import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import edgeHandler from '../src/edge/index.ts';
import {
  eligibleInvoiceMessagesReceivedAfter,
  evaluateEdgeBatch,
  intakeCutoffForStart,
  validateEdgeBatchConfiguration,
} from '../src/edge/bookkeeping-agent.ts';
import {
  deriveEdgeViewerToken,
  hasAuthorizedBearer,
  hasAuthorizedViewer,
  readEdgeApiKey,
  readEdgeAgentConfig,
  readEdgeControlToken,
  readEdgePdfRendererConfig,
  validateEdgeAgentConfig,
  validateStoredEdgeAgentConfig,
} from '../src/edge/config.ts';

const validConfig={
  inboxId:'550e8400-e29b-41d4-a716-446655440000',
  modelId:'provider/verified-model',
  attachmentHosts:['Files.Telnyx.Test'],
  pollIntervalSeconds:60,
};

function secretReader(values={}){
  const defaults={
    CONTROL_TOKEN:'c'.repeat(32),
    INBOX_ID:validConfig.inboxId,
    MODEL_ID:validConfig.modelId,
    ATTACHMENT_HOSTS:'Files.Telnyx.Test',
    API_KEY:'TEST-TELNYX-API-KEY',
    PDF_RENDERER_URL:'https://bookkeeping-pdf-renderer-abc123-e.telnyxcompute.com',
    PDF_RENDERER_TOKEN:'r'.repeat(48),
  };
  return {get:async handle=>({...defaults,...values})[handle]};
}

test('E-001 generated Agent SDK manifest uses one actor, Telnyx binding, and named secret handles',()=>{
  const manifest=readFileSync('telnyx.toml','utf8');
  assert.match(manifest,/main = "src\/edge\/index\.ts"/);
  assert.match(manifest,/compatibility_date = "2026-05-01"/);
  assert.match(manifest,/binding = "INVOICE_AGENT"\s+type = "BookkeepingAgentV2"/);
  assert.match(manifest,/\[telnyx\]\s+binding = "TELNYX"/);
  assert.ok(!manifest.includes('func_id ='));
  for(const handle of ['CONTROL_TOKEN','INBOX_ID','MODEL_ID','ATTACHMENT_HOSTS','API_KEY',
    'PDF_RENDERER_URL','PDF_RENDERER_TOKEN']){
    assert.match(manifest,new RegExp(`binding = "${handle}"`));
  }
  assert.ok(!manifest.includes('binding = "TARGET_SUBJECT"'));
  assert.ok(!manifest.includes('func.toml'));
  assert.ok(!/KEY[0-9A-Za-z_-]{20,}/.test(manifest));
});

test('E-002 edge config reads environment-specific values only through declared secret handles',async()=>{
  const config=await readEdgeAgentConfig(secretReader());
  assert.deepEqual(config,{...validConfig,attachmentHosts:['files.telnyx.test']});
  assert.equal(await readEdgeControlToken(secretReader()),'c'.repeat(32));
  const viewerToken=await deriveEdgeViewerToken('c'.repeat(32));
  assert.equal(viewerToken.length,43);assert.notEqual(viewerToken,'c'.repeat(32));
  assert.equal(await readEdgeApiKey(secretReader()),'TEST-TELNYX-API-KEY');
  assert.deepEqual(await readEdgePdfRendererConfig(secretReader()),{
    baseUrl:'https://bookkeeping-pdf-renderer-abc123-e.telnyxcompute.com',token:'r'.repeat(48),
  });
});

