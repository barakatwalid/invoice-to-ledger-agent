import {randomBytes} from 'node:crypto';
import {chmodSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {validateEdgePdfRendererConfig} from '../src/edge/pdf-renderer-client.ts';

const approval='ALLOW_BOOKKEEPING_PDF_RENDERER_SECRET_WRITES';
if(process.env[approval]!=='YES'){
  console.error(`BLOCKED: set ${approval}=YES only for explicitly approved renderer secret writes`);
  process.exit(2);
}

try{
  const privateDirectory='.private';
  const tokenPath=`${privateDirectory}/pdf-renderer-token`;
  mkdirSync(privateDirectory,{recursive:true,mode:0o700});
  let token;
  try{
    token=readFileSync(tokenPath,'utf8').trim();
  }catch(error){
    if(error?.code!=='ENOENT')throw error;
    token=randomBytes(48).toString('base64url');
    writeFileSync(tokenPath,`${token}\n`,{encoding:'utf8',mode:0o600,flag:'wx'});
  }
  chmodSync(tokenPath,0o600);
  const baseUrl=process.env.BOOKKEEPING_PDF_RENDERER_URL?.trim()??'';
  const config=validateEdgePdfRendererConfig({baseUrl,token});
  const writes=[
    ['BOOKKEEPING_PDF_RENDERER_TOKEN',config.token],
    ['BOOKKEEPING_PDF_RENDERER_URL',config.baseUrl],
  ];
  const cli='.tools/telnyx-edge-v0.5.1-macos-arm64/telnyx-edge';
  let completed=0;
  for(const [name,value] of writes){
    const result=spawnSync(cli,['secrets','add',name,value],{
      env:{...process.env,TELNYX_NO_UPDATE_CHECK:'1'},encoding:'utf8',timeout:30_000,
    });
    if(result.status!==0)throw new Error(`edge_secret_write_failed_${name.toLowerCase()}`);
    completed++;
  }
  const receipt={
    schemaVersion:'pdf_renderer_secret_configuration_receipt_v1',
    configuredAt:new Date().toISOString(),
    secretNames:writes.map(([name])=>name),
    completedWrites:completed,
    valuesPrinted:false,
    tokenPath,
  };
  writeFileSync(`${privateDirectory}/pdf-renderer-secrets.json`,`${JSON.stringify(receipt,null,2)}\n`,{mode:0o600});
  console.log(JSON.stringify({status:'PASS',...receipt},null,2));
}catch(error){
  const code=error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)?
    error.message:'unexpected_pdf_renderer_secret_configuration_error';
  console.error(`FAIL: ${code}`);
  process.exitCode=1;
}
