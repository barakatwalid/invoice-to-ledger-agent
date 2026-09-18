import {resolve} from 'node:path';
import Telnyx from 'telnyx';
import {errorCode} from '../src/errors.ts';
import {JobStore} from '../src/job-store.ts';
import {jobIdentity} from '../src/slice.ts';
import {listInboxMessages,selectSingleInvoiceAttachment} from '../src/telnyx-adapter.ts';

const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const token=value=>typeof value==='string'?value.trim().toLowerCase():null;
const attachmentDescriptor=value=>{
  if(!record(value))return {shape:'invalid'};
  const nestedType=record(value.content_type)?value.content_type.content_type:null;
  const nestedDisposition=record(value.content_disposition)?value.content_disposition.content_disposition:null;
  const nestedTypeParams=record(value.content_type)&&record(value.content_type.params)?value.content_type.params:null;
  const nestedDispositionParams=record(value.content_disposition)&&record(value.content_disposition.params)?
    value.content_disposition.params:null;
  return {
    shape:'object',declaredContentType:token(nestedType??value.content_type),
    disposition:token(nestedDisposition??value.content_disposition??value.disposition),
    hasUrl:typeof value.url==='string',
    hasFilename:typeof value.filename==='string'||typeof nestedTypeParams?.name==='string'||
      typeof nestedDispositionParams?.filename==='string',
  };
};

if(!process.env.TELNYX_API_KEY?.trim()||!process.env.TELNYX_INBOX_ID?.trim()){
  console.error('BLOCKED: configure TELNYX_API_KEY and TELNYX_INBOX_ID locally. Do not paste values into chat.');
  process.exitCode=2;
}else{
  const directory=resolve(process.env.BOOKKEEPING_DATA_DIR?.trim()||'.private');
  let store;
  try{
    const client=new Telnyx({apiKey:process.env.TELNYX_API_KEY,baseURL:'https://api.telnyx.com/v2',
      timeout:15_000,maxRetries:0});
    const messages=await listInboxMessages(client,process.env.TELNYX_INBOX_ID);
    store=new JobStore(resolve(directory,'live-slice.sqlite'));
    let eligibleSupportedMessages=0;let unsupportedMessages=0;let knownJobs=0;let newJobs=0;
    for(const message of messages){
      try{
        const attachment=selectSingleInvoiceAttachment(message);eligibleSupportedMessages++;
        const id=jobIdentity(`telnyx-email:${message.inboxId}:${message.id}:${attachment.index}`);
        if(store.state(id)===null)newJobs++;else knownJobs++;
      }catch(error){
        if(['invoice_attachment_not_found','multiple_invoice_attachments'].includes(errorCode(error))){
          unsupportedMessages++;continue;
        }
        throw error;
      }
    }
    const newest=[...messages].sort((left,right)=>Date.parse(right.receivedAt)-Date.parse(left.receivedAt))[0];
    let newestMessageClassification=null;
    if(newest){
      try{
        const selected=selectSingleInvoiceAttachment(newest);
        newestMessageClassification={status:'eligible',attachmentCount:newest.attachments.length,
          selectedContentType:selected.contentType};
      }catch(error){
        newestMessageClassification={status:'unsupported',reason:errorCode(error),
          attachmentCount:newest.attachments.length,
          attachments:newest.attachments.map(attachmentDescriptor)};
      }
    }
    console.log(JSON.stringify({status:'PASS',receivedMessages:messages.length,eligibleSupportedMessages,
      knownJobs,newJobs,unsupportedMessages,newestReceivedAt:newest?.receivedAt??null,newestMessageClassification,
      attachmentsDownloaded:0,modelCalls:0,secretsPrinted:false},null,2));
  }catch(error){
    console.error(`FAIL: ${errorCode(error)}`);process.exitCode=1;
  }finally{store?.close();}
}
