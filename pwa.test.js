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
// 移行テストは「版が上がる」ことを見たいだけで、その数値そのものが要件ではない。
// 書き写すと schema を上げるたびに十数箇所を手で直すことになる
const CURRENT_SCHEMA = boot().window.__flourish.defaultData().version;
const byText = (dom, sel, text) => qa(dom, sel).find((el) => el.textContent.trim() === text);
const tick = () => new Promise((r) => setTimeout(r, 0));
const stubClipboard = (dom, impl) => { dom.window.navigator.clipboard = { writeText: impl }; };
// 分の実値は select。change を発火させないと保存されない
// 値の表を手で持つと、数値項目を足すたびに3箇所直すことになり必ず忘れる。
// 記録タブの描画から型を導く: select と段階ボタンは数値、✓/✗ の2択は真偽値
const numericSamples = () => {
  const dom = boot();
  const out = {};
  qa(dom, "#view [data-f]").forEach((el) => {
    const f = el.dataset.f;
    if (f in out) return;
    if (el.tagName === "SELECT") {
      const v = [...el.options].map((o) => o.value).find((x) => x !== "");
      out[f] = Number(v);
    } else if (el.dataset.v !== "t" && el.dataset.v !== "f") {
      out[f] = Number(el.dataset.v); // seg の段階
    }
  });
  return out;
};
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