test('E-003 edge config fails closed on malformed identities, hosts, extras, and missing secrets',async()=>{
  assert.throws(()=>validateEdgeAgentConfig({...validConfig,inboxId:'------------------------------------'}));
  assert.throws(()=>validateEdgeAgentConfig({...validConfig,attachmentHosts:['127.0.0.1']}));
  assert.throws(()=>validateEdgeAgentConfig({...validConfig,extra:true}));
  await assert.rejects(()=>readEdgeAgentConfig(secretReader({MODEL_ID:''})),error=>error.code==='edge_missing_model_id');
  await assert.rejects(()=>readEdgeAgentConfig({get:async()=>{throw new Error('private provider detail');}}),
    error=>error.code==='edge_secret_read_failed'&&!error.message.includes('private provider detail'));
  await assert.rejects(()=>readEdgeApiKey(secretReader({API_KEY:'short'})),
    error=>error.code==='invalid_edge_api_key');
  await assert.rejects(()=>readEdgePdfRendererConfig(secretReader({PDF_RENDERER_URL:'http://localhost:3000'})),
    error=>error.code==='invalid_edge_pdf_renderer_config');
  await assert.rejects(()=>deriveEdgeViewerToken('short'),error=>error.code==='invalid_edge_control_token');
  assert.deepEqual(validateStoredEdgeAgentConfig({...validConfig,targetSubject:'Legacy exact subject'}),
    {...validConfig,attachmentHosts:['files.telnyx.test']});
  assert.throws(()=>validateStoredEdgeAgentConfig({...validConfig,unrecognizedLegacyField:'x'}),
    error=>error.code==='invalid_edge_agent_config');
});

test('E-004 edge authorization keeps the viewer password separate from the control bearer',()=>{
  const token='t'.repeat(32);
  assert.equal(hasAuthorizedBearer(new Request('https://edge.test/status',{headers:{authorization:`Bearer ${token}`}}),token),true);
  assert.equal(hasAuthorizedBearer(new Request('https://edge.test/status',{headers:{authorization:`Bearer ${token}x`}}),token),false);
  assert.equal(hasAuthorizedBearer(new Request('https://edge.test/status',{headers:{authorization:`bearer ${token}`}}),token),false);
  assert.equal(hasAuthorizedBearer(new Request('https://edge.test/status'),token),false);
  const viewer='v'.repeat(32);
  const basic=value=>`Basic ${Buffer.from(value).toString('base64')}`;
  assert.equal(hasAuthorizedViewer(new Request('https://edge.test/',{headers:{authorization:basic(`review:${viewer}`)}}),viewer),true);
  assert.equal(hasAuthorizedViewer(new Request('https://edge.test/',{headers:{authorization:basic(`admin:${viewer}`)}}),viewer),false);
  assert.equal(hasAuthorizedViewer(new Request('https://edge.test/',{headers:{authorization:basic(`review:${viewer}x`)}}),viewer),false);
  assert.equal(hasAuthorizedViewer(new Request('https://edge.test/',{headers:{authorization:'Basic %%%'}}),viewer),false);
});

test('E-005 health is public but actor status is blocked before actor access without authorization',async()=>{
  let actorAccessed=false;
  const expectedStatus={running:true,phase:'waiting'};
  const env={
    SECRETS:secretReader(),
    INVOICE_AGENT:{idFromName(name){
      actorAccessed=true;assert.equal(name,'authorized-bookkeeping-inbox-http-v1');
      return {status:async()=>expectedStatus};
    }},
  };
  const health=await edgeHandler.fetch(new Request('https://edge.test/health'),env);
  assert.equal(health.status,200);
  assert.deepEqual(await health.json(),{status:'ready',service:'invoice-to-ledger-agent'});
  const blocked=await edgeHandler.fetch(new Request('https://edge.test/status'),env);
  assert.equal(blocked.status,401);assert.equal(actorAccessed,false);
  assert.equal(blocked.headers.get('cache-control'),'no-store');
  const allowed=await edgeHandler.fetch(new Request('https://edge.test/status',{
    headers:{authorization:`Bearer ${'c'.repeat(32)}`},
  }),env);
  assert.equal(allowed.status,200);assert.equal(actorAccessed,true);
  assert.deepEqual(await allowed.json(),expectedStatus);
});

