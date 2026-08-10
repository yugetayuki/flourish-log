---
name: release
description: Aubade を GitHub Pages へリリースする。テストとスモークを通し、バージョン表記を4ファイルで揃え、コミット・push し、Pages に反映されたことを確認するまで。リリース・デプロイ・公開を頼まれたときに使う。
when_to_use: 「リリースして」「デプロイして」「公開して」「バージョンを上げて」と言われたとき
---

出荷物は `index.html` と `sw.js` の2本。`main` に push すると GitHub Pages が数分で反映する。

## 手順

1. **両方のテストを通す。** 片方でも赤なら中断してオーナーに報告する。
   ```bash
   npm test        # vitest
   npm run smoke   # 実ブラウザ(Chromium)
   ```
2. **下の一覧の版表記をすべて上げる（4ファイル）。** 1つでも食い違うと実機で反映確認ができなくなる。
   - `index.html` のヘッダー eyebrow（`DAWN LOG · vX.Y`）
   - `index.html` 設定タブ末尾の `.foot` 内の版表記
   - `package.json` の `version`
   - `package-lock.json` の `version`（先頭とその直下の2箇所）
   - `sw.js` の `CACHE`（`aubade-vX.Y`）。上げないと `activate` の古いキャッシュ掃除が働かない。
     ネットワーク優先なので表示が古くなることはないが、消えないキャッシュが残る
3. **CLAUDE.md を更新する。** 冒頭の現行バージョン、テスト本数、変更した不変条件。
4. **コミットして push する。** メッセージは共通規約の形式に従い、本文に「なぜ」を書く。
5. **Pages への反映を確認する。**
   ```bash
   curl -s https://yugetayuki.github.io/flourish-log/ | grep -o 'v2\.[0-9]*' | head -1
   ```
   反映まで数分かかる。古い版が返るあいだは間隔を空けて再確認する。
6. **オーナーに実機確認を依頼する。** ここから先はこちらでは実行できない。
   - iPhone で公開URLを開き、右上のバージョン表記が上がっていること
   - 1タップして「✓ 保存済み」が出ること

## 変えてはいけないもの

- `localStorage` キー `flourish-log-v2` と退避キーの接頭辞（変えると既存の記録が読めなくなる）
- リポジトリ名と公開URL（変えるとホーム画面に追加済みの PWA が切れる）
- `window.__flourish` テストフック

## CSP を触った場合

`npm run smoke` を必ず回す。JSDOM は CSP を解釈しないので `npm test` では検出できない。
スモークは記録を載せた fetch / XHR / sendBeacon / 画像 / フォームを実際に投げ、受信側への到達が0件であることを確認する。
