import {readFileSync} from 'node:fs';
import {validateEdgeBatchConfiguration} from '../src/edge/bookkeeping-agent.ts';

const fail=code=>{throw new Error(code);};
const request=async(url,init)=>fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(20_000)});

try{
  if(process.env.ALLOW_TELNYX_EDGE_BATCH_WRITE!=='YES'){
    fail('edge_batch_write_not_approved');
  }
  const configuredUrl=process.env.EDGE_INVOKE_URL?.trim();
  if(!configuredUrl)fail('missing_edge_invoke_url');
  const baseUrl=new URL(configuredUrl);
  if(baseUrl.protocol!=='https:'||baseUrl.username||baseUrl.password||baseUrl.port||
      baseUrl.pathname!=='/'||baseUrl.search||baseUrl.hash||
      !/^[a-z0-9-]+\.telnyxcompute\.com$/.test(baseUrl.hostname))fail('invalid_edge_invoke_url');
  const controlToken=readFileSync('.private/edge-control-token','utf8').trim();
  if(controlToken.length<32||controlToken.length>512)fail('invalid_local_edge_control_token');
  const action=process.env.EDGE_BATCH_ACTION?.trim()||'configure';
  if(action!=='configure'&&action!=='close')fail('invalid_edge_batch_action');

  let path='/control/batch/close';
  let body;
  if(action==='configure'){
    const countText=process.env.EDGE_BATCH_EXPECTED_COUNT?.trim();
    if(!countText||!/^(0|[1-9][0-9]{0,4})$/.test(countText))fail('invalid_edge_batch_expected_count');
    const manifestPath=process.env.EDGE_BATCH_MANIFEST_PATH?.trim();
    let expectedManifest=null;
    if(manifestPath){
      try{expectedManifest=JSON.parse(readFileSync(manifestPath,'utf8'));}
      catch{fail('invalid_edge_batch_manifest_file');}
    }
    body=JSON.stringify(validateEdgeBatchConfiguration({
      label:process.env.EDGE_BATCH_LABEL?.trim()||'',
      expectedCount:Number(countText),
      expectedManifest,
    }));
    path='/control/batch';
  }
  const response=await request(new URL(path,baseUrl),{
    method:'POST',
    headers:{authorization:`Bearer ${controlToken}`,...(body?{'content-type':'application/json'}:{})},
    body,
  });
  let result;
  try{result=await response.json();}catch{fail('edge_invalid_json_response');}
  if(!response.ok)fail(typeof result?.error==='string'&&/^[a-z0-9_]+$/.test(result.error)?result.error:'edge_batch_control_failed');
  console.log(JSON.stringify({
    status:'PASS',action,batchState:result?.state??'none',label:result?.label??null,
    received:result?.completeness?.uniqueReceived??null,expected:result?.expectedCount??null,
    completeness:result?.completeness?.status??null,valuesPrinted:false,
  },null,2));
}catch(error){
  const message=error instanceof Error?error.message:'';
  const code=/^[a-z0-9_]+$/.test(message)?message:'unexpected_edge_batch_control_error';
  console.error(`FAIL: ${code}`);
  process.exitCode=1;
}
