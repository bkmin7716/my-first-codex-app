-- Compare installed source with the repository legacy reference (whitespace ignored).
-- false may reflect comments or real differences: review definitions before applying.
with reference(name,body_md5) as (values ('golf_validate','ca60ec9e06a2a9828cdd277ef473fadb'),('golf_join','4918133c9f9cc73e7344ce0ed8ab76c0'),('golf_mutate','96266b3150694dbd142b0f7876a8a601'))
select r.name,r.body_md5 reference_body_md5,
 md5(regexp_replace(p.prosrc,'[[:space:]]+','','g')) installed_body_md5,
 r.body_md5=md5(regexp_replace(p.prosrc,'[[:space:]]+','','g')) reference_body_matches
from reference r join pg_proc p on p.proname=r.name
join pg_namespace n on n.oid=p.pronamespace where n.nspname='public';
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
-- Both queries must return zero rows. Do not repair by deleting records.
select game_id,user_id,slot from public.golf_members where slot is not null and slot not between 0 and 3;
select game_id,slot,count(*) from public.golf_members where slot is not null group by game_id,slot having count(*)>1;
-- Existing connections outside roster bounds: report, never reassign automatically.
select m.game_id,m.user_id,m.slot from public.golf_members m join public.golf_games g on g.id=m.game_id
where m.slot is not null and (case when jsonb_typeof(g.round->'players')='array' then m.slot>=jsonb_array_length(g.round->'players') else true end);
-- Candidate validator body, read-only; does not replace installed functions.
do $check$
declare g record; r jsonb; failures integer:=0; h jsonb; v jsonb; n integer;
begin
 for g in select id,round from public.golf_games order by id loop
  r:=g.round;
  begin
   <<validation>>
   begin
 -- Exact pre-version validator; no new restrictions on legacy rounds.
 if coalesce(r->'slotPolicyVersion','null'::jsonb)='null'::jsonb and coalesce(r->'gamePolicyVersion','null'::jsonb)='null'::jsonb then
 if r is null or jsonb_typeof(r)<>'object' or coalesce(r->>'mode','') not in ('normal','hussein') then raise exception '게임 종류 오류'; end if;
 if jsonb_typeof(r->'players') is distinct from 'array' or jsonb_typeof(r->'holes') is distinct from 'array' then raise exception '라운드 형식 오류'; end if;
 n:=jsonb_array_length(r->'players');
 if n<>4 or jsonb_array_length(r->'holes')<>18 then raise exception '공동 게임은 4명·18홀입니다'; end if;
 for v in select value from jsonb_array_elements(r->'players') loop
  if jsonb_typeof(v)<>'string' or length(trim(v#>>'{}')) not between 1 and 40 then raise exception '선수 이름 오류'; end if;
 end loop;
 if coalesce(r->>'payment','') not in ('pre','post') or jsonb_typeof(r->'rate') is distinct from 'number' or coalesce(r->>'rate','') !~ '^[0-9]+$' then raise exception '정산 설정 오류'; end if;
 if (r->>'rate')::numeric not between 1 and 10000000 then raise exception '단가 오류'; end if;
 if jsonb_typeof(r->'initial') is distinct from 'array' then raise exception '초기 순위 오류'; end if;
 if jsonb_array_length(r->'initial')<>4 or (select count(distinct value) from jsonb_array_elements(r->'initial') where value in ('0'::jsonb,'1'::jsonb,'2'::jsonb,'3'::jsonb))<>4 then raise exception '초기 순위 오류'; end if;
 for h in select value from jsonb_array_elements(r->'holes') loop
  if coalesce(h->>'par','') not in ('3','4','5') or jsonb_typeof(h->'scores') is distinct from 'array' then raise exception '홀 설정 오류'; end if;
  if jsonb_array_length(h->'scores')<>4 then raise exception '타수 개수 오류'; end if;
  for v in select value from jsonb_array_elements(h->'scores') loop
   if v<>'null'::jsonb then
    if jsonb_typeof(v)<>'number' or (v#>>'{}') !~ '^[0-9]+$' then raise exception '타수는 정수입니다'; end if;
    if (v#>>'{}')::numeric not between 1 and 30 then raise exception '타수 범위 오류'; end if;
   end if;
  end loop;
  if h->'near' is null then raise exception 'Near 누락'; end if;
  if h->'near'<>'null'::jsonb and (h->>'par'<>'3' or h->'near' not in ('0'::jsonb,'1'::jsonb,'2'::jsonb,'3'::jsonb)) then raise exception 'Near 오류'; end if;
  if h->'paid' is distinct from 'null'::jsonb then
   if jsonb_typeof(h->'paid') is distinct from 'array' then raise exception '지급 형식 오류'; end if;
   if jsonb_array_length(h->'paid')<>4 then raise exception '지급 개수 오류'; end if;
   for v in select value from jsonb_array_elements(h->'paid') loop
    if coalesce(v#>>'{}','') !~ '^[0-9]+$' then raise exception '지급 금액 오류'; end if;
    if (v#>>'{}')::numeric>10000000000 then raise exception '지급 금액 범위 오류'; end if;
   end loop;
  end if;
 end loop;
 if jsonb_typeof(r->'settled') is distinct from 'array' or jsonb_typeof(r->'cash') is distinct from 'array' then raise exception '정산 형식 오류'; end if;
 if jsonb_array_length(r->'settled')<>4 then raise exception '정산 개수 오류'; end if;
 for v in select value from jsonb_array_elements(r->'settled') loop
  if v<>'null'::jsonb then
   if coalesce(v#>>'{}','') !~ '^-?[0-9]+$' then raise exception '정산 금액 오류'; end if;
   if abs((v#>>'{}')::numeric)>10000000000 then raise exception '정산 범위 오류'; end if;
  end if;
 end loop;
 for v in select value from jsonb_array_elements(r->'cash') loop
  if coalesce(v->>'type','') not in ('collect','refund') or coalesce(v->>'amount','') !~ '^[0-9]+$' then raise exception '거래 오류'; end if;
  if (v->>'amount')::numeric not between 1 and 10000000000 then raise exception '거래 범위 오류'; end if;
 end loop;
  exit validation;
 end if;
 if r ? 'gamePolicyVersion' and r->'gamePolicyVersion'<>'null'::jsonb and r->'gamePolicyVersion'<>'1'::jsonb then raise exception '지원하지 않는 게임 정책 버전입니다'; end if;
 if r is null or jsonb_typeof(r)<>'object' or coalesce(r->>'mode','') not in ('normal','hussein') then raise exception '게임 종류 오류'; end if;
 if r ? 'slotPolicyVersion' and r->'slotPolicyVersion'<>'null'::jsonb and r->'slotPolicyVersion'<>'1'::jsonb then raise exception '지원하지 않는 선수 정책 버전입니다'; end if;
 if r->'slotPolicyVersion'='1'::jsonb and r->'sharedSlots' is distinct from 'true'::jsonb then raise exception '공동 선수 정책 설정 오류'; end if;
 if jsonb_typeof(r->'players') is distinct from 'array' or jsonb_typeof(r->'holes') is distinct from 'array' then raise exception '라운드 형식 오류'; end if;
 n:=jsonb_array_length(r->'players');
 if n not between 1 and 4 or (r->'slotPolicyVersion'='1'::jsonb and n<>4) or (r->>'mode'='hussein' and n<>4) or jsonb_array_length(r->'holes')<>18 then raise exception '일반 게임은 1~4명, 후세인은 4명·18홀입니다'; end if;
 for v in select value from jsonb_array_elements(r->'players') loop
  if jsonb_typeof(v) is distinct from 'string' or length(trim(v#>>'{}')) not between 1 and 40 then raise exception '선수 이름 오류'; end if;
 end loop;
 if r->'slotPolicyVersion'='1'::jsonb and (select count(distinct btrim(value)) from jsonb_array_elements_text(r->'players'))<>n then raise exception '공동 게임의 선수 이름은 중복될 수 없습니다'; end if;
 if coalesce(r->>'payment','') not in ('pre','post') or jsonb_typeof(r->'rate') is distinct from 'number' or coalesce(r->>'rate','') !~ '^[0-9]+$' then raise exception '정산 설정 오류'; end if;
 if (r->>'rate')::numeric not between 1 and 10000000 then raise exception '단가 오류'; end if;
 if jsonb_typeof(r->'initial') is distinct from 'array' then raise exception '초기 순위 오류'; end if;
 if r->>'mode'='hussein' and (jsonb_array_length(r->'initial')<>4 or (select count(distinct value) from jsonb_array_elements(r->'initial') where value in ('0'::jsonb,'1'::jsonb,'2'::jsonb,'3'::jsonb))<>4) then raise exception '초기 순위 오류'; end if;
 for h in select value from jsonb_array_elements(r->'holes') loop
  if coalesce(h->>'par','') not in ('3','4','5') or jsonb_typeof(h->'scores') is distinct from 'array' then raise exception '홀 설정 오류'; end if;
  if jsonb_array_length(h->'scores')<>n then raise exception '타수 개수 오류'; end if;
  for v in select value from jsonb_array_elements(h->'scores') loop
   if v<>'null'::jsonb then
    if jsonb_typeof(v)<>'number' or (v#>>'{}') !~ '^[0-9]+$' then raise exception '타수는 정수입니다'; end if;
    if (v#>>'{}')::numeric not between 1 and 30 then raise exception '타수 범위 오류'; end if;
   end if;
  end loop;
  if h->'near' is null then raise exception 'Near 누락'; end if;
  if h->'near'<>'null'::jsonb and (h->>'par'<>'3' or not exists(select 1 from generate_series(0,n-1) i where h->'near'=to_jsonb(i))) then raise exception 'Near 오류'; end if;
  if h->'paid' is distinct from 'null'::jsonb then
   if jsonb_typeof(h->'paid') is distinct from 'array' then raise exception '지급 형식 오류'; end if;
   if jsonb_array_length(h->'paid')<>n then raise exception '지급 개수 오류'; end if;
   for v in select value from jsonb_array_elements(h->'paid') loop
    if (r->'slotPolicyVersion'='1'::jsonb and jsonb_typeof(v) is distinct from 'number') or coalesce(v#>>'{}','') !~ '^[0-9]+$' then raise exception '지급 금액 오류'; end if;
    if (v#>>'{}')::numeric>10000000000 then raise exception '지급 금액 범위 오류'; end if;
   end loop;
  end if;
 end loop;
 if jsonb_typeof(r->'settled') is distinct from 'array' or jsonb_typeof(r->'cash') is distinct from 'array' then raise exception '정산 형식 오류'; end if;
 if jsonb_array_length(r->'settled')<>n then raise exception '정산 개수 오류'; end if;
 for v in select value from jsonb_array_elements(r->'settled') loop
  if v<>'null'::jsonb then
   if (r->'slotPolicyVersion'='1'::jsonb and jsonb_typeof(v) is distinct from 'number') or coalesce(v#>>'{}','') !~ '^-?[0-9]+$' then raise exception '정산 금액 오류'; end if;
   if abs((v#>>'{}')::numeric)>10000000000 then raise exception '정산 범위 오류'; end if;
  end if;
 end loop;
 for v in select value from jsonb_array_elements(r->'cash') loop
  if jsonb_typeof(v) is distinct from 'object' or (r->'slotPolicyVersion'='1'::jsonb and jsonb_typeof(v->'amount') is distinct from 'number') or coalesce(v->>'type','') not in ('collect','refund') or coalesce(v->>'amount','') !~ '^[0-9]+$' then raise exception '거래 오류'; end if;
  if (v->>'amount')::numeric not between 1 and 10000000000 then raise exception '거래 범위 오류'; end if;
 end loop;

   end validation;
   raise notice 'PASS game=%',g.id;
  exception when others then
   failures:=failures+1;
   raise notice 'FAIL game=% error=%',g.id,SQLERRM;
  end;
 end loop;
 raise notice 'invalid_round_count=%',failures;
end;
$check$;
