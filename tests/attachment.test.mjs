import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {attachmentHostname,downloadAttachment,parseAllowedAttachmentHosts,parseAttachmentMetadata} from '../src/attachment.ts';

const bytes=new TextEncoder().encode('%PDF-1.4\nsynthetic');

test('A-001 attachment metadata follows the verified response-field contract',()=>{
  const parsed=parseAttachmentMetadata({url:'https://files.telnyx.test/a',filename:'invoice.pdf',
    content_type:'application/pdf',size_bytes:null,sha256:null,disposition:'attachment'});
  assert.equal(parsed.declaredSize,null);assert.equal(parsed.contentType,'application/pdf');
});
test('A-002 download sends no bearer header and verifies bytes, size, and hash',async()=>{
  const expectedDigest=createHash('sha256').update(bytes).digest('hex');
  const meta=parseAttachmentMetadata({url:'https://files.telnyx.test/a',filename:'invoice.pdf',
    content_type:'application/pdf',size_bytes:bytes.length,sha256:expectedDigest});
  const result=await downloadAttachment(meta,{allowedHosts:new Set(['files.telnyx.test']),fetcher:async(url,init)=>{
    assert.equal(new URL(url).hostname,'files.telnyx.test');
    assert.equal(init?.headers,undefined);assert.equal(init?.redirect,'error');
    return new Response(bytes,{status:200,headers:{'content-type':'application/pdf','content-length':String(bytes.length)}});
  }});
  assert.equal(result.sha256,expectedDigest);assert.deepEqual(result.bytes,bytes);
});
test('A-003 failed attachment response exposes only a stable code',async()=>{
  const meta=parseAttachmentMetadata({url:'https://files.telnyx.test/a',filename:'invoice.pdf',
    content_type:'application/pdf',size_bytes:null,sha256:null});
  await assert.rejects(()=>downloadAttachment(meta,{allowedHosts:new Set(['files.telnyx.test']),
    fetcher:async()=>new Response('private body',{status:503})}),error=>error.code==='attachment_http_503');
});
test('A-004 unapproved hosts are rejected before fetch',async()=>{
  let called=false;
  const meta=parseAttachmentMetadata({url:'https://attacker.example/a',filename:'invoice.pdf',
    content_type:'application/pdf',size_bytes:null,sha256:null});
  await assert.rejects(()=>downloadAttachment(meta,{allowedHosts:new Set(['files.telnyx.test']),
    fetcher:async()=>{called=true;return new Response(bytes);}}),error=>error.code==='attachment_host_not_allowed');
  assert.equal(called,false);
});
test('A-005 declared hash mismatch fails closed',async()=>{
  const meta=parseAttachmentMetadata({url:'https://files.telnyx.test/a',filename:'invoice.pdf',
    content_type:'application/pdf',size_bytes:bytes.length,sha256:'0'.repeat(64)});
  await assert.rejects(()=>downloadAttachment(meta,{allowedHosts:new Set(['files.telnyx.test']),
    fetcher:async()=>new Response(bytes,{headers:{'content-length':String(bytes.length)}})}),error=>error.code==='attachment_hash_mismatch');
});
test('A-006 attachment allowlist rejects wildcards and IP literals',()=>{
  assert.throws(()=>parseAllowedAttachmentHosts('*.telnyx.test'));
  assert.throws(()=>parseAllowedAttachmentHosts('127.0.0.1'));
  assert.deepEqual([...parseAllowedAttachmentHosts('Files.Telnyx.Test')],['files.telnyx.test']);
});
test('A-007 hostname discovery returns no path and rejects unsafe URL authorities',()=>{
  const base={filename:'invoice.pdf',contentType:'application/pdf',declaredSize:null,declaredSha256:null};
  assert.equal(attachmentHostname({...base,url:'https://Files.Telnyx.Test/private/token?signature=secret'}),'files.telnyx.test');
  assert.throws(()=>attachmentHostname({...base,url:'https://127.0.0.1/private'}));
  assert.throws(()=>attachmentHostname({...base,url:'https://user:password@files.telnyx.test/private'}));
});
test('A-008 live Telnyx MIME attachment shape is parsed without inventing size or hash',()=>{
  const parsed=parseAttachmentMetadata({
    url:'https://files.telnyx.test/a',
    content_disposition:{content_disposition:'attachment',params:{filename:'invoice.pdf'}},
    content_type:{content_type:'application/pdf',params:{name:'invoice.pdf'}},
  });
  assert.deepEqual(parsed,{url:'https://files.telnyx.test/a',filename:'invoice.pdf',
    contentType:'application/pdf',declaredSize:null,declaredSha256:null});
});
test('A-009 JPEG and PNG attachments are accepted by MIME type without special filenames',()=>{
  for(const contentType of ['image/jpeg','image/png']){
    const parsed=parseAttachmentMetadata({url:'https://files.telnyx.test/a',filename:'scan-from-phone',
      content_type:contentType,size_bytes:null,sha256:null});
    assert.equal(parsed.filename,'scan-from-phone');assert.equal(parsed.contentType,contentType);
  }
  assert.throws(()=>parseAttachmentMetadata({url:'https://files.telnyx.test/a',filename:'invoice.pdf',
    content_type:'application/octet-stream'}),error=>error.code==='unsupported_attachment_type');
});
