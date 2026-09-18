import {randomBytes} from 'node:crypto';
import {chmodSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {validateEdgeAgentConfig} from '../src/edge/config.ts';

const approval='ALLOW_TELNYX_EDGE_SECRET_WRITES';
if(process.env[approval]!=='YES'){
  console.error(`BLOCKED: set ${approval}=YES only for an explicitly approved five-secret write`);
  process.exit(2);
}

const required=name=>{
  const value=process.env[name]?.trim();
  if(!value)throw new Error(`missing_${name.toLowerCase()}`);
  return value;
};

try{
  const config=validateEdgeAgentConfig({
    inboxId:required('TELNYX_INBOX_ID'),
    modelId:required('EXTRACTION_MODEL_ID'),
    attachmentHosts:required('TELNYX_ATTACHMENT_HOSTS').split(',').map(value=>value.trim()).filter(Boolean),
    pollIntervalSeconds:60,
  });
  const privateDirectory='.private';
  const tokenPath=`${privateDirectory}/edge-control-token`;
  mkdirSync(privateDirectory,{recursive:true,mode:0o700});
  let controlToken;
  try{
    controlToken=readFileSync(tokenPath,'utf8').trim();
  }catch(error){
    if(error?.code!=='ENOENT')throw error;
    controlToken=randomBytes(48).toString('base64url');
    writeFileSync(tokenPath,`${controlToken}\n`,{encoding:'utf8',mode:0o600,flag:'wx'});
  }
  chmodSync(tokenPath,0o600);
  if(controlToken.length<32||controlToken.length>512)throw new Error('invalid_local_edge_control_token');
  const writes=[
    ['BOOKKEEPING_EDGE_CONTROL_TOKEN',controlToken],
    ['BOOKKEEPING_TELNYX_INBOX_ID',config.inboxId],
    ['BOOKKEEPING_EXTRACTION_MODEL_ID',config.modelId],
    ['BOOKKEEPING_ATTACHMENT_HOSTS',config.attachmentHosts.join(',')],
    ['BOOKKEEPING_TELNYX_API_KEY',required('TELNYX_API_KEY')],
  ];
  const cli='.tools/telnyx-edge-v0.5.1-macos-arm64/telnyx-edge';
  let completed=0;
  for(const [name,value] of writes){
    const result=spawnSync(cli,['secrets','add',name,value],{
      env:{...process.env,TELNYX_NO_UPDATE_CHECK:'1'},
      encoding:'utf8',
      timeout:30_000,
    });
    if(result.status!==0)throw new Error(`edge_secret_write_failed_${name.toLowerCase()}`);
    completed++;
  }
  const receipt={
    schemaVersion:'edge_secret_configuration_receipt_v1',
    configuredAt:new Date().toISOString(),
    secretNames:writes.map(([name])=>name),
    completedWrites:completed,
    valuesPrinted:false,
    controlTokenPath:tokenPath,
  };
  writeFileSync(`${privateDirectory}/edge-secrets.json`,`${JSON.stringify(receipt,null,2)}\n`,{mode:0o600});
  console.log(JSON.stringify({status:'PASS',...receipt},null,2));
}catch(error){
  const code=error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)?error.message:'unexpected_edge_secret_configuration_error';
  console.error(`FAIL: ${code}`);
  process.exitCode=1;
}
