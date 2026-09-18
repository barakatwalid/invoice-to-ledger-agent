import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import Telnyx from 'telnyx';
import {downloadAttachment,parseAllowedAttachmentHosts} from '../src/attachment.ts';
import {validateBookkeepingPolicy} from '../src/bookkeeping.ts';
import {errorCode,WorkflowError} from '../src/errors.ts';
import {JobStore} from '../src/job-store.ts';
import {jobIdentity,processClaimedJob,validateSyntheticAnswerKey} from '../src/slice.ts';
import {extractWithTelnyxModel,findTargetInboxMessage,selectSinglePdfAttachment} from '../src/telnyx-adapter.ts';
import {writeInspectableResult} from '../src/result.ts';

const required=['TELNYX_API_KEY','TELNYX_INBOX_ID','EXTRACTION_MODEL_ID','TELNYX_TARGET_SUBJECT','TELNYX_ATTACHMENT_HOSTS'];
const missing=required.filter(name=>!process.env[name]);
const reasoningEfforts=new Set(['none','minimal','low','medium','high','xhigh','max']);
if(missing.length){
  console.error(`BLOCKED: configure ${missing.join(', ')} in local .env. Do not paste secret values into chat.`);
  process.exitCode=2;
}else if(process.env.EXTRACTION_REASONING_EFFORT&&!reasoningEfforts.has(process.env.EXTRACTION_REASONING_EFFORT)){
  console.error('BLOCKED: EXTRACTION_REASONING_EFFORT is not a supported trusted value.');
  process.exitCode=2;
}else{
  const privateDirectory=resolve('.private');
  let store;
  try{
    const [answerRaw,policyRaw]=await Promise.all([
      readFile('fixtures/synthetic-invoice-answer-key.json','utf8'),
      readFile('config/demo-policy.json','utf8'),
    ]);
    const answerKey=validateSyntheticAnswerKey(JSON.parse(answerRaw));
    const policy=validateBookkeepingPolicy(JSON.parse(policyRaw));
    const allowedHosts=parseAllowedAttachmentHosts(process.env.TELNYX_ATTACHMENT_HOSTS);
    const client=new Telnyx({
      apiKey:process.env.TELNYX_API_KEY,
      baseURL:'https://api.telnyx.com/v2',
      timeout:180_000,
      maxRetries:0,
    });
    const message=await findTargetInboxMessage(client,process.env.TELNYX_INBOX_ID,
      process.env.TELNYX_TARGET_SUBJECT,process.env.TELNYX_TARGET_MESSAGE_ID||null);
    const attachment=selectSinglePdfAttachment(message);
    const sourceKey=`telnyx-email:${message.inboxId}:${message.id}:${attachment.index}`;
    const id=jobIdentity(sourceKey);
    store=new JobStore(resolve(privateDirectory,'live-slice.sqlite'));
    const claim=store.claim({id,sourceKey,inboxId:message.inboxId,messageId:message.id,
      attachmentIndex:attachment.index,filename:attachment.filename});
    if(claim.outcome==='already_processing')throw new WorkflowError('live_job_already_processing',true);
    if(claim.outcome==='duplicate_completed'){
      const result=JSON.parse(claim.resultJson);
      const paths=await writeInspectableResult(resolve(privateDirectory,'results'),claim.jobId,result);
      console.log(JSON.stringify({status:'PASS',mode:'LIVE_TELNYX',duplicate:true,jobId:claim.jobId,result:paths,
        note:'Previously completed durable job; no duplicate model call was made.'},null,2));
    }else{
      const completed=await processClaimedJob({
        store,claim,mode:'live_telnyx',inboxId:message.inboxId,messageId:message.id,
        receivedAt:message.receivedAt,filename:attachment.filename,declaredSha256:attachment.declaredSha256,
        declaredSize:attachment.declaredSize,privateDirectory,policy,answerKey,
        loadAttachment:()=>downloadAttachment(attachment,{allowedHosts}),
        runModel:pages=>extractWithTelnyxModel(client,process.env.EXTRACTION_MODEL_ID,pages,{
          reasoningEffort:process.env.EXTRACTION_REASONING_EFFORT,
        }),
      });
      console.log(JSON.stringify({status:'PASS',mode:'LIVE_TELNYX',duplicate:false,jobId:claim.jobId,
        decision:completed.result.decision,documentAccuracy:completed.result.documentAccuracy,
        result:{jsonPath:completed.jsonPath,htmlPath:completed.htmlPath}},null,2));
    }
  }catch(error){
    const code=errorCode(error);
    const blocked=error instanceof WorkflowError && [
      'target_invoice_message_not_found','target_invoice_message_ambiguous','invalid_message_selector',
      'configured_model_not_available','configured_model_not_text_generation','invalid_extraction_model_id',
      'model_context_too_small','invalid_attachment_host_allowlist','invoice_pdf_attachment_not_found',
      'multiple_invoice_pdf_attachments','unsupported_attachment_shape','attachment_host_not_allowed',
      'live_job_already_processing',
    ].includes(code);
    console.error(`${blocked?'BLOCKED':'FAIL'}: ${code}`);
    process.exitCode=blocked?2:1;
  }finally{
    store?.close();
  }
}
