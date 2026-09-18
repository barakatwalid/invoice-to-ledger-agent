import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateBookkeepingPolicy} from '../src/bookkeeping.ts';
import {validateInvoiceExtraction} from '../src/extraction.ts';
import {JobStore} from '../src/job-store.ts';
import {createLocalAgentHandler,LocalBookkeepingAgent,parseBatchForm,renderLocalAgentHome} from '../src/local-agent.ts';
import {extractPdfText} from '../src/pdf-text.ts';
import {validateSyntheticAnswerKey} from '../src/slice.ts';
import {WorkflowError} from '../src/errors.ts';

const inboxId='11111111-1111-4111-8111-111111111111';
const pdf=new Uint8Array(readFileSync(new URL('../output/pdf/synthetic-bookkeeping-invoice.pdf',import.meta.url)));
const answerKey=validateSyntheticAnswerKey(JSON.parse(readFileSync(
  new URL('../fixtures/synthetic-invoice-answer-key.json',import.meta.url),'utf8')));
const fixture=JSON.parse(readFileSync(new URL('../fixtures/synthetic-recorded-model-response.json',import.meta.url),'utf8'));
const policy=validateBookkeepingPolicy({
  ...JSON.parse(readFileSync(new URL('../config/demo-policy.json',import.meta.url),'utf8')),
  resultAccess:'authenticated_local_service_only',
});

function fakeClient(messages){
  return {emailInboxes:{messages:{list:()=>({async *[Symbol.asyncIterator](){for(const item of messages)yield item;}})}},
    ai:{openai:{}}};
}

function inbound(id,subject='Invoice sent by test sender'){
  return {id,inbox_id:inboxId,direction:'inbound',status:'received',subject,
    received_at:'2026-09-08T12:00:00Z',attachments:[{
      url:'https://files.telnyx.test/invoice',filename:'invoice.pdf',content_type:'application/pdf',
    }]};
}

test('L-001 local agent processes arbitrary-subject PDF once and deduplicates later polls',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'bookkeeping-local-agent-'));
  const store=new JobStore(join(directory,'live-slice.sqlite'));
  let modelCalls=0;
  const agent=new LocalBookkeepingAgent({
    client:fakeClient([inbound('22222222-2222-4222-8222-222222222222')]),store,
    privateDirectory:directory,inboxId,subjectFilter:null,modelId:'test/model',reasoningEffort:'high',
    allowedHosts:new Set(['files.telnyx.test']),policy,answerKey,
    loadAttachment:async()=>({bytes:pdf,sha256:answerKey.pdfSha256,sizeBytes:pdf.byteLength}),
    runModel:async pages=>{
      modelCalls++;
      const validation=validateInvoiceExtraction(fixture,pages);assert.equal(validation.ok,true);
      return {extraction:validation.value,configuredModelId:'test/model',responseModelId:'test/model',
        provider:'telnyx_inference'};
    },
  });
  try{
    const first=await agent.pollOnce();assert.equal(first.status,'complete');assert.equal(first.claimedJobs,1);
    const second=await agent.pollOnce();assert.equal(second.status,'idle');assert.equal(second.claimedJobs,0);
    assert.equal(modelCalls,1);assert.equal(agent.status().jobs.counts.completed,1);
    assert.deepEqual(agent.status().lastPoll,second);
    const result=agent.result(first.completedJobIds[0]);
    assert.equal(result.decision,'proposal_ready_for_human_review');
    assert.equal(result.controls.resultAccess,'authenticated_local_service_only');
  }finally{await agent.stop();store.close();rmSync(directory,{recursive:true,force:true});}
});

test('L-002 local agent processes only one new invoice per poll',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'bookkeeping-local-limit-'));
  const store=new JobStore(join(directory,'jobs.sqlite'));
  let modelCalls=0;
  const messages=[inbound('22222222-2222-4222-8222-222222222222'),
    {...inbound('33333333-3333-4333-8333-333333333333'),received_at:'2026-09-08T12:01:00Z'}];
  const agent=new LocalBookkeepingAgent({client:fakeClient(messages),store,privateDirectory:directory,inboxId,
    subjectFilter:null,modelId:'test/model',reasoningEffort:'high',allowedHosts:new Set(['files.telnyx.test']),
    policy,answerKey,maxNewJobsPerPoll:1,
    loadAttachment:async()=>({bytes:pdf,sha256:answerKey.pdfSha256,sizeBytes:pdf.byteLength}),
    runModel:async pages=>{modelCalls++;const validation=validateInvoiceExtraction(fixture,pages);
      assert.equal(validation.ok,true);return {extraction:validation.value,configuredModelId:'test/model',
        responseModelId:'test/model',provider:'telnyx_inference'};},
  });
  try{
    assert.equal((await agent.pollOnce()).claimedJobs,1);assert.equal(modelCalls,1);
    assert.equal((await agent.pollOnce()).claimedJobs,1);assert.equal(modelCalls,2);
    assert.equal(agent.status().jobs.counts.completed,2);
  }finally{await agent.stop();store.close();rmSync(directory,{recursive:true,force:true});}
});

