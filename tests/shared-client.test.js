import test from "node:test";
import assert from "node:assert/strict";
import { SharedGames, connectShared } from "../shared.js";
import { createRound } from "../engine.js";
function fixture() {
  let row = {
      id: "game",
      owner_id: "owner",
      revision: 0,
      round: createRound("hussein"),
      locked_holes: [],
      finalized: false,
    },
    callback,
    removed = 0,
    fail = false;
  const calls = [];
  const client = {
    auth: {
      async getSession() {
        return { data: { session: null } };
      },
      async signInAnonymously() {
        return { data: { session: { user: { id: "owner" } } } };
      },
    },
    from(table) {
      const q = {
        select() {
          return q;
        },
        eq() {
          return q;
        },
        order() {
          return q;
        },
        limit() {
          return q;
        },
        single() {
          return q;
        },
        then(resolve, reject) {
          return Promise.resolve(
            fail
              ? { error: { message: "offline" } }
              : { data: structuredClone(table === "golf_games" ? row : []) },
          ).then(resolve, reject);
        },
      };
      return q;
    },
    async rpc(name, args) {
      calls.push({ name, args });
      if (fail) return { error: { message: "offline" } };
      if (name === "golf_mutate") {
        if (args.p_revision !== row.revision)
          return { error: { message: "revision conflict" } };
        row = { ...row, revision: row.revision + 1 };
      }
      return { data: structuredClone(row) };
    },
    channel() {
      const c = {
        on(event, filter, cb) {
          callback = cb;
          return c;
        },
        subscribe(cb) {
          queueMicrotask(() => cb("SUBSCRIBED"));
          return c;
        },
      };
      return c;
    },
    removeChannel() {
      removed++;
    },
  };
  return {
    client,
    calls,
    setRow(v) {
      row = v;
    },
    get row() {
      return row;
    },
    emit() {
      callback();
    },
    setFail(v) {
      fail = v;
    },
    get removed() {
      return removed;
    },
  };
}
test("공동 클라이언트: 익명 인증·RPC 생성·실시간 수신·최신 revision 유지·구독 종료", async () => {
  const f = fixture(),
    updates = [],
    statuses = [],
    api = new SharedGames(
      f.client,
      (s) => updates.push(s.game.revision),
      (s) => statuses.push(s),
    );
  try {
    await api.create(createRound("hussein"), "이름");
    assert.equal(api.userId, "owner");
    assert.equal(f.calls[0].name, "golf_create");
    assert.ok(statuses.includes("실시간 연결됨"));
    f.setRow({ ...f.row, revision: 3 });
    f.emit();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(api.game.revision, 3);
    api.accept({ ...f.row, revision: 1 });
    assert.equal(api.game.revision, 3);
    await api.mutate("score", { hole: 0, player: 2, value: 5 });
    assert.equal(f.calls.at(-1).args.p_revision, 3);
    assert.equal(api.game.revision, 4);
    assert.ok(updates.includes(3));
  } finally {
    api.stop();
  }
  assert.equal(f.removed, 1);
  assert.equal(api.game, null);
});
test("공동 클라이언트: 충돌·오프라인은 성공 처리하지 않으며 최신 게임 재조회", async () => {
  const f = fixture(),
    api = new SharedGames(f.client);
  try {
    await api.open("game");
    f.setRow({ ...f.row, revision: 2 });
    await assert.rejects(
      () => api.mutate("near", { hole: 0, value: 1 }, 0),
      /revision conflict/,
    );
    assert.equal(api.game.revision, 2);
    f.setFail(true);
    await assert.rejects(
      () => api.mutate("score", { hole: 0, player: 0, value: 4 }),
      /offline/,
    );
    assert.equal(api.game.revision, 2);
    assert.equal(api.busy, false);
  } finally {
    api.stop();
  }
});
test("공동 클라이언트: 설정 없으면 실제 연결 필요 안내, 임시 성공 없음", async () => {
  await assert.rejects(() => connectShared(), /설정이 필요/);
});

test("공동 클라이언트: PostgREST의 단일 행 배열 응답 지원", async () => {
  const f = fixture(),
    rpc = f.client.rpc;
  f.client.rpc = async (...args) => {
    const result = await rpc(...args);
    return result.error ? result : { data: [result.data] };
  };
  const api = new SharedGames(f.client);
  try {
    await api.create(createRound("hussein"), "생성자");
    assert.equal(api.game.id, "game");
    await api.mutate("score", { hole: 0, player: 0, value: 4 });
    assert.equal(api.game.revision, 1);
  } finally {
    api.stop();
  }
});
