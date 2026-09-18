import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {JobStore} from '../src/job-store.ts';

const resultJson=(supplierName,invoiceNumber)=>JSON.stringify({extraction:{values:{
  supplierName:{value:supplierName},invoiceNumber:{value:invoiceNumber},
}}});

function complete(store,id,supplierName,invoiceNumber){
  const claim=store.claim({id,sourceKey:`telnyx:test-inbox:${id}:0`,inboxId:'test-inbox',
    messageId:id,attachmentIndex:0,filename:'invoice.pdf'});
  assert.equal(claim.outcome,'claimed');
  store.recordDownloaded(claim.jobId,claim.claimToken,'e'.repeat(64),10,'/private/result.pdf');
  store.recordTextExtracted(claim.jobId,claim.claimToken);
  store.recordModelCompleted(claim.jobId,claim.claimToken,'verified-model');
  store.complete(claim.jobId,claim.claimToken,resultJson(supplierName,invoiceNumber));
}

test('J-001 durable unique source key prevents concurrent duplicate processing and permits failed retry',()=>{
  const directory=mkdtempSync(join(tmpdir(),'bookkeeping-job-store-'));
  const path=join(directory,'jobs.sqlite');
  const first=new JobStore(path);const second=new JobStore(path);
  assert.equal(statSync(path).mode&0o777,0o600);
  const job={id:'a'.repeat(64),sourceKey:'telnyx:test-inbox:test-message:0',inboxId:'test-inbox',
    messageId:'test-message',attachmentIndex:0,filename:'invoice.pdf'};
  try{
    const claim=first.claim(job);assert.equal(claim.outcome,'claimed');assert.equal(claim.attempt,1);
    assert.equal(second.claim(job).outcome,'already_processing');
    first.fail(claim.jobId,claim.claimToken,'attachment_http_503');
    const retry=second.claim(job);assert.equal(retry.outcome,'claimed');assert.equal(retry.attempt,2);
    second.recordDownloaded(retry.jobId,retry.claimToken,'b'.repeat(64),10,'/private/result.pdf');
    second.recordTextExtracted(retry.jobId,retry.claimToken);
    second.recordModelCompleted(retry.jobId,retry.claimToken,'verified-model');
    second.complete(retry.jobId,retry.claimToken,'{"status":"review"}');
    const duplicate=first.claim(job);assert.equal(duplicate.outcome,'duplicate_completed');
    assert.equal(JSON.parse(duplicate.resultJson).status,'review');
  }finally{first.close();second.close();rmSync(directory,{recursive:true,force:true});}
});

