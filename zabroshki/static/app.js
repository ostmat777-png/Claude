/* Заброшки — UI */
'use strict';

const TYPE_NAMES = {
  house: 'Дом / дача', industrial: 'Промздание', farm: 'Ферма / с/х', ruins: 'Руины',
  military: 'Военный объект', building: 'Постройка (прочее)', unmapped: 'Постройка по снимку',
  clearing: 'Прогалина в лесу', deadend: 'Тупик дороги', area: 'Территория (brownfield…)',
  complex: 'Территория / комплекс',
};
const GUARD_NAMES = { red: 'Охраняется / закрыто', yellow: 'Неясно', green: 'Свободный доступ' };
const COLORS = { red: '#e5383b', yellow: '#f4c430', green: '#2dc653' };

const S = {
  map: null, base: 'sat', layers: {}, areaLayer: null, drawer: null,
  runId: null, cands: [], markers: null, markerById: new Map(), selected: null,
  filters: { guard: { red: true, yellow: true, green: true }, minScore: 0.25, types: {}, onlyUnlabeled: false, onlyReliable: true, showParts: false },
  polling: null, lastJobState: 'idle', settings: null,
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const o = Object.assign({ headers: {} }, opts);
  if (o.body && typeof o.body !== 'string') { o.body = JSON.stringify(o.body); o.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(path, o);
  if (!r.ok) {
    let msg = r.status + '';
    try { const j = await r.json(); msg = j.detail || JSON.stringify(j); } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r.text();
}

/* ------------------------------------------------------------------ map */
function initMap() {
  const map = L.map('map', { preferCanvas: true, zoomControl: true, maxZoom: 20 }).setView([60.71, 28.75], 12);
  S.map = map;
  const sat = L.tileLayer('/tiles/esri/{z}/{x}/{y}', { maxZoom: 20, maxNativeZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' });
  const labels = L.tileLayer('/tiles/esri_labels/{z}/{x}/{y}', { maxZoom: 20, maxNativeZoom: 19, attribution: '© Esri' });
  const osm = L.tileLayer('/tiles/osm/{z}/{x}/{y}', { maxZoom: 20, maxNativeZoom: 19, attribution: '© участники OpenStreetMap' });
  S.layers = { sat, labels, osm };
  sat.addTo(map);
  L.control.scale({ imperial: false }).addTo(map);

  S.areaLayer = new L.FeatureGroup().addTo(map);
  S.complexLayer = L.layerGroup().addTo(map);
  S.markers = L.layerGroup().addTo(map);
  S.highlight = L.layerGroup().addTo(map);
  S.manualLayer = L.layerGroup().addTo(map);
  map.on('contextmenu', (e) => manualMenu(e.latlng));

  map.on(L.Draw.Event.CREATED, (e) => {
    S.areaLayer.clearLayers();
    e.layer.setStyle({ color: '#59c3ff', weight: 2, fillOpacity: 0.06, dashArray: '6 4' });
    S.areaLayer.addLayer(e.layer);
    $('#areaSelect').value = '';
    updateAreaInfo();
  });
}

/* ------------------------------------------------------------------ imagery date (Esri Wayback) */
function satUrl() {
  return S.imgRelease ? `/tiles/wayback:${S.imgRelease}/{z}/{x}/{y}` : '/tiles/esri/{z}/{x}/{y}';
}

function setImageryRelease(release, label) {
  S.imgRelease = release || null;
  const oldAttr = S.layers.sat.options.attribution;
  const newAttr = release ? `Esri World Imagery Wayback · снимок ${esc(label || '')}` : 'Imagery © Esri, Maxar, Earthstar Geographics';
  S.layers.sat.options.attribution = newAttr;
  if (S.map.hasLayer(S.layers.sat) && S.map.attributionControl) {
    S.map.attributionControl.removeAttribution(oldAttr);
    S.map.attributionControl.addAttribution(newAttr);
  }
  S.layers.sat.setUrl(satUrl());
  if (S.base === 'map') setBase('sat');
  const sel = $('#dateSelect');
  if (sel.value !== String(release || '')) sel.value = String(release || '');
  $('#dateGroup').classList.toggle('active', !!release);
}

async function loadReleaseYears() {
  try {
    const r = await api('/api/wayback/releases');
    S.releaseYears = r.years;
    fillDateSelect('years');
  } catch (e) { $('#dateSelect').title = 'Архив снимков недоступен: ' + e.message; }
}

function fillDateSelect(mode) {
  const sel = $('#dateSelect');
  const cur = S.imgRelease ? String(S.imgRelease) : '';
  let opts = '<option value="">📅 Текущий снимок</option>';
  if (mode === 'local' && S.localVersions) {
    opts += '<optgroup label="Снимки этого места (дата съёмки)">' + S.localVersions.map((v) =>
      `<option value="${v.release}">${esc(v.date || ('выпуск ' + v.release_date))}${v.src ? ' · ' + esc(v.src) : ''}</option>`).join('') + '</optgroup>';
  }
  if (S.releaseYears) {
    opts += '<optgroup label="По годам (последний выпуск архива)">' + S.releaseYears.map((y) =>
      `<option value="${y.release}">${y.year} (выпуск ${esc(y.date)})</option>`).join('') + '</optgroup>';
  }
  sel.innerHTML = opts;
  sel.value = cur;
  if (sel.value !== cur && cur) {  // keep a release chosen earlier even if it is not in the lists
    sel.insertAdjacentHTML('beforeend', `<option value="${cur}">выпуск ${cur}</option>`);
    sel.value = cur;
  }
}

async function loadLocalDates() {
  const c = S.map.getCenter();
  const btn = $('#dateLocal');
  btn.disabled = true; btn.textContent = '⏳';
  try {
    const r = await api(`/api/wayback/local?lat=${c.lat.toFixed(5)}&lon=${c.lng.toFixed(5)}&z=${Math.round(S.map.getZoom())}`);
    S.localVersions = r.versions;
    S.localCenter = S.map.getCenter();
    fillDateSelect('local');
    btn.textContent = `📍 ${r.versions.length}`;
    btn.title = `Здесь ${r.versions.length} разных снимков — выберите дату в списке`;
  } catch (e) {
    btn.textContent = '📍';
    alert('Не удалось получить даты снимков: ' + e.message);
  } finally { btn.disabled = false; }
}

function stepImagery(dir) {
  // ordered list: newest first (local versions if loaded, otherwise years); index -1 = current imagery
  const list = (S.localVersions && S.localVersions.length ? S.localVersions.map((v) => ({ release: v.release, label: v.date || v.release_date }))
    : (S.releaseYears || []).map((y) => ({ release: y.release, label: y.year })));
  if (!list.length) return;
  let i = list.findIndex((v) => v.release === S.imgRelease);
  i = Math.max(-1, Math.min(list.length - 1, i + dir));
  if (i < 0) setImageryRelease(null);
  else setImageryRelease(list[i].release, list[i].label);
}

function setBase(b) {
  S.base = b;
  const m = S.map;
  Object.values(S.layers).forEach((l) => m.removeLayer(l));
  if (b === 'sat') S.layers.sat.addTo(m);
  if (b === 'hybrid') { S.layers.sat.addTo(m); S.layers.labels.addTo(m); }
  if (b === 'map') S.layers.osm.addTo(m);
  $$('#baseSeg button').forEach((x) => x.classList.toggle('on', x.dataset.base === b));
}

function startDraw(kind) {
  if (S.drawer) S.drawer.disable();
  const shapeOptions = { color: '#59c3ff', weight: 2, fillOpacity: 0.06 };
  S.drawer = kind === 'rect'
    ? new L.Draw.Rectangle(S.map, { shapeOptions, showArea: false })
    : new L.Draw.Polygon(S.map, { shapeOptions, allowIntersection: false, showArea: false });
  S.drawer.enable();
}

function currentAreaGeoJSON() {
  const layers = S.areaLayer.getLayers();
  if (!layers.length) return null;
  return layers[0].toGeoJSON();
}

async function updateAreaInfo() {
  const gj = currentAreaGeoJSON();
  if (!gj) { $('#areaInfo').textContent = ''; return; }
  try {
    const i = await api('/api/area_info', { method: 'POST', body: { geojson: gj } });
    $('#areaInfo').textContent = `${i.area_km2} км² · ~${i.scan_tiles} тайлов z${i.scan_zoom}`;
  } catch (e) { $('#areaInfo').textContent = ''; }
}

function showArea(gj, fit = true) {
  S.areaLayer.clearLayers();
  const l = L.geoJSON(gj, { style: { color: '#59c3ff', weight: 2, fillOpacity: 0.06, dashArray: '6 4' } });
  l.eachLayer((x) => S.areaLayer.addLayer(x));
  if (fit) S.map.fitBounds(S.areaLayer.getBounds(), { padding: [20, 20] });
  updateAreaInfo();
}

/* ------------------------------------------------------------------ areas */
async function loadAreas() {
  const areas = await api('/api/areas');
  const sel = $('#areaSelect');
  sel.innerHTML = '<option value="">— области —</option>' +
    areas.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  S.areas = areas;
}

async function saveArea() {
  const gj = currentAreaGeoJSON();
  if (!gj) return alert('Сначала выделите область рамкой или полигоном.');
  const name = prompt('Название области:', 'Выборг ' + new Date().toLocaleDateString('ru-RU'));
  if (name === null) return;
  const r = await api('/api/areas', { method: 'POST', body: { name, geojson: gj } });
  await loadAreas();
  $('#areaSelect').value = r.id;
}

async function deleteArea() {
  const id = $('#areaSelect').value;
  if (!id) return;
  if (!confirm('Удалить сохранённую область?')) return;
  await api('/api/areas/' + id, { method: 'DELETE' });
  await loadAreas();
}

/* ------------------------------------------------------------------ search / job */
function searchOptions() {
  return {
    search_mode: $('#optMode').value,
    use_imagery: $('#optImagery').checked,
    use_footprints: $('#optFootprints').checked,
    use_models: $('#optModels').checked,
    use_wayback: $('#optWayback').checked,
    use_vlm: $('#optVlm').value,
    stage_b_top_k: +$('#optTopK').value,
    wayback_top_k: +$('#optWbK').value,
  };
}

async function startSearch() {
  const gj = currentAreaGeoJSON();
  if (!gj) return alert('Сначала выделите область рамкой или полигоном.');
  const areaId = $('#areaSelect').value || null;
  const name = areaId ? $('#areaSelect').selectedOptions[0].textContent : null;
  try {
    const info = await api('/api/area_info', { method: 'POST', body: { geojson: gj } });
    if ($('#optImagery').checked && info.scan_tiles > 20000) {
      const hours = (info.scan_tiles / 8 / 3600).toFixed(1);
      if (!confirm(`Область большая: ${info.area_km2} км², ~${info.scan_tiles} тайлов z${info.scan_zoom}.\n` +
        `Первое скачивание снимков займёт ~${hours} ч (повторно — из кэша). Продолжить?`)) return;
    }
  } catch (e) { /* ignore, start anyway */ }
  try {
    const r = await api('/api/search', { method: 'POST', body: { geojson: gj, area_id: areaId, name, options: searchOptions() } });
    S.runId = r.run_id;
    await loadRuns(r.run_id);
    startPolling();
  } catch (e) { alert('Не удалось запустить поиск: ' + e.message); }
}

function startPolling() {
  if (S.polling) return;
  let tick = 0;
  S.polling = setInterval(async () => {
    tick++;
    let j;
    try { j = await api('/api/job'); } catch (e) { return; }
    renderJob(j);
    const active = ['running', 'paused', 'pending'].includes(j.state);
    if (active && tick % 15 === 0 && j.run_id && j.run_id === S.runId) loadCandidates();
    if (!active) {
      clearInterval(S.polling); S.polling = null;
      if (S.lastJobState !== j.state) {
        if (j.name === 'evaluate') { showEval(S.pendingEval || S.runId); }
        else if (j.run_id) { await loadRuns(j.run_id); }
        loadModelInfo();
      }
    }
    S.lastJobState = j.state;
  }, 700);
}

function fmtEta(s) {
  if (s == null || !isFinite(s)) return '';
  if (s < 60) return ` · ~${Math.round(s)} с`;
  if (s < 3600) return ` · ~${Math.round(s / 60)} мин`;
  return ` · ~${(s / 3600).toFixed(1)} ч`;
}

function renderJob(j) {
  const active = ['running', 'paused', 'pending'].includes(j.state);
  $('#btnSearch').disabled = active;
  $('#btnRetrain').disabled = active;
  $('#btnPause').disabled = !active;
  $('#btnCancel').disabled = !active;
  $('#btnPause').textContent = j.state === 'paused' ? '▶ Продолжить' : '⏸ Пауза';
  const pct = Math.round((j.state === 'done' ? 1 : (j.overall || 0)) * 100);
  $('#progressFill').style.width = pct + '%';
  let t = '';
  if (j.state === 'idle') t = 'Выделите область и нажмите «Искать»';
  else if (j.state === 'done') t = `Готово (${{ retrain: 'дообучение', evaluate: 'оценка качества' }[j.name] || 'поиск'}) · ${j.message || ''}`;
  else if (j.state === 'error') t = 'Ошибка: ' + j.error;
  else if (j.state === 'cancelled') t = 'Остановлено';
  else {
    const part = j.total ? ` ${j.done}/${j.total}` : '';
    t = `${j.state === 'paused' ? '⏸ ' : ''}${pct}% · [${j.stage_index}/${j.stage_count}] ${j.stage}${part}${fmtEta(j.eta_s)} — ${j.message || ''}`;
  }
  $('#progressText').textContent = t;
  $('#progressText').title = t;
  if (j.log) $('#logBox').textContent = j.log.join('\n');
}

/* ------------------------------------------------------------------ runs / candidates */
async function loadRuns(selectId) {
  const runs = await api('/api/runs');
  const sel = $('#runSelect');
  sel.innerHTML = runs.map((r) => {
    const d = new Date(r.started * 1000).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `<option value="${r.id}">#${r.id} ${esc(r.name || '')} · ${d} · ${r.count} об. · ${r.status}</option>`;
  }).join('');
  S.runs = runs;
  if (!runs.length) { S.runId = null; S.cands = []; renderCandidates(); return; }
  const id = selectId || S.runId || runs[0].id;
  sel.value = id;
  await selectRun(+sel.value, !selectId);
}

async function selectRun(id, fit) {
  S.runId = id;
  const run = (S.runs || []).find((r) => r.id === id);
  if (run && run.geojson && fit) showArea(run.geojson, true);
  await loadCandidates();
}

async function loadCandidates() {
  if (!S.runId) return;
  const data = await api(`/api/runs/${S.runId}/candidates`);
  S.cands = data.items.map((a) => ({ id: a[0], lat: a[1], lon: a[2], score: a[3], guard: a[4], type: a[5], title: a[6], label: a[7], conf: a[8] || 0, rel: !!a[9], part: !!a[10], sim: a[11] || 0 }));
  loadComplexes();
  buildTypeChecks();
  renderCandidates();
}

function buildTypeChecks() {
  const counts = {};
  S.cands.forEach((c) => { counts[c.type] = (counts[c.type] || 0) + 1; });
  const box = $('#typeChecks');
  const keys = Object.keys(TYPE_NAMES).filter((k) => counts[k]);
  box.innerHTML = keys.map((k) => {
    if (S.filters.types[k] === undefined) S.filters.types[k] = true;
    return `<label title="${esc(TYPE_NAMES[k])}"><input type="checkbox" data-type="${k}" ${S.filters.types[k] ? 'checked' : ''}> ${esc(TYPE_NAMES[k])} (${counts[k]})</label>`;
  }).join('') || '<span class="muted">нет данных</span>';
  box.querySelectorAll('input').forEach((i) => i.addEventListener('change', () => { S.filters.types[i.dataset.type] = i.checked; renderCandidates(); }));
}

function passes(c) {
  const f = S.filters;
  if (!f.guard[c.guard]) return false;
  const mine = c.label === 1;
  if (c.score < f.minScore && !mine && !c.sim) return false;
  if (f.types[c.type] === false) return false;
  if (f.onlyUnlabeled && c.label != null) return false;
  if (f.onlyReliable && c.label === 0) return false;
  if (f.onlyReliable && !c.rel && !c.sim && !mine) return false;
  if (!f.showParts && c.part && !c.sim && !mine) return false;
  return true;
}

function renderCandidates() {
  S.markers.clearLayers();
  S.markerById.clear();
  const cnt = { red: 0, yellow: 0, green: 0 };
  const shown = [];
  for (const c of S.cands) {
    if (c.score >= S.filters.minScore && S.filters.types[c.type] !== false) cnt[c.guard] = (cnt[c.guard] || 0) + 1;
    if (!passes(c)) continue;
    shown.push(c);
  }
  shown.sort((a, b) => a.score - b.score); // draw best on top
  for (const c of shown) {
    const m = L.circleMarker([c.lat, c.lon], {
      radius: c.sim && !c.rel ? 8 : 4 + 7 * c.score,
      color: c.label === 1 ? '#000' : (c.label === 0 ? '#7a7a7a' : (c.sim && !c.rel ? '#c77dff' : (c.conf >= 2 ? '#00e5ff' : '#fff'))),
      weight: c.label != null || c.conf >= 2 || c.sim ? 3 : 1.5, dashArray: c.sim && !c.rel && c.label == null ? '3 3' : null,
      fillColor: COLORS[c.guard] || COLORS.yellow, fillOpacity: 0.9,
    });
    m.bindTooltip(`${(c.score * 100).toFixed(0)} · ${esc(TYPE_NAMES[c.type] || c.type)}<br>${esc(c.title || '')}`
      + (c.sim ? `<br>≈ похоже на ваши примеры (${(c.sim * 100).toFixed(0)}%)` : ''), { direction: 'top' });
    m.on('click', () => selectCandidate(c.id));
    m.addTo(S.markers);
    S.markerById.set(c.id, m);
  }
  ['red', 'yellow', 'green'].forEach((g) => { $('#cnt-' + g).textContent = cnt[g] || 0; });
  const nrel = S.cands.filter((c) => c.rel && !c.part).length;
  const nsim = S.cands.filter((c) => c.sim).length;
  $('#shownCount').textContent = `показано ${shown.length} · надёжных ${nrel}` + (nsim ? ` · ≈ похожих на ваши ${nsim}` : '') + ` · всего ${S.cands.length}`;
  drawComplexes(shown);
  const list = shown.slice().reverse().slice(0, 400);
  $('#list').innerHTML = list.map((c) => `
    <div class="item ${S.selected === c.id ? 'sel' : ''}" data-id="${c.id}">
      <span class="dot ${c.guard}"></span>
      <span class="sc">${(c.score * 100).toFixed(0)}${c.conf >= 2 ? '<span class="conf" title="подтверждено ' + c.conf + ' источниками">✔' + c.conf + '</span>' : ''}</span>
      <span class="tt">${esc(TYPE_NAMES[c.type] || c.type)} · <span class="muted">${esc(c.title || '')}</span>
        ${c.label === 1 ? '<span class="lb">✔ заброшка</span>' : c.label === 0 ? '<span class="lb">✘ не заброшка</span>' : ''}
        ${c.sim && c.label == null ? '<span class="lb simlb" title="Похоже на ваши примеры — проверьте и отметьте">≈ похоже</span>' : ''}</span>
    </div>`).join('') + (shown.length > 400 ? `<div class="muted" style="padding:6px">… и ещё ${shown.length - 400} (уточните фильтры)</div>` : '');
  $$('#list .item').forEach((el) => el.addEventListener('click', () => selectCandidate(+el.dataset.id, true)));
}

/* ------------------------------------------------------------------ territories (complexes) */
async function loadComplexes() {
  if (!S.runId) return;
  try { S.complexes = await api(`/api/runs/${S.runId}/complexes`); } catch (e) { S.complexes = []; }
  renderCandidates();
}

function drawComplexes(shown) {
  S.complexLayer.clearLayers();
  const ids = new Set(shown.map((c) => c.id));
  for (const cx of (S.complexes || [])) {
    if (!ids.has(cx.id) || !cx.geometry) continue;
    const l = L.geoJSON(cx.geometry, { style: { color: COLORS[cx.guard] || COLORS.yellow, weight: 2, dashArray: '5 4', fillOpacity: 0.07 } });
    l.on('click', () => selectCandidate(cx.id));
    l.addTo(S.complexLayer);
  }
}

/* ------------------------------------------------------------------ manual marks (missed objects) */
function manualMenu(latlng) {
  const html = `<div class="mm"><b>${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}</b><br>
    <button id="mmYes">✔ Здесь заброшка</button> <button id="mmNo">✘ Не заброшка</button>
    <div class="muted small">Отметка станет примером для дообучения и проверки качества.</div></div>`;
  const pop = L.popup().setLatLng(latlng).setContent(html).openOn(S.map);
  setTimeout(() => {
    const send = async (label) => {
      await api('/api/labels/manual', { method: 'POST', body: { lat: latlng.lat, lon: latlng.lng, label } });
      S.map.closePopup(pop); loadManual(); loadModelInfo();
    };
    $('#mmYes').onclick = () => send(1);
    $('#mmNo').onclick = () => send(0);
  }, 0);
}

async function loadManual() {
  let labels = [];
  try { labels = await api('/api/labels'); } catch (e) { return; }
  S.manualLayer.clearLayers();
  for (const l of labels) {
    const icon = L.divIcon({ className: 'manual-mark ' + (l.label ? 'yes' : 'no'), html: l.label ? '★' : '✕', iconSize: [20, 20] });
    const m = L.marker([l.lat, l.lon], { icon, title: (l.label ? 'Ваша отметка: заброшка' : 'Ваша отметка: не заброшка') });
    m.bindPopup(`${l.label ? '★ Заброшка' : '✕ Не заброшка'} (${esc(l.note || 'отметка')})<br><button data-del="${l.id}">удалить отметку</button>`);
    m.on('popupopen', (e) => {
      const b = e.popup.getElement().querySelector('button[data-del]');
      if (b) b.onclick = async () => { await api('/api/labels/' + l.id, { method: 'DELETE' }); S.map.closePopup(); loadManual(); };
    });
    m.addTo(S.manualLayer);
  }
  let ex = { positives: [], negatives: [] };
  try { ex = await api('/api/examples'); } catch (e) { return; }
  for (const [list, yes] of [[ex.positives, true], [ex.negatives, false]]) {
    for (const p of list) {
      const icon = L.divIcon({ className: 'manual-mark file ' + (yes ? 'yes' : 'no'), html: yes ? '☆' : '✕', iconSize: [20, 20] });
      L.marker([p.lat, p.lon], { icon, title: (yes ? 'Пример из positives.csv' : 'Не заброшка из negatives.csv') + (p.comment ? ': ' + p.comment : '') })
        .bindPopup(`${yes ? '☆ Пример из файла positives.csv' : '✕ Из файла negatives.csv'}<br>${esc(p.comment || '')}<br><span class="muted small">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</span>`)
        .addTo(S.manualLayer);
    }
  }
}

/* ------------------------------------------------------------------ detail */
function switchTab(name) {
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + name));
  if (name === 'model') loadModelInfo();
}

async function selectCandidate(id, pan) {
  S.selected = id;
  $$('#list .item').forEach((el) => el.classList.toggle('sel', +el.dataset.id === id));
  const m = S.markerById.get(id);
  if (m && pan) S.map.setView(m.getLatLng(), Math.max(S.map.getZoom(), 17));
  switchTab('detail');
  $('#detail').innerHTML = '<p class="muted">Загрузка…</p>';
  let d;
  try { d = await api('/api/candidates/' + id); } catch (e) { $('#detail').innerHTML = 'Ошибка: ' + esc(e.message); return; }
  renderDetail(d);
  if (pan && !m) S.map.setView([d.lat, d.lon], Math.max(S.map.getZoom(), 17));
}

function reasonRows(list) {
  return (list || []).map((r) => {
    const w = r.w ?? 0;
    const cls = w > 0.05 ? 'pos' : (w < -0.05 ? 'neg' : 'neu');
    const ws = w ? (w > 0 ? '+' : '') + w.toFixed(2) : '';
    return `<li><span class="w ${cls}">${ws}</span><span>${esc(r.text)}</span></li>`;
  }).join('');
}

function renderDetail(d) {
  const ll = `${d.lat.toFixed(6)}, ${d.lon.toFixed(6)}`;
  const years = (d.wayback || []).map((w) => `
    <figure><img loading="lazy" src="/api/candidates/${d.id}/image?src=wayback:${w.release}&size=256" data-cap="${esc(w.date)}">
    <figcaption>${esc(w.date)}${w.note ? ' · ' + esc(w.note) : ''}</figcaption></figure>`).join('');
  const tags = d.tags && Object.keys(d.tags).length ? Object.entries(d.tags).map(([k, v]) => `${k}=${v}`).join('\n') : '';
  $('#detail').innerHTML = `
    <h3>${esc(TYPE_NAMES[d.kind] || d.kind)}${d.title ? ' — ' + esc(d.title) : ''}</h3>
    <div class="imgwrap"><img id="mainImg" src="/api/candidates/${d.id}/image?src=current&size=384" data-cap="Текущий снимок"></div>
    <div class="row" style="justify-content:space-between">
      <div><span class="scorebig">${(d.score * 100).toFixed(0)}</span><span class="muted"> / 100 балл заброшенности</span></div>
      <span class="badge ${d.guard}">${GUARD_NAMES[d.guard] || d.guard}</span>
    </div>
    ${d.reliable ? '<div class="relbadge">✔ Надёжная метка</div>' : (d.similar ? '' : '<div class="muted small">Ненадёжная метка — показывается только при снятой галочке «только надёжные»</div>')}
    ${d.similar ? `<div class="simbadge">≈ Похоже на ваши примеры (${(d.similar * 100).toFixed(0)}%) — проверьте по снимку и нажмите «Заброшка» или «Не заброшка»: программа учится на этом</div>`
      : (d.pU != null ? `<div class="muted small">Сходство с вашими примерами: ${(d.pU * 100).toFixed(0)}%</div>` : '')}
    ${(d.members || []).length ? `<h4>Здания территории (${d.members.length})</h4><div class="members">${d.members.map((m) =>
      `<div class="item" data-mid="${m.id}"><span class="dot ${m.guard}"></span><span class="sc">${(m.score * 100).toFixed(0)}${m.reliable ? '<span class="conf">✔</span>' : ''}</span><span class="tt">${esc(TYPE_NAMES[m.kind] || m.kind)} · <span class="muted">${esc(m.title || '')}</span></span></div>`).join('')}</div>` : ''}
    <div class="labelbtns">
      <button class="yes ${d.label === 1 ? 'on' : ''}" id="lblYes">Заброшка</button>
      <button class="no ${d.label === 0 ? 'on' : ''}" id="lblNo">Не заброшка</button>
    </div>
    <div class="muted small" id="lblHint">${S.labelsSinceTrain ? `Новых отметок: ${S.labelsSinceTrain}. Чтобы учесть их в ранжировании — вкладка «Модель» → «Дообучить и пересчитать».` : 'Отметки сохраняются и используются для дообучения.'}</div>
    <div id="infoBox" class="infobox"><h4>Сведения об объекте</h4><p class="muted">Загрузка из открытых источников…</p></div>
    <h4>Подтверждение: ${d.confirm_n >= 2 ? '✔ ' + d.confirm_n + ' независимых источника' : d.confirm_n === 1 ? 'один источник — нужна проверка' : 'не подтверждено'}</h4>
    <ul class="reasons">${(d.confirm || []).map((t) => `<li><span class="w pos">✔</span><span>${esc(t)}</span></li>`).join('')}${(d.contra || []).map((t) => `<li><span class="w neg">✘</span><span>${esc(t)}</span></li>`).join('')}</ul>
    <h4>Почему такой балл</h4>
    <ul class="reasons">${reasonRows(d.reasons)}</ul>
    ${(d.reasons || []).some((r) => / \*$/.test(r.text)) ? '<div class="muted small">* вклад уменьшен: похожие признаки (несколько нейросетей, «много зелени») не суммируются полностью</div>' : ''}
    <h4>Статус охраны: ${GUARD_NAMES[d.guard] || d.guard}</h4>
    <ul class="reasons">${reasonRows(d.guard_reasons)}</ul>
    ${years ? `<h4>Снимки по годам (Esri Wayback)</h4><div class="years">${years}</div>` : ''}
    <h4>Данные</h4>
    <div class="kv">
      <div>Координаты</div><div><span id="coords">${ll}</span> <button id="copyLL" title="Копировать">⧉</button></div>
      <div>Источники</div><div>${esc((d.sources || []).join(', '))}</div>
      <div>Этап проверки</div><div>${d.stage >= 3 ? 'точная (z18 + годы)' : d.stage >= 2 ? 'точная (z18)' : 'быстрый скан'}</div>
      ${d.area_m2 ? `<div>Площадь</div><div>${Math.round(d.area_m2)} м²</div>` : ''}
      ${d.imagery_date ? `<div>Дата снимка</div><div>${esc(d.imagery_date)}</div>` : ''}
    </div>
    ${tags ? `<h4>Теги OSM</h4><div class="tags">${esc(tags)}</div>` : ''}
    <div class="links" style="margin-top:8px">
      <a href="${d.google_maps}" target="_blank" rel="noopener">Открыть в Google Maps ↗</a>
      <a href="${d.osm_url}" target="_blank" rel="noopener">OSM ↗</a>
    </div>`;
  $('#lblYes').onclick = () => setLabel(d.id, d.label === 1 ? null : 1);
  $('#lblNo').onclick = () => setLabel(d.id, d.label === 0 ? null : 0);
  $('#copyLL').onclick = () => { navigator.clipboard && navigator.clipboard.writeText(ll); };
  $$('#detail img').forEach((im) => im.addEventListener('click', () => showBig(im.src.replace(/size=\d+/, 'size=768'), im.dataset.cap)));
  loadInfo(d.id, false);
  $$('#detail .members .item').forEach((el) => el.addEventListener('click', () => selectCandidate(+el.dataset.mid, true)));
  S.highlight.clearLayers();
  if (d.footprint) L.geoJSON(d.footprint, { style: { color: '#00e5ff', weight: 3, fillOpacity: 0.12 } }).addTo(S.highlight);
  else L.circleMarker([d.lat, d.lon], { radius: 14, color: '#00e5ff', weight: 3, fill: false }).addTo(S.highlight);
}

async function loadInfo(id, refresh) {
  const box = $('#infoBox');
  if (!box) return;
  let info;
  try { info = await api(`/api/candidates/${id}/info${refresh ? '?refresh=1' : ''}`); } catch (e) {
    box.innerHTML = '<h4>Сведения об объекте</h4><p class="muted">Не удалось загрузить: ' + esc(e.message) + '</p>'; return;
  }
  if (S.selected !== id || !$('#infoBox')) return;
  const h = [];
  h.push('<h4>Сведения об объекте <button id="infoRefresh" class="small" title="Загрузить заново">↻</button></h4>');
  if (info.auto && info.auto.length) h.push(`<div class="autodesc">${info.auto.map((t) => esc(t)).join(' ')}</div>`);
  for (const w of (info.wikipedia || [])) {
    h.push(`<div class="wcard">${w.thumb ? `<img class="ph" src="${esc(w.thumb)}" data-full="${esc(w.thumb)}" data-cap="${esc(w.title)}">` : '<span></span>'}
      <div><b><a href="${esc(w.url)}" target="_blank" rel="noopener">${esc(w.title)}</a></b>
      <span class="muted small">Википедия (${esc(w.lang)})${w.dist_m ? ', ~' + w.dist_m + ' м' : ''}</span>
      <div class="small">${esc(w.extract || '')}</div></div></div>`);
  }
  for (const w of (info.wikidata || []).slice(0, 3)) {
    const facts = Object.entries(w.facts || {}).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' · ');
    h.push(`<div class="small wd"><a href="${esc(w.url)}" target="_blank" rel="noopener">${esc(w.label || w.qid)}</a>
      ${w.dist_m != null ? `<span class="muted">(~${w.dist_m} м)</span>` : ''} — ${esc(w.description || '')}${facts ? '<br><span class="muted">' + facts + '</span>' : ''}</div>`);
  }
  if ((info.osm || []).length) {
    h.push('<div class="kv small">' + info.osm.map((x) => `<div>${esc(x.k)}</div><div>${esc(x.v)}</div>`).join('') + '</div>');
  }
  const notes = info.notes || [];
  const cond = notes.filter((n) => n.cat === 'condition');
  const sec = notes.filter((n) => n.cat === 'security');
  const noteHtml = (arr) => arr.map((n) => `<li><span>${esc(n.text)}</span> <span class="muted small">— ${n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.source)}</a>` : esc(n.source)}</span></li>`).join('');
  if (cond.length) h.push(`<h4>Состояние и заброшенность по источникам</h4><ul class="notes">${noteHtml(cond)}</ul>`);
  if (sec.length) h.push(`<h4>Охрана и доступ по источникам</h4><ul class="notes">${noteHtml(sec)}</ul>`);
  if (!cond.length && !sec.length) h.push('<p class="muted small">В открытых источниках сведений о состоянии и охране не найдено — проверьте ссылки ниже.</p>');
  const ph = info.photos || [];
  if (ph.length) {
    h.push('<h4>Фотографии рядом (открытые источники)</h4><div class="years">' + ph.map((p) => `<figure>
      <img class="ph" loading="lazy" src="${esc(p.thumb || '')}" data-full="${esc(p.full || p.thumb || '')}" data-cap="${esc((p.title || p.source) + (p.date ? ', ' + p.date : '') + (p.author ? ' · ' + p.author : '') + (p.license ? ' · ' + p.license : ''))}">
      <figcaption>${esc(p.source)}${p.date ? ' · ' + esc(p.date) : ''}${p.dist_m != null ? ' · ' + p.dist_m + ' м' : ''}${p.looks_at ? ' · смотрит на объект' : ''}
      <br><a href="${esc(p.url || '#')}" target="_blank" rel="noopener">${esc((p.author || 'автор') + (p.license ? ', ' + p.license : ''))}</a></figcaption></figure>`).join('') + '</div>');
  } else {
    h.push('<p class="muted small">Фотографий с геометкой рядом не найдено.</p>');
  }
  h.push('<div class="links small">' + (info.links || []).map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)} ↗</a>`).join(' ') + '</div>');
  if ((info.errors || []).length) h.push(`<p class="muted small">Недоступны: ${esc(info.errors.join(', '))} — попробуйте ↻ позже.</p>`);
  h.push('<p class="muted small">Перед поездкой проверьте законность доступа: заброшенные здания опасны, территория может быть частной или охраняемой.</p>');
  box.innerHTML = h.join('');
  $('#infoRefresh').onclick = () => { box.querySelector('h4').insertAdjacentHTML('afterend', '<p class="muted">Обновление…</p>'); loadInfo(id, true); };
  box.querySelectorAll('img.ph').forEach((im) => im.addEventListener('click', () => showBig(im.dataset.full || im.src, im.dataset.cap)));
}

