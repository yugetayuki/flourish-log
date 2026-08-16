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
// 分の実値は select。change を発火させないと保存されない
const pickMin = (dom, f, v) => {
  const s = dom.window.document.querySelector(`select[data-f="${f}"]`);
  s.value = v;
  s.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
};

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

describe("PWA v4.0: 起動と基本描画", () => {
  it("記録タブが描画され、v4.0表示がある", () => {
    const dom = boot();
    expect(q(dom, "#view").textContent).toContain("就寝時刻");
    expect(q(dom, ".eyebrow").textContent).toContain("v4.0");
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

describe("PWA v4.0: 保存と復元", () => {
  it("タップ→localStorageに即保存され✓保存済みが出る", () => {
    const dom = boot();
    byText(dom, "button.sb", "✓ した").click(); // 最初の「した」=アシュワガンダ
    const saved = JSON.parse(dom.window.localStorage.getItem(KEY));
    const today = dom.window.__flourish.fmt(new Date());
    expect(saved.entries[today].ashwagandha).toBe(true);
    expect(q(dom, "#saveState").textContent).toBe("✓ 保存済み");
  });

  // 分の実値は select。空欄「—」が seg の同値タップに相当する未入力への戻り道
  it("select で選び直して空欄にすると未入力(削除)に戻る", () => {
    const dom = boot();
    const pick = (v) => {
      const s = q(dom, 'select[data-f="bedtimeMin"]');
      s.value = v;
      s.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    };
    pick("1380"); // 23:00
    const today = dom.window.__flourish.fmt(new Date());
    expect(JSON.parse(dom.window.localStorage.getItem(KEY)).entries[today].bedtimeMin).toBe(1380);
    pick("");
    expect(Object.keys(JSON.parse(dom.window.localStorage.getItem(KEY)).entries).length).toBe(0);
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

describe("PWA v4.0: ロジック(移植の同一性)", () => {
  it("achieved: 就寝ライン/チェック/未入力", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    expect(f.achieved(d, { bedtimeMin: 1440 }, "bedtimeMin")).toBe(true);
    expect(f.achieved(d, { bedtimeMin: 1500 }, "bedtimeMin")).toBe(false);
    expect(f.achieved(d, {}, "bedtimeMin")).toBe(null);
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
    d.entries["2026-08-08"] = { bedtimeMin: 1512, wakeMin: 390, sleepFeel: 1, youtubeMin: 30, ashwagandha: false, coffee: true, creatine: true, weight: true, weightVal: "68.5", gym: false, study: true };
    const [head, row] = f.buildCSV(d).split("\n");
    expect(head).toContain("就寝時刻(分)");
    // 分の実値をそのまま出す。1512=25:12(v9 の移行値)、390=6:30、30=30分
    expect(row).toBe("2026-08-08,1512,390,普通,30,0,1,1,1,68.5,0,1,,,,,,,,,,,,,");
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

describe("PWA v4.0: 週タブ・週報タブ", () => {
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

describe("PWA v4.0: 設定タブ", () => {
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

describe("PWA v4.0: 壊れた保存データを黙って消さない", () => {
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

describe("PWA v4.0: コピー結果を偽らない", () => {
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

describe("PWA v4.0: CSVの列ずれ", () => {
  it("カンマを含むカスタム項目名でも列数が一致する", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    d.custom = [{ id: "c_a", label: "読書, 英語", target: 5 }];
    d.entries["2026-08-08"] = { gym: true, c_a: true };
    const [head, row] = f.buildCSV(d).split("\n");
    expect(head).toContain('"読書, 英語"');
    expect(head.split('"').length).toBe(3); // 引用符は1フィールド分の2つだけ
    expect(row).toBe("2026-08-08,,,,,,,,,,1,,,,,,,,,,,,,,,1");
  });

  it("引用符を含むラベルは二重引用符でエスケープする", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    d.custom = [{ id: "c_b", label: '「"読書"」', target: 5 }];
    const head = f.buildCSV(d).split("\n")[0];
    expect(head.endsWith('"「""読書""」"')).toBe(true);
  });
});

describe("PWA v4.0: 配信ポリシー", () => {
  it("CSPで外部への持ち出し経路を塞いでいる", () => {
    const csp = q(boot(), 'meta[http-equiv="Content-Security-Policy"]');
    expect(csp).not.toBe(null);
    const c = csp.getAttribute("content");
    expect(c).toContain("default-src 'none'");
    // 送信先はオーナーのPC(Tailscale)だけ。tailnet 内からしか引けないドメインなので、
    // 万一HTMLを注入されても記録の持ち出し先には使えない
    expect(c).toContain("connect-src https://*.ts.net");
    expect(c).not.toContain("connect-src *");
    expect(c).not.toMatch(/connect-src[^;]*http:/); // 平文へは送らせない
    expect(c).toContain("form-action 'none'");
    expect(c).toContain("base-uri 'none'");
    expect(c).toContain("img-src data:"); // アイコンは data: 埋め込みのみ
  });

  it("検索エンジンに拾わせない", () => {
    const m = q(boot(), 'meta[name="robots"]');
    expect(m.getAttribute("content")).toContain("noindex");
    expect(readFileSync("robots.txt", "utf8")).toContain("Disallow: /");
  });

  // sw.js は仕事上 fetch を使うので対象外。そちらの制約は「Service Worker」の describe で見る
  //
  // 通信は「オーナーが設定したPCへ送る1本」だけ。fetch を全面禁止にできなくなった代わりに、
  // 送信先が設定値以外になっていないことと、他の通信APIが増えていないことを見る
  it("index.html の通信は同期の1本だけで、送信先はハードコードされていない", () => {
    expect(html).not.toMatch(/XMLHttpRequest|WebSocket|sendBeacon/);
    expect(html).not.toMatch(/(src|href)\s*=\s*["']https?:/);
    const calls = html.match(/fetch\(/g) || [];
    expect(calls.length).toBe(1);
    expect(html).toMatch(/fetch\(syncCfg\.url,/); // 宛先は設定値のみ
    // URL もトークンもコードに書かない。このリポジトリは Public
    expect(html).not.toMatch(/https:\/\/[a-z0-9-]+\.[a-z0-9.-]*ts\.net/i);
  });
});

describe("PWA v4.0: Service Worker", () => {
  const sw = readFileSync("sw.js", "utf8");

  it("CSPが worker-src 'self' を許可する", () => {
    const c = q(boot(), 'meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    expect(c).toContain("worker-src 'self'"); // 無いと default-src 'none' まで落ちて登録が弾かれる
    expect(c).toContain("connect-src https://*.ts.net"); // 緩めたのは worker-src と同期先だけ
  });

  it("index.htmlが機能検出つきで登録し、失敗を握りつぶさない", () => {
    expect(html).toContain('"serviceWorker" in navigator');
    expect(html).toMatch(/navigator\.serviceWorker\.register\("sw\.js"\)\s*\.catch/);
    expect(html).toContain("[flourish] Service Worker を登録できませんでした");
  });

  it("Service Workerが無い環境でも起動して保存できる", () => {
    const dom = boot();
    expect(dom.window.navigator.serviceWorker).toBe(undefined); // JSDOM は実装を持たない
    byText(dom, "button.sb", "✓ した").click();
    expect(dom.window.localStorage.getItem(KEY)).not.toBe(null);
  });

  // 「古いHTMLを掴み続ける」事故を避けるための約束。破ると Service Worker を入れた意味が反転する
  it("キャッシュ名にバージョンを持ち、古いキャッシュを消す", () => {
    expect(sw).toMatch(/var CACHE = "aubade-v\d+\.\d+"/);
    expect(sw).toContain("skipWaiting");
    expect(sw).toContain("clients.claim");
    expect(sw).toContain("caches.delete");
  });

  it("ネットワーク優先で、失敗したときだけキャッシュへ倒す", () => {
    const fetchAt = sw.indexOf("fetch(req)");
    const cacheAt = sw.indexOf("caches.match(req)");
    expect(fetchAt).toBeGreaterThan(-1);
    expect(cacheAt).toBeGreaterThan(fetchAt); // キャッシュ参照は catch の中にしかない
  });

  // Service Worker はページのCSPの外側で動くので、持ち出し経路の迂回にならないことを見る
  it("他オリジンには触らない", () => {
    expect(sw).toContain("self.location.origin");
    expect(sw).not.toMatch(/https?:\/\//);
  });
});

describe("PWA v4.0: 取り込んだJSONを信用しない", () => {
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
    expect(m.version).toBe(9);
    expect(m.lastBackup).toBe(null);
    expect(m.entries["2026-08-01"].gym).toBe(true);
  });
});

describe("PWA v4.0: 日付またぎ", () => {
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

describe("PWA v4.0: バックアップの記録", () => {
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

describe("PWA v4.0: 起床時刻(計測のみ)", () => {
  it("select で選ぶと当朝の wakeMin として分で保存される", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    const s = q(dom, 'select[data-f="wakeMin"]');
    s.value = "390"; // 6:30
    s.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(JSON.parse(dom.window.localStorage.getItem(KEY)).entries[f.fmt(new Date())].wakeMin).toBe(390);
    expect(q(dom, 'select[data-f="wakeMin"]').value).toBe("390");
  });

  it("空欄を選ぶと未入力に戻る", () => {
    const dom = boot();
    const s = () => q(dom, 'select[data-f="wakeMin"]');
    const set = (v) => { const e = s(); e.value = v; e.dispatchEvent(new dom.window.Event("change", { bubbles: true })); };
    set("420");
    set("");
    expect(Object.keys(JSON.parse(dom.window.localStorage.getItem(KEY)).entries).length).toBe(0);
  });

  // 就寝と起床の両方を未達判定の対象にすると1日の失敗面積が二重になるため、起床は計測のみに留める
  it("週の目標・達成ラインを持たず、週タブでは計測のみと表示する", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    d.entries[f0.fmt(new Date())] = { wakeMin: 360 };
    const dom = boot(JSON.stringify(d));
    byText(dom, "button.tb", "設定").click();
    expect(qa(dom, "[data-tgt]").some((el) => el.dataset.tgt === "wakeMin")).toBe(false);
    expect(q(dom, '[data-th="wakeMin"]')).toBe(null);
    byText(dom, "button.tb", "週").click();
    const rows = qa(dom, ".wrow").filter((el) => el.textContent.includes("起床時刻"));
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain("計測のみ");
    expect(rows[0].querySelectorAll(".dot.ok").length).toBe(0);
  });

  it("CSVと週報データに起床時刻が入る", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    d.entries["2026-08-08"] = { bedtimeMin: 1320, wakeMin: 450 };
    const [head, row] = f.buildCSV(d).split("\n");
    expect(head).toContain("起床時刻(分)");
    expect(row).toBe("2026-08-08,1320,450,,,,,,,,,,,,,,,,,,,,,,");
    const t = f.buildReviewText(d, "2026-08-08");
    expect(t).toContain("wakeMin");
    expect(t).toContain("分の実値");
    expect(t).toContain("計測のみ");
    expect(t).toContain('"wakeMin":');
  });

  it("wake を持たない旧データも読め、version が上がる", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({ version: 3, entries: { "2026-08-01": { bedtime: 1 } } });
    expect(m.version).toBe(9);
    expect(m.enabled.wakeMin).toBe(true);
    expect(m.entries["2026-08-01"]).toEqual({ bedtimeMin: 1410 });
  });

  it("表示トグルを切ると記録タブから消える", () => {
    const dom = boot();
    expect(q(dom, '[data-f="wakeMin"]')).not.toBe(null);
    byText(dom, "button.tb", "設定").click();
    q(dom, '[data-tog="wakeMin"]').click();
    byText(dom, "button.tb", "記録").click();
    expect(q(dom, '[data-f="wakeMin"]')).toBe(null);
  });

  it("推移タブに起床時刻のチャートが出る", () => {
    const dom = boot();
    byText(dom, "button.tb", "推移").click();
    expect(q(dom, "#view").textContent).toContain("起床時刻(28日)");
    expect(qa(dom, "svg").length).toBeGreaterThanOrEqual(3);
  });

  it("28日そろうと起床時刻の相関ヒントが計算される", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    for (let i = 0; i < 28; i++) {
      const dt = new Date("2026-07-01T00:00");
      dt.setDate(dt.getDate() + i);
      d.entries[f0.fmt(dt)] = { wakeMin: i % 2 ? 450 : 360, sleepFeel: i % 2 ? 2 : 0 };
    }
    const dom = boot(JSON.stringify(d));
    byText(dom, "button.tb", "週報").click();
    const view = q(dom, "#view").textContent;
    expect(view).toContain("起床が〜6:30以内 × 眠れた感「良」");
    expect(view).toContain("φ=1.00");
  });
});

describe("PWA v4.0: 相関ヒント", () => {
  // 同じ entry の中で対にするので、時点がずれない組み合わせしか作れない
  // (前夜のアシュワガンダ × 当朝の眠れた感 は成立、当朝のコーヒー × その夜の就寝 は成立しない)
  const seed = (f) => {
    const d = f.defaultData();
    for (let i = 0; i < 28; i++) {
      const dt = new Date("2026-07-01T00:00");
      dt.setDate(dt.getDate() + i);
      const good = i % 2 === 0;
      d.entries[f.fmt(dt)] = {
        ashwagandha: good, sleepFeel: good ? 0 : 2,
        bedtimeMin: good ? 1380 : 1512, wakeMin: good ? 360 : 492,
      };
    }
    return d;
  };

  it("前夜のアシュワガンダと当朝の眠れた感を対にする", () => {
    const f0 = boot().window.__flourish;
    const dom = boot(JSON.stringify(seed(f0)));
    byText(dom, "button.tb", "週報").click();
    expect(q(dom, "#view").textContent).toContain("アシュワガンダを飲んだ × 眠れた感「良」");
  });

  it("早寝が早起きにつながっているかを対にする", () => {
    const f0 = boot().window.__flourish;
    const dom = boot(JSON.stringify(seed(f0)));
    byText(dom, "button.tb", "週報").click();
    expect(q(dom, "#view").textContent).toContain("就寝が達成ライン内 × 起床が〜6:30以内");
  });

  // 本数を増やすほど偶然有意に見えるものが出る(多重比較)。両項目が揃った対だけを出す
  it("データの無い組み合わせは出さない", () => {
    const f0 = boot().window.__flourish;
    const dom = boot(JSON.stringify(seed(f0)));
    byText(dom, "button.tb", "週報").click();
    const view = q(dom, "#view").textContent;
    expect(view).not.toContain("ジムをした");
    expect(view).not.toContain("勉強した");
    expect(qa(dom, "#view .row").length).toBe(4); // 揃っているのは就寝・起床・眠れた感の4対だけ
  });
});

describe("PWA v4.0: 推移タブの期間切替", () => {
  const openTrend = (dom) => byText(dom, "button.tb", "推移").click();
  const dayAgo = (f, n) => { const d = new Date(); d.setDate(d.getDate() - n); return f.fmt(d); };

  it("既定は28日で、90日に切り替わる", () => {
    const dom = boot();
    openTrend(dom);
    expect(q(dom, "#view").textContent).toContain("就寝時刻(28日)");
    expect(byText(dom, "button.sb", "28日").getAttribute("aria-pressed")).toBe("true");
    byText(dom, "button.sb", "90日").click();
    expect(q(dom, "#view").textContent).toContain("就寝時刻(90日)");
    expect(byText(dom, "button.sb", "90日").getAttribute("aria-pressed")).toBe("true");
    expect(byText(dom, "button.sb", "28日").getAttribute("aria-pressed")).toBe("false");
  });

  it("90日にすると28日より前の記録が入る", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    d.entries[dayAgo(f0, 60)] = { weight: true, weightVal: "70.0" };
    const dom = boot(JSON.stringify(d));
    openTrend(dom);
    expect(q(dom, "#view").textContent).toContain("体重の数値を入力すると"); // 28日の窓には無い
    byText(dom, "button.sb", "90日").click();
    expect(q(dom, "#view").textContent).toContain("体重(90日)");
  });

  // 90日ぶんの点は3px間隔で塊になるので打たない
  it("90日表示では点を打たない", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    for (let i = 0; i < 40; i++) d.entries[dayAgo(f0, i)] = { bedtimeMin: [1320, 1380, 1440, 1500, 1560][i % 5] };
    const dom = boot(JSON.stringify(d));
    openTrend(dom);
    expect(qa(dom, "svg")[0].querySelectorAll("circle").length).toBeGreaterThan(0);
    byText(dom, "button.sb", "90日").click();
    expect(qa(dom, "svg")[0].querySelectorAll("circle").length).toBe(0);
  });
});

describe("PWA v4.0: 睡眠の帯グラフ", () => {
  const openTrend = (dom) => byText(dom, "button.tb", "推移").click();
  const dayAgo = (f, n) => { const d = new Date(); d.setDate(d.getDate() - n); return f.fmt(d); };
  const bands = (dom) => qa(dom, "#view path[fill-opacity]").length;

  it("就寝と起床が揃った日ができるまでは案内文を出す", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    d.entries[dayAgo(f0, 0)] = { bedtimeMin: 1440 }; // 就寝だけでは睡眠の長さが決まらない
    const dom = boot(JSON.stringify(d));
    openTrend(dom);
    expect(q(dom, "#view").textContent).not.toContain("睡眠(28日)");
    expect(q(dom, "#view").textContent).toContain("就寝と起床の両方を記録した日ができると");
    expect(bands(dom)).toBe(0);
  });

  it("両方揃うと帯が出て、就寝と起床の線が引かれる", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    d.entries[dayAgo(f0, 0)] = { bedtimeMin: 1440, wakeMin: 420 };
    d.entries[dayAgo(f0, 1)] = { bedtimeMin: 1410, wakeMin: 390 };
    const dom = boot(JSON.stringify(d));
    openTrend(dom);
    expect(q(dom, "#view").textContent).toContain("睡眠(28日)");
    expect(bands(dom)).toBe(1);
    // 帯の上下の線(就寝・起床)が2本
    const svg = qa(dom, "svg").find((s) => s.querySelector("path[fill-opacity]"));
    expect(svg.querySelectorAll('path[fill="none"]').length).toBe(2);
  });

  // 欠損をまたいで塗ると、記録のない夜まで眠っていたことになる
  it("片方が欠けた日で帯を切る", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    [0, 1].forEach((n) => { d.entries[dayAgo(f0, n)] = { bedtimeMin: 1440, wakeMin: 420 }; });
    d.entries[dayAgo(f0, 2)] = { bedtimeMin: 1440 }; // 起床が無いので途切れる
    [3, 4].forEach((n) => { d.entries[dayAgo(f0, n)] = { bedtimeMin: 1440, wakeMin: 420 }; });
    const dom = boot(JSON.stringify(d));
    openTrend(dom);
    expect(bands(dom)).toBe(2);
  });

  it("孤立した1日は線分で示す", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    d.entries[dayAgo(f0, 3)] = { bedtimeMin: 1440, wakeMin: 420 };
    const dom = boot(JSON.stringify(d));
    openTrend(dom);
    expect(bands(dom)).toBe(0); // 幅0の帯は塗っても見えない
    expect(qa(dom, "#view line[stroke-opacity]").length).toBe(1);
  });

  // 帯の広さは推定であって実測ではない。断定表示するとバケット幅の誤差が見えなくなる
  it("睡眠時間を「◯時間」と数値で断定しない", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    d.entries[dayAgo(f0, 0)] = { bedtimeMin: 1440, wakeMin: 420 };
    d.entries[dayAgo(f0, 1)] = { bedtimeMin: 1440, wakeMin: 420 };
    const dom = boot(JSON.stringify(d));
    openTrend(dom);
    const view = q(dom, "#view").textContent;
    expect(view).not.toMatch(/\d+(\.\d+)?\s*時間/);
    expect(view).toContain("おおよその睡眠の長さ");
    expect(view).toContain("最大30分早い側");
  });
});

describe("PWA v4.0: 体重の自由入力", () => {
  const enterWeight = (dom, text) => {
    q(dom, '[data-f="weight"][data-v="t"]').click();
    const wv = q(dom, "#wv");
    wv.value = text;
    wv.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };
  const weightSvgText = (dom) => {
    byText(dom, "button.tb", "推移").click();
    const svgs = qa(dom, "svg");
    return [...svgs[svgs.length - 1].querySelectorAll("text")].map((t) => t.textContent).join(" ");
  };

  it("ドットが2つある入力は数値として読める先頭までに切り詰める", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    enterWeight(dom, "68.5.2");
    expect(f.getS().entries[f.fmt(new Date())].weightVal).toBe("68.5");
    expect(q(dom, "#wv").value).toBe("68.5"); // 再描画後の欄にも反映される
  });

  it("数字を含まない入力は未入力として捨てる", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    enterWeight(dom, ".");
    expect(f.getS().entries[f.fmt(new Date())].weightVal).toBe(undefined);
  });

  it("推移タブの体重チャートにNaNが出ない", () => {
    const dom = boot();
    enterWeight(dom, "68.5.2");
    expect(weightSvgText(dom)).not.toContain("NaN");
  });

  // entries は migrate() の正規化対象外なので、取り込みJSONからも壊れた値が入りうる
  it("取り込みJSONに数値でないweightValがあってもチャートが壊れない", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    d.entries[f0.fmt(new Date())] = { weight: true, weightVal: "6.8.5" };
    const dom = boot(JSON.stringify(d));
    byText(dom, "button.tb", "推移").click();
    const view = q(dom, "#view").textContent;
    expect(view).not.toContain("NaN");
    // 数値として読めない値は未入力と同じ扱いになり、チャートではなく案内文が出る
    expect(view).not.toContain("体重(28日)");
    expect(view).toContain("体重の数値を入力すると");
  });
});

describe("PWA v4.0: 朝コーヒー", () => {
  // カスタム項目は「昨日」カードに入る仕様なので、当朝の行動である朝コーヒーは CORE 側に置く
  it("記録タブの「今朝」カードにあり、✓ したで保存される", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    const card = qa(dom, ".card").find((el) => el.textContent.includes("今朝"));
    expect(card.textContent).toContain("朝コーヒー");
    q(dom, '[data-f="coffee"][data-v="t"]').click();
    expect(JSON.parse(dom.window.localStorage.getItem(KEY)).entries[f.fmt(new Date())].coffee).toBe(true);
  });

  it("週の目標と週タブの達成率に入る", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    expect(d.targets.coffee).toBe(6);
    d.entries[f0.fmt(new Date())] = { coffee: true };
    const dom = boot(JSON.stringify(d));
    byText(dom, "button.tb", "週").click();
    const wrow = qa(dom, ".wrow").find((el) => el.textContent.includes("朝コーヒー"));
    expect(wrow.textContent).toContain("1/6");
    expect(wrow.querySelectorAll(".dot.ok").length).toBe(1);
    byText(dom, "button.tb", "設定").click();
    expect(qa(dom, "[data-tgt]").some((el) => el.dataset.tgt === "coffee")).toBe(true);
  });

  it("CSVに朝コーヒーの列が入る", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    d.entries["2026-08-08"] = { coffee: false };
    const [head, row] = f.buildCSV(d).split("\n");
    expect(head).toContain("朝コーヒー");
    expect(head.split(",").indexOf("朝コーヒー")).toBe(head.split(",").indexOf("クレアチン") - 1);
    expect(row).toBe("2026-08-08,,,,,,0,,,,,,,,,,,,,,,,,,");
  });

  it("coffee を持たない旧データも既定値で埋まる", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({ version: 3, targets: { gym: 4 }, entries: { "2026-08-01": { gym: true } } });
    expect(m.targets.coffee).toBe(6);
    expect(m.targets.gym).toBe(4); // 既存の設定は上書きしない
    expect(m.enabled.coffee).toBe(true);
  });

  it("表示トグルを切ると記録タブから消える", () => {
    const dom = boot();
    expect(q(dom, '[data-f="coffee"]')).not.toBe(null);
    byText(dom, "button.tb", "設定").click();
    q(dom, '[data-tog="coffee"]').click();
    byText(dom, "button.tb", "記録").click();
    expect(q(dom, '[data-f="coffee"]')).toBe(null);
  });
});

describe("PWA v4.0: 週タブの前週併記", () => {
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

describe("PWA v4.0: サウナ・歩数・休肝日", () => {
  const today = (f) => f.fmt(new Date());

  it("3項目とも「昨日」カードにあり、1タップで保存される", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    const card = qa(dom, ".card").find((el) => el.textContent.includes("昨日"));
    ["サウナ", "歩数", "休肝日"].forEach((l) => expect(card.textContent).toContain(l));
    q(dom, '[data-f="sauna"][data-v="t"]').click();
    q(dom, '[data-f="steps"][data-v="3"]').click();
    q(dom, '[data-f="sober"][data-v="t"]').click();
    const e = JSON.parse(dom.window.localStorage.getItem(KEY)).entries[today(f)];
    expect(e).toEqual({ sauna: true, steps: 3, sober: true });
  });

  // 週タブの「◯/◯」が「飲んだ日数」に読めてしまうので、飲まなかった日を数える向きで持つ
  it("休肝日は「飲まなかった」が達成側になる", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    expect(byText(dom, "button.sb", "✓ 飲まなかった").dataset.v).toBe("t");
    expect(f.achieved(f.defaultData(), { sober: true }, "sober")).toBe(true);
    expect(f.achieved(f.defaultData(), { sober: false }, "sober")).toBe(false);
  });

  // 就寝・YouTube と違い、歩数は「達成ライン以上」で達成
  it("歩数は達成ライン以上で達成になる", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    expect(d.th.steps).toBe(2);
    expect(f.achieved(d, { steps: 0 }, "steps")).toBe(false);
    expect(f.achieved(d, { steps: 1 }, "steps")).toBe(false);
    expect(f.achieved(d, { steps: 2 }, "steps")).toBe(true);
    expect(f.achieved(d, { steps: 3 }, "steps")).toBe(true);
    expect(f.achieved(d, {}, "steps")).toBe(null);
    d.th.steps = 3;
    expect(f.achieved(d, { steps: 2 }, "steps")).toBe(false);
  });

  // 最下段を選べるようにすると、どれを選んでも達成になり達成ラインが意味を失う
  it("歩数の達成ラインは設定タブで変えられ、最下段は選べない", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    byText(dom, "button.tb", "設定").click();
    const sel = q(dom, '[data-th="steps"]');
    expect([...sel.options].map((o) => o.value)).toEqual(["1", "2", "3"]);
    sel.value = "3";
    sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(f.getS().th.steps).toBe(3);
    expect(JSON.parse(dom.window.localStorage.getItem(KEY)).th.steps).toBe(3);
  });

  it("週タブと週の目標に3項目とも並ぶ", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    d.entries[today(f0)] = { sauna: true, steps: 3, sober: true };
    const dom = boot(JSON.stringify(d));
    byText(dom, "button.tb", "週").click();
    const wrow = (l) => qa(dom, ".wrow").find((el) => el.textContent.includes(l));
    expect(wrow("サウナ").textContent).toContain("1/2");
    expect(wrow("歩数").textContent).toContain("1/5");
    expect(wrow("休肝日").textContent).toContain("1/4");
    expect(wrow("休肝日").querySelectorAll(".dot.ok").length).toBe(1);
  });

  it("推移タブに歩数のチャートが出る", () => {
    const dom = boot();
    byText(dom, "button.tb", "推移").click();
    expect(q(dom, "#view").textContent).toContain("歩数(28日)");
  });

  it("28日そろうと休肝日の相関ヒントが計算される", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    for (let i = 0; i < 28; i++) {
      const dt = new Date("2026-07-01T00:00");
      dt.setDate(dt.getDate() + i);
      d.entries[f0.fmt(dt)] = { sober: i % 2 === 0, sleepFeel: i % 2 === 0 ? 2 : 0 };
    }
    const dom = boot(JSON.stringify(d));
    byText(dom, "button.tb", "週報").click();
    const view = q(dom, "#view").textContent;
    expect(view).toContain("前日に酒を飲んだ × 眠れた感「良」");
    expect(view).toContain("φ=1.00");
  });
});

describe("PWA v4.0: 食事の節制", () => {
  const today = (f) => f.fmt(new Date());

  // 朝には埋まらない項目なので、他のカードから分けて当日を指すカードに置く
  it("「今日の食事」カードに3食ぶんあり、食べるたびに1タップで保存される", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    const card = qa(dom, ".card").find((el) => el.textContent.includes("今日の食事"));
    ["朝食", "昼食", "夕食"].forEach((l) => expect(card.textContent).toContain(l));
    q(dom, '[data-f="mealB"][data-v="t"]').click();
    q(dom, '[data-f="mealL"][data-v="f"]').click();
    const e = JSON.parse(dom.window.localStorage.getItem(KEY)).entries[today(f)];
    expect(e).toEqual({ mealB: true, mealL: false });
  });

  // 記録しなかった食事は欠損であり失敗ではないので、達成の分母に入れない
  it("記録した食事がすべて節制なら達成、1食でも崩れたら未達", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    expect(f.achieved(d, { mealB: true, mealL: true, mealD: true }, "meal")).toBe(true);
    expect(f.achieved(d, { mealB: true }, "meal")).toBe(true);
    expect(f.achieved(d, { mealB: true, mealD: false }, "meal")).toBe(false);
    expect(f.achieved(d, {}, "meal")).toBe(null);
    expect(f.achieved(d, { gym: true }, "meal")).toBe(null);
  });

  it("週タブでは3行ではなく1行の達成率に畳まれる", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    d.entries[today(f0)] = { mealB: true, mealL: true };
    const dom = boot(JSON.stringify(d));
    byText(dom, "button.tb", "週").click();
    const rows = qa(dom, ".wrow").filter((el) => el.textContent.includes("食事"));
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain("1/5");
    expect(q(dom, "#view").textContent).not.toContain("朝食");
  });

  it("表示トグルを切るとカードごと消える", () => {
    const dom = boot();
    byText(dom, "button.tb", "設定").click();
    q(dom, '[data-tog="meal"]').click();
    byText(dom, "button.tb", "記録").click();
    expect(q(dom, '[data-f="mealB"]')).toBe(null);
    expect(q(dom, "#view").textContent).not.toContain("今日の食事");
  });
});

