import {readFileSync} from 'node:fs';

const fail=code=>{throw new Error(code);};

try{
  const configuredUrl=process.env.EDGE_INVOKE_URL?.trim();
  if(!configuredUrl)fail('missing_edge_invoke_url');
  const baseUrl=new URL(configuredUrl);
  if(baseUrl.protocol!=='https:'||baseUrl.username||baseUrl.password||baseUrl.port||
      baseUrl.pathname!=='/'||baseUrl.search||baseUrl.hash||
      !/^[a-z0-9-]+\.telnyxcompute\.com$/.test(baseUrl.hostname))fail('invalid_edge_invoke_url');
  const controlToken=readFileSync('.private/edge-control-token','utf8').trim();
  if(controlToken.length<32||controlToken.length>512)fail('invalid_local_edge_control_token');
  const response=await fetch(new URL('/status',baseUrl),{
    headers:{authorization:`Bearer ${controlToken}`},redirect:'error',signal:AbortSignal.timeout(30_000),
  });
  let status;
  try{status=await response.json();}catch{
    console.error(JSON.stringify({responseStatus:response.status,
      contentType:response.headers.get('content-type'),responseBodyPrinted:false,secretsPrinted:false}));
    fail('edge_invalid_json_response');
  }
  if(!response.ok)fail('edge_status_request_failed');
  console.log(JSON.stringify({
    status:'PASS',running:status?.running===true,phase:status?.phase??null,
    lastPolledAt:status?.lastPolledAt??null,jobs:status?.jobs??null,lastError:status?.lastError??null,
    recentJobs:Array.isArray(status?.recentJobs)?status.recentJobs.slice(0,5).map(job=>({
      status:job?.status??null,receivedAt:job?.receivedAt??null,errorCode:job?.errorCode??null,
      hasExtractedReference:typeof job?.supplierName==='string'&&typeof job?.invoiceNumber==='string',
    })):[],
    activeBatch:status?.batch===null?null:{state:status?.batch?.state??null,jobs:status?.batch?.jobs??null},
    invoiceValuesPrinted:false,secretsPrinted:false,
  },null,2));
}catch(error){
  const message=error instanceof Error?error.message:'';
  const code=/^[a-z0-9_]+$/.test(message)?message:'unexpected_edge_status_error';
  console.error(`FAIL: ${code}`);
  process.exitCode=1;
}
