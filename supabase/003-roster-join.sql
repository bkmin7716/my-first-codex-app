-- New shared games only. Existing legacy game membership semantics remain unchanged.
begin;
create or replace function public.golf_preview(p_code text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g public.golf_games;
begin
 if auth.uid() is null then raise exception '로그인이 필요합니다'; end if;
 select * into g from public.golf_games where code=upper(trim(p_code));
 if not found or g.round->'slotPolicyVersion' is distinct from '1'::jsonb then raise exception '공동 게임 코드를 확인하세요'; end if;
 return jsonb_build_object('players',g.round->'players','taken',
  coalesce((select jsonb_agg(slot) from public.golf_members where game_id=g.id and slot is not null),'[]'::jsonb));
end; $$;
create or replace function public.golf_join_selected(p_code text,p_slot integer) returns public.golf_games
language plpgsql security definer set search_path='' as $$
declare g public.golf_games; selected_name text; existing_slot integer;
begin
 if auth.uid() is null then raise exception '로그인이 필요합니다'; end if;
 select * into g from public.golf_games where code=upper(trim(p_code)) for update;
 if not found or g.round->'slotPolicyVersion' is distinct from '1'::jsonb then raise exception '공동 게임 코드를 확인하세요'; end if;
 if p_slot is null or p_slot not between 0 and 3 then raise exception '선수 선택 오류'; end if;
 selected_name:=g.round->'players'->>p_slot;
 if selected_name is null or length(trim(selected_name)) not between 1 and 40 then raise exception '등록된 선수 이름 오류'; end if;
 select slot into existing_slot from public.golf_members where game_id=g.id and user_id=auth.uid();
 if found then
  if existing_slot=p_slot then return g; end if;
  if existing_slot is not null then raise exception '이미 다른 선수로 참가했습니다'; end if;
  if exists(select 1 from public.golf_members where game_id=g.id and slot=p_slot) then raise exception '이미 선택된 선수입니다'; end if;
  update public.golf_members set slot=p_slot,name=trim(selected_name) where game_id=g.id and user_id=auth.uid();
 else
  if g.finalized then raise exception '최종 확정된 게임입니다'; end if;
  if exists(select 1 from public.golf_members where game_id=g.id and slot=p_slot) then raise exception '이미 선택된 선수입니다'; end if;
  if (select count(*) from public.golf_members where game_id=g.id)>=4 then raise exception '참가 인원이 모두 찼습니다'; end if;
  insert into public.golf_members(game_id,user_id,name,slot) values(g.id,auth.uid(),trim(selected_name),p_slot);
 end if;
 insert into public.golf_audit(game_id,actor_id,actor_name,action,detail) values(g.id,auth.uid(),trim(selected_name),'join_selected',jsonb_build_object('slot',p_slot));
 update public.golf_games set revision=revision+1,updated_at=now() where id=g.id returning * into g;
 return g;
end; $$;
revoke all on function public.golf_preview(text), public.golf_join_selected(text,integer) from public;
grant execute on function public.golf_preview(text),public.golf_join_selected(text,integer) to authenticated;
commit;
