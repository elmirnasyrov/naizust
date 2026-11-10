// Наизусть: service worker. Хранит файлы приложения в телефоне, чтобы оно открывалось без интернета.
//
// ВАЖНО: при КАЖДОЙ выкладке повышать VERSION (v1 → v2 → v3 ...)
// и держать в SHELL те же ?v=, что в index.html. Иначе телефон может показать старую версию.
const VERSION = 'v1';

const CACHE = 'naizust-' + VERSION;
const FONTS = 'naizust-fonts';
const SHELL = [
  './',
  'index.html',
  'style.css?v=10',
  'app.js?v=10',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];

// Установка: сразу складываем файлы приложения в хранилище телефона
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

// Включение новой версии: удаляем хранилища старых версий
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(k => k.startsWith('naizust-') && k !== CACHE && k !== FONTS)
        .map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Свои файлы: сначала сеть (всегда свежая версия), без сети — из хранилища
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Шрифты Google: один раз скачали — дальше берём из хранилища
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(caches.open(FONTS).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      c.put(req, res.clone());
      return res;
    }));
  }
  // Остальное (поиск песен, YouTube) идёт в интернет как обычно
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req, { ignoreSearch: true })
    || (req.mode === 'navigate' ? await cache.match('index.html') : undefined);
  try {
    // Плохая связь: если сеть молчит дольше 4 секунд, а копия есть, открываем копию
    const net = fetch(req).then(res => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    net.catch(() => {}); // ошибку сети обработаем ниже, без шума в консоли
    if (!cached) return await net;
    return await Promise.race([net, new Promise(r => setTimeout(() => r(cached), 4000))]);
  } catch (e) {
    if (cached) return cached;
    throw e;
  }
}
