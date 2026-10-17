import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {PGlite} from "@electric-sql/pglite";
import {createRound,calculate} from "../engine.js";
const db=new PGlite();
await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;create publication supabase_realtime;`);
await db.exec(readFileSync(new URL('./fixtures/legacy-schema.sql',import.meta.url),'utf8'));
const migration=readFileSync(new URL('../supabase/001-player-slots.sql',import.meta.url),'utf8');
await db.exec(migration);await db.exec(migration);
const users=Array.from({length:5},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`);
for(const id of users)await db.query('insert into auth.users values ($1)',[id]);
async function as(i,sql,args=[]){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[i==null?'':users[i]]);await db.exec('set role authenticated');return db.query(sql,args);}
async function rpc(i,name,args){return (await as(i,`select to_jsonb(public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})) g`,args)).rows[0].g;}
async function mutate(i,g,action,detail,rev=g.revision){return rpc(i,'golf_mutate',[g.id,rev,action,detail]);}
async function snapshot(){await db.exec('reset role');return JSON.stringify((await db.query(`select
(select jsonb_agg(to_jsonb(g) order by id) from public.golf_games g) games,
(select jsonb_agg(to_jsonb(m) order by game_id,user_id) from public.golf_members m) members,
(select jsonb_agg(to_jsonb(a) order by id) from public.golf_audit a) audit`)).rows);}
function rosterRound(){const r=createRound('hussein');r.sharedSlots=true;r.slotPolicyVersion=1;r.gamePolicyVersion=1;r.players=['민수','영희','철수','수진'];r.initial=[3,1,0,2];r.holes[0].par=3;return r;}
async function legacyGame(r){
 await db.exec('reset role');
 const g=(await db.query('insert into public.golf_games(owner_id,round) values($1,$2) returning *',[users[0],r])).rows[0];
 await db.query('insert into public.golf_members(game_id,user_id,name) values($1,$2,$3)',[g.id,users[0],'생성자']);
 return g;
}
async function connectAll(g){for(let i=1;i<4;i++)g=await rpc(i,'golf_join',[g.code,`계정${i}`]);for(let i=0;i<4;i++)g=await mutate(i,g,'slot',{value:[3,1,2,0][i]});return g;}

test('owner roster preserved at create/join/claim; reconnect identity; competing claim is atomic',async()=>{
 const r=rosterRound();r.holes[0].scores=[3,4,5,6];r.holes[0].paid=[1,2,3,4];r.settled=[10,20,30,40];
 let g=await rpc(0,'golf_create',[r,'생성자 계정']);assert.deepEqual(g.round,r);
 assert.equal((await as(0,'select slot from public.golf_members where game_id=$1',[g.id])).rows[0].slot,null);
 g=await rpc(1,'golf_join',[g.code,'계정1']);assert.deepEqual(g.round,r);
 await assert.rejects(()=>mutate(1,g,'player_name',{player:0,value:'탈취 이름'}),/생성자/);
 await assert.rejects(()=>mutate(1,g,'initial',{value:[0,1,2,3]}),/생성자/);
 g=await mutate(0,g,'slot',{value:2});const rev=g.revision;
 g=await mutate(1,g,'slot',{value:1});assert.deepEqual(g.round,r);
 const before=await snapshot();
 await assert.rejects(()=>mutate(0,g,'slot',{value:1}),/변경할 수 없습니다/);
 assert.equal(await snapshot(),before);
 g=await rpc(2,'golf_join',[g.code,'계정2']);
 await assert.rejects(()=>mutate(2,g,'slot',{value:1},rev),/다른 참가자/);
 await assert.rejects(()=>mutate(2,g,'slot',{value:1}),/이미 연결/);
 const rejoined=await rpc(1,'golf_join',[g.code,'다른 계정 이름']);assert.equal(rejoined.revision,g.revision);
 const m=(await as(1,'select slot,name from public.golf_members where game_id=$1 and user_id=$2',[g.id,users[1]])).rows[0];assert.equal(m.slot,1);assert.equal(m.name,'계정1');
 g=await mutate(1,g,'name',{value:'계정 표시 수정'});assert.deepEqual(g.round,r);
 const amounts=calculate(g.round).post.amounts;
 g=await mutate(0,g,'player_name',{player:1,value:'선수명 수정'});
 assert.equal(g.round.players[1],'선수명 수정');assert.deepEqual(g.round.holes,r.holes);assert.deepEqual(g.round.settled,r.settled);assert.deepEqual(calculate(g.round).post.amounts,amounts);
});

