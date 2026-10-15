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
  draftInitial = null,
  draftPlayers = null,
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
const nameDrafts = new Map();
const playerNameDrafts = new Map();
const isSharedRound = r => r.slotPolicyVersion === 1;
const hasModernPolicy = r => r.gamePolicyVersion === 1 || r.slotPolicyVersion === 1;
const isSoloRound = r => r.mode === "normal" && hasModernPolicy(r) && !isSharedRound(r);
// A selection is a local draft, never inferred from a refreshed server row.
const slotDrafts = new Map();
const slotDraftKey = () => `${api.game.id}:${api.userId}`;
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
  initial: "초기 순위 변경", name: "계정 표시 이름 변경", player_name: "선수 이름 변경", slot: "선수 슬롯 연결",
};
function localRounds() {
  try {
    return load(localStorage).filter(r => r.mode === "normal" || r.players.length === 4);
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
 const source = localRounds().find(r=>r.id===selectedSource);
 const players = draftPlayers || source?.players || ["","","",""];
 const initial = draftInitial || source?.initial || [0,1,2,3];
 return `<h1>공동 플레이 · 일반 게임 관리</h1><button data-shared="check">연결 확인 (익명 로그인·서버 조회)</button><div class="card"><label for="shared-name">계정 표시 이름 (선수 이름과 별개)</label><input id="shared-name" maxlength="40" value="${esc(draftName)}"><label for="shared-code">참여 코드</label><input id="shared-code" autocapitalize="characters" maxlength="12" value="${esc(draftCode)}"><button class="primary" data-shared="join">등록된 선수 확인</button><p>참여 후 생성자가 등록한 선수 중 본인을 선택하세요. 선수 이름과 초기 순위는 생성자만 수정합니다.</p></div><div class="card"><h3>게임 생성 · 선수 등록</h3><label for="shared-source">복사할 라운드</label><select id="shared-source"><option value="">새 후세인 공동 게임</option>${localRounds().map(r=>`<option value="${esc(r.id)}" ${selectedSource===r.id?"selected":""}>${esc(r.date)} · ${esc(r.course || "이름 없는 골프장")}</option>`).join("")}</select><p>생성자가 선수 이름을 등록합니다. 복사 시 기존 점수·정산 기록의 선수 순서를 유지하세요.</p>${players.map((name,i)=>`<label for="shared-draft-player-${i}">선수 ${i+1} 이름</label><input id="shared-draft-player-${i}" data-draft-player="${i}" maxlength="40" value="${esc(name)}">`).join("")}${!source || source.mode==='hussein'?`<p>초기 순위</p>${initial.map((slot,rank)=>`<label>${rank+1}등<select data-draft-rank="${rank}">${players.map((name,i)=>`<option value="${i}" ${slot===i?"selected":""}>슬롯 ${i+1} · ${esc(name)}</option>`).join("")}</select></label>`).join("")}`:""}<button class="primary" data-shared="create">게임 생성</button><p>공동 게임은 생성자도 본인 선수를 직접 선택합니다. 일반 게임은 생성자가 혼자 관리합니다.</p></div><button data-shared="list">내 공동 게임 불러오기</button><div id="shared-list">${gamesList===null?"":gamesList.length?gamesList.map(g=>`<div class="card"><strong>${esc(g.round.course || "라운드")}</strong><p>${esc(g.round.date)} · ${g.finalized?"최종 확정":"진행 중"}</p><button data-open-game="${esc(g.id)}">열기</button></div>`).join(""):"<p>참여한 게임이 없습니다.</p>"}</div>`;
}
function roster(g, r, owner) {
 const me = api.members.find(m=>m.user_id===api.userId);
 const shared = isSharedRound(r);
 const modern = hasModernPolicy(r);
 const key = slotDraftKey();
 const selected = slotDrafts.get(key) || "";
 const available = r.players.map((_,i)=>i).filter(i=>!api.members.some(m=>m.slot===i));
 const valid = available.some(i=>String(i)===selected);
 if(me?.slot!=null)slotDrafts.delete(key);
 return `<div class="card"><h3>등록 선수 · ${owner&&modern?"생성자만 이름·초기 순위 수정 가능":"등록 명단"}</h3>${r.players.map((name,i)=>`<p>슬롯 ${i+1}: ${esc(name)} ${shared?(api.members.some(m=>m.slot===i)?"✓ 연결됨":"· 연결 대기"):""}</p>${owner&&modern?`<label for="shared-player-name-${i}">선수 ${i+1} 이름 수정</label><input id="shared-player-name-${i}" data-player-name="${i}" maxlength="40" value="${esc(playerNameDrafts.get(g.id+":"+i) ?? name)}" ${disabled(busy||g.finalized)}><button data-shared="player-name" data-player="${i}" ${disabled(busy||g.finalized)}>선수 이름 저장</button>`:""}`).join("")}${modern?`<label for="shared-my-name">내 계정 표시 이름</label><input id="shared-my-name" maxlength="40" value="${esc(nameDrafts.get(g.id) ?? me?.name)}" ${disabled(busy||g.finalized)}><button data-shared="rename" ${disabled(busy||g.finalized)}>이름 저장</button><p class="muted">계정 표시 이름은 변경 이력에만 사용합니다. 등록 선수 이름은 바뀌지 않습니다.</p>`:""}${shared&&me?.slot!=null?`<p class="badge">내 선수: ${esc(r.players[me.slot])} · 슬롯 ${me.slot+1}</p>`:""}${shared&&me&&me.slot==null?`<label for="shared-slot">생성자가 등록한 선수 중 본인을 선택하세요</label><select id="shared-slot" ${disabled(busy||g.finalized)}><option value="" ${!valid?"selected":""}>본인 선수를 선택하세요</option>${r.players.map((name,i)=>`<option value="${i}" ${selected===String(i)&&valid?"selected":""} ${disabled(!available.includes(i))}>${esc(name)} · 슬롯 ${i+1}${available.includes(i)?"":" (이미 선택됨)"}</option>`).join("")}</select><button data-shared="claim" ${disabled(!valid||busy||g.finalized)}>내 선수 슬롯 연결</button>`:""}${r.mode==='hussein'?`<p>초기 순위</p>${r.initial.map((slot,rank)=>owner&&modern?`<label>${rank+1}등<select data-initial="${rank}" ${disabled(busy||g.finalized||g.locked_holes.length>0)}>${r.players.map((name,i)=>`<option value="${i}" ${slot===i?"selected":""}>${esc(name)}</option>`).join("")}</select></label>`:`<p>${rank+1}등: ${esc(r.players[slot])}</p>`).join("")}`:""}</div>`;
}
function holeWon(x,j){return x.winner==='A'?x.hussein===j:x.winner==='B'?x.allies?.includes(j):false;}
function holeRole(x,j,first){
 if(!x.previousRank)return '<span class="badge">앞선 홀 입력 후 팀 확정</span>';
 return x.hussein===j?'<span class="badge hussein-badge">현재 후세인</span>':`<span class="badge">연합군 · ${first?'초기':'직전 홀'} ${x.previousRank.indexOf(j)+1}등</span>`;
}
function holeResult(r,h,x){
 return `<div class="result ${x.winner?.toLowerCase()||''}" aria-live="polite"><strong class="result-title">${x.winner==='A'?'후세인 승':x.winner==='B'?'연합군 승':x.winner==='tie'?'무승부 · 다음 홀로 이월':'결과 대기'}</strong><p class="muted">${x.previousRank?'팀 기준: '+(r.holes.indexOf(h)===0?'라운드 초기 순위':'직전 홀 최종 순위'):'앞선 홀의 타수를 먼저 입력하세요.'}</p>${x.confirmed?`<p>현재 후세인: ${esc(r.players[x.hussein])} · ${h.scores[x.hussein]}타<br>연합군 기준 1·3등 평균: ${(h.scores[x.previousRank[0]]+h.scores[x.previousRank[2]])/2}타<br>기본 3점 + 이전 이월 ${x.carryIn}점 · 홀 이후 이월 ${x.carry}점</p>`:'<p>이 홀과 앞선 홀의 4명 타수를 모두 입력하면 결과가 확정됩니다.</p>'}</div><div class="next-hussein">${x.confirmed?`<strong>다음 홀 후세인: ${esc(r.players[x.rank[1]])}</strong><p class="muted">현재 홀 최종 2등 · ${r.holes.indexOf(h)===17?'마지막 홀이므로 다음 홀은 없습니다.':'다음 홀에 적용됩니다.'}</p>`:'다음 홀 후세인: 입력 완료 후 확정'}</div>`;
}


function gameView() {
  const g = api.game,
    r = g.round,
    c = calculate(r),
    owner = g.owner_id === api.userId,
    locked = g.locked_holes.includes(hole),
    blocked = g.finalized || locked || busy || (isSoloRound(r) && !owner),
    awaiting = isSharedRound(r) && api.members.find(m=>m.user_id===api.userId)?.slot == null;
  return `<div class="row"><h1>${esc(r.course || "공동 라운드")}</h1><span class="badge">${owner ? "생성자" : "참가자"} · ${api.members.length}/${r.players.length}명</span></div><p>${esc(r.date)} · ${r.mode === "hussein" ? "후세인" : "일반"} · ${g.finalized ? "🔒 최종 정산 확정" : "진행 중"}</p><div class="card"><strong>참여 코드 ${esc(g.code)}</strong><div class="actions">${owner && !isSoloRound(r)?`<button data-shared="invite">초대 링크 복사</button>`:""}<button data-shared="lobby">공동 게임 목록</button></div><p class="muted">${api.members.map((m) => esc(m.name) + (m.user_id === g.owner_id ? " (생성자)" : "")).join(" · ")}</p></div><div class="actions">${[
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
    )}</div>${roster(g, r, owner)}${awaiting ? "<p>본인 선수를 선택하면 스코어 입력 화면이 열립니다.</p>" : page === "score" ? `<div class="hole-grid">${r.holes.map((h, i) => `<button data-shared-hole="${i}" class="${hole === i ? "active" : ""}">${i + 1}${g.locked_holes.includes(i) ? " 🔒" : c.holes[i].confirmed ? " ✓" : ""}</button>`).join("")}</div><h2>${hole + 1}번 홀 · PAR ${r.holes[hole].par}</h2><div class="card">${r.players.map((p, i) => {const x=c.holes[hole];return `<div class="score ${r.mode==='hussein'&&x.hussein===i?'current-hussein':''} ${holeWon(x,i)?'winner-card':''}"><div><label for="shared-score-${i}">${esc(p)}</label>${r.mode==='hussein'?holeRole(x,i,hole===0):''}${holeWon(x,i)?'<span class="badge victory">✓ 승리</span>':''}${x.rank?`<small>현재 홀 ${x.rank.indexOf(i)+1}등</small>`:'' }${r.mode==='hussein'&&x.confirmed?`<small class="money">이번 홀 ${x.earned[i]}점 · ${money(x.expected[i])}${r.holes[hole].par===3&&r.holes[hole].near===i?' (Near 1점 포함)':''}</small>`:''}</div><input id="shared-score-${i}" type="number" inputmode="numeric" min="1" max="30" data-shared-score="${i}" value="${r.holes[hole].scores[i] ?? ""}" ${disabled(blocked)}></div>`;}).join("")}${r.mode === "hussein" && r.holes[hole].par === 3 ? `<label for="shared-near">Near · 별도 1점</label><select id="shared-near" ${disabled(blocked)}><option value="">Near 없음</option>${r.players.map((p, i) => `<option value="${i}" ${r.holes[hole].near === i ? "selected" : ""}>${esc(p)}</option>`).join("")}</select>` : ""}${r.mode==="hussein"?holeResult(r,r.holes[hole],c.holes[hole]):""}<p>${locked ? "🔒 잠긴 홀입니다. 생성자가 잠금을 해제한 뒤 수정할 수 있습니다." : "모든 참가자가 모든 선수의 타수와 Near를 수정할 수 있습니다."}</p><button data-shared="lock" ${disabled(busy || g.finalized || (locked && !owner) || !r.holes[hole].scores.every((v) => v !== null) || (!locked && isSharedRound(r) && api.members.filter(m=>m.slot != null).length !== r.players.length) || (!owner && isSoloRound(r)))}>${locked ? "홀 잠금 해제 (생성자)" : "이 홀 입력 완료 · 잠금"}</button></div><div class="actions"><button data-shared="prev" ${disabled(hole === 0)}>← 이전 홀</button><button data-shared="next" ${disabled(hole === 17)}>다음 홀 →</button></div>` : page === "history" ? history() : summary(g, r, c, owner)}<p class="muted">서버가 저장을 확인한 뒤 화면에 반영됩니다. 통신이 끊긴 동안에는 공동 스코어를 저장할 수 없습니다.</p>`;
}
function summary(g, r, c, owner) {
  return `<h2>라운드 현황·정산</h2><div class="card"><h3>홀별 기록</h3>${r.holes.map((h,hole)=>`<p>${hole+1}홀 · ${r.players.map((name,i)=>`${esc(name)} ${h.scores[i]??"—"}타${r.mode==="hussein"&&c.holes[hole].hussein===i?" (현재 후세인)":""}`).join(" · ")}</p>`).join("")}</div>${!c.complete ? '<p class="warning">미완료 라운드의 임시 정산입니다.</p>' : ""}<div class="grid">${r.players.map((name, i) => `<div class="card"><h3>${esc(name)}</h3><p>총 ${c.totals[i].total}타 · 전반 ${c.totals[i].front} / 후반 ${c.totals[i].back}<br>Par 대비 ${c.totals[i].relative > 0 ? "+" : ""}${c.totals[i].relative}</p>${r.mode === "hussein" ? `<strong>${c.points[i]}점 · 2등 ${c.second[i]}회</strong><p>${r.payment === "post" ? `${c.post.amounts[i] < 0 ? "낼 돈" : "받을 돈"} ${money(Math.abs(c.post.amounts[i]))}` : `예정 수령 ${money(c.points[i] * r.rate)} / 실제 ${money(c.pre.received[i])}`}</p>${r.payment === "post" ? `<p>${r.settled[i] === null ? "정산 대기" : r.settled[i] === c.post.amounts[i] ? "✓ 실제 정산 완료" : "⚠ 금액 변경 · 재정산 필요"}</p>${owner ? `<button data-settle="${i}" ${disabled(busy || g.finalized)}>실제 수금·지급 완료 기록 변경</button>` : ""}` : ""}` : ""}</div>`).join("")}</div>${r.mode === "hussein" ? `<div class="card"><p>현재 이월 ${c.carry}점 · ${money(c.carry * r.rate)}</p>${r.payment === "pre" ? `<p>공동 자금 ${money(c.pre.fund)}<br>예정 지급 ${money(c.pre.expected)} · 실제 지급 ${money(c.pre.actual)}<br>미지급 ${money(c.pre.unpaid)} · 잔액 ${money(c.pre.balance)}<br>예정 상금 부족액 ${money(c.pre.shortage)} · 실제 지급 부족액 ${money(Math.max(0, c.pre.actual - c.pre.fund))}</p>${c.holes.map((h, i) => `<p>${i + 1}홀 · 예정 ${money(sum(h.expected))} / 실제 ${money(sum(h.paid))}${h.stale ? " ⚠ 재정산 필요" : ""} ${owner ? `<button data-pay="${i}" ${disabled(busy || g.finalized || !h.confirmed)}>${h.stale ? "재정산 기록 갱신" : r.holes[i].paid ? "지급 기록 취소" : "지급 완료 기록"}</button>` : ""}</p>`).join("")}${owner ? `<label for="shared-cash-type">실제 거래 종류</label><select id="shared-cash-type"><option value="collect">추가 수금</option><option value="refund">환급</option></select><label for="shared-cash-amount">금액 (VND)</label><input id="shared-cash-amount" type="number" min="1" inputmode="numeric"><button data-shared="cash" ${disabled(busy || g.finalized)}>거래 기록 추가</button>` : ""}${r.cash.map((v, i) => `<p>${v.type === "collect" ? "수금" : "환급"} ${money(v.amount)} ${owner ? `<button data-remove-cash="${i}" ${disabled(busy || g.finalized)}>기록 삭제</button>` : ""}</p>`).join("")}` : `<p>수금 예정 ${money(c.post.collect)} · 지급 예정 ${money(c.post.payout)}<br>정산 차액 ${money(c.post.difference)} (양수: 추가 수금 / 음수: 잔액)<br>차액은 자동 배분하지 않습니다.</p>`}<p class="muted">18홀 이후 남은 이월은 미지급입니다. 이 버튼들은 실제 송금 기능이 아닙니다.</p>${owner ? `<label for="shared-rate">점당 단가 (모든 홀 잠금 해제 후 수정 가능)</label><input id="shared-rate" type="number" min="1" max="10000000" value="${r.rate}" ${disabled(busy || g.finalized || g.locked_holes.length > 0)}>` : ""}</div>` : ""}<div class="card"><h3>최종 정산 확정</h3><p>잠긴 홀 ${g.locked_holes.length}/18 · ${g.finalized ? "최종 잠금 상태" : "미확정"}</p><p>18홀을 모두 잠근 후 생성자가 최종 확정할 수 있습니다. 확정하면 스코어·Near·단가·지급 및 거래 기록도 잠깁니다. 실제 지급 완료 여부는 별도로 확인하세요.</p>${owner ? `<button class="primary" data-shared="finalize" ${disabled(busy || (!g.finalized && g.locked_holes.length !== 18))}>${g.finalized ? "최종 정산 잠금 해제" : "최종 정산 확정 · 전체 잠금"}</button>` : "<p>생성자만 최종 잠금을 변경할 수 있습니다.</p>"}</div>`;
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
  draftPlayers = null; draftInitial = null;
  show();
  panel.querySelector(entry.dataset.sharedEntry === "join" ? "#shared-code" : "#shared-name")?.focus();
});
panel.addEventListener("input", (e) => {
  if (e.target.dataset.draftPlayer !== undefined) {
    if(!draftPlayers)draftPlayers=[...(localRounds().find(r=>r.id===selectedSource)?.players || ["","","",""])];
    draftPlayers[Number(e.target.dataset.draftPlayer)]=e.target.value;
  }
  if (e.target.dataset.playerName !== undefined && api?.game) playerNameDrafts.set(api.game.id+":"+e.target.dataset.playerName,e.target.value);
  if (e.target.id === "shared-slot" && api?.game) slotDrafts.set(slotDraftKey(), e.target.value);
  if (e.target.id === "shared-my-name" && api?.game) nameDrafts.set(api.game.id,e.target.value);
  if (e.target.id === "shared-name") draftName = e.target.value;
  if (e.target.id === "shared-code") draftCode = e.target.value;
  if (e.target.id === "shared-source") selectedSource = e.target.value;
});
panel.addEventListener("focusin", (e) => {
  if (e.target.matches("[data-shared-score],#shared-near,#shared-rate,#shared-my-name,#shared-slot,[data-initial],[data-player-name],[data-draft-player]")) {
    editing = true;
    editRevision = api?.game?.revision;
  }
});
panel.addEventListener("focusout", (e) => {
  if (!e.target.matches("[data-shared-score],#shared-near,#shared-rate,#shared-my-name,#shared-slot,[data-initial],[data-player-name],[data-draft-player]")) return;
  editing = false;
  // Do not replace the save button between WebKit mousedown and click.
  if (e.target.id === "shared-my-name" || e.target.id === "shared-slot" || e.target.dataset.playerName !== undefined) { editRevision = null; return; }
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
  if (el.id === "shared-source") {selectedSource=el.value; draftInitial=null; draftPlayers=null; render();}
  if (el.dataset.draftRank !== undefined) {
    const initial=[...(draftInitial || localRounds().find(r=>r.id===selectedSource)?.initial || [0,1,2,3])], rank=+el.dataset.draftRank, other=initial.indexOf(+el.value);
    [initial[rank],initial[other]]=[initial[other],initial[rank]]; draftInitial=initial; render();
  }
  if (!api?.game) return;
  if (el.id === "shared-slot") {
    slotDrafts.set(slotDraftKey(), el.value);
    const claim = panel.querySelector('[data-shared="claim"]');
    if (claim) claim.disabled = busy || api.game.finalized || !/^[0-3]$/.test(el.value) || api.members.some(m => m.slot === Number(el.value));
    return;
  }
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
  if (el.dataset.initial !== undefined) {
    const initial = [...api.game.round.initial], rank = +el.dataset.initial, slot = +el.value;
    const other = initial.indexOf(slot);
    [initial[rank], initial[other]] = [initial[other], initial[rank]];
    run(() => mutate("initial", {value:initial}, revision));
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
  // Capture before disabling controls or opening the native Safari dialog.
  const playerNameValue = act === "player-name" ? (playerNameDrafts.get(api.game.id+":"+b.dataset.player) ?? panel.querySelector(`#shared-player-name-${b.dataset.player}`).value).trim() : null;
  const selectedSlot = act === "claim" ? panel.querySelector("#shared-slot")?.value : null;
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
        if (draftInitial) r.initial=[...draftInitial];
        r.players = [...(draftPlayers || r.players)].map(v=>v.trim());
        if(!source && !draftPlayers)throw Error("선수 4명의 이름을 먼저 입력하세요.");
        r.sharedSlots = r.mode === "hussein" || r.sharedSlots === true;
        if(r.sharedSlots)r.slotPolicyVersion=1;else delete r.slotPolicyVersion;
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
    if (act === "player-name") {
      await mutate("player_name", {player:Number(b.dataset.player), value:playerNameValue});
      playerNameDrafts.delete(api.game.id+":"+b.dataset.player);
    }
    if (act === "rename") { await mutate("name", {value:(nameDrafts.get(api.game.id) ?? panel.querySelector("#shared-my-name").value).trim()}); nameDrafts.delete(api.game.id); }
    if (act === "claim") {
      if (!/^[0-3]$/.test(selectedSlot ?? "") || api.members.some(m => m.slot === Number(selectedSlot)))
        throw Error("연결할 수 있는 선수 슬롯을 다시 선택하세요.");
      if (confirm("선택한 선수가 본인인지 확인하세요. 기존 기록과 선수 이름은 유지되며 연결 후 슬롯을 변경할 수 없습니다.")) {
        await api.claimSlot(Number(selectedSlot));
        slotDrafts.delete(slotDraftKey());
      }
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