describe("PWA v4.18: 起動と基本描画", () => {
  // 版はここに書き写さない。書き写すとリリースのたびに手で直す6箇所目になる
  it("記録タブが描画され、版表記が出ている", () => {
    const dom = boot();
    expect(q(dom, "#view").textContent).toContain("就寝時刻");
    const ver = JSON.parse(readFileSync("package.json", "utf8")).version.replace(/\.0$/, "");
    expect(q(dom, ".eyebrow").textContent).toContain("v" + ver);
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

describe("PWA v4.18: 保存と復元", () => {
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

describe("PWA v4.18: ロジック(移植の同一性)", () => {
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
    expect(row).toBe("2026-08-08,1512,390,普通,30,0,1,1,1,68.5,0,1,,,,,,,,,,,,,,,,,,,,,,,,");
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

describe("PWA v4.18: 週タブ・週報タブ", () => {
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

describe("PWA v4.18: 設定タブ", () => {
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

describe("PWA v4.18: 壊れた保存データを黙って消さない", () => {
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

describe("PWA v4.18: コピー結果を偽らない", () => {
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

describe("PWA v4.18: CSVの列ずれ", () => {
  it("カンマを含むカスタム項目名でも列数が一致する", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    d.custom = [{ id: "c_a", label: "読書, 英語", target: 5 }];
    d.entries["2026-08-08"] = { gym: true, c_a: true };
    const [head, row] = f.buildCSV(d).split("\n");
    expect(head).toContain('"読書, 英語"');
    expect(head.split('"').length).toBe(3); // 引用符は1フィールド分の2つだけ
    expect(row).toBe("2026-08-08,,,,,,,,,,1,,,,,,,,,,,,,,,,,,,,,,,,,,1");
  });

  it("引用符を含むラベルは二重引用符でエスケープする", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    d.custom = [{ id: "c_b", label: '「"読書"」', target: 5 }];
    const head = f.buildCSV(d).split("\n")[0];
    expect(head.endsWith('"「""読書""」"')).toBe(true);
  });
});

describe("PWA v4.18: 配信ポリシー", () => {
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

describe("PWA v4.18: Service Worker", () => {
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

describe("PWA v4.18: 取り込んだJSONを信用しない", () => {
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
    expect(m.version).toBe(CURRENT_SCHEMA);
    expect(m.lastBackup).toBe(null);
    expect(m.entries["2026-08-01"].gym).toBe(true);
  });
});

describe("PWA v4.18: 日付またぎ", () => {
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

describe("PWA v4.18: バックアップの記録", () => {
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

describe("PWA v4.18: 起床時刻(計測のみ)", () => {
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
    expect(row).toBe("2026-08-08,1320,450,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,");
    const t = f.buildReviewText(d, "2026-08-08");
    expect(t).toContain("wakeMin");
    expect(t).toContain("分の実値");
    expect(t).toContain("計測のみ");
    expect(t).toContain('"wakeMin":');
  });

  it("wake を持たない旧データも読め、version が上がる", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({ version: 3, entries: { "2026-08-01": { bedtime: 1 } } });
    expect(m.version).toBe(CURRENT_SCHEMA);
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

describe("PWA v4.18: 相関ヒント", () => {
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

describe("PWA v4.18: 推移タブの期間切替", () => {
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

describe("PWA v4.18: 睡眠の帯グラフ", () => {
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

describe("PWA v4.18: 体重の自由入力", () => {
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

describe("PWA v4.18: 勉強を分の実値へ移す(study → studyMin)", () => {
  it("select で選ぶと studyMin として分で保存される", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    const s = q(dom, 'select[data-f="studyMin"]');
    s.value = "45";
    s.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(JSON.parse(dom.window.localStorage.getItem(KEY)).entries[f.fmt(new Date())].studyMin).toBe(45);
  });

  // true は「15分以上」という下限で実測値ではない。15 を書き込むと格子に乗って
  // 実測と見分けが付かなくなるため、entries は変換しない
  it("旧データの study を studyMin へ書き換えない", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({ version: 13, entries: { "2026-08-01": { study: true } } });
    expect(m.entries["2026-08-01"].study).toBe(true);
    expect(m.entries["2026-08-01"].studyMin).toBe(undefined);
  });

  // 移行のまたぎで達成数が減ると、過去の週タブが黙って書き換わったように見える
  it("旧データ(真偽)と新データ(分)が混ざった週でも達成数が正しい", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    d.entries["2026-08-03"] = { study: true };    // 旧・達成
    d.entries["2026-08-04"] = { study: false };   // 旧・未達
    d.entries["2026-08-05"] = { studyMin: 45 };   // 新・達成
    d.entries["2026-08-06"] = { studyMin: 0 };    // 新・未達
    const s = f0.weekStats(d, "2026-08-03", "2026-08-09");
    const row = s.items.find((it) => it.label === "勉強");
    expect(row.ok).toBe(2);
    expect(row.entered).toBe(4);
  });

  // 達成の判定を2箇所で書くと必ず片方が腐る。相関ヒントも同じ関数を通す
  it("達成判定は studyDone に一元化されている", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    expect(f.studyDone(d, { study: true })).toBe(true);
    expect(f.studyDone(d, { studyMin: 15 })).toBe(true);
    expect(f.studyDone(d, { studyMin: 14 })).toBe(false);
    expect(f.studyDone(d, {})).toBe(null);
    // 両方ある日は新しい方が勝つ(手で繋いだJSON対策。v9 の旧キー/新キーと同じ向き)
    expect(f.studyDone(d, { study: true, studyMin: 0 })).toBe(false);
  });

  it("達成ラインを設定タブから変えられる", () => {
    const dom = boot();
    expect(q(dom, '[data-th="studyMin"]')).toBe(null); // 記録タブには無い
    byText(dom, "button.tb", "設定").click();
    const sel = q(dom, '[data-th="studyMin"]');
    sel.value = "60";
    sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    const f = dom.window.__flourish;
    expect(f.getS().th.studyMin).toBe(60);
    expect(f.studyDone(f.getS(), { studyMin: 45 })).toBe(false);
  });

  it("CSVは旧列を残したまま分の列を足す", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    d.entries["2026-08-08"] = { study: true };
    d.entries["2026-08-09"] = { studyMin: 90 };
    const lines = f.buildCSV(d).split("\n");
    expect(lines[0]).toContain("勉強(旧・真偽)");
    expect(lines[0]).toContain("勉強(分)");
    const cols = lines[0].split(",");
    const iOld = cols.indexOf("勉強(旧・真偽)");
    expect(lines[1].split(",")[iOld]).toBe("1");
    expect(lines[2].split(",")[iOld + 1]).toBe("90");
  });

  it("週報データに分の実値と移行の注意が入る", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    d.entries["2026-08-03"] = { studyMin: 30 };
    expect(f.weekStats(d, "2026-08-03", "2026-08-09").studyMin).toEqual([30]);
    const t = f.buildReviewText(d, "2026-08-09");
    expect(t).toContain("studyMin");
    expect(t).toContain("v4.7 より前");
  });
});

describe("PWA v4.18: 勉強タイマー", () => {
  const TKEY = "flourish-log-v2-timer";
  // タイマーは独立タブ。記録タブからは触れない
  const openTimer = (dom) => byText(dom, "button.tb", "タイマー").click();
  const startTimer = (dom) => { openTimer(dom); q(dom, '[data-action="timerStart"]').click(); };
  const stopTimer = (dom) => q(dom, '[data-action="timerStop"]').click();
  // タイマーの開始も、1分未満・上限超えの停止も本体データを書かないので KEY 自体が無いことがある
  const entriesOf = (dom) => {
    const raw = dom.window.localStorage.getItem(KEY);
    return raw ? JSON.parse(raw).entries : {};
  };

  // 朝の入力と勉強中の計測は使う時間帯も動線も違う。同じ画面に混ぜない(設計制約3)
  it("記録タブにはタイマーが一切出ない", () => {
    const dom = boot();
    expect(q(dom, '[data-action="timerStart"]')).toBe(null);
    expect(q(dom, '[data-action="timerStop"]')).toBe(null);
    expect(byText(dom, "button.tb", "タイマー")).not.toBe(null);
  });

  it("走行中でも記録タブには出ない", () => {
    const dom = boot(null, withClock("2026-08-17T20:00"));
    startTimer(dom);
    byText(dom, "button.tb", "記録").click();
    expect(q(dom, '[data-action="timerStop"]')).toBe(null);
    expect(q(dom, "#view").textContent).not.toContain("停止して記録");
  });

  it("タイマータブに今日ぶんの累計と記録先の日付が出る", () => {
    const dom = boot(null, withClock("2026-08-17T20:00"));
    startTimer(dom);
    dom.window.__advanceTo("2026-08-17T20:30");
    stopTimer(dom);
    const v = q(dom, "#view").textContent;
    expect(v).toContain("8/18");   // 記録先(翌日ぶん)
    expect(v).toContain("30分");
  });

  // 経過を数えるのではなく開始時刻を持つ。iOS の PWA はバックグラウンドで動けないので、
  // setInterval で数えると画面を消した瞬間に止まり、実際より短い時間が記録される
  it("開始時刻だけを別キーに保存する", () => {
    const dom = boot(null, withClock("2026-08-17T20:00"));
    startTimer(dom);
    const t = JSON.parse(dom.window.localStorage.getItem(TKEY));
    expect(t.startedAt).toBe(Date.parse("2026-08-17T20:00"));
    expect(t.day).toBe("2026-08-17");
    // 本体データには混ぜない。開始だけでは本体キーを作りさえしない
    // (バックアップJSON・週報・台帳のどれにも走行中の状態を出さないため)
    expect(dom.window.localStorage.getItem(KEY)).toBe(null);
  });

  // 画面を消している間も時間は進む。復帰時に「今 − 開始」で出せることを縛る
  it("アプリを閉じて開き直しても経過が続く", () => {
    const dom = boot(null, withClock("2026-08-17T20:00"));
    startTimer(dom);
    const saved = dom.window.localStorage.getItem(TKEY);
    const back = boot(null, (w) => {
      withClock("2026-08-17T20:45")(w);
      w.localStorage.setItem(TKEY, saved);
    });
    openTimer(back);
    expect(q(back, '[data-action="timerStop"]')).not.toBe(null);
    // 走行中はストップウォッチ表記(分:秒)。記録値の fmtDur とは別
    expect(q(back, "#timerElapsed").textContent).toBe("45:00");
  });

  // studyMin は前日を指すので、今日の勉強は明日ぶんのエントリに入る
  it("停止すると開始した日の翌日ぶんに記録される", () => {
    const dom = boot(null, withClock("2026-08-17T20:00"));
    startTimer(dom);
    dom.window.__advanceTo("2026-08-17T21:30");
    stopTimer(dom);
    expect(entriesOf(dom)["2026-08-18"].studyMin).toBe(90);
    expect(dom.window.localStorage.getItem(TKEY)).toBe(null);
  });

  it("複数回まわすと合算される", () => {
    const dom = boot(null, withClock("2026-08-17T09:00"));
    startTimer(dom);
    dom.window.__advanceTo("2026-08-17T09:30");
    stopTimer(dom);
    startTimer(dom);
    dom.window.__advanceTo("2026-08-17T10:15");
    stopTimer(dom);
    expect(entriesOf(dom)["2026-08-18"].studyMin).toBe(75);
  });

  // 日をまたいで止めても、始めた日の勉強として数える(記録先は開始時点で決まる)
  it("日をまたいで停止しても開始した日ぶんに入る", () => {
    const dom = boot(null, withClock("2026-08-17T23:40"));
    startTimer(dom);
    dom.window.__advanceTo("2026-08-18T00:20");
    stopTimer(dom);
    expect(entriesOf(dom)["2026-08-18"].studyMin).toBe(40);
    expect(entriesOf(dom)["2026-08-19"]).toBe(undefined);
  });

  // 止め忘れは「実際より長い」方向にしか壊れない。黙って足すと週の合計が一度で狂う
  it("止め忘れ(上限超え)は記録せず、理由を画面に出す", () => {
    const dom = boot(null, withClock("2026-08-17T09:00"));
    startTimer(dom);
    dom.window.__advanceTo("2026-08-18T02:00");   // 17時間
    stopTimer(dom);
    expect(entriesOf(dom)["2026-08-18"]).toBe(undefined);
    // 「長すぎる」のような評価語を使わない。事実(閾値超え)と次の手だけを出す
    const note = q(dom, "#saveState").textContent;
    expect(note).toContain("記録していません");
    expect(note).toContain("記録タブ");
    expect(note).not.toContain("長すぎ");
    expect(dom.window.localStorage.getItem(TKEY)).toBe(null); // 止まってはいる
  });

  it("1分未満は記録しない", () => {
    const dom = boot(null, withClock("2026-08-17T09:00"));
    startTimer(dom);
    dom.window.__advanceTo("2026-08-17T09:00:20");
    stopTimer(dom);
    expect(Object.keys(entriesOf(dom)).length).toBe(0);
  });

  // 手動入力とタイマーは同じ studyMin を指す。select で選び直せば上書きできる
  it("手動の select で上書きできる", () => {
    const dom = boot(null, withClock("2026-08-17T20:00"));
    startTimer(dom);
    dom.window.__advanceTo("2026-08-17T20:47");
    stopTimer(dom);
    expect(entriesOf(dom)["2026-08-18"].studyMin).toBe(47);
    // 47 は15分格子の外だが、minSelect が option を足すので選択状態として出る
    byText(dom, "button.tb", "記録").click();
    byText(dom, "button.navbtn", "›").click(); // 明日ぶんへ
    const s = q(dom, 'select[data-f="studyMin"]');
    expect(s.value).toBe("47");
    s.value = "60";
    s.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(entriesOf(dom)["2026-08-18"].studyMin).toBe(60);
  });

  // 数えるのではなく毎回 startedAt から引き直すので、間引かれても復帰後に正しい値へ戻る
  it("経過表示は毎秒 startedAt から引き直される", () => {
    const dom = boot(null, withClock("2026-08-17T20:00"));
    startTimer(dom);
    const f = dom.window.__flourish;
    expect(q(dom, "#timerElapsed").textContent).toBe("0:00");
    dom.window.__advanceTo("2026-08-17T20:00:07");
    f.timerPaint();
    expect(q(dom, "#timerElapsed").textContent).toBe("0:07");
    // バックグラウンドで tick が飛んでも、次の1回で追いつく(欠測にならない)
    dom.window.__advanceTo("2026-08-17T21:23:45");
    f.timerPaint();
    expect(q(dom, "#timerElapsed").textContent).toBe("1:23:45");
  });

  it("1時間未満は分:秒、超えたら時:分:秒", () => {
    const f = boot().window.__flourish;
    expect(f.fmtClock(0)).toBe("0:00");
    expect(f.fmtClock(65)).toBe("1:05");
    expect(f.fmtClock(3600)).toBe("1:00:00");
    expect(f.fmtClock(3725)).toBe("1:02:05");
  });

  // 見えない要素を毎秒書き換えても意味がないうえ、止め忘れると interval が残る
  it("タイマータブを離れると更新を止め、戻ると再開する", () => {
    const dom = boot(null, withClock("2026-08-17T20:00"));
    const f = dom.window.__flourish;
    startTimer(dom);
    expect(f.timerTicking()).toBe(true);
    byText(dom, "button.tb", "記録").click();
    expect(f.timerTicking()).toBe(false);
    openTimer(dom);
    expect(f.timerTicking()).toBe(true);
    stopTimer(dom);
    expect(f.timerTicking()).toBe(false);
  });

  it("壊れたタイマー状態は無視して起動する", () => {
    const dom = boot(null, (w) => { w.localStorage.setItem(TKEY, "{壊れている"); });
    expect(dom.window.__flourish.getTimer()).toBe(null);
    openTimer(dom);
    expect(q(dom, '[data-action="timerStop"]')).toBe(null);
    expect(q(dom, '[data-action="timerStart"]')).not.toBe(null);
  });
});

describe("PWA v4.18: 瞑想(分の実値)", () => {
  const seed = (min) => JSON.stringify({ version: 20, entries: { "2026-08-08": { meditationMin: min } } });

  it("記録タブに瞑想の select が出て、選ぶと分の実値が入る", () => {
    const dom = boot();
    const sel = q(dom, 'select[data-f="meditationMin"]');
    expect(sel).not.toBe(null);
    sel.value = "20";
    sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(JSON.parse(dom.window.localStorage.getItem(KEY)).entries["2026-08-18"].meditationMin).toBe(20);
  });

  // 達成ラインの向きは項目ごとに違う。瞑想は「この値以上で達成」(勉強と同じ、就寝とは逆)
  it("達成判定は th.meditationMin 以上で達成、未入力は null", () => {
    const dom = boot(seed(10));
    const f = dom.window.__flourish;
    const d = f.getS();
    expect(f.achieved(d, d.entries["2026-08-08"], "meditationMin")).toBe(true);
    expect(f.achieved(d, { meditationMin: 5 }, "meditationMin")).toBe(false);
    // 欠損は未入力であって未達ではない(設計制約2)
    expect(f.achieved(d, {}, "meditationMin")).toBe(null);
  });

  // 刻みを細かくしてよいのは物理量だけ。瞑想は5〜30分が実勢なので勉強の15分刻みでは粗すぎる
  it("選択肢は5分刻みで、格子外の保存値も選択状態で描かれる", () => {
    const f = boot().window.__flourish;
    expect(f.MEDITATION_MIN.slice(0, 4)).toEqual([0, 5, 10, 15]);
    const dom = boot(seed(37), withClock("2026-08-08T07:00"));
    expect(q(dom, 'select[data-f="meditationMin"]').value).toBe("37");
  });

  // 【後退ガード】達成判定を持つ項目なので CORE / targets / th のすべてに乗る必要がある。
  // どれか1つ欠けると週タブか目標か達成判定のどれかだけが静かに落ちる
  it("CORE・targets・th・enabled のすべてに乗っている", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    expect(f.CORE.some((c) => c.id === "meditationMin")).toBe(true);
    expect(typeof d.targets.meditationMin).toBe("number");
    expect(typeof d.th.meditationMin).toBe("number");
    expect(d.enabled.meditationMin).toBe(true);
  });

  // 【後退ガード】相関ヒントの defs は手書きで、足し忘れても何も落ちない(静かに欠ける)
  it("相関ヒントに瞑想の対がある", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html).toMatch(/瞑想が達成ライン以上 × 眠れた感/);
    expect(html).toMatch(/瞑想が達成ライン以上 × 朝の気分/);
  });

  it("週報データに瞑想の分布が入る", () => {
    const f = boot(seed(25)).window.__flourish;
    expect(f.weekStats(f.getS(), "2026-08-08").meditationMin).toEqual([25]);
  });

  // 勉強の study→studyMin と違い旧キーが無いので、migrate は既定値を足すだけでよい
  it("schema 19 以前のデータを取り込んでも壊れず、既定値が入る", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({ version: 19, entries: { "2026-08-08": { gym: true } } });
    expect(m.version).toBe(f.defaultData().version);
    expect(m.entries["2026-08-08"].meditationMin).toBe(undefined);
    expect(m.th.meditationMin).toBe(f.defaultData().th.meditationMin);
  });
});

// 瞑想と分けた判断が本体。同じフィールドに混ぜると (a) 達成ラインの向きが逆(瞑想は「以上で達成」、
// 昼寝は長いほど良いわけではない)、(b) 夜の睡眠に対して逆向きに効きうる2つが同じ φ に入って相殺する。
// 台帳は追記オンリーで後から分離できないので、分けたことを後退させないガードを置く
describe("PWA v4.18: 昼寝(計測のみ)", () => {
  const seed = (min) => JSON.stringify({ version: 21, entries: { "2026-08-08": { napMin: min } } });

  it("記録タブに昼寝の select が出て、選ぶと分の実値が入る", () => {
    const dom = boot();
    const sel = q(dom, 'select[data-f="napMin"]');
    expect(sel).not.toBe(null);
    sel.value = "15";
    sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(JSON.parse(dom.window.localStorage.getItem(KEY)).entries["2026-08-18"]).toEqual({ napMin: 15 });
  });

  // 【後退ガード】本体。昼寝は前夜の睡眠次第で最適量が変わり、達成/未達の二値で表せない。
  // 目標を持たせると疲れていない日にも昼寝する動機になり、夜の睡眠を削る
  it("【後退ガード】CORE・targets・th を持たず、achieved も判定しない", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    expect(f.CORE.some((c) => c.id === "napMin")).toBe(false);
    expect(d.targets.napMin).toBeUndefined();
    expect(d.th.napMin).toBeUndefined();
    expect(d.enabled.napMin).toBe(true);
    // 週の集計行は allItems(= CORE + カスタム)から導くので、CORE に無い限り達成判定は走らない
    d.entries["2026-08-08"] = { napMin: 20 };
    expect(f.weekStats(d, "2026-08-08").items.some((r) => r.label === "昼寝")).toBe(false);
  });

  // 【後退ガード】週タブと目標に行が出ると、1日あたりの未達の面積が増える(設計制約1・2)
  it("【後退ガード】週タブに行が出ず、目標のステッパーも持たない", () => {
    const dom = boot(seed(15));
    byText(dom, "button.tb", "週").click();
    expect(q(dom, "#view").textContent).not.toContain("昼寝");
    byText(dom, "button.tb", "設定").click();
    expect(qa(dom, "[data-tgt]").map((el) => el.dataset.tgt)).not.toContain("napMin");
    // 表示トグルは持つ(記録できる項目はすべて消せる)
    expect(qa(dom, "[data-tog]").map((el) => el.dataset.tog)).toContain("napMin");
  });

  // 実勢は5〜20分だが、上を2hまで取るのは寝落ちした日が天井に張り付くと実際の長さが記録から消えるため
  it("選択肢は5分刻みで上限2h、格子外の保存値も選択状態で描かれる", () => {
    const f = boot().window.__flourish;
    expect(f.NAP_MIN.slice(0, 4)).toEqual([0, 5, 10, 15]);
    expect(f.NAP_MIN[f.NAP_MIN.length - 1]).toBe(120);
    const dom = boot(seed(37), withClock("2026-08-08T07:00"));
    expect(q(dom, 'select[data-f="napMin"]').value).toBe("37");
  });

  // 【後退ガード】混ぜないことの実測。加算先を meditationMin に寄せ直すと落ちる
  it("【後退ガード】昼寝を入れても meditationMin は増えない", () => {
    const dom = boot();
    const sel = q(dom, 'select[data-f="napMin"]');
    sel.value = "20";
    sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    const e = JSON.parse(dom.window.localStorage.getItem(KEY)).entries["2026-08-18"];
    expect(e.napMin).toBe(20);
    expect(e.meditationMin).toBe(undefined);
  });

  it("週報データに昼寝の分布が入る", () => {
    const f = boot(seed(15)).window.__flourish;
    expect(f.weekStats(f.getS(), "2026-08-08").napMin).toEqual([15]);
  });

  // 計測のみの項目を週報へ渡すときは、解釈を縛る1文を必ず添える(水分・体重と同じ)。
  // 昼寝は外部の基準(「20分まで」「15時以降は避ける」)を誰でも持ち出せる
  it("【後退ガード】週報に外部の基準を持ち込ませない注記がある", () => {
    const f = boot().window.__flourish;
    const t = f.buildReviewText(f.defaultData(), "2026-08-08");
    expect(t).toContain("napMin は昼寝した分の実値");
    expect(t).toContain("目標を持たない計測のみで、多い少ないを評価しないでください");
    expect(t).toContain("外部の基準を持ち込まないでください");
    expect(t).toContain("瞑想とは別の項目なので合算しないでください");
    // 分けた理由(夜の睡眠に逆向きに効きうる)を渡すと、直前の「評価しないで」と逆向きの
    // プライミングになり、【来週の一点】に「昼寝を短くする」が出る経路が開く
    expect(t).not.toContain("逆向きに効きうる");
  });

  // 【後退ガード】相関ヒントの defs は手書きで、足し忘れても何も落ちない(静かに欠ける)。
  // 達成ラインを持たないので二値化は「した/していない」でなければならない
  it("【後退ガード】相関ヒントに昼寝の対があり、二値化が napMin>0 である", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html).toMatch(/前日に昼寝した × 眠れた感/);
    expect(html).toMatch(/前日に昼寝した × 朝の気分/);
    expect(html).toMatch(/e\.napMin==null\?null:e\.napMin>0/);
    // 達成ラインを参照していたら、th.napMin を足した誰かが向きの逆な判定を持ち込んでいる
    expect(html).not.toMatch(/th\.napMin/);
  });

  // 28日ロック(制約4)は外さないので、28日ぶん積んでから週報タブで見る。
  // 対は2本ともコスト側(夜の睡眠・朝の気分)で、日中の集中力を測る項目が無いため
  // 効果側は構造的に出ない。注記が無いと、負の値だけを見て片側で判断することになる
  it("【後退ガード】相関ヒントが描画され、効果側を測っていない旨の注記が出る", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    for (let i = 0; i < 28; i++) {
      const dt = new Date("2026-07-01T00:00");
      dt.setDate(dt.getDate() + i);
      // 昼寝した日は眠れず気分も低い、という完全な相関を作る(φ=1.00 になる)
      d.entries[f0.fmt(dt)] = { napMin: i % 2 === 0 ? 20 : 0, sleepFeel: i % 2 === 0 ? 2 : 0, moodM: i % 2 === 0 ? 2 : 0 };
    }
    const dom = boot(JSON.stringify(d));
    byText(dom, "button.tb", "週報").click();
    const view = q(dom, "#view").textContent;
    expect(view).toContain("前日に昼寝した × 眠れた感「良」");
    expect(view).toContain("前日に昼寝した × 朝の気分「高」");
    expect(view).toContain("関係が出なくても、効果が無いという意味ではありません");
  });

  // 【後退ガード】真上の瞑想が「10分以上で達成」の同形の行なので、注記が無いと
  // 昼寝にも達成ラインがあるように見える(業務時間・仕事の重さと同じ明示)
  it("【後退ガード】記録タブの注記に「計測のみ」がある", () => {
    const dom = boot();
    const card = qa(dom, ".card").find((el) => el.textContent.includes("昨日"));
    expect(card.textContent).toContain("昼寝");
    const label = qa(dom, ".row").find((el) => el.textContent.startsWith("昼寝"));
    expect(label.textContent).toContain("計測のみ");
  });

  // 追加のみなので値の変換は要らない。既存の日を書き換えないことを見る
  it("schema 20 以前のデータを取り込んでも壊れず、既定値が入る", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({ version: 20, entries: { "2026-08-08": { meditationMin: 15 } } });
    expect(m.version).toBe(CURRENT_SCHEMA);
    expect(m.entries["2026-08-08"]).toEqual({ meditationMin: 15 });
    expect(m.enabled.napMin).toBe(true);
  });
});

describe("PWA v4.18: タイマーの種別(勉強/瞑想)", () => {
  const TKEY = "flourish-log-v2-timer";
  const openTimer = (dom) => byText(dom, "button.tb", "タイマー").click();
  const startKind = (dom, kind) => {
    openTimer(dom);
    q(dom, '[data-action="timerStart"][data-kind="' + kind + '"]').click();
  };
  const entriesOf = (dom) => {
    const raw = dom.window.localStorage.getItem(KEY);
    return raw ? JSON.parse(raw).entries : {};
  };

  it("瞑想で計測すると meditationMin に入り、studyMin は増えない", () => {
    const dom = boot(null, withClock("2026-08-17T20:00"));
    startKind(dom, "meditation");
    dom.window.__advanceTo("2026-08-17T20:15");
    q(dom, '[data-action="timerStop"]').click();
    expect(entriesOf(dom)["2026-08-18"].meditationMin).toBe(15);
    expect(entriesOf(dom)["2026-08-18"].studyMin).toBe(undefined);
  });

  it("走行中は開始ボタンを描かない", () => {
    const dom = boot(null, withClock("2026-08-17T20:00"));
    startKind(dom, "study");
    expect(q(dom, '[data-action="timerStart"]')).toBe(null);
    expect(dom.window.__flourish.getTimer().kind).toBe("study");
  });

  // 状態は単一オブジェクトなので、2本目を許すとどちらの経過か復元できなくなる。
  // 描画は走行中に開始ボタンを出さないが、それはハンドラの防壁の検証にならない
  // (描画だけを直しても、取り残されたボタンや二度押しで通ってしまう)。
  // #view の外にボタンを置いて再描画で消えないようにし、ハンドラ自体を叩く
  it("走行中に開始を叩いても、計測中の種別と開始時刻が変わらない", () => {
    const dom = boot(null, withClock("2026-08-17T20:00"));
    startKind(dom, "study");
    const before = { ...dom.window.__flourish.getTimer() };
    const rogue = dom.window.document.createElement("button");
    rogue.setAttribute("data-action", "timerStart");
    rogue.setAttribute("data-kind", "meditation");
    dom.window.document.body.appendChild(rogue);
    dom.window.__advanceTo("2026-08-17T20:10");
    rogue.click();
    expect(dom.window.__flourish.getTimer()).toEqual(before);
    // 弾いたことを黙らせない(押したのに何も起きないと、壊れたのか仕様なのか分からない)
    expect(q(dom, "#saveState").textContent).toContain("勉強");
  });

  // v4.16 以前の走行中の状態は kind を持たない。読み出しで補わないと記録先が消える
  it("kind を持たない旧い走行状態は勉強として読む", () => {
    const dom = boot(null, (w) => {
      withClock("2026-08-17T20:30")(w);
      w.localStorage.setItem(TKEY, JSON.stringify({ startedAt: Date.parse("2026-08-17T20:00+09:00"), day: "2026-08-17" }));
    });
    expect(dom.window.__flourish.getTimer().kind).toBe("study");
    openTimer(dom);
    q(dom, '[data-action="timerStop"]').click();
    expect(entriesOf(dom)["2026-08-18"].studyMin).toBe(30);
  });

  // 記録先フィールドを分岐に書き写すと、種別を足したとき片方だけ古いまま残る
  it("種別の一覧から累計表示が導出され、両方の種別が出る", () => {
    const dom = boot(JSON.stringify({ version: 20, entries: { "2026-08-18": { studyMin: 45, meditationMin: 20 } } }),
      withClock("2026-08-17T09:00"));
    openTimer(dom);
    const txt = q(dom, "#view").textContent;
    expect(txt).toContain("勉強");
    expect(txt).toContain("瞑想");
    expect(txt).toContain("45分");
    expect(txt).toContain("20分");
  });

  // 上限は種別によらず「止め忘れ」への防壁。瞑想でも同じく記録しない
  it("瞑想でも上限を超えた経過は記録しない", () => {
    const dom = boot(null, withClock("2026-08-17T09:00"));
    startKind(dom, "meditation");
    dom.window.__advanceTo("2026-08-18T02:00");
    q(dom, '[data-action="timerStop"]').click();
    expect(entriesOf(dom)["2026-08-18"]).toBe(undefined);
    expect(dom.window.localStorage.getItem(TKEY)).toBe(null);
  });

  // 記録タブは朝の動線。タイマーは種別が増えても一切出さない(設計制約3)
  it("種別が増えても記録タブにタイマーは出ない", () => {
    const dom = boot();
    expect(q(dom, '[data-action="timerStart"]')).toBe(null);
    expect(q(dom, "[data-kind]")).toBe(null);
  });
});

describe("PWA v4.18: ひとこと(その日の出来事)", () => {
  // 設計制約3は朝の入力の摩擦を増やさないこと。既定で自由入力欄が出ていると、朝の動線に
  // タップ以外の作業が増える。閉じている限り textarea が存在しないことを縛る
  it("既定では textarea が無く、朝の動線に現れない", () => {
    const dom = boot();
    expect(q(dom, "#memo")).toBe(null);
    expect(q(dom, '[data-action="memo"]')).not.toBe(null);
  });

  it("開いて書くと保存され、リロードでも残る", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    q(dom, '[data-action="memo"]').click();
    const ta = q(dom, "#memo");
    ta.value = "娘が初めて「ありがとう」と言った";
    ta.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    const saved = JSON.parse(dom.window.localStorage.getItem(KEY));
    expect(saved.entries[f.fmt(new Date())].memo).toBe("娘が初めて「ありがとう」と言った");
    // 書いた日は開き直さなくても見える。畳んだままだと書いたものが消えたように見える
    const back = boot(JSON.stringify(saved));
    expect(q(back, "#memo").value).toBe("娘が初めて「ありがとう」と言った");
  });

  it("空白だけにすると未入力へ戻る", () => {
    const dom = boot();
    q(dom, '[data-action="memo"]').click();
    const set = (v) => {
      const ta = q(dom, "#memo");
      ta.value = v;
      ta.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    };
    set("あとで消す");
    set("   ");
    expect(Object.keys(JSON.parse(dom.window.localStorage.getItem(KEY)).entries).length).toBe(0);
  });

  // 達成判定を持たせると「書かなかった日」が未達になり、設計制約2に正面から反する
  it("週の目標・達成ライン・表示トグルを持たない", () => {
    const f0 = boot().window.__flourish;
    expect(f0.defaultData().enabled.memo).toBe(undefined);
    expect(f0.defaultData().targets.memo).toBe(undefined);
    const dom = boot();
    byText(dom, "button.tb", "設定").click();
    expect(qa(dom, "[data-tog]").some((el) => el.dataset.tog === "memo")).toBe(false);
  });

  // 自由入力なので改行・カンマ・引用符が入る。囲まないと以降の列が全部ずれる
  it("カンマ・改行・引用符を含んでもCSVの列がずれない", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    d.entries["2026-08-08"] = { memo: '朝は雨, 夜は"晴れ"\n散歩した' };
    const lines = f.buildCSV(d).split("\n");
    // 改行を含むセルは引用符の中にあるので、行数は増えるが列数は保たれる
    const joined = lines.slice(1).join("\n");
    expect(joined).toContain('"朝は雨, 夜は""晴れ""\n散歩した"');
    expect(lines[0]).toContain("ひとこと");
  });

  // 台帳は追記オンリーで、確定した本文は二度と直せない。画面に出しておかないと
  // 「アプリで消したのに残っている」に後から気づくことになる
  it("直せなくなることを画面で伝える", () => {
    const dom = boot();
    q(dom, '[data-action="memo"]').click();
    const notes = qa(dom, ".foot").map((el) => el.textContent).join("\n");
    expect(notes).toContain("台帳");
    expect(notes).toMatch(/書き直せません|直せません/);
  });

  // 台帳はこの端末とPCに留まるが、週報はチャットへ貼る動線なので外部へ出る。
  // 同じ「外に出す」でも線を分けてある
  it("週報テキストに本文が混ざらない", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    d.entries["2026-08-08"] = { memo: "取引先の田中さんと会食" };
    expect(f.buildReviewText(d, "2026-08-09")).not.toContain("田中");
  });

  it("memo を持たない旧データも読め、version が上がる", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({ version: 11, entries: { "2026-08-01": { gym: true } } });
    expect(m.version).toBe(CURRENT_SCHEMA);
    expect(m.entries["2026-08-01"].memo).toBe(undefined);
  });
});

describe("PWA v4.18: 誰と過ごしたか(計測のみ)", () => {
  it("記録タブの「昨日」カードにあり、選ぶとインデックスで保存される", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    const card = qa(dom, ".card").find((el) => el.textContent.includes("昨日"));
    expect(card.textContent).toContain("誰と");
    q(dom, '[data-f="companion"][data-v="1"]').click();
    expect(JSON.parse(dom.window.localStorage.getItem(KEY)).entries[f.fmt(new Date())].companion).toBe(1);
  });

  it("同じ値をもう一度押すと未入力に戻る", () => {
    const dom = boot();
    q(dom, '[data-f="companion"][data-v="0"]').click();
    q(dom, '[data-f="companion"][data-v="0"]').click();
    expect(Object.keys(JSON.parse(dom.window.localStorage.getItem(KEY)).entries).length).toBe(0);
  });

  // 誰と過ごすかは達成でも主観の良し悪しでもない。週目標や達成ラインを持たせると
  // 「家族と過ごさなかった日」が未達として数えられ、設計制約1・2の趣旨と衝突する
  it("週の目標・達成ラインを持たない", () => {
    const f0 = boot().window.__flourish;
    expect(f0.defaultData().targets.companion).toBe(undefined);
    expect(f0.defaultData().th.companion).toBe(undefined);
    expect(f0.CORE.some((c) => c.id === "companion")).toBe(false);
    const dom = boot();
    byText(dom, "button.tb", "設定").click();
    expect(qa(dom, "[data-tgt]").some((el) => el.dataset.tgt === "companion")).toBe(false);
    expect(q(dom, '[data-th="companion"]')).toBe(null);
  });

  // 色で「家族の方が良い」と言わせない。評価色(pine/sienna)が付くと順序尺度に見える
  it("評価色を使わず、全段が同じ色", () => {
    const dom = boot();
    const cls = qa(dom, '[data-f="companion"][data-v]').map((el) => el.className);
    expect(cls.length).toBe(dom.window.__flourish.COMPANION_OPTS.length);
    expect(cls.some((c) => c.includes("on-pine") || c.includes("on-sienna"))).toBe(false);
  });

  it("CSVに「誰と」の列がラベルで入る", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    d.entries["2026-08-08"] = { companion: 2 };
    const [head, row] = f.buildCSV(d).split("\n");
    // 添字を書くと列が増えるたびに腐るので、ヘッダーから引く
    expect(head).toContain("誰と");
    expect(row.split(",")[head.split(",").indexOf("誰と")]).toBe("友人");
  });

  // 記録できても週報に渡らなければ、気分との突き合わせができず集めた意味が無い
  it("週報データに分布と凡例が入り、価値づけを禁じる注記が付く", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    d.entries["2026-08-03"] = { companion: 1 };
    d.entries["2026-08-04"] = { companion: 1 };
    d.entries["2026-08-05"] = { companion: 0 };
    expect(f.weekStats(d, "2026-08-03", "2026-08-09").companion).toEqual([1, 2, 0, 0]);
    const t = f.buildReviewText(d, "2026-08-09");
    expect(t).toContain("companion=[" + f.COMPANION_OPTS.join(",") + "]");
    expect(t).toContain("価値づけ");
    expect(t).toContain('"companion":[1,2,0,0]');
  });

  it("companion を持たない旧データも読め、version が上がる", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({ version: 10, entries: { "2026-08-01": { gym: true } } });
    expect(m.version).toBe(CURRENT_SCHEMA);
    expect(m.enabled.companion).toBe(true);
    expect(m.entries["2026-08-01"].companion).toBe(undefined);
  });
});

describe("PWA v4.18: 朝コーヒー", () => {
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
    expect(row).toBe("2026-08-08,,,,,,0,,,,,,,,,,,,,,,,,,,,,,,,,,,,,");
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

describe("PWA v4.18: 週タブの前週併記", () => {
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

// 外食は「良し悪しの無い事実」として足した項目。達成判定を持たず、色でも評価しない。
// 目的は「外食した日の夜がどうだったか」を相関ヒントで読むことなので、
// 計測のみであること・相関の対があることの2つが本体
describe("PWA v4.18: 外食(計測のみ)", () => {
  const today = (f) => f.fmt(new Date());

  it("「昨日」カードにあり、1タップで保存される", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    const card = qa(dom, ".card").find((el) => el.textContent.includes("昨日"));
    expect(card.textContent).toContain("外食");
    q(dom, '[data-f="eatout"][data-v="t"]').click();
    expect(JSON.parse(dom.window.localStorage.getItem(KEY)).entries[today(f)]).toEqual({ eatout: true });
  });

  it("同じ値をもう一度押すと未入力に戻る", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    q(dom, '[data-f="eatout"][data-v="t"]').click();
    q(dom, '[data-f="eatout"][data-v="t"]').click();
    expect(JSON.parse(dom.window.localStorage.getItem(KEY)).entries[today(f)]).toBeUndefined();
  });

  // 制約6 と同じ趣旨。外食は達成でも未達でもない
  it("【後退ガード】達成判定と週次目標を持たない", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    expect(d.targets.eatout).toBeUndefined();
    expect(d.th.eatout).toBeUndefined();
    expect(f.CORE.some((c) => c.id === "eatout")).toBe(false);
  });

  // 週報に載らないと、レビューを書く Claude 側は外食の存在を知り得ない
  it("【後退ガード】週報データに外食と体重が入る", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    const ws = f0.weekStart(new Date("2026-07-06T00:00"));
    for (let i = 0; i < 3; i++) {
      const dt = new Date(ws);
      dt.setDate(dt.getDate() + i);
      d.entries[f0.fmt(dt)] = { eatout: i === 0, weight: true, weightVal: String(68 + i) };
    }
    const s = f0.weekStats(d, ws, f0.fmt(new Date("2026-07-12T00:00")));
    expect(s.eatout).toEqual({ yes: 1, entered: 3 });
    expect(s.weightVal).toEqual([68, 69, 70]);

    const txt = f0.buildReviewText(d, f0.fmt(new Date("2026-07-12T00:00")));
    expect(txt).toContain("eatout");
    expect(txt).toContain("weightVal");
    // 日ごとの対応は渡していないので、突き合わせを禁じる注記が要る
    expect(txt).toContain("週ぶんの一覧で、分布として述べるにとどめて");
    // 強調は週報テキストで使わない。使うと重要度の序列が実態とずれる
    expect(txt).not.toContain("**");
  });

  // 計測のみの項目を週報へ渡すときは、解釈を縛る1文を必ず添える。
  // 体重は外部の基準(BMI・理想体重)を誰でも持ち出せるので、これが無いと
  // 【来週の一点】が最も具体的に書ける変数として無防備に置かれる
  it("【後退ガード】体重に外部の基準を持ち込ませない注記がある", () => {
    const f0 = boot().window.__flourish;
    const txt = f0.buildReviewText(f0.defaultData(), f0.fmt(new Date("2026-07-12T00:00")));
    expect(txt).toContain("BMI や理想体重のような外部の基準を持ち込まず");
    expect(txt).toContain("達成として数えているのは「体重測定をしたか」");
  });

  it("【後退ガード】未入力を失敗と読ませない注記がある（制約2）", () => {
    const f0 = boot().window.__flourish;
    const txt = f0.buildReviewText(f0.defaultData(), f0.fmt(new Date("2026-07-12T00:00")));
    expect(txt).toContain("記録しなかった日は未入力であって失敗ではありません");
  });

  it("体重が未記録・数値でない日は週報に混ざらない", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    const ws = f0.weekStart(new Date("2026-07-06T00:00"));
    const day = (n) => { const dt = new Date(ws); dt.setDate(dt.getDate() + n); return f0.fmt(dt); };
    d.entries[day(0)] = { weightVal: "68.5" };
    d.entries[day(1)] = { weightVal: "" };
    d.entries[day(2)] = { weightVal: "測ってない" };
    d.entries[day(3)] = { eatout: true };
    const s = f0.weekStats(d, ws, f0.fmt(new Date("2026-07-12T00:00")));
    expect(s.weightVal).toEqual([68.5]);
    expect(s.eatout).toEqual({ yes: 1, entered: 1 });
  });

  // ✓ は「達成側の印」として使われているので、計測のみの項目には付けない
  it("【後退ガード】ラベルに ✓ / ✗ を使わない", () => {
    const dom = boot();
    const card = qa(dom, ".card").find((el) => el.textContent.includes("昨日"));
    const row = card.innerHTML.split('data-f="eatout"');
    expect(row.length).toBeGreaterThan(1);
    const labels = qa(dom, '[data-f="eatout"]').map((b) => b.textContent);
    expect(labels).toEqual(["した", "していない"]);
    // 休肝日は従来どおり ✓ を保つ(中立化が全体に漏れていないこと)
    expect(byText(dom, "button.sb", "✓ 飲まなかった")).toBeTruthy();
  });

  // 評価色を付けると画面が「外食は悪い」と言ってしまう(companion と同じ理由)
  it("【後退ガード】選んでも評価色(on-pine)が付かない", () => {
    const dom = boot();
    q(dom, '[data-f="eatout"][data-v="t"]').click();
    const on = q(dom, '[data-f="eatout"][data-v="t"]');
    expect(on.className).toContain("on");
    expect(on.className).not.toContain("on-pine");
    // 休肝日は従来どおり評価色が付く(中立化が全体に漏れていないこと)
    q(dom, '[data-f="sober"][data-v="t"]').click();
    expect(q(dom, '[data-f="sober"][data-v="t"]').className).toContain("on-pine");
  });

  it("設定タブで表示を切ると記録タブから消える", () => {
    const dom = boot();
    expect(q(dom, '[data-f="eatout"][data-v="t"]')).toBeTruthy();
    q(dom, '[data-nav="settings"]').click();
    q(dom, '[data-tog="eatout"]').click();
    q(dom, '[data-nav="log"]').click();
    expect(q(dom, '[data-f="eatout"][data-v="t"]')).toBeNull();
  });

  // これを足すために項目を作った。無ければ目的を果たしていない。
  // 28日ロック(制約4)は外さないので、28日ぶん積んでから週報タブで見る
  it("【後退ガード】眠れた感・朝の気分との相関ヒントが出る", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    for (let i = 0; i < 28; i++) {
      const dt = new Date("2026-07-01T00:00");
      dt.setDate(dt.getDate() + i);
      // 外食した日は眠れず気分も低い、という完全な相関を作る(φ=1.00 になる)
      d.entries[f0.fmt(dt)] = { eatout: i % 2 === 0, sleepFeel: i % 2 === 0 ? 2 : 0, moodM: i % 2 === 0 ? 2 : 0 };
    }
    const dom = boot(JSON.stringify(d));
    byText(dom, "button.tb", "週報").click();
    const view = q(dom, "#view").textContent;
    expect(view).toContain("前日に外食した × 眠れた感「良」");
    expect(view).toContain("前日に外食した × 朝の気分「高」");
  });
});

describe("PWA v4.18: サウナ・歩数・休肝日", () => {
  const today = (f) => f.fmt(new Date());

  it("3項目とも「昨日」カードにあり、1タップで保存される", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    const card = qa(dom, ".card").find((el) => el.textContent.includes("昨日"));
    ["サウナ", "歩数", "休肝日"].forEach((l) => expect(card.textContent).toContain(l));
    q(dom, '[data-f="sauna"][data-v="t"]').click();
    pickMin(dom, "stepsCount", "10000");
    q(dom, '[data-f="sober"][data-v="t"]').click();
    const e = JSON.parse(dom.window.localStorage.getItem(KEY)).entries[today(f)];
    expect(e).toEqual({ sauna: true, stepsCount: 10000, sober: true });
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
    expect(d.th.stepsCount).toBe(8000);
    expect(f.achieved(d, { stepsCount: 3000 }, "stepsCount")).toBe(false);
    expect(f.achieved(d, { stepsCount: 5000 }, "stepsCount")).toBe(false);
    expect(f.achieved(d, { stepsCount: 8000 }, "stepsCount")).toBe(true);
    expect(f.achieved(d, { stepsCount: 10000 }, "stepsCount")).toBe(true);
    expect(f.achieved(d, {}, "stepsCount")).toBe(null);
    d.th.stepsCount = 10000;
    expect(f.achieved(d, { stepsCount: 8000 }, "stepsCount")).toBe(false);
  });

  // 最下段を選べるようにすると、どれを選んでも達成になり達成ラインが意味を失う
  it("歩数の達成ラインは設定タブで変えられ、最下段は選べない", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    byText(dom, "button.tb", "設定").click();
    const sel = q(dom, '[data-th="stepsCount"]');
    expect([...sel.options].map((o) => o.value)).toEqual(["3000", "5000", "8000", "10000", "12000", "15000"]);
    sel.value = "10000";
    sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(f.getS().th.stepsCount).toBe(10000);
    expect(JSON.parse(dom.window.localStorage.getItem(KEY)).th.stepsCount).toBe(10000);
  });

  it("週タブと週の目標に3項目とも並ぶ", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    d.entries[today(f0)] = { sauna: true, stepsCount: 10000, sober: true };
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

describe("PWA v4.18: 食事の節制", () => {
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

describe("PWA v4.18: v5 スキーマ", () => {
  it("v5 データを読んでも既存の設定を保ち、新項目は既定値で埋まる", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({
      version: 5,
      targets: { gym: 4 },
      th: { bedtime: 0 },
      entries: { "2026-08-01": { gym: true } },
    });
    expect(m.version).toBe(CURRENT_SCHEMA);
    expect(m.targets.gym).toBe(4);
    expect(m.th.bedtimeMin).toBe(1380);
    // 達成ラインを設定していない旧データは、シフトの対象ではなく新既定で埋まる
    expect(m.th.stepsCount).toBe(8000);
    ["sauna", "stepsCount", "sober", "meal"].forEach((id) => {
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
    d.entries["2026-08-08"] = { sauna: true, stepsCount: 10000, sober: false, mealB: true, mealD: false };
    const [head, row] = f.buildCSV(d).split("\n");
    ["サウナ", "歩数", "休肝日", "朝食", "昼食", "夕食"].forEach((c) => expect(head).toContain(c));
    expect(row).toBe("2026-08-08,,,,,,,,,,,,,,,1,,,,10000,,,,0,,,,1,,0,,,,,,");
    const t = f.buildReviewText(d, "2026-08-08");
    expect(t).toContain("stepsCount は歩数の実値");
    expect(t).toContain("休肝日は酒を飲まなかった日");
    expect(t).toContain('"stepsCount":');
  });
});

describe("PWA v4.18: 整腸剤・サプリ", () => {
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
    expect(m.version).toBe(CURRENT_SCHEMA);
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
    expect(row).toBe("2026-08-08,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,1,,0,,,");
    expect(f.buildReviewText(d, "2026-08-08")).toContain("食事の節制と整腸剤・サプリは1日3回ぶんを記録し");
  });
});

describe("PWA v4.18: PCへの同期(任意)", () => {
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

describe("PWA v4.18: 同期の取り扱いを壊さない", () => {
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

describe("PWA v4.18: 歩数の移行(v7 の4段階化 → v16 の実値化)", () => {
  // v6 以前のデータは2段の移行を通る: v7 でインデックスを +1 し、v16 で実値へ移す。
  // 合成後の姿を見ないと、片方が壊れてももう片方が吸収して気づけない
  it("旧インデックスが2段の移行を通って実値になる", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({
      version: 6,
      th: { steps: 1 },                       // v7 で 2 → v16 で 8000
      entries: {
        "2026-08-01": { steps: 0 },           // +1 → 1 → 5000
        "2026-08-02": { steps: 1, gym: true },// +1 → 2 → 8000
        "2026-08-03": { steps: 2 },           // +1 → 3 → 10000
      },
    });
    expect(m.version).toBe(CURRENT_SCHEMA);
    expect(m.th.stepsCount).toBe(8000);
    expect(m.th.steps).toBe(undefined);
    expect(m.entries["2026-08-01"].stepsCount).toBe(5000);
    expect(m.entries["2026-08-02"]).toEqual({ stepsCount: 8000, gym: true });
    expect(m.entries["2026-08-03"].stepsCount).toBe(10000);
  });

  // 取り込みJSONは version キーを欠きうる。Object.assign は既定値で埋めるので、
  // 生の入力ではなく o.version で版を判定すると、移行が丸ごと効かなくなる
  it("version キーを持たない入力でも移行される", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({ th: { steps: 1 }, entries: { "2026-08-01": { steps: 2 } } });
    expect(m.entries["2026-08-01"].stepsCount).toBe(10000);
    expect(m.th.stepsCount).toBe(8000);
  });

  it("migrate が書き込む版は defaultData の版と一致し、二度通しても動かない", () => {
    const f = boot().window.__flourish;
    const v = f.defaultData().version;
    expect(f.migrate({}).version).toBe(v);
    expect(f.migrate(f.migrate({ version: 5, entries: {} })).version).toBe(v);
  });

  // 移行の目的は「過去の達成/未達が1つも変わらない」こと。旧仕様の式を右辺に置いて突き合わせる
  it("2段の移行を経ても過去の達成判定が1つも変わらない", () => {
    const f = boot().window.__flourish;
    [1, 2].forEach((oldTh) => {
      const old = { version: 6, th: { steps: oldTh }, entries: {} };
      [0, 1, 2].forEach((v) => { old.entries["2026-08-0" + (v + 1)] = { steps: v }; });
      const m = f.migrate(old);
      [0, 1, 2].forEach((v) => {
        const dt = "2026-08-0" + (v + 1);
        expect(f.achieved(m, m.entries[dt], "stepsCount")).toBe(v >= oldTh);
      });
    });
  });

  it("移行済みのデータを二度通しても再変換しない", () => {
    const f = boot().window.__flourish;
    const once = f.migrate({ version: 6, th: { steps: 1 }, entries: { "2026-08-01": { steps: 1 } } });
    const twice = f.migrate(once);
    expect(twice.entries["2026-08-01"].stepsCount).toBe(8000);
    expect(twice.th.stepsCount).toBe(8000);
  });

  // 同じJSONを二度取り込む経路があるので、入力オブジェクト自体を書き換えてはいけない
  it("migrate は入力の entries を書き換えない", () => {
    const f = boot().window.__flourish;
    const src = { version: 6, entries: { "2026-08-01": { steps: 1 } } };
    f.migrate(src);
    expect(src.entries["2026-08-01"]).toEqual({ steps: 1 });
    expect(f.migrate(src).entries["2026-08-01"].stepsCount).toBe(8000);
  });

  // 取り込みJSONは任意の値になりうる。読み替えは正当なインデックスだけに効かせ、他は素通しする
  it("壊れた歩数の値は例外を出さずそのまま残す", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({ version: 15, entries: { a: { steps: "1" }, b: { steps: 9 }, c: null } });
    expect(m.entries.a).toEqual({ steps: "1" });
    expect(m.entries.b).toEqual({ steps: 9 });
    expect(m.entries.c).toBe(null);
  });

  it("旧キーと新キーが両方あれば新キーを残す", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({ version: 15, entries: { "2026-08-01": { steps: 0, stepsCount: 12000 } } });
    expect(m.entries["2026-08-01"]).toEqual({ stepsCount: 12000 });
  });
});

describe("PWA v4.18: タンパク質", () => {
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

  it("CSVにタンパク質の列が歩数の手前に入る", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    d.entries["2026-08-08"] = { protein: false };
    const [head, row] = f.buildCSV(d).split("\n");
    const cols = head.split(",");
    const i = cols.indexOf("タンパク質");
    expect(i).toBeGreaterThan(-1);
    expect(row.split(",")[i]).toBe("0");
    // 位置がずれると以降の歩数・休肝日・食事・サプリ・カスタムが1つずつ右へ動く
    expect(cols[i + 1]).toBe("歩数(歩)");
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

describe("PWA v4.18: 今の気分", () => {
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
describe("PWA v4.18: 項目の結線ガード(CORE 起点)", () => {
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
    const NUM = numericSamples();
    const groups = f.PERDAY.concat([f.MOOD]);
    // weightVal と memo は enabled を持たない自由入力(達成も計測もしない)ので、
    // enabled から導けない。列が落ちたことは検出したいので、ここで手で埋める
    // weightVal / memo は enabled を持たない自由入力。study は v4.7 で studyMin へ移した
    // 旧列で、過去の記録を読めるように残してある。どれも enabled から導けないので手で埋める
    const e = { weightVal: "68.5", memo: "覚えておきたいこと", study: true };
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
    const NUM = numericSamples();
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
    const NUM = numericSamples();
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

describe("PWA v4.18: 月間ビュー", () => {
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

describe("PWA v4.18: v9 スキーマ(就寝・起床・YouTube の分値化)", () => {
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
    expect(m.version).toBe(CURRENT_SCHEMA);
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

  // 刻みは30分のまま(締め上げの無摩擦化を避ける)。範囲だけ 22:00 まで下へ広げてある
  it("達成ラインは30分刻みのまま、22:00 まで選べる", () => {
    const dom = boot();
    byText(dom, "button.tb", "設定").click();
    const vals = [...q(dom, '[data-th="bedtimeMin"]').options].map((o) => Number(o.value));
    expect(vals).toEqual([1320, 1350, 1380, 1410, 1440, 1470]);
    // 隣り合う選択肢の差が30分より細かくならないこと(細分化は別の判断で、勝手に混ぜない)
    vals.slice(1).forEach((v, i) => expect(v - vals[i]).toBe(30));
    expect(q(dom, '[data-th="bedtimeMin"]').options[0].text).toBe("22:00 以内");
    expect([...q(dom, '[data-th="youtubeMin"]').options].map((o) => o.value)).toEqual(["30", "60", "120"]);
  });
});

describe("PWA v4.18: お風呂・肌ケア / マウスケア", () => {
  const today = (f) => f.fmt(new Date());
  const ITEMS = [
    { id: "bath", label: "お風呂・肌ケア" },
    { id: "mouth", label: "マウスケア" },
  ];

  // 前日を指す項目なので「昨日」カードに置く。「今朝」に置くと指す時点が変わる
  it("「昨日」カードにあり、1タップで保存される", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    const card = qa(dom, ".card").find((el) => el.textContent.includes("昨日"));
    ITEMS.forEach(({ id, label }) => {
      expect(card.textContent).toContain(label);
      expect(card.querySelector(`[data-f="${id}"]`)).not.toBe(null);
    });
    q(dom, '[data-f="bath"][data-v="t"]').click();
    q(dom, '[data-f="mouth"][data-v="f"]').click();
    expect(JSON.parse(dom.window.localStorage.getItem(KEY)).entries[today(f)]).toEqual({ bath: true, mouth: false });
  });

  // 「両方」が何を指すかはオーナーの定義。アプリは中身を決めない(タンパク質の「規定量」と同じ)
  it("ボタンのラベルが「両方した / しなかった」になっている", () => {
    const dom = boot();
    ITEMS.forEach(({ id }) => {
      expect(q(dom, `[data-f="${id}"][data-v="t"]`).textContent).toBe("✓ 両方した");
      expect(q(dom, `[data-f="${id}"][data-v="f"]`).textContent).toBe("✗ しなかった");
    });
    const card = qa(dom, ".card").find((el) => el.textContent.includes("昨日"));
    expect(card.textContent).toContain("両方そろって達成");
  });

  it("達成判定は「した」だけが達成で、未入力は未達にしない", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    ITEMS.forEach(({ id }) => {
      expect(f.achieved(d, { [id]: true }, id)).toBe(true);
      expect(f.achieved(d, { [id]: false }, id)).toBe(false);
      expect(f.achieved(d, {}, id)).toBe(null);
    });
  });

  it("週タブと週の目標に並ぶ", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    d.entries[today(f0)] = { bath: true, mouth: true };
    const dom = boot(JSON.stringify(d));
    byText(dom, "button.tb", "週").click();
    ITEMS.forEach(({ id, label }) => {
      const wrow = qa(dom, ".wrow").find((el) => el.textContent.includes(label));
      expect(wrow.textContent).toContain("1/" + d.targets[id]);
      expect(wrow.querySelectorAll(".dot.ok").length).toBe(1);
    });
  });

  it("CSVに2列が入り、値が自分のラベルの下に出る", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    d.entries["2026-08-08"] = { bath: true, mouth: false };
    const [head, row] = f.buildCSV(d).split("\n");
    const cols = head.split(",");
    const cells = row.split(",");
    expect(cells[cols.indexOf("お風呂・肌ケア")]).toBe("1");
    expect(cells[cols.indexOf("マウスケア")]).toBe("0");
  });

  it("v9 データを読んでも既定値で埋まり、既存の設定は残る", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({ version: 9, targets: { gym: 4 }, entries: { "2026-08-01": { gym: true } } });
    expect(m.version).toBe(CURRENT_SCHEMA);
    ITEMS.forEach(({ id }) => {
      expect(m.targets[id]).toBe(6);
      expect(m.enabled[id]).toBe(true);
    });
    expect(m.targets.gym).toBe(4);
    expect(m.entries["2026-08-01"]).toEqual({ gym: true }); // 値の変換は要らない
  });

  it("表示トグルを切ると記録タブから消える", () => {
    const dom = boot();
    ITEMS.forEach(({ id }) => {
      expect(q(dom, `[data-f="${id}"]`)).not.toBe(null);
      byText(dom, "button.tb", "設定").click();
      q(dom, `[data-tog="${id}"]`).click();
      byText(dom, "button.tb", "記録").click();
      expect(q(dom, `[data-f="${id}"]`)).toBe(null);
    });
  });
});

describe("PWA v4.18: 明日ぶんの先取り入力", () => {
  const AUG = "2026-08-16T21:00"; // 夜。翌日は 2026-08-17
  const openLog = () => boot(undefined, withClock(AUG));
  const nav = (dom, dn) => q(dom, `[data-dn="${dn}"]`);

  // 就寝時刻と前日の行動は夜のうちに確定している。翌朝まで抱えて思い出すより、
  // その場で入れた方が記録が正確になる
  it("明日まで進めるが、その先へは進めない", () => {
    const dom = openLog();
    expect(nav(dom, 1).disabled).toBe(false);
    nav(dom, 1).click();
    expect(q(dom, ".dateT").textContent).toContain("8/17");
    expect(nav(dom, 1).disabled).toBe(true); // 明後日は開かない
  });

  // 同じカードが指す時点が変わるので、見出しが「昨夜」のままだと何を入れているか分からなくなる
  it("明日ぶんではカードの見出しが今夜・明日の朝・今日になる", () => {
    const dom = openLog();
    const titles = () => qa(dom, ".ctitle").map((el) => el.textContent);
    expect(titles()).toEqual(expect.arrayContaining(["昨夜", "今朝", "昨日"]));
    nav(dom, 1).click();
    expect(titles()).toEqual(expect.arrayContaining(["今夜", "明日の朝", "今日"]));
    nav(dom, -1).click();
    expect(titles()).toEqual(expect.arrayContaining(["昨夜", "今朝", "昨日"]));
  });

  it("明日ぶんに入れた値は明日の日付キーに入る", () => {
    const dom = openLog();
    nav(dom, 1).click();
    const s = q(dom, 'select[data-f="bedtimeMin"]');
    s.value = "1320"; // 22:00
    s.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    const saved = JSON.parse(dom.window.localStorage.getItem(KEY)).entries;
    expect(saved["2026-08-17"]).toEqual({ bedtimeMin: 1320 });
    expect(saved["2026-08-16"]).toBe(undefined);
  });

  // 未来日はまだ達成に数えない。日付が変わってから集計へ入る
  it("明日ぶんの記録は今日の週集計に入らない", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    d.entries["2026-08-17"] = { gym: true };
    const ws = f0.weekStart(new Date("2026-08-17T00:00"));
    const s = f0.weekStats(d, ws, "2026-08-16");
    const gym = s.items.find((it) => it.label === "ジム");
    expect(gym.ok).toBe(0);
    expect(gym.entered).toBe(0);
  });

  it("遡及入力の下限は変わらない(7日前まで)", () => {
    const dom = openLog();
    for (let i = 0; i < 7; i++) nav(dom, -1).click();
    expect(q(dom, ".dateT").textContent).toContain("8/9");
    expect(nav(dom, -1).disabled).toBe(true);
  });
});

describe("PWA v4.18: 水分(お試し)", () => {
  // 実値(ml)で保存する。刻みを変えても過去の記録の意味は動かないので migrate は要らない
  it("500ml刻みの select で、値は ml の実値として保存される", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    const s = q(dom, 'select[data-f="waterMl"]');
    expect(s).not.toBe(null);
    expect(s.value).toBe(""); // 既定値があると未入力と区別できず、推奨量にも見える
    const vals = [...s.options].slice(1).map((o) => Number(o.value));
    expect(vals[0]).toBe(0); // 0ml は正当な記録
    vals.slice(1).forEach((v, i) => expect(v - vals[i]).toBe(500));
    expect(vals[vals.length - 1]).toBe(4000); // 天井は4Lまで取ってある
    s.value = "1500";
    s.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(JSON.parse(dom.window.localStorage.getItem(KEY)).entries[f.fmt(new Date())]).toEqual({ waterMl: 1500 });
  });

  // 当日を指す項目に閾値を置くと、まだ飲み終わっていない日中がずっと未達に見える。
  // 起床時刻・気分・誰と・業務時間と同じ「計測のみ」に揃えてある(schema 18)
  it("達成ラインも達成判定も持たない(計測のみ)", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    const d = f.defaultData();
    expect(d.th.waterMl).toBe(undefined);
    expect(d.targets.waterMl).toBe(undefined);
    // CORE に居ないので achieved は水分について呼ばれない。呼ばれても
    // 起床時刻・業務時間と同じ落ち方(真偽値でないので false)をするだけで、達成は作らない
    expect(f.CORE.some((c) => c.id === "waterMl")).toBe(false);
    expect(f.achieved(d, { waterMl: 2500 }, "waterMl")).toBe(f.achieved(d, { wakeMin: 390 }, "wakeMin"));
    byText(dom, "button.tb", "設定").click();
    expect(q(dom, '[data-th="waterMl"]')).toBe(null);
    // 表示トグルは残す。消すと項目自体を隠せなくなる
    expect(q(dom, '[data-tog="waterMl"]')).not.toBe(null);
  });

  it("週タブ・週の目標・月間ビューに水分が出ない", () => {
    const dom = boot();
    byText(dom, "button.tb", "週").click();
    expect(q(dom, "#view").textContent).not.toContain("水分");
    byText(dom, "button.tb", "推移").click();
    expect(qa(dom, '[data-mon] option').some((o) => o.value === "waterMl")).toBe(false);
    byText(dom, "button.tb", "設定").click();
    expect(qa(dom, "[data-tgt]").some((el) => el.dataset.tgt === "waterMl")).toBe(false);
  });

  it("週報には ml の実値を昇順で渡す", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    const ws = f.weekStart(new Date("2026-08-05T00:00"));
    const day = (n) => f.fmt(new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + n));
    d.entries[day(0)] = { waterMl: 2500 };
    d.entries[day(1)] = { waterMl: 0 };
    const s = f.weekStats(d, ws, day(6));
    expect(s.waterMl).toEqual([0, 2500]); // 0ml を落とさない
    expect(f.buildReviewText(d, day(6))).toContain("waterMl");
  });

  it("水分を持たない旧データも読め、表示トグルだけ既定値で埋まる", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({ version: 12, targets: { gym: 4 }, entries: { "2026-08-01": { gym: true } } });
    expect(m.version).toBe(CURRENT_SCHEMA);
    expect(m.enabled.waterMl).toBe(true);
    expect(m.targets.waterMl).toBe(undefined);
    expect(m.th.waterMl).toBe(undefined);
    expect(m.targets.gym).toBe(4);
  });
});

// 水は1日かけて飲むので、翌朝まとめて思い出せない。前日を指したままだと、今日ぶんを
// 入れるのに明日の画面へ動く必要があった(実際に翌日ぶんのエントリへ入力されていた)
describe("PWA v4.18: 水分を当日へ移す(v18)", () => {
  const cardTitles = (dom) => qa(dom, ".card .ctitle").map((el) => el.textContent);

  it("水分は「今日の水分」カードに出て、「昨日」カードには出ない", () => {
    const dom = boot();
    expect(cardTitles(dom)).toContain("今日の水分");
    const yday = qa(dom, ".card").find((el) => el.textContent.includes("昨日"));
    expect(yday.textContent).not.toContain("水分");
    expect(yday.querySelector('[data-f="waterMl"]')).toBe(null);
    const water = qa(dom, ".card").find((el) => el.textContent.includes("今日の水分"));
    expect(water.querySelector('select[data-f="waterMl"]')).not.toBe(null);
  });

  // 上3枚は「今夜/明日の朝/今日」に切り替わるのに、当日カードだけ「今日の〜」のままだった。
  // どの日に入れているか迷わないための変更なので、見出しが指す時点とずれたままにしない
  it("明日ぶんを開くと当日カードの見出しが「明日の〜」になる", () => {
    const dom = boot();
    const titles = () => qa(dom, "#view .card .ctitle").map((el) => el.textContent);
    expect(titles()).toEqual(["昨夜", "今朝", "昨日", "今日の水分", "今日の食事", "今日のサプリ", "今日の気分"]);
    qa(dom, "[data-dn]").find((b) => b.dataset.dn === "1").click();
    expect(titles()).toEqual(["今夜", "明日の朝", "今日", "明日の水分", "明日の食事", "明日のサプリ", "明日の気分"]);
  });

  it("今日の画面のまま今日ぶんが保存される", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    const s = q(dom, 'select[data-f="waterMl"]');
    s.value = "1500";
    s.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    const e = JSON.parse(dom.window.localStorage.getItem(KEY)).entries;
    expect(e[f.fmt(new Date())]).toEqual({ waterMl: 1500 });
  });

  it("旧データの水分を1日前へ移す", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({
      version: 17,
      entries: {
        "2026-08-17": { waterMl: 1500 },
        "2026-08-18": { waterMl: 2000, gym: true },
        "2026-08-19": { gym: false },
        "2026-08-20": { waterMl: 1000 },
      },
    });
    expect(m.entries["2026-08-16"]).toEqual({ waterMl: 1500 });
    expect(m.entries["2026-08-17"]).toEqual({ waterMl: 2000 });
    expect(m.entries["2026-08-18"]).toEqual({ gym: true });
    expect(m.entries["2026-08-19"]).toEqual({ gym: false, waterMl: 1000 });
    // 水分だけの日は移送で空になる。空のまま残すと「記録した日」として数えられてしまう
    expect("2026-08-20" in m.entries).toBe(false);
    expect(m.th.waterMl).toBe(undefined);
    expect(m.targets.waterMl).toBe(undefined);
  });

  it("同じJSONを二度通しても二重に動かない", () => {
    const f = boot().window.__flourish;
    const src = { version: 17, entries: { "2026-08-18": { waterMl: 2000 } } };
    const once = f.migrate(JSON.parse(JSON.stringify(src)));
    const twice = f.migrate(JSON.parse(JSON.stringify(src)));
    expect(twice.entries).toEqual(once.entries);
    // 移行済みを読み直しても動かない(版で止まる)
    expect(f.migrate(JSON.parse(JSON.stringify(once))).entries).toEqual(once.entries);
  });

  it("入力オブジェクトを書き換えない", () => {
    const f = boot().window.__flourish;
    const src = { version: 17, entries: { "2026-08-18": { waterMl: 2000 } } };
    const snap = JSON.stringify(src);
    f.migrate(src);
    expect(JSON.stringify(src)).toBe(snap);
  });

  it("汚れた値と日付でないキーは動かさず素通しする", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({
      version: 17,
      entries: { "2026-08-18": { waterMl: "x", gym: true }, "bad-key": { waterMl: 900 } },
    });
    expect(m.entries["2026-08-18"]).toEqual({ waterMl: "x", gym: true });
    expect(m.entries["bad-key"]).toEqual({ waterMl: 900 });
    expect(m.entries["2026-08-17"]).toBe(undefined);
  });

  // 「1日2L」は俗説なので外部基準は持ち込ませない。ただし水分は本人の行動なので、
  // 業務時間と同じ「多い少ないを評価しないで」で括ると事実の提示まで止まってしまう
  it("週報テキストは水分の事実提示を許し、外部基準だけを禁じる", () => {
    const f = boot().window.__flourish;
    const t = f.buildReviewText(f.defaultData(), "2026-08-17");
    expect(t).toContain("水分も目標を持たない計測のみ");
    expect(t).toContain("分布を事実として述べるのは構いません");
    expect(t).toContain("1日2L");
    // 業務時間側の「多い少ないを評価しないでください」に水分を巻き込まない
    expect(t).not.toContain("業務時間と仕事の重さと水分");
  });
});

describe("PWA v4.7: 仕事の文脈(業務時間・仕事の重さ)", () => {
  // これまで記録していたのは結果ばかりで、それを動かす外的要因が1つも無かった。
  // 「なぜそうなったか」に届かせるための説明変数なので、達成すべき行動ではない
  it("どちらも目標も達成ラインも持たない(計測のみ)", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    ["workMin", "workLoad"].forEach((id) => {
      expect(d.enabled[id]).toBe(true);
      expect(d.targets[id]).toBe(undefined);
      expect(d.th[id]).toBe(undefined);
      expect(f0.CORE.some((c) => c.id === id)).toBe(false);
    });
    d.entries[f0.fmt(new Date())] = { workMin: 480, workLoad: 2 };
    const dom = boot(JSON.stringify(d));
    byText(dom, "button.tb", "週").click();
    expect(q(dom, "#view").textContent).not.toContain("業務時間");
    expect(q(dom, "#view").textContent).not.toContain("仕事の重さ");
    byText(dom, "button.tb", "設定").click();
    expect(q(dom, '[data-tgt="workMin"]')).toBe(null);
    expect(q(dom, '[data-th="workLoad"]')).toBe(null);
  });

  it("業務時間は30分刻みの実値で、0(休み)も記録できる", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    const s = q(dom, 'select[data-f="workMin"]');
    const vals = [...s.options].slice(1).map((o) => Number(o.value));
    expect(vals[0]).toBe(0); // 休みの日。曜日に頼らず平日/休日が読める
    vals.slice(1).forEach((v, i) => expect(v - vals[i]).toBe(30));
    expect(vals[vals.length - 1]).toBe(840); // 14h まで
    s.value = "0";
    s.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    // 0 は「仕事をしていない」なので重さも「なし」で確定する(下の専用テスト参照)
    expect(JSON.parse(dom.window.localStorage.getItem(KEY)).entries[f.fmt(new Date())]).toEqual({ workMin: 0, workLoad: 0 });
  });

  // 主観尺度の段数は原則変えない。「なし」だけは例外で、尺度の細分化ではなく
  // 「尺度の外の段(その日は仕事をしていない)」の追加(オーナー判断、schema 17)。
  // 疑似精度は増えない。**軽い/普通/重い の3段はこれ以上増やさないこと**
  it("仕事の重さは なし + 3段階で、主観の段は増やさない", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    expect(f.LOAD_OPTS).toEqual(["なし", "軽い", "普通", "重い"]);
    expect(f.LOAD_OPTS.slice(1)).toEqual(["軽い", "普通", "重い"]);
    const btns = qa(dom, '[data-f="workLoad"]');
    expect(btns.map((b) => b.dataset.v)).toEqual(["0", "1", "2", "3"]);
    btns[3].click();
    expect(JSON.parse(dom.window.localStorage.getItem(KEY)).entries[f.fmt(new Date())]).toEqual({ workLoad: 3 });
  });

  // 「なし」は良し悪しの外にある。評価色を付けると「仕事をしない日が達成」に読める。
  // **seg() は選択中のボタンにしか色を付けない。** 未選択のまま見ると全ボタンが "sb" で、
  // colors[0] を on-pine に変えても通ってしまう(実際にそう書いていて素通りした)
  it("「なし」を選んでも評価色が付かない", () => {
    const dom = boot();
    q(dom, '[data-f="workLoad"][data-v="0"]').click();
    const on = q(dom, '[data-f="workLoad"][data-v="0"]');
    expect(on.getAttribute("aria-pressed")).toBe("true"); // 選択されている状態で見ている
    expect(on.className).toContain("on-");               // 何かしら色は付く(付かないなら選択が見えない)
    expect(on.className).not.toContain("on-pine");
    expect(on.className).not.toContain("on-sienna");
    // 対照: 「重い」には注意色が付く(評価色そのものが消えていないことの確認)
    q(dom, '[data-f="workLoad"][data-v="3"]').click();
    expect(q(dom, '[data-f="workLoad"][data-v="3"]').className).toContain("on-sienna");
  });

  // 業務時間0は「仕事をしていない」で確定する。もう1タップ求めない
  it("業務時間を0にすると重さが「なし」になる", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    const s = q(dom, 'select[data-f="workMin"]');
    s.value = "0";
    s.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    const e = JSON.parse(dom.window.localStorage.getItem(KEY)).entries[f.fmt(new Date())];
    expect(e).toEqual({ workMin: 0, workLoad: 0 });
    expect(q(dom, '[data-f="workLoad"][data-v="0"]').getAttribute("aria-pressed")).toBe("true");
  });

  // 無条件に入れると、本人が選んだ値が訂正のついでに黙って置き換わる
  it("既に重さを入れてある日は、業務時間0にしても上書きしない", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    q(dom, '[data-f="workLoad"][data-v="3"]').click();   // 重い
    const s = q(dom, 'select[data-f="workMin"]');
    s.value = "0";
    s.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(JSON.parse(dom.window.localStorage.getItem(KEY)).entries[f.fmt(new Date())])
      .toEqual({ workLoad: 3, workMin: 0 });
  });

  it("0以外を選んだときは重さに触れない", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    q(dom, '[data-f="workLoad"][data-v="2"]').click();
    const s = q(dom, 'select[data-f="workMin"]');
    s.value = "480";
    s.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(JSON.parse(dom.window.localStorage.getItem(KEY)).entries[f.fmt(new Date())])
      .toEqual({ workLoad: 2, workMin: 480 });
  });

  // 台帳が workLoad を1件も持っていない窓のうちに動かした(v7 の歩数と同じ状況)。
  // 端末に残る旧スケールだけは読み替えが要る
  it("旧スケール(軽い0/普通1/重い2)を +1 して読み替える", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({ version: 16, entries: {
      "2026-08-10": { workLoad: 0 }, "2026-08-11": { workLoad: 2 }, "2026-08-12": { gym: true },
    } });
    expect(m.version).toBe(CURRENT_SCHEMA);
    expect(m.entries["2026-08-10"].workLoad).toBe(1); // 軽い
    expect(m.entries["2026-08-11"].workLoad).toBe(3); // 重い
    expect(m.entries["2026-08-12"].workLoad).toBe(undefined);
  });

  it("読み替え済みのデータを二度通しても二重にずれない", () => {
    const f = boot().window.__flourish;
    const once = f.migrate({ version: 16, entries: { "2026-08-10": { workLoad: 2 } } });
    const twice = f.migrate(once);
    expect(twice.entries["2026-08-10"].workLoad).toBe(3);
  });

  it("週報には業務時間の実値と重さの分布を渡し、評価を禁じる注記を付ける", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    const ws = f.weekStart(new Date("2026-08-05T00:00"));
    const day = (n) => f.fmt(new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + n));
    d.entries[day(0)] = { workMin: 600, workLoad: 3 };  // 重い
    d.entries[day(1)] = { workMin: 0, workLoad: 0 };    // なし(仕事をしていない日)
    const s = f.weekStats(d, ws, day(6));
    expect(s.workMin).toEqual([0, 600]);
    // [なし, 軽い, 普通, 重い]。「なし」の日が分布に出ることで、休んだ日と未入力を区別できる
    expect(s.workLoad).toEqual([1, 0, 0, 1]);
    const t = f.buildReviewText(d, day(6));
    expect(t).toContain("workMin");
    expect(t).toContain("多い少ないを評価しないでください");
  });

  // 棚卸しで「ジムに行けない理由は仕事との摩擦」と出た。それを検証できる対を置いてある
  it("相関ヒントに仕事を上流とする対がある", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    for (let i = 0; i < 28; i++) {
      const dt = new Date("2026-07-01T00:00");
      dt.setDate(dt.getDate() + i);
      d.entries[f0.fmt(dt)] = { workLoad: i % 2 === 0 ? 3 : 1, sober: i % 2 !== 0 }; // 重い / 軽い
    }
    const dom = boot(JSON.stringify(d));
    byText(dom, "button.tb", "週報").click();
    const row = qa(dom, "#view .row").find((el) => el.textContent.includes("仕事が重い × 前日に酒を飲んだ"));
    expect(row).not.toBe(undefined);
    expect(row.textContent).toContain("φ=1.00");
  });

  it("仕事の項目を持たない旧データも既定値で埋まる", () => {
    const f = boot().window.__flourish;
    const m = f.migrate({ version: 14, entries: { "2026-08-01": { gym: true } } });
    expect(m.version).toBe(CURRENT_SCHEMA);
    expect(m.enabled.workMin).toBe(true);
    expect(m.enabled.workLoad).toBe(true);
    expect(m.targets.workMin).toBe(undefined);
  });
});

