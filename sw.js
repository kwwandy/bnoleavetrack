/*
 * sw.js — 簡單嘅 cache-first service worker,俾 app 可以離線使用。
 * 如果要更新 app 版本,記得改 CACHE_NAME(例如 v2),先會強制更新快取。
 */
const CACHE_NAME = 'bno-tracker-v3';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/theme.js',
  './js/dates.js',
  './js/calc.js',
  './js/db.js',
  './js/pdf.js',
  './js/app.js',
  './js/lib/jspdf.umd.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // index.html(navigation):優先用網絡,失敗先用快取,確保有新版時盡量攞到最新
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', clone));
          return resp;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // 其他靜態資源:cache-first
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return resp;
      });
    })
  );
});
