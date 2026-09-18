import {readFile} from 'node:fs/promises';
import {reviewInvoice} from '../src/reconcile.ts';
import {checkCompleteness, businessReference} from '../src/completeness.ts';
const invoice=JSON.parse(await readFile(new URL('../fixtures/simple-pre-extracted.json', import.meta.url),'utf8'));
const altered=structuredClone(invoice); altered.total='151.00';
console.log(JSON.stringify({
  mode:'OFFLINE: handwritten pre-extracted JSON; NO email or AI integration',
  correctArithmetic:reviewInvoice(invoice),
  incorrectTotal:reviewInvoice(altered),
  incompleteBatch:checkCompleteness({expectedCount:3,expectedManifest:null,unresolvedDocuments:0,received:[
    {canonicalId:'demo-1',businessReference:businessReference('vendor-1','001')},
    {canonicalId:'demo-2',businessReference:businessReference('vendor-2','002')},
    {canonicalId:'demo-1',businessReference:businessReference('vendor-1','001')},
  ]})
},null,2));