describe("PWA v4.0: v5 スキーマ", () => {
  it("v5 データを読んでも既存の設定を保ち、新項目は既定値で埋まる", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({
      version: 5,
      targets: { gym: 4 },
      th: { bedtime: 0 },
      entries: { "2026-08-01": { gym: true } },
    });
    expect(m.version).toBe(9);
    expect(m.targets.gym).toBe(4);
    expect(m.th.bedtimeMin).toBe(1380);
    // 達成ラインを設定していない旧データは、シフトの対象ではなく新既定で埋まる
    expect(m.th.steps).toBe(2);
    ["sauna", "steps", "sober", "meal"].forEach((id) => {
      expect(m.targets[id]).toBeGreaterThan(0);
      expect(m.enabled[id]).toBe(true);
    });
    expect(m.entries["2026-08-01"]).toEqual({ gym: true });
  });

  // 項目を足したときに結線を忘れても気づけるよう、目標の一覧から自動で検査対象に入れる
  it("週の目標を持つ項目はすべて表示トグルとステッパーを持つ", () => {
    const dom = boot();
    const d = dom.window.__flourish.defaultData();
    byText(dom, "button.tb", "設定").click();
    const tgts = qa(dom, "[data-tgt]").map((el) => el.dataset.tgt);
    const togs = qa(dom, "[data-tog]").map((el) => el.dataset.tog);
    Object.keys(d.targets).forEach((id) => {
      expect(d.enabled[id]).toBe(true);
      expect(tgts).toContain(id);
      expect(togs).toContain(id);
    });
  });

  it("CSVと週報データに新項目が入る", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    d.entries["2026-08-08"] = { sauna: true, steps: 3, sober: false, mealB: true, mealD: false };
    const [head, row] = f.buildCSV(d).split("\n");
    ["サウナ", "歩数", "休肝日", "朝食", "昼食", "夕食"].forEach((c) => expect(head).toContain(c));
    expect(row).toBe("2026-08-08,,,,,,,,,,,,1,,1万以上,0,1,,0,,,,,,");
    const t = f.buildReviewText(d, "2026-08-08");
    expect(t).toContain("steps=[3千以下,5千,8千,1万以上]");
    expect(t).toContain("休肝日は酒を飲まなかった日");
    expect(t).toContain('"steps":');
  });
});

