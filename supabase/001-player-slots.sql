-- Existing installations: run before deploying the updated app. No round data is reordered.
begin;
alter table public.golf_members add column if not exists slot integer check (slot between 0 and 3);
create unique index if not exists golf_member_slot on public.golf_members(game_id,slot);
create or replace function public.golf_create(p_round jsonb,p_name text) returns public.golf_games language plpgsql security definer set search_path='' as $$
declare g public.golf_games; assigned integer;
begin
 if auth.uid() is null then raise exception '로그인이 필요합니다'; end if;
 if octet_length(p_round::text)>100000 then raise exception '라운드 크기 초과'; end if;
 perform public.golf_validate(p_round);
 if p_round->>'sharedSlots'='true' then
  p_round:=jsonb_set(p_round,'{players,0}',to_jsonb(trim(p_name))); assigned:=0;
 end if;
 insert into public.golf_games(owner_id,round) values(auth.uid(),p_round) returning * into g;
 insert into public.golf_members(game_id,user_id,name,slot) values(g.id,auth.uid(),trim(p_name),assigned);
 insert into public.golf_audit(game_id,actor_id,actor_name,action,detail) values(g.id,auth.uid(),trim(p_name),'create','{}');
 return g;
end;
$$;
create or replace function public.golf_join(p_code text,p_name text) returns public.golf_games language plpgsql security definer set search_path='' as $$
declare g public.golf_games; assigned integer;
begin
 if auth.uid() is null then raise exception '로그인이 필요합니다'; end if;
 select * into g from public.golf_games where code=upper(trim(p_code)) for update;
 if not found then raise exception '참여 코드를 확인하세요'; end if;
 if exists(select 1 from public.golf_members where game_id=g.id and user_id=auth.uid()) then return g; end if;
 if g.finalized then raise exception '최종 확정된 게임입니다'; end if;
 if (select count(*) from public.golf_members where game_id=g.id)>=4 then raise exception '참가 인원 4명이 모두 찼습니다'; end if;
 if g.round->>'sharedSlots'='true' then
  select i into assigned from generate_series(0,3) i where not exists(select 1 from public.golf_members m where m.game_id=g.id and m.slot=i) order by i limit 1;
  g.round:=jsonb_set(g.round,array['players',assigned::text],to_jsonb(trim(p_name)));
 end if;
 insert into public.golf_members(game_id,user_id,name,slot) values(g.id,auth.uid(),trim(p_name),assigned);
 insert into public.golf_audit(game_id,actor_id,actor_name,action,detail) values(g.id,auth.uid(),trim(p_name),'join','{}');
 -- Broadcast membership changes through the game row, too.
 update public.golf_games set round=g.round,revision=revision+1,updated_at=now() where id=g.id returning * into g;
 return g;
end;
$$;
create or replace function public.golf_mutate(p_game uuid,p_revision bigint,p_action text,p_detail jsonb) returns public.golf_games language plpgsql security definer set search_path='' as $$
declare g public.golf_games; who text; h integer; player integer; path text[]; before_value jsonb; after_value jsonb; d jsonb;
begin
 select * into g from public.golf_games where id=p_game for update;
 select name into who from public.golf_members where game_id=p_game and user_id=auth.uid();
 if who is null then raise exception '참가자만 수정할 수 있습니다'; end if;
 if p_revision is null or g.revision<>p_revision then raise exception '다른 참가자가 수정했습니다. 최신 내용을 확인 후 다시 입력하세요'; end if;
 if octet_length(p_detail::text)>100000 then raise exception '요청 크기 초과'; end if;
 if p_action in ('name','slot') then
  if p_action='slot' then
   if g.finalized then raise exception '최종 확정 잠금 상태입니다'; end if;
   if exists(select 1 from public.golf_members where game_id=g.id and user_id=auth.uid() and slot is not null) then raise exception '선수 슬롯은 변경할 수 없습니다'; end if;
   player:=(p_detail->>'value')::integer;
   if player is null or player not between 0 and 3 then raise exception '선수 번호 오류'; end if;
   if exists(select 1 from public.golf_members where game_id=g.id and slot=player) then raise exception '이미 연결된 선수 슬롯입니다'; end if;
   update public.golf_members set slot=player where game_id=g.id and user_id=auth.uid();
   before_value:=g.round->'players'->player; after_value:=to_jsonb(who);
  else
   if jsonb_typeof(p_detail->'value') is distinct from 'string' or length(trim(p_detail->>'value')) not between 1 and 40 then raise exception '내 표시 이름을 1~40자로 입력하세요'; end if;
   select slot into player from public.golf_members where game_id=g.id and user_id=auth.uid();
   before_value:=to_jsonb(who); after_value:=to_jsonb(trim(p_detail->>'value'));
   update public.golf_members set name=trim(p_detail->>'value') where game_id=g.id and user_id=auth.uid();
  end if;
  if player is not null then g.round:=jsonb_set(g.round,array['players',player::text],after_value); end if;
 elsif p_action='finalize' then
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
    if h=0 and (select count(slot) from public.golf_members where game_id=g.id)<>4 then raise exception '4명의 선수 슬롯과 초기 순위를 모두 확정하세요'; end if;
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
     when 'initial' then
      if cardinality(g.locked_holes)>0 then raise exception '초기 순위 수정 전 모든 홀의 잠금을 해제하세요'; end if;
      path:=array['initial'];
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
commit;
