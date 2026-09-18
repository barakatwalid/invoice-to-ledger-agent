import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSyntheticModelDiagnostic } from '../src/model-diagnostic.ts';

test('O-002 synthetic invalid model output is private and explicitly labelled',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'model-diagnostic-'));
  try{
    const path=await writeSyntheticModelDiagnostic(directory,'a'.repeat(64),{
      content:'synthetic response only',finishReason:'stop',responseModelId:'test/model',
    });
    assert.equal(statSync(path).mode&0o777,0o600);
    const saved=JSON.parse(readFileSync(path,'utf8'));
    assert.equal(saved.syntheticLocalPdfOnly,true);
    assert.match(saved.warning,/never enable/);
    assert.equal(saved.content,'synthetic response only');
    assert.match(saved.contentSha256,/^[a-f0-9]{64}$/);
    assert.match(path,/\.[a-f0-9]{16}\.invalid-model-output\.json$/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
