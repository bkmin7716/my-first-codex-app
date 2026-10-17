-- Optional, additive API after 001 + reviewed 003. Manual approval required.
-- No backfill, no replacement of existing RPCs, grants, RLS or game rules.
begin;
create or replace function public.golf_roster_by_code(p_code text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g public.golf_games; me public.golf_members; roster jsonb; can_join boolean;
begin
 if auth.uid() is null then raise exception '로그인이 필요합니다'; end if;
 select * into g from public.golf_games where code=upper(trim(p_code));
 if not found then raise exception '참여 코드를 확인하세요'; end if;
 select * into me from public.golf_members where game_id=g.id and user_id=auth.uid();
 can_join:=me.user_id is not null or (not g.finalized and (select count(*) from public.golf_members where game_id=g.id)<4);
 -- Preserve owner-only normal policies from 001/002.
 if me.user_id is null and g.round->>'mode'='normal' and g.round->'gamePolicyVersion'='1'::jsonb
 and g.round->'slotPolicyVersion' is distinct from '1'::jsonb and g.round->'normalScorePolicyVersion' is distinct from '1'::jsonb then can_join:=false; end if;
 select jsonb_agg(jsonb_build_object('player',p.ordinality-1,'name',p.name,
 'taken',g.round->>'mode'='hussein' and exists(select 1 from public.golf_members m where m.game_id=g.id and m.user_id<>auth.uid() and
  (m.slot=p.ordinality-1 or (m.slot is null and m.name=p.name and (select count(*) from jsonb_array_elements_text(g.round->'players') x where x=p.name)=1))),
 'mine',me.slot=p.ordinality-1) order by p.ordinality) into roster
 from jsonb_array_elements_text(g.round->'players') with ordinality p(name,ordinality);
 -- Reveal only roster/availability to code holders, never scores, money or member IDs.
 return jsonb_build_object('course',g.round->>'course','mode',g.round->>'mode','players',roster,
 'is_member',me.user_id is not null,'slot',me.slot,'name',me.name,'can_join',can_join,'finalized',g.finalized);
end;
$$;
create or replace function public.golf_join_player(p_code text,p_player integer default null,p_expected_name text default null) returns public.golf_games
language plpgsql security definer set search_path='' as $$
declare g public.golf_games; me public.golf_members; chosen text;
begin
 if auth.uid() is null then raise exception '로그인이 필요합니다'; end if;
 select * into g from public.golf_games where code=upper(trim(p_code)) for update;
 if not found then raise exception '참여 코드를 확인하세요'; end if;
 select * into me from public.golf_members where game_id=g.id and user_id=auth.uid();
 -- Reconnection never renames, moves a bound player, or changes finalized games.
 if me.user_id is not null then return g; end if;
 if g.finalized then raise exception '최종 확정된 게임입니다'; end if;
 if p_player is null or p_player<0 or p_player>=jsonb_array_length(g.round->'players') then raise exception '본인 선수를 선택하세요'; end if;
 chosen:=g.round->'players'->>p_player;
 if p_expected_name is not null and p_expected_name is distinct from chosen then raise exception '선수 명단이 변경되었습니다. 코드를 다시 조회하세요'; end if;
 if g.round->>'mode'='hussein' and exists(select 1 from public.golf_members m where m.game_id=g.id and m.user_id<>auth.uid() and
  (m.slot=p_player or (m.slot is null and m.name=chosen and (select count(*) from jsonb_array_elements_text(g.round->'players') x where x=chosen)=1))) then raise exception '이미 다른 계정에 연결된 선수입니다'; end if;
 -- Existing RPC enforces capacity, legacy policy, authentication and audit behavior.
 select * into g from public.golf_join(p_code,chosen);
 -- Normal selection supplies a display name only: four accounts even with one golfer.
 if g.round->>'mode'='normal' then return g; end if;
 update public.golf_members set slot=p_player,name=chosen where game_id=g.id and user_id=auth.uid();
 update public.golf_games set revision=revision+1,updated_at=now() where id=g.id returning * into g;
 insert into public.golf_audit(game_id,actor_id,actor_name,action,detail)
 values(g.id,auth.uid(),chosen,'player_join',jsonb_build_object('player',p_player,'revision',g.revision));
 return g;
end;
$$;
create or replace function public.golf_create_player(p_round jsonb,p_player integer) returns public.golf_games
language plpgsql security definer set search_path='' as $$
declare g public.golf_games;
begin
 if auth.uid() is null then raise exception '로그인이 필요합니다'; end if;
 if p_player is null or p_player<0 or p_player>=jsonb_array_length(p_round->'players') then raise exception '생성자 선수를 선택하세요'; end if;
 select * into g from public.golf_create(p_round,p_round->'players'->>p_player);
 if g.round->>'mode'='normal' then return g; end if;
 -- The new game/member only; errors roll back creation and all audit writes.
 update public.golf_members set slot=p_player where game_id=g.id and user_id=auth.uid();
 return g;
end;
$$;
revoke all on function public.golf_roster_by_code(text),public.golf_join_player(text,integer,text),public.golf_create_player(jsonb,integer) from public,anon;
grant execute on function public.golf_roster_by_code(text),public.golf_join_player(text,integer,text),public.golf_create_player(jsonb,integer) to authenticated;
commit;
