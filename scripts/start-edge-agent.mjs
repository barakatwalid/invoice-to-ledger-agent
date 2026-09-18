import {readFileSync} from 'node:fs';

const fail=code=>{throw new Error(code);};

try{
  if(process.env.ALLOW_TELNYX_EDGE_START!=='YES')fail('edge_start_not_approved');
  const configuredUrl=process.env.EDGE_INVOKE_URL?.trim();
  if(!configuredUrl)fail('missing_edge_invoke_url');
  const baseUrl=new URL(configuredUrl);
  if(baseUrl.protocol!=='https:'||baseUrl.username||baseUrl.password||baseUrl.port||
      baseUrl.pathname!=='/'||baseUrl.search||baseUrl.hash||
      !/^[a-z0-9-]+\.telnyxcompute\.com$/.test(baseUrl.hostname))fail('invalid_edge_invoke_url');
  const controlToken=readFileSync('.private/edge-control-token','utf8').trim();
  if(controlToken.length<32||controlToken.length>512)fail('invalid_local_edge_control_token');
  const response=await fetch(new URL('/control/start',baseUrl),{
    method:'POST',headers:{authorization:`Bearer ${controlToken}`},redirect:'error',
    signal:AbortSignal.timeout(30_000),
  });
  let result;
  try{result=await response.json();}catch{fail('edge_invalid_json_response');}
  if(!response.ok||result?.running!==true){
    fail(typeof result?.error==='string'&&/^[a-z0-9_]+$/.test(result.error)?result.error:'edge_start_failed');
  }
  console.log(JSON.stringify({
    status:'PASS',running:true,phase:result?.phase??null,lastError:result?.lastError??null,
    jobs:result?.jobs??null,batch:result?.batch===null?null:{state:result?.batch?.state??null,
      expectedCount:result?.batch?.expectedCount??null},secretsPrinted:false,
  },null,2));
}catch(error){
  const message=error instanceof Error?error.message:'';
  const code=/^[a-z0-9_]+$/.test(message)?message:'unexpected_edge_start_error';
  console.error(`FAIL: ${code}`);
  process.exitCode=1;
}
