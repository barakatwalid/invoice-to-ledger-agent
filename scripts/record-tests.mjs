import {spawnSync} from 'node:child_process';
import {readdirSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const files=readdirSync('tests').filter(f=>f.endsWith('.test.mjs')).sort().map(f=>`tests/${f}`);
const result=spawnSync(process.execPath,['--experimental-strip-types','--test','--test-reporter=tap',...files],{encoding:'utf8',maxBuffer:10*1024*1024});
mkdirSync('evidence',{recursive:true});
const output=(result.stdout||'')+(result.stderr||'');
writeFileSync('evidence/local-tests.tap',output);
const metric=name=>Number(output.match(new RegExp(`^# ${name} (\\d+)$`,'m'))?.[1]??0);
const scripts=readdirSync('scripts').filter(f=>f.endsWith('.mjs')||f.endsWith('.py')).sort().map(f=>`scripts/${f}`);
const walk=(directory,predicate)=>readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
  const path=`${directory}/${entry.name}`;
  return entry.isDirectory()?walk(path,predicate):predicate(path)?[path]:[];
});
const hashFiles=['package.json','package-lock.json','tsconfig.json','telnyx.toml','telnyx-env.d.ts',
  ...walk('src',f=>f.endsWith('.ts')),...files,
  'config/demo-policy.json','config/local-agent-provider.json',
  'fixtures/simple-pre-extracted.json','fixtures/arithmetic-oracle.json',
  'fixtures/synthetic-invoice-answer-key.json','fixtures/synthetic-recorded-model-response.json',
  'output/pdf/synthetic-bookkeeping-invoice.pdf',...scripts].sort();
const summary={recordedAt:new Date().toISOString(),environment:'local/offline',node:process.versions.node,exitCode:result.status,
  tests:metric('tests'),pass:metric('pass'),fail:metric('fail'),skipped:metric('skipped'),
  randomizedArithmeticCasesCompleted:Number(output.match(/generated_arithmetic_cases_completed=(\d+)/)?.[1]??0),randomizedSeed:'0x5EED1234',
  integrationTestsRun:0,liveTestsRun:0,sourceHashes:Object.fromEntries(hashFiles.map(f=>[f,createHash('sha256').update(readFileSync(f)).digest('hex')]))};
writeFileSync('evidence/local-summary.json',JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({...summary,sourceHashes:'See evidence/local-summary.json'},null,2));
if (result.status !== 0) {
  console.error(output);
}
process.exitCode=result.status??1;
