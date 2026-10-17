// Browser + actual PostgreSQL rules via PGlite. The SDK transport below is a
// TEST adapter, not Supabase Realtime/Auth. Live Supabase smoke testing is separate.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { chromium, webkit } from "playwright";
import { PGlite } from "@electric-sql/pglite";
import { createRound } from "../engine.js";
async function setStroke(page, player, stroke) {
 const group=page.locator(`#shared-score-${player}`);
 if(await group.getAttribute('data-stroke')===String(stroke))return;
 const par=await page.locator('h2').filter({hasText:/번 홀 · PAR/}).innerText().then(t=>Number(t.match(/PAR (\d+)/)[1]));
 const value=stroke===''?'':Number(stroke)-par;
 if(value!==''&&(value< -1||value>4))await group.locator('details').evaluate(el=>el.open=true);
 await group.locator(`[data-value="${value}"]`).click();
}
async function joinAs(page,code,slot=null){
 await page.locator('#shared-code').fill(code);await page.locator('[data-shared="lookup"]').click();
 await page.waitForFunction(()=>!document.querySelector('[data-shared="local"]').disabled&&document.querySelector('[data-shared="join"]'));
 if(slot!==null)await page.locator('#shared-join-player').selectOption(String(slot));
 await page.locator('[data-shared="join"]').click();await page.locator('#shared-score-0').waitFor();
}
const db = new PGlite();
await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;create publication supabase_realtime;`);
await db.exec(
  readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8"),
);
await db.exec(readFileSync(new URL('../supabase/004-code-player-join.sql',import.meta.url),'utf8'));
const users = Array.from(
  { length: 5 },
  (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
);
for (const id of users)
  await db.query("insert into auth.users values ($1)", [id]);
const events = new Set();
const mutationRequests = [];
let queue = Promise.resolve();
async function request(body) {
  if (body.connectionFailure) throw Error('connection probe unavailable');
  const uid = users[body.user];
  if (!uid) throw Error("test user");
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid]);
  await db.exec("set role authenticated");
  if (body.rpc) {
    if (["golf_mutate","golf_join_player","golf_create_player"].includes(body.rpc)) mutationRequests.push(structuredClone(body.args));
    const keys = {
      golf_create: ["p_round", "p_name"],
      golf_join: ["p_code", "p_name"],
      golf_roster_by_code:["p_code"],golf_join_player:["p_code","p_player","p_expected_name"],golf_create_player:["p_round","p_player"],
      golf_mutate: ["p_game", "p_revision", "p_action", "p_detail"],
    }[body.rpc];
    if (!keys) throw Error("test rpc");
    const result = await db.query(
      `select to_jsonb(public.${body.rpc}(${keys.map((_, i) => "$" + (i + 1)).join(",")})) as g`,
      keys.map((k) => body.args[k]),
    );
    for (const res of events) res.write("data: changed\n\n");
    return body.rpc==='golf_roster_by_code'?result.rows[0].g:[result.rows[0].g];
  }
  if (!["golf_games", "golf_members", "golf_audit"].includes(body.table))
    throw Error("test table");
  let sql = `select * from public.${body.table}`,
    args = [];
  if (body.filter) {
    const [field, value] = body.filter;
    if (!["id", "game_id"].includes(field)) throw Error("test filter");
    sql += ` where ${field}=$1`;
    args = [value];
  }
  if (body.order) {
    const { field, ascending = true } = body.order;
    if (!["id", "updated_at", "joined_at"].includes(field))
      throw Error("test order");
    sql += ` order by ${field} ${ascending ? "asc" : "desc"}`;
  }
  if (body.limit) sql += " limit 100";
  const rows = (await db.query(sql, args)).rows;
  return body.single ? rows[0] : rows;
}
const basePath = "/my-first-codex-app";
const root = resolve(new URL("..", import.meta.url).pathname);
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  // Serve the test transport over HTTP: browser routing cannot reliably
  // intercept module fetches owned by an active worker (notably WebKit).
  if (url.pathname === "/__sdk.js") {
    res.setHeader("Content-Type", "application/javascript");
    res.end(sdk);
    return;
  }
  if (url.pathname === "/__events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    res.write(": connected\n\n");
    events.add(res);
    req.on("close", () => events.delete(res));
    return;
  }
  if (url.pathname === "/__db") {
    let text = "";
    for await (const chunk of req) text += chunk;
    const task = queue.then(() => request(JSON.parse(text)));
    queue = task.catch(() => {});
    try {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: await task }));
    } catch (e) {
      res.end(JSON.stringify({ error: { message: e.message } }));
    }
    return;
  }
  if (!url.pathname.startsWith(basePath + "/")) { res.writeHead(404).end(); return; }
  url.pathname = url.pathname.slice(basePath.length);
  if (url.pathname === "/shared-config.js") {
    res.setHeader("Content-Type", "application/javascript");
    res.end(
      "export const sharedConfig={url:'https://test.supabase.co',publishableKey:'test-public'}",
    );
    return;
  }
  const file = resolve(
    root,
    "." + (url.pathname === "/" ? "/index.html" : url.pathname),
  );
  if (!file.startsWith(root + "/")) {
    res.writeHead(403).end();
    return;
  }
  try {
    res.setHeader(
      "Content-Type",
      {
        ".js": "application/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".webmanifest": "application/manifest+json",
      }[extname(file)] || "application/octet-stream",
    );
    const source = readFileSync(file);
    res.end(url.pathname === "/shared.js" ? source.toString().replace(
      "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm",
      "/__sdk.js",
    ) : source);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
async function stopOrigin() {
  if (!server.listening) return;
  const closed = new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()),
  );
  for (const res of events) res.end();
  server.closeAllConnections();
  await closed;
}
const sdk = `export function createClient(){
 window.__testUser ??= Number(new URL(location.href).searchParams.get("account")||0);
 const call=async body=>{if(body.table==='golf_games' && body.limit===1){window.__connectionProbes=(window.__connectionProbes||0)+1;body.connectionFailure=!!window.__connectionFailure;if(window.__holdConnection)await window.__holdConnection;}if(body.table==='golf_members' && window.__holdMembers){window.__membersPending=true;await window.__holdMembers;}return fetch('/__db',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,user:window.__testUser})}).then(r=>r.json());};
 return {auth:{async getUser(){return {data:{user:{id:'00000000-0000-4000-8000-'+String(window.__testUser+1).padStart(12,'0')}}}},async getSession(){return {data:{session:null}}},async signInAnonymously(){return {data:{session:{user:{id:'00000000-0000-4000-8000-'+String(window.__testUser+1).padStart(12,'0')}}}}}},
 rpc:(rpc,args)=>call({rpc,args}),from(table){let body={table};const q={select(){return q},eq(k,v){body.filter=[k,v];return q},order(field,o={}){body.order={field,...o};return q},limit(n){body.limit=n;return q},single(){body.single=true;return q},then(a,b){return call(body).then(a,b)}};return q},
 channel(){let cb,es;const c={on(e,f,fn){cb=fn;return c},subscribe(fn){fn('SUBSCRIBED');es=new EventSource('/__events');es.onmessage=()=>cb();es.onopen=()=>fn('SUBSCRIBED');return c},close(){es?.close()}};return c},removeChannel(c){c.close()}}}
