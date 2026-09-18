import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import Telnyx,{APIConnectionError,APIConnectionTimeoutError} from 'telnyx';
import {extractPdfText} from '../src/pdf-text.ts';
import {
  extractWithTelnyxModel,
  findTargetInboxMessage,
  findTargetInboxMessageHttp,
  listInboxMessages,
  listInboxMessagesHttp,
  listTargetInboxMessages,
  selectSingleInvoiceAttachment,
  selectSinglePdfAttachment,
} from '../src/telnyx-adapter.ts';
import {transcribeVisualWithTelnyxModel,validateVisualInvoiceTranscription} from '../src/telnyx-vision.ts';

const inboxId='11111111-1111-4111-8111-111111111111';
const subject='Synthetic bookkeeping invoice BK-2026-001';
const message=(id,subjectValue=subject)=>({
  id,inbox_id:inboxId,direction:'inbound',status:'received',subject:subjectValue,
  received_at:'2026-09-08T12:00:00Z',attachments:[{
    url:'https://files.telnyx.test/invoice',filename:'invoice.pdf',content_type:'application/pdf',
    size_bytes:123,sha256:'a'.repeat(64),
  }],
});
const jsonResponse=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});

test('T-001 official SDK traverses inbox page_cursor using page[after]',async()=>{
  const requested=[];
  const client=new Telnyx({apiKey:'TEST-NOT-SECRET',baseURL:'https://api.telnyx.test/v2',maxRetries:0,
    fetch:async(url,init)=>{
      requested.push(String(url));
      assert.equal(new Headers(init?.headers).get('authorization'),'Bearer TEST-NOT-SECRET');
      if(requested.length===1)return jsonResponse({data:[message('22222222-2222-4222-8222-222222222222','other')],
        meta:{page_size:1,page_cursor:'NEXT-CURSOR'}});
      return jsonResponse({data:[message('33333333-3333-4333-8333-333333333333')],meta:{page_size:1}});
    }});
  const found=await findTargetInboxMessage(client,inboxId,subject);
  assert.equal(found.id,'33333333-3333-4333-8333-333333333333');
  assert.equal(requested.length,2);
  assert.equal(new URL(requested[0]).searchParams.get('page[size]'),'100');
  assert.equal(new URL(requested[1]).searchParams.get('page[after]'),'NEXT-CURSOR');
});

test('T-001b Edge direct inbox fallback is fixed-origin, no-redirect, and cursor bounded',async()=>{
  const requested=[];
  const fetcher=async(url,init)=>{
    const parsed=new URL(String(url));requested.push(parsed);
    assert.equal(parsed.origin,'https://api.telnyx.com');
    assert.equal(parsed.pathname,`/v2/email_inboxes/${inboxId}/messages`);
    assert.equal(new Headers(init.headers).get('authorization'),'Bearer TEST-NOT-SECRET');
    assert.equal(init.redirect,'error');assert.equal(init.method,'GET');
    if(requested.length===1)return jsonResponse({data:[message('22222222-2222-4222-8222-222222222222','other')],
      meta:{page_cursor:'NEXT-CURSOR'}});
    return jsonResponse({data:[message('33333333-3333-4333-8333-333333333333')],meta:{}});
  };
  const found=await findTargetInboxMessageHttp('TEST-NOT-SECRET',inboxId,subject,null,{fetcher});
  assert.equal(found.id,'33333333-3333-4333-8333-333333333333');
  assert.equal(requested[0].searchParams.get('filter[subject]'),subject);
  assert.equal(requested[0].searchParams.get('page[size]'),'100');
  assert.equal(requested[1].searchParams.get('page[after]'),'NEXT-CURSOR');
});

test('T-001c Edge direct inbox fallback reports only HTTP status and rejects bad pagination',async()=>{
  await assert.rejects(()=>listInboxMessagesHttp('TEST-NOT-SECRET',inboxId,subject,{
    fetcher:async()=>new Response('private provider body',{status:403}),
  }),error=>error.code==='email_list_provider_http_403'&&!error.message.includes('private provider body'));
  await assert.rejects(()=>listInboxMessagesHttp('TEST-NOT-SECRET',inboxId,subject,{
    fetcher:async()=>jsonResponse({data:[],meta:{page_cursor:'REPEATED'}}),
  }),error=>error.code==='email_list_provider_invalid_response');
});