test('unbound members edit all four scores and Near, and lock without other players connecting',async()=>{
 let g=await rpc(0,'golf_create',[rosterRound(),'생성자']);
 g=await rpc(1,'golf_join',[g.code,'미연결 참가자']);
 for(const actor of [0,1]) {
  for(let player=0;player<4;player++)g=await mutate(actor,g,'score',{hole:0,player,value:player+3+actor});
  for(let player=0;player<4;player++)g=await mutate(actor,g,'near',{hole:0,value:player});
  g=await mutate(actor,g,'lock',{hole:0,value:true});
  assert.deepEqual(g.locked_holes,[0]);
  await assert.rejects(()=>mutate(1,g,'lock',{hole:0,value:false}),/생성자/);
  await assert.rejects(()=>mutate(actor,g,'score',{hole:0,player:1,value:4}),/잠긴 홀/);
  await assert.rejects(()=>mutate(actor,g,'near',{hole:0,value:1}),/잠긴 홀/);
  g=await mutate(0,g,'lock',{hole:0,value:false});
 }
 g=await mutate(0,g,'slot',{value:0});
 // Exact reported case: owner bound to first player; three others unbound.
 for(let player=0;player<4;player++)g=await mutate(0,g,'score',{hole:0,player,value:player+3});
 g=await mutate(1,g,'near',{hole:0,value:1});
 g=await mutate(1,g,'lock',{hole:0,value:true});
 const members=(await as(0,'select slot from public.golf_members where game_id=$1',[g.id])).rows;
 assert.equal(members.filter(m=>m.slot!=null).length,1);
 assert.deepEqual(g.round.players,rosterRound().players);
 const before=await snapshot();
 await assert.rejects(()=>mutate(2,g,'score',{hole:0,player:1,value:5}),/참가자/);
 for(const [a,d] of [['player_name',{player:1,value:'탈취'}],['initial',{value:[0,1,2,3]}],['rate',{value:1}],['cash',{value:[]}],['finalize',{value:false}]])await assert.rejects(()=>mutate(1,g,a,d),/생성자/);
 await assert.rejects(()=>mutate(1,g,'slot',{value:0}),/이미 연결/);
 assert.equal(await snapshot(),before);
});

