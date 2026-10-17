import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createRound} from '../engine.js';

test('14 fixture games / 19 members / 36 audits remain byte-for-byte unchanged by repeated versioned migration',async()=>{
 const db=new PGlite();
 try {
  await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;create publication supabase_realtime;`);
  await db.exec(readFileSync(new URL('./fixtures/legacy-schema.sql',import.meta.url),'utf8'));
  // Production already has the nullable column and its unique index.
  await db.exec('alter table public.golf_members add column slot integer check(slot between 0 and 3);create unique index golf_members_game_slot_unique on public.golf_members(game_id,slot)');
  const ids=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'];
  for(const id of ids)await db.query('insert into auth.users values($1)',[id]);
  async function rpc(i,name,args){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[i]]);await db.exec('set role authenticated');return (await db.query(`select to_jsonb(public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})) g`,args)).rows[0].g;}
  const games=[];
  for(let i=0;i<14;i++){
   const r=createRound('hussein');r.sharedSlots=i<5?true:null;r.holes[0].par=3;r.holes[0].paid=[1,2,3,4];r.settled=[10,20,30,40];
   let g=await rpc(0,'golf_create',[r,'생성자']);if(i<5)g=await rpc(1,'golf_join',[g.code,'참가자']);games.push(g);
  }
  for(let i=0;i<17;i++){const g=games[0];games[0]=await rpc(0,'golf_mutate',[g.id,g.revision,'score',{hole:0,player:i%4,value:4}]);}
  await db.exec('reset role');
  const snapshot=async()=>(await db.query(`select
   (select jsonb_agg(to_jsonb(g) order by id) from public.golf_games g) games,
   (select jsonb_agg(to_jsonb(m) order by game_id,user_id) from public.golf_members m) members,
   (select jsonb_agg(to_jsonb(a) order by id) from public.golf_audit a) audit`)).rows[0];
  const before=await snapshot();assert.equal(before.games.length,14);assert.equal(before.members.length,19);assert.equal(before.audit.length,36);
  assert.equal(before.games.filter(g=>g.round.sharedSlots===true).length,5);assert.ok(before.members.every(m=>m.slot===null));
  const metadata=async()=>(await db.query(`select (select jsonb_agg(jsonb_build_array(oid,proowner,proacl) order by oid) from pg_proc where proname in ('golf_validate','golf_create','golf_join','golf_mutate')) funcs,
   (select jsonb_agg(to_jsonb(p) order by policyname) from pg_policies p where schemaname='public') policies`)).rows[0];
  const meta=await metadata();
  const migration=readFileSync(new URL('../supabase/001-player-slots.sql',import.meta.url),'utf8');
  await db.exec(migration);await db.exec(migration);
  const patch=readFileSync(new URL('../supabase/002-shared-score-access.sql',import.meta.url),'utf8');
  await db.exec(patch);await db.exec(patch);
  const preview=readFileSync(new URL("../supabase/003-normal-shared-scorecard.sql",import.meta.url),"utf8");
  await db.exec(preview);await db.exec(preview);
  assert.deepEqual(await snapshot(),before);assert.deepEqual(await metadata(),meta);
  assert.equal((await db.query("select count(*)::int n from pg_indexes where schemaname='public' and indexname='golf_member_slot'")).rows[0].n,0);
  await db.exec(readFileSync(new URL('../supabase/001-player-slots-precheck.sql',import.meta.url),'utf8'));
  await db.exec(readFileSync(new URL('../supabase/001-player-slots-postcheck.sql',import.meta.url),'utf8'));
  assert.deepEqual(await snapshot(),before);
  let g=games[0];g=await rpc(1,'golf_join',[g.code,'재접속']);assert.equal(g.revision,games[0].revision);
  await assert.rejects(()=>rpc(1,'golf_mutate',[g.id,g.revision,'slot',{value:1}]),/생성자/);
  g=await rpc(1,'golf_mutate',[g.id,g.revision,'near',{hole:0,value:1}]);
  g=await rpc(1,'golf_mutate',[g.id,g.revision,'lock',{hole:0,value:true}]);assert.deepEqual(g.locked_holes,[0]);
  await db.exec('reset role');assert.equal((await db.query('select count(slot)::int n from public.golf_members')).rows[0].n,0);
  const fresh=await rpc(0,'golf_create',[createRound('hussein'),'생성자']);assert.equal(fresh.round.slotPolicyVersion,1);
 }finally{await db.close();}
});
