import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, it, expect } from "vitest";

const html = readFileSync("index.html", "utf8");
const KEY = "flourish-log-v2";

const boot = (seed) =>
  new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://flourish.test/",
    beforeParse(w) { if (seed) w.localStorage.setItem(KEY, seed); },
  });

const q = (dom, s) => dom.window.document.querySelector(s);
const qa = (dom, s) => [...dom.window.document.querySelectorAll(s)];
const byText = (dom, sel, text) => qa(dom, sel).find((el) => el.textContent.trim() === text);

describe("PWA v2.0: 起動と基本描画", () => {
  it("記録タブが描画され、v2.0表示がある", () => {
    const dom = boot();
    expect(q(dom, "#view").textContent).toContain("就寝時刻");
    expect(q(dom, ".eyebrow").textContent).toContain("v2.0");
  });
});

describe("PWA v2.0: 保存と復元", () => {
  it("タップ→localStorageに即保存され✓保存済みが出る", () => {
    const dom = boot();
    byText(dom, "button.sb", "✓ した").click(); // 最初の「した」=アシュワガンダ
    const saved = JSON.parse(dom.window.localStorage.getItem(KEY));
    const today = dom.window.__flourish.fmt(new Date());
    expect(saved.entries[today].ashwagandha).toBe(true);
    expect(q(dom, "#saveState").textContent).toBe("✓ 保存済み");
  });

  it("同じボタン2回タップ→未入力(削除)に戻る", () => {
    const dom = boot();
    const btn = () => byText(dom, "button.sb", "〜23:00");
    btn().click();
    btn().click(); // 再描画後の同ラベルボタンを取り直してタップ
    const saved = JSON.parse(dom.window.localStorage.getItem(KEY));
    expect(Object.keys(saved.entries).length).toBe(0);
  });

  it("再起動(別インスタンス)で前回データが復元される", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    d.entries[f.fmt(new Date())] = { sleepFeel: 0 };
    const dom2 = boot(JSON.stringify(d));
    const good = byText(dom2, "button.sb", "良");
    expect(good.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("PWA v2.0: ロジック(移植の同一性)", () => {
  it("achieved: 就寝ライン/チェック/未入力", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    expect(f.achieved(d, { bedtime: 2 }, "bedtime")).toBe(true);
    expect(f.achieved(d, { bedtime: 4 }, "bedtime")).toBe(false);
    expect(f.achieved(d, {}, "bedtime")).toBe(null);
    expect(f.achieved(d, { gym: false }, "gym")).toBe(false);
  });

  it("phi: 完全一致=1 / 逆転=-1 / 片側一定=0", () => {
    const f = boot().window.__flourish;
    expect(f.phi([[1,1],[1,1],[0,0],[0,0]])).toBeCloseTo(1);
    expect(f.phi([[1,0],[1,0],[0,1],[0,1]])).toBeCloseTo(-1);
    expect(f.phi([[1,1],[1,0]])).toBe(0);
  });

  it("buildCSV: ラベル/1/0/空の変換", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    d.entries["2026-08-08"] = { bedtime: 4, sleepFeel: 1, youtube: 0, ashwagandha: false, creatine: true, weight: true, weightVal: "68.5", gym: false, study: true };
    const [head, row] = f.buildCSV(d).split("\n");
    expect(head).toContain("就寝時刻");
    expect(row).toBe("2026-08-08,以降,普通,<30分,0,1,1,68.5,0,1");
  });

  it("週報コピー用テキストに凡例と今週/前週JSONが含まれる", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    const t = f.buildReviewText(f.getS(), f.fmt(new Date()));
    expect(t).toContain("凡例");
    expect(t).toContain("今週:");
    expect(t).toContain("前週:");
    expect(t).toContain("【事実】");
  });
});

describe("PWA v2.0: 週タブ・週報タブ", () => {
  it("週タブ: 達成した項目が1/6と表示されドットが出る", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    d.entries[f0.fmt(new Date())] = { ashwagandha: true };
    const dom = boot(JSON.stringify(d));
    byText(dom, "button.tb", "週").click();
    expect(q(dom, "#view").textContent).toContain("アシュワガンダ");
    expect(q(dom, "#view").textContent).toContain("1/6");
    expect(qa(dom, ".dot.ok").length).toBeGreaterThan(0);
  });

  it("週報タブ: 28日未満は相関ロック表示", () => {
    const dom = boot();
    byText(dom, "button.tb", "週報").click();
    expect(q(dom, "#view").textContent).toContain("28日分の記録で解禁");
  });
});

describe("PWA v2.0: 設定タブ", () => {
  it("CSVエクスポート: テキストエリアにdate,ヘッダーが出る", () => {
    const dom = boot();
    byText(dom, "button.tb", "設定").click();
    byText(dom, "button.ghost", "CSVをコピー").click();
    expect(q(dom, "#exp").value.startsWith("date,")).toBe(true);
  });

  it("JSON取り込み: 貼り付け→取り込むで状態が置き換わり保存される", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    byText(dom, "button.tb", "設定").click();
    const d = f.defaultData();
    d.targets.gym = 6;
    d.entries["2026-08-01"] = { gym: true };
    q(dom, "#imp").value = JSON.stringify(d);
    byText(dom, "button.ghost", "取り込む").click();
    expect(f.getS().targets.gym).toBe(6);
    const saved = JSON.parse(dom.window.localStorage.getItem(KEY));
    expect(saved.entries["2026-08-01"].gym).toBe(true);
    expect(q(dom, "#view").textContent).toContain("取り込み完了");
  });

  it("初期化: 2段階確認でデータが消える", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    d.entries["2026-08-01"] = { gym: true };
    const dom = boot(JSON.stringify(d));
    byText(dom, "button.tb", "設定").click();
    byText(dom, "button.danger", "すべてのデータを削除…").click();
    byText(dom, "button.danger", "本当に削除する(取り消せません)").click();
    const saved = JSON.parse(dom.window.localStorage.getItem(KEY));
    expect(Object.keys(saved.entries).length).toBe(0);
  });
});
