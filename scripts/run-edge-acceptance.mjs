import {chmodSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';

const approval='ALLOW_TELNYX_EDGE_LIVE_ACCEPTANCE';
if(process.env[approval]!=='YES'){
  console.error(`BLOCKED: set ${approval}=YES only for an explicitly approved deployed acceptance run`);
  process.exit(2);
}

const fail=code=>{throw new Error(code);};
const request=async(url,init={})=>fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(20_000)});
const parseJson=async response=>{
  try{return await response.json();}catch{fail('edge_invalid_json_response');}
};
const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));

let started=false;
let baseUrl;
let headers;
try{
  const configuredUrl=process.env.EDGE_INVOKE_URL?.trim();
  if(!configuredUrl)fail('missing_edge_invoke_url');
  baseUrl=new URL(configuredUrl);
  if(baseUrl.protocol!=='https:'||baseUrl.username||baseUrl.password||baseUrl.port||
      baseUrl.pathname!=='/'||baseUrl.search||baseUrl.hash||
      !/^[a-z0-9-]+\.telnyxcompute\.com$/.test(baseUrl.hostname))fail('invalid_edge_invoke_url');
  const controlToken=readFileSync('.private/edge-control-token','utf8').trim();
  if(controlToken.length<32||controlToken.length>512)fail('invalid_local_edge_control_token');
  headers={authorization:`Bearer ${controlToken}`};

  const health=await request(new URL('/health',baseUrl));
  const healthBody=await parseJson(health);
  if(health.status!==200||healthBody?.status!=='ready')fail('edge_health_check_failed');
  const unauthorized=await request(new URL('/status',baseUrl));
  if(unauthorized.status!==401)fail('edge_unauthorized_boundary_failed');

  const start=await request(new URL('/control/start',baseUrl),{method:'POST',headers});
  const startBody=await parseJson(start);
  if(start.status!==200||startBody?.running!==true)fail('edge_start_failed');
  started=true;

  const deadline=Date.now()+240_000;
  let status=startBody;
  while(Date.now()<deadline){
    if(status?.lastCompletedJobId&&status?.jobs?.complete>=1)break;
    if(status?.jobs?.failed>=1)fail(`edge_job_failed_${String(status.lastError??'unknown')}`);
    if(typeof status?.lastError==='string'){
      const pollError=/^[a-z0-9_]+$/.test(status.lastError)?status.lastError:'unknown';
      fail(`edge_poll_failed_${pollError}`);
    }
    await wait(5_000);
    const response=await request(new URL('/status',baseUrl),{headers});
    status=await parseJson(response);
    if(response.status!==200)fail('edge_status_failed');
  }
  const jobId=status?.lastCompletedJobId;
  if(typeof jobId!=='string'||!/^[a-f0-9]{64}$/.test(jobId))fail('edge_acceptance_timeout');
  const resultResponse=await request(new URL(`/results/${jobId}`,baseUrl),{headers});
  const result=await parseJson(resultResponse);
  if(resultResponse.status!==200||result?.schemaVersion!=='bookkeeping_edge_result_v1'||
      result.jobId!==jobId||result.intake?.provider!=='telnyx_email'||
      result.controls?.automaticPosting!==false||result.controls?.publicResultUrl!==false){
    fail('edge_result_validation_failed');
  }
  mkdirSync('.private/results',{recursive:true,mode:0o700});
  const resultPath=`.private/results/${jobId}-edge.json`;
  writeFileSync(resultPath,`${JSON.stringify(result,null,2)}\n`,{mode:0o600});
  chmodSync(resultPath,0o600);
  console.log(JSON.stringify({
    status:'PASS',mode:'LIVE_TELNYX_EDGE',jobId,decision:result.decision,
    resultPath,automaticPosting:false,publicResultUrl:false,valuesPrinted:false,
  },null,2));
}catch(error){
  const message=error instanceof Error?error.message:'';
  const code=/^[a-z0-9_]+$/.test(message)?message:'unexpected_edge_acceptance_error';
  console.error(`FAIL: ${code}`);
  process.exitCode=1;
}finally{
  if(started&&baseUrl&&headers){
    try{
      const stop=await request(new URL('/control/stop',baseUrl),{method:'POST',headers});
      if(!stop.ok){console.error('FAIL: edge_stop_failed');process.exitCode=1;}
    }catch{
      console.error('FAIL: edge_stop_failed');process.exitCode=1;
    }
  }
}
