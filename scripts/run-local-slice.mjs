import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {validateBookkeepingPolicy} from '../src/bookkeeping.ts';
import {validateInvoiceExtraction} from '../src/extraction.ts';
import {errorCode,WorkflowError} from '../src/errors.ts';
import {JobStore} from '../src/job-store.ts';
import {extractPdfText} from '../src/pdf-text.ts';
import {jobIdentity,processClaimedJob,validateSyntheticAnswerKey} from '../src/slice.ts';
import {writeInspectableResult} from '../src/result.ts';

const privateDirectory=resolve('.private');
const pdfPath=resolve('output/pdf/synthetic-bookkeeping-invoice.pdf');
const [pdfBuffer,answerRaw,modelRaw,policyRaw]=await Promise.all([
  readFile(pdfPath),
  readFile('fixtures/synthetic-invoice-answer-key.json','utf8'),
  readFile('fixtures/synthetic-recorded-model-response.json','utf8'),
  readFile('config/demo-policy.json','utf8'),
]);
const bytes=new Uint8Array(pdfBuffer);
const sha256=createHash('sha256').update(bytes).digest('hex');
const answerKey=validateSyntheticAnswerKey(JSON.parse(answerRaw));
const policy=validateBookkeepingPolicy(JSON.parse(policyRaw));
const sourceKey=`local-fixture:${sha256}:recorded-model-response-v1:${policy.id}`;
const id=jobIdentity(sourceKey);
const store=new JobStore(resolve(privateDirectory,'local-slice.sqlite'));

try {
  const claim=store.claim({
    id,sourceKey,inboxId:'LOCAL-FIXTURE-NOT-TELNYX',messageId:'LOCAL-FIXTURE-MESSAGE',
    attachmentIndex:0,filename:'synthetic-bookkeeping-invoice.pdf',
  });
  if(claim.outcome==='already_processing')throw new WorkflowError('local_fixture_already_processing',true);
  if(claim.outcome==='duplicate_completed'){
    const result=JSON.parse(claim.resultJson);
    const paths=await writeInspectableResult(resolve(privateDirectory,'results'),claim.jobId,result);
    console.log(JSON.stringify({status:'PASS',mode:'LOCAL_FIXTURE_NOT_LIVE',duplicate:true,jobId:claim.jobId,
      result:paths,note:'Recorded model output only; no Telnyx email or live AI request ran.'},null,2));
  }else{
    const completed=await processClaimedJob({
      store,claim,mode:'local_fixture',inboxId:'LOCAL-FIXTURE-NOT-TELNYX',messageId:'LOCAL-FIXTURE-MESSAGE',
      receivedAt:'2000-01-01T00:00:00.000Z',filename:'synthetic-bookkeeping-invoice.pdf',
      declaredSha256:answerKey.pdfSha256,declaredSize:bytes.byteLength,privateDirectory,policy,answerKey,
      loadAttachment:async()=>({bytes,sha256,sizeBytes:bytes.byteLength}),
      runModel:async pages=>{
        const validation=validateInvoiceExtraction(JSON.parse(modelRaw),pages);
        if(!validation.ok)throw new WorkflowError(`recorded_fixture_${validation.issues[0]?.code??'invalid'}`);
        return {extraction:validation.value,configuredModelId:'RECORDED-FIXTURE-NO-MODEL',responseModelId:null,
          provider:'recorded_fixture_not_a_live_model'};
      },
    });
    console.log(JSON.stringify({status:'PASS',mode:'LOCAL_FIXTURE_NOT_LIVE',duplicate:false,jobId:claim.jobId,
      decision:completed.result.decision,documentAccuracy:completed.result.documentAccuracy,result:{jsonPath:completed.jsonPath,htmlPath:completed.htmlPath},
      note:'Actual PDF bytes and text parser exercised; recorded model output only. No Telnyx email or live AI request ran.'},null,2));
  }
}catch(error){
  console.error(`FAIL: ${errorCode(error)}`);
  process.exitCode=1;
}finally{
  store.close();
}
