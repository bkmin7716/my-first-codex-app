-- Run once in the Supabase SQL editor. All mutations go through these RPCs.
begin;
create table public.golf_games (
 id uuid primary key default gen_random_uuid(),
 code text unique not null default upper(substr(replace(gen_random_uuid()::text,'-',''),1,12)),
 owner_id uuid not null references auth.users(id),
 round jsonb not null,
 revision bigint not null default 0,
 locked_holes integer[] not null default '{}',
 finalized boolean not null default false,
 updated_at timestamptz not null default now()
);
create table public.golf_members (
 game_id uuid not null references public.golf_games(id) on delete cascade,
 user_id uuid not null references auth.users(id),
 name text not null check (length(trim(name)) between 1 and 40),
 joined_at timestamptz not null default now(),
 primary key(game_id,user_id)
);
create table public.golf_audit (
 id bigint generated always as identity primary key,
 game_id uuid not null references public.golf_games(id) on delete cascade,
 actor_id uuid not null,
 actor_name text not null,
 action text not null,
 detail jsonb not null,
 created_at timestamptz not null default now()
);
create index on public.golf_members(user_id);
create index on public.golf_audit(game_id,id desc);
alter table public.golf_games enable row level security;
alter table public.golf_members enable row level security;
alter table public.golf_audit enable row level security;

create function public.golf_is_member(g uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.golf_members where game_id=g and user_id=auth.uid());
$$;
create policy member_read on public.golf_games for select to authenticated using (public.golf_is_member(id));
create policy member_read on public.golf_members for select to authenticated using (public.golf_is_member(game_id));
create policy member_read on public.golf_audit for select to authenticated using (public.golf_is_member(game_id));
revoke all on public.golf_games, public.golf_members, public.golf_audit from anon, authenticated;
grant select on public.golf_games, public.golf_members, public.golf_audit to authenticated;

-- Validate imported local rounds as well as every resulting server mutation.
create function public.golf_validate(r jsonb) returns void language plpgsql set search_path='' as $$
declare h jsonb; v jsonb; i integer; n integer;
begin
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
end;
$$;

create function public.golf_create(p_round jsonb,p_name text) returns public.golf_games language plpgsql security definer set search_path='' as $$
declare g public.golf_games;
begin
 if auth.uid() is null then raise exception '로그인이 필요합니다'; end if;
 if octet_length(p_round::text)>100000 then raise exception '라운드 크기 초과'; end if;
 perform public.golf_validate(p_round);
 insert into public.golf_games(owner_id,round) values(auth.uid(),p_round) returning * into g;
 insert into public.golf_members(game_id,user_id,name) values(g.id,auth.uid(),trim(p_name));
 insert into public.golf_audit(game_id,actor_id,actor_name,action,detail) values(g.id,auth.uid(),trim(p_name),'create','{}');
 return g;
end;
$$;
create function public.golf_join(p_code text,p_name text) returns public.golf_games language plpgsql security definer set search_path='' as $$
declare g public.golf_games;
begin
 if auth.uid() is null then raise exception '로그인이 필요합니다'; end if;
 select * into g from public.golf_games where code=upper(trim(p_code)) for update;
 if not found then raise exception '참여 코드를 확인하세요'; end if;
 if exists(select 1 from public.golf_members where game_id=g.id and user_id=auth.uid()) then return g; end if;
 if g.finalized then raise exception '최종 확정된 게임입니다'; end if;
 if (select count(*) from public.golf_members where game_id=g.id)>=4 then raise exception '참가 인원 4명이 모두 찼습니다'; end if;
 insert into public.golf_members(game_id,user_id,name) values(g.id,auth.uid(),trim(p_name));
 insert into public.golf_audit(game_id,actor_id,actor_name,action,detail) values(g.id,auth.uid(),trim(p_name),'join','{}');
 -- Broadcast membership changes through the game row, too.
 update public.golf_games set revision=revision+1,updated_at=now() where id=g.id returning * into g;
 return g;