async function setLabel(id, label) {
  try {
    const r = await api(`/api/candidates/${id}/label`, { method: 'POST', body: { label } });
    S.labelsSinceTrain = r.labels_since_train;
  } catch (e) { alert('Ошибка: ' + e.message); return; }
  const c = S.cands.find((x) => x.id === id);
  if (c) c.label = label;
  renderCandidates();
  const d = await api('/api/candidates/' + id);
  renderDetail(d);
  loadModelInfo();
}

function showBig(src, cap) {
  let el = $('#bigimg');
  if (!el) {
    el = document.createElement('div'); el.id = 'bigimg';
    el.innerHTML = '<img><div class="cap"></div>';
    el.onclick = () => { el.style.display = 'none'; };
    document.body.appendChild(el);
  }
  el.querySelector('img').src = src;
  el.querySelector('.cap').textContent = cap || '';
  el.style.display = 'flex';
}

async function showPhone() {
  let info = { enabled: false, urls: [] };
  try { info = await api('/api/lan'); } catch (e) { /* ignore */ }
  const body = $('#phoneBody');
  if (location.hostname !== '127.0.0.1' && location.hostname !== 'localhost') {
    body.innerHTML = 'Вы уже открыли программу с другого устройства 👍';
  } else if (!info.enabled || !info.urls.length) {
    body.innerHTML = 'Сейчас доступ с телефона выключен. Закройте программу и запустите <b>run_lan.bat</b> ' +
      '(или <code>run.bat --lan</code>), затем снова нажмите «📱».<br><br>Телефон должен быть в той же Wi-Fi сети, что и компьютер. ' +
      'Вся работа (скан, нейросети) идёт на компьютере, телефон только показывает карту и отметки.';
  } else {
    body.innerHTML = (info.qr_svg || '') +
      '<div>Отсканируйте QR-код камерой телефона или откройте ссылку:</div>' +
      info.urls.map((u) => `<div><code>${esc(u)}</code></div>`).join('') +
      '<div class="small">Телефон должен быть в той же Wi-Fi сети. Ссылка содержит ключ доступа — не публикуйте её.</div>';
  }
  $('#phoneModal').style.display = 'flex';
}

