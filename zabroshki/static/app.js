/* Заброшки — UI */
'use strict';

const TYPE_NAMES = {
  house: 'Дом / дача', industrial: 'Промздание', farm: 'Ферма / с/х', ruins: 'Руины',
  military: 'Военный объект', building: 'Постройка (прочее)', unmapped: 'Постройка по снимку',
  clearing: 'Прогалина в лесу', deadend: 'Тупик дороги', area: 'Территория (brownfield…)',
};
const GUARD_NAMES = { red: 'Охраняется / закрыто', yellow: 'Неясно', green: 'Свободный доступ' };
const COLORS = { red: '#e5383b', yellow: '#f4c430', green: '#2dc653' };

const S = {
  map: null, base: 'sat', layers: {}, areaLayer: null, drawer: null,
  runId: null, cands: [], markers: null, markerById: new Map(), selected: null,
  filters: { guard: { red: true, yellow: true, green: true }, minScore: 0.25, types: {}, onlyUnlabeled: false },
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
  S.markers = L.layerGroup().addTo(map);

  map.on(L.Draw.Event.CREATED, (e) => {
    S.areaLayer.clearLayers();
    e.layer.setStyle({ color: '#59c3ff', weight: 2, fillOpacity: 0.06, dashArray: '6 4' });
    S.areaLayer.addLayer(e.layer);
    $('#areaSelect').value = '';
    updateAreaInfo();
  });
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
    if (active && tick % 8 === 0 && j.run_id && j.run_id === S.runId) loadCandidates();
    if (!active) {
      clearInterval(S.polling); S.polling = null;
      if (S.lastJobState !== j.state) { if (j.run_id) { await loadRuns(j.run_id); } loadModelInfo(); }
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
  else if (j.state === 'done') t = `Готово (${j.name === 'retrain' ? 'дообучение' : 'поиск'}) · ${j.message || ''}`;
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
  S.cands = data.items.map((a) => ({ id: a[0], lat: a[1], lon: a[2], score: a[3], guard: a[4], type: a[5], title: a[6], label: a[7] }));
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
  if (c.score < f.minScore) return false;
  if (f.types[c.type] === false) return false;
  if (f.onlyUnlabeled && c.label != null) return false;
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
      radius: 4 + 7 * c.score, color: c.label === 1 ? '#000' : (c.label === 0 ? '#7a7a7a' : '#fff'),
      weight: c.label != null ? 3 : 1.5, fillColor: COLORS[c.guard] || COLORS.yellow, fillOpacity: 0.9,
    });
    m.bindTooltip(`${(c.score * 100).toFixed(0)} · ${esc(TYPE_NAMES[c.type] || c.type)}<br>${esc(c.title || '')}`, { direction: 'top' });
    m.on('click', () => selectCandidate(c.id));
    m.addTo(S.markers);
    S.markerById.set(c.id, m);
  }
  ['red', 'yellow', 'green'].forEach((g) => { $('#cnt-' + g).textContent = cnt[g] || 0; });
  $('#shownCount').textContent = `показано ${shown.length} из ${S.cands.length}`;
  const list = shown.slice().reverse().slice(0, 400);
  $('#list').innerHTML = list.map((c) => `
    <div class="item ${S.selected === c.id ? 'sel' : ''}" data-id="${c.id}">
      <span class="dot ${c.guard}"></span>
      <span class="sc">${(c.score * 100).toFixed(0)}</span>
      <span class="tt">${esc(TYPE_NAMES[c.type] || c.type)} · <span class="muted">${esc(c.title || '')}</span>
        ${c.label === 1 ? '<span class="lb">✔ заброшка</span>' : c.label === 0 ? '<span class="lb">✘ не заброшка</span>' : ''}</span>
    </div>`).join('') + (shown.length > 400 ? `<div class="muted" style="padding:6px">… и ещё ${shown.length - 400} (уточните фильтры)</div>` : '');
  $$('#list .item').forEach((el) => el.addEventListener('click', () => selectCandidate(+el.dataset.id, true)));
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
    <div class="labelbtns">
      <button class="yes ${d.label === 1 ? 'on' : ''}" id="lblYes">Заброшка</button>
      <button class="no ${d.label === 0 ? 'on' : ''}" id="lblNo">Не заброшка</button>
    </div>
    <h4>Почему такой балл</h4>
    <ul class="reasons">${reasonRows(d.reasons)}</ul>
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
}

