import Telnyx from 'telnyx';
import {errorCode} from '../src/errors.ts';
import {listInboxMessages,selectSingleInvoiceAttachment} from '../src/telnyx-adapter.ts';

const subject=process.argv[2]?.trim();
if(!process.env.TELNYX_API_KEY?.trim()||!process.env.TELNYX_INBOX_ID?.trim()||!subject){
  console.error('BLOCKED: local credentials and one exact subject argument are required.');
  process.exitCode=2;
}else{
  try{
    const client=new Telnyx({apiKey:process.env.TELNYX_API_KEY,baseURL:'https://api.telnyx.com/v2',
      timeout:15_000,maxRetries:0});
    const messages=await listInboxMessages(client,process.env.TELNYX_INBOX_ID);
    const normalized=subject.toLocaleLowerCase('en-US');
    const exact=messages.filter(message=>message.subject===subject);
    const caseInsensitive=messages.filter(message=>message.subject.toLocaleLowerCase('en-US')===normalized);
    const trimmedCaseInsensitive=messages.filter(message=>message.subject.trim().toLocaleLowerCase('en-US')===
      normalized.trim());
    const contains=messages.filter(message=>message.subject.toLocaleLowerCase('en-US').includes(normalized));
    const candidates=trimmedCaseInsensitive.length?trimmedCaseInsensitive:contains;
    const classifications=candidates.map(message=>{
      try{
        const attachment=selectSingleInvoiceAttachment(message);
        return {status:'eligible',contentType:attachment.contentType};
      }catch(error){
        return {status:'unsupported',reason:errorCode(error)};
      }
    });
    console.log(JSON.stringify({status:'PASS',receivedMessages:messages.length,
      exactSubjectMatches:exact.length,caseInsensitiveMatches:caseInsensitive.length,
      trimmedCaseInsensitiveMatches:trimmedCaseInsensitive.length,containsSubjectMatches:contains.length,
      classifications,
      attachmentsDownloaded:0,modelCalls:0,secretsPrinted:false},null,2));
  }catch(error){
    console.error(`FAIL: ${errorCode(error)}`);process.exitCode=1;
  }
}