end;
$$;
create function public.golf_mutate(p_game uuid,p_revision bigint,p_action text,p_detail jsonb) returns public.golf_games language plpgsql security definer set search_path='' as $$
declare g public.golf_games; who text; h integer; player integer; path text[]; before_value jsonb; after_value jsonb; d jsonb;
begin
 select * into g from public.golf_games where id=p_game for update;
 select name into who from public.golf_members where game_id=p_game and user_id=auth.uid();
 if who is null then raise exception '참가자만 수정할 수 있습니다'; end if;
 if g.revision<>p_revision then raise exception '다른 참가자가 수정했습니다. 최신 내용을 확인 후 다시 입력하세요'; end if;
 if octet_length(p_detail::text)>100000 then raise exception '요청 크기 초과'; end if;
 if p_action='finalize' then
  if auth.uid()<>g.owner_id then raise exception '생성자만 최종 잠금을 변경할 수 있습니다'; end if;
  if jsonb_typeof(p_detail->'value') is distinct from 'boolean' then raise exception '잠금 값 오류'; end if;
  if (p_detail->>'value')::boolean then
   if cardinality(g.locked_holes)<>18 then raise exception '18홀을 모두 잠근 후 최종 확정하세요'; end if;
  end if;
  before_value:=to_jsonb(g.finalized); g.finalized:=(p_detail->>'value')::boolean; after_value:=to_jsonb(g.finalized);
 else
  if g.finalized then raise exception '최종 확정 잠금 상태입니다'; end if;
  if p_action in ('score','near','lock','paid') then
   h:=(p_detail->>'hole')::integer;
   if h is null or h not between 0 and 17 then raise exception '홀 번호 오류'; end if;
  end if;
  if p_action='lock' then
   if jsonb_typeof(p_detail->'value') is distinct from 'boolean' then raise exception '잠금 값 오류'; end if;
   before_value:=to_jsonb(h=any(g.locked_holes));
   if (p_detail->>'value')::boolean then
    if exists(select 1 from jsonb_array_elements(g.round->'holes'->h->'scores') v where v='null'::jsonb) then raise exception '모든 선수의 타수를 입력하세요'; end if;
    if not h=any(g.locked_holes) then g.locked_holes:=array_append(g.locked_holes,h); end if;
   else
    if auth.uid()<>g.owner_id then raise exception '생성자만 홀 잠금을 해제할 수 있습니다'; end if;
    g.locked_holes:=array_remove(g.locked_holes,h);
   end if;
   after_value:=to_jsonb(h=any(g.locked_holes));
  else
   if p_action in ('score','near') then
    if h=any(g.locked_holes) then raise exception '잠긴 홀입니다. 생성자에게 잠금 해제를 요청하세요'; end if;
    if p_action='score' then
     player:=(p_detail->>'player')::integer;
     if player is null or player not between 0 and 3 then raise exception '선수 번호 오류'; end if;
     path:=array['holes',h::text,'scores',player::text];
    else path:=array['holes',h::text,'near']; end if;
   else
    if auth.uid()<>g.owner_id then raise exception '설정·지급 기록은 생성자만 수정할 수 있습니다'; end if;
    case p_action
     when 'rate' then
      if cardinality(g.locked_holes)>0 then raise exception '단가 수정 전 모든 홀의 잠금을 해제하세요'; end if;
      path:=array['rate'];
     when 'paid' then path:=array['holes',h::text,'paid'];
     when 'settled' then
      player:=(p_detail->>'player')::integer;
      if player is null or player not between 0 and 3 then raise exception '선수 번호 오류'; end if;
      path:=array['settled',player::text];
     when 'cash' then path:=array['cash'];
     else raise exception '지원하지 않는 변경입니다';
    end case;
   end if;
   if not p_detail ? 'value' then raise exception '변경 값이 필요합니다'; end if;
   before_value:=g.round#>path; after_value:=p_detail->'value';
   g.round:=jsonb_set(g.round,path,after_value,false);
   perform public.golf_validate(g.round);
  end if;
 end if;
 update public.golf_games set round=g.round,locked_holes=g.locked_holes,finalized=g.finalized,revision=revision+1,updated_at=now() where id=g.id returning * into g;
 d:=p_detail||jsonb_build_object('before',before_value,'after',after_value,'revision',g.revision);
 insert into public.golf_audit(game_id,actor_id,actor_name,action,detail) values(g.id,auth.uid(),who,p_action,d);
 return g;
end;
$$;
-- Functions are executable by PUBLIC by default: explicitly close that route.
revoke all on function public.golf_validate(jsonb), public.golf_is_member(uuid), public.golf_create(jsonb,text), public.golf_join(text,text), public.golf_mutate(uuid,bigint,text,jsonb) from public, anon;
grant execute on function public.golf_is_member(uuid), public.golf_create(jsonb,text), public.golf_join(text,text), public.golf_mutate(uuid,bigint,text,jsonb) to authenticated;
-- Only game rows need Realtime; history and members are reloaded after each event.
alter publication supabase_realtime add table public.golf_games;

commit;
