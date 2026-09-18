import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import Telnyx from 'telnyx';
import {createSharedTestInbox,setLocalInboxId,validateTestInboxReceipt,writeTestInboxReceipt} from '../src/telnyx-inbox.ts';
import {errorCode} from '../src/errors.ts';

const key=process.env.TELNYX_API_KEY;
if(!key){
  console.error('BLOCKED: configure TELNYX_API_KEY in local .env. Do not paste it into chat.');
  process.exitCode=2;
}else{
  const receiptPath=resolve('.private/telnyx-test-inbox.json');
  try{
    let receipt;
    let outcome='CREATED';
    try{
      receipt=validateTestInboxReceipt(JSON.parse(await readFile(receiptPath,'utf8')));
      outcome='ALREADY_RECORDED_NO_REMOTE_CALL';
    }catch(error){
      if(!(error && typeof error==='object' && 'code' in error && error.code==='ENOENT'))throw error;
      const client=new Telnyx({
        apiKey:key,
        baseURL:'https://api.telnyx.com/v2',
        timeout:15_000,
        maxRetries:0,
      });
      receipt=await createSharedTestInbox(client);
      await writeTestInboxReceipt(receiptPath,receipt);
    }
    await setLocalInboxId(resolve('.env'),receipt.inboxId);
    console.log(JSON.stringify({
      status:'PASS',outcome,inboxId:receipt.inboxId,address:receipt.address,
      inboxStatus:receipt.status,receiptPath,
      note:'TELNYX_INBOX_ID was set in local .env. The API key was not printed.',
    },null,2));
  }catch(error){
    const httpStatus=error && typeof error==='object' && 'status' in error && Number.isInteger(error.status)?error.status:null;
    const code=httpStatus===null?errorCode(error):`provider_http_${httpStatus}`;
    console.error(`FAIL: ${code}. No automatic retry; inspect the account inbox list before trying again.`);
    process.exitCode=1;
  }
}
