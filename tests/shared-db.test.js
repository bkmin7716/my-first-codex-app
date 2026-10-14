import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { createRound, calculate } from "../engine.js";

const db = new PGlite();
await db.exec(`create role anon; create role authenticated;
 create schema auth; create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
 create publication supabase_realtime;`);
await db.exec(
  readFileSync(new URL("./fixtures/legacy-schema.sql", import.meta.url), "utf8"),
);
await db.exec(readFileSync(new URL("../supabase/001-player-slots.sql", import.meta.url), "utf8"));
await db.exec(readFileSync(new URL("../supabase/001-player-slots.sql", import.meta.url), "utf8"));
const users = Array.from(
  { length: 5 },
  (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
);
for (const id of users)
  await db.query("insert into auth.users values ($1)", [id]);
async function as(i, sql, args = []) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    i === null ? "" : users[i],
  ]);
  await db.exec("set role authenticated");
  return db.query(sql, args);
}
async function rpc(i, name, args) {
  const params = args.map((_, i) => `$${i + 1}`).join(",");
  return (await as(i, `select to_jsonb(public.${name}(${params})) as g`, args))
    .rows[0].g;
}
let game;
async function change(i, action, detail, revision = game.revision) {
  game = await rpc(i, "golf_mutate", [game.id, revision, action, detail]);
  return game;
}

test("PostgreSQL: 4명 참여·권한·충돌·이력·재계산·최종 잠금", async (t) => {
  await t.test("4명용 로컬 라운드 생성 및 원본 유지", async () => {
    const round = createRound("hussein");
    round.holes[0].par = 3;
    round.holes[1].par = 3;
    game = await rpc(0, "golf_create", [round, "생성자"]);
    assert.equal(game.revision, 0);
    assert.equal(game.owner_id, users[0]);
    assert.equal(round.holes[0].scores[0], null);
  });
  await t.test("비참가자는 게임·회원·이력 조회와 수정 차단", async () => {
    for (const table of ["golf_games", "golf_members", "golf_audit"])
      assert.equal(
        (await as(4, `select * from public.${table}`)).rows.length,
        0,
      );
    await assert.rejects(
      () =>
        rpc(4, "golf_mutate", [
          game.id,
          0,
          "score",
          { hole: 0, player: 0, value: 4 },
        ]),
      /참가자/,
    );
    await assert.rejects(
      () => as(0, "update public.golf_games set finalized=true"),
      /permission denied/,
    );
  });
  await t.test("나머지 3명 코드 참여·5번째 거부·재참여 멱등", async () => {
    for (let i = 1; i < 4; i++)
      game = await rpc(i, "golf_join", [game.code.toLowerCase(), `참가자${i}`]);
    await assert.rejects(() => rpc(4, "golf_join", [game.code, "초과"]), /4명/);
    assert.equal(
      (await rpc(1, "golf_join", [game.code, "다른 이름"])).revision,
      game.revision,
    );
    for (let i=0;i<4;i++) await change(i,"slot",{value:i});
    assert.equal(
      (await as(2, "select * from public.golf_members")).rows.length,
      4,
    );
  });
  await t.test(
    "모든 참가자가 모든 선수의 점수 수정·동시 수정은 revision 충돌",
    async () => {
      await assert.rejects(
        () =>
          rpc(1, "golf_mutate", [
            game.id,
            null,
            "score",
            { hole: 0, player: 0, value: 4 },
          ]),
        /다른 참가자/,
      );
      const old = game.revision;
      await change(1, "score", { hole: 0, player: 0, value: 3 });
      await assert.rejects(
        () => change(2, "score", { hole: 0, player: 1, value: 4 }, old),
        /다른 참가자/,
      );
      for (let i = 1; i < 4; i++)
        await change(i, "score", {
          hole: 0,
          player: i,
          value: [3, 4, 6, 7][i],
        });
      assert.equal(calculate(game.round).holes[0].winner, "A");
      const other = (
        await as(3, "select round from public.golf_games where id=$1", [
          game.id,
        ])
      ).rows[0];
      assert.deepEqual(other.round, game.round);
    },
  );
  await t.test("Near 변경·미입력 홀 잠금 차단·서버 입력 검증", async () => {
    await change(2, "near", { hole: 0, value: 2 });
    assert.deepEqual(calculate(game.round).points, [0, 3, 1, 0]);
    await assert.rejects(
      () => change(1, "lock", { hole: 1, value: true }),
      /모든 선수/,
    );
    for (const value of [0, 31, 1.5, "4"])
      await assert.rejects(() =>
        change(1, "score", { hole: 0, player: 1, value }),
      );
    await assert.rejects(
      () => change(1, "near", { hole: 3, value: 0 }),
      /Near/,
    );
  });
  await t.test(
    "모든 참가자 홀 잠금·생성자도 잠긴 홀 수정 불가·생성자만 해제",
    async () => {
      await change(3, "lock", { hole: 0, value: true });
      for (const i of [0, 1, 2, 3])
        await assert.rejects(
          () => change(i, "score", { hole: 0, player: 0, value: 5 }),
          /잠긴 홀/,
        );
      await assert.rejects(
        () => change(1, "near", { hole: 0, value: 0 }),
        /잠긴 홀/,
      );
      await assert.rejects(
        () => change(1, "lock", { hole: 0, value: false }),
        /생성자/,
      );
      await assert.rejects(
        () => change(0, "rate", { value: 200000 }),
        /잠금을 해제/,
      );
      await change(0, "lock", { hole: 0, value: false });
    },
  );
  await t.test(
    "과거 수정 시 순위·이월·Near·정산 재계산 및 지급 기록 유지",
    async () => {
      for (let i = 0; i < 4; i++)
        await change(2, "score", {
          hole: 1,
          player: i,
          value: [3, 4, 6, 7][i],
        });
      await change(0, "paid", {
        hole: 0,
        value: calculate(game.round).holes[0].expected,
      });
      await change(0, "settled", {
        player: 1,
        value: calculate(game.round).post.amounts[1],
      });
      await change(1, "score", { hole: 0, player: 1, value: 4 });
      await change(1, "score", { hole: 0, player: 2, value: 5 });
      let c = calculate(game.round);
      assert.equal(c.holes[0].winner, "tie");
      assert.equal(c.holes[1].pot, 6);
      assert.equal(c.points[2], 1);
      assert.equal(c.holes[0].stale, true);
      await change(2, "near", { hole: 0, value: 1 });
      c = calculate(game.round);
      assert.notEqual(game.round.settled[1], c.post.amounts[1]);
      await change(0, "rate", { value: 200000 });
      assert.equal(
        calculate(game.round).post.amounts[1],
        (calculate(game.round).points[1] - 14) * 200000,
      );
    },
  );
  await t.test(
    "일반 참가자의 단가·지급·거래 수정 및 최종 확정 차단",
    async () => {
      for (const [action, detail] of [
        ["rate", { value: 1 }],
        ["paid", { hole: 0, value: null }],
        ["settled", { player: 0, value: 0 }],
        ["cash", { value: [] }],
        ["finalize", { value: true }],
      ])
        await assert.rejects(() => change(1, action, detail), /생성자/);
      await assert.rejects(
        () => change(0, "finalize", { value: true }),
        /18홀/,
      );
    },
  );
  await t.test(
    "18홀 전체 잠금 후 최종 정산 잠금은 모든 데이터 변경 차단",
    async () => {
      for (let h = 0; h < 18; h++) {
        for (let p = 0; p < 4; p++)
          await change(p, "score", {
            hole: h,
            player: p,
            value: [3, 4, 6, 7][p],
          });
        await change(1, "lock", { hole: h, value: true });
      }
      assert.equal(calculate(game.round).complete, true);
      await change(0, "finalize", { value: true });
      for (const [action, detail] of [
        ["score", { hole: 0, player: 0, value: 7 }],
        ["lock", { hole: 0, value: false }],
        ["rate", { value: 1 }],
        ["near", { hole: 0, value: 1 }],
        ["paid", { hole: 0, value: null }],
        ["settled", { player: 0, value: null }],
        ["cash", { value: [] }],
      ])
        await assert.rejects(() => change(0, action, detail), /최종 확정/);
      await assert.rejects(
        () => change(1, "finalize", { value: false }),
        /생성자/,
      );
      await change(0, "finalize", { value: false });
      await change(0, "lock", { hole: 0, value: false });
      await change(3, "score", { hole: 0, player: 0, value: 8 });
    },
  );
  await t.test(
    "감사 기록: 실제 사용자 ID·이름·이전/새 값·시간·순서 보존, 직접 변조 차단",
    async () => {
      const rows = (
        await as(0, "select * from public.golf_audit order by id desc")
      ).rows;
      const last = rows[0];
      assert.equal(last.actor_id, users[3]);
      assert.equal(last.actor_name, "참가자3");
      assert.equal(last.detail.before, 3);
      assert.equal(last.detail.after, 8);
      assert.ok(last.created_at);
      await assert.rejects(
        () => as(1, "delete from public.golf_audit"),
        /permission denied/,
      );
      await assert.rejects(
        () =>
          as(
            1,
            "insert into public.golf_members(game_id,user_id,name) values ($1,$2,$3)",
            [game.id, users[4], "침입"],
          ),
        /permission denied/,
      );
    },
  );
  await t.test("익명 토큰 없는 호출·잘못된 복사 데이터 거부", async () => {
    await assert.rejects(
      () => rpc(null, "golf_create", [createRound("hussein"), "누구"]),
      /로그인/,
    );
    const bad = createRound("hussein");
    bad.initial = [0, 0, 2, 3];
    await assert.rejects(
      () => rpc(0, "golf_create", [bad, "생성자"]),
      /초기 순위/,
    );
  });
});

