import { sharedConfig } from "./shared-config.js";
import { connectShared, diagnosticText } from "./shared.js";
import { createRound, calculate } from "./engine.js";
import { load } from "./storage.js";

const localRoot = document.querySelector("#app");
const launcher = document.createElement("div");
launcher.className = "shared-launcher";
launcher.innerHTML =
  '<button class="primary" id="shared-launch">4명 공동 플레이 ↗</button>';
localRoot.before(launcher);
const panel = document.createElement("main");
panel.className = "shell shared-panel";
panel.hidden = true;
localRoot.before(panel);
let api = null,
  hole = 0,
  busy = false,
  editing = false,
  editRevision = null,
  status = sharedConfig.url && sharedConfig.publishableKey ? "설정 주입됨 · 실제 연결 미확인" : "배포 설정 누락 · 공동 플레이 연결 불가",
  error = "",
  page = "score",
  gamesList = null,
  selectedSource = "",
  draftName = "",
  draftCode = new URLSearchParams(location.hash.slice(1)).get("join") || "";
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const money = (v) => `${v.toLocaleString("ko-KR")} VND`;
const sum = (a) => a.reduce((s, v) => s + v, 0);
const disabled = (v) => (v ? "disabled" : "");
const actions = {
  score: "타수 변경",
  near: "Near 변경",
  lock: "홀 잠금 변경",
  finalize: "최종 잠금 변경",
  rate: "단가 변경",
  paid: "홀 지급 기록",
  settled: "정산 완료 기록",
  cash: "수금·환급 기록",
  create: "게임 생성",
  join: "게임 참여",
};
function localRounds() {
  try {
    return load(localStorage).filter((r) => r.players.length === 4);
  } catch {
    return [];
  }
}
function checksText() {
  const c = api?.checks;
  return `배포 설정: ${!sharedConfig.url || !sharedConfig.publishableKey ? "누락" : /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(sharedConfig.url) ? "주입됨 (연결은 별도 확인)" : "URL 형식 오류"} · 로그인: ${c?.auth || "미확인"} · 서버 조회: ${c?.query || "미확인"} · RPC: ${c?.rpc || "미확인"}`;
}
function diagnostics() {
  return [...(api?.diagnostics.values() || [])].map(e => `<li>${esc(e.operation)} · ${esc(e.state)} · ${esc(e.time)}${e.error ? ` · 코드 ${esc(e.error.code)}${e.error.status ? ` · HTTP ${esc(e.error.status)}` : ""} · ${esc(e.error.message)} ${esc(e.error.details)} ${esc(e.error.hint)}` : ""}</li>`).join("");
}
function updateDiagnostics() {
  const list = panel.querySelector("#shared-diagnostics");
  if (list) list.innerHTML = diagnostics();
  const alert = panel.querySelector("#shared-error");
  const failures = [...(api?.diagnostics.values() || [])].filter(e => e.state === "실패");
  const text = [error, ...failures.map(e => `${e.operation} 실패 · ${e.error.code}: ${e.error.message}`)].filter(Boolean).join("\n");
  if (alert) { alert.textContent = text; alert.hidden = !text; }
}
function setStatus(value) {
  status = value;
  const el = panel.querySelector("#shared-status");
  if (el) el.textContent = value;
  const checks = panel.querySelector("#shared-checks");
  if (checks) checks.textContent = checksText();
  updateDiagnostics();
}
async function connection() {
  if (!api)
    api = await connectShared(() => {
      if (!editing && !busy) render();
    }, setStatus);
  return api;
}
function lobby() {
  return `<h1>4명 공동 플레이</h1><button data-shared="check">연결 확인 (익명 로그인·서버 조회)</button><p>각자의 휴대폰에서 같은 스코어를 입력하고 확인하세요. 공동 게임은 인터넷 연결이 필요합니다.</p><div class="card"><label for="shared-name">내 표시 이름 (변경 이력에 기록)</label><input id="shared-name" maxlength="40" placeholder="예: 민수" value="${esc(draftName)}"><label for="shared-code">참여 코드</label><input id="shared-code" autocapitalize="characters" maxlength="12" value="${esc(draftCode)}"><button class="primary" data-shared="join">코드로 참여</button></div><div class="card"><h3>공동 게임 생성</h3><p class="muted">로컬에서 선수·골프장·18홀 Par·초기 순위·정산 방식을 설정한 뒤 복사할 수 있습니다. 원본과 기존 스코어·지급·정산 기록은 유지됩니다. 공동 게임 생성 후에는 단가 외 설정이 고정됩니다.</p><label for="shared-source">복사할 라운드</label><select id="shared-source"><option value="">새 후세인 게임 (선수 1~4, 기본 Par)</option>${localRounds()
    .map(
      (r) =>
        `<option value="${esc(r.id)}" ${selectedSource === r.id ? "selected" : ""}>${esc(r.date)} · ${esc(r.course || "이름 없는 골프장")}</option>`,
    )
    .join(
      "",
    )}</select><button class="primary" data-shared="create">공동 게임 생성</button></div><button data-shared="list">내 공동 게임 불러오기</button><div id="shared-list">${gamesList === null ? "" : gamesList.length ? gamesList.map((g) => `<div class="card"><strong>${esc(g.round.course || "공동 라운드")}</strong><p>${esc(g.round.date)} · ${g.finalized ? "최종 확정" : "진행 중"}</p><button data-open-game="${esc(g.id)}">열기</button></div>`).join("") : "<p>참여한 공동 게임이 없습니다.</p>"}</div><p class="muted">설정 누락 시 배포 관리자에게 문의하세요. 새 공동 게임의 선수 이름과 골프장 등은 로컬 라운드에서 설정한 후 복사하세요.</p>`;
}
function gameView() {
  const g = api.game,
    r = g.round,
    c = calculate(r),
    owner = g.owner_id === api.userId,
    locked = g.locked_holes.includes(hole),
    blocked = g.finalized || locked || busy;
  return `<div class="row"><h1>${esc(r.course || "공동 라운드")}</h1><span class="badge">${owner ? "생성자" : "참가자"} · ${api.members.length}/4명</span></div><p>${esc(r.date)} · ${r.mode === "hussein" ? "후세인" : "일반"} · ${g.finalized ? "🔒 최종 정산 확정" : "진행 중"}</p><div class="card"><strong>참여 코드 ${esc(g.code)}</strong><div class="actions"><button data-shared="invite">초대 링크 복사</button><button data-shared="lobby">공동 게임 목록</button></div><p class="muted">${api.members.map((m) => esc(m.name) + (m.user_id === g.owner_id ? " (생성자)" : "")).join(" · ")}</p></div><div class="actions">${[
    ["score", "스코어"],
    ["summary", "현황·정산"],
    ["history", "변경 이력"],
  ]
    .map(
      ([v, t]) =>
        `<button data-page="${v}" class="${page === v ? "primary" : ""}">${t}</button>`,
    )
    .join(
      "",
    )}</div>${page === "score" ? `<div class="hole-grid">${r.holes.map((h, i) => `<button data-shared-hole="${i}" class="${hole === i ? "active" : ""}">${i + 1}${g.locked_holes.includes(i) ? " 🔒" : c.holes[i].confirmed ? " ✓" : ""}</button>`).join("")}</div><h2>${hole + 1}번 홀 · PAR ${r.holes[hole].par}</h2><div class="card">${r.players.map((p, i) => `<label for="shared-score-${i}">${esc(p)}${c.holes[hole].rank?.[1] === i ? " · 2등 / A팀" : ""}</label><input id="shared-score-${i}" type="number" inputmode="numeric" min="1" max="30" data-shared-score="${i}" value="${r.holes[hole].scores[i] ?? ""}" ${disabled(blocked)}>`).join("")}${r.mode === "hussein" && r.holes[hole].par === 3 ? `<label for="shared-near">Near · 별도 1점</label><select id="shared-near" ${disabled(blocked)}><option value="">Near 없음</option>${r.players.map((p, i) => `<option value="${i}" ${r.holes[hole].near === i ? "selected" : ""}>${esc(p)}</option>`).join("")}</select>` : ""}<p class="result">${c.holes[hole].winner ? (c.holes[hole].winner === "tie" ? "무승부" : c.holes[hole].winner + "팀 승리") : "결과 대기"} · 홀 이후 이월 ${c.holes[hole].carry}점</p><p>${locked ? "🔒 잠긴 홀입니다. 생성자가 잠금을 해제한 뒤 수정할 수 있습니다." : "모든 참가자가 모든 선수의 타수와 Near를 수정할 수 있습니다."}</p><button data-shared="lock" ${disabled(busy || g.finalized || (locked && !owner) || !r.holes[hole].scores.every((v) => v !== null))}>${locked ? "홀 잠금 해제 (생성자)" : "이 홀 입력 완료 · 잠금"}</button></div><div class="actions"><button data-shared="prev" ${disabled(hole === 0)}>← 이전 홀</button><button data-shared="next" ${disabled(hole === 17)}>다음 홀 →</button></div>` : page === "history" ? history() : summary(g, r, c, owner)}<p class="muted">서버가 저장을 확인한 뒤 화면에 반영됩니다. 통신이 끊긴 동안에는 공동 스코어를 저장할 수 없습니다.</p>`;
}
function summary(g, r, c, owner) {
  return `<h2>라운드 현황·정산</h2>${!c.complete ? '<p class="warning">미완료 라운드의 임시 정산입니다.</p>' : ""}<div class="grid">${r.players.map((name, i) => `<div class="card"><h3>${esc(name)}</h3><p>총 ${c.totals[i].total}타 · 전반 ${c.totals[i].front} / 후반 ${c.totals[i].back}<br>Par 대비 ${c.totals[i].relative > 0 ? "+" : ""}${c.totals[i].relative}</p>${r.mode === "hussein" ? `<strong>${c.points[i]}점 · 2등 ${c.second[i]}회</strong><p>${r.payment === "post" ? `${c.post.amounts[i] < 0 ? "낼 돈" : "받을 돈"} ${money(Math.abs(c.post.amounts[i]))}` : `예정 수령 ${money(c.points[i] * r.rate)} / 실제 ${money(c.pre.received[i])}`}</p>${r.payment === "post" ? `<p>${r.settled[i] === null ? "정산 대기" : r.settled[i] === c.post.amounts[i] ? "✓ 실제 정산 완료" : "⚠ 금액 변경 · 재정산 필요"}</p>${owner ? `<button data-settle="${i}" ${disabled(busy || g.finalized)}>실제 수금·지급 완료 기록 변경</button>` : ""}` : ""}` : ""}</div>`).join("")}</div>${r.mode === "hussein" ? `<div class="card"><p>현재 이월 ${c.carry}점 · ${money(c.carry * r.rate)}</p>${r.payment === "pre" ? `<p>공동 자금 ${money(c.pre.fund)}<br>예정 지급 ${money(c.pre.expected)} · 실제 지급 ${money(c.pre.actual)}<br>미지급 ${money(c.pre.unpaid)} · 잔액 ${money(c.pre.balance)}<br>예정 상금 부족액 ${money(c.pre.shortage)} · 실제 지급 부족액 ${money(Math.max(0, c.pre.actual - c.pre.fund))}</p>${c.holes.map((h, i) => `<p>${i + 1}홀 · 예정 ${money(sum(h.expected))} / 실제 ${money(sum(h.paid))}${h.stale ? " ⚠ 재정산 필요" : ""} ${owner ? `<button data-pay="${i}" ${disabled(busy || g.finalized || !h.confirmed)}>${h.stale ? "재정산 기록 갱신" : r.holes[i].paid ? "지급 기록 취소" : "지급 완료 기록"}</button>` : ""}</p>`).join("")}${owner ? `<label for="shared-cash-type">실제 거래 종류</label><select id="shared-cash-type"><option value="collect">추가 수금</option><option value="refund">환급</option></select><label for="shared-cash-amount">금액 (VND)</label><input id="shared-cash-amount" type="number" min="1" inputmode="numeric"><button data-shared="cash" ${disabled(busy || g.finalized)}>거래 기록 추가</button>` : ""}${r.cash.map((v, i) => `<p>${v.type === "collect" ? "수금" : "환급"} ${money(v.amount)} ${owner ? `<button data-remove-cash="${i}" ${disabled(busy || g.finalized)}>기록 삭제</button>` : ""}</p>`).join("")}` : `<p>수금 예정 ${money(c.post.collect)} · 지급 예정 ${money(c.post.payout)}<br>정산 차액 ${money(c.post.difference)} (양수: 추가 수금 / 음수: 잔액)<br>차액은 자동 배분하지 않습니다.</p>`}<p class="muted">18홀 이후 남은 이월은 미지급입니다. 이 버튼들은 실제 송금 기능이 아닙니다.</p>${owner ? `<label for="shared-rate">점당 단가 (모든 홀 잠금 해제 후 수정 가능)</label><input id="shared-rate" type="number" min="1" max="10000000" value="${r.rate}" ${disabled(busy || g.finalized || g.locked_holes.length > 0)}>` : ""}</div>` : ""}<div class="card"><h3>최종 정산 확정</h3><p>잠긴 홀 ${g.locked_holes.length}/18 · ${g.finalized ? "최종 잠금 상태" : "미확정"}</p><p>18홀을 모두 잠근 후 생성자가 최종 확정할 수 있습니다. 확정하면 스코어·Near·단가·지급 및 거래 기록도 잠깁니다. 실제 지급 완료 여부는 별도로 확인하세요.</p>${owner ? `<button class="primary" data-shared="finalize" ${disabled(busy || (!g.finalized && g.locked_holes.length !== 18))}>${g.finalized ? "최종 정산 잠금 해제" : "최종 정산 확정 · 전체 잠금"}</button>` : "<p>생성자만 최종 잠금을 변경할 수 있습니다.</p>"}</div>`;
}
function history() {
  return `<h2>최근 변경 이력 (최대 100건)</h2><p class="muted">전체 이력은 서버에 보존됩니다. 이름은 표시 이름이며 사용자 ID도 함께 기록됩니다.</p>${api.audit.map((a) => `<div class="card"><strong>${esc(a.actor_name)} · ${esc(actions[a.action] || a.action)}</strong><p>${esc(new Date(a.created_at).toLocaleString("ko-KR"))}${a.detail.hole !== undefined ? ` · ${a.detail.hole + 1}홀` : ""}${a.detail.player !== undefined ? ` · ${esc(api.game.round.players[a.detail.player])}` : ""}</p>${a.detail.before !== undefined ? `<p>${esc(JSON.stringify(a.detail.before))} → ${esc(JSON.stringify(a.detail.after))}</p>` : ""}<small>${esc(a.actor_id)}</small></div>`).join("")}`;
}
function render() {
  if (panel.hidden) return;
  panel.dataset.revision = api?.game?.revision ?? "";
  panel.innerHTML = `<div class="row"><strong>Golf Score & Hussein · 공동 플레이</strong><button data-shared="local">로컬 라운드로</button></div><p id="shared-status" role="status">${esc(status)}${busy ? " · 저장 중" : ""}</p><p id="shared-checks" class="muted">${esc(checksText())}</p><p id="shared-error" role="alert" class="warning" ${error ? "" : "hidden"}>${esc(error)}</p><details><summary>요청별 진단 결과</summary><ul id="shared-diagnostics">${diagnostics()}</ul></details>${api?.game ? gameView() : lobby()}`;
  updateDiagnostics();
  panel.querySelectorAll("button,input,select").forEach((el) => {
    if (busy) el.disabled = true;
  });
}
function show() {
  panel.hidden = false;
  localRoot.hidden = true;
  launcher.hidden = true;
  document.body.classList.add("shared-mode");
  render();
}
launcher.querySelector("button").addEventListener("click", show);
localRoot.addEventListener("click", (e) => {
  const entry = e.target.closest("[data-shared-entry]");
  if (!entry) return;
  selectedSource = entry.dataset.source || "";
  show();
  panel.querySelector(entry.dataset.sharedEntry === "join" ? "#shared-code" : "#shared-name")?.focus();
});
panel.addEventListener("input", (e) => {
  if (e.target.id === "shared-name") draftName = e.target.value;
  if (e.target.id === "shared-code") draftCode = e.target.value;
  if (e.target.id === "shared-source") selectedSource = e.target.value;
});
panel.addEventListener("focusin", (e) => {
  if (e.target.matches("[data-shared-score],#shared-near,#shared-rate")) {
    editing = true;
    editRevision = api?.game?.revision;
  }
});
panel.addEventListener("focusout", () => {
  editing = false;
  setTimeout(() => {
    if (!busy && !editing && api?.game) render();
  }, 0);
});
async function run(fn) {
  if (busy) return;
  busy = true;
  error = "";
  try {
    const task = fn();
    panel
      .querySelectorAll("button,input,select")
      .forEach((el) => (el.disabled = true));
    await task;
  } catch (e) {
    error = e.operation ? "" : `화면 작업 실패: ${diagnosticText(e.message)}`;

  } finally {
    busy = false;
    editing = false;
    render();
  }
}
async function mutate(action, detail, revision) {
  await api.mutate(action, detail, revision);
}
panel.addEventListener("change", (e) => {
  const el = e.target;
  if (!api?.game) return;
  const revision = editRevision ?? api.game.revision;
  editRevision = null;
  if (el.dataset.sharedScore !== undefined) {
    const value = el.value === "" ? null : Number(el.value);
    run(async () => {
      if (
        value !== null &&
        (!Number.isInteger(value) || value < 1 || value > 30)
      )
        throw Error("타수는 1~30 정수로 입력하세요.");
      await mutate(
        "score",
        { hole, player: +el.dataset.sharedScore, value },
        revision,
      );
    });
  }
  if (el.id === "shared-near")
    run(() =>
      mutate(
        "near",
        { hole, value: el.value === "" ? null : +el.value },
        revision,
      ),
    );
  if (el.id === "shared-rate")
    run(() => mutate("rate", { value: Number(el.value) }, revision));
});
panel.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || busy) return;
  if (b.dataset.page) {
    page = b.dataset.page;
    render();
    return;
  }
  if (b.dataset.sharedHole !== undefined) {
    hole = +b.dataset.sharedHole;
    render();
    return;
  }
  const act = b.dataset.shared;
  if (act === "local") {
    api?.stop();
    panel.hidden = true;
    localRoot.hidden = false;
    launcher.hidden = false;
    document.body.classList.remove("shared-mode");
    return;
  }
  if (act === "lobby") {
    api.stop();
    setStatus("공동 게임 연결 종료 · 목록에서 다시 여세요.");
    render();
    return;
  }
  if (act === "prev" || act === "next") {
    hole += act === "next" ? 1 : -1;
    render();
    return;
  }
  run(async () => {
    if (act === "check") {
      const c = await connection();
      gamesList = await c.list();
      return;
    }
    if (act === "create" || act === "join") {
      const name = panel.querySelector("#shared-name").value.trim();
      if (!name || name.length > 40)
        throw Error("내 표시 이름을 1~40자로 입력하세요.");
      const code = panel.querySelector("#shared-code").value.trim();
      const source = panel.querySelector("#shared-source").value;
      selectedSource = source;
      const c = await connection();
      if (act === "join") {
        await c.join(code, name);
        historyReplace();
      } else {
        const r = source
          ? structuredClone(localRounds().find((r) => r.id === source))
          : createRound("hussein");
        if (!r) throw Error("로컬 라운드를 다시 선택하세요.");
        await c.create(r, name);
      }
      hole = 0;
      page = "score";
    }
    if (act === "list") {
      const c = await connection();
      gamesList = await c.list();
      return;
    }
    if (b.dataset.openGame) {
      await api.open(b.dataset.openGame);
      page = "score";
    }
    if (act === "invite") {
      const url = new URL(location.href);
      url.hash = `join=${api.game.code}`;
      await navigator.clipboard.writeText(url.href);
      setStatus("초대 링크를 복사했습니다. 나머지 3명에게 전달하세요.");
    }
    if (act === "lock")
      await mutate("lock", {
        hole,
        value: !api.game.locked_holes.includes(hole),
      });
    if (act === "finalize" && confirm("최종 정산 잠금을 변경하시겠습니까?"))
      await mutate("finalize", { value: !api.game.finalized });
    const r = api?.game?.round,
      c = r ? calculate(r) : null;
    if (
      b.dataset.settle !== undefined &&
      confirm("실제 수금·지급을 처리한 뒤 기록을 변경하세요.")
    ) {
      const i = +b.dataset.settle;
      await mutate("settled", {
        player: i,
        value: r.settled[i] === c.post.amounts[i] ? null : c.post.amounts[i],
      });
    }
    if (
      b.dataset.pay !== undefined &&
      confirm("실제 지급 또는 재정산을 처리했습니까? 기록을 변경합니다.")
    ) {
      const i = +b.dataset.pay;
      await mutate("paid", {
        hole: i,
        value:
          r.holes[i].paid && !c.holes[i].stale ? null : c.holes[i].expected,
      });
    }
    if (act === "cash") {
      const amount = +panel.querySelector("#shared-cash-amount").value,
        type = panel.querySelector("#shared-cash-type").value;
      if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1e10)
        throw Error("올바른 거래 금액을 입력하세요.");
      if (confirm("실제 수금·환급을 거래로 기록합니까?"))
        await mutate("cash", { value: [...r.cash, { type, amount }] });
    }
    if (
      b.dataset.removeCash !== undefined &&
      confirm("거래 기록을 삭제합니까?")
    )
      await mutate("cash", {
        value: r.cash.filter((_, i) => i !== +b.dataset.removeCash),
      });
  });
});
function historyReplace() {
  if (location.hash.startsWith("#join="))
    window.history.replaceState(null, "", location.pathname + location.search);
}
if (new URLSearchParams(location.hash.slice(1)).has("join")) show();
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) api?.refresh();
});
window.addEventListener("online", () => api?.refresh());