describe("PWA v4.0: 整腸剤・サプリ", () => {
  const today = (f) => f.fmt(new Date());

  it("「今日のサプリ」カードに朝昼晩があり、飲むたびに1タップで保存される", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    const card = qa(dom, ".card").find((el) => el.textContent.includes("今日のサプリ"));
    ["朝サプリ", "昼サプリ", "晩サプリ"].forEach((l) => expect(card.textContent).toContain(l));
    q(dom, '[data-f="suppM"][data-v="t"]').click();
    q(dom, '[data-f="suppN"][data-v="f"]').click();
    const e = JSON.parse(dom.window.localStorage.getItem(KEY)).entries[today(f)];
    expect(e).toEqual({ suppM: true, suppN: false });
  });

  // 食事と同じ畳み方。記録しなかった回は欠損であり失敗ではないので分母に入れない
  it("記録した回がすべて「飲んだ」なら達成、1回でも抜けたら未達", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    expect(f.achieved(d, { suppM: true, suppN: true, suppE: true }, "supp")).toBe(true);
    expect(f.achieved(d, { suppM: true }, "supp")).toBe(true);
    expect(f.achieved(d, { suppM: true, suppE: false }, "supp")).toBe(false);
    expect(f.achieved(d, {}, "supp")).toBe(null);
    expect(f.achieved(d, { mealB: true }, "supp")).toBe(null);
  });

  it("週タブでは1行に畳まれ、食事とは別の行になる", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    d.entries[today(f0)] = { suppM: true, suppN: true, mealB: false };
    const dom = boot(JSON.stringify(d));
    byText(dom, "button.tb", "週").click();
    const rows = qa(dom, ".wrow").filter((el) => el.textContent.includes("整腸剤・サプリ"));
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain("1/6");
    expect(rows[0].querySelectorAll(".dot.ok").length).toBe(1);
    const meal = qa(dom, ".wrow").find((el) => el.textContent.includes("食事の節制"));
    expect(meal.querySelectorAll(".dot.ng").length).toBe(1);
    expect(q(dom, "#view").textContent).not.toContain("朝サプリ");
  });

  // クレアチンとアシュワガンダは個別に効果を見るため独立の項目のまま残す
  it("既存のサプリ項目を吸収していない", () => {
    const dom = boot();
    expect(q(dom, '[data-f="creatine"]')).not.toBe(null);
    expect(q(dom, '[data-f="ashwagandha"]')).not.toBe(null);
    const card = qa(dom, ".card").find((el) => el.textContent.includes("今日のサプリ"));
    expect(card.textContent).not.toContain("クレアチン");
    expect(card.textContent).not.toContain("アシュワガンダ");
  });

  it("表示トグルを切るとカードごと消え、食事のカードは残る", () => {
    const dom = boot();
    byText(dom, "button.tb", "設定").click();
    q(dom, '[data-tog="supp"]').click();
    byText(dom, "button.tb", "記録").click();
    expect(q(dom, '[data-f="suppM"]')).toBe(null);
    expect(q(dom, "#view").textContent).not.toContain("今日のサプリ");
    expect(q(dom, "#view").textContent).toContain("今日の食事");
  });

  it("v5 データを読んでも既存の設定を保ち、サプリは既定値で埋まる", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({ version: 5, targets: { meal: 3 }, entries: { "2026-08-01": { mealB: true } } });
    expect(m.version).toBe(9);
    expect(m.targets.meal).toBe(3);
    expect(m.targets.supp).toBe(6);
    expect(m.enabled.supp).toBe(true);
    expect(m.entries["2026-08-01"]).toEqual({ mealB: true });
  });

  it("CSVと週報データにサプリが入る", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    d.entries["2026-08-08"] = { suppM: true, suppE: false };
    const [head, row] = f.buildCSV(d).split("\n");
    ["朝サプリ", "昼サプリ", "晩サプリ"].forEach((c) => expect(head).toContain(c));
    expect(row).toBe("2026-08-08,,,,,,,,,,,,,,,,,,,1,,0,,,");
    expect(f.buildReviewText(d, "2026-08-08")).toContain("食事の節制と整腸剤・サプリは1日3回ぶんを記録し");
  });
});

