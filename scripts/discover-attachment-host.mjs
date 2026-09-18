import Telnyx from 'telnyx';
import {attachmentHostname} from '../src/attachment.ts';
import {errorCode,WorkflowError} from '../src/errors.ts';
import {findTargetInboxMessage,selectSinglePdfAttachment} from '../src/telnyx-adapter.ts';

const required=['TELNYX_API_KEY','TELNYX_INBOX_ID','TELNYX_TARGET_SUBJECT'];
const missing=required.filter(name=>!process.env[name]);
if(missing.length){
  console.error(`BLOCKED: configure ${missing.join(', ')} in local .env. Do not paste secret values into chat.`);
  process.exitCode=2;
}else{
  try{
    const client=new Telnyx({
      apiKey:process.env.TELNYX_API_KEY,
      baseURL:'https://api.telnyx.com/v2',
      timeout:15_000,
      maxRetries:2,
    });
    const message=await findTargetInboxMessage(client,process.env.TELNYX_INBOX_ID,
      process.env.TELNYX_TARGET_SUBJECT,process.env.TELNYX_TARGET_MESSAGE_ID||null);
    const attachment=selectSinglePdfAttachment(message);
    console.log(JSON.stringify({
      status:'PASS',
      mode:'READ_ONLY_ATTACHMENT_HOST_DISCOVERY',
      attachmentHostname:attachmentHostname(attachment),
      note:'No attachment was downloaded. No message body, attachment URL, email address, or credential was logged. Verify this exact hostname before adding it to TELNYX_ATTACHMENT_HOSTS.',
    },null,2));
  }catch(error){
    const code=errorCode(error);
    const blocked=error instanceof WorkflowError && [
      'target_invoice_message_not_found','target_invoice_message_ambiguous',
      'invoice_pdf_attachment_not_found','multiple_invoice_pdf_attachments',
      'unsupported_attachment_shape','unsupported_attachment_type','invalid_attachment_url',
    ].includes(code);
    console.error(`${blocked?'BLOCKED':'FAIL'}: ${code}`);
    process.exitCode=blocked?2:1;
  }
}
