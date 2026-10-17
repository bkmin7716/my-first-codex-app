-- Existing installations: run before deploying the updated app. No round data is reordered.
begin;
alter table public.golf_members add column if not exists slot integer check (slot between 0 and 3);
-- Reuse an existing valid, unconditional unique index on these two columns.
do $index$
begin
 if not exists (
  select 1 from pg_index x
  where x.indrelid='public.golf_members'::regclass
   and x.indisunique and x.indisvalid and x.indisready
   and x.indpred is null and x.indexprs is null and x.indnkeyatts=2
   and (select array_agg(a.attname::text order by a.attname)
        from unnest(x.indkey::smallint[]) with ordinality k(attnum,pos)
        join pg_attribute a on a.attrelid=x.indrelid and a.attnum=k.attnum
        where k.pos<=x.indnkeyatts)=array['game_id','slot']::text[]
 ) then
  create unique index golf_member_slot on public.golf_members(game_id,slot);
 end if;
end;
$index$;
create or replace function public.golf_validate(r jsonb) returns void language plpgsql set search_path='' as $$
declare h jsonb; v jsonb; n integer;
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
  return;
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

end;
$$;

create or replace function public.golf_create(p_round jsonb,p_name text) returns public.golf_games language plpgsql security definer set search_path='' as $$
declare g public.golf_games;
begin
 if auth.uid() is null then raise exception '로그인이 필요합니다'; end if;
 if p_name is null or length(trim(p_name)) not between 1 and 40 then raise exception '표시 이름을 1~40자로 입력하세요'; end if;
 if octet_length(p_round::text)>100000 then raise exception '라운드 크기 초과'; end if;
 if jsonb_typeof(p_round->'players') is distinct from 'array' then raise exception '선수 배열 오류'; end if;
 if jsonb_array_length(p_round->'players') not between 1 and 4 then raise exception '선수 인원 오류'; end if;
 -- Mark every new game; existing versionless normal games retain legacy rights.
 p_round:=p_round||jsonb_build_object('gamePolicyVersion',1);
 -- Stamp only the newly inserted game; never update an existing game.
 if p_round->>'mode'='hussein' or p_round->'sharedSlots'='true'::jsonb then
  p_round:=p_round||jsonb_build_object('sharedSlots',true,'slotPolicyVersion',1);
 else
  p_round:=p_round-'slotPolicyVersion';
 end if;
 perform public.golf_validate(p_round);
 insert into public.golf_games(owner_id,round) values(auth.uid(),p_round) returning * into g;
 insert into public.golf_members(game_id,user_id,name,slot) values(g.id,auth.uid(),trim(p_name),null);
 insert into public.golf_audit(game_id,actor_id,actor_name,action,detail) values(g.id,auth.uid(),trim(p_name),'create','{}');
 return g;
end;
$$;
create or replace function public.golf_join(p_code text,p_name text) returns public.golf_games language plpgsql security definer set search_path='' as $$
declare g public.golf_games;
begin
 if auth.uid() is null then raise exception '로그인이 필요합니다'; end if;
 select * into g from public.golf_games where code=upper(trim(p_code)) for update;
 if not found then raise exception '참여 코드를 확인하세요'; end if;
 if coalesce(g.round->'slotPolicyVersion','null'::jsonb)='null'::jsonb and coalesce(g.round->'gamePolicyVersion','null'::jsonb)='null'::jsonb then
 if exists(select 1 from public.golf_members where game_id=g.id and user_id=auth.uid()) then return g; end if;
 if g.finalized then raise exception '최종 확정된 게임입니다'; end if;
 if (select count(*) from public.golf_members where game_id=g.id)>=4 then raise exception '참가 인원 4명이 모두 찼습니다'; end if;
 insert into public.golf_members(game_id,user_id,name) values(g.id,auth.uid(),trim(p_name));
 insert into public.golf_audit(game_id,actor_id,actor_name,action,detail) values(g.id,auth.uid(),trim(p_name),'join','{}');
 -- Broadcast membership changes through the game row, too.
 update public.golf_games set revision=revision+1,updated_at=now() where id=g.id returning * into g;
 return g;
 end if;
 if p_name is null or length(trim(p_name)) not between 1 and 40 then raise exception '표시 이름을 1~40자로 입력하세요'; end if;
 if exists(select 1 from public.golf_members where game_id=g.id and user_id=auth.uid()) then return g; end if;
 if g.finalized then raise exception '최종 확정된 게임입니다'; end if;
 if g.round->>'mode'='normal' and g.round->'slotPolicyVersion' is distinct from '1'::jsonb then raise exception '일반 게임은 생성자 혼자 관리합니다'; end if;
 perform public.golf_validate(g.round);
 if (select count(*) from public.golf_members where game_id=g.id)>=jsonb_array_length(g.round->'players') then raise exception '참가 인원이 모두 찼습니다'; end if;
 insert into public.golf_members(game_id,user_id,name,slot) values(g.id,auth.uid(),trim(p_name),null);
 insert into public.golf_audit(game_id,actor_id,actor_name,action,detail) values(g.id,auth.uid(),trim(p_name),'join','{}');
 -- Broadcast membership changes through the game row, too.
 update public.golf_games set round=g.round,revision=revision+1,updated_at=now() where id=g.id returning * into g;
 return g;