test.after(async () => db.close());

test("fixed slots, initial permutation, partial roster lock and rename preserve money", async () => {
 const r=createRound("hussein"); r.sharedSlots=true; r.initial=[3,2,1,0]; r.holes[0].scores=[4,4,4,4]; r.holes[0].paid=[1,2,3,4]; r.settled=[10,20,30,40];
 let g=await rpc(0,"golf_create",[r,"소유자"]);
 await assert.rejects(()=>rpc(0,"golf_mutate",[g.id,g.revision,"lock",{hole:0,value:true}]),/4명의/);
 for(const i of [3,1,2]) g=await rpc(i,"golf_join",[g.code,`이름${i}`]);
 assert.deepEqual(g.round.players,["소유자","이름3","이름1","이름2"]);
 assert.deepEqual(calculate(g.round).holes[0].rank,[3,2,1,0]);
 await assert.rejects(()=>rpc(1,"golf_mutate",[g.id,g.revision,"initial",{value:[0,0,2,3]}]));
 await assert.rejects(()=>rpc(1,"golf_mutate",[g.id,g.revision,"slot",{value:0}]),/변경할 수 없습니다/);
 g=await rpc(3,"golf_mutate",[g.id,g.revision,"name",{value:"새 이름"}]);
 assert.equal(g.round.players[1],"새 이름"); assert.deepEqual(g.round.holes[0].paid,r.holes[0].paid); assert.deepEqual(g.round.settled,r.settled);
 g=await rpc(0,"golf_mutate",[g.id,g.revision,"initial",{value:[0,1,2,3]}]);
 assert.equal(calculate(g.round).holes[0].rank[1],1);
});
