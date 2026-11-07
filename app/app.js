// Заброшки для телефона: интерфейс. Поиск — app/core.js (в фоновом потоке worker.js), хранение — store.js.
import * as core from './core.js';
import { store, cacheGet, cachePut } from './store.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = { red: '#e5383b', yellow: '#f4c430', green: '#2dc653' };
const GUARD_RU = { red: 'охраняется / закрыто', yellow: 'неясно', green: 'свободный доступ' };
const TYPE_NAMES = { house: 'Дом', industrial: 'Промздание', farm: 'Ферма / с/х', ruins: 'Руины', military: 'Военный объект',
  building: 'Постройка', area: 'Территория', complex: 'Территория / комплекс', unmapped: 'Постройка' };
const MAX_KM2 = 400;

const S = { run: null, cands: [], byKey: new Map(), labels: [], selected: null, guard: { red: true, yellow: true, green: true },
  onlyReliable: true, showMarks: true, release: null, draw: null, worker: null, installEvt: null };

/* ------------------------------------------------------------------ карта */
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const LABELS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
const WAYBACK = 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/{r}/{z}/{y}/{x}';
const WB_CONFIG = 'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json';
const WB_TILEMAP = 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tilemap/{r}/{z}/{y}/{x}';
const ESRI_ATTR = 'Снимки © Esri, Maxar, Earthstar Geographics';

let view = null;
try { view = JSON.parse(localStorage.getItem('view') || 'null'); } catch (e) { /* приватный режим */ }
const map = L.map('map', { zoomControl: false, preferCanvas: true, maxZoom: 20, attributionControl: true })
  .setView(view ? [view[0], view[1]] : [60.71, 28.75], view ? view[2] : 12);
const sat = L.tileLayer(ESRI, { maxZoom: 20, maxNativeZoom: 19, attribution: ESRI_ATTR });
const labels = L.tileLayer(LABELS, { maxZoom: 20, maxNativeZoom: 19, attribution: '© Esri' });
const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, maxNativeZoom: 19, attribution: '© участники OpenStreetMap' });
sat.addTo(map);
const layers = { complexes: L.layerGroup().addTo(map), markers: L.layerGroup().addTo(map), highlight: L.layerGroup().addTo(map),
  marks: L.layerGroup().addTo(map), draw: L.layerGroup().addTo(map), me: L.layerGroup().addTo(map) };
map.on('moveend', () => { const c = map.getCenter(); try { localStorage.setItem('view', JSON.stringify([c.lat, c.lng, map.getZoom()])); } catch (e) { /* ok */ } });

$$('#layerSeg button').forEach((b) => b.addEventListener('click', () => {
  $$('#layerSeg button').forEach((x) => x.classList.toggle('on', x === b));
  [sat, labels, osm].forEach((l) => map.removeLayer(l));
  if (b.dataset.layer === 'osm') osm.addTo(map);
  else { sat.addTo(map); if (b.dataset.layer === 'hyb') labels.addTo(map); }
}));

$('#btnLocate').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Геолокация недоступна');
  navigator.geolocation.getCurrentPosition((p) => {
    const ll = [p.coords.latitude, p.coords.longitude];
    layers.me.clearLayers();
    L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#4d9de0', fillOpacity: 1 }).addTo(layers.me);
    map.setView(ll, Math.max(map.getZoom(), 15));
  }, () => toast('Не удалось определить место (разрешите доступ к геопозиции)'), { enableHighAccuracy: true, timeout: 15000 });
});

