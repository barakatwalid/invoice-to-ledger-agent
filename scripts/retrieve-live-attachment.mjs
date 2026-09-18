import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Telnyx from 'telnyx';
import { downloadAttachment, parseAllowedAttachmentHosts } from '../src/attachment.ts';
import { errorCode, WorkflowError } from '../src/errors.ts';
import { validateSyntheticAnswerKey } from '../src/slice.ts';
import { findTargetInboxMessage, selectSinglePdfAttachment } from '../src/telnyx-adapter.ts';

const required=['TELNYX_API_KEY','TELNYX_INBOX_ID','TELNYX_TARGET_SUBJECT','TELNYX_ATTACHMENT_HOSTS'];
const missing=required.filter(name=>!process.env[name]);
if(missing.length){
  console.error(`BLOCKED: configure ${missing.join(', ')} locally. Do not paste secrets into chat.`);
  process.exitCode=2;
}else{
  try{
    const answerKey=validateSyntheticAnswerKey(JSON.parse(
      await readFile('fixtures/synthetic-invoice-answer-key.json','utf8')));
    const client=new Telnyx({apiKey:process.env.TELNYX_API_KEY,baseURL:'https://api.telnyx.com/v2',
      timeout:15_000,maxRetries:0});
    const message=await findTargetInboxMessage(client,process.env.TELNYX_INBOX_ID,
      process.env.TELNYX_TARGET_SUBJECT,process.env.TELNYX_TARGET_MESSAGE_ID||null);
    const attachment=selectSinglePdfAttachment(message);
    const downloaded=await downloadAttachment(attachment,{
      allowedHosts:parseAllowedAttachmentHosts(process.env.TELNYX_ATTACHMENT_HOSTS),
    });
    const directory=resolve('.private','received-attachments');
    await mkdir(directory,{recursive:true,mode:0o700});
    const path=resolve(directory,`${downloaded.sha256}.pdf`);
    const temporary=`${path}.${process.pid}-${Date.now()}.tmp`;
    await writeFile(temporary,downloaded.bytes,{mode:0o600,flag:'wx'});
    await rename(temporary,path);
    console.log(JSON.stringify({status:'PASS',mode:'LIVE_TELNYX_ATTACHMENT_ONLY',
      filename:attachment.filename,sizeBytes:downloaded.sizeBytes,sha256:downloaded.sha256,
      matchesSyntheticOriginal:downloaded.sha256===answerKey.pdfSha256,path,
      note:'Actual Telnyx attachment downloaded without forwarding the API key. No model request ran.'},null,2));
  }catch(error){
    console.error(`FAIL: ${errorCode(error)}`);
    process.exitCode=error instanceof WorkflowError&&error.retryable?2:1;
  }
}
