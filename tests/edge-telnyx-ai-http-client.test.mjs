import assert from 'node:assert/strict';
import test from 'node:test';
import {createDirectTelnyxAiClient} from '../src/edge/telnyx-ai-http-client.ts';
import {transcribeVisualWithTelnyxModel} from '../src/telnyx-vision.ts';

const apiKey='test-key-'.padEnd(40,'x');

test('H-001 direct Edge AI client uses only fixed Telnyx HTTPS endpoints and rejects redirects',async()=>{
  const calls=[];
  const client=createDirectTelnyxAiClient(apiKey,async(input,init)=>{
    calls.push({url:String(input),init});
    if(String(input).endsWith('/models')){
      return Response.json({data:[{id:'test/model',task:'text-generation',context_length:100000,is_vision_supported:true}]});
    }
    return Response.json({model:'test/model',choices:[{finish_reason:'stop',message:{content:'{}'}}]});
  });
  await client.ai.openai.listModels();
  await client.ai.openai.chat.createCompletion({model:'test/model',messages:[]});
  assert.deepEqual(calls.map(value=>value.url),[
    'https://api.telnyx.com/v2/ai/openai/models',
    'https://api.telnyx.com/v2/ai/openai/chat/completions',
  ]);
  assert.equal(calls[0].init.redirect,'error');
  assert.equal(calls[0].init.method,'GET');
  assert.equal(calls[1].init.method,'POST');
  assert.equal(calls[1].init.headers.authorization,`Bearer ${apiKey}`);
  assert.deepEqual(JSON.parse(calls[1].init.body),{model:'test/model',messages:[]});
});

test('H-002 direct Edge AI client returns a stable HTTP code without provider body leakage',async()=>{
  const client=createDirectTelnyxAiClient(apiKey,async()=>new Response('PRIVATE PROVIDER BODY',{
    status:502,headers:{'content-type':'text/plain'},
  }));
  await assert.rejects(
    client.ai.openai.chat.createCompletion({model:'test/model',messages:[]}),
    error=>error.code==='model_completion_provider_http_502'&&
      !error.message.includes('PRIVATE PROVIDER BODY')&&error.retryable===true,
  );
});

test('H-003 direct HTTP vision failure survives adapter handling as a precise safe code',async()=>{
  const client=createDirectTelnyxAiClient(apiKey,async(input)=>{
    if(String(input).endsWith('/models')){
      return Response.json({data:[{id:'test/vision',task:'text-generation',context_length:100000,is_vision_supported:true}]});
    }
    return new Response('PRIVATE PROVIDER BODY',{status:502,headers:{'content-type':'text/plain'}});
  });
  await assert.rejects(
    transcribeVisualWithTelnyxModel(client,'test/vision',[
      {page:1,contentType:'image/jpeg',bytes:new Uint8Array([255,216,255,224,0,16,74,70,73,70])},
    ]),
    error=>error.code==='model_completion_provider_http_502'&&error.retryable===true,
  );
});

test('H-004 direct Edge AI client classifies connection failures without leaking their message',async()=>{
  const client=createDirectTelnyxAiClient(apiKey,async()=>{throw new Error('PRIVATE NETWORK DETAIL');});
  await assert.rejects(
    client.ai.openai.listModels(),
    error=>error.code==='model_list_provider_connection_error'&&
      !error.message.includes('PRIVATE NETWORK DETAIL')&&error.retryable===true,
  );
});