test('shared gameplay without slot prerequisites; original score/Near/money/locks/finalize/audit and RLS preserved',async()=>{
 let g=await rpc(0,'golf_create',[rosterRound(),'계정0']);
 g=await mutate(0,g,'score',{hole:0,player:0,value:4});
 g=await mutate(0,g,'slot',{value:3});
 await assert.rejects(()=>mutate(0,g,'lock',{hole:1,value:true}),/모든 선수/);
 for(let i=1;i<4;i++){g=await rpc(i,'golf_join',[g.code,`계정${i}`]);g=await mutate(i,g,'slot',{value:[3,1,2,0][i]});}
 await assert.rejects(()=>rpc(4,'golf_join',[g.code,'다섯째']),/모두 찼습니다/);
 for(const table of ['golf_games','golf_members','golf_audit'])assert.equal((await as(4,`select * from public.${table} where ${table==='golf_games'?'id':'game_id'}=$1`,[g.id])).rows.length,0);
 await assert.rejects(()=>mutate(4,g,'score',{hole:0,player:0,value:3}),/참가자/);
 await assert.rejects(()=>as(1,'update public.golf_games set finalized=true'),/permission denied/);
 await assert.rejects(()=>as(1,'delete from public.golf_audit'),/permission denied/);
 await assert.rejects(()=>mutate(0,g,'lock',{hole:0,value:true}),/모든 선수/);
 for(let p=0;p<4;p++)g=await mutate(p,g,'score',{hole:0,player:p,value:[3,4,6,7][p]});
 g=await mutate(2,g,'near',{hole:0,value:2});
 g=await mutate(0,g,'paid',{hole:0,value:calculate(g.round).holes[0].expected});
 g=await mutate(0,g,'settled',{player:1,value:100});g=await mutate(0,g,'cash',{value:[{type:'collect',amount:1000}]});
 for(const [a,d] of [['rate',{value:1}],['paid',{hole:0,value:null}],['settled',{player:0,value:0}],['cash',{value:[]}],['finalize',{value:true}]])await assert.rejects(()=>mutate(1,g,a,d),/생성자/);
 g=await mutate(1,g,'lock',{hole:0,value:true});
 await assert.rejects(()=>mutate(0,g,'initial',{value:[0,1,2,3]}),/잠금/);
 await assert.rejects(()=>mutate(0,g,'score',{hole:0,player:0,value:5}),/잠긴 홀/);
 await assert.rejects(()=>mutate(1,g,'lock',{hole:0,value:false}),/생성자/);
 await assert.rejects(()=>mutate(0,g,'rate',{value:200000}),/잠금/);
 g=await mutate(0,g,'lock',{hole:0,value:false});g=await mutate(0,g,'rate',{value:200000});
 const paid=structuredClone(g.round.holes[0].paid);g=await mutate(2,g,'score',{hole:0,player:0,value:8});assert.deepEqual(g.round.holes[0].paid,paid);assert.ok(calculate(g.round).holes[0].stale);
 for(let h=0;h<18;h++){for(let p=0;p<4;p++)g=await mutate(p,g,'score',{hole:h,player:p,value:[3,4,6,7][p]});g=await mutate(1,g,'lock',{hole:h,value:true});}
 g=await mutate(0,g,'finalize',{value:true});
 for(const [a,d] of [['name',{value:'변경'}],['player_name',{player:0,value:'변경'}],['score',{hole:0,player:0,value:4}],['lock',{hole:0,value:false}],['cash',{value:[]}]])await assert.rejects(()=>mutate(0,g,a,d),/최종 확정/);
 g=await mutate(0,g,'finalize',{value:false});
 const last=(await as(0,'select * from public.golf_audit where game_id=$1 order by id desc limit 1',[g.id])).rows[0];assert.equal(last.actor_id,users[0]);assert.equal(last.action,'finalize');assert.equal(last.detail.before,true);assert.equal(last.detail.after,false);
});

test('new normal 1-4 owner alone records and locks; unexpected non-owner membership cannot bypass policy',async()=>{
 for(let n=1;n<=4;n++){const r=createRound('normal',n);let g=await rpc(0,'golf_create',[r,'계정0']);assert.deepEqual(g.round,{...r,gamePolicyVersion:1});
 for(let p=0;p<n;p++)g=await mutate(0,g,'score',{hole:0,player:p,value:4});g=await mutate(0,g,'lock',{hole:0,value:true});assert.deepEqual(g.locked_holes,[0]);
 await assert.rejects(()=>rpc(1,'golf_join',[g.code,'계정1']),/혼자 관리/);
 await db.exec('reset role');await db.query('insert into public.golf_members(game_id,user_id,name) values($1,$2,$3)',[g.id,users[1],'이전 참가자']);
 await assert.rejects(()=>mutate(1,g,'lock',{hole:0,value:false}),/생성자만/);}
});

