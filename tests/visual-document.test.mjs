import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {isPdfRendererAvailable,prepareVisualPages,validateVisualInputBytes,visualPageDataUrl} from '../src/visual-document.ts';

test('V-000 configured local PDF renderer passes its bounded capability preflight',async()=>{
  assert.equal(await isPdfRendererAvailable(),true);
});

test('V-001 a PDF is rendered portably to ordered PNG pages for vision input',async()=>{
  const pdf=new Uint8Array(await readFile(new URL('../output/pdf/synthetic-bookkeeping-invoice.pdf',import.meta.url)));
  const pages=await prepareVisualPages(pdf,'application/pdf');
  assert.equal(pages.length,1);assert.equal(pages[0].page,1);assert.equal(pages[0].contentType,'image/png');
  assert.deepEqual([...pages[0].bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);
  assert.match(visualPageDataUrl(pages[0]),/^data:image\/png;base64,/);
});

test('V-002 PNG and JPEG inputs are decoded and retain their actual MIME type',async()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
  const jpeg=Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=','base64');
  for(const [contentType,bytes] of [
    ['image/png',png],
    ['image/jpeg',jpeg],
  ]){
    const pages=await prepareVisualPages(new Uint8Array(bytes),contentType);
    assert.equal(pages.length,1);assert.equal(pages[0].contentType,contentType);
  }
});

test('V-003 declared MIME and actual byte signature must agree',()=>{
  const fakePdf=new TextEncoder().encode('%PDF-1.7\n');
  assert.throws(()=>validateVisualInputBytes(fakePdf,'image/png'),
    error=>error.code==='attachment_content_type_mismatch');
  assert.throws(()=>validateVisualInputBytes(new Uint8Array([137,80,78,71,13,10,26,10]),'application/pdf'),
    error=>error.code==='attachment_content_type_mismatch');
});
