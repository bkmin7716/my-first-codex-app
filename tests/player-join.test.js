import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {PGlite} from '@electric-sql/pglite';import {createRound,calculate} from '../engine.js';
const db=new PGlite();
await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;create publication supabase_realtime;`);
await db.exec(readFileSync(new URL('../supabase/schema.sql',import.meta.url),'utf8'));
const ids=Array.from({length:6},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`);for(const id of ids)await db.query('insert into auth.users values($1)',[id]);
async function rpc(actor,name,args){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor===null?'':ids[actor]]);await db.exec('set role authenticated');return (await db.query(`select to_jsonb(public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})) result`,args)).rows[0].result;}
async function snapshot(){await db.exec('reset role');return (await db.query(`select (select jsonb_agg(to_jsonb(g) order by id) from public.golf_games g) games,(select jsonb_agg(to_jsonb(m) order by game_id,user_id) from public.golf_members m) members,(select jsonb_agg(to_jsonb(a) order by id) from public.golf_audit a) audit`)).rows[0];}
const patch=readFileSync(new URL('../supabase/004-code-player-join.sql',import.meta.url),'utf8');
test('004 repeats preserve every existing row and original function definitions/owners/ACL/RLS',async()=>{
 for(let i=0;i<14;i++){const g=await rpc(0,'golf_create',[createRound(i%2?'normal':'hussein'),'생성자']);if(i<9){await db.exec('reset role');await db.query('insert into public.golf_members(game_id,user_id,name) values($1,$2,$3)',[g.id,ids[1],'기존 참가자']);}}
 await db.exec('reset role');await db.exec(`insert into public.golf_audit(game_id,actor_id,actor_name,action,detail) select (select id from public.golf_games order by id limit 1),'${ids[0]}','생성자','score','{}' from generate_series(1,117)`);
 const before=await snapshot();assert.equal(before.games.length,14);assert.equal(before.members.length,23);assert.equal(before.audit.length,131);
 const metadata=async()=>(await db.query(`select (select jsonb_agg(jsonb_build_array(oid,proowner,proacl,prosrc) order by oid) from pg_proc where proname in ('golf_create','golf_join','golf_mutate','golf_validate')) funcs,(select jsonb_agg(to_jsonb(p) order by policyname) from pg_policies p where schemaname='public') policies`)).rows;
 const meta=await metadata();await db.exec(patch);await db.exec(patch);assert.deepEqual(await snapshot(),before);assert.deepEqual(await metadata(),meta);
 await db.exec('set role anon');await assert.rejects(()=>db.query("select public.golf_roster_by_code('TEST')"),/permission denied/);
});
test('Hussein lookup is minimal, selection is exclusive, join binds atomically and reconnect is unchanged',async()=>{
 for(const mode of ['hussein']){
  const r=createRound(mode);r.players=['가','나','다','라'];r.holes[0].par=3;r.holes[0].scores=[3,4,5,6];r.holes[0].paid=[1,2,3,4];r.cash=[{type:'collect',amount:100}];r.settled=[1,null,null,null];
  let g=await rpc(0,'golf_create_player',[r,3]);const saved=structuredClone(g.round);
  const before=await snapshot(),list=await rpc(1,'golf_roster_by_code',[g.code]);assert.equal(list.players.length,4);assert.equal(list.players[3].taken,true);assert.equal(list.round,undefined);assert.equal(list.owner_id,undefined);assert.deepEqual(await snapshot(),before);
  const staleBefore=await snapshot();await assert.rejects(()=>rpc(1,'golf_join_player',[g.code,1,'이전 이름']),/명단이 변경/);assert.deepEqual(await snapshot(),staleBefore);
  g=await rpc(1,'golf_join_player',[g.code,1,'나']);let state=await snapshot();let m=state.members.find(m=>m.game_id===g.id&&m.user_id===ids[1]);assert.equal(m.slot,1);assert.equal(m.name,'나');assert.deepEqual(g.round,saved);
  const stable=await snapshot();await assert.rejects(()=>rpc(2,'golf_join_player',[g.code,1]),/이미 다른 계정/);assert.deepEqual(await snapshot(),stable);
  const again=await rpc(1,'golf_join_player',[g.code,0]);assert.equal(again.revision,g.revision);assert.deepEqual(await snapshot(),stable);
  g=await rpc(2,'golf_join_player',[g.code,2]);g=await rpc(3,'golf_join_player',[g.code,0]);
  for(let actor=0;actor<4;actor++)g=await rpc(actor,'golf_mutate',[g.id,g.revision,'score',{hole:0,player:0,value:actor+3}]);
  assert.equal(g.round.holes[0].scores[0],6);assert.deepEqual(g.round.cash,saved.cash);assert.deepEqual(g.round.settled,saved.settled);assert.deepEqual(g.round.holes[0].paid,saved.holes[0].paid);
  if(mode==='hussein'){
   g=await rpc(1,'golf_mutate',[g.id,g.revision,'near',{hole:0,value:1}]);g=await rpc(0,'golf_mutate',[g.id,g.revision,'paid',{hole:0,value:calculate(g.round).holes[0].expected}]);g=await rpc(0,'golf_mutate',[g.id,g.revision,'settled',{player:1,value:100}]);
  }
 }
});
test('legacy/unbound reconnect never changes identity and preserves existing scores/finances; name reservations and finalized protection',async()=>{
 await db.exec('reset role');const r=createRound('hussein');r.players=['가','나','다','라'];
 let g=(await db.query('insert into public.golf_games(owner_id,round) values($1,$2) returning *',[ids[0],r])).rows[0];
 await db.query('insert into public.golf_members(game_id,user_id,name) values($1,$2,$3),($1,$4,$5)',[g.id,ids[0],'가',ids[1],'표시이름']);
 const before=await snapshot();assert.equal((await rpc(2,'golf_roster_by_code',[g.code])).players[0].taken,true);const reconnected=await rpc(1,'golf_join_player',[g.code,null]);assert.equal(reconnected.revision,Number(g.revision));assert.deepEqual(reconnected.round,r);assert.deepEqual(await snapshot(),before);
 g=await rpc(1,'golf_join_player',[g.code,1,'다른 이름']);assert.deepEqual(g.round,r);assert.deepEqual(await snapshot(),before);await assert.rejects(()=>rpc(2,'golf_join_player',[g.code,0]),/이미 다른 계정/);
 g=await rpc(2,'golf_join_player',[g.code,2]);assert.equal((await rpc(2,'golf_roster_by_code',[g.code])).slot,2);
 const linked=await snapshot();await rpc(2,'golf_join_player',[g.code,3,'무시할 이름']);assert.deepEqual(await snapshot(),linked);
 g=await rpc(2,'golf_mutate',[g.id,g.revision,'score',{hole:0,player:0,value:4}]);
 g=await rpc(2,'golf_mutate',[g.id,g.revision,'near',{hole:2,value:2}]);
 await db.exec('reset role');await db.query('update public.golf_games set finalized=true where id=$1',[g.id]);const stable=await snapshot();await rpc(1,'golf_join_player',[g.code,null]);assert.deepEqual(await snapshot(),stable);await assert.rejects(()=>rpc(3,'golf_join_player',[g.code,3]),/최종 확정/);assert.deepEqual(await snapshot(),stable);
});
test('new normal games allow four accounts regardless of 1–4 golfers, shared scoring and immutable reconnection',async()=>{
 for(let count=1;count<=4;count++){
  const r=createRound('normal',count);r.players=Array.from({length:count},(_,i)=>`선수${i+1}`);
  let g=await rpc(0,'golf_create_player',[r,0]);
  for(let actor=1;actor<4;actor++){
   const roster=await rpc(actor,'golf_roster_by_code',[g.code]);assert.equal(roster.can_join,true);assert.ok(roster.players.every(p=>!p.taken));
   g=await rpc(actor,'golf_join_player',[g.code,0,'선수1']);
  }
  let state=await snapshot();const members=state.members.filter(m=>m.game_id===g.id);assert.equal(members.length,4);assert.ok(members.every(m=>m.slot===null&&m.name==='선수1'));
  assert.equal((await rpc(4,'golf_roster_by_code',[g.code])).can_join,false);
  await assert.rejects(()=>rpc(4,'golf_join_player',[g.code,0]),/참가 인원/);assert.deepEqual(await snapshot(),state);
  for(let actor=0;actor<4;actor++){
   const roster=await rpc(actor,'golf_roster_by_code',[g.code]);assert.equal(roster.is_member,true);
   await rpc(actor,'golf_join_player',[g.code,999,'바뀐 이름']);assert.deepEqual(await snapshot(),state);
   for(let player=0;player<count;player++)g=await rpc(actor,'golf_mutate',[g.id,g.revision,'score',{hole:0,player,value:actor+3}]);
   state=await snapshot();
  }
  for(const action of ['near','lock','finalize','paid','settled'])await assert.rejects(()=>rpc(0,'golf_mutate',[g.id,g.revision,action,{}]));
  await assert.rejects(()=>rpc(4,'golf_mutate',[g.id,g.revision,'score',{hole:0,player:0,value:3}]));assert.deepEqual(await snapshot(),state);
 }
});
await test('close test database',async()=>db.close());