test('invalid JSON and roster inputs produce P0001 without writes',async()=>{
 const r=rosterRound();
 for(const name of [null,'','   ','x'.repeat(41)])await assert.rejects(()=>rpc(0,'golf_create',[r,name]),e=>e.code==='P0001');
 for(const players of [['','','',''],['A','B','C']])await assert.rejects(()=>rpc(0,'golf_create',[{...r,players},'계정']),e=>e.code==='P0001');
 let g=await connectAll(await rpc(0,'golf_create',[r,'계정0']));
 for(const [a,d] of [['score',[]],['score',null],['score',{hole:'x',player:0,value:3}],['score',{hole:0,player:1.5,value:3}],['score',{hole:0,player:0,value:31}],['near',{hole:0,value:'1'}],['near',{hole:0,value:4}],['near',{hole:0,value:{}}],['near',{hole:1,value:0}],['paid',{hole:0,value:[{},1,2,3]}],['settled',{player:'x',value:0}],['lock',{hole:0,value:'true'}],['rate',{value:{}}],['initial',{value:[0,0,2,3]}],['cash',{value:[{type:'collect',amount:{}}]}]]){
 const before=await snapshot();await assert.rejects(()=>mutate(0,g,a,d),e=>e.code==='P0001');assert.equal(await snapshot(),before);}
 await db.exec('reset role');await db.query("update public.golf_games set round=jsonb_set(round,'{players}','{}') where id=$1",[g.id]);await assert.rejects(()=>mutate(0,g,'slot',{value:1}),e=>e.code==='P0001');
});

test('upgrade preserves all existing rows, membership slots and grants; unique index reused',async()=>{
 await db.exec('reset role');
 // Prior test intentionally seeded invalid data; migration must preserve it too.
 await db.exec('alter index public.golf_member_slot rename to golf_members_game_slot_unique');
 const before=await snapshot();const grants=(await db.query("select oid,proacl,proowner from pg_proc where proname in ('golf_validate','golf_create','golf_join','golf_mutate') order by oid")).rows;
 await db.exec(migration);await db.exec(migration);assert.equal(await snapshot(),before);
 assert.deepEqual((await db.query("select oid,proacl,proowner from pg_proc where proname in ('golf_validate','golf_create','golf_join','golf_mutate') order by oid")).rows,grants);
 assert.equal((await db.query("select count(*)::int n from pg_indexes where schemaname='public' and indexname='golf_member_slot'")).rows[0].n,0);
 await db.exec(readFileSync(new URL('../supabase/001-player-slots-precheck.sql',import.meta.url),'utf8'));assert.equal(await snapshot(),before);
});

test.after(()=>db.close());

test('legacy Hussein sharedSlots missing/null/true preserves member gameplay without slot requirement',async()=>{
 for(const flag of ['missing','null','true']) {
  const r=createRound('hussein');if(flag==='null')r.sharedSlots=null;if(flag==='true')r.sharedSlots=true;
  let g=await legacyGame(r);g=await rpc(1,'golf_join',[g.code,'참가자']);
  assert.deepEqual(g.round,r);
  await assert.rejects(()=>mutate(1,g,'slot',{value:1}),/생성자/);
  for(let p=0;p<4;p++)g=await mutate(1,g,'score',{hole:0,player:p,value:4});
  g=await mutate(1,g,'lock',{hole:0,value:true});assert.deepEqual(g.locked_holes,[0]);
  assert.equal((await as(0,'select count(slot)::int n from public.golf_members where game_id=$1',[g.id])).rows[0].n,0);
  g=await mutate(0,g,'lock',{hole:0,value:false});
  g=await mutate(1,g,'near',{hole:2,value:1});g=await mutate(0,g,'paid',{hole:0,value:[1,2,3,4]});
  g=await mutate(0,g,'settled',{player:1,value:100});g=await mutate(0,g,'cash',{value:[{type:'collect',amount:100}]});g=await mutate(0,g,'rate',{value:200000});
  g=await rpc(1,'golf_join',[g.code,'재접속']);
  for(let h=0;h<18;h++){for(let p=0;p<4;p++)g=await mutate(1,g,'score',{hole:h,player:p,value:4});g=await mutate(1,g,'lock',{hole:h,value:true});}
  g=await mutate(0,g,'finalize',{value:true});assert.equal(g.finalized,true);
  g=await rpc(1,'golf_join',[g.code,'재접속']);assert.equal(g.finalized,true);
  g=await mutate(0,g,'finalize',{value:false});assert.equal(g.finalized,false);
 }
});