async function setLabel(id, label) {
  try {
    await api(`/api/candidates/${id}/label`, { method: 'POST', body: { label } });
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

/* ------------------------------------------------------------------ model / settings */
async function loadModelInfo() {
  try {
    const m = await api('/api/model');
    const lines = [
      `<b>Примеры:</b> ${m.positives_csv} из examples/positives.csv` + (m.positives_csv_path ? ` <span class="small">(${esc(m.positives_csv_path)})</span>` : ''),
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
  $('#optImagery').checked = !!s.use_imagery;
  $('#optFootprints').checked = !!s.use_footprints;
  $('#optModels').checked = !!s.use_models;
  $('#optWayback').checked = !!s.use_wayback;
  $('#optVlm').value = String(s.use_vlm);
  $('#optTopK').value = s.stage_b_top_k;
  $('#optWbK').value = s.wayback_top_k;
  $('#zScan').textContent = s.scan_zoom;
  const p = await api('/api/providers');
  $('#optProvider').innerHTML = Object.entries(p.providers).filter(([, v]) => v.kind === 'sat')
    .map(([k, v]) => `<option value="${k}" ${k === p.imagery ? 'selected' : ''}>${esc(v.name)}</option>`).join('');
}

async function saveOpts() {
  const o = searchOptions();
  o.use_vlm = o.use_vlm === 'auto' ? 'auto' : o.use_vlm === 'true';
  o.imagery_provider = $('#optProvider').value;
  await api('/api/settings', { method: 'POST', body: o });
  $('#btnSaveOpts').textContent = 'Сохранено ✓';
  setTimeout(() => { $('#btnSaveOpts').textContent = 'Сохранить параметры'; }, 1500);
}

async function doExport(fmt) {
  if (!S.runId) return alert('Нет результатов для экспорта.');
  const filters = { guard: Object.keys(S.filters.guard).filter((g) => S.filters.guard[g]), min_score: S.filters.minScore,
    types: Object.keys(S.filters.types).filter((t) => S.filters.types[t]), only_unlabeled: S.filters.onlyUnlabeled };
  try {
    const r = await api('/api/export', { method: 'POST', body: { run_id: S.runId, format: fmt, filters } });
    $('#exportMsg').innerHTML = `Сохранено: <code>${esc(r.path)}</code> · <a href="/api/export/download?name=${encodeURIComponent(r.name)}" download>скачать</a> · <a href="#" id="openFolder">открыть папку</a>`;
    $('#openFolder').onclick = (e) => { e.preventDefault(); api('/api/open_folder', { method: 'POST', body: { path: r.path } }); };
  } catch (e) { $('#exportMsg').textContent = 'Ошибка экспорта: ' + e.message; }
}

/* ------------------------------------------------------------------ wiring */
function wire() {
  $$('#baseSeg button').forEach((b) => b.addEventListener('click', () => setBase(b.dataset.base)));
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
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $$('.export button').forEach((b) => b.addEventListener('click', () => doExport(b.dataset.fmt)));
  $('#btnRetrain').onclick = async () => {
    try { await api('/api/retrain', { method: 'POST', body: { run_id: S.runId } }); startPolling(); } catch (e) { alert(e.message); }
  };
  $('#btnSaveOpts').onclick = saveOpts;
}

window.addEventListener('DOMContentLoaded', async () => {
  initMap();
  wire();
  try { await loadSettings(); } catch (e) { console.warn(e); }
  try { await loadAreas(); } catch (e) { console.warn(e); }
  try { await loadRuns(); } catch (e) { console.warn(e); }
  const j = await api('/api/job').catch(() => ({ state: 'idle' }));
  renderJob(j);
  if (['running', 'paused', 'pending'].includes(j.state)) { S.runId = j.run_id; startPolling(); }
  loadModelInfo();
});
