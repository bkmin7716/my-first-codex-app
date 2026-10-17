import test from 'node:test';
import assert from 'node:assert/strict';
import {createRound,calculate,relativeTotals,relativeText,scoreButtons,validateRound} from '../engine.js';
test('PAR 입력은 실제 타수를 유지하며 미입력과 파를 구분한다',()=>{
 const r=createRound('hussein');
 assert.deepEqual(relativeTotals(r,0),{out:null,in:null,total:null});
 r.holes[0].scores=[4,3,5,6];
 assert.equal(relativeTotals(r,0).out,0);
 assert.equal(relativeText(0),'0'); assert.equal(relativeText(null),'—');
 assert.equal(calculate(r).holes[0].winner,'A');
 const before=JSON.stringify(r);relativeTotals(r,0);scoreButtons(4,4,0);assert.equal(JSON.stringify(r),before);
 r.holes[9].scores[0]=7;
 assert.deepEqual(relativeTotals(r,0),{out:0,in:3,total:3});validateRound(r);
});
test('확장 입력과 잠금은 실제 타수 1~30 범위를 보존한다',()=>{
 for(const par of [3,4,5]){
  const html=scoreButtons(par,null,0,true,true);
  assert.match(html,/미입력/);assert.match(html,/data-value="0"/);
  for(const value of [-1,0,1,2,3,4])assert.match(html.split("<details>")[0],new RegExp(`data-value="${value}"`));
  assert.match(html,new RegExp(`data-value="${1-par}"`));
  assert.doesNotMatch(html,/data-value="(?:5|6|7|8|9|[12][0-9])"/);
  assert.equal((html.match(/<button /g)||[]).length,(html.match(/disabled/g)||[]).length);
 }
});