test('existing sharedSlots true members with null slots can reconnect and choose without changing roster or finances',async()=>{
 const r=rosterRound();r.holes[0].scores=[3,4,5,6];r.holes[0].paid=[1,2,3,4];r.settled=[10,20,30,40];
 let g=await rpc(0,'golf_create',[r,'생성자']);g=await rpc(1,'golf_join',[g.code,'참가자']);
 const before=structuredClone(g.round);
 g=await rpc(1,'golf_join',[g.code,'재접속']);g=await mutate(1,g,'slot',{value:2});assert.deepEqual(g.round,before);
 g=await rpc(0,'golf_join',[g.code,'생성자']);g=await mutate(0,g,'slot',{value:0});assert.deepEqual(g.round,before);
 const m=(await as(0,'select user_id,slot from public.golf_members where game_id=$1',[g.id])).rows;
 assert.equal(m.find(m=>m.user_id===users[1]).slot,2);assert.equal(m.find(m=>m.user_id===users[0]).slot,0);
});

test('finalized shared game rejects new slot; existing binding and reconnect remain readable',async()=>{
 let g=await rpc(0,'golf_create',[rosterRound(),'기존 생성자']);
 g=await rpc(1,'golf_join',[g.code,'기존 참가자']);g=await mutate(0,g,'slot',{value:1});
 await db.exec('reset role');await db.query("update public.golf_games set finalized=true,locked_holes=array(select generate_series(0,17)) where id=$1",[g.id]);
 g=await rpc(1,'golf_join',[g.code,'기존 참가자']);const before=await snapshot();
 await assert.rejects(()=>mutate(1,g,'slot',{value:2}),/최종 확정/);assert.equal(await snapshot(),before);
 const connected=await rpc(0,'golf_join',[g.code,'기존 생성자']);assert.equal(connected.finalized,true);
 assert.equal((await as(0,'select slot from public.golf_members where game_id=$1 and user_id=$2',[g.id,users[0]])).rows[0].slot,1);
});

test('shared roster duplicate names rejected on create and owner rename, legacy duplicates preserved',async()=>{
 for(const players of [['A','A','C','D'],['A',' A ','C','D']]){
 const before=await snapshot();await assert.rejects(()=>rpc(0,'golf_create',[{...rosterRound(),players},'계정']),/중복/);assert.equal(await snapshot(),before);}
 let g=await rpc(0,'golf_create',[rosterRound(),'생성자']);g=await mutate(0,g,'slot',{value:0});
 const before=await snapshot();await assert.rejects(()=>mutate(0,g,'player_name',{player:1,value:'민수'}),/중복/);assert.equal(await snapshot(),before);
 const r=rosterRound();r.sharedSlots=null;delete r.slotPolicyVersion;delete r.gamePolicyVersion;r.players=['A','A','C','D'];
 const legacy=await legacyGame(r);assert.deepEqual(legacy.round,r);
});


test('server stamps policy only on new shared creation and version cannot be changed via mutate',async()=>{
 const r=createRound('hussein');r.sharedSlots=true;const input=structuredClone(r);
 let g=await rpc(0,'golf_create',[r,'생성자']);assert.equal(g.round.slotPolicyVersion,1);assert.deepEqual(r,input);
 const before=await snapshot();await assert.rejects(()=>mutate(0,g,'slotPolicyVersion',{value:1}),/지원하지/);assert.equal(await snapshot(),before);
 const normal=await rpc(0,'golf_create',[createRound('normal',2),'생성자']);assert.equal(normal.round.slotPolicyVersion,undefined);
});