describe("PWA v4.0: PCへの同期(任意)", () => {
  const SYNC_KEY = "flourish-log-v2-sync";
  const URL_OK = "https://pc.example-tailnet.ts.net/aubade";
  // fetch は JSDOM に無い。呼ばれた内容を記録し、応答を差し替えられるようにする
  const stubFetch = (dom, impl) => {
    const calls = [];
    dom.window.fetch = (url, init) => { calls.push({ url, init }); return impl(url, init); };
    return calls;
  };
  const ok = () => Promise.resolve({ ok: true, status: 200 });
  // JSDOM の setTimeout をそのまま待つと4秒かかる。差し替えて任意に進める。
  // アプリがタイマーを積む前に仕込まないと本物の setTimeout が使われるので、
  // クリックより先に useFakeTimers を呼ぶこと
  const useFakeTimers = (dom) => {
    const w = dom.window;
    w.__timers = [];
    w.__now = 0;
    const realSet = w.setTimeout;
    w.setTimeout = (fn, delay) => {
      if (typeof delay !== "number" || delay < 50) return realSet(fn, delay);
      return "fake:" + (w.__timers.push({ fn, at: w.__now + delay }) - 1);
    };
    w.clearTimeout = (id) => {
      if (typeof id === "string" && id.startsWith("fake:")) w.__timers[+id.slice(5)] = null;
    };
  };
  const advance = async (dom, ms) => {
    const w = dom.window;
    w.__now += ms;
    for (let i = 0; i < w.__timers.length; i++) {
      const t = w.__timers[i];
      if (t && t.at <= w.__now) { w.__timers[i] = null; t.fn(); }
    }
    await tick();
  };
  const configure = (dom, url, token) => {
    const f = dom.window.__flourish;
    byText(dom, "button.tb", "設定").click();
    const set = (id, v) => {
      const el = q(dom, "#" + id);
      el.value = v;
      el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    };
    set("syncUrl", url);
    set("syncToken", token);
    return f;
  };

  it("未設定なら何も送らない", async () => {
    const dom = boot();
    const calls = stubFetch(dom, ok);
    byText(dom, "button.sb", "✓ した").click();
    dom.window.__flourish.syncPush();
    await tick();
    expect(calls.length).toBe(0);
  });

  it("設定するとURLとトークンが本体とは別のキーに保存される", () => {
    const dom = boot();
    configure(dom, URL_OK, "t".repeat(32));
    const saved = JSON.parse(dom.window.localStorage.getItem(SYNC_KEY));
    expect(saved.url).toBe(URL_OK);
    expect(saved.token).toBe("t".repeat(32));
    // 本体データに混ざっていない = バックアップJSONにも週報にも出ない
    const main = dom.window.localStorage.getItem("flourish-log-v2") || "{}";
    expect(main).not.toContain("ts.net");
    expect(main).not.toContain("t".repeat(32));
  });

  // トークンがバックアップに混ざると、コピーや共有のたびに一緒に出ていく
  it("JSON/CSVの書き出しにトークンが混ざらない", () => {
    const dom = boot();
    const f = configure(dom, URL_OK, "seekrit-token-seekrit-token-1234");
    expect(JSON.stringify(f.getS())).not.toContain("seekrit");
    expect(f.buildCSV(f.getS())).not.toContain("seekrit");
    expect(f.buildReviewText(f.getS(), f.fmt(new Date()))).not.toContain("seekrit");
  });

  it("送信は設定したURLへ、Bearerトークンと全履歴で行う", async () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    d.entries["2026-08-01"] = { gym: true };
    const dom = boot(JSON.stringify(d));
    const calls = stubFetch(dom, ok);
    configure(dom, URL_OK, "t".repeat(32));
    dom.window.__flourish.syncPush();
    await tick();
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(URL_OK);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.Authorization).toBe("Bearer " + "t".repeat(32));
    expect(JSON.parse(calls[0].init.body).entries["2026-08-01"].gym).toBe(true);
  });

  // 200 は受信側が書き終えた合図。ここまで来たら実際に持ち出せている
  it("成功したら同期日とバックアップ日を記録する", async () => {
    const dom = boot();
    stubFetch(dom, ok);
    const f = configure(dom, URL_OK, "t".repeat(32));
    f.syncPush();
    await tick();
    const today = f.fmt(new Date());
    expect(JSON.parse(dom.window.localStorage.getItem(SYNC_KEY)).last).toBe(today);
    expect(JSON.parse(dom.window.localStorage.getItem("flourish-log-v2")).lastBackup).toBe(today);
    expect(q(dom, "#syncline").textContent).toContain("同期しました");
  });

  // PCが落ちている・tailnet 外にいるのは日常的に起きる。失敗しても記録は端末に残る
  it("失敗しても保存は壊れず、バックアップ日も進めない", async () => {
    const dom = boot();
    stubFetch(dom, () => Promise.reject(new Error("接続できない")));
    const f = configure(dom, URL_OK, "t".repeat(32));
    f.syncPush();
    await tick();
    expect(f.getS().lastBackup).toBe(null);
    expect(JSON.parse(dom.window.localStorage.getItem(SYNC_KEY)).last).toBe(null);
    expect(q(dom, "#syncline").textContent).toContain("同期できませんでした");
    // 保存は通常どおり続けられる
    byText(dom, "button.tb", "記録").click();
    byText(dom, "button.sb", "✓ した").click();
    expect(JSON.parse(dom.window.localStorage.getItem("flourish-log-v2")).entries[f.fmt(new Date())].ashwagandha).toBe(true);
  });

  it("HTTPエラー応答を成功として扱わない", async () => {
    const dom = boot();
    stubFetch(dom, () => Promise.resolve({ ok: false, status: 401 }));
    const f = configure(dom, URL_OK, "t".repeat(32));
    f.syncPush();
    await tick();
    expect(f.getS().lastBackup).toBe(null);
    expect(JSON.parse(dom.window.localStorage.getItem(SYNC_KEY)).last).toBe(null);
    expect(q(dom, "#syncline").textContent).toContain("同期できませんでした");
  });

  // CSP は *.ts.net しか許さない。他を保存できると、送れない理由が画面から消える
  it("ts.net 以外のURLは保存せず理由を出す", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    expect(f.syncUrlOk("https://pc.example-tailnet.ts.net/aubade")).toBe(true);
    expect(f.syncUrlOk("https://evil.example.com/aubade")).toBe(false);
    expect(f.syncUrlOk("http://pc.example-tailnet.ts.net/")).toBe(false); // 平文は不可
    expect(f.syncUrlOk("https://ts.net.evil.com/")).toBe(false);
    // URLだけを入れる。トークンまで入れると syncNote が消えて理由が見えなくなる
    byText(dom, "button.tb", "設定").click();
    const el = q(dom, "#syncUrl");
    el.value = "https://evil.example.com/aubade";
    el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(q(dom, "#syncline").textContent).toContain("ts.net");
    expect(dom.window.localStorage.getItem(SYNC_KEY) || "").not.toContain("evil");
  });

  // save() から scheduleSync() が落ちても、syncPush を直接叩くテストは全部緑のまま通る。
  // 自動同期は iOS PWA では唯一の送信経路なので、結線そのものを縛る
  it("保存すると、待ち時間のあとに実際に送られる", async () => {
    const dom = boot();
    const calls = stubFetch(dom, ok);
    configure(dom, URL_OK, "t".repeat(32));
    useFakeTimers(dom);
    byText(dom, "button.tb", "記録").click();
    byText(dom, "button.sb", "✓ した").click();
    expect(calls.length).toBe(0);
    await advance(dom, 4000);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(URL_OK);
    const f = dom.window.__flourish;
    expect(JSON.parse(calls[0].init.body).entries[f.fmt(new Date())].ashwagandha).toBe(true);
  });

  it("連続タップは1回にまとまる", async () => {
    const dom = boot();
    const calls = stubFetch(dom, ok);
    configure(dom, URL_OK, "t".repeat(32));
    useFakeTimers(dom);
    byText(dom, "button.tb", "記録").click();
    byText(dom, "button.sb", "✓ した").click();
    await advance(dom, 2000);
    pickMin(dom, "bedtimeMin", "1380"); // 2回目の保存で待ち時間が延びる
    await advance(dom, 2000);
    expect(calls.length).toBe(0);
    await advance(dom, 2000);
    expect(calls.length).toBe(1);
  });

  it("保存のたびに送らず、まとめてから送る", async () => {
    const dom = boot();
    const calls = stubFetch(dom, ok);
    configure(dom, URL_OK, "t".repeat(32));
    byText(dom, "button.tb", "記録").click();
    byText(dom, "button.sb", "✓ した").click();
    pickMin(dom, "bedtimeMin", "1380");
    await tick();
    expect(calls.length).toBe(0); // 待ち時間の前には飛ばない
  });

  // 送信の成功で lastBackup を更新するので、save() を呼ぶと保存→同期→保存の再帰になる
  it("同期の成功が次の同期を呼び戻さない", async () => {
    const dom = boot();
    const calls = stubFetch(dom, ok);
    const f = configure(dom, URL_OK, "t".repeat(32));
    f.syncPush();
    await tick();
    await tick();
    expect(calls.length).toBe(1);
  });

  it("取り込んだJSONで送信先が書き換わらない", () => {
    const dom = boot();
    const f = configure(dom, URL_OK, "t".repeat(32));
    byText(dom, "button.tb", "設定").click();
    q(dom, "#imp").value = JSON.stringify({ version: 6, entries: {}, url: "https://evil.example.com", token: "x" });
    byText(dom, "button.ghost", "取り込む").click();
    expect(f.getSync().url).toBe(URL_OK);
    expect(f.getSync().token).toBe("t".repeat(32));
  });

  it("fetch が無い環境でも例外を投げない", async () => {
    const dom = boot();
    const f = configure(dom, URL_OK, "t".repeat(32));
    dom.window.fetch = undefined;
    expect(() => f.syncPush()).not.toThrow();
    expect(q(dom, "#syncline").textContent).toContain("この端末では同期できません");
  });
});

