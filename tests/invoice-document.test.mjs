import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkflowError} from '../src/errors.ts';
import {readInvoiceDocument} from '../src/invoice-document.ts';

const visualRun={
  pages:[{page:1,text:'Vision invoice text'}],
  configuredModelId:'provider/vision-model',
  responseModelId:'provider/vision-model',
  provider:'telnyx_inference',
};

test('D-001 embedded PDF text remains the preferred path and does not invoke vision',async()=>{
  let visualPreparationCalls=0;let visualModelCalls=0;
  const result=await readInvoiceDocument(new Uint8Array([1,2,3]),'application/pdf',{
    extractText:async()=>[{page:1,text:'Embedded invoice text'}],
    prepareVisual:async()=>{visualPreparationCalls++;return [];},
    transcribeVisual:async()=>{visualModelCalls++;return visualRun;},
  });
  assert.deepEqual(result,{pages:[{page:1,text:'Embedded invoice text'}],path:'embedded_text',visualModel:null});
  assert.equal(visualPreparationCalls,0);assert.equal(visualModelCalls,0);
});

test('D-002 a PDF with no embedded text is rendered and transcribed through Telnyx vision',async()=>{
  let visualModelPages=0;
  const result=await readInvoiceDocument(new Uint8Array([1,2,3]),'application/pdf',{
    extractText:async()=>{throw new WorkflowError('pdf_has_no_extractable_text');},
    prepareVisual:async(_bytes,contentType)=>{
      assert.equal(contentType,'application/pdf');
      return [{page:1,contentType:'image/png',bytes:new Uint8Array([1,2,3,4,5,6,7,8])}];
    },
    transcribeVisual:async pages=>{visualModelPages=pages.length;return visualRun;},
  });
  assert.equal(visualModelPages,1);assert.equal(result.path,'telnyx_vision');
  assert.deepEqual(result.pages,visualRun.pages);assert.deepEqual(result.visualModel,{
    configuredModelId:visualRun.configuredModelId,responseModelId:visualRun.responseModelId,
    provider:'telnyx_inference',
  });
});

test('D-003 JPEG and PNG inputs always use the bounded visual path',async()=>{
  for(const contentType of ['image/jpeg','image/png']){
    let textCalls=0;
    const result=await readInvoiceDocument(new Uint8Array([1,2,3]),contentType,{
      extractText:async()=>{textCalls++;return [];},
      prepareVisual:async()=>[{page:1,contentType,bytes:new Uint8Array([1,2,3,4,5,6,7,8])}],
      transcribeVisual:async()=>visualRun,
    });
    assert.equal(textCalls,0);assert.equal(result.path,'telnyx_vision');
  }
});

test('D-004 malformed PDFs do not silently fall back to vision',async()=>{
  let visualCalls=0;
  await assert.rejects(()=>readInvoiceDocument(new Uint8Array([1]),'application/pdf',{
    extractText:async()=>{throw new WorkflowError('unsupported_or_invalid_pdf');},
    prepareVisual:async()=>[],
    transcribeVisual:async()=>{visualCalls++;return visualRun;},
  }),error=>error.code==='unsupported_or_invalid_pdf');
  assert.equal(visualCalls,0);
});
