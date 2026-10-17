import test from 'node:test';import assert from 'node:assert/strict';
import {createRound,calculate,validateRound,settle} from '../engine.js';import {save,load,parseBackup} from '../storage.js';import {readFileSync,existsSync} from 'node:fs';
const make=(scores,par=4,near=null)=>{const r=createRound('hussein');scores.forEach((s,i)=>{r.holes[i].scores=s;r.holes[i].par=par;r.holes[i].near=near;});return r;};
const calc=(s,p=4,n=null)=>calculate(make(s,p,n));
test('01 초기 순위 중복 및 잘못된 순위 방지',()=>{const r=make([]);r.initial=[0,0,2,3];assert.throws(()=>validateRound(r));r.initial=[3,2,1,0];assert.doesNotThrow(()=>validateRound(r));});
test('02 첫 홀 동타 초기 순위 적용',()=>{const r=make([[4,4,5,6]]);r.initial=[1,0,2,3];assert.deepEqual(calculate(r).holes[0].rank,[1,0,2,3]);});
test('03 이후 홀 동타 직전 순위 적용',()=>assert.deepEqual(calc([[6,3,4,5],[4,4,4,5]]).holes[1].rank,[1,2,0,3]));
test('04 모두 동타 순위 유지',()=>assert.deepEqual(calc([[6,3,4,5],[4,4,4,4]]).holes[1].rank,[1,2,3,0]));
test('05 2등 자동 결정 및 미완료 확정 금지',()=>{assert.equal(calc([[3,5,4,6]]).holes[0].rank[1],2);assert.equal(calc([[3,null,4,6],[4,4,4,4]]).holes[1].rank,null);});
test('06 A팀 승리 3점',()=>assert.deepEqual(calc([[3,4,6,7]]).points,[0,3,0,0]));
test('07 B팀 승리 각 1점 · 4등 포함',()=>assert.deepEqual(calc([[3,5,6,30]]).points,[1,0,1,1]));
test('08 같은 비교 타수 무승부',()=>{const c=calc([[3,4,5,6]]);assert.equal(c.holes[0].winner,'tie');assert.equal(c.carry,3);assert.equal(sum(c.points),0);});
const sum=a=>a.reduce((x,y)=>x+y,0);
test('09 1홀 이월 6점',()=>assert.equal(calc([[4,4,4,4],[3,4,6,7]]).points[1],6));
test('10 2홀 이월 9점',()=>assert.equal(calc([[4,4,4,4],[3,4,5,6],[3,4,6,7]]).points[1],9));
test('11 이월 B팀 동일 분배',()=>assert.deepEqual(calc([[4,4,4,4],[3,5,6,7]]).points,[2,0,2,2]));
test('12 Par3 Near 별도 1점',()=>assert.deepEqual(calc([[3,4,6,7]],3,0).points,[1,3,0,0]));
test('13 무승부 Near 정상 지급·이월 제외',()=>{const c=calc([[3,4,5,6]],3,2);assert.deepEqual(c.points,[0,0,1,0]);assert.equal(c.carry,3);});
test('14 Par4·5 Near 불가',()=>{for(const par of [4,5])assert.throws(()=>calc([[3,4,5,6]],par,0));});
test('15 18홀 잔여 이월 미지급',()=>{const c=calc(Array(18).fill([4,4,4,4]));assert.equal(c.carry,54);assert.equal(c.pre.carryAmount,5400000);assert.equal(sum(c.points),0);});
test('16 과거 홀 수정 후 순위·이월 전부 재계산',()=>{const r=make([[3,4,5,6],[4,4,4,4],[3,4,6,7]]);assert.equal(calculate(r).points[1],9);r.holes[0].scores=[7,3,4,6];const c=calculate(r);assert.deepEqual(c.holes[1].rank,[1,2,3,0]);assert.equal(sum(c.points),9);assert.equal(c.holes[2].pot,6);});
test('17 13점 -100000',()=>assert.equal(settle([13],100000).amounts[0],-100000));
test('18 16점 +200000',()=>assert.equal(settle([16],100000).amounts[0],200000));
test('19 선불 공동 자금 5600000 단가와 독립',()=>{const r=make([]);r.rate=200000;assert.equal(calculate(r).pre.fund,5600000);});
test('20 잔액·부족액 및 수금·환급',()=>{const r=make(Array(18).fill([3,4,6,7]),3,0);let c=calculate(r);assert.equal(c.pre.shortage,1600000);assert.equal(c.pre.balance,5600000);r.holes.forEach((h,i)=>h.paid=[...c.holes[i].expected]);assert.equal(calculate(r).pre.balance,0);r.cash=[{type:'collect',amount:2000000},{type:'refund',amount:100000}];assert.equal(calculate(r).pre.balance,300000);});
test('21 차액 기준14점 유지',()=>{assert.equal(settle([16,14,14,14],100000).difference,200000);assert.equal(settle([13,14,14,14],100000).difference,-100000);});
const memory=()=>({value:null,getItem(){return this.value},setItem(k,v){this.value=v}});
test('22 새 세션 로드 시 데이터 유지',()=>{const s=memory(),r=make([[3,4,6,7]]);save(s,[r]);assert.deepEqual(load(s),[r]);});
test('23 여러 라운드 개별 불러오기 및 JSON 검증',()=>{const s=memory(),a=make([]),b=createRound('normal',2);save(s,[a,b]);assert.equal(load(s).find(x=>x.id===b.id).players.length,2);assert.throws(()=>parseBackup('{"version":9,"rounds":[]}'));assert.throws(()=>parseBackup(JSON.stringify({version:1,rounds:[a,a]})));});
test('24 모바일 기본 구조 정적 검사 (브라우저 검증 아님)',()=>{const html=readFileSync(new URL('../index.html',import.meta.url),'utf8'),css=readFileSync(new URL('../style.css',import.meta.url),'utf8');assert.match(html,/width=device-width/);assert.match(html,/lang="ko"/);assert.match(css,/safe-area-inset-bottom/);assert.match(css,/@media\(max-width:380px\)/);});
test('25 이미 지급한 홀 수정 시 지급 기록 보존 및 재정산 경고',()=>{const r=make([[3,4,6,7]]);r.holes[0].paid=calculate(r).holes[0].expected;r.holes[0].scores=[3,5,6,7];const c=calculate(r);assert.deepEqual(c.holes[0].paid,[0,300000,0,0]);assert.equal(c.holes[0].stale,true);});
test('26 단가 변경·Near 변경에 따른 지급 예정 재계산',()=>{const r=make([[3,4,6,7]],3,0);r.rate=200000;assert.equal(calculate(r).pre.expected,800000);r.holes[0].near=2;assert.deepEqual(calculate(r).points,[0,3,1,0]);});
test('27 일반 1~4명 전·후반 타수 및 입력홀 Par 대비',()=>{for(let n=1;n<=4;n++){const r=createRound('normal',n);r.holes[0].scores=Array(n).fill(5);r.holes[9].scores=Array(n).fill(3);const t=calculate(r).totals[0];assert.deepEqual(t,{front:5,back:3,total:8,played:2,relative:0});}});
test('28 입력 오류·이후 미완료 지급 재정산 표시',()=>{assert.throws(()=>calc([[0,4,5,6]]));assert.throws(()=>calc([[3.2,4,5,6]]));const r=make([[3,4,6,7],[3,4,6,7]]);r.holes[1].paid=calculate(r).holes[1].expected;r.holes[0].scores[0]=null;assert.equal(calculate(r).holes[1].stale,true);});
test('29 오프라인 자산 누락 없음·상대 경로 Pages 지원',()=>{const sw=readFileSync(new URL('../sw.js',import.meta.url),'utf8');for(const asset of ['index.html','app.js','engine.js','storage.js','style.css','manifest.webmanifest','icon-192.png','icon-512.png']){assert.ok(existsSync(new URL('../'+asset,import.meta.url)));assert.ok(sw.includes(asset));}});