async function showEval(runId) {
  try {
    const t = await api('/api/evaluate/report?run_id=' + runId);
    $('#evalBox').textContent = t;
    $('#evalBox').style.display = 'block';
    switchTab('model');
  } catch (e) { $('#evalBox').textContent = e.message; $('#evalBox').style.display = 'block'; }
}

/* ------------------------------------------------------------------ model / settings */
async function loadModelInfo() {
  try {
    const m = await api('/api/model');
    S.labelsSinceTrain = m.labels_since_train;
    const lines = [
      `<b>Примеры:</b> ${m.positives_csv} из файла` + (m.positives_csv_path ? ` <span class="small">(${esc(m.positives_csv_path)})</span>` : '')
        + (m.negatives_csv ? ` · не заброшек из negatives.csv: ${m.negatives_csv}` : '')
        + (m.positives_bad_n ? `<div class="warn">Не распознано строк: ${m.positives_bad_n}. Нужны широта и долгота (лучше 5 знаков после точки), например «60.71234, 28.74567».<br>`
          + m.positives_bad.map((b) => `строка ${b[0]}: «${esc(b[1])}»`).join('<br>') + '</div>' : '')
        + (!m.positives_csv && !m.positives_bad_n ? `<div class="warn">Файл пуст или не найден. Проверьте, что он называется positives.csv и лежит в папке examples программы (путь выше).</div>` : ''),
      `<b>Отметки:</b> заброшка ${m.labels_pos}, не заброшка ${m.labels_neg}` + (m.labels_since_train ? ` · новых с последнего обучения: ${m.labels_since_train}` : ''),
      `<b>Устройство:</b> ${esc(m.device || '')}`,
    ];
    for (const [k, v] of Object.entries(m.models || {})) {
      lines.push(`<b>${esc(k)}:</b> ${esc(v)}`);
    }
    if (m.metrics) lines.push(`<b>Качество:</b> ${esc(m.metrics)}`);
    $('#modelInfo').innerHTML = lines.join('<br>');
  } catch (e) { $('#modelInfo').textContent = 'нет данных: ' + e.message; }
}