describe("PWA v4.0: 同期の取り扱いを壊さない", () => {
  const SYNC_KEY = "flourish-log-v2-sync";
  const URL_OK = "https://pc.example-tailnet.ts.net/aubade";
  const stubFetch = (dom, impl) => {
    const calls = [];
    dom.window.fetch = (url, init) => { calls.push({ url, init }); return impl(url, init); };
    return calls;
  };
  const ok = () => Promise.resolve({ ok: true, status: 200 });
  const setField = (dom, id, v) => {
    const el = q(dom, "#" + id);
    el.value = v;
    el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };
  const configure = (dom) => {
    byText(dom, "button.tb", "設定").click();
    setField(dom, "syncUrl", URL_OK);
    setField(dom, "syncToken", "t".repeat(32));
    return dom.window.__flourish;
  };

  // 受信側は32文字未満を拒む。ここで通すと「毎回401」を理由不明のまま繰り返す
  it("短すぎるトークンは保存せず、理由を出す", () => {
    const dom = boot();
    byText(dom, "button.tb", "設定").click();
    setField(dom, "syncUrl", URL_OK);
    setField(dom, "syncToken", "short");
    expect(q(dom, "#syncline").textContent).toContain("32文字以上");
    expect(dom.window.__flourish.getSync().token).toBe("");
  });

  // 全再描画にすると、書きかけの取り込みJSONやカスタム項目名まで消える
  it("同期の結果表示が、設定タブの書きかけ入力を消さない", async () => {
    const dom = boot();
    stubFetch(dom, ok);
    const f = configure(dom);
    q(dom, "#imp").value = '{"書きかけ": true}';
    q(dom, "#newLabel").value = "読書";
    f.syncPush();
    await tick();
    expect(q(dom, "#syncline").textContent).toContain("同期しました");
    expect(q(dom, "#imp").value).toBe('{"書きかけ": true}');
    expect(q(dom, "#newLabel").value).toBe("読書");
  });

  // 送信先を残したまま消すと、空の全履歴がPCへ送られて向こうの控えまで巻き添えになる
  it("すべてのデータを削除すると、同期の設定も消える", () => {
    const dom = boot();
    const f = configure(dom);
    expect(f.getSync().url).toBe(URL_OK);
    byText(dom, "button.danger", "すべてのデータを削除…").click();
    byText(dom, "button.danger", "本当に削除する(取り消せません)").click();
    expect(f.getSync().url).toBe("");
    expect(f.getSync().token).toBe("");
    expect(JSON.parse(dom.window.localStorage.getItem(SYNC_KEY)).url).toBe("");
  });

  it("削除後は何も送らない", async () => {
    const dom = boot();
    const calls = stubFetch(dom, ok);
    const f = configure(dom);
    byText(dom, "button.danger", "すべてのデータを削除…").click();
    byText(dom, "button.danger", "本当に削除する(取り消せません)").click();
    f.syncPush();
    await tick();
    expect(calls.length).toBe(0);
  });

  // 4秒の待ちの途中で閉じられると、その回は送られないまま終わる
  it("画面が隠れるとき、保留中の同期を流す", async () => {
    const dom = boot();
    const calls = stubFetch(dom, ok);
    configure(dom);
    byText(dom, "button.tb", "記録").click();
    byText(dom, "button.sb", "✓ した").click();
    expect(calls.length).toBe(0);
    Object.defineProperty(dom.window.document, "visibilityState", { value: "hidden", configurable: true });
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await tick();
    expect(calls.length).toBe(1);
  });

  it("保留が無いときは隠れても送らない", async () => {
    const dom = boot();
    const calls = stubFetch(dom, ok);
    configure(dom);
    Object.defineProperty(dom.window.document, "visibilityState", { value: "hidden", configurable: true });
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await tick();
    expect(calls.length).toBe(0);
  });
});

describe("PWA v4.0: v7 スキーマ(歩数の4段階化)", () => {
  // 旧0/1/2 は各段の上限が新1/2/3 と一致する。達成ラインも同じだけ動かす
  it("旧データの歩数と達成ラインを +1 して読み替える", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({
      version: 6,
      th: { steps: 1 },
      entries: {
        "2026-08-01": { steps: 0 },
        "2026-08-02": { steps: 1, gym: true },
        "2026-08-03": { steps: 2 },
      },
    });
    expect(m.version).toBe(9);
    expect(m.th.steps).toBe(2);
    expect(m.entries["2026-08-01"].steps).toBe(1);
    expect(m.entries["2026-08-02"]).toEqual({ steps: 2, gym: true });
    expect(m.entries["2026-08-03"].steps).toBe(3);
  });

  // 取り込みJSONは version キーを欠きうる。Object.assign は既定値で埋めるので、
  // 生の入力ではなく o.version で版を判定すると、この経路のシフトだけが丸ごと効かなくなる
  it("version キーを持たない入力でも歩数を読み替える", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({ th: { steps: 1 }, entries: { "2026-08-01": { steps: 2 } } });
    expect(m.entries["2026-08-01"].steps).toBe(3);
    expect(m.th.steps).toBe(2);
  });

  // 版は defaultData と migrate の2箇所に書かれている。片方だけ上げると、
  // 保存済みデータが毎回「古い版」と判定され続けて移行が繰り返し走る
  it("migrate が書き込む版は defaultData の版と一致し、二度通しても動かない", () => {
    const f = boot().window.__flourish;
    const v = f.defaultData().version;
    expect(f.migrate({}).version).toBe(v);
    expect(f.migrate(f.migrate({ version: 5, entries: {} })).version).toBe(v);
  });

  // 読み替えの目的は「過去の達成/未達が1つも変わらない」こと。旧仕様の式を右辺に置いて突き合わせる
  it("読み替えても過去の達成判定が1つも変わらない", () => {
    const f = boot().window.__flourish;
    [1, 2].forEach((oldTh) => {
      const old = { version: 6, th: { steps: oldTh }, entries: {} };
      [0, 1, 2].forEach((v) => { old.entries["2026-08-0" + (v + 1)] = { steps: v }; });
      const m = f.migrate(old);
      [0, 1, 2].forEach((v) => {
        const dt = "2026-08-0" + (v + 1);
        expect(f.achieved(m, m.entries[dt], "steps")).toBe(v >= oldTh);
      });
    });
  });

  it("読み替え済みのデータを二度通しても再シフトしない", () => {
    const f = boot().window.__flourish;
    const once = f.migrate({ version: 6, th: { steps: 1 }, entries: { "2026-08-01": { steps: 1 } } });
    const twice = f.migrate(once);
    expect(twice.entries["2026-08-01"].steps).toBe(2);
    expect(twice.th.steps).toBe(2);
  });

  // 同じJSONを二度取り込む経路があるので、入力オブジェクト自体を書き換えてはいけない
  it("migrate は入力の entries を書き換えない", () => {
    const f = boot().window.__flourish;
    const src = { version: 6, entries: { "2026-08-01": { steps: 1 } } };
    f.migrate(src);
    expect(src.entries["2026-08-01"].steps).toBe(1);
    expect(f.migrate(src).entries["2026-08-01"].steps).toBe(2);
  });

  it("保存して再起動しても歩数が二重にずれない", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    d.version = 6;
    d.th.steps = 1;
    d.entries["2026-08-01"] = { steps: 1 };
    const dom1 = boot(JSON.stringify(d));
    dom1.window.__flourish.save();
    const saved = dom1.window.localStorage.getItem(KEY);
    expect(JSON.parse(saved).entries["2026-08-01"].steps).toBe(2);
    const f2 = boot(saved).window.__flourish;
    expect(f2.getS().entries["2026-08-01"].steps).toBe(2);
    expect(f2.getS().th.steps).toBe(2);
  });

  // 取り込みJSONは任意の値になりうる。読み替えは数値の 0..2 だけに効かせ、他は素通しする
  it("壊れた歩数の値は例外を出さずそのまま残す", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({
      version: 6,
      entries: {
        a: { steps: "1" },
        b: { steps: 1.5 },
        c: { steps: 9 },
        e: { steps: [1] },
        g: null,
      },
    });
    expect(m.entries.a.steps).toBe("1");
    expect(m.entries.b.steps).toBe(1.5);
    expect(m.entries.c.steps).toBe(9);
    expect(m.entries.e.steps).toEqual([1]);
    expect(m.entries.g).toBe(null);
  });

  // 段数を書き写すと、最上段が例外も出さずに集計から落ちる
  it("週報データの歩数の分布が段数ぶんあり、最上段も数えられる", () => {
    const f = boot().window.__flourish;
    const top = f.STEP_OPTS.length - 1;
    const d = f.defaultData();
    const ws = f.weekStart(new Date("2026-08-05T00:00"));
    const day = (n) => f.fmt(new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + n));
    d.entries[day(0)] = { steps: top };
    d.entries[day(1)] = { steps: 0 };
    const s = f.weekStats(d, ws, day(6));
    expect(s.steps.length).toBe(f.STEP_OPTS.length);
    expect(s.steps[top]).toBe(1);
    expect(s.steps[0]).toBe(1);
  });

  // Y軸の範囲を段数に合わせないと、最上段の点が枠の外へ出て黙って消える
  it("推移タブの歩数チャートに全段の目盛りが出て、最上段の点が枠に収まる", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    d.entries[f0.fmt(new Date())] = { steps: f0.STEP_OPTS.length - 1 };
    const dom = boot(JSON.stringify(d));
    byText(dom, "button.tb", "推移").click();
    const card = qa(dom, ".card").find((el) => el.textContent.includes("歩数("));
    f0.STEP_OPTS.forEach((l) => expect(card.textContent).toContain(l));
    const cys = [...card.querySelectorAll("circle")].map((c) => +c.getAttribute("cy"));
    expect(cys.length).toBe(1);
    cys.forEach((cy) => {
      expect(cy).toBeGreaterThanOrEqual(8);   // svgChart の上余白 T
      expect(cy).toBeLessThanOrEqual(130);    // T + 描画高さ
    });
  });
});

