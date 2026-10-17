import test from 'node:test';import assert from 'node:assert/strict';
const handlers={},root={innerHTML:'',addEventListener(k,f){handlers[k]=f},querySelector(){return {focus(){}}}},toast={style:{}};
const memory={value:null,getItem(){return this.value},setItem(k,v){this.value=v}};
globalThis.document={querySelector(s){return s==='#app'?root:toast}};globalThis.localStorage=memory;globalThis.window={scrollTo(){}};globalThis.confirm=()=>true;
await import('../app.js');const click=async dataset=>handlers.click({target:{closest(){return {dataset}}}});const change=async(dataset,value)=>handlers.change({target:{dataset,value}});
test('화면 1 시작 화면에서 두 게임 제공',()=>{assert.match(root.innerHTML,/일반 게임/);assert.match(root.innerHTML,/후세인 게임/);});
test('화면 2 후세인 생성·초기 순위 교환·중복 방지',async()=>{await click({act:'new-hussein'});await change({playerRank:'0'},'2');const r=JSON.parse(memory.value).rounds[0];assert.deepEqual(r.initial,[2,1,0,3]);assert.match(root.innerHTML,/18홀 Par 설정/);});
test('화면 3 입력 즉시 저장·결과·현재 후세인 강조',async()=>{await click({act:'play'});assert.match(root.innerHTML,/현재 후세인/);assert.doesNotMatch(root.innerHTML,/✓ 승리|<strong>다음 홀 후세인:/);for(const [i,s] of [3,4,6,7].entries())handlers.input({target:{dataset:{score:String(i)},value:String(s),setCustomValidity(){},reportValidity(){}}});assert.match(root.innerHTML,/후세인 승/);assert.match(root.innerHTML,/score current-hussein/);assert.deepEqual(JSON.parse(memory.value).rounds[0].holes[0].scores,[3,4,6,7]);});
test('화면 4 후불 완료 내역 변경 후 재정산 표시',async()=>{await click({view:'settlement'});await click({settled:'1'});await click({view:'score'});await change({score:'1'},'5');await click({view:'settlement'});assert.match(root.innerHTML,/재정산이 필요합니다/);});
test('화면 5 복제 시 지급 및 완료 기록 제거',async()=>{const id=JSON.parse(memory.value).rounds[0].id;await click({act:'home'});await click({act:'duplicate',id});const data=JSON.parse(memory.value).rounds;assert.equal(data.length,2);assert.ok(data[0].settled.every(x=>x===null));assert.notEqual(data[0].id,data[1].id);});
test('화면 6 확인 후 초기화·목록 이어하기',async()=>{await click({act:'reset'});let data=JSON.parse(memory.value).rounds;assert.ok(data[0].holes.every(h=>h.scores.every(x=>x===null)));await click({act:'home'});await click({act:'open',id:data[1].id});assert.match(root.innerHTML,/후세인 승|연합군 승/);});

test('화면 7 현재·다음 후세인 구분 및 미완료·무승부·연합군 승리 표시',async()=>{
 await click({act:'new-hussein'});await click({act:'play'});
 for(const [i,s] of [6,1,2,3].entries())await change({score:String(i)},String(s));
 assert.match(root.innerHTML,/<strong>선수 2<\/strong><span class="badge hussein-badge">현재 후세인/);
 assert.match(root.innerHTML,/<strong>다음 홀 후세인: 선수 3/);
 assert.equal((root.innerHTML.match(/✓ 승리/g)||[]).length,1);
 assert.match(root.innerHTML,/이번 홀 3점 · 300,000 VND/);
 await change({score:'3'},'');assert.doesNotMatch(root.innerHTML,/✓ 승리|<strong>다음 홀 후세인:/);
 assert.match(root.innerHTML,/현재 후세인/);
 for(let i=0;i<4;i++)await change({score:String(i)},'4');
 assert.match(root.innerHTML,/무승부 · 다음 홀로 이월/);assert.doesNotMatch(root.innerHTML,/✓ 승리/);
 await click({act:'next'});
 for(const [i,s] of [3,5,6,7].entries())await change({score:String(i)},String(s));
 assert.match(root.innerHTML,/연합군 승/);assert.equal((root.innerHTML.match(/✓ 승리/g)||[]).length,3);
 assert.equal((root.innerHTML.match(/이번 홀 2점 · 200,000 VND/g)||[]).length,3);
});

test('PAR 버튼으로 여러 선수 입력·확장·미입력·다시 불러오기',async()=>{
 for(const mode of ['normal','hussein']){
  await click({act:'new-'+mode});await click({act:'play'});
  assert.match(root.innerHTML,/PAR 4/);
  for(let i=0;i<4;i++)await click({relative:String(i),value:'0'});
  let round=JSON.parse(memory.value).rounds[0];assert.deepEqual(round.holes[0].scores,[4,4,4,4]);
  await click({relative:'0',value:'-3'});await click({relative:'1',value:'4'});
  round=JSON.parse(memory.value).rounds[0];assert.deepEqual(round.holes[0].scores,[1,8,4,4]);
  await click({relative:'0',value:''});assert.equal(JSON.parse(memory.value).rounds[0].holes[0].scores[0],null);
  await click({view:'summary'});assert.match(root.innerHTML,/OUT/);assert.match(root.innerHTML,/IN/);assert.match(root.innerHTML,/TOTAL/);
 }
});
test('PAR 5 더블파 확장 입력은 10타로 저장된다',async()=>{
 for(const mode of ['normal','hussein']){
  await click({act:'new-'+mode});await change({par:'0'},'5');await click({act:'play'});
  assert.match(root.innerHTML,/\+5 \(더블파\)/);
  await click({relative:'0',value:'5'});
  assert.equal(JSON.parse(memory.value).rounds[0].holes[0].scores[0],10);
  await click({view:'summary'});assert.match(root.innerHTML,/OUT \+5 · IN — · TOTAL \+5/);
 }
});