test('T-001d Edge any-subject listing omits the subject filter and returns received messages',async()=>{
  const fetcher=async(url)=>{
    const parsed=new URL(String(url));
    assert.equal(parsed.searchParams.has('filter[subject]'),false);
    return jsonResponse({data:[message('22222222-2222-4222-8222-222222222222','Vendor A'),
      message('33333333-3333-4333-8333-333333333333','Vendor B')],meta:{}});
  };
  const messages=await listInboxMessagesHttp('TEST-NOT-SECRET',inboxId,null,{fetcher});
  assert.deepEqual(messages.map(item=>item.subject),['Vendor A','Vendor B']);
});

test('T-002 ambiguous exact subject requires an explicit message ID',async()=>{
  const client=new Telnyx({apiKey:'TEST-NOT-SECRET',baseURL:'https://api.telnyx.test/v2',maxRetries:0,
    fetch:async()=>jsonResponse({data:[message('22222222-2222-4222-8222-222222222222'),
      message('33333333-3333-4333-8333-333333333333')],meta:{page_size:2}})});
  await assert.rejects(()=>findTargetInboxMessage(client,inboxId,subject),error=>error.code==='target_invoice_message_ambiguous');
  const found=await findTargetInboxMessage(client,inboxId,subject,'33333333-3333-4333-8333-333333333333');
  assert.equal(found.id,'33333333-3333-4333-8333-333333333333');
});

test('T-003 inbound PDF attachment uses only documented attachment response fields',()=>{
  const selected=selectSinglePdfAttachment({id:'m',inboxId:'i',subject:'s',receivedAt:'2026-09-08T00:00:00Z',
    attachments:[{url:'https://files.telnyx.test/a',
      content_disposition:{content_disposition:'attachment',params:{filename:'invoice.pdf'}},
      content_type:{content_type:'application/pdf',params:{name:'invoice.pdf'}},
      unknown_provider_field:'preserved_outside_adapter'}]});
  assert.equal(selected.index,0);assert.equal(selected.filename,'invoice.pdf');
  assert.equal(selected.declaredSize,null);assert.equal(selected.declaredSha256,null);
});

test('T-004 SDK verifies configured model list then sends guided_json completion',async()=>{
  const [pdf,fixture]=await Promise.all([
    readFile(new URL('../output/pdf/synthetic-bookkeeping-invoice.pdf',import.meta.url)),
    readFile(new URL('../fixtures/synthetic-recorded-model-response.json',import.meta.url),'utf8'),
  ]);
  const pages=await extractPdfText(new Uint8Array(pdf));
  const requests=[];
  const client=new Telnyx({apiKey:'TEST-NOT-SECRET',baseURL:'https://api.telnyx.test/v2',maxRetries:0,
    fetch:async(url,init)=>{
      const parsed=new URL(String(url));requests.push(parsed.pathname);
      if(parsed.pathname.endsWith('/ai/openai/models'))return jsonResponse({object:'list',data:[{
        id:'test/invoice-model',task:'text-generation',context_length:100000,
      }]});
      const body=JSON.parse(String(init?.body));
      assert.equal(body.model,'test/invoice-model');assert.equal(body.temperature,0);
      assert.equal(body.reasoning_effort,'high');
      assert.equal('enable_thinking' in body,false);
      assert.ok(body.guided_json.required.includes('total'));
      assert.match(body.messages[0].content,/exactly one raw JSON object/);
      assert.match(body.messages[0].content,/emit no prose, Markdown, bullets/);
      assert.match(body.messages[0].content,/untrusted data/);
      assert.match(body.messages[0].content,/Required JSON Schema:/);
      assert.match(body.messages[0].content,/"supplierName"/);
      assert.match(body.messages[0].content,/"supplierAddress"/);
      assert.match(body.messages[0].content,/"supplierTaxRegistrationId"/);
      assert.match(body.messages[0].content,/"lineNet"/);
      assert.match(body.messages[0].content,/synthetic\/test-document notice is not a financial complexity/);
      return jsonResponse({model:'test/invoice-model',choices:[{message:{content:fixture}}]});
    }});
  const result=await extractWithTelnyxModel(client,'test/invoice-model',pages,{reasoningEffort:'high'});
  assert.deepEqual(requests,['/v2/ai/openai/models','/v2/ai/openai/chat/completions']);
  assert.equal(result.extraction.invoiceNumber.value,'BK-2026-001');
  assert.equal(result.responseModelId,'test/invoice-model');
});

test('T-005 model absent from live account list blocks before completion request',async()=>{
  let requests=0;
  const client=new Telnyx({apiKey:'TEST-NOT-SECRET',baseURL:'https://api.telnyx.test/v2',maxRetries:0,
    fetch:async()=>{requests++;return jsonResponse({object:'list',data:[]});}});
  await assert.rejects(()=>extractWithTelnyxModel(client,'missing/model',[{page:1,text:'invoice'}]),
    error=>error.code==='configured_model_not_available');
  assert.equal(requests,1);
});

