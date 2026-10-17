import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createRound} from '../engine.js';
const oldSql=readFileSync(new URL('./fixtures/legacy-schema.sql',import.meta.url),'utf8');
const migration=readFileSync(new URL('../supabase/001-player-slots.sql',import.meta.url),'utf8')+readFileSync(new URL('../supabase/003-normal-shared-scorecard.sql',import.meta.url),'utf8');
const users=Array.from({length:5},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`);
const fixtures=[];
for(const mode of ['normal','hussein'])for(const flag of ['missing','null','true']){
 const r=createRound(mode);r.players=['A','A','C','D'];r.holes[0].par=3;r.holes[0].scores=[3,4,5,6];
 if(flag!=='missing')r.sharedSlots=flag==='true'?true:null;
 fixtures.push({id:`10000000-0000-4000-8000-${String(fixtures.length+1).padStart(12,'0')}`,r});
}
const partial=createRound('normal',2);partial.holes[0].scores=[3,4];fixtures.push({id:'10000000-0000-4000-8000-000000000007',r:partial});
async function setup(upgraded){const db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;create publication supabase_realtime;`);
await db.exec(oldSql);await db.exec('alter table public.golf_members add column slot integer check(slot between 0 and 3);create unique index golf_members_game_slot_unique on public.golf_members(game_id,slot)');
for(const id of users)await db.query('insert into auth.users values($1)',[id]);
for(const [i,{id,r}] of fixtures.entries()){await db.query('insert into public.golf_games(id,code,owner_id,round) values($1,$2,$3,$4)',[id,`LEGACY${String(i).padStart(6,'0')}`,users[0],r]);await db.query('insert into public.golf_members(game_id,user_id,name) values($1,$2,$3)',[id,users[0],'생성자']);}
const precheck=readFileSync(new URL('../supabase/001-player-slots-precheck.sql',import.meta.url),'utf8');
const referenceQuery=precheck.slice(0,precheck.indexOf('-- Baseline:'));
assert.ok((await db.query(referenceQuery)).rows.every(r=>r.reference_body_matches===true));
if(upgraded)await db.exec(migration);return db;}
function stable(value){if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['updated_at','joined_at','created_at'].includes(k)).map(([k,v])=>[k,stable(v)]));return value;}
async function state(db){await db.exec('reset role');return stable((await db.query(`select
(select jsonb_agg(to_jsonb(g) order by id) from public.golf_games g) games,
(select jsonb_agg(to_jsonb(m) order by game_id,user_id) from public.golf_members m) members,
(select jsonb_agg(to_jsonb(a) order by id) from public.golf_audit a) audit`)).rows[0]);}
async function call(db,user,name,args){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user==null?'':users[user]]);await db.exec('set role authenticated');try{return {ok:stable((await db.query(`select to_jsonb(public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})) g`,args)).rows[0].g)};}catch(e){return {error:{code:e.code,message:e.message}};}}

test('original vs migrated legacy normal/Hussein RPCs: same results, errors, permissions and mutations',async()=>{
 const before=await setup(false),after=await setup(true);let checks=0;
 try{
  async function compare(user,name,args,label){const a=await call(before,user,name,args),b=await call(after,user,name,args);assert.deepEqual(b,a,label);assert.deepEqual(await state(after),await state(before),label+' state');checks++;return b;}
  for(const [i,{id,r}] of fixtures.entries()){
   const code=`LEGACY${String(i).padStart(6,'0')}`;
   await compare(1,'golf_join',[code,'  참가자1  '],'legacy join including normal');
   await compare(1,'golf_join',[code,null],'idempotent join precedes name validation');
   await compare(2,'golf_join',[code,''],'original table name constraint');
   await compare(2,'golf_join',[code,'참가자2'],'capacity uses 4 even for a historical partial normal roster');
   await compare(3,'golf_join',[code,'참가자3'],'fourth membership');
   await compare(4,'golf_join',[code,'초과'],'fifth membership refused');
   async function change(user,action,detail,offset=0){await before.exec('reset role');const rev=(await before.query('select revision from public.golf_games where id=$1',[id])).rows[0].revision;return compare(user,'golf_mutate',[id,Number(rev)+offset,action,detail],`${r.mode}/${i}/${user}/${action}`);}
   await change(4,'score',{hole:0,player:0,value:4});
   await change(null,'score',{hole:0,player:0,value:4});
   await change(1,'score',{hole:'0',player:'0',value:4});
   await change(1,'score',{hole:'bad',player:0,value:4});
   await change(1,'score',{hole:0,player:0,value:4},-1);
   await change(1,'near',{hole:0,value:1});
   for(const action of ['name','player_name','initial','slot'])for(const user of [0,1])await change(user,action,{player:0,value:action==='initial'?[0,1,2,3]:action==='slot'?0:'새 이름'});
   for(const action of ['rate','paid','settled','cash','finalize'])await change(1,action,{hole:0,player:0,value:action==='finalize'?true:0});
   await change(0,'rate',{value:200000});
   await change(0,'paid',{hole:0,value:Array(r.players.length).fill('100')});
   await change(0,'settled',{player:0,value:'100'});
   await change(0,'cash',{value:[{type:'collect',amount:'100'}]});
   await change(1,'lock',{hole:0,value:true});
   await change(1,'score',{hole:0,player:0,value:4});
   await change(1,'lock',{hole:0,value:false});
   await change(0,'rate',{value:100000});
   await change(0,'lock',{hole:0,value:false});
   await change(0,'finalize',{value:true});
   for(const db of [before,after]){await db.exec('reset role');await db.query('update public.golf_games set locked_holes=array(select generate_series(0,17)) where id=$1',[id]);}
   await change(0,'finalize',{value:true});
   await compare(1,'golf_join',[code,'재접속'],'finalized member reconnect');
   await change(1,'score',{hole:0,player:0,value:4});
   await change(0,'finalize',{value:false});
  }
  assert.ok(checks>=250);console.log(`PASS: ${checks} original/migrated legacy RPC comparisons plus state comparisons`);
 }finally{await before.close();await after.close();}
});