test('L-003 health is public while dashboard, polling, status, and results require authentication',async()=>{
  const token='t'.repeat(48);
  const state={running:true,phase:'waiting',lastPolledAt:null,lastCompletedJobId:null,lastError:null,
    recoveredInterruptedJobs:0,lastPoll:null,jobs:{counts:{ready:0,processing:0,completed:1,failed:0},
      latestCompletedJobId:'a'.repeat(64),recent:[]},batch:null};
  let polls=0;let configured=null;let closed=0;
  const handler=createLocalAgentHandler({status:()=>state,pollOnce:async()=>{polls++;return {status:'idle'};},
    result:id=>id==='a'.repeat(64)?{supplier:'<script>unsafe</script>'}:null,
    configureBatch:value=>{configured=value;return {};},closeBatch:()=>{closed++;return null;}},token);
  const invoke=async(method,url,headers={},body='')=>{
    const captured={status:null,headers:{},body:''};
    const response={headersSent:false,writeHead(status,responseHeaders={}){
      captured.status=status;captured.headers=responseHeaders;this.headersSent=true;return this;
    },end(body=''){captured.body+=String(body);return this;}};
    const request={method,url,headers,async *[Symbol.asyncIterator](){if(body)yield Buffer.from(body);}};
    await handler(request,response);
    return captured;
  };
  const authorization=`Basic ${Buffer.from(`review:${token}`).toString('base64')}`;
  assert.equal((await invoke('GET','/health')).status,200);
  assert.equal((await invoke('GET','/status')).status,401);
  const status=await invoke('GET','/status',{authorization});assert.equal(status.status,200);
  const home=await invoke('GET','/',{authorization});assert.equal(home.status,200);
  assert.match(home.body,/Invoice operations/);assert.match(home.body,/Process inbox now/);
  assert.match(home.body,/Quarterly completeness batch/);assert.match(home.body,/Recent invoice jobs/);
  const csrf=home.body.match(/name="_csrf" value="([a-f0-9]{64})"/)?.[1];assert.ok(csrf);
  const contentType={'content-type':'application/x-www-form-urlencoded'};
  assert.equal((await invoke('POST','/control/poll',{authorization,...contentType},'_csrf=bad')).status,403);
  const poll=await invoke('POST','/control/poll',{authorization,...contentType},`_csrf=${csrf}`);
  assert.equal(poll.status,303);assert.equal(polls,1);
  const batchBody=new URLSearchParams({_csrf:csrf,label:'2026 Q3',expected_count:'2',
    expected_manifest:'Vendor A | INV-1\nVendor B | INV-2',include_unassigned:'on'}).toString();
  assert.equal((await invoke('POST','/control/batch',{authorization,...contentType},batchBody)).status,303);
  assert.deepEqual(configured,{label:'2026 Q3',expectedCount:2,expectedManifest:[
    {supplierName:'Vendor A',invoiceNumber:'INV-1'},
    {supplierName:'Vendor B',invoiceNumber:'INV-2'},
  ],includeUnassignedJobs:true});
  assert.equal((await invoke('POST','/control/batch/close',{authorization,...contentType},`_csrf=${csrf}`)).status,303);
  assert.equal(closed,1);
  const result=await invoke('GET',`/results/${'a'.repeat(64)}`,{authorization});
  assert.equal(result.status,200);assert.match(result.body,/&lt;script&gt;unsafe&lt;\/script&gt;/);
});

test('L-004 an unknown invoice never inherits the synthetic expected count or identity',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'bookkeeping-local-unknown-'));
  const store=new JobStore(join(directory,'jobs.sqlite'));
  const agent=new LocalBookkeepingAgent({
    client:fakeClient([inbound('44444444-4444-4444-8444-444444444444')]),store,
    privateDirectory:directory,inboxId,subjectFilter:null,modelId:'test/model',reasoningEffort:'high',
    allowedHosts:new Set(['files.telnyx.test']),policy,answerKey,
    loadAttachment:async()=>({bytes:pdf,sha256:'0'.repeat(64),sizeBytes:pdf.byteLength}),
    runModel:async pages=>{
      const validation=validateInvoiceExtraction(fixture,pages);assert.equal(validation.ok,true);
      return {extraction:validation.value,configuredModelId:'test/model',responseModelId:'test/model',
        provider:'telnyx_inference'};
    },
  });
  try{
    const run=await agent.pollOnce();assert.equal(run.status,'complete');
    const result=agent.result(run.completedJobIds[0]);
    assert.deepEqual(result.documentAccuracy,{status:'not_evaluated',mismatches:[],
      reason:'attachment_hash_does_not_match_answer_key'});
    assert.equal(result.completeness.status,'unknown');
    assert.equal(result.completeness.expectedCount,null);
    assert.deepEqual(result.completeness.missingReferences,[]);
  }finally{await agent.stop();store.close();rmSync(directory,{recursive:true,force:true});}
});