test('T-006 model-list timeout becomes a stable retryable workflow error',async()=>{
  const client={ai:{openai:{listModels:async()=>{throw new APIConnectionTimeoutError();}}}};
  await assert.rejects(()=>extractWithTelnyxModel(client,'test/model',[{page:1,text:'invoice'}]),
    error=>error.code==='model_list_provider_timeout'&&error.retryable===true);
});

test('T-007 completion connection failure identifies the failed provider stage',async()=>{
  const client={ai:{openai:{listModels:async()=>({data:[{id:'test/model',task:'text-generation',context_length:10000}]}),
    chat:{createCompletion:async()=>{throw new APIConnectionError({message:'redacted test failure'});}}}}};
  await assert.rejects(()=>extractWithTelnyxModel(client,'test/model',[{page:1,text:'invoice'}]),
    error=>error.code==='model_completion_provider_connection_error'&&error.retryable===true);
});

function clientWithModelContent(content,finishReason){
  return {ai:{openai:{
    listModels:async()=>({data:[{id:'test/model',task:'text-generation',context_length:10000}]}),
    chat:{createCompletion:async()=>({
      model:'test/model',choices:[{finish_reason:finishReason,message:{content}}],
    })},
  }}};
}

test('T-008 empty model content has a privacy-safe stable error',async()=>{
  await assert.rejects(()=>extractWithTelnyxModel(clientWithModelContent('   ',null),'test/model',
    [{page:1,text:'invoice'}]),error=>error.code==='model_output_empty');
});

test('T-009 length-stopped non-JSON model content is classified as truncated',async()=>{
  await assert.rejects(()=>extractWithTelnyxModel(clientWithModelContent('{"schemaVersion":','length'),
    'test/model',[{page:1,text:'invoice'}]),error=>error.code==='model_output_truncated');
});

test('T-010 markdown-wrapped output is rejected without weakening strict JSON',async()=>{
  let captured=null;
  await assert.rejects(()=>extractWithTelnyxModel(clientWithModelContent('```json\n{}\n```','stop'),
    'test/model',[{page:1,text:'invoice'}],{captureSyntheticInvalidOutput:async diagnostic=>{captured=diagnostic;}}),
  error=>error.code==='model_output_markdown_wrapped');
  assert.equal(captured.content,'```json\n{}\n```');
  assert.equal(captured.finishReason,'stop');
});

test('T-011 schema-invalid synthetic JSON is privately capturable for offline diagnosis',async()=>{
  let captured=null;
  await assert.rejects(()=>extractWithTelnyxModel(clientWithModelContent('{}','stop'),'test/model',
    [{page:1,text:'invoice'}],{captureSyntheticInvalidOutput:async diagnostic=>{captured=diagnostic;}}),
  error=>error.code==='model_output_invalid_extraction_schema');
  assert.equal(captured.content,'{}');
  assert.equal(captured.responseModelId,'test/model');
});

test('T-012 inbox-list connection failure identifies the failed provider stage',async()=>{
  const client={emailInboxes:{messages:{list:()=>({
    async *[Symbol.asyncIterator](){throw new APIConnectionError({message:'redacted test failure'});},
  })}}};
  await assert.rejects(()=>findTargetInboxMessage(client,inboxId,subject),
    error=>error.code==='email_list_provider_connection_error'&&error.retryable===true);
});

test('T-013 polling lists repeated exact-subject messages without weakening one-shot ambiguity',async()=>{
  const first=message('22222222-2222-4222-8222-222222222222');
  const second={...message('33333333-3333-4333-8333-333333333333'),received_at:'2026-09-08T12:01:00Z'};
  const client=new Telnyx({apiKey:'TEST-NOT-SECRET',baseURL:'https://api.telnyx.test/v2',maxRetries:0,
    fetch:async()=>jsonResponse({data:[second,first,message('44444444-4444-4444-8444-444444444444','other')],
      meta:{page_size:3}})});
  const matches=await listTargetInboxMessages(client,inboxId,subject);
  assert.deepEqual(matches.map(item=>item.id),[second.id,first.id]);
  await assert.rejects(()=>findTargetInboxMessage(client,inboxId,subject),
    error=>error.code==='target_invoice_message_ambiguous');
});