test('E-005b actor outage produces a protected maintenance dashboard and safe status response',async()=>{
  const privateProviderError=new Error('SqliteSidecarServer fence URL and private actor details');
  const env={
    SECRETS:secretReader(),
    INVOICE_AGENT:{idFromName(name){
      assert.equal(name,'authorized-bookkeeping-inbox-http-v1');
      return {status:async()=>{throw privateProviderError;}};
    }},
  };
  const viewerToken=await deriveEdgeViewerToken('c'.repeat(32));
  const authorization=`Basic ${Buffer.from(`review:${viewerToken}`).toString('base64')}`;
  const page=await edgeHandler.fetch(new Request('https://edge.test/',{headers:{authorization}}),env);
  assert.equal(page.status,503);
  assert.match(page.headers.get('content-type'),/^text\/html/);
  assert.equal(page.headers.get('retry-after'),'30');
  assert.equal(page.headers.get('cache-control'),'private, no-store');
  assert.match(page.headers.get('content-security-policy'),/default-src 'none'/);
  assert.equal(page.headers.get('x-frame-options'),'DENY');
  const html=await page.text();
  assert.match(html,/StatefulActor storage is temporarily unavailable/);
  assert.match(html,/Processing is safely paused/);
  assert.match(html,/No invoice retry, deletion, payment or posting was triggered/);
  assert.doesNotMatch(html,/unexpected_error/);
  assert.doesNotMatch(html,/SqliteSidecarServer/);
  assert.doesNotMatch(html,/private actor details/);

  const status=await edgeHandler.fetch(new Request('https://edge.test/status',{
    headers:{authorization:`Bearer ${'c'.repeat(32)}`},
  }),env);
  assert.equal(status.status,503);
  assert.equal(status.headers.get('content-type'),'application/json');
  assert.deepEqual(await status.json(),{status:'blocked',error:'unexpected_error'});
});

