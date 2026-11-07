// Service worker «Заброшек»:
// 1) оболочка приложения хранится на телефоне — открывается без сети (сохранённые поиски, отметки);
// 2) фоновая загрузка данных OSM (Background Fetch, Chrome/Яндекс/Samsung на Android): браузер качает, даже если
//    приложение закрыто; здесь готовые ответы складываются в кэш на телефоне (IndexedDB, те же ключи, что у поиска),
//    а уведомление сообщает, что можно открыть и посмотреть результат.
const VERSION = 'zabroshki-v3';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'core.js', 'store.js', 'worker.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png', 'vendor/leaflet/images/marker-icon.png', 'vendor/leaflet/images/marker-shadow.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;   // внешние запросы — как обычно
  // свои файлы: сначала сеть (чтобы обновления приходили), без сети — из кэша
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
});

/* ---------------------------------------------------------------- IndexedDB (та же схема, что в store.js) */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('zabroshki', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const [n, o] of [['runs', { keyPath: 'id', autoIncrement: true }], ['labels', { keyPath: 'id', autoIncrement: true }], ['cache'], ['kv']]) {
        if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, o);
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbPut(store, key, value) {
  const d = await idb();
  await new Promise((res, rej) => { const t = d.transaction(store, 'readwrite'); t.objectStore(store).put(value, key); t.oncomplete = res; t.onerror = () => rej(t.error); });
}
async function idbGet(store, key) {
  const d = await idb();
  return new Promise((res, rej) => { const r = d.transaction(store).objectStore(store).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function sha1(s) {
  const b = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/* ---------------------------------------------------------------- фоновая загрузка */
async function storeRecords(reg) {
  const records = await reg.matchAll();
  let ok = 0;
  for (const rec of records) {
    try {
      const resp = await rec.responseReady;
      if (!resp || !resp.ok) continue;
      const txt = await resp.text();
      if (!txt.trimStart().startsWith('{')) continue;
      const d = JSON.parse(txt);
      const rem = d.remark || '';
      if (rem.includes('runtime error') || rem.includes('timed out')) continue;   // докачает приложение
      const q = new URL(rec.request.url).searchParams.get('data');
      await idbPut('cache', 'ovp:' + await sha1(q), { t: Date.now(), d: d.elements || [] });
      ok++;
    } catch (e) { /* этот кусок докачает приложение */ }
  }
  return [ok, records.length];
}
async function finish(event, success) {
  const reg = event.registration;
  const [ok, total] = await storeRecords(reg);
  const p = (await idbGet('kv', 'pending')) || {};
  if (p.bgId === reg.id) await idbPut('kv', 'pending', { ...p, status: 'downloaded', ok, total, ts: Date.now() });
  const title = ok === total ? 'Заброшки: данные скачаны — нажмите, чтобы показать результат'
    : `Заброшки: скачано ${ok} из ${total} — нажмите, программа докачает остальное`;
  try { await event.updateUI({ title }); } catch (e) { /* уже обновлено */ }
}
self.addEventListener('backgroundfetchsuccess', (e) => e.waitUntil(finish(e, true)));
self.addEventListener('backgroundfetchfail', (e) => e.waitUntil(finish(e, false)));
self.addEventListener('backgroundfetchabort', (e) => e.waitUntil((async () => {
  const p = (await idbGet('kv', 'pending')) || {};
  if (p.bgId === e.registration.id) await idbPut('kv', 'pending', { ...p, status: 'aborted' });
})()));
self.addEventListener('backgroundfetchclick', (e) => e.waitUntil((async () => {
  const cl = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (cl.length) { cl[0].postMessage({ type: 'bg-click' }); return cl[0].focus(); }
  return self.clients.openWindow('./?resume=1');
})()));
