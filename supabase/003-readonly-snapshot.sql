-- Read-only: run before/after installation while application writes are paused.
-- Export ALL result sets. Historical production baseline: 14 / 23 / 131.
-- Never reset data to those counts; confirm the actual maintenance-window counts.
begin transaction isolation level repeatable read read only;
select 'golf_games' dataset,count(*) rows,
 md5(coalesce(string_agg(to_jsonb(g)::text,E'\n' order by id),'')) fingerprint
from public.golf_games g
union all select 'golf_members',count(*),
 md5(coalesce(string_agg(to_jsonb(m)::text,E'\n' order by game_id,user_id),'')) from public.golf_members m
union all select 'golf_audit',count(*),
 md5(coalesce(string_agg(to_jsonb(a)::text,E'\n' order by id),'')) from public.golf_audit a;

-- Missing exact signatures are an installation prerequisite failure.
with required(signature) as (values
 ('public.golf_validate(jsonb)'),('public.golf_create(jsonb,text)'),
 ('public.golf_join(text,text)'),('public.golf_mutate(uuid,bigint,text,jsonb)'))
select r.signature,p.oid,pg_get_userbyid(p.proowner) owner,p.proacl,
 p.prosecdef security_definer,p.proconfig settings,pg_get_functiondef(p.oid) definition
from required r left join pg_proc p on p.oid=to_regprocedure(r.signature)
order by r.signature;

select relname,relrowsecurity,relforcerowsecurity
from pg_class where oid in ('public.golf_games'::regclass,
 'public.golf_members'::regclass,'public.golf_audit'::regclass) order by relname;
select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
from pg_policies where schemaname='public'
 and tablename in ('golf_games','golf_members','golf_audit') order by tablename,policyname;
select grantee,table_name,privilege_type,is_grantable
from information_schema.table_privileges where table_schema='public'
 and table_name in ('golf_games','golf_members','golf_audit') order by table_name,grantee,privilege_type;
select pubname,schemaname,tablename from pg_publication_tables
where schemaname='public' and tablename in ('golf_games','golf_members','golf_audit')
order by pubname,tablename;
select round->>'mode' mode,round->'gamePolicyVersion' game_policy,
 round->'slotPolicyVersion' slot_policy,count(*) games
from public.golf_games group by 1,2,3 order by 1,2,3;
commit;
