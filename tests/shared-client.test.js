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
      async getUser() { return {data:{user:{id:"owner"}}}; },
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

test("익명 로그인 실패를 RPC 성공으로 표시하지 않음", async () => {
  const f = fixture();
  f.client.auth.signInAnonymously = async () => ({ error: {message:"disabled"} });
  const api = new SharedGames(f.client);
  await assert.rejects(() => api.create(createRound("hussein"), "이름"), /auth.signInAnonymously: disabled/);
  assert.equal(api.checks.auth, "실패");
  assert.equal(api.checks.rpc, "미확인");
  assert.equal(f.calls.length, 0);
});
test("조회 실패 후 복구 상태와 RPC 확인 결과를 구분", async () => {
  const f = fixture(), statuses = [], api = new SharedGames(f.client, () => {}, s => statuses.push(s));
  try {
    await api.open("game");
    assert.equal(api.checks.query, "확인됨");
    assert.equal(api.checks.rpc, "미확인");
    f.setFail(true);
    await api.refresh();
    assert.equal(api.checks.query, "실패");
    f.setFail(false);
    await api.refresh();
    assert.equal(api.checks.query, "확인됨");
    assert.match(statuses.at(-1), /서버 조회 확인됨/);
  } finally { api.stop(); }
});

test("로컬 세션만으로 로그인 성공을 표시하지 않음", async () => {
  const f = fixture();
  f.client.auth.getSession = async () => ({data:{session:{user:{id:"owner"}}}});
  f.client.auth.getUser = async () => ({error:{message:"expired"}});
  const api = new SharedGames(f.client);
  await assert.rejects(() => api.list(), /auth.getUser: expired/);
  assert.equal(api.checks.auth, "실패");
  assert.equal(api.checks.query, "미확인");
  assert.equal(api.checks.rpc, "미확인");
});

 test("요청별 오류 코드·HTTP·상세 보존 및 같은 요청 성공 시 오류 해제", async () => {
  const f = fixture(), api = new SharedGames(f.client);
  f.client.rpc = async () => ({error:{code:"42501",message:"permission denied",details:"policy",hint:"check role"},status:403});
  await assert.rejects(() => api.join("ABC", "민수"), /rpc.golf_join: permission denied/);
  const entry = api.diagnostics.get("rpc.golf_join");
  assert.equal(entry.error.code, "42501"); assert.equal(entry.error.status, "403");
  assert.equal(entry.error.details, "policy"); assert.equal(entry.error.hint, "check role");
  assert.equal(api.diagnostics.get("auth.getUser").state, "성공");
  f.client.rpc = async () => ({data:f.row});
  try { await api.join("ABC", "민수"); assert.equal(api.diagnostics.get("rpc.golf_join").error, null); } finally { api.stop(); }
 });
 test("이력 조회만 실패해도 게임·참여자 보존, 재조회 성공은 RPC 실패를 지우지 않음", async () => {
  const f = fixture(), original = f.client.from, api = new SharedGames(f.client);
  try {
    await api.open("game");
    f.client.from = table => table === "golf_audit" ? {select(){return this},eq(){return this},order(){return this},limit(){return Promise.resolve({error:{code:"42501",message:"audit denied"}})}} : original(table);
    await api.refresh();
    assert.equal(api.game.id, "game");
    assert.equal(api.diagnostics.get("golf_members.refresh").state, "성공");
    assert.equal(api.diagnostics.get("golf_audit.refresh").state, "실패");
    f.client.from = original;
    await api.refresh();
    assert.equal(api.diagnostics.get("golf_audit.refresh").error, null);
    f.client.rpc = async () => ({error:{message:"conflict",code:"40001"}});
    await assert.rejects(() => api.mutate("score", {}), /conflict/);
    assert.equal(api.diagnostics.get("rpc.golf_mutate").state, "실패");
    assert.equal(api.diagnostics.get("golf_games.refresh").state, "성공");
  } finally { api.stop(); }
 });
