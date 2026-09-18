import {readFileSync} from 'node:fs';

const fail=code=>{throw new Error(code);};

try{
  if(process.env.ALLOW_TELNYX_EDGE_FAILED_JOB_HIDE!=='YES'){
    console.error('BLOCKED: set ALLOW_TELNYX_EDGE_FAILED_JOB_HIDE=YES only for an explicitly approved failed-job hide');
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
  const headers={authorization:`Bearer ${controlToken}`};
  const statusResponse=await fetch(new URL('/status',baseUrl),{
    headers,redirect:'error',signal:AbortSignal.timeout(30_000),
  });
  const status=await statusResponse.json();
  if(!statusResponse.ok)fail('edge_status_request_failed');
  const failed=(Array.isArray(status?.recentJobs)?status.recentJobs:[]).filter(job=>
    job?.status==='failed'&&typeof job?.id==='string'&&/^[a-f0-9]{64}$/.test(job.id));
  if(failed.length!==1)fail(failed.length===0?'edge_failed_job_not_found':'edge_failed_job_ambiguous');
  const response=await fetch(new URL(`/control/jobs/${failed[0].id}/hide`,baseUrl),{
    method:'POST',headers,redirect:'error',signal:AbortSignal.timeout(30_000),
  });
  const result=await response.json();
  if(!response.ok){
    fail(typeof result?.error==='string'&&/^[a-z0-9_]+$/.test(result.error)?result.error:'edge_failed_job_hide_failed');
  }
  console.log(JSON.stringify({
    status:'PASS',running:result?.running===true,phase:result?.phase??null,jobs:result?.jobs??null,
    activeBatch:result?.batch===null?null:{state:result?.batch?.state??null,jobs:result?.batch?.jobs??null},
    hiddenJobs:1,inboxMessagesDeleted:0,secretsPrinted:false,
  },null,2));
}catch(error){
  const message=error instanceof Error?error.message:'';
  const code=/^[a-z0-9_]+$/.test(message)?message:'unexpected_edge_failed_job_hide_error';
  console.error(`FAIL: ${code}`);
  process.exitCode=1;
}