/* ------------------------------------------------------------------ нижняя панель */
const sheet = $('#sheet');
const SIZES = ['collapsed', 'half', 'full'];
function setSheet(s) { SIZES.forEach((x) => sheet.classList.toggle(x, x === s)); }
$('#handle').addEventListener('click', () => { const i = SIZES.findIndex((x) => sheet.classList.contains(x)); setSheet(SIZES[(i + 1) % 3]); });
let y0 = null;
$('#handle').addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
$('#handle').addEventListener('touchend', (e) => {
  if (y0 == null) return;
  const dy = e.changedTouches[0].clientY - y0; y0 = null;
  const i = SIZES.findIndex((x) => sheet.classList.contains(x));
  if (dy < -30) setSheet(SIZES[Math.min(2, i + 1)]); else if (dy > 30) setSheet(SIZES[Math.max(0, i - 1)]);
});
function showTab(t) {
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  $$('.tab').forEach((x) => x.classList.toggle('on', x.id === 'tab-' + t));
  if (sheet.classList.contains('collapsed')) setSheet('half');
  if (t === 'runs') renderRuns();
  if (t === 'more') renderMore();
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

/* ------------------------------------------------------------------ область и поиск */
function km2(poly) {
  const r = poly.rings[0];
  const lat0 = r.reduce((s, p) => s + p[1], 0) / r.length;
  const kx = 111.32 * Math.cos(lat0 * Math.PI / 180), ky = 110.574;
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] * kx + r[i][0] * kx) * (r[j][1] * ky - r[i][1] * ky);
  return Math.abs(a / 2);
}
function screenArea() {
  const b = map.getBounds();
  const w = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
  return { type: 'Polygon', rings: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}
$('#btnSearch').addEventListener('click', () => startSearch(screenArea()));

$('#btnDraw').addEventListener('click', () => {
  S.draw = [];
  $('#drawBar').classList.remove('hidden');
  setSheet('collapsed');
  renderDraw();
});
map.on('click', (e) => { if (S.draw) { S.draw.push([e.latlng.lng, e.latlng.lat]); renderDraw(); } });
function renderDraw() {
  layers.draw.clearLayers();
  if (!S.draw) return;
  const ll = S.draw.map(([x, y]) => [y, x]);
  if (ll.length >= 3) L.polygon(ll, { color: '#4d9de0', weight: 2, fillOpacity: 0.1 }).addTo(layers.draw);
  else if (ll.length) L.polyline(ll, { color: '#4d9de0', weight: 2 }).addTo(layers.draw);
  ll.forEach((p) => L.circleMarker(p, { radius: 5, color: '#fff', weight: 2, fillColor: '#4d9de0', fillOpacity: 1 }).addTo(layers.draw));
  $('#drawText').textContent = S.draw.length < 3 ? `Нажимайте на карту по углам области (${S.draw.length}/3+)`
    : `Область ~${km2({ rings: [[...S.draw, S.draw[0]]] }).toFixed(1)} км²`;
}
$('#drawUndo').addEventListener('click', () => { S.draw?.pop(); renderDraw(); });
$('#drawCancel').addEventListener('click', () => { S.draw = null; $('#drawBar').classList.add('hidden'); renderDraw(); });
$('#drawDone').addEventListener('click', () => {
  if (!S.draw || S.draw.length < 3) return toast('Нужно хотя бы 3 точки');
  const poly = { type: 'Polygon', rings: [[...S.draw, S.draw[0]]] };
  S.draw = null; $('#drawBar').classList.add('hidden'); renderDraw();
  startSearch(poly);
});

function progress(msg, done, total) {
  $('#pMsg').textContent = msg || 'Поиск…';
  $('#pFill').style.width = total ? `${Math.max(3, Math.round(100 * done / total))}%` : '3%';
}
$('#pCancel').addEventListener('click', () => {
  if (S.bgReg) { S.bgCancel?.(); }
  if (S.worker) { S.worker.terminate(); S.worker = null; }
  S.abort?.abort();
  $('#progress').classList.add('hidden');
  store.del('kv', 'pending').catch(() => {});
  toast('Поиск отменён');
});
$('#pHide').addEventListener('click', () => {
  S.bgHide?.();
  $('#progress').classList.add('hidden');
  toast('Скачивается в фоне. Когда закончится — нажмите на уведомление или откройте приложение.', 6000);
});

async function startSearch(area, opts = {}) {
  const a = km2(area);
  if (a > MAX_KM2) return toast(`Слишком большая область (${a.toFixed(0)} км²). Приблизьте карту до ${MAX_KM2} км² или нарисуйте область.`, 6000);
  if (!opts.resume && a > 150 && !confirm(`Область ${a.toFixed(0)} км². На телефоне это займёт несколько минут и ~${Math.round(a / 20)} МБ трафика. Продолжить?`)) return;
  S.bgCancelled = false;
  $('#progress').classList.remove('hidden');
  $('#pHide').classList.add('hidden');
  $('#pLog').textContent = `Область ${a.toFixed(1)} км². Загружаю данные OpenStreetMap…`;
  progress('Загрузка OSM…', 0, 0);
  const t0 = Date.now();
  try {
    // 1) данные OSM: фоновой загрузкой браузера (можно выйти из приложения), если она есть
    const bg = await backgroundDownload(area, opts);
    if (bg === 'hidden') return;          // качается в фоне, результат покажем, когда вернётесь
    if (bg === 'cancelled') throw new Error('отменено');
    // 2) поиск (всё скачанное — уже на телефоне; что не скачалось — докачается здесь с запасными серверами)
    await store.put('kv', { area, status: 'foreground', ts: Date.now() }, 'pending').catch(() => {});
    await keepAwake(true);
    const res = await runSearch(area);
    const run = { name: runName(res.cands, a), date: new Date().toISOString(), area, km2: a, stats: res.stats, cands: res.cands };
    run.stats.total_s = Math.round((Date.now() - t0) / 1000);
    try { run.id = await store.put('runs', run); } catch (e) { toast('Не удалось сохранить поиск на телефоне — места мало?'); }
    try { localStorage.setItem('lastRun', String(run.id || '')); } catch (e) { /* ok */ }
    await store.del('kv', 'pending').catch(() => {});
    openRun(run);
    $('#progress').classList.add('hidden');
    toast(`Готово: надёжных меток ${run.stats.reliable}`);
  } catch (e) {
    $('#progress').classList.add('hidden');
    if (String(e.message || e) === 'отменено') await store.del('kv', 'pending').catch(() => {});
    else toast('Поиск не удался: ' + (e.message || e) + '. Проверьте интернет и попробуйте ещё раз.', 8000);
  } finally {
    keepAwake(false);
  }
}

/* ---- экран не гаснет, пока идёт поиск на виду (там, где нет фоновой загрузки) */
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !S.wake) S.wake = await navigator.wakeLock.request('screen');
    if (!on && S.wake) { await S.wake.release(); S.wake = null; }
  } catch (e) { S.wake = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.wake === null && !$('#progress').classList.contains('hidden')) keepAwake(true);
});

