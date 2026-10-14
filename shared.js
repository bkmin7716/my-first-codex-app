import { validateRound } from "./engine.js";
import { sharedConfig } from "./shared-config.js";

export class SharedGames {
  constructor(client, onUpdate = () => {}, onStatus = () => {}) {
    this.client = client;
    this.onUpdate = onUpdate;
    this.onStatus = onStatus;
    this.game = null;
    this.members = [];
    this.audit = [];
    this.channel = null;
    this.timer = null;
    this.generation = 0;
    this.busy = false;
    this.reading = false;
    this.realtime = false;
    this.checks = { auth: "미확인", query: "미확인", rpc: "미확인" };
  }
  async identity() {
    this.checks.auth = "확인 중";
    this.onStatus("익명 로그인 확인 중");
    const { data, error } = await this.client.auth.getSession();
    if (error) { this.checks.auth = "실패"; throw Error("익명 로그인 세션 조회 실패"); }
    let session = data.session;
    if (!session) {
      const result = await this.client.auth.signInAnonymously();
      if (result.error) { this.checks.auth = "실패"; throw Error("익명 로그인 실패 · Supabase에서 익명 로그인을 허용했는지 확인하세요."); }
      session = result.data.session;
    }
    if (!session?.user?.id) { this.checks.auth = "실패"; throw Error("익명 로그인 세션을 확인할 수 없습니다."); }
    // getSession may only read local storage; verify the identity with Auth.
    const verified = await this.client.auth.getUser();
    if (verified.error || verified.data?.user?.id !== session.user.id) {
      this.checks.auth = "실패";
      throw Error("익명 로그인 서버 확인 실패");
    }
    this.checks.auth = "확인됨";
    this.userId = verified.data.user.id;
    this.onStatus("로그인 확인됨 · 서버 요청 대기");
    return this.userId;
  }
  async rpc(name, args) {
    this.checks.rpc = "확인 중";
    const { data, error } = await this.client.rpc(name, args);
    if (error) { this.checks.rpc = "요청 실패"; throw Error(error.message); }
    // PostgREST can encode composite-returning RPCs as a one-row array.
    const game = Array.isArray(data)
      ? data.length === 1
        ? data[0]
        : null
      : data;
    if (!game?.id) { this.checks.rpc = "응답 오류"; throw Error("서버의 게임 응답을 확인할 수 없습니다."); }
    validateRound(game.round);
    this.checks.rpc = "실행 확인됨";
    this.onStatus("로그인·RPC 실행 확인됨 · 게임 동기화 확인 중");
    return game;
  }
  async create(round, name) {
    validateRound(round);
    if (round.players.length !== 4)
      throw Error("공동 게임은 4명으로 설정하세요.");
    await this.identity();
    return this.watch(
      await this.rpc("golf_create", { p_round: round, p_name: name }),
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
    const { data, error } = await this.client
      .from("golf_games")
      .select("*")
      .order("updated_at", { ascending: false });
    if (error) { this.checks.query = "실패"; throw Error(error.message); }
    this.checks.query = "확인됨";
    this.onStatus("로그인·서버 조회 확인됨 · RPC 실행은 게임 생성/참여 시 확인");
    return data;
  }
  async open(id) {
    await this.identity();
    const { data, error } = await this.client
      .from("golf_games")
      .select("*")
      .eq("id", id)
      .single();
    if (error) throw Error(error.message);
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
  async refresh() {
    if (!this.game || this.reading) return;
    this.reading = true;
    const generation = this.generation,
      id = this.game.id;
    try {
      const [g, m, a] = await Promise.all([
        this.client.from("golf_games").select("*").eq("id", id).single(),
        this.client
          .from("golf_members")
          .select("*")
          .eq("game_id", id)
          .order("joined_at"),
        this.client
          .from("golf_audit")
          .select("*")
          .eq("game_id", id)
          .order("id", { ascending: false })
          .limit(100),
      ]);
      if (generation !== this.generation) return;
      for (const result of [g, m, a])
        if (result.error) throw Error(result.error.message);
      this.accept(g.data);
      this.members = m.data;
      this.audit = a.data;
      this.checks.query = "확인됨";
      this.onStatus(this.realtime ? "실시간 연결됨 · 서버 조회 확인됨" : "서버 조회 확인됨 · 실시간 연결 확인 중 · 5초마다 갱신");
      this.onUpdate(this);
    } catch (error) {
      if (generation === this.generation) this.checks.query = "실패";
      if (generation === this.generation)
        this.onStatus(
          "서버 조회 실패 · 연결 상태 미확인 · 자동 재시도 중",
        );
    } finally {
      this.reading = false;
    }
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