test('30 첫 홀 팀은 초기 순위, 현재 홀 최종 순위와 구분',()=>{
 const r=make([[3,4,6,7]]);r.initial=[3,2,1,0];
 const x=calculate(r).holes[0];
 assert.deepEqual(x.previousRank,[3,2,1,0]);assert.equal(x.hussein,2);
 assert.deepEqual(x.allies,[3,1,0]);assert.deepEqual(x.rank,[0,1,2,3]);
 assert.equal(x.winner,'B');assert.deepEqual(x.earned,[1,1,0,1]);
 assert.deepEqual(x.expected,[100000,100000,0,100000]);
});
test('31 입력 전·도중·완료 후 현재 팀 고정, 다음 홀은 직전 최종 순위 사용',()=>{
 const r=make([[6,3,4,5]]);
 for(const scores of [[null,null,null,null],[3,8,null,null],[3,8,2,6]]){
  r.holes[1].scores=scores;const x=calculate(r).holes[1];
  assert.deepEqual(x.previousRank,[1,2,3,0]);assert.equal(x.hussein,2);
  assert.deepEqual(x.allies,[1,3,0]);
  if(scores.includes(null)){assert.equal(x.winner,null);assert.equal(x.rank,null);assert.deepEqual(x.earned,[0,0,0,0]);}
 }
 const c=calculate(r);assert.equal(c.holes[1].winner,'A');
 assert.deepEqual(c.holes[1].earned,[0,0,3,0]);assert.equal(c.holes[1].rank[1],0);
 assert.equal(c.holes[2].hussein,0);assert.equal(c.holes[2].winner,null);
});
test('32 이전 홀 수정 시 팀·승패·이월·정산 순차 재계산, 실제 기록 보존',()=>{
 const r=make([[6,3,4,5],[3,8,2,6],[4,4,4,4]]);r.rate=200000;
 const before=calculate(r);assert.deepEqual(before.points,[0,3,3,0]);
 r.holes[1].paid=[...before.holes[1].expected];r.settled=[...before.post.amounts];
 const actual=structuredClone(r);r.holes[0].scores=[3,4,5,6];
 const c=calculate(r);assert.equal(c.holes[0].winner,'tie');
 assert.equal(c.holes[1].hussein,1);assert.deepEqual(c.holes[1].allies,[0,2,3]);
 assert.equal(c.holes[1].winner,'B');assert.equal(c.holes[1].pot,6);
 assert.deepEqual(c.points,[2,0,2,2]);assert.equal(c.carry,3);
 assert.deepEqual(c.holes[1].expected,[400000,0,400000,400000]);
 assert.deepEqual(c.post.amounts,[-2400000,-2800000,-2400000,-2400000]);
 assert.equal(c.holes[1].stale,true);assert.deepEqual(r.holes[1].paid,actual.holes[1].paid);
 assert.deepEqual(r.settled,actual.settled);
 r.holes[0].scores[0]=null;const blocked=calculate(r);
 assert.equal(blocked.holes[1].previousRank,null);assert.equal(blocked.holes[1].hussein,null);
 assert.equal(blocked.holes[1].rank,null);assert.equal(blocked.holes[1].winner,null);
});
test('33 현재 홀 1등인 후세인도 승리 3점, Near와 승패 분리',()=>{
 const c=calc([[6,1,2,3]],3,3),x=c.holes[0];
 assert.equal(x.hussein,1);assert.equal(x.rank[0],1);assert.equal(x.winner,'A');
 assert.deepEqual(x.earned,[0,3,0,1]);assert.equal(x.rank[1],2);
});