test('E-006 hosted dashboard is viewer-protected, read-only, escaped, and omits private evidence',async()=>{
  const jobId='a'.repeat(64);
  const batch={id:'batch-1',state:'active',label:'Quarterly invoice batch',expectedCount:1,expectedManifest:null,
    startedAt:'2026-09-09T09:55:00.000Z',closedAt:null,
    jobs:{total:1,pending:0,processing:0,completed:1,failed:0,unresolved:0,unsupportedReceipts:0},
    completeness:{status:'count_match_only',uniqueReceived:1,duplicateOccurrences:0,expectedCount:1,
      countState:'match',missingReferences:[],unexpectedReferences:[],issues:[]}};
  const expectedStatus={running:false,phase:'ready',lastPolledAt:'2026-09-09T10:00:00.000Z',
    lastCompletedJobId:jobId,lastError:null,jobs:{pending:0,processing:0,complete:1,failed:0},batch,batches:[batch],
    recentJobs:[{id:jobId,status:'complete',filename:'invoice.pdf',receivedAt:'2026-09-09T10:00:00.000Z',
      supplierName:'Northstar',invoiceNumber:'BK-2026-001',currency:'USD',printedTotal:'150.00',
      decision:'proposal_ready_for_human_review',errorCode:null,createdAt:'2026-09-09T10:00:00.000Z',
      updatedAt:'2026-09-09T10:01:00.000Z'}]};
  const expectedMonitor={available:true,refreshedAt:'2026-09-09T10:02:00.000Z',
    scopeStartedAt:'2026-09-09T09:55:00.000Z',receivedMessages:1,eligiblePdfMessages:1,
    knownJobs:1,waitingJobs:0,unsupportedMessages:0,
    newestEligible:{receivedAt:'2026-09-09T10:00:00.000Z',filename:'invoice.pdf'}};
  const sourced=(value,quote='PRIVATE SOURCE QUOTE')=>({value,evidence:{page:1,quote}});
  const result={
    completedAt:'2026-09-09T10:01:00.000Z',
    intake:{attachment:{filename:'invoice.pdf',contentType:'application/pdf',sha256:'PRIVATE-HASH-SHOULD-NOT-APPEAR'}},
    extraction:{configuredModelId:'provider/model',responseModelId:'provider/model',values:{
      supplierName:sourced('<script>alert(1)</script> Northstar'),supplierAddress:sourced('Demo Street'),
      supplierTaxRegistrationId:sourced('VAT-001'),invoiceNumber:sourced('BK-2026-001'),
      invoiceDate:sourced('2026-09-09'),currency:sourced('USD'),subtotal:sourced('140.00'),tax:sourced('10.00'),
      total:sourced('150.00'),lines:[{description:sourced('Demo item'),quantity:sourced('2'),
        unitPrice:sourced('70.00'),lineNet:sourced('140.00')}],
    }},
    arithmetic:{status:'arithmetic_consistent',checks:[
      {path:'subtotal',printed:'140.00',calculated:'140.00',delta:'0.00',matches:true},
    ]},
    accountingProposal:{status:'suggested_human_review_required',entries:[
      {side:'debit',accountId:'DEMO-6000-UNCLASSIFIED-EXPENSE',amount:'150.00',currency:'USD'},
      {side:'credit',accountId:'DEMO-2000-ACCOUNTS-PAYABLE',amount:'150.00',currency:'USD'},
    ]},
    decision:'proposal_ready_for_human_review',controls:{automaticPosting:false},
  };
  let actorAccesses=0;
  const documentBytes=new TextEncoder().encode('%PDF-safe-preview');
  const env={SECRETS:secretReader(),INVOICE_AGENT:{idFromName(name){
    actorAccesses++;assert.equal(name,'authorized-bookkeeping-inbox-http-v1');
    return {status:async()=>expectedStatus,inboxMonitor:async()=>expectedMonitor,
      result:async id=>{assert.equal(id,jobId);return result;},
      invoiceDocument:async id=>{assert.equal(id,jobId);return {bytes:documentBytes,
        contentType:'application/pdf',filename:'invoice.pdf',sizeBytes:documentBytes.byteLength};}};
  }}};
  const blocked=await edgeHandler.fetch(new Request('https://edge.test/'),env);
  assert.equal(blocked.status,401);assert.equal(actorAccesses,0);
  assert.match(blocked.headers.get('www-authenticate'),/^Basic /);

  const viewerToken=await deriveEdgeViewerToken('c'.repeat(32));
  const authorization=`Basic ${Buffer.from(`review:${viewerToken}`).toString('base64')}`;
  const allowed=await edgeHandler.fetch(new Request('https://edge.test/',{headers:{authorization}}),env);
  assert.equal(allowed.status,200);assert.equal(actorAccesses,1);
  assert.match(allowed.headers.get('content-type'),/^text\/html/);
  assert.match(allowed.headers.get('content-security-policy'),/default-src 'none'/);
  assert.equal(allowed.headers.get('x-frame-options'),'DENY');
  const html=await allowed.text();
  assert.match(html,/Step 3 · Accounting/);assert.match(html,/DEMO-6000-UNCLASSIFIED-EXPENSE/);
  assert.match(html,/Step 4 · Reconciliation/);assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt; Northstar/);
  assert.match(html,/Step 1 · Completeness/);assert.match(html,/1 of 1 unique invoice received/);
  assert.match(html,/Live inbox monitor/);assert.match(html,/Waiting to claim/);
  assert.match(html,/dashboard-layout"><aside class="dashboard-rail"/);
  assert.doesNotMatch(html,/class="flow"/);
  assert.match(html,/How it works/);assert.match(html,/invoice\.pdf/);
  assert.match(html,/Invoice archive/);assert.match(html,new RegExp(`/invoices/${jobId}`));
  assert.doesNotMatch(html,/View technical JSON/);
  assert.doesNotMatch(html,/<script>/);assert.doesNotMatch(html,/PRIVATE SOURCE QUOTE/);
  assert.doesNotMatch(html,/PRIVATE-HASH-SHOULD-NOT-APPEAR/);

  const guide=await edgeHandler.fetch(new Request('https://edge.test/how-it-works',{headers:{authorization}}),env);
  assert.equal(guide.status,200);assert.equal(actorAccesses,1);
  const guideHtml=await guide.text();
  assert.match(guideHtml,/What happens to an invoice\?/);
  assert.match(guideHtml,/StatefulActor/);assert.match(guideHtml,/Telnyx PDF renderer turns up to 10 scanned pages/i);
  assert.match(guideHtml,/popovertarget="actor-info"/);assert.match(guideHtml,/Claims every invoice once/);
  assert.match(guideHtml,/Downloads into temporary memory/);assert.match(guideHtml,/Your Mac is not part of the live runtime/);
  assert.match(guideHtml,/Direct JPEG\/PNG skips rendering/i);
  assert.match(guideHtml,/zai-org\/GLM-5\.3-Flash/);
  assert.match(guideHtml,/GLM reads the JPEG pages/);assert.match(guideHtml,/The images are sent to the LLM/);
  assert.match(guideHtml,/GLM reads the image/);assert.match(guideHtml,/zai-org\/GLM-5\.3-Flash via Telnyx Inference/);
  assert.match(guideHtml,/Digital PDF: one AI call/);assert.match(guideHtml,/then a second AI call to structure/);
  assert.match(guideHtml,/Every value carries its page number and exact source quote/);
  assert.doesNotMatch(guideHtml,/Telnyx Vision reads/);
  assert.match(guideHtml,/The LLM extracts; the StatefulActor checks/);assert.match(guideHtml,/Exact-decimal math checks/);
  assert.match(guideHtml,/popovertarget="check-info"/);assert.match(guideHtml,/The StatefulActor runs Step 3/);
  assert.match(guideHtml,/The LLM does not grade its own work/);
  assert.doesNotMatch(guideHtml,/If a reviewer asks/);
  assert.doesNotMatch(guideHtml,/PRIVATE SOURCE QUOTE/);

  const detail=await edgeHandler.fetch(new Request(`https://edge.test/invoices/${jobId}`,{headers:{authorization}}),env);
  assert.equal(detail.status,200);assert.equal(actorAccesses,2);
  const detailHtml=await detail.text();
  assert.match(detailHtml,/BK-2026-001/);assert.match(detailHtml,/Source document/);
  assert.match(detailHtml,new RegExp(`/invoices/${jobId}/document`));assert.match(detailHtml,/preview-frame/);
  assert.match(detailHtml,/<details class="technical-json card">/);
  assert.match(detailHtml,/View technical JSON/);assert.match(detailHtml,/Sanitized structured result/);
  assert.match(detailHtml,/arithmetic_consistent/);assert.doesNotMatch(detailHtml,/PRIVATE SOURCE QUOTE/);
  assert.doesNotMatch(detailHtml,/PRIVATE-HASH-SHOULD-NOT-APPEAR/);

  const preview=await edgeHandler.fetch(new Request(`https://edge.test/invoices/${jobId}/document`,{
    headers:{authorization},
  }),env);
  assert.equal(preview.status,200);assert.equal(actorAccesses,3);
  assert.equal(preview.headers.get('content-type'),'application/pdf');
  assert.match(preview.headers.get('content-disposition'),/^inline;/);
  assert.equal(preview.headers.get('cache-control'),'private, no-store');
  assert.equal(preview.headers.get('cross-origin-resource-policy'),'same-origin');
  assert.deepEqual(new Uint8Array(await preview.arrayBuffer()),documentBytes);

  const malformed=await edgeHandler.fetch(new Request('https://edge.test/invoices/not-an-id',{headers:{authorization}}),env);
  assert.equal(malformed.status,400);assert.equal(actorAccesses,3);

  const viewerCannotControl=await edgeHandler.fetch(new Request('https://edge.test/status',{headers:{authorization}}),env);
  assert.equal(viewerCannotControl.status,401);
});

