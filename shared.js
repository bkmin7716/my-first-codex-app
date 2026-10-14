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
  }
  async identity() {
    const { data, error } = await this.client.auth.getSession();
    if (error) throw error;
    let session = data.session;
    if (!session) {
      const result = await this.client.auth.signInAnonymously();
      if (result.error) throw result.error;
      session = result.data.session;
    }
    this.userId = session.user.id;
    return this.userId;
  }
  async rpc(name, args) {
    const { data, error } = await this.client.rpc(name, args);
    if (error) throw Error(error.message);
    // PostgREST can encode composite-returning RPCs as a one-row array.
    const game = Array.isArray(data)
      ? data.length === 1
        ? data[0]
        : null
      : data;
    if (!game?.id) throw Error("서버의 게임 응답을 확인할 수 없습니다.");
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
    if (error) throw Error(error.message);
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
      this.onUpdate(this);
    } catch (error) {
      if (generation === this.generation)
        this.onStatus(
          `연결 실패 · 수정은 서버 확인 후 반영됩니다: ${error.message}`,
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
