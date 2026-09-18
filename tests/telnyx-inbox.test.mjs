import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Telnyx from 'telnyx';
import {createSharedTestInbox,setLocalInboxId,validateTestInboxReceipt,writeTestInboxReceipt} from '../src/telnyx-inbox.ts';

test('I-001 official SDK creates one shared-subdomain inbox with an empty body',async()=>{
  let calls=0;
  const client=new Telnyx({apiKey:'TEST-NOT-SECRET',baseURL:'https://api.telnyx.test/v2',maxRetries:0,
    fetch:async(url,init)=>{
      calls++;
      assert.equal(String(url),'https://api.telnyx.test/v2/email_inboxes');
      assert.equal(init?.method,'POST');
      assert.equal(String(init?.body),'{}');
      return new Response(JSON.stringify({data:{id:'inbox-test-id',address:'generated@inbound.telnyx.test',
        domain:'inbound.telnyx.test',domain_id:'domain-id',record_type:'email_inbox',settings:{},status:'active',
        created_at:'2026-09-08T16:00:00Z',updated_at:'2026-09-08T16:00:00Z'}}),
        {status:200,headers:{'content-type':'application/json'}});
    }});
  const receipt=await createSharedTestInbox(client);
  assert.equal(calls,1);assert.equal(receipt.inboxId,'inbox-test-id');
  assert.equal(receipt.address,'generated@inbound.telnyx.test');
});

test('I-002 receipt and env update are private and preserve the API key',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'bookkeeping-inbox-'));
  const receiptPath=join(directory,'receipt.json');
  const envPath=join(directory,'.env');
  const receipt={schemaVersion:'telnyx_test_inbox_receipt_v1',inboxId:'inbox-test-id',
    address:'generated@inbound.telnyx.test',domain:'inbound.telnyx.test',status:'active',
    providerCreatedAt:'2026-09-08T16:00:00Z',recordedAt:'2026-09-08T16:01:00Z',
    purpose:'authorized_invoice_to_ledger_test'};
  writeFileSync(envPath,'TELNYX_API_KEY=TEST-SECRET-PRESERVED\nTELNYX_INBOX_ID=\n',{mode:0o600});
  try{
    await writeTestInboxReceipt(receiptPath,receipt);
    await setLocalInboxId(envPath,receipt.inboxId);
    assert.deepEqual(validateTestInboxReceipt(JSON.parse(readFileSync(receiptPath,'utf8'))),receipt);
    assert.match(readFileSync(envPath,'utf8'),/TELNYX_API_KEY=TEST-SECRET-PRESERVED/);
    assert.match(readFileSync(envPath,'utf8'),/TELNYX_INBOX_ID=inbox-test-id/);
    assert.equal(statSync(receiptPath).mode&0o777,0o600);assert.equal(statSync(envPath).mode&0o777,0o600);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
