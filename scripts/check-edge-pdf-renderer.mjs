import {readFile} from 'node:fs/promises';
import {
  checkEdgePdfRendererHealth,
  renderPdfWithEdgeService,
  validateEdgePdfRendererConfig,
} from '../src/edge/pdf-renderer-client.ts';

if(process.env.ALLOW_BOOKKEEPING_PDF_RENDERER_TEST!=='YES'){
  console.error('BLOCKED: set ALLOW_BOOKKEEPING_PDF_RENDERER_TEST=YES only for an explicitly approved hosted renderer test');
  process.exit(2);
}

try{
  const config=validateEdgePdfRendererConfig({
    baseUrl:process.env.BOOKKEEPING_PDF_RENDERER_URL?.trim()??'',
    token:(await readFile('.private/pdf-renderer-token','utf8')).trim(),
  });
  const pdf=new Uint8Array(await readFile('tmp/pdfs/scanned-renderer-test.pdf'));
  await checkEdgePdfRendererHealth(config);
  const pages=await renderPdfWithEdgeService(pdf,config);
  console.log(JSON.stringify({
    status:'PASS',health:'ready',input:'synthetic_image_only_pdf',
    pages:pages.map(page=>({page:page.page,contentType:page.contentType,sizeBytes:page.bytes.byteLength})),
    credentialsPrinted:false,documentTextPrinted:false,
  },null,2));
}catch(error){
  const code=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'?
    error.code:'hosted_pdf_renderer_test_failed';
  console.error(`FAIL: ${code}`);
  process.exitCode=1;
}