describe("PWA v4.7: 歩数の実値化(v16)", () => {
  it("1000歩刻みの select で、値は歩数の実値として保存される", () => {
    const dom = boot();
    const f = dom.window.__flourish;
    const s = q(dom, 'select[data-f="stepsCount"]');
    expect(s).not.toBe(null);
    expect(s.value).toBe("");
    const vals = [...s.options].slice(1).map((o) => Number(o.value));
    expect(vals[0]).toBe(0);
    vals.slice(1).forEach((v, i) => expect(v - vals[i]).toBe(1000));
    expect(vals[vals.length - 1]).toBe(20000); // 天井は20000歩まで
    // 「2千」ではなく歩数そのままで読ませる。最上段だけは上限ではなく「これ以上」
    const labels = [...s.options].slice(1).map((o) => o.textContent);
    expect(labels[0]).toBe("0歩");
    expect(labels[2]).toBe("2000歩");
    expect(labels[labels.length - 1]).toBe("20000歩以上");
    expect(labels.slice(0, -1).some((l) => l.includes("以上"))).toBe(false);
    pickMin(dom, "stepsCount", "12000");
    expect(JSON.parse(dom.window.localStorage.getItem(KEY)).entries[f.fmt(new Date())]).toEqual({ stepsCount: 12000 });
  });

  // 実値になったので、刻みを変えても過去の記録の意味は動かない = migrate が要らない
  it("推移タブのY軸が実値の目盛りになり、最上段の点が枠に収まる", () => {
    const f0 = boot().window.__flourish;
    const d = f0.defaultData();
    d.entries[f0.fmt(new Date())] = { stepsCount: 20000 };
    const dom = boot(JSON.stringify(d));
    byText(dom, "button.tb", "推移").click();
    const card = qa(dom, ".card").find((el) => el.textContent.includes("歩数("));
    expect(card.textContent).toContain("20000歩");
    const cys = [...card.querySelectorAll("circle")].map((c) => +c.getAttribute("cy"));
    expect(cys.length).toBe(1);
    cys.forEach((cy) => {
      expect(cy).toBeGreaterThanOrEqual(8);
      expect(cy).toBeLessThanOrEqual(130);
    });
  });

  it("週報には歩数の実値を昇順で渡す", () => {
    const f = boot().window.__flourish;
    const d = f.defaultData();
    const ws = f.weekStart(new Date("2026-08-05T00:00"));
    const day = (n) => f.fmt(new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + n));
    d.entries[day(0)] = { stepsCount: 12000 };
    d.entries[day(1)] = { stepsCount: 0 };
    expect(f.weekStats(d, ws, day(6)).stepsCount).toEqual([0, 12000]);
  });
});