test('34 current-hole best two allies determine outcome, not previous-rank first and third',()=>{
 const c=calc([[3,5,9,4]]),x=c.holes[0];
 assert.equal(x.hussein,1);assert.deepEqual(x.comparisonPlayers,[0,3]);
 assert.equal(x.allianceAverage,3.5);assert.equal(x.winner,'B');
 assert.deepEqual(x.earned,[1,0,1,1]);assert.deepEqual(x.expected,[100000,0,100000,100000]);
});
test('35 consecutive draws change next Hussein using current rank, retain carry multiplier and Near',()=>{
 const c=calc([[8,4,4,4],[4,8,4,4],[5,6,7,3]],3,0);
 assert.deepEqual(c.holes.slice(0,3).map(x=>x.hussein),[1,2,3]);
 assert.deepEqual(c.holes.slice(0,3).map(x=>x.winner),['tie','tie','A']);
 assert.deepEqual(c.holes.slice(0,3).map(x=>x.pot),[3,6,9]);
 assert.deepEqual(c.holes[0].rank,[1,2,3,0]);assert.deepEqual(c.holes[1].rank,[2,3,0,1]);
 assert.deepEqual(c.points,[3,0,0,9]);assert.equal(c.carry,0);
 assert.deepEqual(c.holes[2].expected,[100000,0,0,900000]);
 assert.deepEqual(c.post.amounts,[-1100000,-1400000,-1400000,-500000]);
});
test('36 initial and previous rank break tied ally scores consistently',()=>{
 const r=make([[5,5,5,8],[4,4,4,4]]);r.initial=[2,1,0,3];
 const c=calculate(r);assert.deepEqual(c.holes[0].comparisonPlayers,[2,0]);
 assert.deepEqual(c.holes[0].rank,[2,1,0,3]);assert.deepEqual(c.holes[1].rank,[2,1,0,3]);
 assert.equal(c.holes[0].winner,'tie');assert.equal(c.holes[1].winner,'tie');
});
test('37 reloaded saved/finalized round recalculates amounts without changing any stored records',()=>{
 const r=make([[3,5,9,4]],3,2);r.holes[0].paid=[0,300000,100000,0];
 r.settled=[-1400000,-1100000,-1300000,-1400000];r.finished=true;
 r.locked_holes=[0];r.finalized=true;r.revision=7;
 const saved=JSON.stringify(r),loaded=JSON.parse(saved),c=calculate(loaded);
 assert.equal(c.holes[0].winner,'B');assert.deepEqual(c.points,[1,0,2,1]);
 assert.deepEqual(c.holes[0].expected,[100000,0,200000,100000]);
 assert.equal(c.holes[0].stale,true);assert.equal(c.pre.actual,400000);
 assert.deepEqual(c.post.amounts,[-1300000,-1400000,-1200000,-1300000]);
 assert.equal(JSON.stringify(loaded),saved);
});
