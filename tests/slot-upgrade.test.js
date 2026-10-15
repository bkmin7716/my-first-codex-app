import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createRound} from '../engine.js';

test('legacy slot RPC P0001 reproduction and non-destructive upgrade', async () => {
 const db=new PGlite();
 try {
  await db.exec(`create role anon; create role authenticated; create schema auth;
   create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
   grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
   create publication supabase_realtime;`);
  await db.exec(readFileSync(new URL('./fixtures/legacy-schema.sql',import.meta.url),'utf8'));
  const uid='00000000-0000-4000-8000-000000000001';
  await db.query('insert into auth.users values ($1)',[uid]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid]);
  await db.exec('set role authenticated');
  const r=createRound('hussein');r.sharedSlots=true;r.holes[0].scores=[3,4,5,6];r.holes[0].paid=[1,2,3,4];r.settled=[10,20,30,40];
  const g=(await db.query('select to_jsonb(public.golf_create($1,$2)) g',[r,'wqq'])).rows[0].g;
  await assert.rejects(()=>db.query('select public.golf_mutate($1,$2,$3,$4)',[g.id,g.revision,'slot',{value:1}]), e=>e.code==='P0001' && /지원하지 않는 변경/.test(e.message));
  await db.exec('reset role');
  const migration=readFileSync(new URL('../supabase/001-player-slots.sql',import.meta.url),'utf8');
  await db.exec(migration);await db.exec(migration);
  assert.deepEqual((await db.query('select round from public.golf_games where id=$1',[g.id])).rows[0].round,r);
  await db.exec('set role authenticated');
  const linked=(await db.query('select to_jsonb(public.golf_mutate($1,$2,$3,$4)) g',[g.id,g.revision,'slot',{value:1}])).rows[0].g;
  assert.deepEqual(linked.round,r);
  await assert.rejects(()=>db.query('select public.golf_mutate($1,$2,$3,$4)',[g.id,linked.revision,'slot',{value:2}]),/변경할 수 없습니다/);
 } finally {await db.close();}
});
