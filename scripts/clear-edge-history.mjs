import {readFileSync} from 'node:fs';

const fail=code=>{throw new Error(code);};

try{
  if(process.env.ALLOW_TELNYX_EDGE_HISTORY_CLEAR!=='YES'){
    console.error('BLOCKED: set ALLOW_TELNYX_EDGE_HISTORY_CLEAR=YES only for an explicitly approved history deletion');
    process.exit(2);
  }
  const configuredUrl=process.env.EDGE_INVOKE_URL?.trim();
  if(!configuredUrl)fail('missing_edge_invoke_url');
  const baseUrl=new URL(configuredUrl);
  if(baseUrl.protocol!=='https:'||baseUrl.username||baseUrl.password||baseUrl.port||
      baseUrl.pathname!=='/'||baseUrl.search||baseUrl.hash||
      !/^[a-z0-9-]+\.telnyxcompute\.com$/.test(baseUrl.hostname))fail('invalid_edge_invoke_url');
  const controlToken=readFileSync('.private/edge-control-token','utf8').trim();
  if(controlToken.length<32||controlToken.length>512)fail('invalid_local_edge_control_token');
  const response=await fetch(new URL('/control/history/clear',baseUrl),{
    method:'POST',headers:{authorization:`Bearer ${controlToken}`},redirect:'error',
    signal:AbortSignal.timeout(30_000),
  });
  let status;
  try{status=await response.json();}catch{fail('edge_invalid_json_response');}
  if(!response.ok){
    fail(typeof status?.error==='string'&&/^[a-z0-9_]+$/.test(status.error)?status.error:'edge_history_clear_failed');
  }
  console.log(JSON.stringify({
    status:'PASS',running:status?.running===true,phase:status?.phase??null,jobs:status?.jobs??null,
    activeBatch:status?.batch===null?null:{state:status?.batch?.state??null,
      expectedCount:status?.batch?.expectedCount??null,jobs:status?.batch?.jobs??null},
    inboxEmailsDeleted:0,secretsPrinted:false,
  },null,2));
}catch(error){
  const message=error instanceof Error?error.message:'';
  const code=/^[a-z0-9_]+$/.test(message)?message:'unexpected_edge_history_clear_error';
  console.error(`FAIL: ${code}`);
  process.exitCode=1;
}
