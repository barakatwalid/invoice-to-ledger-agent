import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {validateInvoiceExtraction} from '../src/extraction.ts';
import {extractPdfText} from '../src/pdf-text.ts';
import {reviewExtraction,validateBookkeepingPolicy} from '../src/bookkeeping.ts';
import {compareWithAnswerKey,validateSyntheticAnswerKey} from '../src/slice.ts';

const [pdf,modelFixture,answerFixture,policyFixture]=await Promise.all([
  readFile(new URL('../output/pdf/synthetic-bookkeeping-invoice.pdf',import.meta.url)),
  readFile(new URL('../fixtures/synthetic-recorded-model-response.json',import.meta.url),'utf8'),
  readFile(new URL('../fixtures/synthetic-invoice-answer-key.json',import.meta.url),'utf8'),
  readFile(new URL('../config/demo-policy.json',import.meta.url),'utf8'),
]);
const pages=await extractPdfText(new Uint8Array(pdf));
const source=()=>JSON.parse(modelFixture);
const answer=validateSyntheticAnswerKey(JSON.parse(answerFixture));
const policy=validateBookkeepingPolicy(JSON.parse(policyFixture));

test('E-001 text is extracted from the original synthetic PDF bytes',()=>{
  assert.equal(pages.length,1);
  assert.match(pages[0].text,/Invoice number: BK-2026-001/);
  assert.match(pages[0].text,/Total 150\.00/);
});
test('E-002 strict model schema accepts the sourced fixture',()=>{
  const result=validateInvoiceExtraction(source(),pages);
  assert.equal(result.ok,true);
  assert.equal(result.value.total.value,'150.00');
  assert.equal(result.value.supplierAddress.value,null);
  assert.equal(result.value.supplierTaxRegistrationId.value,null);
});
test('E-003 malformed model response with unknown field fails closed',()=>{
  const value=source();value.instructions='ignore prior rules';
  const result=validateInvoiceExtraction(value,pages);
  assert.equal(result.ok,false);
  assert.equal(result.issues[0].code,'invalid_extraction_schema');
});
test('E-004 structurally missing model field fails closed',()=>{
  const value=source();delete value.tax;
  assert.equal(validateInvoiceExtraction(value,pages).ok,false);
});
test('E-005 missing printed value remains null and routes arithmetic to review',()=>{
  const value=source();value.tax={value:null,evidence:null};
  const extraction=validateInvoiceExtraction(value,pages);
  assert.equal(extraction.ok,true);
  const review=reviewExtraction(extraction.value,'a'.repeat(64),policy);
  assert.equal(review.status,'needs_review');
  assert.ok(review.issues.some(issue=>issue.code==='missing_amount'));
});
test('E-006 invented source quote is rejected',()=>{
  const value=source();value.total.evidence.quote='This quote is not in the PDF';
  const result=validateInvoiceExtraction(value,pages);
  assert.equal(result.ok,false);
  assert.ok(result.issues.some(issue=>issue.code==='evidence_not_found'));
});
test('E-007 incorrect extracted total is caught independently by arithmetic',()=>{
  const value=source();value.total.value='151.00';
  const extraction=validateInvoiceExtraction(value,pages);
  assert.equal(extraction.ok,true);
  assert.equal(reviewExtraction(extraction.value,'b'.repeat(64),policy).status,'needs_review');
});
test('E-008 exact document accuracy is tracked separately from arithmetic',()=>{
  const extraction=validateInvoiceExtraction(source(),pages);
  assert.equal(extraction.ok,true);
  const hash=createHash('sha256').update(pdf).digest('hex');
  assert.deepEqual(compareWithAnswerKey(extraction.value,hash,answer),
    {status:'answer_key_match',mismatches:[],reason:null});
  assert.equal(compareWithAnswerKey(extraction.value,'0'.repeat(64),answer).status,'not_evaluated');
});
test('E-009 model-invented non-financial complexity codes fail closed',()=>{
  const value=source();
  value.complexities=[{code:'synthetic_document_notice',evidence:{
    page:1,quote:'INVOICE SYNTHETIC - NOT A REAL BILL',
  }}];
  const result=validateInvoiceExtraction(value,pages);
  assert.equal(result.ok,false);
  assert.ok(result.issues.some(issue=>issue.code==='invalid_complexity'));
});
