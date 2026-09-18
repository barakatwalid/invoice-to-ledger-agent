import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import Telnyx from 'telnyx';
import {validateBookkeepingPolicy} from '../src/bookkeeping.ts';
import {errorCode,WorkflowError} from '../src/errors.ts';
import {JobStore} from '../src/job-store.ts';
import {writeSyntheticModelDiagnostic} from '../src/model-diagnostic.ts';
import {jobIdentity,processClaimedJob,validateSyntheticAnswerKey} from '../src/slice.ts';
import {extractWithTelnyxModel} from '../src/telnyx-adapter.ts';
import {writeInspectableResult} from '../src/result.ts';

const required=['TELNYX_API_KEY','EXTRACTION_MODEL_ID'];
const missing=required.filter(name=>!process.env[name]);
const reasoningEfforts=new Set(['none','minimal','low','medium','high','xhigh','max']);
if(missing.length){
  console.error(`BLOCKED: configure ${missing.join(', ')} locally. Do not paste secret values into chat.`);
  process.exitCode=2;
}else if(process.env.EXTRACTION_REASONING_EFFORT&&!reasoningEfforts.has(process.env.EXTRACTION_REASONING_EFFORT)){
  console.error('BLOCKED: EXTRACTION_REASONING_EFFORT is not a supported trusted value.');
  process.exitCode=2;
}else{
  const privateDirectory=resolve('.private');
  let store;
  try{
    const [pdfBuffer,answerRaw,policyRaw]=await Promise.all([
      readFile('output/pdf/synthetic-bookkeeping-invoice.pdf'),
      readFile('fixtures/synthetic-invoice-answer-key.json','utf8'),
      readFile('config/demo-policy.json','utf8'),
    ]);
    const bytes=new Uint8Array(pdfBuffer);
    const sha256=createHash('sha256').update(bytes).digest('hex');
    const answerKey=validateSyntheticAnswerKey(JSON.parse(answerRaw));
    const policy=validateBookkeepingPolicy(JSON.parse(policyRaw));
    if(sha256!==answerKey.pdfSha256)throw new WorkflowError('local_pdf_answer_key_hash_mismatch');
    const modelId=process.env.EXTRACTION_MODEL_ID;
    const reasoningEffort=process.env.EXTRACTION_REASONING_EFFORT;
    const sourceKey=`local-pdf-live-telnyx-model:${sha256}:${modelId}:${policy.id}`;
    const id=jobIdentity(sourceKey);
    store=new JobStore(resolve(privateDirectory,'live-model-slice.sqlite'));
    const claim=store.claim({id,sourceKey,inboxId:'NO-TELNYX-INBOX-MODEL-ONLY',
      messageId:'LOCAL-PDF-LIVE-MODEL',attachmentIndex:0,filename:'synthetic-bookkeeping-invoice.pdf'});
    if(claim.outcome==='already_processing')throw new WorkflowError('live_model_job_already_processing',true);
    if(claim.outcome==='duplicate_completed'){
      const result=JSON.parse(claim.resultJson);
      const paths=await writeInspectableResult(resolve(privateDirectory,'results'),claim.jobId,result);
      console.log(JSON.stringify({status:'PASS',mode:'LOCAL_PDF_LIVE_TELNYX_MODEL',duplicate:true,
        jobId:claim.jobId,result:paths,note:'Previously completed live-model job; no duplicate inference request was made.'},null,2));
    }else{
      const client=new Telnyx({apiKey:process.env.TELNYX_API_KEY,baseURL:'https://api.telnyx.com/v2',
        timeout:180_000,maxRetries:0});
      const completed=await processClaimedJob({
        store,claim,mode:'local_pdf_live_telnyx_model',inboxId:'NO-TELNYX-INBOX-MODEL-ONLY',
        messageId:'LOCAL-PDF-LIVE-MODEL',receivedAt:new Date().toISOString(),
        filename:'synthetic-bookkeeping-invoice.pdf',declaredSha256:answerKey.pdfSha256,
        declaredSize:bytes.byteLength,privateDirectory,policy,answerKey,
        loadAttachment:async()=>({bytes,sha256,sizeBytes:bytes.byteLength}),
        runModel:pages=>extractWithTelnyxModel(client,modelId,pages,{
          reasoningEffort,
          captureSyntheticInvalidOutput:diagnostic=>writeSyntheticModelDiagnostic(
            resolve(privateDirectory,'model-diagnostics'),id,diagnostic),
        }),
      });
      console.log(JSON.stringify({status:'PASS',mode:'LOCAL_PDF_LIVE_TELNYX_MODEL',duplicate:false,
        jobId:claim.jobId,configuredModelId:modelId,responseModelId:completed.result.extraction.responseModelId,
        decision:completed.result.decision,documentAccuracy:completed.result.documentAccuracy,
        result:{jsonPath:completed.jsonPath,htmlPath:completed.htmlPath},
        note:'Live Telnyx inference ran on a local PDF. No Telnyx email or remote attachment retrieval ran.'},null,2));
    }
  }catch(error){
    const httpStatus=error && typeof error==='object' && 'status' in error && Number.isInteger(error.status)?error.status:null;
    console.error(`FAIL: ${httpStatus===null?errorCode(error):`provider_http_${httpStatus}`}`);
    process.exitCode=1;
  }finally{store?.close();}
}