async function loadSettings() {
  const s = await api('/api/settings');
  S.settings = s;
  $('#optMode').value = s.search_mode === 'full' ? 'full' : 'fast';
  $('#optImagery').checked = !!s.use_imagery;
  $('#optFootprints').checked = !!s.use_footprints;
  $('#optModels').checked = !!s.use_models;
  $('#optWayback').checked = !!s.use_wayback;
  $('#optVlm').value = String(s.use_vlm);
  $('#optTopK').value = s.stage_b_top_k;
  $('#optWbK').value = s.wayback_top_k;
  $('#zScan').textContent = s.scan_zoom;
  $('#optDevice').value = s.device || 'auto';
  const p = await api('/api/providers');
  $('#optProvider').innerHTML = Object.entries(p.providers).filter(([, v]) => v.kind === 'sat')
    .map(([k, v]) => `<option value="${k}" ${k === p.imagery ? 'selected' : ''}>${esc(v.name)}</option>`).join('');
}

async function saveOpts() {
  const o = searchOptions();
  o.use_vlm = o.use_vlm === 'auto' ? 'auto' : o.use_vlm === 'true';
  o.imagery_provider = $('#optProvider').value;
  const devChanged = (S.settings && S.settings.device) !== $('#optDevice').value;
  o.device = $('#optDevice').value;
  await api('/api/settings', { method: 'POST', body: o });
  $('#btnSaveOpts').textContent = devChanged ? 'Сохранено ✓ — перезапустите программу' : 'Сохранено ✓';
  if (S.settings) S.settings.device = o.device;
  setTimeout(() => { $('#btnSaveOpts').textContent = 'Сохранить параметры'; }, devChanged ? 6000 : 1500);
}

