import { validateRound } from "./engine.js";
import { sharedConfig } from "./shared-config.js";

export function diagnosticText(value) {
  return String(value ?? "").replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|Bearer\s+\S+/gi, "[비공개]").slice(0, 1500);
}

export class SharedGames {
  constructor(client, onUpdate = () => {}, onStatus = () => {}) {
    this.client = client;
    this.onUpdate = onUpdate;
    this.onStatus = value => { this.status = value; onStatus(value); };
    this.game = null;
    this.members = [];
    this.audit = [];
    this.channel = null;
    this.timer = null;
    this.generation = 0;
    this.busy = false;
    this.reading = null;
    this.realtime = false;
    this.diagnostics = new Map();
    this.requestId = 0;
    this.checks = { auth: "미확인", query: "미확인", rpc: "미확인" };
  }
  async request(operation, group, fn, validate = () => {}) {
    const entry = { operation, group, id: ++this.requestId, state: "확인 중", time: new Date().toISOString() };
    this.diagnostics.set(operation, entry);
    this.checks[group] = "확인 중";
    this.onStatus(this.status || "요청 확인 중");
    try {
      const result = await fn();
      if (result.error) throw Object.assign(new Error(result.error.message), result.error, { status: result.status || result.error.status });
      validate(result.data);
      entry.state = "성공";
      entry.error = null;
      return result;
    } catch (cause) {
      entry.state = "실패";
      entry.error = {
        code: diagnosticText(cause.code || cause.name || "UNKNOWN"),
        message: diagnosticText(cause.message || cause),
        status: diagnosticText(cause.status || ""),
        details: diagnosticText(cause.details), hint: diagnosticText(cause.hint),
      };
      throw Object.assign(new Error(`${operation}: ${entry.error.message}`), { ...entry.error, operation, message: `${operation}: ${entry.error.message}` });
    } finally {
      entry.time = new Date().toISOString();
      const entries = [...this.diagnostics.values()].filter(e => e.group === group);
      if (this.diagnostics.get(operation) === entry) this.checks[group] = entries.some(e => e.state === "실패") ? "실패" : entries.some(e => e.state === "확인 중") ? "확인 중" : group === "rpc" ? "실행 확인됨" : "확인됨";
      if (this.diagnostics.get(operation) === entry) this.onStatus(this.status || "요청 결과 확인됨");
    }
  }
  async identity() {
    this.checks.auth = "확인 중";
    this.onStatus("익명 로그인 확인 중");
    const { data } = await this.request("auth.getSession", "auth", () => this.client.auth.getSession());
    let session = data.session;
    if (!session) {
      const result = await this.request("auth.signInAnonymously", "auth", () => this.client.auth.signInAnonymously());
      session = result.data.session;
    }
    if (!session?.user?.id) { this.checks.auth = "실패"; throw Error("익명 로그인 세션을 확인할 수 없습니다."); }
    // getSession may only read local storage; verify the identity with Auth.
    const verified = await this.request("auth.getUser", "auth", () => this.client.auth.getUser(), data => {
      if (data?.user?.id !== session.user.id) throw Error("익명 로그인 서버 확인 실패");
    });
    this.checks.auth = "확인됨";
    this.userId = verified.data.user.id;
    this.onStatus("로그인 확인됨 · 서버 요청 대기");
    return this.userId;
  }
  async rpc(name, args) {
    this.checks.rpc = "확인 중";
    const { data } = await this.request(`rpc.${name}`, "rpc", () => this.client.rpc(name, args), data => {
      const game = Array.isArray(data) && data.length === 1 ? data[0] : data;
      if (!game?.id) throw Error("서버의 게임 응답을 확인할 수 없습니다.");
      validateRound(game.round);
    });
    // PostgREST can encode composite-returning RPCs as a one-row array.
    const game = Array.isArray(data)
      ? data.length === 1
        ? data[0]
        : null
      : data;
    if (!game?.id) { this.checks.rpc = "응답 오류"; throw Error("서버의 게임 응답을 확인할 수 없습니다."); }
    validateRound(game.round);

    this.onStatus("로그인·RPC 실행 확인됨 · 게임 동기화 확인 중");
    return game;
  }
  async create(round, name) {
    validateRound(round);
    if ((round.mode === "hussein" || round.sharedSlots === true) && round.players.length !== 4)
      throw Error("공동 게임은 4명으로 설정하세요.");
    const payload = {...structuredClone(round), gamePolicyVersion: 1};
    if (payload.mode === "hussein" || payload.sharedSlots === true) { payload.sharedSlots = true; payload.slotPolicyVersion = 1; }
    else delete payload.slotPolicyVersion;
    await this.identity();
    return this.watch(
      await this.rpc("golf_create", { p_round: payload, p_name: name }),
    );
  }
  async join(code, name) {
    await this.identity();
    return this.watch(
      await this.rpc("golf_join", { p_code: code, p_name: name }),
    );
  }
  async list() {
    await this.identity();
    const { data } = await this.request("golf_games.list", "query", () => this.client
      .from("golf_games")
      .select("*")
      .order("updated_at", { ascending: false }));

    this.onStatus("로그인·서버 조회 확인됨 · RPC 실행은 게임 생성/참여 시 확인");
    return data;
  }
  async open(id) {
    await this.identity();
    const { data } = await this.request("golf_games.open", "query", () => this.client
      .from("golf_games")
      .select("*")
      .eq("id", id)
      .single());
    return this.watch(data);
  }
  accept(game) {
    if (
      !this.game ||
      game.id !== this.game.id ||
      game.revision >= this.game.revision
    ) {
      validateRound(game.round);
      this.game = game;
    }
  }
  async watch(game) {
    this.stop();
    this.accept(game);
    const generation = this.generation;
    this.channel = this.client
      .channel(`golf-${game.id}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "golf_games",
          filter: `id=eq.${game.id}`,
        },
        () => this.refresh(),
      )
      .subscribe((status) => {
        if (generation !== this.generation) return;
        this.realtime = status === "SUBSCRIBED";
        if (generation === this.generation)
          this.onStatus(
            status === "SUBSCRIBED"
              ? "실시간 연결됨"
              : "연결 확인 중 · 자동 재연결",
          );
        if (status === "SUBSCRIBED") this.refresh();
      });
    // Reconcile missed events, background suspension and websocket interruptions.
    this.timer = setInterval(() => this.refresh(), 5000);
    await this.refresh();
    return this.game;
  }
  refresh() {
    if (!this.game) return Promise.resolve();
    // Realtime may start the first read before watch() reaches refresh().
    // Every caller must await that read, and an old game's read must not block
    // a new watch or clear its in-flight promise when it finishes.
    if (this.reading) return this.reading;
    const generation = this.generation, id = this.game.id;
    const pending = Promise.resolve().then(() => this.readSnapshot(generation, id)).finally(() => {
      if (this.reading === pending) this.reading = null;
    });
    this.reading = pending;
    return pending;
  }
  async readSnapshot(generation, id) {
    try {
      const results = await Promise.allSettled([
        this.request("golf_games.refresh", "query", () => this.client.from("golf_games").select("*").eq("id", id).single(), data => validateRound(data.round)),
        this.request("golf_members.refresh", "query", () => this.client.from("golf_members").select("*").eq("game_id", id).order("joined_at")),
        this.request("golf_audit.refresh", "query", () => this.client.from("golf_audit").select("*").eq("game_id", id).order("id", { ascending: false }).limit(100)),
      ]);
      if (generation !== this.generation) return;
      const [g, m, a] = results;
      if (g.status === "fulfilled") this.accept(g.value.data);
      if (m.status === "fulfilled") this.members = m.value.data;
      if (a.status === "fulfilled") this.audit = a.value.data;
      this.onUpdate(this);
      if (results.some(r => r.status === "rejected")) throw Error("일부 서버 조회 실패");
      this.onStatus(this.realtime ? "실시간 연결됨 · 서버 조회 확인됨" : "서버 조회 확인됨 · 실시간 연결 확인 중 · 5초마다 갱신");
    } catch (error) {
      if (generation === this.generation) this.checks.query = "실패";
      if (generation === this.generation)
        this.onStatus(
          "서버 조회 실패 · 연결 상태 미확인 · 자동 재시도 중",
        );
    }
  }
  async claimSlot(slot) {
    if (this.game?.round.slotPolicyVersion !== 1) throw Error("기존 게임은 선수 연결을 사용하지 않습니다.");
    const me = this.members.find(m => m.user_id === this.userId);
    if (!me) throw Error("참가자만 슬롯을 연결할 수 있습니다.");
    if (me.slot != null) throw Error("선수 슬롯은 변경할 수 없습니다.");
    if (!Number.isInteger(slot) || slot < 0 || slot > 3) throw Error("선수 번호 오류");
    if (this.members.some(m => m.slot === slot)) throw Error("이미 연결된 선수 슬롯입니다.");
    if (this.game?.finalized) throw Error("최종 확정 잠금 상태입니다.");
    return this.mutate("slot", { value: slot });
  }
  async mutate(action, detail, revision = this.game?.revision) {
    if (this.busy) throw Error("이전 변경을 저장 중입니다.");
    if (!this.game) throw Error("먼저 공동 게임을 여세요.");
    this.busy = true;
    try {
      const game = await this.rpc("golf_mutate", {
        p_game: this.game.id,
        p_revision: revision,
        p_action: action,
        p_detail: detail,
      });
      this.accept(game);
      this.onUpdate(this);
      return game;
    } catch (error) {
      await this.refresh();
      throw error;
    } finally {
      this.busy = false;
      await this.refresh();
    }
  }
  stop() {
    this.generation++;
    this.reading = null;
    for (const [key, entry] of this.diagnostics) if (entry.group === "query") this.diagnostics.delete(key);
    this.checks.query = "미확인";
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.channel) this.client.removeChannel(this.channel);
    this.channel = null;
    this.game = null;
    this.members = [];
    this.audit = [];
    this.realtime = false;
  }
}

export async function connectShared(onUpdate, onStatus) {
  if (!sharedConfig.url || !sharedConfig.publishableKey)
    throw Error(
      "공동 플레이 설정이 필요합니다. SHARED_SETUP.md 안내에 따라 shared-config.js를 설정하세요.",
    );
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(sharedConfig.url))
    throw Error("Supabase 프로젝트 HTTPS URL을 확인하세요.");
  const { createClient } = await import(
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm"
  );
  const client = createClient(sharedConfig.url, sharedConfig.publishableKey);
  return new SharedGames(client, onUpdate, onStatus);
}