describe("PWA v4.0: タンパク質", () => {
  const today = (f) => f.fmt(new Date());

  // 前日を指す項目なので「昨日」カードに置く。「今朝」に置くと指す時点が変わる
  it("「昨日」カードにあり、1タップで保存される", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    const card = qa(dom, ".card").find((el) => el.textContent.includes("昨日"));
    expect(card.textContent).toContain("タンパク質");
    expect(card.textContent).toContain("規定量以上とれたか");
    expect(card.querySelector('[data-f="protein"]')).not.toBe(null);
    q(dom, '[data-f="protein"][data-v="t"]').click();
    expect(JSON.parse(dom.window.localStorage.getItem(KEY)).entries[today(f)]).toEqual({ protein: true });
  });

  it("達成判定は「した」だけが達成で、未入力は未達にしない", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    expect(f.achieved(d, { protein: true }, "protein")).toBe(true);
    expect(f.achieved(d, { protein: false }, "protein")).toBe(false);
    expect(f.achieved(d, {}, "protein")).toBe(null);
  });

  it("週タブと週の目標に並ぶ", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    d.entries[today(f0)] = { protein: true };
    const dom = boot(JSON.stringify(d));
    byText(dom, "button.tb", "週").click();
    const wrow = qa(dom, ".wrow").find((el) => el.textContent.includes("タンパク質"));
    expect(wrow.textContent).toContain("1/" + d.targets.protein);
    expect(wrow.querySelectorAll(".dot.ok").length).toBe(1);
  });

  it("CSVにタンパク質の列がサウナと歩数の間に入る", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    d.entries["2026-08-08"] = { protein: false };
    const [head, row] = f.buildCSV(d).split("\n");
    const cols = head.split(",");
    const i = cols.indexOf("タンパク質");
    expect(i).toBeGreaterThan(-1);
    expect(row.split(",")[i]).toBe("0");
    // 位置がずれると以降の歩数・休肝日・食事・サプリ・カスタムが1つずつ右へ動く
    expect(cols[i - 1]).toBe("サウナ");
    expect(cols[i + 1]).toBe("歩数");
  });

  it("週報データに達成数と数え方が入る", () => {
    const f = boot().window.__flourish;
    const t = f.buildReviewText(f.defaultData(), "2026-08-08");
    expect(t).toContain("タンパク質は前日に規定量以上とれた日");
    expect(t).toContain('"タンパク質"');
  });

  it("protein を持たない旧データも既定値で埋まり、既存の設定は残る", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({ version: 6, targets: { gym: 4 }, entries: { "2026-08-01": { gym: true } } });
    expect(m.targets.protein).toBe(6);
    expect(m.enabled.protein).toBe(true);
    expect(m.targets.gym).toBe(4);
  });

  it("表示トグルを切ると記録タブから消える", () => {
    const dom = boot();
    expect(q(dom, '[data-f="protein"]')).not.toBe(null);
    byText(dom, "button.tb", "設定").click();
    q(dom, '[data-tog="protein"]').click();
    byText(dom, "button.tb", "記録").click();
    expect(q(dom, '[data-f="protein"]')).toBe(null);
  });
});

describe("PWA v4.0: 今の気分", () => {
  const today = (f) => f.fmt(new Date());

  // PERDAY と同じくその場で1タップするので、指す時点は記録した朝ではなく当日
  it("「今日の気分」カードに朝・昼・晩の3枠があり、1タップで当日に保存される", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    const card = qa(dom, ".card").find((el) => el.textContent.includes("今日の気分"));
    expect(card).not.toBe(undefined);
    ["朝", "昼", "晩"].forEach((l) => expect(card.textContent).toContain(l));
    q(dom, '[data-f="moodM"][data-v="0"]').click();
    q(dom, '[data-f="moodE"][data-v="2"]').click();
    expect(JSON.parse(dom.window.localStorage.getItem(KEY)).entries[today(f)]).toEqual({ moodM: 0, moodE: 2 });
  });

  // 設計制約6: 主観状態は直接コントロールできないので目標化しない
  it("気分は計測のみで、目標も達成ラインも週タブの行も持たない", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    expect(d.targets.mood).toBe(undefined);
    expect(d.th.mood).toBe(undefined);
    expect(f0.CORE.some((c) => c.id === "mood")).toBe(false);
    f0.MOOD.parts.forEach((p) => {
      expect(d.targets[p.id]).toBe(undefined);
      expect(f0.CORE.some((c) => c.id === p.id)).toBe(false);
    });
    d.entries[today(f0)] = { moodM: 0, moodN: 0, moodE: 0 };
    const dom = boot(JSON.stringify(d));
    byText(dom, "button.tb", "週").click();
    expect(q(dom, "#view").textContent).not.toContain("今の気分");
    byText(dom, "button.tb", "設定").click();
    expect(q(dom, '[data-tgt="mood"]')).toBe(null);
    expect(q(dom, '[data-th="mood"]')).toBe(null);
  });

  it("表示トグルを切ると記録タブから3枠とも消える", () => {
    const dom = boot();
    expect(q(dom, '[data-f="moodM"]')).not.toBe(null);
    byText(dom, "button.tb", "設定").click();
    q(dom, '[data-tog="mood"]').click();
    byText(dom, "button.tb", "記録").click();
    dom.window.__flourish.MOOD.parts.forEach((p) => expect(q(dom, `[data-f="${p.id}"]`)).toBe(null));
  });

  it("CSVに3枠ぶんの列がラベルで入り、カスタム列より前にある", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    d.custom = [{ id: "c_a", label: "読書", target: 5 }];
    d.entries["2026-08-08"] = { moodM: 0, moodE: 2, c_a: true };
    const [head, row] = f.buildCSV(d).split("\n");
    const cols = head.split(",");
    expect(cols.indexOf("朝の気分")).toBeGreaterThan(-1);
    expect(cols.indexOf("晩の気分")).toBeLessThan(cols.indexOf("読書"));
    expect(row.split(",")[cols.indexOf("朝の気分")]).toBe("高");
    expect(row.split(",")[cols.indexOf("晩の気分")]).toBe("低");
    expect(row.split(",")[cols.indexOf("昼の気分")]).toBe("");
  });

  it("週報データに3枠ぶんの分布と凡例・注記が入る", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    const ws = f.weekStart(new Date("2026-08-05T00:00"));
    const day = (n) => f.fmt(new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + n));
    d.entries[day(0)] = { moodM: 0, moodE: 2 };
    const s = f.weekStats(d, ws, day(6));
    expect(s.mood.length).toBe(f.MOOD.parts.length);
    s.mood.forEach((slot) => expect(slot.length).toBe(f.MOOD_OPTS.length));
    expect(s.mood[0][0]).toBe(1);
    expect(s.mood[2][2]).toBe(1);
    const t = f.buildReviewText(d, day(6));
    expect(t).toContain("mood=[高,中,低]");
    expect(t).toContain("計測のみで達成判定の対象ではありません");
    // この2文が、渡していない日ごとの対応を Claude が推測で埋めるのを止めている唯一の指示
    expect(t).toContain("3枠ぶんの分布");
    expect(t).toContain("日単位の突き合わせ");
  });

  // 前夜・当朝の要因と時間的に最も近いので、相関には朝の値だけを使う
  it("相関ヒントは朝の気分を使い、昼・晩の値では動かない", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    for (let i = 0; i < 28; i++) {
      const dt = new Date("2026-07-01T00:00");
      dt.setDate(dt.getDate() + i);
      // 朝は coffee と完全一致、昼・晩はわざと逆向きに入れる
      d.entries[f0.fmt(dt)] = { coffee: i % 2 === 0, moodM: i % 2 === 0 ? 0 : 2, moodN: i % 2 === 0 ? 2 : 0, moodE: i % 2 === 0 ? 2 : 0 };
    }
    const dom = boot(JSON.stringify(d));
    byText(dom, "button.tb", "週報").click();
    const row = qa(dom, "#view .row").find((el) => el.textContent.includes("朝コーヒーを飲んだ × 朝の気分「高」"));
    expect(row).not.toBe(undefined);
    expect(row.textContent).toContain("φ=1.00");
  });

  // |φ| だけで並べると、記録し始めの行がたまたま大きく振れただけで上位を占める
  it("確かさは記録日数が少ないほど 0 に寄る", () => {
    const f = boot().window.__flourish;
    expect(f.strength(0.43, 14)).toBe(0);
    expect(f.strength(0.4, 100)).toBeGreaterThan(0);
    // 完全一致なら日数が少なくても強い。日数だけで殺さないこと
    expect(f.strength(1, 14)).toBeGreaterThan(0.9);
    expect(f.strength(0.9, 3)).toBe(0);
    // 丸め誤差で |φ| が1をわずかに超えても NaN を返さない(NaN は並び順だけを黙って壊す)
    expect(Number.isNaN(f.strength(1.0000000000000002, 50))).toBe(false);
    expect(f.strength(1.0000000000000002, 50)).toBeGreaterThan(0);
  });

  it("相関ヒントは |φ| ではなく記録日数を踏まえた確かさの順に並ぶ", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    const day = (i) => { const t = new Date("2026-04-01T00:00"); t.setDate(t.getDate() + i); return f0.fmt(t); };
    // アシュワガンダ × 眠れた感「良」: 35/15/15/35 の2x2 で n=100, φ=0.40
    for (let i = 0; i < 100; i++) {
      const ash = i < 50;
      // 35/15/15/35 にする。i>=65 だと 35/15/35/15 になり φ=0.00 で strength が同点になる
      const good = ash ? i < 35 : i >= 85;
      d.entries[day(i)] = { ashwagandha: ash, sleepFeel: good ? 0 : 1 };
    }
    // 朝コーヒー × 朝の気分「高」: 5/2/2/5 の2x2 で n=14, φ=0.43(|φ| はこちらが上)
    for (let i = 0; i < 14; i++) {
      d.entries[day(i)].coffee = i < 7;
      d.entries[day(i)].moodM = i < 5 || (i >= 7 && i < 9) ? 0 : 2;
    }
    const dom = boot(JSON.stringify(d));
    byText(dom, "button.tb", "週報").click();
    const rows = qa(dom, "#view .row").map((el) => el.textContent);
    const ash = rows.findIndex((t) => t.includes("アシュワガンダを飲んだ × 眠れた感"));
    const cof = rows.findIndex((t) => t.includes("朝コーヒーを飲んだ × 朝の気分"));
    expect(rows[cof]).toContain("n=14");
    expect(rows[ash]).toContain("n=100");
    // フィクスチャが意図した φ を作れていないと、両者の strength が 0 で同点になり
    // 並びが第2キー(記録日数)だけで決まる。値そのものを固定して、検査対象を守る
    expect(rows[ash]).toContain("φ=0.40");
    expect(rows[cof]).toContain("φ=0.43");
    expect(Math.abs(+rows[cof].match(/φ=(-?[0-9.]+)/)[1])).toBeGreaterThan(Math.abs(+rows[ash].match(/φ=(-?[0-9.]+)/)[1]));
    expect(ash).toBeLessThan(cof);
  });

  // 上のテストは確かさ順と記録日数順が同じ並びになる形なので、単なる日数順への劣化を検出できない。
  // 日数は少ないが確かさは高い対を置いて、両者が食い違う場合を縛る
  it("記録日数が少なくても確かさが高ければ上に来る", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    const day = (i) => { const t = new Date("2026-04-01T00:00"); t.setDate(t.getDate() + i); return f0.fmt(t); };
    // アシュワガンダ × 眠れた感「良」: 28/22/22/28 の2x2 で n=100, φ=0.12(確かさは 0 に潰れる)
    for (let i = 0; i < 100; i++) {
      const ash = i < 50;
      d.entries[day(i)] = { ashwagandha: ash, sleepFeel: (ash ? i < 28 : i >= 78) ? 0 : 1 };
    }
    // 朝コーヒー × 朝の気分「高」: n=14 だが完全一致(φ=1.00)
    for (let i = 0; i < 14; i++) {
      d.entries[day(i)].coffee = i < 7;
      d.entries[day(i)].moodM = i < 7 ? 0 : 2;
    }
    const dom = boot(JSON.stringify(d));
    byText(dom, "button.tb", "週報").click();
    const rows = qa(dom, "#view .row").map((el) => el.textContent);
    const ash = rows.findIndex((t) => t.includes("アシュワガンダを飲んだ × 眠れた感"));
    const cof = rows.findIndex((t) => t.includes("朝コーヒーを飲んだ × 朝の気分"));
    expect(rows[cof]).toContain("φ=1.00");
    expect(rows[cof]).toContain("n=14");
    expect(rows[ash]).toContain("n=100");
    expect(cof).toBeLessThan(ash);
  });

  // 分母が「晩にもアプリを開いた日」に自己選択される。データからは取り除けないので条件を出す
  it("朝×晩の行は分母が限られることをラベルに出す", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    for (let i = 0; i < 28; i++) {
      const t = new Date("2026-04-01T00:00");
      t.setDate(t.getDate() + i);
      d.entries[f0.fmt(t)] = { moodM: i % 2 === 0 ? 0 : 2, moodE: i % 2 === 0 ? 0 : 2 };
    }
    const dom = boot(JSON.stringify(d));
    byText(dom, "button.tb", "週報").click();
    const row = qa(dom, "#view .row").find((el) => el.textContent.includes("朝の気分「高」× 晩の気分「高」"));
    expect(row).not.toBe(undefined);
    expect(row.textContent).toContain("晩も記録した日だけ");
  });

  it("気分を持たない旧データも既定値で埋まる", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({ version: 7, targets: { gym: 4 }, entries: { "2026-08-01": { gym: true } } });
    expect(m.enabled.mood).toBe(true);
    expect(m.targets.mood).toBe(undefined);
    expect(m.entries["2026-08-01"]).toEqual({ gym: true });
  });
});

