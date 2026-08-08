import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, it, expect } from "vitest";

const html = readFileSync("index.html", "utf8");
const KEY = "flourish-log-v2";

// prepare(w) で「起動より前の環境」(壊れた保存データ・setItem の失敗など)を作り込む
const boot = (seed, prepare) =>
  new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://flourish.test/",
    beforeParse(w) {
      if (seed) w.localStorage.setItem(KEY, seed);
      if (prepare) prepare(w);
    },
  });

const q = (dom, s) => dom.window.document.querySelector(s);
const qa = (dom, s) => [...dom.window.document.querySelectorAll(s)];
const byText = (dom, sel, text) => qa(dom, sel).find((el) => el.textContent.trim() === text);
const tick = () => new Promise((r) => setTimeout(r, 0));
const stubClipboard = (dom, impl) => { dom.window.navigator.clipboard = { writeText: impl }; };

// アプリは new Date() を直接読むので、JSDOM 側の Date を差し替えて日付またぎを再現する
const withClock = (iso) => (w) => {
  let now = Date.parse(iso);
  const Real = w.Date;
  function Fake(...a) { return a.length ? new Real(...a) : new Real(now); }
  Fake.prototype = Real.prototype;
  Fake.now = () => now;
  Fake.parse = Real.parse;
  Fake.UTC = Real.UTC;
  w.Date = Fake;
  w.__advanceTo = (s) => { now = Date.parse(s); };
};
const stubShare = (impl) => (w) => {
  w.navigator.share = impl;
  w.navigator.canShare = () => true;
};

describe("PWA v2.4: 起動と基本描画", () => {
  it("記録タブが描画され、v2.4表示がある", () => {
    const dom = boot();
    expect(q(dom, "#view").textContent).toContain("就寝時刻");
    expect(q(dom, ".eyebrow").textContent).toContain("v2.4");
  });

  it("正常起動では警告バナーを出さない", () => {
    const dom = boot();
    expect(q(dom, "#banner").innerHTML).toBe("");
  });

  // 表示名はタブ・ホーム画面アイコン・見出しの3箇所にあり、片方だけ直すと食い違う
  it("表示名 Aubade がタイトル・ホーム画面名・見出しで一致する", () => {
    const dom = boot();
    expect(q(dom, "title").textContent).toBe("Aubade");
    expect(q(dom, 'meta[name="apple-mobile-web-app-title"]').getAttribute("content")).toBe("Aubade");
    expect(q(dom, "h1").textContent).toBe("Aubade");
  });

  // 表示名を変えても保存キーは据え置く。変えると既存の記録が読めなくなる
  it("保存キーは flourish-log-v2 のまま", () => {
    const dom = boot();
    byText(dom, "button.sb", "✓ した").click();
    expect(dom.window.__flourish.KEY).toBe("flourish-log-v2");
    expect(dom.window.localStorage.getItem("flourish-log-v2")).not.toBe(null);
  });
});