test('preview normal migration preserves all rows, allows any registered participant to edit without slots',async()=>{
 await db.exec('reset role');const before=await snapshot();
 const patch=readFileSync(new URL('../supabase/003-normal-shared-scorecard.sql',import.meta.url),'utf8');
 const metadata=(await db.query("select oid,proacl,proowner from pg_proc where proname in ('golf_create','golf_join','golf_mutate') order by oid")).rows;
 await db.exec(patch);await db.exec(patch);assert.equal(await snapshot(),before);
 assert.deepEqual((await db.query("select oid,proacl,proowner from pg_proc where proname in ('golf_create','golf_join','golf_mutate') order by oid")).rows,metadata);
 for(let n=1;n<=4;n++){
  let g=await rpc(0,'golf_create',[{...createRound('normal',n),sharedSlots:true,slotPolicyVersion:1},'생성자']);
  assert.equal(g.round.sharedSlots,false);assert.equal(g.round.slotPolicyVersion,undefined);
  for(let actor=1;actor<4;actor++)g=await rpc(actor,'golf_join',[g.code,`참가자${actor}`]);
  const full=await snapshot();
  await assert.rejects(()=>rpc(4,'golf_join',[g.code,'다섯째']),/참가 인원/);assert.equal(await snapshot(),full);
  assert.equal((await rpc(1,'golf_join',[g.code,'재접속'])).revision,g.revision);
  for(let actor=0;actor<4;actor++)for(let p=0;p<n;p++)g=await mutate(actor,g,'score',{hole:17,player:p,value:p+4});
  g=await mutate(1,g,'score',{hole:0,player:0,value:null});
  g=await mutate(2,g,'score',{hole:0,player:0,value:4});
  assert.equal(g.round.holes[17].scores.length,n);
  assert.deepEqual(g.round.holes[17].scores,Array.from({length:n},(_,i)=>i+4));
  assert.equal((await as(0,'select count(slot)::int n from public.golf_members where game_id=$1',[g.id])).rows[0].n,0);
  await assert.rejects(()=>mutate(1,g,'slot',{value:0}),/일반 게임/);
  await assert.rejects(()=>mutate(1,g,'player_name',{player:0,value:'탈취'}),/생성자만/);
  const saved=structuredClone(g.round);
  g=await mutate(0,g,'player_name',{player:0,value:'생성자 수정'});
  const renamed=structuredClone(saved);renamed.players[0]='생성자 수정';assert.deepEqual(g.round,renamed);
  g=await mutate(1,g,'name',{value:'참가자 표시 이름'});assert.deepEqual(g.round,renamed);
  for(const actor of [0,1,2,3])for(const action of ['near','lock','finalize','initial','slot','rate','paid','settled','cash'])for(const value of [true,false]){
   const unchanged=await snapshot();
   await assert.rejects(()=>mutate(actor,g,action,{hole:17,player:0,value}),/일반 게임/);
   assert.equal(await snapshot(),unchanged);
  }
  const unchanged=await snapshot();
  await assert.rejects(()=>mutate(4,g,'score',{hole:0,player:0,value:5}),/참가자만/);
  await assert.rejects(()=>mutate(1,g,'score',{hole:0,player:0,value:5},g.revision-1),/다른 참가자/);
  assert.equal(await snapshot(),unchanged);
 }
 // Legacy path remains byte-for-byte equivalent; no policy version is stamped.
 let legacy=await legacyGame(createRound('normal',4));legacy=await rpc(1,'golf_join',[legacy.code,'참가자']);
 legacy=await mutate(1,legacy,'score',{hole:0,player:1,value:4});assert.equal(legacy.round.gamePolicyVersion,undefined);
});