// 手で足す検査は必ず忘れる。CORE を起点にすれば、次に項目を足したときも自動で検査対象に入る
describe("PWA v4.0: 項目の結線ガード(CORE 起点)", () => {
  it("CORE の全項目が記録タブ・CSV列・設定タブに結線されている", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    const head = f.buildCSV(f.defaultData()).split("\n")[0].split(",");
    const onLog = qa(dom, "#view [data-f]").map((el) => el.dataset.f);
    byText(dom, "button.tb", "設定").click();
    const tgts = qa(dom, "[data-tgt]").map((el) => el.dataset.tgt);
    const togs = qa(dom, "[data-tog]").map((el) => el.dataset.tog);
    f.CORE.forEach((c) => {
      expect(tgts).toContain(c.id);
      expect(togs).toContain(c.id);
      // data-tgt は targets に値が無くても描画され、週タブは「1/undefined」と出るだけで落ちない
      expect(typeof f.defaultData().targets[c.id]).toBe("number");
      // 1日3回ぶんの項目は parts が入力欄とCSV列を持ち、畳んだ id 自体は持たない
      (c.parts || [{ id: c.id, label: c.label }]).forEach((p) => {
        expect(onLog).toContain(p.id);
        // 列名は単位を添えることがある(「就寝時刻(分)」)ので部分一致で見る
        expect(head.some((c) => c.includes(p.label))).toBe(true);
      });
    });
  });

  // buildCSV のヘッダーと行のセルは別々の書き写しなので、片方だけ足すと
  // 以降の列が全部1つずれる。csvCell は引用処理しかせず、ズレは例外も警告も出さない
  it("CSVのヘッダーと行のフィールド数が一致する", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    // 埋める項目は enabled から導く。CORE や MOOD を手で並べると、
    // 次に計測のみの項目を足したときに「CSV列だけ忘れた」が素通りする
    const NUM = { bedtimeMin: 1440, wakeMin: 420, sleepFeel: 1, youtubeMin: 60, steps: 1, moodM: 0, moodN: 0, moodE: 0 };
    const groups = f.PERDAY.concat([f.MOOD]);
    const e = { weightVal: "68.5" };
    Object.keys(d.enabled).forEach((id) => {
      const g = groups.find((x) => x.id === id);
      (g ? g.parts : [{ id }]).forEach((p) => { e[p.id] = NUM[p.id] != null ? NUM[p.id] : true; });
    });
    d.entries["2026-08-08"] = e;
    const [head, row] = f.buildCSV(d).split("\n");
    expect(row.split(",").length).toBe(head.split(",").length);
    // 全項目を埋めたのだから、空セルが残っていたら行側に落ちた列がある
    expect(row.split(",").filter((c) => c === "").length).toBe(0);
  });

  // CORE は「達成判定を持つ項目」でしかない。計測のみの項目(起床時刻・眠れた感・気分)は
  // CORE に入らないので、記録できる項目の一覧は enabled のキーを唯一の出所にする
  it("記録できる項目はすべて表示トグルと記録タブの入力欄を持つ", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    const onLog = qa(dom, "#view [data-f]").map((el) => el.dataset.f);
    byText(dom, "button.tb", "設定").click();
    const togs = qa(dom, "[data-tog]").map((el) => el.dataset.tog);
    const grouped = f.PERDAY.concat([f.MOOD]);
    Object.keys(f.defaultData().enabled).forEach((id) => {
      expect(togs).toContain(id);
      const g = grouped.find((x) => x.id === id);
      (g ? g.parts : [{ id }]).forEach((p) => expect(onLog).toContain(p.id));
    });
  });

  // 列が丸ごと無いとヘッダーも行も欠けるので、幅の一致では検出できない。
  // 項目を1つだけ埋めた行を作り、CSVのどこかに値が出ることで「列がある」ことを確かめる
  it("記録できる項目はすべてCSVに1列以上を持つ", () => {
    const f = boot().window.__flourish;
    const NUM = { bedtimeMin: 1440, wakeMin: 420, sleepFeel: 1, youtubeMin: 60, steps: 1, moodM: 0, moodN: 0, moodE: 0 };
    const groups = f.PERDAY.concat([f.MOOD]);
    Object.keys(f.defaultData().enabled).forEach((id) => {
      const d = f.defaultData();
      const one = {};
      const g = groups.find((x) => x.id === id);
      (g ? g.parts : [{ id }]).forEach((p) => { one[p.id] = NUM[p.id] != null ? NUM[p.id] : true; });
      d.entries["2026-08-08"] = one;
      const cells = f.buildCSV(d).split("\n")[1].split(",").slice(1);
      expect(cells.filter((c) => c !== "").length).toBeGreaterThan(0);
    });
  });

  // 幅が合っていても、ヘッダーと行の対応がずれれば値は別の列の下に出る。
  // 1項目ずつ埋めて、それぞれが自分だけの列に出ることを確かめる
  it("記録できる項目のCSV列が互いに重ならない", () => {
    const f = boot().window.__flourish;
    const NUM = { bedtimeMin: 1440, wakeMin: 420, sleepFeel: 1, youtubeMin: 60, steps: 1, moodM: 0, moodN: 0, moodE: 0 };
    const groups = f.PERDAY.concat([f.MOOD]);
    const ids = [];
    Object.keys(f.defaultData().enabled).forEach((id) => {
      const g = groups.find((x) => x.id === id);
      (g ? g.parts : [{ id }]).forEach((p) => ids.push(p.id));
    });
    // ラベルが分かる項目は、値が自分のラベルの列に出ることまで見る(列が入れ替わっても幅は合うため)
    const labels = new Map();
    f.CORE.forEach((c) => (c.parts || [c]).forEach((p) => labels.set(p.id, p.label)));
    f.MOOD.parts.forEach((p) => labels.set(p.id, p.label));
    const seen = new Map();
    ids.forEach((id) => {
      const d = f.defaultData();
      d.entries["2026-08-08"] = { [id]: NUM[id] != null ? NUM[id] : true };
      const [head, row] = f.buildCSV(d).split("\n");
      const at = row.split(",").findIndex((c, i) => i > 0 && c !== "");
      expect(at).toBeGreaterThan(0);
      expect(seen.get(at)).toBe(undefined); // 別の項目と同じ列に出たら対応が壊れている
      if (labels.has(id)) expect(head.split(",")[at]).toContain(labels.get(id));
      seen.set(at, id);
    });
    expect(seen.size).toBe(ids.length);
  });

  // 版表記は5箇所にある。1つでも食い違うと実機での反映確認ができなくなる
  it("版表記が index.html・sw.js・package.json で一致する", () => {
    const html = readFileSync("index.html", "utf8");
    const ver = html.match(/DAWN&nbsp;LOG&nbsp;·&nbsp;v([0-9.]+)/)[1];
    expect(html.match(/環境設計の仕事です。 v([0-9.]+)/)[1]).toBe(ver);
    expect(readFileSync("sw.js", "utf8")).toContain('"aubade-v' + ver + '"');
    expect(JSON.parse(readFileSync("package.json", "utf8")).version).toBe(ver + ".0");
    expect(JSON.parse(readFileSync("package-lock.json", "utf8")).version).toBe(ver + ".0");
  });

  // README の表は手書きの写しなので、項目を足したときに片方だけ古くなる
  it("README の「記録するもの」に CORE の全ラベルが出ている", () => {
    const f = boot().window.__flourish;
    const readme = readFileSync("README.md", "utf8");
    f.CORE.forEach((c) => expect(readme).toContain(c.label));
  });

  // 色クラスの数が選択肢の数に足りないと class="sb on undefined" になり、
  // 選んだ段のラベルだけが白く消える。aria-pressed は正常に付くので他の検査は素通りする
  it("段階式の項目はどの段を選んでも色クラスが付く", () => {
    const counts = {};
    qa(boot(), "#view .seg [data-f]").forEach((el) => {
      if (/^\d+$/.test(el.dataset.v)) counts[el.dataset.f] = (counts[el.dataset.f] || 0) + 1;
    });
    expect(Object.keys(counts).length).toBeGreaterThan(0);
    Object.keys(counts).forEach((fld) => {
      for (let i = 0; i < counts[fld]; i++) {
        const dom = boot();
        q(dom, `[data-f="${fld}"][data-v="${i}"]`).click();
        const on = q(dom, `[data-f="${fld}"][data-v="${i}"]`);
        expect(on.getAttribute("aria-pressed")).toBe("true");
        expect(on.className).not.toContain("undefined");
        expect(on.className).toMatch(/\bon-[a-z]+\b/);
      }
    });
  });

  // 分母だけ落ちても例外もレイアウト崩れも起きないので、数を突き合わせる
  it("記録タブの「◯/◯ 入力」の分母が入力欄の数と一致する", () => {
    const dom = boot();
    const ids = new Set(qa(dom, "#view [data-f]").map((el) => el.dataset.f));
    const n = +q(dom, ".dateS").textContent.split("/")[1].replace(/[^0-9]/g, "");
    expect(n).toBe(ids.size);
  });
});