test('L-005 an image-only PDF falls back to one vision extraction without a text-model call',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'bookkeeping-local-scan-'));
  const store=new JobStore(join(directory,'jobs.sqlite'));
  const pages=await extractPdfText(pdf);let textModelCalls=0;let visualCalls=0;
  const agent=new LocalBookkeepingAgent({
    client:fakeClient([inbound('55555555-5555-4555-8555-555555555555')]),store,
    privateDirectory:directory,inboxId,subjectFilter:null,modelId:'test/vision',reasoningEffort:'high',
    allowedHosts:new Set(['files.telnyx.test']),policy,answerKey,
    loadAttachment:async()=>({bytes:pdf,sha256:'1'.repeat(64),sizeBytes:pdf.byteLength}),
    extractText:async()=>{throw new WorkflowError('pdf_has_no_extractable_text');},
    runModel:async()=>{textModelCalls++;throw new Error('unexpected');},
    runVisualModel:async(bytes,contentType)=>{
      visualCalls++;assert.equal(bytes.byteLength,pdf.byteLength);assert.equal(contentType,'application/pdf');
      const validation=validateInvoiceExtraction(fixture,pages);assert.equal(validation.ok,true);
      return {pages,extraction:validation.value,configuredModelId:'test/vision',responseModelId:'test/vision',
        provider:'telnyx_inference'};
    },
  });
  try{
    const run=await agent.pollOnce();assert.equal(run.status,'complete');assert.equal(visualCalls,1);
    assert.equal(textModelCalls,0);
    const result=agent.result(run.completedJobIds[0]);
    assert.equal(result.documentText.source,'telnyx_vision_capture');
    assert.equal(result.pdfText.status,'not_used_visual_input');
    assert.match(result.extraction.validation,/model_visual_transcription/);
    assert.equal(agent.status().phase,'ready');
    assert.equal(agent.status().lastError,null);
  }finally{await agent.stop();store.close();rmSync(directory,{recursive:true,force:true});}
});

test('L-006 a directly attached JPEG is processed by MIME type without a filename extension',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'bookkeeping-local-image-'));
  const store=new JobStore(join(directory,'jobs.sqlite'));const pages=await extractPdfText(pdf);
  const imageMessage={...inbound('66666666-6666-4666-8666-666666666666'),attachments:[{
    url:'https://files.telnyx.test/invoice',filename:'phone-camera-upload',content_type:'image/jpeg',
  }]};
  let visualCalls=0;
  const agent=new LocalBookkeepingAgent({client:fakeClient([imageMessage]),store,privateDirectory:directory,inboxId,
    subjectFilter:null,modelId:'test/vision',reasoningEffort:'high',allowedHosts:new Set(['files.telnyx.test']),
    policy,answerKey,loadAttachment:async()=>({bytes:new Uint8Array([255,216,255,1,2,3,4,5]),
      sha256:'2'.repeat(64),sizeBytes:8}),
    runModel:async()=>{throw new Error('unexpected');},
    runVisualModel:async(_bytes,contentType)=>{visualCalls++;assert.equal(contentType,'image/jpeg');
      const validation=validateInvoiceExtraction(fixture,pages);assert.equal(validation.ok,true);
      return {pages,extraction:validation.value,configuredModelId:'test/vision',responseModelId:'test/vision',
        provider:'telnyx_inference'};},
  });
  try{
    const run=await agent.pollOnce();assert.equal(run.status,'complete');assert.equal(visualCalls,1);
    const result=agent.result(run.completedJobIds[0]);
    assert.equal(result.intake.attachment.filename,'phone-camera-upload');
    assert.equal(result.intake.attachment.contentType,'image/jpeg');
  }finally{await agent.stop();store.close();rmSync(directory,{recursive:true,force:true});}
});

