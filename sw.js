/**
 * Service Worker — アプリ本体を端末にキャッシュして、電波ゼロでも起動できるようにする。
 *
 * 中身を更新したら CACHE 名の版数を必ず上げること。
 * 上げ忘れると iPad 側に古い画面が残り続ける。
 */
var CACHE = 'onozaki-event-pos-v5';
var ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  // GAS中継への通信はキャッシュしない（常にネットワーク）
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // アプリ本体は cache-first。オフラインでも確実に起動させることを最優先する。
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) {
        // 裏でこっそり更新を取りに行く（次回起動時に反映）
        fetch(req).then(function (res) {
          if (res && res.ok) caches.open(CACHE).then(function (c) { c.put(req, res.clone()); });
        }).catch(function () { });
        return hit;
      }
      return fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match('./index.html');
      });
    })
  );
});
