import test from 'node:test';
import assert from 'node:assert/strict';
import {renderInspectableResult} from '../src/result.ts';

test('O-001 untrusted extracted text is HTML-escaped in inspectable output',()=>{
  const html=renderInspectableResult({supplier:'<script>alert("invoice")</script>'});
  assert.ok(!html.includes('<script>alert'));
  assert.match(html,/&lt;script&gt;alert/);
  assert.match(html,/&lt;\/script&gt;/);
  assert.match(html,/&quot;invoice/);
  assert.match(html,/Human review required/);
});

test('O-002 inspectable output presents extracted fields and retains raw JSON',()=>{
  const value=(text,quote)=>({value:text,evidence:{page:1,quote}});
  const result={
    decision:'proposal_ready_for_human_review',createdAt:'2026-09-09T10:00:00.000Z',
    job:{id:'a'.repeat(64)},intake:{attachment:{filename:'invoice.pdf',contentType:'application/pdf',
      calculatedSize:5364}},documentText:{source:'embedded_pdf_text',pages:1,note:'Checked.'},
    extraction:{configuredModelId:'test/model',responseModelId:'test/model',values:{
      supplierName:value('NORTHSTAR DEMO SUPPLIES','NORTHSTAR DEMO SUPPLIES'),
      invoiceNumber:value('BK-2026-001','Invoice number: BK-2026-001'),
      invoiceDate:value('2026-09-08','Invoice date: 2026-09-08'),currency:value('USD','Currency: USD'),
      pricing:value('net','Pricing: net'),subtotal:value('125.00','Subtotal 125.00'),
      tax:value('25.00','Tax 25.00'),total:value('150.00','Total 150.00'),
      lines:[{description:value('Design','Design 2 50.00 100.00'),quantity:value('2','2'),
        unitPrice:value('50.00','50.00'),lineNet:value('100.00','100.00')}],complexities:[],
    }},documentAccuracy:{status:'answer_key_match',mismatches:[]},
    arithmetic:{status:'arithmetic_consistent',checks:[{path:'total',printed:'150.00',
      calculated:'150.00',delta:'0.00',matches:true}],issues:[]},
    completeness:{status:'manifest_match',uniqueReceived:1,expectedCount:1},
    accountingProposal:{status:'suggested_human_review_required',policyLabel:'DEMO ONLY',issues:[],
      entries:[{side:'debit',accountId:'expense:unclassified',amount:'150.00',currency:'USD',basis:'Review.'}]},
    controls:{resultAccess:'authenticated_local_service_only'},
  };
  const html=renderInspectableResult(result);
  assert.match(html,/NORTHSTAR DEMO SUPPLIES/);
  assert.match(html,/Line items/);
  assert.match(html,/Calculation checks/);
  assert.match(html,/Step 3 · Accounting/);
  assert.match(html,/Suggested debit \/ credit entries/);
  assert.match(html,/Step 4 · Reconciliation/);
  assert.match(html,/Source evidence/);
  assert.match(html,/Raw JSON result/);
  assert.match(html,/&quot;schemaVersion&quot;|&quot;decision&quot;/);
});