async function doExport(fmt) {
  if (!S.runId) return alert('Нет результатов для экспорта.');
  const filters = { guard: Object.keys(S.filters.guard).filter((g) => S.filters.guard[g]), min_score: S.filters.minScore,
    types: Object.keys(S.filters.types).filter((t) => S.filters.types[t]), only_unlabeled: S.filters.onlyUnlabeled, only_reliable: S.filters.onlyReliable, show_parts: S.filters.showParts };
  try {
    const r = await api('/api/export', { method: 'POST', body: { run_id: S.runId, format: fmt, filters } });
    $('#exportMsg').innerHTML = `Сохранено: <code>${esc(r.path)}</code> · <a href="/api/export/download?name=${encodeURIComponent(r.name)}" download>скачать</a> · <a href="#" id="openFolder">открыть папку</a>`;
    $('#openFolder').onclick = (e) => { e.preventDefault(); api('/api/open_folder', { method: 'POST', body: { path: r.path } }); };
  } catch (e) { $('#exportMsg').textContent = 'Ошибка экспорта: ' + e.message; }
}

/* ------------------------------------------------------------------ wiring */
function wire() {
  $$('#baseSeg button').forEach((b) => b.addEventListener('click', () => setBase(b.dataset.base)));
  $('#dateSelect').onchange = () => {
    const v = $('#dateSelect').value;
    setImageryRelease(v ? +v : null, $('#dateSelect').selectedOptions[0].textContent);
  };
  $('#datePrev').onclick = () => stepImagery(+1);
  $('#dateNext').onclick = () => stepImagery(-1);
  $('#dateLocal').onclick = loadLocalDates;
  S.map.on('moveend', () => {  // local dates belong to a place: forget them after a long move
    if (!S.localVersions) return;
    const c = S.map.getCenter();
    if (!S.localCenter) { S.localCenter = c; return; }
    if (S.map.distance(c, S.localCenter) > 1500) { S.localVersions = null; S.localCenter = null; fillDateSelect('years'); $('#dateLocal').textContent = '📍'; }
  });
  $('#btnRect').onclick = () => startDraw('rect');
  $('#btnPoly').onclick = () => startDraw('poly');
  $('#btnClear').onclick = () => { S.areaLayer.clearLayers(); $('#areaSelect').value = ''; updateAreaInfo(); };
  $('#btnSaveArea').onclick = saveArea;
  $('#btnDelArea').onclick = deleteArea;
  $('#areaSelect').onchange = () => {
    const a = (S.areas || []).find((x) => String(x.id) === $('#areaSelect').value);
    if (a) showArea(a.geojson, true);
  };
  $('#btnSearch').onclick = startSearch;
  $('#btnPause').onclick = async () => {
    const j = await api('/api/job');
    await api('/api/job/' + (j.state === 'paused' ? 'resume' : 'pause'), { method: 'POST' });
    startPolling();
  };
  $('#btnCancel').onclick = async () => { if (confirm('Остановить поиск? Уже найденное сохранится, кэш останется.')) await api('/api/job/cancel', { method: 'POST' }); };
  $('#runSelect').onchange = () => selectRun(+$('#runSelect').value, true);
  $('#btnDelRun').onclick = async () => {
    if (!S.runId || !confirm('Удалить результаты этого запуска? Отметки сохранятся.')) return;
    await api('/api/runs/' + S.runId, { method: 'DELETE' }); S.runId = null; await loadRuns();
  };
  $$('#colorChips input').forEach((i) => i.addEventListener('change', () => { S.filters.guard[i.dataset.guard] = i.checked; renderCandidates(); }));
  $('#scoreSlider').addEventListener('input', (e) => { S.filters.minScore = +e.target.value; $('#scoreVal').textContent = (+e.target.value).toFixed(2); renderCandidates(); });
  $('#onlyUnlabeled').onchange = (e) => { S.filters.onlyUnlabeled = e.target.checked; renderCandidates(); };
  $('#onlyReliable').onchange = (e) => { S.filters.onlyReliable = e.target.checked; renderCandidates(); };
  $('#showParts').onchange = (e) => { S.filters.showParts = e.target.checked; renderCandidates(); };
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $$('.export button').forEach((b) => b.addEventListener('click', () => doExport(b.dataset.fmt)));
  $('#btnRetrain').onclick = async () => {
    try { await api('/api/retrain', { method: 'POST', body: { run_id: S.runId } }); startPolling(); } catch (e) { alert(e.message); }
  };
  $('#btnSaveOpts').onclick = saveOpts;
  $('#btnPhone').onclick = showPhone;
  $('#phoneClose').onclick = () => { $('#phoneModal').style.display = 'none'; };
  $('#btnEval').onclick = async () => {
    if (!S.runId) return alert('Сначала выполните поиск.');
    try {
      await api('/api/evaluate', { method: 'POST', body: { run_id: S.runId } });
      S.pendingEval = S.runId;
      startPolling();
    } catch (e) { alert(e.message); }
  };
}

window.addEventListener('DOMContentLoaded', async () => {
  initMap();
  wire();
  try { await loadSettings(); } catch (e) { console.warn(e); }
  loadReleaseYears();
  try { await loadAreas(); } catch (e) { console.warn(e); }
  try { await loadRuns(); } catch (e) { console.warn(e); }
  const j = await api('/api/job').catch(() => ({ state: 'idle' }));
  renderJob(j);
  if (['running', 'paused', 'pending'].includes(j.state)) { S.runId = j.run_id; startPolling(); }
  loadModelInfo();
  loadManual();
});
