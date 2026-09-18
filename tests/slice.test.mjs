import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('V-001 local vertical slice produces a private inspectable result without live claims',()=>{
  const run=spawnSync(process.execPath,['--experimental-strip-types','scripts/run-local-slice.mjs'],{encoding:'utf8',timeout:30000});
  assert.equal(run.status,0,run.stderr);
  const output=JSON.parse(run.stdout);
  assert.equal(output.status,'PASS');assert.equal(output.mode,'LOCAL_FIXTURE_NOT_LIVE');
  assert.match(output.note,/no Telnyx email or live AI request ran/i);
  assert.match(output.result.jsonPath,/\.private\/results\/[a-f0-9]{64}\.json$/);
  assert.match(output.result.htmlPath,/\.private\/results\/[a-f0-9]{64}\.html$/);
});

test('V-002 live slice blocks before network when credentials and selectors are absent',()=>{
  const env={...process.env};
  for(const name of ['TELNYX_API_KEY','TELNYX_INBOX_ID','EXTRACTION_MODEL_ID','TELNYX_TARGET_SUBJECT','TELNYX_ATTACHMENT_HOSTS'])delete env[name];
  const run=spawnSync(process.execPath,['--experimental-strip-types','scripts/run-live-slice.mjs'],{env,encoding:'utf8',timeout:5000});
  assert.equal(run.status,2);assert.match(run.stderr,/BLOCKED/);assert.equal(run.stdout,'');
});

test('V-003 live-model slice blocks before network without key and trusted model selection',()=>{
  const env={...process.env};delete env.TELNYX_API_KEY;delete env.EXTRACTION_MODEL_ID;
  const run=spawnSync(process.execPath,['--experimental-strip-types','scripts/run-live-model-slice.mjs'],
    {env,encoding:'utf8',timeout:5000});
  assert.equal(run.status,2);assert.match(run.stderr,/BLOCKED/);assert.equal(run.stdout,'');
});
