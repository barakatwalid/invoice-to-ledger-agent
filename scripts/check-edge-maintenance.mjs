import {readFileSync} from 'node:fs';

try{
  const configuredUrl=process.env.EDGE_INVOKE_URL?.trim();
  if(!configuredUrl)throw new Error('missing_edge_invoke_url');
  const baseUrl=new URL(configuredUrl);
  if(baseUrl.protocol!=='https:'||!baseUrl.hostname.endsWith('.telnyxcompute.com')||
      baseUrl.username||baseUrl.password||baseUrl.pathname!=='/'||baseUrl.search||baseUrl.hash){
    throw new Error('invalid_edge_invoke_url');
  }
  const viewerToken=readFileSync('.private/edge-viewer-token','utf8').trim();
  const controlToken=readFileSync('.private/edge-control-token','utf8').trim();
  if(viewerToken.length<32||controlToken.length<32)throw new Error('invalid_local_edge_token');
  const viewerAuthorization=`Basic ${Buffer.from(`review:${viewerToken}`,'utf8').toString('base64')}`;
  const request=(path,authorization)=>fetch(new URL(path,baseUrl),{
    headers:authorization?{authorization}:{},redirect:'error',signal:AbortSignal.timeout(30_000),
  });
  const health=await request('/health');
  const blocked=await request('/');
  const page=await request('/',viewerAuthorization);
  const html=await page.text();
  const guide=await request('/how-it-works',viewerAuthorization);
  const status=await request('/status',`Bearer ${controlToken}`);
  let statusJson=null;
  try{statusJson=await status.json();}catch{}
  const checks={
    healthReady:health.status===200,
    unauthenticatedRootBlocked:blocked.status===401,
    maintenancePage:page.status===503&&page.headers.get('content-type')?.startsWith('text/html')&&
      html.includes('Processing is safely paused')&&html.includes('StatefulActor')&&
      !html.includes('unexpected_error')&&!html.includes('SqliteSidecarServer'),
    retryBounded:page.headers.get('retry-after')==='30',
    staticGuideAvailable:guide.status===200,
    statusFailsSafely:status.status===503&&statusJson?.status==='blocked'&&
      statusJson?.error==='unexpected_error',
    securityHeaders:page.headers.get('content-security-policy')?.includes("default-src 'none'")&&
      page.headers.get('x-frame-options')==='DENY',
  };
  const pass=Object.values(checks).every(Boolean);
  console.log(JSON.stringify({status:pass?'PASS':'FAIL',mode:'maintenance',checks,
    responseBodiesPrinted:false,secretsPrinted:false},null,2));
  if(!pass)process.exitCode=1;
}catch(error){
  const code=error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)?error.message:
    'edge_maintenance_check_failed';
  console.error(`FAIL: ${code}`);
  process.exitCode=1;
}
