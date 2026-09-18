import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareEdgeVisualPages,
  renderPdfWithEdgeService,
  validateEdgePdfRendererConfig,
  validatePdfRendererResponse,
} from '../src/edge/pdf-renderer-client.ts';

const config={
  baseUrl:'https://bookkeeping-pdf-renderer-abc123-e.telnyxcompute.com',
  token:'r'.repeat(48),
};
const jpeg=Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=','base64');
const rendered={schemaVersion:'pdf_page_render_v1',pages:[{
  page:1,contentType:'image/jpeg',width:1,height:1,base64:jpeg.toString('base64'),
}]};

test('R-001 renderer config permits only a credential-free Telnyx Compute HTTPS origin',()=>{
  assert.deepEqual(validateEdgePdfRendererConfig(config),config);
  for(const baseUrl of [
    'http://bookkeeping-pdf-renderer-abc123-e.telnyxcompute.com',
    'https://localhost/',
    'https://user:pass@bookkeeping-pdf-renderer-abc123-e.telnyxcompute.com/',
    'https://bookkeeping-pdf-renderer-abc123-e.telnyxcompute.com/render',
    'https://bookkeeping-pdf-renderer-abc123-e.telnyxcompute.com/?token=x',
  ]) assert.throws(()=>validateEdgePdfRendererConfig({...config,baseUrl}),
    error=>error.code==='invalid_edge_pdf_renderer_config');
});

test('R-002 renderer response is strict, ordered, bounded, and validates actual JPEG bytes',()=>{
  const pages=validatePdfRendererResponse(rendered);
  assert.equal(pages.length,1);assert.equal(pages[0].page,1);assert.equal(pages[0].contentType,'image/jpeg');
  assert.deepEqual(pages[0].bytes,new Uint8Array(jpeg));
  for(const invalid of [
    {...rendered,extra:true},
    {...rendered,pages:[{...rendered.pages[0],page:2}]},
    {...rendered,pages:[{...rendered.pages[0],contentType:'image/png'}]},
    {...rendered,pages:[{...rendered.pages[0],base64:Buffer.from('not jpeg').toString('base64')}]},
  ]) assert.throws(()=>validatePdfRendererResponse(invalid));
});

test('R-003 PDF request sends no redirects or private metadata and accepts the strict payload',async()=>{
  const pdf=new TextEncoder().encode('%PDF-1.7\n');
  let observed;
  const pages=await renderPdfWithEdgeService(pdf,config,async(url,init)=>{
    observed={url,init};
    return Response.json(rendered);
  });
  assert.equal(pages.length,1);assert.equal(observed.url,`${config.baseUrl}/render`);
  assert.equal(observed.init.method,'POST');assert.equal(observed.init.redirect,'error');
  assert.equal(observed.init.headers.authorization,`Bearer ${config.token}`);
  assert.deepEqual([...observed.init.body],[...pdf]);
  assert.equal(JSON.stringify(observed).includes('invoice'),false);
});

test('R-004 renderer failures expose stable stage codes, never provider bodies',async()=>{
  const pdf=new TextEncoder().encode('%PDF-1.7\n');
  await assert.rejects(()=>renderPdfWithEdgeService(pdf,config,async()=>new Response('PRIVATE DETAIL',{status:503})),
    error=>error.code==='pdf_renderer_temporarily_unavailable'&&!error.message.includes('PRIVATE DETAIL'));
  await assert.rejects(()=>renderPdfWithEdgeService(pdf,config,async()=>{throw new Error('PRIVATE NETWORK DETAIL');}),
    error=>error.code==='pdf_renderer_connection_failed'&&!error.message.includes('PRIVATE NETWORK DETAIL'));
});

test('R-005 direct JPEG input bypasses the PDF renderer',async()=>{
  let requests=0;
  const pages=await prepareEdgeVisualPages(new Uint8Array(jpeg),'image/jpeg',undefined,async()=>{
    requests++;throw new Error('should not fetch');
  });
  assert.equal(requests,0);assert.equal(pages.length,1);assert.equal(pages[0].contentType,'image/jpeg');
});
