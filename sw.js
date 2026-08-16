"use strict";
// Aubade をオフラインでも開けるようにする。出荷物は index.html だけなので、抱えるのもそれだけ。
//
// 方式はネットワーク優先。通信できるときは必ずネットワークを先に見て、失敗したときだけ
// キャッシュへ倒す。キャッシュ優先にすると「古いHTMLを掴み続けて版が上がらない」事故が起き、
// Service Worker を入れずにきた理由がそれだったため、速度より更新の確実さを取る。
//
// キャッシュ名にはバージョンを含める。リリース時にここも上げること(手順は .claude/skills/release)。
// 上げ忘れても activate で古い名前を消す仕組みが働かないだけで、ネットワーク優先なので
// 表示が古くなることはない。
var CACHE = "aubade-v4.6";
var SHELL = "./index.html";

self.addEventListener("install", function(e){
  e.waitUntil(
    caches.open(CACHE)
      .then(function(c){ return c.addAll(["./", SHELL]); })
      .then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function(e){
  var req = e.request;
  // 他オリジンには一切触らない。CSP で塞いだ持ち出し経路を Service Worker が迂回しないようにする
  // (Service Worker はページの CSP の外側で動くので、ここで自分から縛っておく必要がある)
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then(function(res){
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function(c){ return c.put(req, copy); })
          .catch(function(err){ console.error("[flourish] キャッシュを更新できませんでした", err); });
      }
      return res;
    }).catch(function(){
      // 通信できないのは想定内(圏外・機内モード)なのでログは出さず、キャッシュへ倒す。
      // 個別に持っていなければ本体を返し、とにかく起動はさせる
      return caches.match(req)
        .then(function(hit){ return hit || caches.match(SHELL); })
        .then(function(res){ return res || Response.error(); });
    })
  );
});
