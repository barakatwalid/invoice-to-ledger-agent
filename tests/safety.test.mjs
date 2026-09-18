import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

test('S-001 baseline test command invokes no provider probe',()=>{const p=JSON.parse(readFileSync('package.json','utf8'));assert.ok(!p.scripts.test.includes('probe'));assert.equal(p.scripts.postinstall,undefined);});
test('S-002 optional live probe blocks without credentials before network access',()=>{
 const env={...process.env};delete env.TELNYX_API_KEY;delete env.TELNYX_INBOX_ID;
 const r=spawnSync(process.execPath,['scripts/probe-telnyx.mjs'],{env,encoding:'utf8',timeout:5000});
 assert.equal(r.status,2);assert.match(r.stderr,/BLOCKED/);
});
test('S-003 doctor does not print secret values',()=>{
 const sentinel='TEST-SECRET-DO-NOT-PRINT';
 const r=spawnSync(process.execPath,['scripts/doctor.mjs'],{env:{...process.env,TELNYX_API_KEY:sentinel,TELNYX_INBOX_ID:'test-inbox'},encoding:'utf8',timeout:5000});
 assert.ok(!`${r.stdout}${r.stderr}`.includes(sentinel));const output=JSON.parse(r.stdout);
 assert.equal(output.configurationPresenceOnly.TELNYX_API_KEY,true);assert.equal(typeof output.visualPdfRendererAvailable,'boolean');
});
test('S-014 local agent provider defaults are exact reviewed public selectors',()=>{
 const config=JSON.parse(readFileSync('config/local-agent-provider.json','utf8'));
 assert.deepEqual(config,{schemaVersion:'local_agent_provider_v1',modelId:'zai-org/GLM-5.3-Flash',
  reasoningEffort:'high',attachmentHosts:['us-central-1.telnyxcloudstorage.com'],
  verifiedAt:'2026-09-08',
  note:'Public selectors observed in the live Telnyx account and attachment metadata; the model list is rechecked before every completion.'});
 const runner=readFileSync('scripts/run-local-agent.mjs','utf8');
 assert.match(runner,/config\/local-agent-provider\.json/);
 assert.match(runner,/process\.env\.EXTRACTION_MODEL_ID\?\.trim\(\)\|\|providerConfig\.modelId/);
});
test('S-004 original 100-case catalogue remains a plan, not fabricated passing results',()=>{
 const d=JSON.parse(readFileSync('docs/original-100-scenarios.json','utf8'));
 assert.equal(d.case_count,100);assert.equal(d.cases.length,100);assert.ok(d.cases.every(c=>c.status==='NOT_IMPLEMENTED_NOT_RUN'));
});
test('S-005 fixture is explicitly synthetic structured data',()=>{
 const d=JSON.parse(readFileSync('fixtures/simple-pre-extracted.json','utf8'));
  assert.match(d.id,/SYNTHETIC/);
});
test('S-006 attachment-host discovery blocks before network without local configuration',()=>{
 const env={...process.env};
 for(const name of ['TELNYX_API_KEY','TELNYX_INBOX_ID','TELNYX_TARGET_SUBJECT'])delete env[name];
 const r=spawnSync(process.execPath,['--experimental-strip-types','scripts/discover-attachment-host.mjs'],{env,encoding:'utf8',timeout:5000});
  assert.equal(r.status,2);assert.match(r.stderr,/BLOCKED/);assert.equal(r.stdout,'');
});
test('S-007 full live slice disables SDK retries and keeps the bounded timeout explicit',()=>{
  const source=readFileSync('scripts/run-live-slice.mjs','utf8');
  assert.match(source,/timeout:180_000/);
  assert.match(source,/maxRetries:0/);
  assert.ok(!source.includes('maxRetries:2'));
});
test('S-008 attachment-only evidence command cannot invoke inference and disables SDK retries',()=>{
  const source=readFileSync('scripts/retrieve-live-attachment.mjs','utf8');
  assert.match(source,/maxRetries:0/);
  assert.ok(!source.includes('extractWithTelnyxModel'));
  assert.ok(!source.includes('createCompletion'));
  assert.match(source,/No model request ran/);
});
test('S-009 Edge secret writer blocks before touching the CLI without an explicit one-run guard',()=>{
  const env={...process.env,
    TELNYX_INBOX_ID:'550e8400-e29b-41d4-a716-446655440000',
    TELNYX_TARGET_SUBJECT:'Synthetic invoice',EXTRACTION_MODEL_ID:'provider/model',
    TELNYX_ATTACHMENT_HOSTS:'files.telnyx.test'};
  delete env.ALLOW_TELNYX_EDGE_SECRET_WRITES;
  const r=spawnSync(process.execPath,['--experimental-strip-types','scripts/configure-edge-secrets.mjs'],
    {env,encoding:'utf8',timeout:5000});
  assert.equal(r.status,2);assert.equal(r.stdout,'');
  assert.match(r.stderr,/BLOCKED: set ALLOW_TELNYX_EDGE_SECRET_WRITES=YES/);
});
test('S-010 deployed Edge acceptance blocks before network without an explicit one-run guard',()=>{
  const env={...process.env,EDGE_INVOKE_URL:'https://invoice-to-ledger-agent.example.telnyxcompute.com'};
  delete env.ALLOW_TELNYX_EDGE_LIVE_ACCEPTANCE;
  const r=spawnSync(process.execPath,['scripts/run-edge-acceptance.mjs'],{env,encoding:'utf8',timeout:5000});
  assert.equal(r.status,2);assert.equal(r.stdout,'');
  assert.match(r.stderr,/BLOCKED: set ALLOW_TELNYX_EDGE_LIVE_ACCEPTANCE=YES/);
});
test('S-010b API-key secret writer blocks before touching the CLI without explicit approval',()=>{
  const env={...process.env,TELNYX_API_KEY:'TEST-TELNYX-API-KEY'};
  delete env.ALLOW_TELNYX_EDGE_API_KEY_SECRET_WRITE;
  const r=spawnSync(process.execPath,['scripts/configure-edge-api-key-secret.mjs'],
    {env,encoding:'utf8',timeout:5000});
  assert.equal(r.status,2);assert.equal(r.stdout,'');
  assert.match(r.stderr,/BLOCKED: set ALLOW_TELNYX_EDGE_API_KEY_SECRET_WRITE=YES/);
});
test('S-010c viewer password is derived locally without Telnyx secret writes or secret output',()=>{
  const source=readFileSync('scripts/configure-edge-viewer-password.mjs','utf8');
  assert.ok(!source.includes('telnyx-edge'));
  assert.match(source,/valuesPrinted:false,remoteSecretWrites:0/);
  assert.ok(!source.includes('console.log(viewerToken)'));
});
test('S-011 deployed Edge acceptance reports a privacy-safe inbox-poll error without waiting for timeout',()=>{
  const source=readFileSync('scripts/run-edge-acceptance.mjs','utf8');
  assert.match(source,/typeof status\?\.lastError==='string'/);
  assert.match(source,/\^\[a-z0-9_\]\+\$/);
  assert.match(source,/edge_poll_failed_/);
});
test('S-012 local acceptance reads its token privately and permits loopback targets only',()=>{
  const source=readFileSync('scripts/check-local-agent.mjs','utf8');
  assert.match(source,/\['127\.0\.0\.1','localhost','::1'\]/);
  assert.match(source,/secretsPrinted:false/);
  assert.ok(!source.includes('console.log(token)'));
  assert.ok(!source.includes('console.log(authorization)'));
  assert.match(source,/Quarterly completeness batch/);
});
test('S-013 inbox preview cannot download attachments or invoke a model',()=>{
  const source=readFileSync('scripts/preview-local-inbox.mjs','utf8');
  assert.match(source,/selectSingleInvoiceAttachment/);
  assert.ok(!source.includes('selectSinglePdfAttachment'));
  assert.match(source,/multiple_invoice_attachments/);
  assert.match(source,/newestMessageClassification/);
  assert.ok(!source.includes('newest.subject'));
  assert.ok(!source.includes('newest.id'));
  assert.ok(!source.includes('attachment.url'));
  assert.ok(!source.includes('downloadAttachment'));
  assert.ok(!source.includes('extractWithTelnyxModel'));
  assert.ok(!source.includes('createCompletion'));
  assert.match(source,/attachmentsDownloaded:0,modelCalls:0,secretsPrinted:false/);
});
test('S-015 exact-subject check is read-only and does not expose message metadata',()=>{
  const source=readFileSync('scripts/check-inbox-subject.mjs','utf8');
  assert.match(source,/listInboxMessages/);
  assert.ok(!source.includes('downloadAttachment'));
  assert.ok(!source.includes('createCompletion'));
  assert.ok(!source.includes('message.id'));
  assert.ok(!source.includes('message.attachments'));
  assert.match(source,/trimmedCaseInsensitiveMatches/);
  assert.match(source,/containsSubjectMatches/);
  assert.match(source,/secretsPrinted:false/);
});
test('S-016 local batch mutations require bounded forms and a CSRF token',()=>{
  const source=readFileSync('src/local-agent.ts','utf8');
  assert.match(source,/createHmac\('sha256', controlToken\)/);
  assert.match(source,/form_too_large/);
  assert.match(source,/csrf_rejected/);
  assert.match(source,/\/control\/batch\/close/);
  assert.match(source,/Without a manifest, a matching total is labelled count-only/);
});
test('S-017 manual hosted poll blocks before network without explicit approval',()=>{
  const env={...process.env,EDGE_INVOKE_URL:'https://invoice-to-ledger-agent.example.telnyxcompute.com'};
  delete env.ALLOW_TELNYX_EDGE_MANUAL_POLL;
  const r=spawnSync(process.execPath,['scripts/poll-edge-now.mjs'],{env,encoding:'utf8',timeout:5000});
  assert.equal(r.status,2);assert.equal(r.stdout,'');
  assert.match(r.stderr,/BLOCKED: set ALLOW_TELNYX_EDGE_MANUAL_POLL=YES/);
});
test('S-018 hosted history deletion blocks before network without explicit approval',()=>{
  const env={...process.env,EDGE_INVOKE_URL:'https://invoice-to-ledger-agent.example.telnyxcompute.com'};
  delete env.ALLOW_TELNYX_EDGE_HISTORY_CLEAR;
  const r=spawnSync(process.execPath,['scripts/clear-edge-history.mjs'],
    {env,encoding:'utf8',timeout:5000});
  assert.equal(r.status,2);assert.equal(r.stdout,'');
  assert.match(r.stderr,/BLOCKED: set ALLOW_TELNYX_EDGE_HISTORY_CLEAR=YES/);
});
test('S-019 renderer secret writer blocks before generating or writing secrets without explicit approval',()=>{
  const env={...process.env,
    BOOKKEEPING_PDF_RENDERER_URL:'https://bookkeeping-pdf-renderer.example.telnyxcompute.com'};
  delete env.ALLOW_BOOKKEEPING_PDF_RENDERER_SECRET_WRITES;
  const r=spawnSync(process.execPath,['--experimental-strip-types','scripts/configure-pdf-renderer-secrets.mjs'],
    {env,encoding:'utf8',timeout:5000});
  assert.equal(r.status,2);assert.equal(r.stdout,'');
  assert.match(r.stderr,/BLOCKED: set ALLOW_BOOKKEEPING_PDF_RENDERER_SECRET_WRITES=YES/);
});
test('S-020 hosted renderer check blocks before reading its token or making network requests',()=>{
  const env={...process.env,
    BOOKKEEPING_PDF_RENDERER_URL:'https://bookkeeping-pdf-renderer.example.telnyxcompute.com'};
  delete env.ALLOW_BOOKKEEPING_PDF_RENDERER_TEST;
  const r=spawnSync(process.execPath,['--experimental-strip-types','scripts/check-edge-pdf-renderer.mjs'],
    {env,encoding:'utf8',timeout:5000});
  assert.equal(r.status,2);assert.equal(r.stdout,'');
  assert.match(r.stderr,/BLOCKED: set ALLOW_BOOKKEEPING_PDF_RENDERER_TEST=YES/);
});
test('S-021 hosted failed-job hide blocks before network without explicit approval',()=>{
  const env={...process.env,EDGE_INVOKE_URL:'https://invoice-to-ledger-agent.example.telnyxcompute.com'};
  delete env.ALLOW_TELNYX_EDGE_FAILED_JOB_HIDE;
  const r=spawnSync(process.execPath,['scripts/hide-edge-failed-job.mjs'],
    {env,encoding:'utf8',timeout:5000});
  assert.equal(r.status,2);assert.equal(r.stdout,'');
  assert.match(r.stderr,/BLOCKED: set ALLOW_TELNYX_EDGE_FAILED_JOB_HIDE=YES/);
});