/* ---- фоновая загрузка данных OSM (Background Fetch: Chrome, Яндекс, Samsung на Android) */
async function bgManager() {
  try {
    if (!('serviceWorker' in navigator) || !('BackgroundFetchManager' in self)) return null;
    const reg = await navigator.serviceWorker.ready;
    return reg.backgroundFetch || null;
  } catch (e) { return null; }
}
async function backgroundDownload(area, opts) {
  const bf = opts.noBg ? null : await bgManager();
  if (!bf) return 'none';
  let reg = null;
  if (opts.bgId) reg = await bf.get(opts.bgId);
  if (!reg) {
    const plan = core.osmPlan(core.areaBbox(area));
    const missing = [];
    for (const it of plan) if (!(await cacheGet(await core.cacheKey(it.q)))) missing.push(it);
    if (!missing.length) return 'cached';
    progress('Проверяю серверы OpenStreetMap…', 0, 0);
    const ok = await core.probeMirrors();
    if (!ok.length) { $('#pLog').textContent = 'Серверы OSM сейчас не отвечают на быструю проверку — пробую обычной загрузкой…'; return 'none'; }
    const best = ok.slice(0, 2).map((m) => m.url);   // нагрузка на два самых быстрых сервера
    const urls = missing.map((it, i) => core.overpassGetUrl(best[i % best.length], it.q));
    const id = 'zab-' + Date.now();
    try {
      reg = await bf.fetch(id, urls, { title: `Заброшки: загрузка данных OSM (${missing.length} запросов)`,
        icons: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }], downloadTotal: 0 });
    } catch (e) { $('#pLog').textContent = 'Фоновая загрузка недоступна (' + e.message + ') — качаю на экране'; return 'none'; }
    await store.put('kv', { area, status: 'running', bgId: id, total: missing.length, ts: Date.now() }, 'pending').catch(() => {});
  }
  return watchBackground(reg);
}
function watchBackground(reg) {
  return new Promise((resolve) => {
    S.bgReg = reg;
    let done = 0, total = 0, settled = false;
    $('#pHide').classList.remove('hidden');
    const show = () => {
      progress(`Скачивается в фоне: ${done} из ${total || '?'} запросов`, done, total);
      $('#pLog').innerHTML = 'Можно выйти из приложения или выключить экран — браузер докачает сам и покажет уведомление. '
        + 'Нажмите на него, когда загрузка закончится.';
    };
    reg.matchAll().then((recs) => {
      total = recs.length; show();
      recs.forEach((r) => r.responseReady.then(() => { done++; show(); }, () => { done++; show(); }));
    });
    const end = async (how) => {
      if (settled) return; settled = true;
      S.bgReg = null;
      $('#pHide').classList.add('hidden');
      if (how === 'cancelled' || how === 'hidden') return resolve(how);
      progress('Сохраняю скачанное…', total, total);
      // ответы складывает service worker; на всякий случай ждём его не дольше 20 с
      for (let i = 0; i < 40; i++) {
        const p = await store.get('kv', 'pending').catch(() => null);
        if (!p || p.status === 'downloaded') break;
        await new Promise((r) => setTimeout(r, 500));
      }
      resolve('done');
    };
    const check = () => { if (reg.result === 'success' || reg.result === 'failure') end('done'); };
    reg.addEventListener('progress', check);
    check();
    // страховка: если браузер не качает (бывает в некоторых браузерах) — отменить и качать на экране
    let lastBytes = -1, lastChange = Date.now();
    const stallMs = S.bgStallMs || 120e3;
    const wd = setInterval(async () => {
      if (settled) return clearInterval(wd);
      if (reg.downloaded !== lastBytes || done > 0 && done !== S._lastDone) { lastBytes = reg.downloaded; S._lastDone = done; lastChange = Date.now(); return; }
      if (document.visibilityState === 'visible' && Date.now() - lastChange > stallMs) {
        clearInterval(wd);
        $('#pLog').textContent = 'Фоновая загрузка в этом браузере не идёт — качаю на экране (не выключайте экран)';
        try { await reg.abort(); } catch (e) { /* ok */ }
        if (!settled) { settled = true; S.bgReg = null; $('#pHide').classList.add('hidden'); resolve('stalled'); }
      }
    }, 3000);
    S.bgHide = () => end('hidden');
    S.bgCancel = async () => { try { await reg.abort(); } catch (e) { /* ok */ } end('cancelled'); };
  });
}
async function resumePending(fromClick) {
  const p = await store.get('kv', 'pending').catch(() => null);
  if (!p || !p.area) return;
  if (p.status === 'aborted') { await store.del('kv', 'pending'); return; }
  if (p.status === 'running' || p.status === 'downloaded') {
    const bf = await bgManager();
    const reg = bf && p.bgId ? await bf.get(p.bgId) : null;
    if (reg && reg.result === '') {      // ещё качается
      if (!fromClick) toast('Поиск ещё скачивается в фоне — показываю прогресс');
      return startSearch(p.area, { resume: true, bgId: p.bgId });
    }
    toast('Данные скачаны — показываю результат');
    return startSearch(p.area, { resume: true, noBg: true });   // недокачанное — обычной загрузкой с делением
  }
  if (p.status === 'foreground' && Date.now() - p.ts < 3 * 86400e3) {
    if (confirm('Прошлый поиск прервался. Продолжить? Уже скачанное заново не качается.')) startSearch(p.area, { resume: true });
    else await store.del('kv', 'pending');
  }
}
navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.type === 'bg-click') resumePending(true); });

