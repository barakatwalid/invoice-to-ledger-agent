import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const baseUrl=process.env.LOCAL_AGENT_URL?.trim()||'http://127.0.0.1:3000';
let parsed;
try{parsed=new URL(baseUrl);}catch{console.error('BLOCKED: invalid LOCAL_AGENT_URL');process.exit(2);}
if(!['127.0.0.1','localhost','::1'].includes(parsed.hostname)){
  console.error('BLOCKED: local acceptance only permits a loopback URL');process.exit(2);
}
const tokenPath=resolve(process.env.BOOKKEEPING_DATA_DIR?.trim()||'.private','local-agent-control-token');
let token=process.env.BOOKKEEPING_CONTROL_TOKEN?.trim();
if(!token){
  try{token=(await readFile(tokenPath,'utf8')).trim();}
  catch{console.error('BLOCKED: local agent control token is unavailable');process.exit(2);}
}
if(token.length<32||token.length>512){console.error('BLOCKED: invalid local agent control token');process.exit(2);}
const authorization=`Basic ${Buffer.from(`review:${token}`).toString('base64')}`;
const request=async(path,options={})=>fetch(new URL(path,parsed),{
  ...options,signal:AbortSignal.timeout(10_000),redirect:'manual',
  headers:{...options.headers},
});
try{
  const health=await request('/health');
  if(health.status!==200)throw new Error('local_health_failed');
  const blocked=await request('/status');
  if(blocked.status!==401)throw new Error('local_unauthorized_boundary_failed');
  const statusResponse=await request('/status',{headers:{authorization}});
  if(statusResponse.status!==200)throw new Error('local_authenticated_status_failed');
  const status=await statusResponse.json();
  const homeResponse=await request('/',{headers:{authorization}});
  if(homeResponse.status!==200)throw new Error('local_dashboard_access_failed');
  const home=await homeResponse.text();
  const batchUi=home.includes('Quarterly completeness batch')&&home.includes('Expected invoice count')&&
    home.includes('count-only')?'inspectable_batch_ui_pass':'invalid_batch_ui';
  if(batchUi!=='inspectable_batch_ui_pass')throw new Error('local_batch_ui_failed');
  let resultStatus='not_available';
  let decision=null;
  if(typeof status?.lastCompletedJobId==='string'){
    const resultResponse=await request(`/results/${status.lastCompletedJobId}`,{headers:{authorization}});
    if(resultResponse.status!==200)throw new Error('local_result_access_failed');
    const html=await resultResponse.text();
    resultStatus=html.includes('Human review required')?'inspectable_html_pass':'invalid_html';
    decision=html.includes('proposal_ready_for_human_review')?'proposal_ready_for_human_review':
      html.includes('needs_review')?'needs_review':'not_detected';
  }
  console.log(JSON.stringify({status:'PASS',health:health.status,unauthorizedBoundary:blocked.status,
    authenticatedStatus:statusResponse.status,phase:status.phase??null,jobs:status.jobs?.counts??null,
    batchUi,batchStatus:status.batch?.completeness?.status??'not_configured',
    lastPoll:status.lastPoll??null,lastError:status.lastError??null,
    resultStatus,decision,secretsPrinted:false},null,2));
}catch(error){
  const code=error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)?error.message:'local_acceptance_failed';
  console.error(`FAIL: ${code}`);process.exitCode=1;
}