end;
$$;
create or replace function public.golf_mutate(p_game uuid,p_revision bigint,p_action text,p_detail jsonb) returns public.golf_games language plpgsql security definer set search_path='' as $$
declare g public.golf_games; who text; h integer; player integer; path text[]; before_value jsonb; after_value jsonb; d jsonb; n integer; target integer; shared boolean;
begin
 select * into g from public.golf_games where id=p_game for update;
 select name into who from public.golf_members where game_id=p_game and user_id=auth.uid();
 if who is null then raise exception '참가자만 수정할 수 있습니다'; end if;
 if p_revision is null or g.revision<>p_revision then raise exception '다른 참가자가 수정했습니다. 최신 내용을 확인 후 다시 입력하세요'; end if;
 -- Exact pre-version mutation contract, including unsupported-action behavior.
 if coalesce(g.round->'slotPolicyVersion','null'::jsonb)='null'::jsonb and coalesce(g.round->'gamePolicyVersion','null'::jsonb)='null'::jsonb then
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
 end if;
 if jsonb_typeof(g.round->'players') is distinct from 'array' then raise exception '선수 배열 오류'; end if;
 n:=jsonb_array_length(g.round->'players');
 shared:=coalesce(g.round->'slotPolicyVersion'='1'::jsonb,false);
 if g.round->>'mode'='normal' and not shared and auth.uid()<>g.owner_id and p_action<>'name' then raise exception '일반 게임은 생성자만 수정할 수 있습니다'; end if;
 if n not between 1 and 4 then raise exception '선수 인원 오류'; end if;
 if jsonb_typeof(p_detail) is distinct from 'object' then raise exception '요청 상세는 JSON 객체여야 합니다'; end if;
 if p_action is null or p_action not in ('name','player_name','slot','finalize','score','near','lock','initial','rate','paid','settled','cash') then raise exception '지원하지 않는 변경입니다'; end if;
 if not p_detail ? 'value' then raise exception '변경 값이 필요합니다'; end if;
 if octet_length(p_detail::text)>100000 then raise exception '요청 크기 초과'; end if;
 if p_action in ('name','player_name','slot') then
  if g.finalized then raise exception '최종 확정 잠금 상태입니다'; end if;
  if p_action='slot' then
   if not shared then raise exception '선수 슬롯 연결을 허용한 공동 게임이 아닙니다'; end if;
   if exists(select 1 from public.golf_members where game_id=g.id and user_id=auth.uid() and slot is not null) then raise exception '선수 슬롯은 변경할 수 없습니다'; end if;
   if jsonb_typeof(p_detail->'value') is distinct from 'number' or coalesce(p_detail->>'value','') !~ '^[0-3]$' then raise exception '선수 번호 오류'; end if;
   player:=(p_detail->>'value')::integer;
   if player not between 0 and n-1 then raise exception '선수 번호 오류'; end if;
   if exists(select 1 from public.golf_members where game_id=g.id and slot=player) then raise exception '이미 연결된 선수 슬롯입니다'; end if;
   if length(trim(g.round->'players'->>player)) not between 1 and 40 then raise exception '생성자가 선수 이름을 먼저 등록해야 합니다'; end if;
   before_value:='null'::jsonb; after_value:=to_jsonb(player);
   update public.golf_members set slot=player where game_id=g.id and user_id=auth.uid();
  else
   if jsonb_typeof(p_detail->'value') is distinct from 'string' or length(trim(p_detail->>'value')) not between 1 and 40 then raise exception '이름을 1~40자로 입력하세요'; end if;
   after_value:=to_jsonb(trim(p_detail->>'value'));
   if p_action='name' then
    before_value:=to_jsonb(who);
    update public.golf_members set name=trim(p_detail->>'value') where game_id=g.id and user_id=auth.uid();
   else
    if auth.uid()<>g.owner_id then raise exception '생성자만 선수 이름을 수정할 수 있습니다'; end if;
    if jsonb_typeof(p_detail->'player') is distinct from 'number' or coalesce(p_detail->>'player','') !~ '^[0-3]$' then raise exception '선수 번호 오류'; end if;
    player:=(p_detail->>'player')::integer;
    if player not between 0 and n-1 then raise exception '선수 번호 오류'; end if;
    before_value:=g.round->'players'->player;
    g.round:=jsonb_set(g.round,array['players',player::text],after_value);
   end if;
  end if;
  perform public.golf_validate(g.round);
 elsif p_action='finalize' then
  if auth.uid()<>g.owner_id then raise exception '생성자만 최종 잠금을 변경할 수 있습니다'; end if;
  if jsonb_typeof(p_detail->'value') is distinct from 'boolean' then raise exception '잠금 값 오류'; end if;
  if (p_detail->>'value')::boolean then
   if cardinality(g.locked_holes)<>18 then raise exception '18홀을 모두 잠근 후 최종 확정하세요'; end if;
  end if;
  before_value:=to_jsonb(g.finalized); g.finalized:=(p_detail->>'value')::boolean; after_value:=to_jsonb(g.finalized);
 else
  if g.finalized then raise exception '최종 확정 잠금 상태입니다'; end if;
  -- Membership is required above; score/Near/lock do not require any slot binding.
  if p_action in ('score','near','lock','paid') then
   if jsonb_typeof(p_detail->'hole') is distinct from 'number' or coalesce(p_detail->>'hole','') !~ '^([0-9]|1[0-7])$' then raise exception '홀 번호 오류'; end if;
   h:=(p_detail->>'hole')::integer;
   if h is null or h not between 0 and 17 then raise exception '홀 번호 오류'; end if;
  end if;
  if shared then
   target:=null;
   if p_action='settled' and p_detail->'value'<>'null'::jsonb then
    if jsonb_typeof(p_detail->'player') is distinct from 'number' or coalesce(p_detail->>'player','') !~ '^[0-3]$' then raise exception '선수 번호 오류'; end if;
    target:=(p_detail->>'player')::integer;
   end if;
   if target is not null then
    if target not between 0 and n-1 or not exists(select 1 from public.golf_members where game_id=g.id and slot=target and length(trim(name)) between 1 and 40) or length(trim(g.round->'players'->>target)) not between 1 and 40 then raise exception '이름과 사용자 연결을 먼저 완료하세요'; end if;
   end if;
   if p_action='paid' and p_detail->'value'<>'null'::jsonb and (select count(distinct slot) from public.golf_members where game_id=g.id and slot between 0 and n-1)<>n then raise exception '지급 기록 전 선수 연결을 완료하세요'; end if;
  end if;
  if p_action='lock' then
   if jsonb_typeof(p_detail->'value') is distinct from 'boolean' then raise exception '잠금 값 오류'; end if;
   before_value:=to_jsonb(h=any(g.locked_holes));
   if (p_detail->>'value')::boolean then
    if h=0 and g.round->>'mode'='hussein' then
     if jsonb_typeof(g.round->'initial') is distinct from 'array' then raise exception '초기 순위 오류'; end if;
     if jsonb_array_length(g.round->'initial')<>4 or (select count(distinct value) from jsonb_array_elements(g.round->'initial') where value in ('0'::jsonb,'1'::jsonb,'2'::jsonb,'3'::jsonb))<>4 then raise exception '초기 순위 오류'; end if;
    end if;
    -- Validate shape, integer score range, Near and financial data before locking.
    perform public.golf_validate(g.round);
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
     if jsonb_typeof(p_detail->'player') is distinct from 'number' or coalesce(p_detail->>'player','') !~ '^[0-3]$' then raise exception '선수 번호 오류'; end if;
     player:=(p_detail->>'player')::integer;
     if player is null or player not between 0 and n-1 then raise exception '선수 번호 오류'; end if;
     path:=array['holes',h::text,'scores',player::text];
    else path:=array['holes',h::text,'near']; end if;
   else
    if auth.uid()<>g.owner_id then raise exception '설정·지급 기록은 생성자만 수정할 수 있습니다'; end if;
    case p_action
     when 'initial' then
      if not shared then raise exception '초기 순위 변경은 새 공동 게임에서만 가능합니다'; end if;
      if cardinality(g.locked_holes)>0 then raise exception '초기 순위 수정 전 모든 홀의 잠금을 해제하세요'; end if;
      path:=array['initial'];
     when 'rate' then
      if cardinality(g.locked_holes)>0 then raise exception '단가 수정 전 모든 홀의 잠금을 해제하세요'; end if;
      path:=array['rate'];
     when 'paid' then path:=array['holes',h::text,'paid'];
     when 'settled' then
      if jsonb_typeof(p_detail->'player') is distinct from 'number' or coalesce(p_detail->>'player','') !~ '^[0-3]$' then raise exception '선수 번호 오류'; end if;
     player:=(p_detail->>'player')::integer;
      if player is null or player not between 0 and n-1 then raise exception '선수 번호 오류'; end if;
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
-- CREATE OR REPLACE preserves existing function ownership and grants.
commit;