`;
if (process.env.SCORECARD_PREVIEW === "1") {
  console.log(`Isolated preview (temporary test DB, no Supabase): ${origin}${basePath}/?account=0`);
  console.log(`Participant: ${origin}${basePath}/?account=1 (use the created game's join code). Ctrl+C stops the preview.`);
  await new Promise(() => {});
}
const browserType = process.env.BROWSER === "webkit" ? webkit : chromium;
const browser = await browserType.launch({
  headless: true,
  executablePath:
    browserType === webkit ? undefined : process.env.CHROMIUM_PATH ||
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
  args: browserType === chromium ? ["--no-sandbox"] : [],
});
const contexts = [],
  pages = [],
  errors = [];
async function waitSaved(p) {
  await p.waitForFunction(
    () =>
      !document.querySelector(
        '.shared-panel button:disabled[data-shared="local"]',
      ),
  );
}
async function waitSynced() {
  const task = queue.then(() => request({user:0,table:"golf_games"}));
  queue = task.catch(() => {});
  const revision = (await task)[0].revision;
  for (const p of pages.slice(0,4)) await p.evaluate(() => document.activeElement?.blur());
  for (const p of pages.slice(0,4)) await p.waitForFunction(v => Number(document.querySelector(".shared-panel").dataset.revision) === Number(v), revision);
}
try {
  for (let i = 0; i < 5; i++) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: "block",
    });
    contexts.push(context);
    await context.addInitScript((i) => {
      window.__testUser = i;
    }, i);
    const p = await context.newPage();
    p.on("dialog", d=>d.accept());
    p.on("pageerror", (e) => errors.push(e.message));
    pages.push(p);
    await p.goto(origin + basePath + "/");
    await p.getByRole("button", { name: i === 0 ? "새 공동 게임 생성" : "참여 코드로 참여", exact: true }).click();
    await p.waitForFunction(() => document.querySelector('#connection-signal')?.dataset.state === 'ready');
    assert.equal(await p.evaluate(()=>window.__connectionProbes>0),true);
    assert.equal(await p.locator('#shared-debug').evaluate(el=>el.open),false);
    assert.equal(await p.locator("#shared-launch,#shared-name").count(),0);
  }
  const healthPage=pages[4];
  await healthPage.evaluate(()=>{window.__connectionFailure=true;window.dispatchEvent(new Event('online'));});
  await healthPage.waitForFunction(()=>document.querySelector('#connection-signal').dataset.state==='error');
  assert.equal(await healthPage.locator('#connection-retry').isEnabled(),true);
  const probes=await healthPage.evaluate(()=>window.__connectionProbes);
  await healthPage.evaluate(()=>{window.__connectionFailure=false;window.__holdConnection=new Promise(resolve=>window.__releaseConnection=resolve);});
  await healthPage.locator('#connection-retry').click();
  await healthPage.waitForFunction(()=>window.__connectionProbes>0 && document.querySelector('#connection-signal').dataset.state==='checking');
  await healthPage.evaluate(()=>{window.__releaseConnection();window.__holdConnection=null;});
  await healthPage.waitForFunction(()=>document.querySelector('#connection-signal').dataset.state==='ready');
  assert.ok(await healthPage.evaluate(()=>window.__connectionProbes)>probes);
  await healthPage.evaluate(()=>{window.__connectionFailure=true;window.dispatchEvent(new Event('online'));});
  await healthPage.waitForFunction(()=>document.querySelector('#connection-signal').dataset.state==='error');
  await healthPage.evaluate(()=>{window.__connectionFailure=false;window.dispatchEvent(new Event('online'));});
  await healthPage.waitForFunction(()=>document.querySelector('#connection-signal').dataset.state==='ready');
  const round = createRound("hussein");
  round.sharedSlots = true;
  round.slotPolicyVersion = 1;
  round.gamePolicyVersion = 1;
  round.course = "공동 테스트";
  round.holes[0].par = 3;
  round.holes[0].scores = [3,4,6,7];
  round.holes[0].paid = [200000,0,0,0];
  round.cash = [{type:"collect",amount:400000}];
  round.settled = [100000,null,null,null];
  round.finished = true;
  await pages[0].evaluate((r) => {
    localStorage.setItem(
      "golf-hussein-v1",
      JSON.stringify({ version: 1, rounds: [r] }),
    );
  }, round);
  // A local list entry opens the lobby with the source already selected.
  await pages[0].reload();
  await pages[0].getByRole("button", {name:"공동 게임으로 복사",exact:true}).click();
  assert.equal(await pages[0].locator("#shared-source").inputValue(), round.id);
  await pages[0].locator("#shared-owner-player").selectOption("3");
  await pages[0].locator("#shared-debug summary").click();
  await pages[0].locator('[data-shared="check"]').click();
  await waitSaved(pages[0]);
  assert.match(await pages[0].locator("#shared-checks").textContent(), /로그인: 확인됨.*서버 조회: 확인됨.*RPC: 미확인/);
  assert.equal(await pages[0].locator("#shared-owner-player").inputValue(), "3");
  // Hold the first member response while subscribe starts a refresh before watch.
  // Completion must wait for membership, rather than rendering an empty roster.
  await pages[0].evaluate(() => { window.__holdMembers = new Promise(resolve => { window.__releaseMembers = resolve; }); });
  await pages[0].locator('[data-shared="create"]').click();
  await pages[0].waitForFunction(() => window.__membersPending);
  assert.equal(await pages[0].locator('[data-shared="local"]').isDisabled(), true,
    "create must still be waiting for the member query");
  await pages[0].evaluate(() => { window.__releaseMembers(); window.__holdMembers = null; });
  await pages[0].locator('#shared-score-0').waitFor();
  await waitSaved(pages[0]);
  assert.equal(await pages[0].locator('.shared-panel').getAttribute('data-member-state'), 'ready');
  await pages[0]
    .getByRole("heading", { name: "공동 테스트", exact: true })
    .waitFor();
  assert.match(await pages[0].locator("#shared-checks").textContent(), /RPC: 실행 확인됨/);
  const saved = await db.query("select round from public.golf_games");
  assert.deepEqual(saved.rows[0].round, round);
  const code = (
    await pages[0].locator(".shared-panel .card strong").first().innerText()
  ).replace("참여 코드 ", "");
  assert.match(code, /^[A-F0-9]{12}$/);
  // Two browsers see the same free player. The second stale choice must fail atomically.
  await pages[2].locator('#shared-code').fill(code);await pages[2].locator('[data-shared="lookup"]').click();
  await pages[2].locator('#shared-join-player').selectOption('1');
  for (let i = 1; i < 4; i++) {
    if (i === 1) {
      await pages[i].goto(origin + basePath + "/#join=" + code);
      await pages[i].reload();

    }
    if(i===2){
      await pages[2].locator('[data-shared="join"]').click();
      await pages[2].getByRole('alert').filter({hasText:'이미 다른 계정'}).waitFor();
      assert.equal(await pages[2].locator('#shared-join-player option[value="1"]').isDisabled(),true);
    }
    await joinAs(pages[i],code,[3,1,2,0][i]);
    await waitSaved(pages[i]);
    assert.equal(await pages[i].locator('.shared-panel').getAttribute('data-member-state'), 'ready');
    const membership = (await db.query('select slot from public.golf_members where user_id=$1', [users[i]])).rows;
    assert.equal(membership.length, 1);
    assert.equal(membership[0].slot,[3,1,2,0][i]);
    assert.equal(await pages[i].getByRole("alert").count(), 0);
    if (i === 1) assert.equal(new URL(pages[i].url()).hash, "");
  }
  await pages[4].locator("#shared-code").fill(code);
  await pages[4].locator('[data-shared="lookup"]').click();
  await pages[4].getByText("정원이 찼거나 참가를 허용하지 않는 게임입니다.").waitFor();
  await waitSynced();
  assert.equal(await pages[0].locator("#shared-score-0").count(), 1);
  // No account has selected a slot: unbound members can edit every player and lock.
  for(let player=0;player<4;player++) {
    await setStroke(pages[1], player, String(player+4));
    await waitSaved(pages[1]); await waitSynced();
  }
  assert.equal(await pages[1].locator('[data-shared-relative][data-value=""]').count(),0);
  await pages[1].locator('[data-shared-relative="0"][data-value="1"]').click();await waitSaved(pages[1]);await waitSynced();
  assert.equal(await pages[0].locator('#shared-score-0').getAttribute('data-stroke'),'');
  assert.equal(await pages[0].locator('#shared-score-0 > small').innerText(),'');
  await setStroke(pages[1],0,'4');await waitSaved(pages[1]);await waitSynced();
  // Two independent accounts edit the same score in both directions, before any slot claim.
  await setStroke(pages[1],0,'5');await waitSaved(pages[1]);await waitSynced();
  assert.equal(await pages[0].locator('#shared-score-0').getAttribute('data-stroke'),'5');
  await setStroke(pages[0],0,'4');await waitSaved(pages[0]);await waitSynced();
  assert.equal(await pages[1].locator('#shared-score-0').getAttribute('data-stroke'),'4');
  await pages[1].locator('#shared-near').selectOption('1');
  await waitSaved(pages[1]); await waitSynced();
  await pages[1].locator('[data-shared="lock"]').click();
  await waitSaved(pages[1]); await waitSynced();
  assert.equal(await pages[1].locator('#shared-score-1 button').first().isDisabled(),true);
  assert.equal(await pages[1].locator('[data-shared="lock"]').isDisabled(),true);
  assert.equal((await db.query('select count(slot)::int n from public.golf_members')).rows[0].n,4);
  await pages[0].locator('[data-shared="lock"]').click();
  await waitSaved(pages[0]); await waitSynced();
  // Restore this isolated fixture's inputs before the pre-existing preservation checks.
  for(let player=0;player<4;player++) {
    await setStroke(pages[1], player, String(round.holes[0].scores[player]));
    await waitSaved(pages[1]); await waitSynced();
  }
  await pages[1].locator('#shared-near').selectOption('');
  await waitSaved(pages[1]); await waitSynced();
  const linked=queue.then(async()=>{await db.exec('reset role');return (await db.query('select user_id,slot from public.golf_members order by slot')).rows;});queue=linked.catch(()=>{});
  const roster=await linked;for(let i=0;i<4;i++)assert.equal(roster.find(m=>m.user_id===users[i]).slot,[3,1,2,0][i]);
  for(const p of pages)assert.equal(await p.locator('#shared-slot,[data-shared="claim"]').count(),0);
  await pages[3].locator('#shared-settings summary').click();await pages[3].locator('#shared-my-name').fill('참가자3');await pages[3].locator('[data-shared="rename"]').click();await waitSaved(pages[3]);await waitSynced();await pages[3].locator('#shared-settings summary').click();
  assert.equal(await pages[0].locator('#shared-player-name-0').isVisible(),false);
  assert.equal(await pages[0].locator('[data-initial="0"]').isVisible(),false);
  await pages[0].locator('#shared-settings summary').click();
  await pages[0].locator('[data-initial="0"]').selectOption("2");
  await waitSaved(pages[0]); await waitSynced();
  assert.equal(await pages[0].locator('[data-initial="0"]').inputValue(), "2");
  for(const p of pages.slice(1,4)) {
    assert.equal(await p.locator('[data-initial]').count(),0);
    assert.equal(await p.locator('[data-player-name]').count(),0);
    if(!await p.locator('#shared-settings').evaluate(el=>el.open))await p.locator('#shared-settings summary').click();
    assert.match(await p.locator('.shared-panel').innerText(),/1등: 선수 3/);
  }
  if(!await pages[1].locator('#shared-settings').evaluate(el=>el.open))await pages[1].locator('#shared-settings summary').click();
  await pages[1].locator("#shared-my-name").fill("민수");
  await pages[1].locator('[data-shared="rename"]').click();
  await waitSaved(pages[1]); await waitSynced();
  assert.equal(await pages[1].locator('#shared-player-label-1').innerText(),round.players[1]);
  await pages[0].locator('#shared-player-name-1').fill('민수');
  await pages[0].locator('[data-shared="player-name"][data-player="1"]').click();
  await waitSaved(pages[0]); await waitSynced();
  await waitSaved(pages[1]); await waitSynced();
  for (const p of pages.slice(0,4)) {
    assert.match(await p.locator('#shared-player-label-1').innerText(), /민수/);
    assert.match(await p.locator(".score.current-hussein").innerText(), /현재 후세인/);
    assert.equal(await p.locator(".score.current-hussein").evaluate(e=>getComputedStyle(e).backgroundColor), "rgb(255, 244, 204)");
  }
  assert.ok(mutationRequests.some(a=>a.p_player===1));
  assert.equal(mutationRequests.some(a=>a.p_action==='slot'),false);
  assert.ok(mutationRequests.some(a=>a.p_action==='player_name' && a.p_detail.player===1 && a.p_detail.value==='민수'));
  assert.ok(mutationRequests.some(a=>a.p_action==='initial' && JSON.stringify(a.p_detail.value)===JSON.stringify([2,1,0,3])));
  for (let i = 0; i < 4; i++) {
    const p = pages[i];
    await p.waitForTimeout(100);
    await setStroke(p, i, String([3, 4, 6, 7][i]));
    await waitSaved(p);
    await waitSynced();
  }
  await pages[3].waitForFunction(
    () => document.querySelector("#shared-score-1").dataset.stroke === "4",
  );
  for (const p of pages.slice(0,4)) {
    assert.match(await p.locator(".result").innerText(), /후세인 승/);
    assert.equal(await p.locator(".victory").count(), 1);
    assert.match(await p.locator(".next-hussein").innerText(), /다음 홀 후세인: 민수/);
    assert.match(await p.locator(".score.current-hussein").innerText(), /3점 · 300,000 VND/);
  }
  await pages[2].locator("#shared-near").selectOption("2");
  await waitSaved(pages[2]);
  await waitSynced();
  await pages[1].locator('[data-shared="lock"]').click();
  await waitSaved(pages[1]);
  await pages[0].waitForFunction(
    () => document.querySelector("#shared-score-0").querySelector("button").disabled,
  );
  assert.equal(
    await pages[1].locator('[data-shared="lock"]').isDisabled(),
    true,
  );
  await pages[0].locator('[data-shared="lock"]').click();
  await pages[3].waitForFunction(
    () => !document.querySelector("#shared-score-0").querySelector("button").disabled,
  );
  await setStroke(pages[3], 0, "7");
  await waitSaved(pages[3]);
  await pages[0].waitForFunction(
    () => document.querySelector("#shared-score-0").dataset.stroke === "7",
  );
  await pages[0].locator('[data-page="history"]').click();
  await pages[0]
    .getByText("참가자3 · 타수 변경", { exact: true })
    .first()
    .waitFor();
  assert.ok(
    (await pages[0].locator(".shared-panel").innerText()).includes("3 → 7"),
  );
  await contexts[3].setOffline(true);
  await setStroke(pages[3], 0, "6");
  await pages[3].getByRole("alert").waitFor();
  await waitSaved(pages[3]);
  assert.equal(await pages[3].locator("#shared-score-0").getAttribute("data-stroke"), "7");
  await contexts[3].setOffline(false);
  await pages[0].locator('[data-shared="lobby"]').click();
  await pages[0].locator('[data-shared="list"]').click();
  await pages[0].locator("[data-open-game]").waitFor();
  await pages[0].locator("[data-open-game]").click();
  await pages[0].locator("#shared-score-0").waitFor();
  assert.deepEqual(await pages[0].evaluate(() => JSON.parse(localStorage.getItem("golf-hussein-v1")).rounds[0]), round);
  await pages[0].getByText("생성자 · 4/4명", {exact:true}).waitFor();
  await pages[0].locator('[data-shared="lobby"]').click();
  await pages[0].locator("#shared-source").selectOption("");
  for(let i=0;i<4;i++)await pages[0].locator(`#shared-draft-player-${i}`).fill(`등록 선수${i+1}`);
  await pages[0].locator('[data-draft-player-rank="0"]').selectOption('2');
  assert.deepEqual(await pages[0].locator('[data-draft-player-rank]').evaluateAll(els=>els.map(el=>el.value)),['2','1','0','3']);
  assert.equal(await pages[0].locator('.player-setup-row').evaluateAll(rows=>rows.every(row=>row.querySelector('input') && row.querySelector('select'))),true);
  await pages[0].locator('[data-shared="create"]').click();
  await pages[0].getByRole("heading", {name:"공동 라운드",exact:true}).waitFor();
  assert.equal(await pages[0].locator('#shared-settings').evaluate(el=>el.open),false);
  const latestCreatedTask=queue.then(()=>request({user:0,table:'golf_games',order:{field:'updated_at',ascending:false}}));
  queue=latestCreatedTask.catch(()=>{});
  const latestCreated=(await latestCreatedTask)[0].round;
  assert.deepEqual(latestCreated.initial,[2,1,0,3]);
  // Restore intended Hussein for the comparison regression via owner settings.
  await pages[0].locator('#shared-settings summary').click();
  await pages[0].locator('[data-initial="0"]').selectOption('0');
  await waitSaved(pages[0]);
  await pages[0].locator('#shared-settings summary').click();
  assert.equal(await pages[0].locator("#shared-slot").count(), 0);
  assert.equal(await pages[0].locator("#shared-score-0").count(),1);
  assert.deepEqual(await pages[0].evaluate(() => JSON.parse(localStorage.getItem("golf-hussein-v1")).rounds[0]), round);
  // New comparison must also be shown by the shared UI (old comparison gave Hussein a win).
  for(let player=0;player<4;player++) {
    await setStroke(pages[0], player, String([3,5,8,4][player]));
    await waitSaved(pages[0]);
  }
  assert.match(await pages[0].locator('.result').innerText(),/연합군 승/);
  assert.match(await pages[0].locator('.result').innerText(),/연합군 현재 홀 상위 2명 평균: 3.5타/);
  assert.equal(await pages[0].locator('.victory').count(),3);
  await pages[0].reload();
  await pages[0].getByRole('button',{name:'새 공동 게임 생성',exact:true}).click();
  await pages[0].locator('[data-shared="list"]').click();
  await pages[0].locator('[data-open-game]').first().click();
  await pages[0].locator('#shared-score-0').waitFor();
  assert.match(await pages[0].locator('.result').innerText(),/연합군 승/);
  // Existing null-flag Hussein games keep the original no-slot workflow.
  const legacyRound=createRound("hussein");legacyRound.sharedSlots=true;
  legacyRound.holes[0].scores=[3,4,5,6];
  const legacyTask=queue.then(async()=>{
    await db.exec('reset role');
    const legacy=(await db.query('insert into public.golf_games(owner_id,round) values($1,$2) returning *',[users[0],legacyRound])).rows[0];
    await db.query('insert into public.golf_members(game_id,user_id,name) values($1,$2,$3)',[legacy.id,users[0],'기존 생성자']);
    return legacy;
  });
  queue=legacyTask.catch(()=>{});
  const legacy=await legacyTask;
  await pages[1].locator('[data-shared="lobby"]').click();
  await pages[1].locator('#shared-code').fill(legacy.code);
  await joinAs(pages[1],await pages[1].locator('#shared-code').inputValue(),1);
  await pages[1].locator('#shared-score-0').waitFor();
  assert.equal(await pages[1].locator('#shared-slot').count(),0);
  assert.equal(await pages[1].locator('[data-shared="lock"]').isDisabled(),false);
  await pages[1].locator('[data-shared="lock"]').click();
  await waitSaved(pages[1]);
  assert.equal(await pages[1].locator('#shared-score-0 button').first().isDisabled(),true);
  await pages[1].locator('[data-shared="lobby"]').click();
  await pages[1].locator('#shared-code').fill(code);
  await joinAs(pages[1],await pages[1].locator('#shared-code').inputValue());
  await pages[1].locator('#shared-score-0').waitFor();
  assert.equal(await pages[1].locator('#shared-slot').count(),0);
  // Normal and Hussein share the exact same 18-hole card; normal has no betting controls.
  await pages[0].locator('[data-shared="lobby"]').click();
  await pages[0].locator('#shared-source').selectOption('new-normal');
  await pages[0].locator('#shared-normal-count').selectOption('2');

  await pages[0].locator('#shared-draft-player-0').fill('일반 A');
  await pages[0].locator('#shared-draft-player-1').fill('일반 B');
  await pages[0].locator('[data-shared="create"]').click();
  await pages[0].locator('#shared-score-0').waitFor();
  assert.equal(await pages[0].locator('.relative-score').count(),2);
  const normalCode=(await pages[0].locator('.shared-panel .card strong').first().innerText()).replace('참여 코드 ','');
  await joinAs(pages[4],normalCode,0);
  await pages[4].locator('#shared-score-0').waitFor();
  for(const p of [pages[0],pages[4]]) {
    assert.equal(await p.locator('#shared-slot,#shared-near,[data-shared="lock"],.result,[data-pay],[data-settle]').count(),0);
  }
  await setStroke(pages[4],1,'5');await waitSaved(pages[4]);
  await pages[0].waitForFunction(()=>document.querySelector('#shared-score-1').dataset.stroke==='5');
  await setStroke(pages[0],1,'6');await waitSaved(pages[0]);
  await pages[4].waitForFunction(()=>document.querySelector('#shared-score-1').dataset.stroke==='6');
  await setStroke(pages[4],1,'5');await waitSaved(pages[4]);
  await pages[0].waitForFunction(()=>document.querySelector('#shared-score-1').dataset.stroke==='5');
  // Inspect test storage in the same queue as RPCs. A direct read can inherit
  // another browser's authenticated role/RLS and report zero members in WebKit.
  const memberInspection=queue.then(async()=>{
    await db.exec('reset role');
    return (await db.query('select slot from public.golf_members where game_id=(select id from public.golf_games where code=$1)',[normalCode])).rows;
  });
  queue=memberInspection.catch(()=>{});
  const normalMembers=await memberInspection;
  assert.equal(normalMembers.length,2);assert.deepEqual(normalMembers.map(m=>m.slot),[null,null]);
  await pages[4].locator('[data-shared-relative="1"][data-value="1"]').click();await waitSaved(pages[4]);
  await pages[0].waitForFunction(()=>document.querySelector('#shared-score-1').dataset.stroke==='');
  assert.equal(await pages[0].locator('#shared-score-1 > small').innerText(),'');
  await setStroke(pages[0],1,'5');await waitSaved(pages[0]);
  await pages[4].waitForFunction(()=>document.querySelector('#shared-score-1').dataset.stroke==='5');
  await pages[4].locator('[data-shared-hole="17"]').click();
  await setStroke(pages[4],0,'6');await waitSaved(pages[4]);
  await pages[0].locator('[data-shared-hole="17"]').click();
  await pages[0].waitForFunction(()=>document.querySelector('#shared-score-0').dataset.stroke==='6');
  for(const p of [pages[0],pages[4]])await p.locator('[data-page="summary"]').click();
  assert.equal(await pages[4].locator('[data-total="out-1"]').innerText(),'+1');
  assert.equal(await pages[4].locator('[data-total="in-0"]').innerText(),'+2');
  assert.equal(await pages[4].locator('[data-total="total-0"]').innerText(),'+2');
  assert.equal(await pages[4].locator('.scorecard thead th').count(),22);
  await pages[4].locator('.scorecard-scroll').evaluate(el=>el.scrollLeft=800);
  const pinned=await pages[4].evaluate(()=>{const box=document.querySelector('.scorecard-scroll').getBoundingClientRect(),name=document.querySelector('.scorecard tbody .player-fixed').getBoundingClientRect();return Math.abs(name.left-box.left)<3;});
  assert.equal(pinned,true);
  assert.equal(await pages[4].evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await pages[4].locator('[data-shared="finalize"],#shared-rate,#shared-cash-type,[data-pay],[data-settle]').count(),0);
  for (const configuration of ["missing", "invalid", "auth-failure"]) {
    const context = await browser.newContext({viewport:{width:390,height:844},serviceWorkers:"block"});
    contexts.push(context);
    await context.route("**/shared-config.js", route => route.fulfill({contentType:"application/javascript", body:
      configuration === "missing" ? "export const sharedConfig={url:'',publishableKey:''}" :
      configuration === "invalid" ? "export const sharedConfig={url:'https://supabase.com/dashboard/project/test',publishableKey:'test-public'}" :
      "export const sharedConfig={url:'https://test.supabase.co',publishableKey:'test-public'}"}));
    await context.route("**/__sdk.js", route => route.fulfill({contentType:"application/javascript",headers:{"access-control-allow-origin":"*"},body:
      "export function createClient(){return {auth:{async getSession(){return {data:{session:null}}},async signInAnonymously(){return {error:{message:'sb_secret_do-not-display'}}}}}}"}));
    const p = await context.newPage();
    p.on("pageerror", e => errors.push(e.message));
    await p.goto(origin + basePath + "/");
    await p.getByRole("button", {name:"참여 코드로 참여",exact:true}).click();

    await p.locator("#shared-code").fill("123456789ABC");
    await p.locator("#shared-debug summary").click();
    await p.locator('[data-shared="check"]').click();
    await p.getByRole("alert").waitFor();
    await p.locator("#shared-debug summary").click();
    const text = await p.locator(".shared-panel").innerText();
    assert.doesNotMatch(text, /sb_secret_|실시간 연결됨|RPC: 실행 확인됨/);
    assert.match(text, configuration === "missing" ? /배포 설정: 누락/ : configuration === "invalid" ? /URL 형식 오류/ : /로그인: 실패/);

    assert.equal(await p.locator("#shared-code").inputValue(), "123456789ABC");
    await context.close();
  }
  // Real service worker: stale cached modules must not hide the new UI.
  const pwaContext = await browser.newContext({viewport:{width:390,height:844},serviceWorkers:"allow"});
  contexts.push(pwaContext);
  await pwaContext.addInitScript(() => { window.__testUser = 3; });
  const pwa = await pwaContext.newPage();
  pwa.on("pageerror", e => errors.push(e.message));
  await pwa.goto(origin + basePath + "/");
  await pwa.evaluate(async () => { await navigator.serviceWorker.ready; });
  await pwa.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await pwa.evaluate(async r => {
    localStorage.setItem("golf-hussein-v1", JSON.stringify({version:1,rounds:[r]}));
    const cache = await caches.open("golf-hussein-v4");
    await cache.put(new URL("./app.js", location.href), new Response("document.querySelector('#app').textContent='STALE_APP'",{headers:{"Content-Type":"application/javascript"}}));
    await cache.put(new URL("./shared-ui.js", location.href), new Response("",{headers:{"Content-Type":"application/javascript"}}));
  }, round);
  await pwa.reload();
  await pwa.getByRole("button", {name:"공동 게임으로 복사",exact:true}).waitFor();
  await pwa.getByRole("button",{name:"새 공동 게임 생성",exact:true}).waitFor();
  assert.deepEqual(await pwa.evaluate(() => JSON.parse(localStorage.getItem("golf-hussein-v1")).rounds[0]), round);
  // WebKit's offline emulation rejects SW responses before the worker can
  // answer (microsoft/playwright#42775). Keep Chromium's emulation check,
  // and exercise real network failure in BOTH engines below, without retries.
  if (browserType === chromium) {
    await pwaContext.setOffline(true);
    const response = await pwa.reload();
    assert.equal(response.status(), 200);
    assert.equal(response.fromServiceWorker(), true);
    await pwa.getByRole("button", {name:"공동 게임으로 복사",exact:true}).waitFor();
    await pwaContext.setOffline(false);
  }
  // A rendered UI alone does not prove that background cache.put has finished.
  await pwa.waitForFunction(async () => {
    const cache = await caches.open("golf-hussein-v4");
    const app = await cache.match(new URL("./app.js", location.href));
    const shared = await cache.match(new URL("./shared-ui.js", location.href));
    return app && shared && !(await app.text()).includes("STALE_APP") &&
      (await shared.text()).includes("shared-join-player");
  });
  await pwa.evaluate(() => { window.__oldDocument = true; });
  await stopOrigin();
  assert.equal(server.listening, false);
  // Negative control: with no worker/cache the exact same URL must fail.
  const noWorker = await browser.newContext({serviceWorkers:"block"});
  try {
    const p = await noWorker.newPage();
    await assert.rejects(() => p.goto(origin + basePath + "/"),
      /net::ERR_CONNECTION_REFUSED|Could not connect|Connection refused|cannot connect/i);
  } finally { await noWorker.close(); }
  const offlineResponse = await pwa.reload();
  assert.equal(offlineResponse.status(), 200);
  assert.equal(offlineResponse.fromServiceWorker(), true);
  assert.equal(await pwa.evaluate(() => window.__oldDocument), undefined);
  assert.equal(new URL(pwa.url()).pathname, basePath + "/");
  await pwa.getByRole("button", {name:"공동 게임으로 복사",exact:true}).waitFor();
  assert.deepEqual(await pwa.evaluate(() => JSON.parse(localStorage.getItem("golf-hussein-v1")).rounds[0]), round);
  // An uncached navigation must use the project-scoped index fallback too.
  const fallback = await pwa.goto(origin + basePath + "/uncached-offline");
  assert.equal(fallback.status(), 200);
  assert.equal(fallback.fromServiceWorker(), true);
  await pwa.getByRole("button", {name:"공동 게임으로 복사",exact:true}).waitFor();
  assert.deepEqual(await pwa.evaluate(() => JSON.parse(localStorage.getItem("golf-hussein-v1")).rounds[0]), round);
  // Restore the origin at the same address; the real worker must still allow
  // authenticated shared RPCs and event delivery after the outage.
  await new Promise(resolve => server.listen(Number(new URL(origin).port), "127.0.0.1", resolve));
  await pwa.goto(origin + basePath + "/");
  await pwa.getByRole("button", {name:"참여 코드로 참여",exact:true}).click();

  await pwa.locator("#shared-code").fill(code);
  await joinAs(pwa,code);
  await pwa.waitForFunction(() => document.querySelector("#shared-score-0") || document.querySelector('[role="alert"]'));
  assert.equal(await pwa.getByRole("alert").count(), 0,
    await pwa.locator(".shared-panel").innerText());
  assert.equal(await pwa.locator("#shared-slot").count(),0);
  await setStroke(pwa, 0, "7");
  await waitSaved(pwa);
  await pages[1].waitForFunction(() => document.querySelector("#shared-score-0").dataset.stroke === "7");
  assert.match(await pwa.locator("#shared-checks").textContent(), /RPC: 실행 확인됨/);
  assert.deepEqual(await pwa.evaluate(() => JSON.parse(localStorage.getItem("golf-hussein-v1")).rounds[0]), round);
  await pwaContext.close();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: 5 isolated mobile browsers + PostgreSQL: create/join/capacity/all-player edits/event sync/Near/lock/owner unlock/history/offline/list/full local preservation/config and auth failures/service worker stale cache/network outage reload/uncached project-path fallback/negative control/shared recovery",
  );
} catch (error) {
  for (const [i, p] of pages.entries()) {
    console.error(`Browser ${i} failure state:`, await p.locator('.shared-panel').innerText().catch(() => 'page unavailable'));
  }
  console.error('Browser page errors:', errors);
  throw error;
} finally {
  await browser.close();
  await stopOrigin();
  await db.close();
}
