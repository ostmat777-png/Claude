// Хранилище на телефоне (IndexedDB): поиски, отметки, кэш ответов OSM. Работает и в окне, и в фоновом потоке.
const DB = 'zabroshki';
const VER = 1;
let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('runs')) d.createObjectStore('runs', { keyPath: 'id', autoIncrement: true });
      if (!d.objectStoreNames.contains('labels')) d.createObjectStore('labels', { keyPath: 'id', autoIncrement: true });
      if (!d.objectStoreNames.contains('cache')) d.createObjectStore('cache');
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    };
    r.onsuccess = () => { _db = r.result; res(_db); };
    r.onerror = () => rej(r.error);
  });
}
function tx(store, mode, fn) {
  return open().then((d) => new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const store = {
  async put(name, value, key) { return tx(name, 'readwrite', (s) => req(key === undefined ? s.put(value) : s.put(value, key))); },
  async get(name, key) { return tx(name, 'readonly', (s) => req(s.get(key))); },
  async all(name) { return tx(name, 'readonly', (s) => req(s.getAll())); },
  async del(name, key) { return tx(name, 'readwrite', (s) => req(s.delete(key))); },
  async clear(name) { return tx(name, 'readwrite', (s) => req(s.clear())); },
};

// кэш ответов Overpass на 14 дней
const TTL = 14 * 86400e3;
export async function cacheGet(key) {
  try {
    const v = await store.get('cache', key);
    if (v && Date.now() - v.t < TTL) return v.d;
  } catch (e) { /* нет места / приватный режим — просто без кэша */ }
  return null;
}
export async function cachePut(key, d) {
  try { await store.put('cache', { t: Date.now(), d }, key); } catch (e) { /* переполнение — не страшно */ }
}