describe("PWA v4.0: 月間ビュー", () => {
  const AUG = "2026-08-16T09:00"; // 2026-08-01 は土曜。月曜起点なので先頭に空きが5つ
  const seed = (entries) => {
    const d = boot().window.__flourish.defaultData();
    Object.assign(d.entries, entries);
    return JSON.stringify(d);
  };
  const open = (s) => {
    const dom = boot(s, withClock(AUG));
    byText(dom, "button.tb", "推移").click();
    return dom;
  };
  const card = (dom) => qa(dom, ".card").find((el) => el.textContent.includes("月間"));
  const pick = (dom, id) => {
    const sel = q(dom, "[data-mon]");
    sel.value = id;
    sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };

  it("推移タブに当月のカレンダーが月曜起点で出る", () => {
    const dom = open();
    expect(card(dom)).not.toBe(undefined);
    expect(card(dom).textContent).toContain("2026年8月");
    expect(qa(dom, ".mh").map((el) => el.textContent)).toEqual(["月", "火", "水", "木", "金", "土", "日"]);
    expect(qa(dom, ".mcell").length).toBe(36); // 空き5 + 31日
    expect(qa(dom, ".mcell .dot").length).toBe(31);
  });

  // 制約2: 欠損は未入力であって未達ではない。週タブと同じ語彙で区別する
  it("未入力・未達・達成・未来を区別する", () => {
    const dom = open(seed({ "2026-08-14": { gym: true }, "2026-08-15": { gym: false } }));
    pick(dom, "gym");
    const dots = qa(dom, ".mcell .dot").map((el) => el.className);
    expect(dots[13]).toContain("ok");    // 8/14 達成
    expect(dots[14]).toContain("ng");    // 8/15 未達
    expect(dots[12]).toContain("miss");  // 8/13 未入力
    expect(dots[16]).toContain("fut");   // 8/17 未来
  });

  // 月ごとの目標は持たない。達成数と記録数を事実として並べるだけ
  it("達成数と記録数を出し、未入力は記録数に数えない", () => {
    const dom = open(seed({ "2026-08-14": { gym: true }, "2026-08-15": { gym: false } }));
    pick(dom, "gym");
    expect(card(dom).textContent).toContain("達成 1 / 記録 2");
  });

  it("今月より先へは進めず、記録より前の月へも戻れない", () => {
    const dom = open(seed({ "2026-08-10": { gym: true } }));
    expect(q(dom, '[data-mo="1"]').disabled).toBe(true);
    expect(q(dom, '[data-mo="-1"]').disabled).toBe(true);
  });

  it("前の月に記録があれば戻れる", () => {
    const dom = open(seed({ "2026-07-20": { gym: true }, "2026-08-10": { gym: true } }));
    q(dom, '[data-mo="-1"]').click();
    expect(card(dom).textContent).toContain("2026年7月");
    expect(qa(dom, ".mcell .dot").length).toBe(31);
    expect(q(dom, '[data-mo="1"]').disabled).toBe(false);
  });

  // 出所は週タブと同じ allItems + enabled。計測のみの項目は達成判定を持たないので出ない
  it("達成判定を持たない項目はセレクタに出ず、非表示にした項目も消える", () => {
    const dom = open();
    const opts = () => [...q(dom, "[data-mon]").options].map((o) => o.value);
    expect(opts()).toContain("gym");
    ["mood", "wakeMin", "sleepFeel"].forEach((id) => expect(opts()).not.toContain(id));
    byText(dom, "button.tb", "設定").click();
    q(dom, '[data-tog="gym"]').click();
    byText(dom, "button.tb", "推移").click();
    expect(opts()).not.toContain("gym");
  });
});

describe("PWA v4.0: v9 スキーマ(就寝・起床・YouTube の分値化)", () => {
  // 変換表はバケットの上端。開区間だけ旧チャートの慣行値(25.2h / 8.2h / 2.5h)に対応する
  it("旧インデックスを分へ読み替え、旧キーを残さない", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({
      version: 8,
      th: { bedtime: 1, youtube: 2 },
      targets: { bedtime: 4, youtube: 3 },
      enabled: { bedtime: false, wake: true, youtube: true },
      entries: { "2026-08-01": { bedtime: 0, wake: 4, youtube: 3, gym: true } },
    });
    expect(m.version).toBe(9);
    expect(m.entries["2026-08-01"]).toEqual({ bedtimeMin: 1380, wakeMin: 492, youtubeMin: 150, gym: true });
    expect(m.th.bedtimeMin).toBe(1410);
    expect(m.th.youtubeMin).toBe(120);
    expect(m.th.bedtime).toBe(undefined);
    expect(m.targets.bedtimeMin).toBe(4); // 週の回数なので値は変換しない
    expect(m.targets.bedtime).toBe(undefined);
    expect(m.enabled.bedtimeMin).toBe(false); // 非表示の設定は持ち越す
    expect(m.enabled.wakeMin).toBe(true);
    expect(m.enabled.wake).toBe(undefined);
  });

  // 読み替えの目的は「過去の達成/未達が1つも変わらない」こと。旧仕様の式を右辺に置いて突き合わせる
  it("読み替えても過去の達成判定が1つも変わらない", () => {
    const f = boot().window.__flourish;
    [0, 1, 2, 3].forEach((oldTh) => {
      const old = { version: 8, th: { bedtime: oldTh, youtube: Math.min(oldTh, 2) }, entries: {} };
      [0, 1, 2, 3, 4].forEach((v) => { old.entries["2026-08-0" + (v + 1)] = { bedtime: v, youtube: Math.min(v, 3) }; });
      const m = f.migrate(old);
      [0, 1, 2, 3, 4].forEach((v) => {
        const e = m.entries["2026-08-0" + (v + 1)];
        expect(f.achieved(m, e, "bedtimeMin")).toBe(v <= oldTh);
        expect(f.achieved(m, e, "youtubeMin")).toBe(Math.min(v, 3) <= Math.min(oldTh, 2));
      });
    });
  });

  it("二度通しても再変換せず、入力オブジェクトも書き換えない", () => {
    const f = boot().window.__flourish;
    const src = { version: 8, entries: { "2026-08-01": { bedtime: 2 } } };
    const once = f.migrate(src);
    expect(src.entries["2026-08-01"]).toEqual({ bedtime: 2 }); // 入力は無傷
    expect(f.migrate(once).entries["2026-08-01"]).toEqual({ bedtimeMin: 1440 });
  });

  // 手で繋いだJSONは旧キーと新キーが両方あることがある。新しい方を正とする
  it("旧キーと新キーが両方あれば新キーを残す", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({ version: 8, entries: { "2026-08-01": { bedtime: 0, bedtimeMin: 1425 } } });
    expect(m.entries["2026-08-01"]).toEqual({ bedtimeMin: 1425 });
  });

  it("汚れた旧値は変換も削除もせず素通しする", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({ version: 8, entries: { a: { bedtime: "2" }, b: { wake: 9 }, c: null } });
    expect(m.entries.a).toEqual({ bedtime: "2" });
    expect(m.entries.b).toEqual({ wake: 9 });
    expect(m.entries.c).toBe(null);
  });

  // 実値保存なので、選択肢を増やしても過去の記録の意味は動かない = migrate が要らない
  it("記録タブの select は空欄が既定で、選択肢はすべて分の数値", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    [["bedtimeMin", f.BEDTIME_MIN], ["wakeMin", f.WAKE_MIN], ["youtubeMin", f.YT_MIN]].forEach(([id, opts]) => {
      const s = q(dom, `select[data-f="${id}"]`);
      expect(s).not.toBe(null);
      expect(s.value).toBe(""); // 既定値があると未入力と区別できず、推奨値にも見える
      const vals = [...s.options].map((o) => o.value);
      expect(vals[0]).toBe("");
      expect(vals.slice(1)).toEqual(opts.map(String));
    });
  });

  // 移行で入った 1512(25:12) / 492(8:12) は15分格子に乗らない。option が無いと
  // 値があるのに無選択で描かれ、別の値を選んだ瞬間に黙って消える
  it("選択肢に無い保存値にも option を足して編集できる", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    d.entries[f0.fmt(new Date())] = { bedtimeMin: 1512 };
    const dom = boot(JSON.stringify(d));
    const s = q(dom, 'select[data-f="bedtimeMin"]');
    expect(s.value).toBe("1512");
    expect([...s.options].map((o) => o.text)).toContain("25:12");
  });

  it("週報は分の実値を昇順で渡し、日付との対応は渡さない", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    const ws = f.weekStart(new Date("2026-08-05T00:00"));
    const day = (n) => f.fmt(new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + n));
    d.entries[day(0)] = { bedtimeMin: 1500 };
    d.entries[day(1)] = { bedtimeMin: 1380, youtubeMin: 0 };
    const s = f.weekStats(d, ws, day(6));
    expect(s.bedtimeMin).toEqual([1380, 1500]);
    expect(s.youtubeMin).toEqual([0]); // 0分は正当な記録なので落とさない
    expect(s.wakeMin).toEqual([]);
  });

  // 入力が15分刻みでも達成ラインは粗いまま。締め上げの無摩擦化を避けるための意図的な決定
  it("達成ラインの選択肢は v8 までと同じ境界のまま", () => {
    const dom = boot();
    byText(dom, "button.tb", "設定").click();
    expect([...q(dom, '[data-th="bedtimeMin"]').options].map((o) => o.value)).toEqual(["1380", "1410", "1440", "1470"]);
    expect([...q(dom, '[data-th="youtubeMin"]').options].map((o) => o.value)).toEqual(["30", "60", "120"]);
  });
});
