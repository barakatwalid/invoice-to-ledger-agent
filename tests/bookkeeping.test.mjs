import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertAllowedResultRecipient,normalizePrintedAmount,proposeAccountingEntries,reviewExtraction,validateBookkeepingPolicy} from '../src/bookkeeping.ts';
import {validateInvoiceExtraction} from '../src/extraction.ts';
import {extractPdfText} from '../src/pdf-text.ts';

const policy=validateBookkeepingPolicy(JSON.parse(readFileSync(new URL('../config/demo-policy.json',import.meta.url),'utf8')));
const bytes=new Uint8Array(readFileSync(new URL('../output/pdf/synthetic-bookkeeping-invoice.pdf',import.meta.url)));
const pages=await extractPdfText(bytes);
const validated=validateInvoiceExtraction(JSON.parse(readFileSync(new URL('../fixtures/synthetic-recorded-model-response.json',import.meta.url),'utf8')),pages);
if(!validated.ok)throw new Error('test fixture is invalid');

test('K-001 demo accounting proposal balances exact gross amount and remains unapproved',()=>{
  const arithmetic=reviewExtraction(validated.value,'a'.repeat(64),policy);
  const proposal=proposeAccountingEntries(validated.value,arithmetic,policy);
  assert.equal(proposal.status,'suggested_human_review_required');
  assert.equal(proposal.entries[0].amount,'150.00');
  assert.equal(proposal.balance.matches,true);
  assert.equal(proposal.postingPermitted,false);
  assert.equal(proposal.taxTreatmentVerified,false);
  assert.match(proposal.policyLabel,/DEMO ONLY/);
});
test('K-002 proposal is withheld when arithmetic needs review',()=>{
  const altered=structuredClone(validated.value);altered.total.value='151.00';
  const proposal=proposeAccountingEntries(altered,reviewExtraction(altered,'b'.repeat(64),policy),policy);
  assert.equal(proposal.status,'withheld_needs_review');assert.equal(proposal.entries.length,0);
});
test('K-003 result recipients are controlled by trusted policy, not invoice text',()=>{
  assert.throws(()=>assertAllowedResultRecipient('vendor@example.com',policy),error=>error.code==='result_recipient_not_allowed');
  const allowed=structuredClone(policy);allowed.allowedResultRecipients=['reviewer@example.test'];
  assert.doesNotThrow(()=>assertAllowedResultRecipient('Reviewer@Example.Test',allowed));
  assert.throws(()=>assertAllowedResultRecipient('reply-to@example.test',allowed));
});
test('K-004 authenticated actor result access is an explicit valid policy, not public access',()=>{
  const edgePolicy=structuredClone(policy);edgePolicy.resultAccess='authenticated_edge_actor_only';
  const validatedPolicy=validateBookkeepingPolicy(edgePolicy);
  assert.equal(validatedPolicy.resultAccess,'authenticated_edge_actor_only');
  assert.deepEqual(validatedPolicy.allowedResultRecipients,[]);
});
test('K-005 authenticated local service result access is explicit and remains non-public',()=>{
  const hostedPolicy=structuredClone(policy);hostedPolicy.resultAccess='authenticated_local_service_only';
  assert.equal(validateBookkeepingPolicy(hostedPolicy).resultAccess,'authenticated_local_service_only');
});
test('K-006 trusted currency markers normalize for arithmetic without changing extracted strings',()=>{
  const extraction=structuredClone(validated.value);
  const originals={subtotal:extraction.subtotal.value,total:extraction.total.value};
  for(const line of extraction.lines){line.unitPrice.value=`$${line.unitPrice.value}`;line.lineNet.value=`$${line.lineNet.value}`;}
  extraction.subtotal.value='$125.00';extraction.tax.value='$25.00';extraction.total.value='$150.00';
  const review=reviewExtraction(extraction,'c'.repeat(64),policy);
  const proposal=proposeAccountingEntries(extraction,review,policy);
  assert.equal(review.status,'arithmetic_consistent');assert.equal(proposal.status,'suggested_human_review_required');
  assert.equal(proposal.entries[0].amount,'150.00');assert.equal(extraction.subtotal.value,'$125.00');
  assert.deepEqual(originals,{subtotal:'125.00',total:'150.00'});
});
test('K-007 explicitly allowed comma-decimal EUR format normalizes exactly',()=>{
  assert.equal(normalizePrintedAmount('EUR 1.685,50','EUR',policy),'1685.50');
  assert.equal(normalizePrintedAmount('EUR 1.685,501','EUR',policy),null);
  assert.equal(normalizePrintedAmount('RM 1,900.80','MYR',policy),'1900.80');
});
