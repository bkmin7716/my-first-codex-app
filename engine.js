export const BASE_POINTS=14, DEPOSIT=1400000;
export function validateRound(r){
 if(!r || !['normal','hussein'].includes(r.mode))throw Error('게임 종류가 올바르지 않습니다.');
 const n=r.players?.length;
 if(!n||n>4||(r.mode==='hussein'&&n!==4))throw Error('참가자 수를 확인하세요.');
 if(r.players.some(x=>typeof x!=='string'||!x.trim()||x.length>40))throw Error('선수 이름은 1~40자로 입력하세요.');
 if(!Array.isArray(r.holes)||r.holes.length!==18)throw Error('18홀 데이터가 필요합니다.');
 if(!Number.isSafeInteger(r.rate)||r.rate<1||r.rate>10000000)throw Error('1점당 금액을 확인하세요.');
 if(r.mode==='hussein'&&(!Array.isArray(r.initial)||r.initial.length!==4||new Set(r.initial).size!==4||r.initial.some(x=>!Number.isInteger(x)||x<0||x>3)))throw Error('초기 순위는 중복 없이 지정하세요.');
 if(!['pre','post'].includes(r.payment))throw Error('정산 방식을 확인하세요.');
 for(const h of r.holes){
  if(![3,4,5].includes(h.par)||!Array.isArray(h.scores)||h.scores.length!==n)throw Error('홀 설정이 올바르지 않습니다.');
  if(h.scores.some(x=>x!==null&&(!Number.isInteger(x)||x<1||x>30)))throw Error('타수는 1~30 정수로 입력하세요.');
  if(h.near!==null&&(h.par!==3||!Number.isInteger(h.near)||h.near<0||h.near>=n))throw Error('Near는 Par 3에서 한 명만 선택하세요.');
  if(h.paid!==null&&h.paid!==undefined&&(!Array.isArray(h.paid)||h.paid.length!==n||h.paid.some(x=>!Number.isSafeInteger(x)||x<0||x>1e10)))throw Error('지급 기록이 올바르지 않습니다.');
 }
 if(r.settled&&(!Array.isArray(r.settled)||r.settled.length!==n||r.settled.some(x=>x!==null&&(!Number.isSafeInteger(x)||Math.abs(x)>1e10))))throw Error('정산 완료 기록이 올바르지 않습니다.');
 if(r.cash && (!Array.isArray(r.cash)||r.cash.some(x=>!['collect','refund'].includes(x.type)||!Number.isSafeInteger(x.amount)||x.amount<1||x.amount>1e10)))throw Error('수금·환급 기록이 올바르지 않습니다.');
 return r;
}
export function createRound(mode,n=4){return {id:globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random()}`,mode,date:new Date().toLocaleDateString('en-CA'),course:'',players:Array.from({length:mode==='hussein'?4:n},(_,i)=>`선수 ${i+1}`),initial:[0,1,2,3],payment:'post',rate:100000,holes:Array.from({length:18},(_,i)=>({par:[4,4,3,5,4,4,3,5,4][i%9],scores:Array(mode==='hussein'?4:n).fill(null),near:null,paid:null})),cash:[],settled:Array(mode==='hussein'?4:n).fill(null),current:0,finished:false};}
export function settle(points,rate){const amounts=points.map(p=>(p-BASE_POINTS)*rate);const collect=-amounts.filter(x=>x<0).reduce((a,b)=>a+b,0), payout=amounts.filter(x=>x>0).reduce((a,b)=>a+b,0);return {amounts,collect,payout,difference:payout-collect};}
export function calculate(r){
 validateRound(r);const n=r.players.length,points=Array(n).fill(0),second=Array(n).fill(0);let order=[...r.initial],carry=0,blocked=false;
 const holes=r.holes.map(h=>{
  const complete=h.scores.every(x=>x!==null);const earned=Array(n).fill(0);let winner=null,rank=null,pot=0,comparisonPlayers=null,allianceAverage=null;
  // Freeze the teams before sorting this hole. A missing earlier hole blocks future teams.
  const previousRank=r.mode==='hussein'&&!blocked?[...order]:null;
  const hussein=previousRank?.[1]??null, allies=previousRank?[previousRank[0],previousRank[2],previousRank[3]]:null;
  const carryIn=carry;
  if(r.mode==='hussein'){
   if(!complete)blocked=true;
   if(!blocked){rank=[...order].sort((a,b)=>h.scores[a]-h.scores[b]||order.indexOf(a)-order.indexOf(b));order=rank;second[rank[1]]++;pot=carry+3;
    comparisonPlayers=rank.filter(i=>i!==hussein).slice(0,2);
    const allianceTotal=comparisonPlayers.reduce((sum,i)=>sum+h.scores[i],0);
    allianceAverage=allianceTotal/2;
    const comparison=2*h.scores[hussein]-allianceTotal;
    winner=comparison<0?'A':comparison>0?'B':'tie';
    if(winner==='tie')carry=pot;
    else {if(winner==='A')earned[hussein]=pot;else allies.forEach(i=>earned[i]=pot/3);carry=0;}
    if(h.par===3&&h.near!==null)earned[h.near]++;
    earned.forEach((p,i)=>points[i]+=p);
   }
  }
  const expected=earned.map(p=>p*r.rate), paid=h.paid||Array(n).fill(0),stale=!!h.paid&&expected.some((x,i)=>x!==paid[i]);
  return {complete,previousRank,hussein,allies,comparisonPlayers,allianceAverage,carryIn,rank,winner,earned,pot,carry,expected,paid,stale,confirmed:r.mode==='normal'?complete:!!rank};
 });
 const totals=r.players.map((_,i)=>{const sum=(a,b)=>r.holes.slice(a,b).reduce((s,h)=>s+(h.scores[i]??0),0);const played=r.holes.filter(h=>h.scores[i]!==null);return {front:sum(0,9),back:sum(9,18),total:sum(0,18),played:played.length,relative:played.reduce((s,h)=>s+h.scores[i]-h.par,0)};});
 const expected=holes.reduce((s,h)=>s+h.expected.reduce((a,b)=>a+b,0),0),actual=holes.reduce((s,h)=>s+h.paid.reduce((a,b)=>a+b,0),0);
 const collected=(r.cash||[]).filter(x=>x.type==='collect').reduce((s,x)=>s+x.amount,0),refunded=(r.cash||[]).filter(x=>x.type==='refund').reduce((s,x)=>s+x.amount,0),fund=DEPOSIT*4+collected-refunded;
 return {holes,points,second,totals,carry,post:settle(points,r.rate),pre:{fund,expected,actual,unpaid:holes.reduce((s,h)=>s+h.expected.reduce((a,b,i)=>a+Math.max(0,b-h.paid[i]),0),0),balance:Math.max(0,fund-actual),shortage:Math.max(0,expected-fund),carryAmount:carry*r.rate,received:r.players.map((_,i)=>holes.reduce((s,h)=>s+h.paid[i],0))},complete:holes.every(h=>h.confirmed)};
}