describe("PWA v2.4: 保存と復元", () => {
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

describe("PWA v2.4: ロジック(移植の同一性)", () => {
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

describe("PWA v2.4: 週タブ・週報タブ", () => {
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

describe("PWA v2.4: 設定タブ", () => {
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

describe("PWA v2.4: 壊れた保存データを黙って消さない", () => {
  const BROKEN = '{"version":2,"entries":{"2026-08-01":{"gym":true}'; // 末尾が欠けたJSON

  it("解析に失敗したら警告バナーを出し、原本を退避キーへ移す", () => {
    const dom = boot(BROKEN);
    expect(q(dom, "#banner .banner.err")).not.toBe(null);
    const keys = dom.window.__flourish.brokenKeys();
    expect(keys.length).toBe(1);
    expect(dom.window.localStorage.getItem(keys[0])).toBe(BROKEN);
  });

  it("退避後にタップしても、退避された原本は上書きされない", () => {
    const dom = boot(BROKEN);
    const key = dom.window.__flourish.brokenKeys()[0];
    byText(dom, "button.sb", "✓ した").click();
    expect(JSON.parse(dom.window.localStorage.getItem(KEY)).entries).not.toEqual({});
    expect(dom.window.localStorage.getItem(key)).toBe(BROKEN);
  });

  it("退避データは設定タブから取り出して取り込み欄に戻せる", () => {
    const dom = boot(BROKEN);
    byText(dom, "button.tb", "設定").click();
    const btn = q(dom, '[data-action="showbroken"]');
    expect(btn).not.toBe(null);
    btn.click();
    expect(q(dom, "#exp").value).toBe(BROKEN);
  });

  it("退避できなかった場合は保存を止め、原本をそのまま残す", () => {
    const dom = boot(BROKEN, (w) => {
      const orig = w.Storage.prototype.setItem;
      w.Storage.prototype.setItem = function (k, v) {
        if (String(k).startsWith(KEY + "-broken-")) throw new Error("quota exceeded");
        return orig.call(this, k, v);
      };
    });
    expect(dom.window.__flourish.brokenKeys().length).toBe(0);
    byText(dom, "button.sb", "✓ した").click();
    expect(q(dom, "#saveState").textContent).toBe("保存を停止中");
    expect(dom.window.localStorage.getItem(KEY)).toBe(BROKEN);
  });
});

describe("PWA v2.4: コピー結果を偽らない", () => {
  const openExport = (dom) => {
    byText(dom, "button.tb", "設定").click();
    byText(dom, "button.ghost", "CSVをコピー").click();
  };

  it("クリップボードが成功したら「コピーしました」に変わる", async () => {
    const dom = boot();
    stubClipboard(dom, () => Promise.resolve());
    openExport(dom);
    await tick();
    expect(q(dom, "#expnote").textContent).toContain("コピーしました");
  });

  it("クリップボードが拒否されたら「コピーしました」と言わず手動コピーを案内する", async () => {
    const dom = boot();
    stubClipboard(dom, () => Promise.reject(new Error("denied")));
    openExport(dom);
    await tick();
    const note = q(dom, "#expnote").textContent;
    expect(note).not.toContain("コピーしました");
    expect(note).toContain("長押し");
    expect(q(dom, "#exp").value.startsWith("date,")).toBe(true);
  });

  it("週報コピーも拒否時に成功表示にならない", async () => {
    const f0 = boot().window.__flourish;
    const seeded = f0.defaultData();
    seeded.entries[f0.fmt(new Date())] = { gym: true }; // 入力0日だとコピーボタンが無効
    const dom = boot(JSON.stringify(seeded));
    stubClipboard(dom, () => Promise.reject(new Error("denied")));
    byText(dom, "button.tb", "週報").click();
    byText(dom, "button.bigbtn", "週報用データをコピー").click();
    await tick();
    expect(q(dom, "#revnote").textContent).not.toContain("コピーしました");
    expect(q(dom, "#revout").value).toContain("【事実】");
  });

  it("クリップボードAPIが無い環境でも例外を投げずテキストを出す", () => {
    const dom = boot();
    expect(dom.window.navigator.clipboard).toBe(undefined);
    openExport(dom);
    expect(q(dom, "#exp").value.startsWith("date,")).toBe(true);
  });
});

describe("PWA v2.4: CSVの列ずれ", () => {
  it("カンマを含むカスタム項目名でも列数が一致する", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    d.custom = [{ id: "c_a", label: "読書, 英語", target: 5 }];
    d.entries["2026-08-08"] = { gym: true, c_a: true };
    const [head, row] = f.buildCSV(d).split("\n");
    expect(head).toContain('"読書, 英語"');
    expect(head.split('"').length).toBe(3); // 引用符は1フィールド分の2つだけ
    expect(row).toBe("2026-08-08,,,,,,,,1,,1");
  });

  it("引用符を含むラベルは二重引用符でエスケープする", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    d.custom = [{ id: "c_b", label: '「"読書"」', target: 5 }];
    const head = f.buildCSV(d).split("\n")[0];
    expect(head.endsWith('"「""読書""」"')).toBe(true);
  });
});

describe("PWA v2.4: 配信ポリシー", () => {
  it("CSPで外部への持ち出し経路を塞いでいる", () => {
    const csp = q(boot(), 'meta[http-equiv="Content-Security-Policy"]');
    expect(csp).not.toBe(null);
    const c = csp.getAttribute("content");
    expect(c).toContain("default-src 'none'");
    expect(c).toContain("connect-src 'none'"); // fetch/XHR/WebSocket/beacon を禁止
    expect(c).toContain("form-action 'none'");
    expect(c).toContain("base-uri 'none'");
    expect(c).toContain("img-src data:"); // アイコンは data: 埋め込みのみ
  });

  it("検索エンジンに拾わせない", () => {
    const m = q(boot(), 'meta[name="robots"]');
    expect(m.getAttribute("content")).toContain("noindex");
    expect(readFileSync("robots.txt", "utf8")).toContain("Disallow: /");
  });

  it("外部への通信コードとリソース参照を持たない", () => {
    expect(html).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|sendBeacon/);
    expect(html).not.toMatch(/(src|href)\s*=\s*["']https?:/);
  });
});

describe("PWA v2.4: 取り込んだJSONを信用しない", () => {
  const EVIL = 'c_x" data-action="reset2';
  const importJson = (dom, data) => {
    byText(dom, "button.tb", "設定").click();
    q(dom, "#imp").value = JSON.stringify(data);
    byText(dom, "button.ghost", "取り込む").click();
  };

  it("カスタム項目IDに仕込まれた属性は注入されない", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    const d = f.defaultData();
    d.custom = [{ id: EVIL, label: "注入", target: 5 }];
    importJson(dom, d);
    expect(qa(dom, '[data-action="reset2"]').length).toBe(0);
    expect(q(dom, "[data-del]").getAttribute("data-del")).toBe(EVIL);
    byText(dom, "button.tb", "記録").click();
    expect(qa(dom, '[data-action="reset2"]').length).toBe(0);
  });

  it("エスケープしても記録・削除は通常どおり動く", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    const d = f.defaultData();
    d.custom = [{ id: EVIL, label: "注入", target: 5 }];
    importJson(dom, d);
    byText(dom, "button.tb", "記録").click();
    qa(dom, "[data-f]").find((el) => el.getAttribute("data-f") === EVIL && el.dataset.v === "t").click();
    expect(f.getS().entries[f.fmt(new Date())][EVIL]).toBe(true);
    byText(dom, "button.tb", "設定").click();
    q(dom, ".delbtn").click();
    expect(f.getS().custom.length).toBe(0);
  });

  it("entriesがオブジェクトでなければ空として扱う", () => {
    const f = boot().window.__flourish;
    expect(f.migrate({ entries: ["2026-08-01"] }).entries).toEqual({});
    expect(f.migrate({ entries: "壊れた" }).entries).toEqual({});
    expect(f.migrate(null).entries).toEqual({});
  });

  it("カスタム項目の型を正規化する", () => {
    const f = boot().window.__flourish;
    const c = f.migrate({
      custom: [
        { id: "c_a", label: "読書", target: "99" },
        { id: "c_b", target: NaN },
        { id: "", label: "IDなし", target: 3 },
        "文字列",
      ],
    }).custom;
    expect(c.length).toBe(2); // ID不正の2件は落とす
    expect(c[0].target).toBe(7); // 0..7 にクランプ
    expect(c[1]).toEqual({ id: "c_b", label: "c_b", target: 5 });
  });

  it("最上位が配列のJSONは取り込まない", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    importJson(dom, [{ entries: {} }]);
    expect(q(dom, "#view").textContent).toContain("取り込み失敗");
    expect(f.getS().custom).toEqual([]);
  });

  it("lastBackup を持たない v2 データも読める", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({ version: 2, entries: { "2026-08-01": { gym: true } } });
    expect(m.version).toBe(3);
    expect(m.lastBackup).toBe(null);
    expect(m.entries["2026-08-01"].gym).toBe(true);
  });
});

describe("PWA v2.4: 日付またぎ", () => {
  const dateT = (dom) => q(dom, ".dateT").textContent;

  it("復帰時に日付が変わっていたら、今日を見ていた人を今日へ送る", () => {
    const dom = boot(null, withClock("2026-08-08T09:00"));
    expect(dateT(dom)).toContain("8/8");
    dom.window.__advanceTo("2026-08-09T07:00");
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    expect(dateT(dom)).toContain("8/9");
    expect(dateT(dom)).toContain("今日");
  });

  // JSDOM の document.visibilityState は既定が "prerender" なので、実ブラウザの復帰状態を作る
  it("visibilitychange でも追随する", () => {
    const dom = boot(null, withClock("2026-08-08T09:00"));
    Object.defineProperty(dom.window.document, "visibilityState", { value: "visible", configurable: true });
    dom.window.__advanceTo("2026-08-09T07:00");
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    expect(dateT(dom)).toContain("8/9");
  });

  it("画面が隠れているときは何もしない", () => {
    const dom = boot(null, withClock("2026-08-08T09:00"));
    Object.defineProperty(dom.window.document, "visibilityState", { value: "hidden", configurable: true });
    dom.window.__advanceTo("2026-08-09T07:00");
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    expect(dateT(dom)).toContain("8/8");
  });

  // 遡及入力の途中で復帰したときに今日へ引き戻すと、入力先が黙って変わってしまう
  it("自分で過去日を選んでいる場合は引き戻さない", () => {
    const dom = boot(null, withClock("2026-08-08T09:00"));
    byText(dom, "button.navbtn", "‹").click();
    expect(dateT(dom)).toContain("8/7");
    dom.window.__advanceTo("2026-08-09T07:00");
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    expect(dateT(dom)).toContain("8/7");
  });

  it("日付が変わっていなければ何もしない", () => {
    const dom = boot(null, withClock("2026-08-08T09:00"));
    byText(dom, "button.navbtn", "‹").click();
    dom.window.__advanceTo("2026-08-08T18:00");
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    expect(dateT(dom)).toContain("8/7");
  });
});

describe("PWA v2.4: バックアップの記録", () => {
  const openSettings = (dom) => byText(dom, "button.tb", "設定").click();
  const ago = (f, n) => { const d = new Date(); d.setDate(d.getDate() - n); return f.fmt(d); };

  it("初期状態では未バックアップと表示する", () => {
    const dom = boot();
    openSettings(dom);
    expect(q(dom, "#backupline").textContent).toContain("まだバックアップしていません");
  });

  it("JSONのコピーが成功したらバックアップ日を記録する", async () => {
    const dom = boot();
    stubClipboard(dom, () => Promise.resolve());
    openSettings(dom);
    byText(dom, "button.ghost", "JSONをコピー").click();
    await tick();
    const f = dom.window.__flourish;
    expect(f.getS().lastBackup).toBe(f.fmt(new Date()));
    expect(q(dom, "#backupline").textContent).toContain("今日");
  });

  // CSVからは復元できないので、コピーしてもバックアップにはならない
  it("CSVのコピーはバックアップに数えない", async () => {
    const dom = boot();
    stubClipboard(dom, () => Promise.resolve());
    openSettings(dom);
    byText(dom, "button.ghost", "CSVをコピー").click();
    await tick();
    expect(dom.window.__flourish.getS().lastBackup).toBe(null);
  });

  it("コピーが拒否されたらバックアップに数えない", async () => {
    const dom = boot();
    stubClipboard(dom, () => Promise.reject(new Error("denied")));
    openSettings(dom);
    byText(dom, "button.ghost", "JSONをコピー").click();
    await tick();
    expect(dom.window.__flourish.getS().lastBackup).toBe(null);
  });

  it("経過日数を出し、間隔が空いたら色を変える", () => {
    const f0 = boot().window.__flourish;
    const mk = (n) => { const d = f0.defaultData(); d.lastBackup = ago(f0, n); return JSON.stringify(d); };
    const recent = boot(mk(10));
    openSettings(recent);
    expect(q(recent, "#backupline").textContent).toContain("10日前");
    expect(q(recent, "#backupline").getAttribute("style")).toContain("--sub");
    const stale = boot(mk(70));
    openSettings(stale);
    expect(q(stale, "#backupline").getAttribute("style")).toContain("--sienna");
  });

  it("共有APIが無い端末では書き出しボタンを出さない", () => {
    const dom = boot();
    openSettings(dom);
    expect(q(dom, '[data-action="sharejson"]')).toBe(null);
  });

  it("ファイル書き出しに成功したらバックアップ日を記録する", async () => {
    const dom = boot(null, stubShare(() => Promise.resolve()));
    openSettings(dom);
    q(dom, '[data-action="sharejson"]').click();
    await tick();
    const f = dom.window.__flourish;
    expect(f.getS().lastBackup).toBe(f.fmt(new Date()));
    expect(q(dom, "#setnote").textContent).toContain("書き出しました");
  });

  // 共有シートを閉じただけで「バックアップ済み」になると、実際には守られていないのに安心してしまう
  it("共有シートを閉じた場合はバックアップに数えない", async () => {
    const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
    const dom = boot(null, stubShare(() => Promise.reject(abort)));
    openSettings(dom);
    q(dom, '[data-action="sharejson"]').click();
    await tick();
    expect(dom.window.__flourish.getS().lastBackup).toBe(null);
    expect(q(dom, "#setnote").textContent).toContain("中止");
  });
});

describe("PWA v2.4: 週タブの前週併記", () => {
  const prevWeekDay = (f, n) => {
    const ws = f.weekStart(new Date());
    const d = new Date(ws);
    d.setDate(d.getDate() - 7 + n);
    return f.fmt(d);
  };

  it("前週に入力があれば達成数を併記する", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    d.entries[prevWeekDay(f0, 0)] = { gym: true };
    d.entries[prevWeekDay(f0, 1)] = { gym: true };
    const dom = boot(JSON.stringify(d));
    byText(dom, "button.tb", "週").click();
    expect(q(dom, "#view").textContent).toContain("前週 2");
  });

  // 初週に「前週 0」が並ぶと、記録がないだけなのに未達成に見える
  it("前週に入力がなければ前週欄を出さない", () => {
    const dom = boot();
    byText(dom, "button.tb", "週").click();
    expect(q(dom, "#view").textContent).not.toContain("前週");
  });
});