function runSearch(area) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker('worker.js', { type: 'module' }); } catch (e) { w = null; }
    if (!w) return mainThreadSearch(area).then(resolve, reject);
    S.worker = w;
    let started = false;
    w.onmessage = (ev) => {
      const m = ev.data;
      started = true;
      if (m.type === 'progress') progress(m.msg, m.done, m.total);
      else if (m.type === 'log') $('#pLog').textContent = m.msg;
      else if (m.type === 'done') { w.terminate(); S.worker = null; resolve({ cands: m.cands, stats: m.stats }); }
      else if (m.type === 'error') { w.terminate(); S.worker = null; reject(new Error(m.msg)); }
    };
    w.onerror = (e) => {   // нет поддержки модулей в фоновом потоке — считаем в основном
      w.terminate(); S.worker = null;
      if (!started) mainThreadSearch(area).then(resolve, reject); else reject(new Error(e.message || 'ошибка'));
    };
    w.postMessage({ type: 'search', area });
  });
}
async function mainThreadSearch(area) {
  S.abort = new AbortController();
  const res = await core.search(area, { signal: S.abort.signal, cacheGet, cachePut, parallel: 2,
    progress: (d, n, msg) => progress(msg, d, n), log: (msg) => { $('#pLog').textContent = msg; } });
  return { stats: res.stats, cands: res.cands.map(core.toPlain) };
}
function runName(cands, a) {
  const cnt = {};
  for (const c of cands) if (c.f.near_place_name) cnt[c.f.near_place_name] = (cnt[c.f.near_place_name] || 0) + 1;
  const top = Object.entries(cnt).sort((x, y) => y[1] - x[1])[0];
  const d = new Date();
  return `${top ? top[0] : 'Поиск'} · ${a < 10 ? a.toFixed(1) : a.toFixed(0)} км² · ${d.toLocaleDateString('ru-RU')}`;
}

/* ------------------------------------------------------------------ результаты */
function openRun(run) {
  S.run = run;
  S.cands = run.cands;
  S.byKey = new Map(run.cands.map((c) => [c.key, c]));
  S.selected = null;
  layers.highlight.clearLayers();
  const st = run.stats || {};
  $('#summary').innerHTML = `<b>${esc(run.name)}</b> — надёжных ${st.reliable ?? '?'}, территорий ${st.complexes ?? 0}` +
    (st.osm_failed && st.osm_failed.length ? ` · <span class="yellow-t">часть данных OSM не загрузилась</span>` : '');
  render();
  showTab('list');
  try {
    const b = L.geoJSON({ type: 'Polygon', coordinates: run.area.rings }).getBounds();
    if (!map.getBounds().intersects(b)) map.fitBounds(b);
  } catch (e) { /* ok */ }
}
function labelAt(lat, lon, r = 15) {
  let best = null, bd = r;
  for (const l of S.labels) {
    const d = Math.hypot((l.lat - lat) * 110574, (l.lon - lon) * 111320 * Math.cos(lat * Math.PI / 180));
    if (d <= bd) { best = l; bd = d; }
  }
  return best;
}
function shownCands() {
  const out = [];
  const cnt = { red: 0, yellow: 0, green: 0 };
  for (const c of S.cands) {
    const lb = labelAt(c.lat, c.lon);
    const mine = lb && lb.label === 1;
    let vis;
    if (S.onlyReliable) vis = (c.f.reliable && !c.f.complex_key) || mine;
    else vis = (c.score >= 0.25 || c.f.reliable || mine) && !c.f.complex_key;
    if (lb && lb.label === 0 && S.onlyReliable) vis = false;
    if (!vis) continue;
    cnt[c.guard] = (cnt[c.guard] || 0) + 1;
    if (!S.guard[c.guard]) continue;
    out.push(c);
  }
  return [out, cnt];
}
function render() {
  layers.markers.clearLayers();
  layers.complexes.clearLayers();
  const [shown, cnt] = shownCands();
  for (const g of ['red', 'yellow', 'green']) $('#c-' + g).textContent = cnt[g] || 0;
  const nrel = S.cands.filter((c) => c.f.reliable && !c.f.complex_key).length;
  $('#shownCount').textContent = `показано ${shown.length} · надёжных ${nrel} · всего найдено ${S.cands.length}`;
  shown.sort((a, b) => a.score - b.score);
  for (const c of shown) {
    if (c.kind === 'complex' && c.footprint) {
      const l = L.geoJSON(c.footprint, { style: { color: COLORS[c.guard], weight: 2, dashArray: '6 5', fillOpacity: 0.08 } });
      l.on('click', () => select(c.key));
      l.addTo(layers.complexes);
    }
    const lb = labelAt(c.lat, c.lon);
    const m = L.circleMarker([c.lat, c.lon], { radius: 6 + 8 * c.score, color: lb ? (lb.label ? '#000' : '#777') : '#fff',
      weight: lb ? 3 : 2, fillColor: COLORS[c.guard] || COLORS.yellow, fillOpacity: 0.9 });
    m.on('click', () => select(c.key));
    m.addTo(layers.markers);
  }
  const list = shown.slice().reverse().slice(0, 300);
  $('#list').innerHTML = list.length ? list.map((c) => {
    const lb = labelAt(c.lat, c.lon);
    return `<div class="item ${S.selected === c.key ? 'sel' : ''}" data-k="${esc(c.key)}"><span class="dot ${c.guard}"></span>
      <span class="sc">${Math.round(c.score * 100)}</span>
      <span class="tt">${esc(TYPE_NAMES[c.kind] || c.kind)} · <span class="muted">${esc(c.title || '')}</span>
      ${lb ? `<span class="lb">${lb.label ? '✔ заброшка' : '✘ не заброшка'}</span>` : ''}</span></div>`;
  }).join('') + (shown.length > 300 ? `<div class="muted small">… и ещё ${shown.length - 300}</div>` : '')
    : `<div class="muted" style="padding:10px">${S.run ? (S.onlyReliable ? 'Надёжных меток здесь нет. Снимите галочку «только надёжные», чтобы увидеть всех кандидатов.' : 'Ничего не найдено.') : 'Поиска ещё не было.'}</div>`;
  $$('#list .item').forEach((el) => el.addEventListener('click', () => select(el.dataset.k, true)));
  renderMarks();
}
$('#onlyReliable').addEventListener('change', (e) => { S.onlyReliable = e.target.checked; render(); });
$('#showMarks').addEventListener('change', (e) => { S.showMarks = e.target.checked; renderMarks(); });
$$('.chip').forEach((ch) => ch.addEventListener('click', () => { S.guard[ch.dataset.g] = !S.guard[ch.dataset.g]; ch.classList.toggle('on', S.guard[ch.dataset.g]); render(); }));