test('T-014 dedicated-inbox polling can accept arbitrary subjects without sending a subject filter',async()=>{
  let requested;
  const client=new Telnyx({apiKey:'TEST-NOT-SECRET',baseURL:'https://api.telnyx.test/v2',maxRetries:0,
    fetch:async url=>{requested=new URL(String(url));return jsonResponse({data:[
      message('22222222-2222-4222-8222-222222222222','Invoice from test sender'),
    ],meta:{page_size:1}});}});
  const matches=await listInboxMessages(client,inboxId);
  assert.equal(matches[0].subject,'Invoice from test sender');
  assert.equal(requested.searchParams.has('filter[subject]'),false);
  assert.equal(requested.searchParams.get('page[size]'),'100');
});

test('T-015 MIME routing accepts one attached image with any filename and ignores inline logos',()=>{
  const selected=selectSingleInvoiceAttachment({id:'m',inboxId:'i',subject:'s',receivedAt:'2026-09-08T00:00:00Z',
    attachments:[
      {url:'https://files.telnyx.test/logo',filename:'logo.png',content_type:'image/png',disposition:'inline'},
      {url:'https://files.telnyx.test/invoice',filename:'camera-upload',content_type:'image/jpeg',disposition:'attachment'},
    ]});
  assert.equal(selected.index,1);assert.equal(selected.filename,'camera-upload');
  assert.equal(selected.contentType,'image/jpeg');
});

test('T-015b MIME and disposition tokens are normalized case-insensitively',()=>{
  const selected=selectSingleInvoiceAttachment({id:'m',inboxId:'i',subject:'s',receivedAt:'2026-09-08T00:00:00Z',
    attachments:[
      {url:'https://files.telnyx.test/logo',filename:'logo',content_type:' IMAGE/PNG ',disposition:' INLINE '},
      {url:'https://files.telnyx.test/invoice',filename:'scan',content_type:' IMAGE/JPEG ',disposition:' ATTACHMENT '},
    ]});
  assert.equal(selected.index,1);assert.equal(selected.contentType,'image/jpeg');
});

test('T-016 vision extraction uses the live OpenAI-compatible image_url object despite SDK 7.20 typing',async()=>{
  const pdf=await readFile(new URL('../output/pdf/synthetic-bookkeeping-invoice.pdf',import.meta.url));
  const pages=await extractPdfText(new Uint8Array(pdf));
  const capture={schemaVersion:'visual_invoice_transcription_v1',pages};
  let body;
  const client=new Telnyx({apiKey:'TEST-NOT-SECRET',baseURL:'https://api.telnyx.test/v2',maxRetries:0,
    fetch:async(url,init)=>{
      if(new URL(String(url)).pathname.endsWith('/models'))return jsonResponse({data:[{
        id:'test/vision-model',task:'text-generation',context_length:100000,is_vision_supported:true,
      }]});
      body=JSON.parse(String(init?.body));
      return jsonResponse({model:'test/vision-model',choices:[{finish_reason:'stop',message:{
        content:JSON.stringify(capture),
      }}]});
    }});
  const run=await transcribeVisualWithTelnyxModel(client,'test/vision-model',[
    {page:1,contentType:'image/png',bytes:new Uint8Array([137,80,78,71,13,10,26,10])},
  ],{reasoningEffort:'high'});
  assert.equal(run.pages[0].text,pages[0].text);
  assert.equal(body.model,'test/vision-model');assert.equal(body.reasoning_effort,'high');
  assert.deepEqual(body.guided_json.required,['schemaVersion','pages']);
  assert.equal(body.messages[1].content[2].type,'image_url');
  assert.match(body.messages[1].content[2].image_url.url,/^data:image\/png;base64,/);
  assert.deepEqual(Object.keys(body.messages[1].content[2].image_url),['url']);
});

test('T-017 vision extraction blocks before completion when the listed model lacks vision',async()=>{
  let completionCalls=0;
  const client={ai:{openai:{
    listModels:async()=>({data:[{id:'test/model',task:'text-generation',context_length:10000,
      is_vision_supported:false}]}),
    chat:{createCompletion:async()=>{completionCalls++;return {};}}
  }}};
  await assert.rejects(()=>transcribeVisualWithTelnyxModel(client,'test/model',[
    {page:1,contentType:'image/png',bytes:new Uint8Array(8)},
  ]),error=>error.code==='configured_model_not_vision_capable');
  assert.equal(completionCalls,0);
});

test('T-018 visual transcription validates exact page count, order, and bounded text',()=>{
  const capture={schemaVersion:'visual_invoice_transcription_v1',pages:[{page:1,text:'Invoice 123'}]};
  assert.equal(validateVisualInvoiceTranscription(capture,1)[0].text,'Invoice 123');
  assert.throws(()=>validateVisualInvoiceTranscription({...capture,pages:[{page:2,text:'Invoice'}]},1),
    error=>error.code==='model_output_invalid_visual_transcription');
});
