-- Baseline: games=8, members=13, audits=30; all existing games have no policy version.
select count(*) games,count(*) filter(where round->'sharedSlots'='true'::jsonb) old_shared_flag_true,
count(*) filter(where round->'slotPolicyVersion'='1'::jsonb) slot_policy_v1_games,
count(*) filter(where round->'gamePolicyVersion'='1'::jsonb) game_policy_v1_games,
count(*) filter(where coalesce(round->'slotPolicyVersion','null'::jsonb)='null'::jsonb and coalesce(round->'gamePolicyVersion','null'::jsonb)='null'::jsonb) legacy_games from public.golf_games;
select count(*) members,count(slot) connected,count(*) filter(where slot is null) unconnected from public.golf_members;
select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public' and tablename in ('golf_games','golf_members','golf_audit') order by tablename,policyname;
select relname,relrowsecurity,relforcerowsecurity from pg_class where oid in ('public.golf_games'::regclass,'public.golf_members'::regclass,'public.golf_audit'::regclass) order by relname;
-- Run before and after, with app writes paused. Save results (baseline 8 / 13 / 30).
select 'games' dataset,count(*) rows,md5(coalesce(string_agg(to_jsonb(g)::text,E'\n' order by id),'')) fingerprint from public.golf_games g
union all select 'members',count(*),md5(coalesce(string_agg(to_jsonb(m)::text,E'\n' order by game_id,user_id),'')) from public.golf_members m
union all select 'audit',count(*),md5(coalesce(string_agg(to_jsonb(a)::text,E'\n' order by id),'')) from public.golf_audit a;
select c.relname index_name,pg_get_indexdef(x.indexrelid) definition,x.indisunique,x.indisvalid,x.indisready,pg_get_expr(x.indpred,x.indrelid) predicate
from pg_index x join pg_class c on c.oid=x.indexrelid where x.indrelid='public.golf_members'::regclass order by c.relname;
select p.oid::regprocedure signature,pg_get_functiondef(p.oid) definition,p.proacl,p.proowner
from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('golf_validate','golf_create','golf_join','golf_mutate') order by p.oid;
-- After installation, validate existing rounds without mutations.
do $check$
declare g record; failures integer:=0;
begin
 for g in select id,round from public.golf_games order by id loop
  begin perform public.golf_validate(g.round); raise notice 'PASS game=%',g.id;
  exception when others then failures:=failures+1; raise notice 'FAIL game=% error=%',g.id,SQLERRM; end;
 end loop;
 raise notice 'invalid_round_count=%',failures;
end;
$check$;