/* ------------------------------------------------------------------ объект */
function select(key, pan) {
  const c = S.byKey.get(key);
  if (!c) return;
  S.selected = key;
  layers.highlight.clearLayers();
  if (c.footprint) L.geoJSON(c.footprint, { style: { color: '#00e5ff', weight: 3, fillOpacity: 0.12 } }).addTo(layers.highlight);
  else L.circleMarker([c.lat, c.lon], { radius: 16, color: '#00e5ff', weight: 3, fill: false }).addTo(layers.highlight);
  if (pan) map.setView([c.lat, c.lon], Math.max(map.getZoom(), 17));
  renderDetail(c);
  showTab('detail');
  $$('#list .item').forEach((el) => el.classList.toggle('sel', el.dataset.k === key));
}
function reasonsHtml(rs) {
  return `<ul class="reasons">${(rs || []).map((r) => `<li><span class="w ${r.w > 0 ? 'pos' : r.w < 0 ? 'neg' : 'neu'}">${r.w > 0 ? '+' : ''}${r.w ? r.w.toFixed(2) : '·'}</span><span>${esc(r.text)}</span></li>`).join('')}</ul>`;
}
function renderDetail(c) {
  const lb = labelAt(c.lat, c.lon);
  const ll = `${c.lat.toFixed(6)}, ${c.lon.toFixed(6)}`;
  const members = (c.f.members || []).map((k) => S.byKey.get(k)).filter(Boolean);
  const tags = Object.entries(c.tags || {}).map(([k, v]) => `${k}=${v}`).join('\n');
  $('#detail').innerHTML = `
    <h3>${esc(TYPE_NAMES[c.kind] || c.kind)}${c.title ? ' — ' + esc(c.title) : ''}</h3>
    <div class="row"><span class="scorebig">${Math.round(c.score * 100)}</span><span class="muted">/ 100</span>
      <span style="flex:1"></span><span class="badge ${c.guard}">${GUARD_RU[c.guard]}</span></div>
    ${c.f.reliable ? '<div class="relbadge">✔ Надёжная метка (тег заброшенности OSM)</div>' : '<div class="muted small">Не надёжная метка: нет тега заброшенности OSM на самом здании или есть противоречие.</div>'}
    ${(c.f.contra || []).length ? `<div class="neg small">Противоречит: ${esc(c.f.contra.join('; '))}</div>` : ''}
    <div class="links">
      <a href="https://yandex.ru/maps/?pt=${c.lon},${c.lat}&z=17&l=sat" target="_blank" rel="noopener">Яндекс</a>
      <a href="https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lon}" target="_blank" rel="noopener">Google</a>
      <a href="geo:${c.lat},${c.lon}?q=${c.lat},${c.lon}">Навигатор</a>
      <a href="https://www.openstreetmap.org/?mlat=${c.lat}&mlon=${c.lon}#map=18/${c.lat}/${c.lon}" target="_blank" rel="noopener">OSM</a>
      <button id="dCopy">⧉ ${ll}</button>
      <button id="dYears">📅 Снимки по годам</button>
    </div>
    <div class="labelbtns">
      <button class="yes ${lb && lb.label === 1 ? 'on' : ''}" id="dYes">Заброшка</button>
      <button class="no ${lb && lb.label === 0 ? 'on' : ''}" id="dNo">Не заброшка</button>
    </div>
    ${members.length ? `<h4>Здания территории (${members.length})</h4>${members.map((m) => `<div class="item" data-k="${esc(m.key)}"><span class="dot ${m.guard}"></span><span class="sc">${Math.round(m.score * 100)}</span><span class="tt">${esc(TYPE_NAMES[m.kind] || m.kind)} · <span class="muted">${esc(m.title)}</span>${m.f.reliable ? ' ✔' : ''}</span></div>`).join('')}` : ''}
    <h4>Почему такой балл</h4>${reasonsHtml(c.reasons)}
    <h4>Охрана</h4>${reasonsHtml(c.guard_reasons)}
    <h4>Сведения и фото</h4><div id="info"><button id="dInfo">Найти в Википедии и на Викискладе</button></div>
    ${tags ? `<h4>Теги OSM</h4><div class="tags">${esc(tags)}</div>` : ''}`;
  $('#dCopy').onclick = () => { navigator.clipboard?.writeText(ll).then(() => toast('Координаты скопированы'), () => toast(ll)); };
  $('#dYears').onclick = () => openDates(c.lat, c.lon);
  $('#dYes').onclick = () => setLabel(c, 1);
  $('#dNo').onclick = () => setLabel(c, 0);
  $('#dInfo').onclick = () => loadInfo(c);
  $$('#detail .item').forEach((el) => el.addEventListener('click', () => select(el.dataset.k, true)));
}