test('J-002 startup recovery releases interrupted claims and retry limits fail closed',()=>{
  const directory=mkdtempSync(join(tmpdir(),'bookkeeping-job-recovery-'));
  const store=new JobStore(join(directory,'jobs.sqlite'));
  const job={id:'c'.repeat(64),sourceKey:'telnyx:test-inbox:interrupted:0',inboxId:'test-inbox',
    messageId:'interrupted',attachmentIndex:0,filename:'invoice.pdf'};
  try{
    assert.equal(store.claim(job,2).outcome,'claimed');
    assert.equal(store.overview().counts.processing,1);
    assert.equal(store.recoverInterruptedJobs(),1);
    const retry=store.claim(job,2);assert.equal(retry.outcome,'claimed');assert.equal(retry.attempt,2);
    store.fail(retry.jobId,retry.claimToken,'model_output_not_json');
    assert.deepEqual(store.claim(job,2),{outcome:'retry_exhausted',jobId:job.id,attempts:2});
    const overview=store.overview(5);
    assert.equal(overview.counts.failed,1);assert.equal(overview.recent[0].errorCode,'model_output_not_json');
    assert.equal(overview.latestCompletedJobId,null);assert.equal(store.result(job.id),null);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('J-003 completed results are retrievable for authenticated serving',()=>{
  const directory=mkdtempSync(join(tmpdir(),'bookkeeping-job-result-'));
  const store=new JobStore(join(directory,'jobs.sqlite'));
  const job={id:'d'.repeat(64),sourceKey:'telnyx:test-inbox:complete:0',inboxId:'test-inbox',
    messageId:'complete',attachmentIndex:0,filename:'invoice.pdf'};
  try{
    const claim=store.claim(job);assert.equal(claim.outcome,'claimed');
    store.recordDownloaded(claim.jobId,claim.claimToken,'e'.repeat(64),10,'/private/result.pdf');
    store.recordTextExtracted(claim.jobId,claim.claimToken);
    store.recordModelCompleted(claim.jobId,claim.claimToken,'verified-model');
    store.complete(claim.jobId,claim.claimToken,'{"status":"review"}');
    assert.deepEqual(store.result(job.id),{status:'review'});
    assert.deepEqual(store.state(job.id),{state:'completed',attempts:1});
    assert.equal(store.overview().latestCompletedJobId,job.id);
    assert.throws(()=>store.result('../private'),error=>error.code==='invalid_result_job_id');
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('J-004 active batch distinguishes count-only from exact manifest completeness',()=>{
  const directory=mkdtempSync(join(tmpdir(),'bookkeeping-job-batch-'));
  const store=new JobStore(join(directory,'jobs.sqlite'));
  try{
    let batch=store.configureActiveBatch({label:'2026 Q3',expectedCount:2,expectedManifest:null,
      includeUnassignedJobs:false});
    assert.equal(batch.completeness.status,'incomplete');assert.equal(batch.jobs.total,0);
    complete(store,'1'.repeat(64),'Vendor A','INV-1');complete(store,'2'.repeat(64),'Vendor B','INV-2');
    batch=store.latestBatchOverview();assert.equal(batch.completeness.status,'count_match_only');
    assert.equal(batch.completeness.uniqueReceived,2);assert.equal(batch.jobs.completed,2);
    batch=store.configureActiveBatch({label:'2026 Q3',expectedCount:2,expectedManifest:[
      {supplierName:'Vendor A',invoiceNumber:'INV-1'},
      {supplierName:'Vendor B',invoiceNumber:'INV-2'},
    ],includeUnassignedJobs:false});
    assert.equal(batch.completeness.status,'manifest_match');
    assert.deepEqual(batch.completeness.missingReferences,[]);
    assert.deepEqual(batch.completeness.unexpectedReferences,[]);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('J-005 unsupported receipts and unresolved identities prevent false completeness',()=>{
  const directory=mkdtempSync(join(tmpdir(),'bookkeeping-job-batch-review-'));
  const store=new JobStore(join(directory,'jobs.sqlite'));
  try{
    store.configureActiveBatch({label:'2026 Q3',expectedCount:1,expectedManifest:null,
      includeUnassignedJobs:false});
    complete(store,'3'.repeat(64),'Vendor A','');
    store.recordInboxReceipt({sourceKey:'telnyx:test-inbox:unsupported',inboxId:'test-inbox',
      messageId:'unsupported',receivedAt:'2026-09-09T00:00:00Z',classification:'unsupported',
      reasonCode:'invoice_attachment_not_found'});
    const batch=store.latestBatchOverview();
    assert.equal(batch.completeness.countState,'match');assert.equal(batch.completeness.status,'needs_review');
    assert.deepEqual(batch.completeness.issues,['unresolved_documents']);
    assert.equal(batch.jobs.unresolved,1);assert.equal(batch.jobs.unsupportedReceipts,1);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('J-006 existing records join a new batch only after explicit inclusion',()=>{
  const directory=mkdtempSync(join(tmpdir(),'bookkeeping-job-batch-existing-'));
  const store=new JobStore(join(directory,'jobs.sqlite'));
  try{
    complete(store,'4'.repeat(64),'Vendor A','INV-4');
    store.recordInboxReceipt({sourceKey:'telnyx:test-inbox:old-unsupported',inboxId:'test-inbox',
      messageId:'old-unsupported',receivedAt:'2026-09-09T00:00:00Z',classification:'unsupported',
      reasonCode:'invoice_attachment_not_found'});
    let batch=store.configureActiveBatch({label:'Imported quarter',expectedCount:1,expectedManifest:null,
      includeUnassignedJobs:false});
    assert.equal(batch.jobs.total,0);assert.equal(batch.jobs.unsupportedReceipts,0);
    batch=store.configureActiveBatch({label:'Imported quarter',expectedCount:1,expectedManifest:null,
      includeUnassignedJobs:true});
    assert.equal(batch.jobs.total,1);assert.equal(batch.jobs.unsupportedReceipts,0);
    assert.equal(batch.completeness.status,'count_match_only');
    const closed=store.closeActiveBatch();assert.equal(closed.state,'closed');
    assert.equal(store.latestBatchOverview().state,'closed');
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('J-007 existing databases migrate the jobs table before batch assignment',()=>{
  const directory=mkdtempSync(join(tmpdir(),'bookkeeping-job-batch-migration-'));
  const path=join(directory,'jobs.sqlite');
  const initial=new JobStore(path);initial.close();
  const raw=new DatabaseSync(path);raw.exec('DROP INDEX jobs_batch_id; ALTER TABLE jobs DROP COLUMN batch_id;');raw.close();
  const migrated=new JobStore(path);
  try{
    migrated.configureActiveBatch({label:'Migrated',expectedCount:1,expectedManifest:null,
      includeUnassignedJobs:false});
    complete(migrated,'5'.repeat(64),'Vendor A','INV-5');
    assert.equal(migrated.latestBatchOverview().jobs.total,1);
  }finally{migrated.close();rmSync(directory,{recursive:true,force:true});}
});

test('J-008 invalid or duplicate manifest identities fail closed',()=>{
  const directory=mkdtempSync(join(tmpdir(),'bookkeeping-job-batch-invalid-'));
  const store=new JobStore(join(directory,'jobs.sqlite'));
  try{
    assert.throws(()=>store.configureActiveBatch({label:'Q3',expectedCount:2,expectedManifest:[
      {supplierName:'Vendor',invoiceNumber:'INV-1'},
    ],includeUnassignedJobs:false}),error=>error.code==='invalid_batch_configuration');
    assert.throws(()=>store.configureActiveBatch({label:'Q3',expectedCount:2,expectedManifest:[
      {supplierName:'Vendor',invoiceNumber:'INV-1'},
      {supplierName:'Vendor',invoiceNumber:'INV-1'},
    ],includeUnassignedJobs:false}),error=>error.code==='invalid_batch_configuration');
    assert.throws(()=>store.recordInboxReceipt({sourceKey:'x',inboxId:'i',messageId:'m',receivedAt:'bad',
      classification:'unsupported',reasonCode:'Unsafe message'}),error=>error.code==='invalid_inbox_receipt');
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('J-009 closed batch history remains available after a new batch starts',()=>{
  const directory=mkdtempSync(join(tmpdir(),'bookkeeping-job-batch-history-'));
  const store=new JobStore(join(directory,'jobs.sqlite'));
  try{
    store.configureActiveBatch({label:'2026 Q3 presentation',expectedCount:2,expectedManifest:null,
      includeUnassignedJobs:false});
    complete(store,'6'.repeat(64),'Vendor A','INV-6');
    complete(store,'7'.repeat(64),'Vendor B','INV-7');
    store.closeActiveBatch();
    store.configureActiveBatch({label:'New batch',expectedCount:2,expectedManifest:null,
      includeUnassignedJobs:false});
    const history=store.batchHistory();
    assert.equal(history.length,2);assert.equal(history[0].label,'New batch');
    assert.equal(history[0].state,'active');assert.equal(history[1].label,'2026 Q3 presentation');
    assert.equal(history[1].state,'closed');assert.equal(history[1].completeness.uniqueReceived,2);
    assert.equal(history[1].completeness.status,'count_match_only');
    assert.throws(()=>store.batchHistory(0),error=>error.code==='invalid_batch_history_limit');
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