test('E-007 Agent SDK and generated binding types are pinned and compile-time visible',()=>{
  const pkg=JSON.parse(readFileSync('package.json','utf8'));
  assert.equal(pkg.dependencies['@telnyx/edge-runtime'],'0.15.1');
  const generated=readFileSync('telnyx-env.d.ts','utf8');
  assert.match(generated,/ActorNamespace<BookkeepingAgentV2>/);
  assert.match(generated,/SECRETS: \{ get\(binding: "CONTROL_TOKEN" \| "INBOX_ID"/);
  assert.match(generated,/"API_KEY"/);
  assert.match(generated,/"PDF_RENDERER_URL"/);assert.match(generated,/"PDF_RENDERER_TOKEN"/);
  assert.ok(!generated.includes('"TARGET_SUBJECT"'));
});

test('E-008 scheduled Edge attempts disable task retries and direct AI calls retain the 180-second bound',()=>{
  const source=readFileSync('src/edge/bookkeeping-agent.ts','utf8');
  const transport=readFileSync('src/edge/telnyx-ai-http-client.ts','utf8');
  assert.match(source,/createDirectTelnyxAiClient\(apiKey\)/);
  assert.match(transport,/stage === 'model_list' \? 30_000 : 180_000/);
  assert.doesNotMatch(transport,/maxRetries/);
  assert.ok((source.match(/maxRetries: 0/g)??[]).length>=3);
  assert.match(source,/findTargetInboxMessageHttp/);
  assert.match(source,/listInboxMessagesHttp\(apiKey, config\.inboxId, null\)/);
});

test('E-009 any-subject intake accepts new single invoice documents in deterministic order',()=>{
  const pdf=index=>({url:`https://files.telnyx.test/${index}`,filename:`${index}.pdf`,
    content_type:'application/pdf',size_bytes:100,sha256:'a'.repeat(64)});
  const image={url:'https://files.telnyx.test/image',filename:'image.png',
    content_type:'image/png',size_bytes:100,sha256:'b'.repeat(64)};
  const make=(id,subject,receivedAt,attachments)=>({id,inboxId:validConfig.inboxId,subject,receivedAt,attachments});
  const eligible=eligibleInvoiceMessagesReceivedAfter([
    make('old','old subject','2026-09-09T09:59:59.000Z',[pdf('old')]),
    make('later','completely unrelated subject','2026-09-09T10:02:00.000Z',[pdf('later')]),
    make('image','image only','2026-09-09T10:01:00.000Z',[image]),
    make('multiple','two invoices','2026-09-09T10:01:00.000Z',[pdf('one'),pdf('two')]),
    make('first','vendor invoice 8472','2026-09-09T10:00:01.000Z',[pdf('first')]),
  ],'2026-09-09T10:00:00.000Z');
  assert.deepEqual(eligible.map(candidate=>candidate.message.id),['first','image','later']);
  assert.throws(()=>eligibleInvoiceMessagesReceivedAfter([],'not-a-date'),
    error=>error.code==='invalid_edge_accept_after');
});

test('E-010 re-arming a running actor preserves its intake cutoff',()=>{
  const existing='2026-09-09T14:46:00.000Z';
  const later='2026-09-09T15:06:00.000Z';
  assert.equal(intakeCutoffForStart(true,existing,later),existing);
  assert.equal(intakeCutoffForStart(false,existing,later),later);
  assert.equal(intakeCutoffForStart(true,undefined,later),later);
  assert.throws(()=>intakeCutoffForStart(false,undefined,'invalid'),
    error=>error.code==='invalid_edge_accept_after');
});

test('E-011 hosted batch configuration is strict and exact-manifest aware',()=>{
  const valid=validateEdgeBatchConfiguration({label:'Quarterly batch',expectedCount:2,expectedManifest:[
    {supplierName:'Vendor A',invoiceNumber:'INV-1'},
    {supplierName:'Vendor B',invoiceNumber:'INV-2'},
  ]});
  assert.deepEqual(valid,{label:'Quarterly batch',expectedCount:2,expectedManifest:[
    {supplierName:'Vendor A',invoiceNumber:'INV-1'},
    {supplierName:'Vendor B',invoiceNumber:'INV-2'},
  ]});
  for(const invalid of [
    {label:'',expectedCount:0,expectedManifest:null},
    {label:'x',expectedCount:-1,expectedManifest:null},
    {label:'x',expectedCount:1,expectedManifest:[],extra:true},
    {label:'x',expectedCount:2,expectedManifest:[{supplierName:'Vendor A',invoiceNumber:'INV-1'}]},
    {label:'x',expectedCount:2,expectedManifest:[
      {supplierName:'Vendor A',invoiceNumber:'INV-1'},
      {supplierName:'Vendor A',invoiceNumber:'INV-1'},
    ]},
  ]) assert.throws(()=>validateEdgeBatchConfiguration(invalid),error=>error.code==='invalid_edge_batch_configuration');
});

test('E-012 hosted completeness distinguishes exact identity, count-only, and unresolved receipts',()=>{
  const base={id:'batch-1',state:'active',label:'Quarterly batch',expectedCount:2,
    startedAt:'2026-09-09T10:00:00.000Z',closedAt:null,unsupportedReceipts:0};
  const jobs=[
    {canonicalId:'job-a',status:'complete',businessReference:JSON.stringify(['Vendor A','INV-1'])},
    {canonicalId:'job-b',status:'complete',businessReference:JSON.stringify(['Vendor B','INV-2'])},
  ];
  const exact=evaluateEdgeBatch({...base,expectedManifest:[
    {supplierName:'Vendor A',invoiceNumber:'INV-1'},
    {supplierName:'Vendor B',invoiceNumber:'INV-2'},
  ],jobs});
  assert.equal(exact.completeness.status,'manifest_match');
  assert.deepEqual(exact.jobs,{total:2,pending:0,processing:0,completed:2,failed:0,unresolved:0,unsupportedReceipts:0});

  const countOnly=evaluateEdgeBatch({...base,expectedManifest:null,jobs});
  assert.equal(countOnly.completeness.status,'count_match_only');
  const unsupported=evaluateEdgeBatch({...base,expectedManifest:null,jobs,unsupportedReceipts:1});
  assert.equal(unsupported.completeness.status,'needs_review');
  assert.deepEqual(unsupported.completeness.issues,['unresolved_documents']);
  const pending=evaluateEdgeBatch({...base,expectedManifest:null,jobs:[jobs[0],
    {canonicalId:'job-b',status:'pending',businessReference:null}]});
  assert.equal(pending.completeness.status,'needs_review');assert.equal(pending.jobs.unresolved,1);
});

test('E-013 hosted operator controls require bearer auth and accept only bounded JSON',async()=>{
  let configured=null;let cleared=0;let hidden=0;let closed=0;let polled=0;let actorAccessed=0;
  const response={id:'batch-1',state:'active'};
  const env={SECRETS:secretReader(),INVOICE_AGENT:{idFromName(){actorAccessed++;return {
    configureBatch:async input=>{configured=input;return response;},
    closeBatch:async()=>{closed++;return response;},
    clearPriorHistory:async()=>{cleared++;return {ok:true,status:{running:true,phase:'waiting'}};},
    hideFailedJob:async id=>{hidden++;assert.equal(id,'b'.repeat(64));return {ok:true,status:{running:true,phase:'ready'}};},
    pollNow:async()=>{polled++;return {ok:true,status:{running:true,phase:'waiting'}};},
  };}}};
  const viewerToken=await deriveEdgeViewerToken('c'.repeat(32));
  const viewer=`Basic ${Buffer.from(`review:${viewerToken}`).toString('base64')}`;
  const denied=await edgeHandler.fetch(new Request('https://edge.test/control/batch',{method:'POST',
    headers:{authorization:viewer,'content-type':'application/json'},body:'{}'}),env);
  assert.equal(denied.status,401);assert.equal(actorAccessed,0);

  const bearer={authorization:`Bearer ${'c'.repeat(32)}`,'content-type':'application/json'};
  const body={label:'Quarterly batch',expectedCount:2,expectedManifest:null};
  const allowed=await edgeHandler.fetch(new Request('https://edge.test/control/batch',{method:'POST',
    headers:bearer,body:JSON.stringify(body)}),env);
  assert.equal(allowed.status,200);assert.deepEqual(configured,body);assert.deepEqual(await allowed.json(),response);

  const wrongType=await edgeHandler.fetch(new Request('https://edge.test/control/batch',{method:'POST',
    headers:{authorization:`Bearer ${'c'.repeat(32)}`},body:'{}'}),env);
  assert.equal(wrongType.status,415);
  const oversized=await edgeHandler.fetch(new Request('https://edge.test/control/batch',{method:'POST',
    headers:{...bearer,'content-length':'120001'},body:'{}'}),env);
  assert.equal(oversized.status,413);
  const close=await edgeHandler.fetch(new Request('https://edge.test/control/batch/close',{method:'POST',
    headers:{authorization:`Bearer ${'c'.repeat(32)}`}}),env);
  assert.equal(close.status,200);assert.equal(closed,1);
  const clear=await edgeHandler.fetch(new Request('https://edge.test/control/history/clear',{
    method:'POST',headers:{authorization:`Bearer ${'c'.repeat(32)}`}}),env);
  assert.equal(clear.status,200);assert.equal(cleared,1);
  const hide=await edgeHandler.fetch(new Request(`https://edge.test/control/jobs/${'b'.repeat(64)}/hide`,{
    method:'POST',headers:{authorization:`Bearer ${'c'.repeat(32)}`}}),env);
  assert.equal(hide.status,200);assert.equal(hidden,1);
  assert.deepEqual(await hide.json(),{running:true,phase:'ready'});
  const poll=await edgeHandler.fetch(new Request('https://edge.test/control/poll',{method:'POST',headers:{
    authorization:`Bearer ${'c'.repeat(32)}`}}),env);
  assert.equal(poll.status,200);assert.equal(polled,1);
  assert.deepEqual(await poll.json(),{running:true,phase:'waiting'});

  env.INVOICE_AGENT.idFromName=()=>({pollNow:async()=>({ok:false,errorCode:'edge_manual_poll_cycle_failed'})});
  const failedPoll=await edgeHandler.fetch(new Request('https://edge.test/control/poll',{method:'POST',headers:{
    authorization:`Bearer ${'c'.repeat(32)}`}}),env);
  assert.equal(failedPoll.status,503);
  assert.deepEqual(await failedPoll.json(),{error:'edge_manual_poll_cycle_failed'});
});

test('E-014 manual polling bypasses the actor alarm queue while scheduled polling retains it',()=>{
  const source=readFileSync('src/edge/bookkeeping-agent.ts','utf8');
  assert.match(source,/pollNow\(\)[\s\S]*?await this\._pollCycle\(false\)/);
  assert.match(source,/async _poll\(\)[\s\S]*?await this\._pollCycle\(true\)/);
  assert.match(source,/if \(queueProcessing\) \{\s*await this\.queue\('_process'/);
});

test('E-015 status returns an independent active-batch object for actor serialization',()=>{
  const source=readFileSync('src/edge/bookkeeping-agent.ts','utf8');
  assert.match(source,/batch: batches\.length === 0 \? null : this\.batchOverview\(batches\[0\]!\.id\)/);
  assert.ok(!source.includes('batch: batches[0] ?? null'));
});

test('E-016 targeted failed-job hiding preserves deduplication and removes only operator-visible counts',()=>{
  const source=readFileSync('src/edge/bookkeeping-agent.ts','utf8');
  assert.match(source,/if \(row\.status !== 'failed'\) return \{ ok: false, errorCode: 'edge_job_not_failed' \}/);
  assert.match(source,/UPDATE invoice_jobs SET hidden = 1/);
  assert.match(source,/FROM invoice_jobs WHERE hidden = 0 ORDER BY created_at DESC/);
  assert.match(source,/FROM invoice_jobs WHERE hidden = 0 GROUP BY status/);
  assert.match(source,/WHERE batch_id = \? AND hidden = 0 ORDER BY created_at/);
  assert.match(source,/SELECT status FROM invoice_jobs WHERE job_id = \?/);
});

test('E-017 invoice preview re-fetches only completed visible jobs through existing attachment controls',()=>{
  const actor=readFileSync('src/edge/bookkeeping-agent.ts','utf8');
  const edge=readFileSync('src/edge/index.ts','utf8');
  assert.match(actor,/async invoiceDocument\(jobId: string\)/);
  assert.match(actor,/WHERE job_id = \? AND hidden = 0 AND status = 'complete'/);
  assert.match(actor,/findTargetInboxMessageHttp\(apiKey, config\.inboxId, null, row\.message_id\)/);
  assert.match(actor,/downloadAttachment\(attachment, \{\s*allowedHosts: new Set\(config\.attachmentHosts\)/);
  assert.match(edge,/cross-origin-resource-policy': 'same-origin'/);
  assert.match(edge,/cache-control': 'private, no-store'/);
  assert.match(edge,/frame-src 'self'/);
});
