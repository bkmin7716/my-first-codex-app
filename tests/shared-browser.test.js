// Browser + actual PostgreSQL rules via PGlite. The SDK transport below is a
// TEST adapter, not Supabase Realtime/Auth. Live Supabase smoke testing is separate.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { chromium, webkit } from "playwright";
import { PGlite } from "@electric-sql/pglite";
import { createRound } from "../engine.js";
const db = new PGlite();
await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;create publication supabase_realtime;`);
await db.exec(
  readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8"),
);
const users = Array.from(
  { length: 5 },
  (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
);
for (const id of users)
  await db.query("insert into auth.users values ($1)", [id]);
const events = new Set();
let queue = Promise.resolve();
async function request(body) {
  const uid = users[body.user];
  if (!uid) throw Error("test user");
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid]);
  await db.exec("set role authenticated");
  if (body.rpc) {
    const keys = {
      golf_create: ["p_round", "p_name"],
      golf_join: ["p_code", "p_name"],
      golf_mutate: ["p_game", "p_revision", "p_action", "p_detail"],
    }[body.rpc];
    if (!keys) throw Error("test rpc");
    const result = await db.query(
      `select to_jsonb(public.${body.rpc}(${keys.map((_, i) => "$" + (i + 1)).join(",")})) as g`,
      keys.map((k) => body.args[k]),
    );
    for (const res of events) res.write("data: changed\n\n");
    return [result.rows[0].g];
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
 const call=body=>fetch('/__db',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,user:window.__testUser})}).then(r=>r.json());
 return {auth:{async getUser(){return {data:{user:{id:'00000000-0000-4000-8000-'+String(window.__testUser+1).padStart(12,'0')}}}},async getSession(){return {data:{session:null}}},async signInAnonymously(){return {data:{session:{user:{id:'00000000-0000-4000-8000-'+String(window.__testUser+1).padStart(12,'0')}}}}}},
 rpc:(rpc,args)=>call({rpc,args}),from(table){let body={table};const q={select(){return q},eq(k,v){body.filter=[k,v];return q},order(field,o={}){body.order={field,...o};return q},limit(n){body.limit=n;return q},single(){body.single=true;return q},then(a,b){return call(body).then(a,b)}};return q},
 channel(){let cb,es;const c={on(e,f,fn){cb=fn;return c},subscribe(fn){es=new EventSource('/__events');es.onmessage=()=>cb();es.onopen=()=>fn('SUBSCRIBED');return c},close(){es?.close()}};return c},removeChannel(c){c.close()}}}
`;
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
    p.on("pageerror", (e) => errors.push(e.message));
    pages.push(p);
    await p.goto(origin + basePath + "/");
    await p.getByRole("button", { name: i === 0 ? "새 공동 게임 생성" : "참여 코드로 참여", exact: true }).click();
    assert.match(await p.locator("#shared-checks").innerText(), /로그인: 미확인.*RPC: 미확인/);
    await p.locator("#shared-name").fill(i === 0 ? "생성자" : `참가자${i}`);
  }
  const round = createRound("hussein");
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
  await pages[0].locator("#shared-name").fill("생성자");
  await pages[0].locator('[data-shared="check"]').click();
  await waitSaved(pages[0]);
  assert.match(await pages[0].locator("#shared-checks").innerText(), /로그인: 확인됨.*서버 조회: 확인됨.*RPC: 미확인/);
  assert.equal(await pages[0].locator("#shared-name").inputValue(), "생성자");
  await pages[0].locator('[data-shared="create"]').click();
  await pages[0]
    .getByRole("heading", { name: "공동 테스트", exact: true })
    .waitFor();
  assert.match(await pages[0].locator("#shared-checks").innerText(), /RPC: 실행 확인됨/);
  const saved = await db.query("select round from public.golf_games");
  assert.deepEqual(saved.rows[0].round, round);
  const code = (
    await pages[0].locator(".shared-panel .card strong").first().innerText()
  ).replace("참여 코드 ", "");
  assert.match(code, /^[A-F0-9]{12}$/);
  for (let i = 1; i < 4; i++) {
    if (i === 1) {
      await pages[i].goto(origin + basePath + "/#join=" + code);
      await pages[i].reload();
      await pages[i].locator("#shared-name").fill("참가자1");
    }
    await pages[i].locator("#shared-code").fill(code);
    await pages[i].locator('[data-shared="join"]').click();
    await pages[i].locator("#shared-score-0").waitFor();
    await waitSaved(pages[i]);
    assert.equal(await pages[i].getByRole("alert").count(), 0);
    if (i === 1) assert.equal(new URL(pages[i].url()).hash, "");
  }
  await pages[4].locator("#shared-code").fill(code);
  await pages[4].locator('[data-shared="join"]').click();
  await pages[4].getByRole("alert").filter({ hasText: "4명" }).waitFor();
  await waitSynced();
  for (let i = 0; i < 4; i++) {
    const p = pages[i];
    await p.waitForTimeout(100);
    await p.locator(`#shared-score-${i}`).fill(String([3, 4, 6, 7][i]));
    await p.locator(`#shared-score-${i}`).press("Tab");
    await waitSaved(p);
    await waitSynced();
  }
  await pages[3].waitForFunction(
    () => document.querySelector("#shared-score-1").value === "4",
  );
  await pages[2].locator("#shared-near").selectOption("2");
  await waitSaved(pages[2]);
  await waitSynced();
  await pages[1].locator('[data-shared="lock"]').click();
  await waitSaved(pages[1]);
  await pages[0].waitForFunction(
    () => document.querySelector("#shared-score-0").disabled,
  );
  assert.equal(
    await pages[1].locator('[data-shared="lock"]').isDisabled(),
    true,
  );
  await pages[0].locator('[data-shared="lock"]').click();
  await pages[3].waitForFunction(
    () => !document.querySelector("#shared-score-0").disabled,
  );
  await pages[3].locator("#shared-score-0").fill("8");
  await pages[3].locator("#shared-score-0").press("Tab");
  await waitSaved(pages[3]);
  await pages[0].waitForFunction(
    () => document.querySelector("#shared-score-0").value === "8",
  );
  await pages[0].locator('[data-page="history"]').click();
  await pages[0]
    .getByText("참가자3 · 타수 변경", { exact: true })
    .first()
    .waitFor();
  assert.ok(
    (await pages[0].locator(".shared-panel").innerText()).includes("3 → 8"),
  );
  await contexts[3].setOffline(true);
  await pages[3].locator("#shared-score-0").fill("9");
  await pages[3].locator("#shared-score-0").press("Tab");
  await pages[3].getByRole("alert").waitFor();
  assert.equal(await pages[3].locator("#shared-score-0").inputValue(), "8");
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
  await pages[0].locator('[data-shared="create"]').click();
  await pages[0].getByRole("heading", {name:"공동 라운드",exact:true}).waitFor();
  assert.equal(await pages[0].locator("#shared-score-0").inputValue(), "");
  assert.deepEqual(await pages[0].evaluate(() => JSON.parse(localStorage.getItem("golf-hussein-v1")).rounds[0]), round);
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
    await p.locator("#shared-name").fill("실패 테스트");
    await p.locator("#shared-code").fill("123456789ABC");
    await p.locator('[data-shared="check"]').click();
    await p.getByRole("alert").waitFor();
    const text = await p.locator(".shared-panel").innerText();
    assert.doesNotMatch(text, /sb_secret_|실시간 연결됨|RPC: 실행 확인됨/);
    assert.match(text, configuration === "missing" ? /배포 설정: 누락/ : configuration === "invalid" ? /URL 형식 오류/ : /로그인: 실패/);
    assert.equal(await p.locator("#shared-name").inputValue(), "실패 테스트");
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
    const cache = await caches.open("golf-hussein-v3");
    await cache.put(new URL("./app.js", location.href), new Response("document.querySelector('#app').textContent='STALE_APP'",{headers:{"Content-Type":"application/javascript"}}));
    await cache.put(new URL("./shared-ui.js", location.href), new Response("",{headers:{"Content-Type":"application/javascript"}}));
  }, round);
  await pwa.reload();
  await pwa.getByRole("button", {name:"공동 게임으로 복사",exact:true}).waitFor();
  await pwa.locator("#shared-launch").waitFor();
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
    const cache = await caches.open("golf-hussein-v3");
    const app = await cache.match(new URL("./app.js", location.href));
    const shared = await cache.match(new URL("./shared-ui.js", location.href));
    return app && shared && !(await app.text()).includes("STALE_APP") &&
      (await shared.text()).includes("shared-launch");
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
  await pwa.locator("#shared-name").fill("참가자3");
  await pwa.locator("#shared-code").fill(code);
  await pwa.locator('[data-shared="join"]').click();
  await pwa.waitForFunction(() => document.querySelector("#shared-score-0") || document.querySelector('[role="alert"]'));
  assert.equal(await pwa.getByRole("alert").count(), 0,
    await pwa.locator(".shared-panel").innerText());
  await pwa.locator("#shared-score-0").fill("10");
  await pwa.locator("#shared-score-0").press("Tab");
  await waitSaved(pwa);
  await pages[1].waitForFunction(() => document.querySelector("#shared-score-0").value === "10");
  assert.match(await pwa.locator("#shared-checks").innerText(), /RPC: 실행 확인됨/);
  assert.deepEqual(await pwa.evaluate(() => JSON.parse(localStorage.getItem("golf-hussein-v1")).rounds[0]), round);
  await pwaContext.close();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: 5 isolated mobile browsers + PostgreSQL: create/join/capacity/all-player edits/event sync/Near/lock/owner unlock/history/offline/list/full local preservation/config and auth failures/service worker stale cache/network outage reload/uncached project-path fallback/negative control/shared recovery",
  );
} finally {
  await browser.close();
  await stopOrigin();
  await db.close();
}
