import {readFileSync} from 'node:fs';

try{
  const configuredUrl=process.env.EDGE_INVOKE_URL?.trim();
  if(!configuredUrl)throw new Error('missing_edge_invoke_url');
  const baseUrl=new URL(configuredUrl);
  if(baseUrl.protocol!=='https:'||!baseUrl.hostname.endsWith('.telnyxcompute.com')||
      baseUrl.username||baseUrl.password||baseUrl.pathname!=='/'||baseUrl.search||baseUrl.hash){
    throw new Error('invalid_edge_dashboard_url');
  }
  const viewerToken=readFileSync('.private/edge-viewer-token','utf8').trim();
  if(viewerToken.length<32||viewerToken.length>512)throw new Error('invalid_local_edge_viewer_token');
  const authorization=`Basic ${Buffer.from(`review:${viewerToken}`,'utf8').toString('base64')}`;
  const request=async(path,headers={})=>fetch(new URL(path,baseUrl),{
    method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(30_000),
  });
  const health=await request('/health');
  const healthJson=await health.json();
  const blocked=await request('/');
  const page=await request('/',{authorization});
  const html=await page.text();
  const invoicePath=html.match(/href="(\/invoices\/[a-f0-9]{64})"/)?.[1]??null;
  const detail=invoicePath===null?null:await request(invoicePath,{authorization});
  const detailHtml=detail===null?'':await detail.text();
  const guide=await request('/how-it-works',{authorization});
  const guideHtml=await guide.text();
  const controlBoundary=await request('/status',{authorization});
  const checks={
    healthReady:health.status===200&&healthJson?.status==='ready',
    unauthenticatedRootBlocked:blocked.status===401&&blocked.headers.get('www-authenticate')?.startsWith('Basic '),
    authenticatedDashboard:page.status===200&&page.headers.get('content-type')?.startsWith('text/html'),
    liveInboxMonitor:html.includes('Live inbox monitor')&&html.includes('Waiting to claim')&&
      !html.includes('read-only inbox snapshot is temporarily unavailable'),
    sidePanelLayout:html.includes('<div class="dashboard-layout"><aside class="dashboard-rail">')&&
      !html.includes('<section class="flow"'),
    compactInvoiceReview:detail?.status===200&&detailHtml.includes('Source document')&&
      detailHtml.includes(`${invoicePath}/document`)&&detailHtml.includes('detail-overview'),
    hostedGuide:guide.status===200&&guideHtml.includes('What happens to an invoice?')&&
      guideHtml.includes('StatefulActor')&&guideHtml.includes('Telnyx PDF renderer turns up to 10 scanned pages')&&
      guideHtml.includes('Direct JPEG/PNG skips rendering')&&
      guideHtml.includes('GLM reads the JPEG pages')&&guideHtml.includes('The images are sent to the LLM')&&
      guideHtml.includes('zai-org/GLM-5.3-Flash via Telnyx Inference')&&
      guideHtml.includes('The StatefulActor runs Step 3')&&
      guideHtml.includes('The LLM extracts; the StatefulActor checks')&&
      !guideHtml.includes('Telnyx Vision reads'),
    securityHeaders:page.headers.get('content-security-policy')?.includes("default-src 'none'")&&
      page.headers.get('x-frame-options')==='DENY'&&guide.headers.get('x-frame-options')==='DENY',
    resultOrCleanStateVisible:(html.includes('Step 3 · Accounting')&&html.includes('Suggested entries')&&
      html.includes('Step 4 · Reconciliation')&&html.includes('Independent checks'))||
      html.includes('No completed invoice yet'),
    step1Visible:html.includes('Step 1 · Completeness'),
    invoiceArchiveVisible:html.includes('Invoice archive')&&html.includes('Recent invoices'),
    postingGuardrailVisible:html.includes('Automatic posting is off')||html.includes('No completed invoice yet'),
    privateDetailsOmitted:!html.includes('sha256')&&!html.includes('Raw JSON')&&!html.includes('Source evidence'),
    viewerCannotAccessControlApi:controlBoundary.status===401,
  };
  const pass=Object.values(checks).every(Boolean);
  console.log(JSON.stringify({status:pass?'PASS':'FAIL',target:baseUrl.origin,checks,secretsPrinted:false},null,2));
  if(!pass)process.exitCode=1;
}catch(error){
  const code=error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)?error.message:'edge_dashboard_check_failed';
  console.error(`FAIL: ${code}`);
  process.exitCode=1;
}