/* ------------------------------------------------------------------ отметки */
async function loadLabels() { try { S.labels = await store.all('labels'); } catch (e) { S.labels = []; } }
async function setLabel(c, label) {
  const old = labelAt(c.lat, c.lon);
  if (old) await store.del('labels', old.id);
  if (!old || old.label !== label) await store.put('labels', { lat: c.lat, lon: c.lon, label, note: c.title || '', ts: Date.now() });
  await loadLabels();
  render();
  renderDetail(c);
}
function renderMarks() {
  layers.marks.clearLayers();
  if (!S.showMarks) return;
  for (const l of S.labels) {
    const icon = L.divIcon({ className: 'mark ' + (l.label ? 'yes' : 'no'), html: l.label ? '★' : '✕', iconSize: [22, 22] });
    const m = L.marker([l.lat, l.lon], { icon });
    m.bindPopup(`<div class="popup">${l.label ? '★ Заброшка' : '✕ Не заброшка'}${l.note ? ' — ' + esc(l.note) : ''}<br><button data-del="${l.id}">удалить отметку</button></div>`);
    m.on('popupopen', (e) => {
      const b = e.popup.getElement().querySelector('button[data-del]');
      if (b) b.onclick = async () => { await store.del('labels', l.id); map.closePopup(); await loadLabels(); render(); };
    });
    m.addTo(layers.marks);
  }
}
map.on('contextmenu', (e) => {   // долгое нажатие на телефоне
  if (S.draw) return;
  const ll = e.latlng;
  const pop = L.popup().setLatLng(ll).setContent(`<div class="popup"><b>${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}</b><br>
    <button id="mmYes">★ Здесь заброшка</button><button id="mmNo">✕ Не заброшка</button><br><button id="mmYears">📅 Снимки по годам</button></div>`).openOn(map);
  setTimeout(() => {
    const send = async (label) => { await store.put('labels', { lat: ll.lat, lon: ll.lng, label, note: '', ts: Date.now() }); map.closePopup(pop); await loadLabels(); render(); };
    $('#mmYes').onclick = () => send(1);
    $('#mmNo').onclick = () => send(0);
    $('#mmYears').onclick = () => { map.closePopup(pop); openDates(ll.lat, ll.lng); };
  }, 0);
});

