import {spawnSync} from 'node:child_process';

const approval='ALLOW_TELNYX_EDGE_API_KEY_SECRET_WRITE';
if(process.env[approval]!=='YES'){
  console.error(`BLOCKED: set ${approval}=YES only for an explicitly approved API-key secret write`);
  process.exit(2);
}

const apiKey=process.env.TELNYX_API_KEY?.trim();
if(!apiKey||apiKey.length<16||apiKey.length>512||/\s/.test(apiKey)){
  console.error('FAIL: invalid_telnyx_api_key');
  process.exit(1);
}

const name='BOOKKEEPING_TELNYX_API_KEY';
const cli='.tools/telnyx-edge-v0.5.1-macos-arm64/telnyx-edge';
const result=spawnSync(cli,['secrets','add',name,apiKey],{
  env:{...process.env,TELNYX_NO_UPDATE_CHECK:'1'},encoding:'utf8',timeout:30_000,
});
if(result.status!==0){
  console.error('FAIL: edge_api_key_secret_write_failed');
  process.exit(1);
}
console.log(JSON.stringify({status:'PASS',secretName:name,completedWrites:1,valuesPrinted:false},null,2));