test('L-007 messages without one supported attached document are skipped without model calls',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'bookkeeping-local-unsupported-'));
  const store=new JobStore(join(directory,'jobs.sqlite'));let modelCalls=0;
  const noAttachment={...inbound('77777777-7777-4777-8777-777777777777'),attachments:[]};
  const agent=new LocalBookkeepingAgent({client:fakeClient([noAttachment]),store,privateDirectory:directory,inboxId,
    subjectFilter:null,modelId:'test/model',reasoningEffort:'high',allowedHosts:new Set(['files.telnyx.test']),
    policy,answerKey,runModel:async()=>{modelCalls++;throw new Error('unexpected');}});
  try{
    const run=await agent.pollOnce();assert.equal(run.status,'idle');assert.equal(run.claimedJobs,0);
    assert.equal(run.skippedUnsupportedMessages,1);assert.equal(modelCalls,0);
  }finally{await agent.stop();store.close();rmSync(directory,{recursive:true,force:true});}
});

test('L-008 an active manifest batch reaches exact completeness after the matching invoice completes',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'bookkeeping-local-batch-'));
  const store=new JobStore(join(directory,'jobs.sqlite'));
  store.configureActiveBatch({label:'2026 Q3',expectedCount:1,expectedManifest:[{
    supplierName:answerKey.expected.supplierName,invoiceNumber:answerKey.expected.invoiceNumber,
  }],includeUnassignedJobs:false});
  const agent=new LocalBookkeepingAgent({
    client:fakeClient([inbound('88888888-8888-4888-8888-888888888888')]),store,
    privateDirectory:directory,inboxId,subjectFilter:null,modelId:'test/model',reasoningEffort:'high',
    allowedHosts:new Set(['files.telnyx.test']),policy,answerKey,
    loadAttachment:async()=>({bytes:pdf,sha256:answerKey.pdfSha256,sizeBytes:pdf.byteLength}),
    runModel:async pages=>{const validation=validateInvoiceExtraction(fixture,pages);assert.equal(validation.ok,true);
      return {extraction:validation.value,configuredModelId:'test/model',responseModelId:'test/model',
        provider:'telnyx_inference'};},
  });
  try{
    const run=await agent.pollOnce();assert.equal(run.status,'complete');
    const batch=agent.status().batch;assert.equal(batch.completeness.status,'manifest_match');
    assert.equal(batch.completeness.uniqueReceived,1);assert.equal(batch.jobs.completed,1);
    assert.equal(batch.jobs.unsupportedReceipts,0);
  }finally{await agent.stop();store.close();rmSync(directory,{recursive:true,force:true});}
});

test('L-009 batch form rejects malformed manifest lines and contradictory counts fail in the store',()=>{
  assert.throws(()=>parseBatchForm(new URLSearchParams({label:'Q3',expected_count:'1',
    expected_manifest:'missing separator'})),error=>error.code==='invalid_batch_manifest_line');
  const directory=mkdtempSync(join(tmpdir(),'bookkeeping-local-batch-form-'));
  const store=new JobStore(join(directory,'jobs.sqlite'));
  try{
    const parsed=parseBatchForm(new URLSearchParams({label:'Q3',expected_count:'2',
      expected_manifest:'Vendor | INV-1'}));
    assert.throws(()=>store.configureActiveBatch(parsed),error=>error.code==='invalid_batch_configuration');
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('L-010 dashboard keeps a closed batch visible while a new batch is active',()=>{
  const batch=(id,label,state,expectedCount,received)=>({id,label,state,expectedCount,expectedManifest:null,
    startedAt:'2026-09-09T00:00:00Z',closedAt:state==='closed'?'2026-09-09T01:00:00Z':null,
    jobs:{total:received,ready:0,processing:0,completed:received,failed:0,unresolved:0,unsupportedReceipts:0},
    completeness:{status:received===expectedCount?'count_match_only':'needs_review',uniqueReceived:received,
      duplicateOccurrences:0,expectedCount,countState:received===expectedCount?'match':'excess',
      missingReferences:[],unexpectedReferences:[],issues:[]}});
  const active=batch('active','2026 Q4','active',2,1);
  const closed=batch('closed','2026 Q3','closed',7,7);
  const html=renderLocalAgentHome({running:true,phase:'waiting',lastPolledAt:null,lastCompletedJobId:null,
    lastError:null,recoveredInterruptedJobs:0,lastPoll:null,
    jobs:{counts:{ready:0,processing:0,completed:8,failed:0},latestCompletedJobId:null,recent:[]},
    batch:active,batches:[active,closed]},'c'.repeat(64));
  assert.match(html,/Previous batches/);assert.match(html,/2026 Q3/);assert.match(html,/7 of 7/);
  assert.match(html,/Count Match Only/);
});