/* ------------------------------------------------------------------ снимки по годам (Esri Wayback) */
let wbReleases = null;
async function releases() {
  if (wbReleases) return wbReleases;
  const cfg = await (await fetch(WB_CONFIG)).json();
  wbReleases = Object.entries(cfg).map(([k, v]) => ({ r: +k, date: (v.itemTitle.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || '', meta: v.metadataLayerUrl }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  return wbReleases;
}
function lonlatToTile(lon, lat, z) {
  const n = 2 ** z, r = lat * Math.PI / 180;
  return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n)];
}
async function localVersions(lat, lon, z = 17, max = 10) {
  const rels = await releases();
  const pos = new Map(rels.map((x, i) => [x.r, i]));
  const [x, y] = lonlatToTile(lon, lat, z);
  const out = [];
  let i = 0, misses = 0;
  while (i < rels.length && out.length < max) {
    const r = rels[i].r;
    let d = {};
    try { d = await (await fetch(WB_TILEMAP.replace('{r}', r).replace('{z}', z).replace('{y}', y).replace('{x}', x))).json(); } catch (e) { d = {}; }
    if (d.data && d.data[0]) {
      const s = d.select ? d.select[0] : r;
      if (!out.includes(s)) out.push(s);
      i = Math.max(i, pos.get(s) ?? i) + 1; misses = 0;
    } else { misses++; i++; if (misses >= 3) break; }
  }
  return out;
}
async function captureDate(rel, lat, lon, z = 17) {
  if (!rel.meta) return null;
  const layer = Math.max(0, Math.min(13, 23 - z));
  try {
    const u = `${rel.meta}/${layer}/query?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=SRC_DATE&returnGeometry=false&f=json`;
    const d = await (await fetch(u)).json();
    const s = String(d.features?.[0]?.attributes?.SRC_DATE || '');
    return s.length >= 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
  } catch (e) { return null; }
}
function setRelease(r, label) {
  S.release = r;
  sat.setUrl(r ? WAYBACK.replace('{r}', r) : ESRI);
  sat.options.maxNativeZoom = r ? 18 : 19;
  if (!map.hasLayer(sat)) $('#layerSeg button[data-layer=sat]').click();
  $('#dateBadge').textContent = r ? '📅 ' + label : '';
  $('#dateBadge').classList.toggle('hidden', !r);
}
$('#dateBadge').addEventListener('click', () => setRelease(null));
async function openDates(lat, lon) {
  const c = map.getCenter();
  lat = lat ?? c.lat; lon = lon ?? c.lng;
  showTab('detail');
  const box = document.createElement('div');
  box.innerHTML = `<h3>Снимки по годам</h3><div class="muted small">Архив Esri Wayback. Нажмите дату — карта покажет снимок того времени
    (жёлтая плашка вверху — вернуть текущий).</div><h4>Реальные даты съёмки здесь</h4><div class="dates" id="dLocal"><span class="muted small">ищу…</span></div>
    <h4>По годам (последний выпуск архива за год)</h4><div class="dates" id="dYearsList"></div>
    <div class="row" style="margin-top:10px"><button id="dNow">Текущий снимок</button></div>`;
  $('#detail').replaceChildren(box);
  map.setView([lat, lon], Math.max(map.getZoom(), 16));
  $('#dNow').onclick = () => setRelease(null);
  let rels;
  try { rels = await releases(); } catch (e) { $('#dLocal').textContent = 'Архив недоступен — нет интернета?'; return; }
  const byYear = new Map();
  for (const r of rels) { const y = r.date.slice(0, 4); if (y && !byYear.has(y)) byYear.set(y, r); }
  $('#dYearsList').innerHTML = [...byYear.entries()].map(([y, r]) => `<button data-r="${r.r}" data-l="${y} (выпуск ${r.date})">${y}</button>`).join('');
  const bind = () => $$('#detail .dates button').forEach((b) => b.onclick = () => {
    $$('#detail .dates button').forEach((x) => x.classList.toggle('on', x === b));
    setRelease(+b.dataset.r, b.dataset.l);
  });
  bind();
  try {
    const vers = await localVersions(lat, lon);
    const rows = [];
    const seen = new Set();
    for (const v of vers) {
      const rel = rels.find((x) => x.r === v);
      const d = await captureDate(rel, lat, lon) || ('выпуск ' + rel.date);
      if (seen.has(d)) continue;
      seen.add(d);
      rows.push(`<button data-r="${v}" data-l="снимок ${d}">${d}</button>`);
    }
    $('#dLocal').innerHTML = rows.join('') || '<span class="muted small">разных снимков здесь не найдено</span>';
    bind();
  } catch (e) { $('#dLocal').textContent = 'Не удалось получить даты'; }
}
$('#btnDate').addEventListener('click', () => openDates());

/* ------------------------------------------------------------------ сведения (Википедия, Викисклад) */
async function loadInfo(c) {
  const box = $('#info');
  box.innerHTML = '<span class="muted small">ищу…</span>';
  const out = [];
  try {
    const g = await (await fetch(`https://ru.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${c.lat}|${c.lon}&gsradius=300&gslimit=5&format=json&origin=*`)).json();
    const pages = g.query?.geosearch || [];
    if (pages.length) {
      const ids = pages.map((p) => p.pageid).join('|');
      const ex = await (await fetch(`https://ru.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&exchars=600&pageids=${ids}&format=json&origin=*`)).json();
      for (const p of pages) {
        const e = ex.query?.pages?.[p.pageid]?.extract || '';
        out.push(`<div style="margin:6px 0"><a href="https://ru.wikipedia.org/?curid=${p.pageid}" target="_blank" rel="noopener"><b>${esc(p.title)}</b></a>
          <span class="muted small">~${Math.round(p.dist)} м</span><div class="small">${esc(e)}</div></div>`);
      }
    }
  } catch (e) { out.push('<div class="muted small">Википедия недоступна</div>'); }
  try {
    const d = await (await fetch(`https://commons.wikimedia.org/w/api.php?action=query&generator=geosearch&ggscoord=${c.lat}|${c.lon}&ggsradius=150&ggsnamespace=6&ggslimit=12&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=360&format=json&origin=*`)).json();
    const ph = Object.values(d.query?.pages || {}).map((p) => p.imageinfo?.[0]).filter((i) => i && i.thumburl);
    if (ph.length) {
      out.push(`<div class="photos">${ph.map((i) => {
        const a = (i.extmetadata?.Artist?.value || '').replace(/<[^>]+>/g, '').slice(0, 40);
        const lic = i.extmetadata?.LicenseShortName?.value || '';
        return `<figure><img src="${esc(i.thumburl)}" data-big="${esc(i.thumburl)}" data-cap="${esc(a + ' · ' + lic)}" loading="lazy" alt=""><figcaption><a href="${esc(i.descriptionurl)}" target="_blank" rel="noopener">${esc(a || 'Викисклад')}</a> · ${esc(lic)}</figcaption></figure>`;
      }).join('')}</div>`);
    }
  } catch (e) { out.push('<div class="muted small">Викисклад недоступен</div>'); }
  const t = c.tags || {};
  if (t.wikipedia) { const [lang, title] = t.wikipedia.includes(':') ? t.wikipedia.split(':') : ['ru', t.wikipedia];
    out.unshift(`<div><a href="https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}" target="_blank" rel="noopener">Статья из тега OSM: ${esc(title)}</a></div>`); }
  out.push(`<div class="links"><a href="https://www.google.com/search?q=${encodeURIComponent((c.title || 'заброшка') + ' ' + c.lat.toFixed(4) + ' ' + c.lon.toFixed(4))}" target="_blank" rel="noopener">Поиск в интернете</a>
    <a href="https://wikimapia.org/#lat=${c.lat}&lon=${c.lon}&z=17" target="_blank" rel="noopener">Wikimapia</a></div>`);
  box.innerHTML = out.join('') || '<span class="muted small">Ничего не найдено</span>';
  box.querySelectorAll('img[data-big]').forEach((im) => im.onclick = () => {
    $('#bigimg img').src = im.dataset.big; $('#bigimg .cap').textContent = im.dataset.cap; $('#bigimg').classList.remove('hidden');
  });
}
$('#bigimg').addEventListener('click', () => $('#bigimg').classList.add('hidden'));

/* ------------------------------------------------------------------ сохранённые поиски и выгрузка */
async function renderRuns() {
  let runs = [];
  try { runs = await store.all('runs'); } catch (e) { /* ok */ }
  runs.sort((a, b) => (a.date < b.date ? 1 : -1));
  $('#runs').innerHTML = runs.length ? runs.map((r) => `<div class="run"><span class="t">${esc(r.name)}<br><span class="muted small">надёжных ${r.stats?.reliable ?? '?'}, ${r.stats?.total_s ?? '?'} с</span></span>
    <button data-open="${r.id}">Открыть</button><button data-del="${r.id}">✕</button></div>`).join('')
    : '<div class="muted">Сохранённых поисков пока нет.</div>';
  $$('#runs button[data-open]').forEach((b) => b.onclick = async () => openRun(await store.get('runs', +b.dataset.open)));
  $$('#runs button[data-del]').forEach((b) => b.onclick = async () => { if (confirm('Удалить этот поиск с телефона?')) { await store.del('runs', +b.dataset.del); renderRuns(); } });
}
function xmlEsc(s) { return esc(s); }
function exportText(fmt, items) {
  const name = (c) => `${Math.round(c.score * 100)} ${TYPE_NAMES[c.kind] || c.kind}${c.title ? ' — ' + c.title : ''}`;
  const desc = (c) => `Балл ${Math.round(c.score * 100)}/100; охрана: ${GUARD_RU[c.guard]}; ` + (c.reasons || []).slice(0, 4).map((r) => r.text).join('; ');
  if (fmt === 'geojson') {
    return JSON.stringify({ type: 'FeatureCollection', features: items.map((c) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
      properties: { score: c.score, guard: c.guard, type: c.kind, title: c.title, reliable: !!c.f.reliable, reasons: c.reasons, tags: c.tags } })) }, null, 1);
  }
  if (fmt === 'csv') {
    const rows = [['lat', 'lon', 'score', 'guard', 'type', 'title', 'reliable', 'reasons']].concat(items.map((c) => [c.lat.toFixed(6), c.lon.toFixed(6),
      c.score.toFixed(3), GUARD_RU[c.guard], TYPE_NAMES[c.kind] || c.kind, c.title, c.f.reliable ? 'да' : 'нет', (c.reasons || []).map((r) => r.text).join('; ')]));
    return '﻿' + rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
  }
  if (fmt === 'gpx') {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Заброшки" xmlns="http://www.topografix.com/GPX/1/1">\n` +
      items.map((c) => `<wpt lat="${c.lat.toFixed(7)}" lon="${c.lon.toFixed(7)}"><name>${xmlEsc(name(c))}</name><desc>${xmlEsc(desc(c))}</desc></wpt>`).join('\n') + '\n</gpx>';
  }
  const col = { red: 'ff3b38e5', yellow: 'ff30c4f4', green: 'ff53c62d' };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Заброшки</name>` +
    Object.entries(col).map(([g, c]) => `<Style id="${g}"><IconStyle><color>${c}</color><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>`).join('') +
    items.map((c) => `<Placemark><name>${xmlEsc(name(c))}</name><styleUrl>#${c.guard}</styleUrl><description>${xmlEsc(desc(c))}</description><Point><coordinates>${c.lon.toFixed(7)},${c.lat.toFixed(7)},0</coordinates></Point></Placemark>`).join('') +
    '</Document></kml>';
}
async function saveFile(text, filename, mime) {
  const file = new File([text], filename, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
$$('[data-exp]').forEach((b) => b.addEventListener('click', () => {
  if (!S.run) return toast('Сначала выполните или откройте поиск');
  const fmt = b.dataset.exp;
  const [items] = shownCands();
  const mime = { kml: 'application/vnd.google-earth.kml+xml', gpx: 'application/gpx+xml', geojson: 'application/geo+json', csv: 'text/csv' }[fmt];
  saveFile(exportText(fmt, items), `zabroshki_${new Date().toISOString().slice(0, 10)}.${fmt}`, mime);
}));
$('#btnExportMarks').addEventListener('click', () => {
  if (!S.labels.length) return toast('Отметок пока нет: долгое нажатие на карту или кнопки «Заброшка / Не заброшка»');
  const items = S.labels.map((l) => ({ lat: l.lat, lon: l.lon, score: l.label, guard: l.label ? 'green' : 'yellow', kind: 'building',
    title: (l.label ? 'Заброшка' : 'Не заброшка') + (l.note ? ': ' + l.note : ''), reasons: [], f: {} }));
  saveFile(exportText('gpx', items), 'zabroshki_otmetki.gpx', 'application/gpx+xml');
});
$('#btnClearCache').addEventListener('click', async () => { await store.clear('cache'); toast('Кэш OSM очищен'); renderMore(); });

async function renderMore() {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('#installBox').innerHTML = standalone ? '<div class="muted small">Приложение установлено на телефон.</div>'
    : S.installEvt ? '<div class="install">Установите как приложение: значок на главном экране, работает без адресной строки.<br><button id="btnInstall" class="primary">Установить</button></div>'
      : isIOS ? '<div class="install">Чтобы установить: кнопка «Поделиться» внизу Safari → «На экран „Домой“».</div>'
        : '<div class="install">Чтобы установить: меню браузера ⋮ → «Добавить на главный экран» / «Установить приложение».</div>';
  if ($('#btnInstall')) $('#btnInstall').onclick = async () => { S.installEvt.prompt(); S.installEvt = null; renderMore(); };
  try {
    const e = await navigator.storage?.estimate?.();
    if (e) $('#storageInfo').textContent = `На телефоне занято ${(e.usage / 1e6).toFixed(1)} МБ (поиски, отметки, кэш OSM).`;
  } catch (e) { /* ok */ }
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvt = e; });

/* ------------------------------------------------------------------ запуск */
(async function init() {
  await loadLabels();
  try { await navigator.storage?.persist?.(); } catch (e) { /* ok */ }
  let last = null;
  try { const id = +localStorage.getItem('lastRun'); if (id) last = await store.get('runs', id); } catch (e) { /* ok */ }
  if (last) openRun(last); else render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  resumePending(new URLSearchParams(location.search).has('resume'));
})();
// вернулись в приложение, пока оно было открыто в фоне: если загрузка закончилась — показать результат
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !$('#progress').classList.contains('hidden')) return;
  const p = await store.get('kv', 'pending').catch(() => null);
  if (p && (p.status === 'downloaded' || p.status === 'running')) resumePending(true);
});
window.__zab = { S, map, core };   // для отладки
