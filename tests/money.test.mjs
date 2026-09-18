import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseUnits,formatUnits,sumAmounts,lineExtension} from '../src/money.ts';

test('M-001 decimal addition has no floating-point artifacts',()=>assert.equal(sumAmounts(['0.10','0.20'],2),'0.30'));
test('M-002 zero-decimal precision is explicit',()=>assert.equal(sumAmounts(['100','23'],0),'123'));
test('M-003 three-decimal precision is explicit',()=>assert.equal(sumAmounts(['1.001','0.002'],3),'1.003'));
test('M-004 signed exact sums',()=>assert.equal(sumAmounts(['100.00','-20.01'],2),'79.99'));
test('M-005 negative zero is normalized',()=>assert.equal(formatUnits(parseUnits('-0.00',2),2),'0.00'));
test('M-006 harmless trailing zeros fit declared precision',()=>assert.equal(parseUnits('1.2300',2),123n));
test('M-007 printed fractional cents are not silently rounded',()=>assert.throws(()=>parseUnits('1.001',2)));
test('M-008 positive half rounds away from zero',()=>assert.equal(lineExtension('1','0.005',2),'0.01'));
test('M-009 negative half rounds away from zero',()=>assert.equal(lineExtension('-1','0.005',2),'-0.01'));
test('M-010 fractional quantities and high-precision prices',()=>assert.equal(lineExtension('1.5','2.345',2),'3.52'));
test('M-011 below-half rounding',()=>assert.equal(lineExtension('1','0.004999',2),'0.00'));
test('M-012 negative times negative',()=>assert.equal(lineExtension('-2','-10.50',2),'21.00'));
test('M-013 large exact supported inputs',()=>assert.equal(sumAmounts(['999999999999.99','0.01'],2),'1000000000000.00'));
test('M-014 all supported scales round-trip',()=>{for(let s=0;s<=6;s++)assert.equal(parseUnits(formatUnits(-12345n,s),s),-12345n);});
test('M-015 invalid scales never coerce',()=>{for(const s of [-1,7,1.5,NaN,Infinity,'2',null])assert.throws(()=>parseUnits('1',s));});
for(const [i,value] of [null,undefined,'',0,12.34,'NaN','Infinity','1e3',' 1.00','1.00 ','1,000.00','1.000,00','+1','01.00','.50','1.','0x10','9999999999999','1.1234567',{},'١٢'].entries()){
  test(`M-invalid-${i+1} malformed/out-of-contract decimal is rejected`,()=>assert.throws(()=>parseUnits(value,2)));
}
test('M-oracle 1000 seeded cases checked against independent Python Decimal oracle',t=>{
  const fixture=JSON.parse(readFileSync(new URL('../fixtures/arithmetic-oracle.json',import.meta.url),'utf8'));
  assert.equal(fixture.caseCount,1000);assert.equal(fixture.cases.length,1000);
  let completed=0;
  try{
    for(const c of fixture.cases){
      assert.equal(lineExtension(c.quantity,c.unitPrice,c.minorUnits),c.expected,`oracle case ${c.id}`);
      completed++;
    }
  }finally{t.diagnostic(`generated_arithmetic_cases_completed=${completed}`);}
});
