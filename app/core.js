// Заброшки — ядро поиска для телефона (работает целиком в браузере, без ПК и сервера).
// Перенос логики настольной версии (zabroshki/osm.py, candidates.py, scoring.py, complexes.py) без нейросетей:
// теги заброшенности OSM (только относящиеся ко всему зданию), контекст (дачи, плотная застройка, парки, музеи,
// стройки, военные территории, населённые пункты), охрана (заборы, ворота, КПП, access), территории.
// Модуль без DOM: тот же код проверяется в Node на данных настольной версии.

/* ============================================================== OSM запросы */
const LC_KEYS = ['abandoned', 'disused', 'ruins'].concat(
  ...['abandoned', 'disused', 'ruins'].map((p) => ['building', 'amenity', 'railway', 'man_made', 'landuse', 'military',
    'shop', 'office', 'industrial', 'place', 'aeroway', 'power', 'tourism', 'leisure', 'historic'].map((k) => `${p}:${k}`)));
const LC_Q = LC_KEYS.map((k) => `  nwr["${k}"];`).join('\n');

export const OUT = '(node.a; way.a;); out tags geom qt;\nrel.a; out body geom qt;';
export const GROUPS = [
  ['context', LC_Q + `
  nwr["building"="ruins"]; nwr["historic"~"^(ruins|bunker|fort|military)$"];
  nwr["was:building"]; nwr["was:amenity"]; nwr["was:military"];
  nwr["military"];
  nwr["landuse"~"^(residential|allotments|industrial|commercial|retail|farmyard|garages|quarry|construction|landfill|railway|cemetery|military|brownfield)$"];
  nwr["man_made"~"^(water_tower|tower|chimney|works|silo|bunker_silo)$"];
  nwr["access"~"^(private|no|military|permit)$"]["highway"!~"."]["barrier"!~"."];
  nwr["barrier"]; nwr["building"="guardhouse"]; nwr["military"="checkpoint"]; nwr["amenity"="security"];
  node["place"]; way["place"];
`, 0.06],
  ['buildings', `
  way["building"]; relation["building"];
`, 0.035],
  ['leisure', `
  nwr["leisure"~"^(park|garden|nature_reserve|recreation_ground|playground|sports_centre|stadium)$"];
  nwr["boundary"="protected_area"];
  nwr["tourism"~"^(museum|attraction|zoo|theme_park|gallery|camp_site)$"];
  nwr["historic"~"^(monument|memorial|castle|manor|church|city_gate|citywalls|fort|archaeological_site)$"];
`, 0.12],
];

// публичные серверы Overpass (CORS разрешён); lz4/z — отдельные машины основного overpass-api.de
export const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
];
const host = (u) => u.split('/')[2];

export function chunks(s, w, n, e, stepLat) {
  // равные куски (без узких полосок по краю)
  const ny = Math.max(1, Math.ceil((n - s) / stepLat - 1e-9));
  const nx = Math.max(1, Math.ceil((e - w) / (stepLat * 2) - 1e-9));
  const out = [];
  for (let i = 0; i < ny; i++) {
    for (let j = 0; j < nx; j++) {
      const r = (v) => Math.round(v * 1e5) / 1e5;
      out.push([r(s + (n - s) * i / ny), r(w + (e - w) * j / nx), r(s + (n - s) * (i + 1) / ny), r(w + (e - w) * (j + 1) / nx)]);
    }
  }
  return out;
}

export function overpassQuery(body, bbox, timeout = 90) {
  const [s, w, n, e] = bbox;
  return `[out:json][timeout:${timeout}][bbox:${s},${w},${n},${e}];\n(\n${body}\n)->.a;\n${OUT}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Скачивает OSM для области. hooks: {fetch, cacheGet, cachePut, progress(done,total,msg), signal, log} */
export async function fetchOSM(bbox, hooks = {}) {
  const f = hooks.fetch || fetch;
  const m = 0.004;
  const [s0, w0, n0, e0] = bbox;
  const s = s0 - m, w = w0 - 2 * m, n = n0 + m, e = e0 + 2 * m;
  const plan = [];
  for (const [name, body, step] of GROUPS) for (const ch of chunks(s, w, n, e, step)) plan.push({ name, body, ch, n: plan.length + 1 });
  const byId = new Map();
  const failed = [];
  const penalty = new Map();
  let good = 0;
  let done = 0;

  // одна попытка на сервер, не больше 3 серверов на кусок: перегруженный сервер (504) обычно справляется с куском
  // поменьше, поэтому после неудач кусок сразу делится на 4 (до 3 раз), а не ждёт минутами
  const keyOf = async (body, ch) => 'ovp:' + await sha1(overpassQuery(body, ch));
  async function one(body, ch, label) {
    const q = overpassQuery(body, ch);
    const key = await keyOf(body, ch);
    if (hooks.cacheGet) {
      const c = await hooks.cacheGet(key);
      if (c) return c;
    }
    const errors = [];
    const t0 = Date.now();
    for (let attempt = 0; attempt < 3 && Date.now() - t0 < 4 * 60e3; attempt++) {
      if (hooks.signal?.aborted) throw new Error('отменено');
      const now = Date.now();
      const order = MIRRORS.map((u, i) => i).sort((a, b) =>
        ((penalty.get(MIRRORS[a]) || 0) > now) - ((penalty.get(MIRRORS[b]) || 0) > now)
        || ((a - good + MIRRORS.length) % MIRRORS.length) - ((b - good + MIRRORS.length) % MIRRORS.length));
      const i = order[0];
      const url = MIRRORS[i];
      const wait = (penalty.get(url) || 0) - now;
      if (wait > 0) {
        hooks.log?.(`OSM: все серверы заняты, жду ${Math.round(Math.min(wait, 30e3) / 1000)} с и пробую снова (${label})`);
        await sleep(Math.min(wait, 30e3));
      }
      hooks.log?.(`OSM: ${label} — запрос к ${host(url)}…`);
      try {
        const ctl = new AbortController();
        const tm = setTimeout(() => ctl.abort(), 100e3);
        const onAbort = () => ctl.abort();
        hooks.signal?.addEventListener('abort', onAbort);
        let r;
        try {
          r = await f(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), signal: ctl.signal,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        } finally { clearTimeout(tm); hooks.signal?.removeEventListener('abort', onAbort); }
        if (r.status === 429) throw new Error('429');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const txt = await r.text();
        if (!txt.trimStart().startsWith('{')) throw new Error('не JSON');
        const d = JSON.parse(txt);
        const rem = d.remark || '';
        if (rem.includes('runtime error') || rem.includes('timed out')) throw new Error(rem.slice(0, 120));
        good = i;
        penalty.delete(url);
        const els = d.elements || [];
        if (hooks.cachePut) await hooks.cachePut(key, els);
        return els;
      } catch (ex) {
        if (hooks.signal?.aborted) throw new Error('отменено');
        let msg = String(ex && ex.message || ex);
        if (/abort/i.test(msg)) msg = 'не ответил за 100 с';
        else if (msg.includes('429')) msg = 'слишком много запросов с вашего адреса (429; с VPN бывает чаще)';
        else if (/HTTP 50[234]/.test(msg)) msg = 'перегружен (' + msg + ')';
        else if (/fetch|network/i.test(msg)) msg = 'нет связи с сервером';
        errors.push(host(url) + ': ' + msg);
        hooks.log?.(`OSM: ${host(url)} ${msg} — пробую другой сервер (${label})`);
        penalty.set(url, Date.now() + (msg.includes('429') ? 60e3 : msg.includes('100 с') ? 180e3 : 20e3));
      }
    }
    throw new Error(errors.slice(-3).join('; '));
  }

  const GROUP_RU = { context: 'контекст', buildings: 'здания', leisure: 'парки и музеи' };
  async function split(item, depth) {
    try {
      return await one(item.body, item.ch, `запрос ${item.n} из ${plan.length}: ${GROUP_RU[item.name] || item.name}` + (depth ? `, часть ${'¼'.repeat(depth)}` : ''));
    } catch (ex) {
      if (hooks.signal?.aborted) throw ex;
      if (depth >= 3) { failed.push(item.name); return []; }
      hooks.log?.(`OSM: делю ${GROUP_RU[item.name] || item.name} на 4 части поменьше — так серверы отвечают охотнее`);
      const [s1, w1, n1, e1] = item.ch;
      const ml = (s1 + n1) / 2, mo = (w1 + e1) / 2;
      const res = [];
      const nFailed = failed.length;
      for (const ch of [[s1, w1, ml, mo], [s1, mo, ml, e1], [ml, w1, n1, mo], [ml, mo, n1, e1]]) {
        res.push(...await split({ ...item, ch }, depth + 1));
      }
      // все части скачались — запомнить и под исходным запросом (повторный поиск не начнёт с перегрузки сервера)
      if (failed.length === nFailed && hooks.cachePut) await hooks.cachePut(await keyOf(item.body, item.ch), res);
      return res;
    }
  }

  hooks.progress?.(0, plan.length, `Загрузка OSM: 0 из ${plan.length} запросов`);
  let next = 0;
  const par = hooks.parallel || 2;
  async function worker() {
    while (next < plan.length) {
      const it = plan[next++];
      const els = await split(it, 0);
      for (const el of els) byId.set(el.type + '/' + el.id, el);
      done++;
      hooks.progress?.(done, plan.length, `Загрузка OSM: готово ${done} из ${plan.length} запросов`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(par, plan.length) }, worker));
  return { elements: [...byId.values()], failed: [...new Set(failed)] };
}

async function sha1(s) {
  if (globalThis.crypto?.subtle) {
    const b = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
    return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return String(h);
}

/* ============================================================== геометрия */
// Геометрии в градусах: {type:'Point', c:[lon,lat]} | {type:'Line', c:[[lon,lat]..]} |
// {type:'Polygon', rings:[[[lon,lat]..], ..]} | {type:'MultiPolygon', polys:[rings, ..]}
export class LocalProj {
  constructor(lat0, lon0) { this.lat0 = lat0; this.lon0 = lon0; this.kx = 111320 * Math.cos(lat0 * Math.PI / 180); this.ky = 110574; }
  fwd(lon, lat) { return [(lon - this.lon0) * this.kx, (lat - this.lat0) * this.ky]; }
  inv(x, y) { return [this.lon0 + x / this.kx, this.lat0 + y / this.ky]; }
  geom(g) { // в метры (кэш на объекте)
    if (g._m && g._mp === this) return g._m;
    let m;
    const f = (c) => this.fwd(c[0], c[1]);
    if (g.type === 'Point') m = { type: 'Point', c: f(g.c) };
    else if (g.type === 'Line') m = { type: 'Line', c: g.c.map(f) };
    else if (g.type === 'Polygon') m = { type: 'Polygon', rings: g.rings.map((r) => r.map(f)) };
    else m = { type: 'MultiPolygon', polys: g.polys.map((rs) => rs.map((r) => r.map(f))) };
    m.bbox = bboxOf(m);
    Object.defineProperty(g, '_m', { value: m, writable: true, enumerable: false });
    Object.defineProperty(g, '_mp', { value: this, writable: true, enumerable: false });
    return m;
  }
}

function allCoords(g) {
  if (g.type === 'Point') return [g.c];
  if (g.type === 'Line') return g.c;
  if (g.type === 'Polygon') return g.rings[0];
  return g.polys.flatMap((p) => p[0]);
}
export function bboxOf(g) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of allCoords(g)) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
  return [a, b, c, d];
}
const isArea = (g) => g && (g.type === 'Polygon' || g.type === 'MultiPolygon');
const polysOf = (g) => (g.type === 'Polygon' ? [g.rings] : g.polys);

function ringArea(r) { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return Math.abs(s / 2); }
export function areaM(m) { if (!isArea(m)) return 0; let a = 0; for (const rs of polysOf(m)) { a += ringArea(rs[0]); for (const h of rs.slice(1)) a -= ringArea(h); } return Math.max(0, a); }
function inRing(p, r) {
  let ins = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
export function containsM(m, p) {
  if (!isArea(m)) return false;
  const b = m.bbox; if (p[0] < b[0] || p[0] > b[2] || p[1] < b[1] || p[1] > b[3]) return false;
  for (const rs of polysOf(m)) if (inRing(p, rs[0]) && !rs.slice(1).some((h) => inRing(p, h))) return true;
  return false;
}
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = dx * dx + dy * dy;
  let t = l ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function segments(m) {
  if (m.type === 'Line') return [m.c];
  if (m.type === 'Point') return [];
  return polysOf(m).flat();
}
/** расстояние от точки (метры) до геометрии (метры); 0 — внутри площади */
export function distPM(p, m) {
  if (m.type === 'Point') return Math.hypot(p[0] - m.c[0], p[1] - m.c[1]);
  if (isArea(m) && containsM(m, p)) return 0;
  let d = Infinity;
  for (const s of segments(m)) for (let i = 1; i < s.length; i++) { const v = segDist(p, s[i - 1], s[i]); if (v < d) d = v; }
  return d;
}
/** расстояние между геометриями (приближённо: по вершинам; 0 — если одна внутри другой) */
export function distMM(a, b) {
  if (a.type === 'Point') return distPM(a.c, b);
  if (b.type === 'Point') return distPM(b.c, a);
  let d = Infinity;
  for (const c of allCoordsFull(a)) { d = Math.min(d, distPM(c, b)); if (d === 0) return 0; }
  for (const c of allCoordsFull(b)) { d = Math.min(d, distPM(c, a)); if (d === 0) return 0; }
  return d;
}
function allCoordsFull(g) { if (g.type === 'Point') return [g.c]; if (g.type === 'Line') return g.c; return polysOf(g).flatMap((rs) => rs[0]); }
const bboxGap = (a, b) => Math.max(0, a[0] - b[2], b[0] - a[2], a[1] - b[3], b[1] - a[3]);
export function intersectsMM(a, b) { return bboxGap(a.bbox, b.bbox) === 0 && distMM(a, b) === 0; }

export function centroidM(m) {
  if (m.type === 'Point') return m.c;
  if (!isArea(m)) { const c = m.c; return c[Math.floor(c.length / 2)]; }
  let best = null, ba = -1;
  for (const rs of polysOf(m)) { const a = ringArea(rs[0]); if (a > ba) { ba = a; best = rs[0]; } }
  let x = 0, y = 0, a2 = 0;
  for (let i = 0, j = best.length - 1; i < best.length; j = i++) {
    const f = best[j][0] * best[i][1] - best[i][0] * best[j][1];
    x += (best[j][0] + best[i][0]) * f; y += (best[j][1] + best[i][1]) * f; a2 += f;
  }
  if (Math.abs(a2) < 1e-9) return best[0];
  return [x / (3 * a2), y / (3 * a2)];
}
/** точка гарантированно внутри площади (как shapely representative_point) */
export function repPointM(m) {
  const c = centroidM(m);
  if (!isArea(m) || containsM(m, c)) return c;
  const b = m.bbox, y = (b[1] + b[3]) / 2;
  const xs = [];
  for (const s of segments(m)) for (let i = 1; i < s.length; i++) {
    const [x1, y1] = s[i - 1], [x2, y2] = s[i];
    if ((y1 > y) !== (y2 > y)) xs.push(x1 + (y - y1) * (x2 - x1) / (y2 - y1));
  }
  xs.sort((p, q) => p - q);
  let bw = -1, bx = c[0];
  for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > bw) { bw = xs[i + 1] - xs[i]; bx = (xs[i] + xs[i + 1]) / 2; }
  return [bx, y];
}
export function convexHull(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** Сетка-индекс по bbox в метрах */
export class Grid {
  constructor(cell = 200) { this.cell = cell; this.m = new Map(); }
  add(item, bbox) {
    const c = this.cell;
    for (let i = Math.floor(bbox[0] / c); i <= Math.floor(bbox[2] / c); i++)
      for (let j = Math.floor(bbox[1] / c); j <= Math.floor(bbox[3] / c); j++) {
        const k = i + ',' + j; let a = this.m.get(k); if (!a) this.m.set(k, a = []); a.push(item);
      }
  }
  query(bbox, pad = 0) {
    const c = this.cell, out = new Set();
    for (let i = Math.floor((bbox[0] - pad) / c); i <= Math.floor((bbox[2] + pad) / c); i++)
      for (let j = Math.floor((bbox[1] - pad) / c); j <= Math.floor((bbox[3] + pad) / c); j++) {
        const a = this.m.get(i + ',' + j); if (a) for (const it of a) out.add(it);
      }
    return [...out];
  }
}

/* ============================================================== разбор элементов OSM */
function wayCoords(el) { return (el.geometry || []).filter(Boolean).map((p) => [p.lon, p.lat]); }
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
function joinRings(lines) {
  const parts = lines.map((l) => l.slice()).filter((l) => l.length >= 2);
  const rings = [];
  while (parts.length) {
    let cur = parts.shift();
    let grown = true;
    while (!same(cur[0], cur[cur.length - 1]) && grown) {
      grown = false;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const end = cur[cur.length - 1];
        if (same(end, p[0])) cur = cur.concat(p.slice(1));
        else if (same(end, p[p.length - 1])) cur = cur.concat(p.slice(0, -1).reverse());
        else if (same(cur[0], p[p.length - 1])) cur = p.concat(cur.slice(1));
        else if (same(cur[0], p[0])) cur = p.slice(1).reverse().concat(cur);
        else continue;
        parts.splice(i, 1); grown = true; break;
      }
    }
    if (cur.length >= 4 && same(cur[0], cur[cur.length - 1])) rings.push(cur);
  }
  return rings;
}
export function elementGeometry(el) {
  if (el.type === 'node') return el.lat != null ? { type: 'Point', c: [el.lon, el.lat] } : null;
  const tags = el.tags || {};
  if (el.type === 'way') {
    const c = wayCoords(el);
    if (c.length < 2) return el.center ? { type: 'Point', c: [el.center.lon, el.center.lat] } : null;
    const closed = c.length >= 4 && same(c[0], c[c.length - 1]);
    const isLine = tags.highway || (tags.barrier && tags.area !== 'yes');
    return closed && !isLine ? { type: 'Polygon', rings: [c] } : { type: 'Line', c };
  }
  if (el.type === 'relation') {
    if (el.center) return { type: 'Point', c: [el.center.lon, el.center.lat] };
    const outers = [], inners = [];
    for (const m of el.members || []) {
      if (m.type !== 'way' || !m.geometry) continue;
      const c = m.geometry.filter(Boolean).map((p) => [p.lon, p.lat]);
      if (c.length >= 2) (m.role === 'inner' ? inners : outers).push(c);
    }
    const os = joinRings(outers);
    if (!os.length) {
      if (el.bounds) { const b = el.bounds; return { type: 'Point', c: [(b.minlon + b.maxlon) / 2, (b.minlat + b.maxlat) / 2] }; }
      return null;
    }
    const is = joinRings(inners);
    const polys = os.map((o) => [o]);
    for (const h of is) {
      const p = polys.find((rs) => inRing(h[0], rs[0]));
      if (p) p.push(h);
    }
    return polys.length === 1 ? { type: 'Polygon', rings: polys[0] } : { type: 'MultiPolygon', polys };
  }
  return null;
}

/* ============================================================== правила тегов (osm.py) */
const CONSTR_WORDS = ['строительство', 'стройка', 'стройплощад', 'жилой комплекс', 'жк ', 'жк ', 'реконструкция'];
export function isConstruction(t) {
  if (t.landuse === 'construction' || t.building === 'construction') return true;
  if (t.construction != null && t.construction !== 'no' && !t.highway) return true;
  if ('building' in t) return false;
  const txt = ' ' + ['name', 'description', 'note'].map((k) => t[k] || '').join(' ').toLowerCase() + ' ';
  return CONSTR_WORDS.some((w) => txt.includes(w));
}
const LC_PREFIXES = ['abandoned', 'disused', 'ruins'];
const GONE_PREFIXES = ['was', 'demolished', 'removed', 'razed', 'destroyed'];
const WHOLE_AMENITY = new Set(['school', 'kindergarten', 'childcare', 'hospital', 'clinic', 'sanatorium', 'cinema', 'theatre',
  'community_centre', 'library', 'prison', 'university', 'college', 'townhall', 'social_facility', 'nursing_home',
  'place_of_worship', 'monastery', 'fire_station', 'police', 'bus_station', 'arts_centre', 'public_bath', 'courthouse',
  'events_venue', 'dormitory', 'conference_centre']);
const SITE_MAN_MADE = new Set(['works', 'water_tower', 'tower', 'chimney', 'silo', 'bunker_silo', 'lighthouse',
  'pumping_station', 'wastewater_plant', 'water_works', 'gasometer', 'kiln', 'observatory', 'mineshaft', 'storage_tank']);
const SITE = {
  amenity: WHOLE_AMENITY, man_made: SITE_MAN_MADE,
  tourism: new Set(['hotel', 'motel', 'hostel', 'guest_house', 'chalet', 'alpine_hut', 'camp_site', 'museum']),
  leisure: new Set(['sports_centre', 'stadium', 'resort', 'ice_rink', 'sports_hall', 'summer_camp']),
  historic: new Set(['ruins', 'fort', 'bunker', 'castle', 'manor', 'monastery', 'military', 'church']),
  railway: new Set(['station']), aeroway: new Set(['hangar', 'terminal']),
};
const FEATURE_KEYS = new Set(['building', 'amenity', 'shop', 'office', 'craft', 'man_made', 'railway', 'highway', 'barrier',
  'power', 'military', 'landuse', 'leisure', 'tourism', 'historic', 'aeroway', 'waterway', 'place', 'industrial', 'cuisine',
  'healthcare', 'club', 'public_transport', 'bridge', 'emergency', 'vending', 'atm']);
function siteFeature(base, v) {
  if (['building', 'military', 'landuse', 'industrial'].includes(base)) return true;
  return !!(SITE[base] && SITE[base].has(v));
}
function partition(k) { const i = k.indexOf(':'); return i < 0 ? [k, ''] : [k.slice(0, i), k.slice(i + 1)]; }
function features(t) {
  const out = [];
  for (const [k, v] of Object.entries(t)) {
    const [pre, base] = partition(k);
    const key = base && (LC_PREFIXES.includes(pre) || GONE_PREFIXES.includes(pre)) ? base : k;
    if (FEATURE_KEYS.has(key)) out.push([key, v]);
  }
  return out;
}
/** теги заброшенности, относящиеся ко всему зданию/территории (закрытый магазин в жилом доме — нет) */
export function siteLifecycle(t) {
  const feats = features(t);
  const siteFeat = feats.some(([b, v]) => siteFeature(b, v));
  const out = {};
  for (const [k, v] of Object.entries(t)) {
    if (v === 'no' || v === 'false') continue;
    if (LC_PREFIXES.includes(k)) { if (siteFeat || !feats.length) out[k] = v; continue; }
    const [pre, base] = partition(k);
    if (LC_PREFIXES.includes(pre) && base && siteFeature(base.split(':')[0], v)) out[k] = v;
  }
  return out;
}
export function isLifecycle(t) {
  if (t.landuse === 'brownfield' && isConstruction(t)) return false;
  if (Object.keys(siteLifecycle(t)).length) return true;
  return t.building === 'ruins' || t.historic === 'ruins' || t.landuse === 'brownfield';
}
export function lifecycleStrength(t) {
  let best = 0, why = '';
  const take = (w, s) => { if (w > best) { best = w; why = s; } };
  const site = siteLifecycle(t);
  for (const [k, v] of Object.entries(t)) {
    const kv = `${k}=${v}`;
    const [pre, base] = partition(k);
    if (k === 'building' && v === 'ruins') take(3.2, 'OSM: building=ruins (руины)');
    else if (k === 'historic' && v === 'ruins') take(3.0, 'OSM: historic=ruins');
    else if (k in site && (pre === 'ruins' || pre === 'abandoned')) take(3.0, `OSM: ${kv}` + (pre === 'abandoned' ? ' (заброшено)' : ''));
    else if (k in site && pre === 'disused') take(2.2, `OSM: ${kv} (не используется)`);
    else if (k === 'landuse' && v === 'brownfield' && !isConstruction(t)) take(1.6, 'OSM: landuse=brownfield (заброшенная промплощадка)');
    else if (pre === 'was' && base && 'building' in t && base !== 'building' && siteFeature(base, v)) take(0.8, `OSM: ${kv} (здание раньше использовалось иначе)`);
    else if (k === 'building' && ['collapsed', 'damaged', 'abandoned'].includes(v)) take(3.0, `OSM: ${kv}`);
    else if (k === 'condition' && ['deficient', 'poor', 'ruins'].includes(v)) take(1.5, `OSM: ${kv}`);
  }
  return [best, why];
}
export function tagsType(t, ctx = {}) {
  const b = t.building || '';
  const vals = Object.entries(t).map(([k, v]) => `${k}=${v}`).join(' ');
  const has = (list) => list.some((x) => vals.includes(`building=${x}`) || vals.includes(`:building=${x}`));
  if (b === 'ruins' || t.historic === 'ruins' || 'ruins' in t || Object.keys(t).some((k) => k.startsWith('ruins:'))) return 'ruins';
  if ('military' in t || t.landuse === 'military' || vals.includes('military') || ctx.in_military) return 'military';
  if (t.landuse === 'brownfield' && !('building' in t)) return 'area';
  if (has(['farm', 'farm_auxiliary', 'barn', 'cowshed', 'stable', 'greenhouse', 'sty', 'hangar', 'silo']) || ctx.in_farmyard) return 'farm';
  if (has(['industrial', 'warehouse', 'factory', 'manufacture', 'works', 'storage_tank', 'service', 'garages', 'transformer_tower', 'hangar', 'boathouse'])
      || ctx.in_industrial || ['works', 'chimney', 'water_tower', 'silo'].includes(t.man_made)) return 'industrial';
  if (has(['house', 'detached', 'residential', 'apartments', 'cabin', 'hut', 'bungalow', 'semidetached_house', 'terrace', 'dacha', 'farmhouse', 'static_caravan'])
      || ctx.in_allotments || ctx.in_residential) return 'house';
  if (t.landuse || (!b && Object.keys(t).length)) return 'area';
  return 'building';
}
export function title(t) {
  const name = t.name || t.old_name || t['was:name'] || '';
  const parts = name ? [name] : [];
  for (const k of ['building', 'abandoned:building', 'disused:building', 'ruins:building', 'historic', 'military', 'landuse',
    'man_made', 'amenity', 'abandoned:amenity', 'disused:amenity']) {
    if (k in t && t[k] !== 'yes') { parts.push(`${k}=${t[k]}`); break; }
  }
  if (!parts.length && t.building) parts.push('building=' + t.building);
  return parts.join(', ').slice(0, 80);
}
const SETTLEMENT_RADIUS = { city: 3500, town: 1800, village: 700, hamlet: 300, isolated_dwelling: 90, suburb: 900,
  quarter: 500, neighbourhood: 350, allotments: 350, farm: 150, locality: 0 };
export const NOT_BUILDINGS = new Set(['castle_wall', 'wall', 'city_wall', 'roof', 'carport', 'bridge', 'construction',
  'grandstand', 'ship', 'train_station_roof']);

export function parse(elements) {
  const d = { buildings: [], lifecycle: [], military: [], landuse: {}, places: [], barriersLine: [], barriersNode: [],
    guardObjs: [], accessAreas: [], towers: [] };
  const addLu = (cls, g, tags, id) => { (d.landuse[cls] ||= []).push({ g, tags, id }); };
  for (const el of elements) {
    const tags = el.tags; if (!tags) continue;
    const id = el.type + '/' + el.id;
    let g; const geom = () => (g === undefined ? (g = elementGeometry(el)) : g);
    if ('building' in tags && (el.type === 'way' || el.type === 'relation') && geom()) d.buildings.push({ id, g: geom(), tags });
    if ((isLifecycle(tags) || ['collapsed', 'damaged', 'abandoned'].includes(tags.building)) && geom()) d.lifecycle.push({ id, g: geom(), tags });
    if (('military' in tags || tags.landuse === 'military') && geom()) d.military.push({ id, g: geom(), tags });
    let lu = tags.landuse;
    if (lu === 'brownfield' && isConstruction(tags)) lu = 'construction';
    if (lu && isArea(geom())) addLu(lu, geom(), tags, id);
    let extra = null;
    if (['park', 'garden', 'recreation_ground', 'playground', 'sports_centre', 'stadium'].includes(tags.leisure)) extra = 'park';
    else if (tags.leisure === 'nature_reserve' || tags.boundary === 'protected_area') extra = 'protected';
    else if (['museum', 'zoo', 'theme_park', 'gallery'].includes(tags.tourism)) extra = 'museum';
    if (extra && isArea(geom())) addLu(extra, geom(), tags, id);
    if ('place' in tags && geom()) {
      const r = SETTLEMENT_RADIUS[tags.place] || 0;
      if (r) d.places.push({ g: geom(), place: tags.place, name: tags.name || '', r });
      if (isArea(geom()) && ['city', 'town', 'village', 'hamlet', 'suburb', 'quarter', 'neighbourhood'].includes(tags.place)) addLu('place_area', geom(), tags, id);
    }
    if ('barrier' in tags && geom()) (geom().type === 'Point' ? d.barriersNode : d.barriersLine).push({ g: geom(), tags, id });
    if ((tags.building === 'guardhouse' || tags.military === 'checkpoint' || tags.amenity === 'security') && geom()) d.guardObjs.push({ g: geom(), tags, id });
    if (['private', 'no', 'military', 'permit'].includes(tags.access) && !tags.highway && !tags.barrier && isArea(geom())) d.accessAreas.push({ g: geom(), tags, id });
  }
  return d;
}

/* ============================================================== контекст (candidates.Context) */
const FENCE_TYPES = new Set(['fence', 'wall', 'city_wall', 'retaining_wall', 'guard_rail', 'hedge', 'jersey_barrier', 'chain', 'barbed_wire', 'concrete_fence']);
const STRONG_FENCES = new Set(['fence', 'wall', 'city_wall', 'barbed_wire', 'concrete_fence']);
const GATE_TYPES = new Set(['gate', 'lift_gate', 'swing_gate', 'sliding_gate', 'border_control', 'toll_booth', 'turnstile',
  'full-height_turnstile', 'bump_gate', 'hampshire_gate', 'entrance', 'kissing_gate']);
const STRONG_GATES = new Set(['lift_gate', 'border_control', 'full-height_turnstile', 'toll_booth']);
const LU_CLASSES = ['residential', 'allotments', 'industrial', 'commercial', 'retail', 'farmyard', 'garages', 'military',
  'brownfield', 'quarry', 'construction', 'railway', 'cemetery', 'landfill', 'place_area', 'park', 'protected', 'museum'];

class Index {
  constructor(lp, items, cell = 250) {
    this.items = items; this.lp = lp; this.grid = new Grid(cell);
    for (const it of items) { it.m = lp.geom(it.g); this.grid.add(it, it.m.bbox); }
  }
  containing(p) { return this.grid.query([p[0], p[1], p[0], p[1]]).filter((it) => containsM(it.m, p)); }
  within(m, dist) {
    const out = [];
    for (const it of this.grid.query(m.bbox, dist)) {
      if (bboxGap(it.m.bbox, m.bbox) > dist) continue;
      const d = distMM(it.m, m);
      if (d <= dist) out.push([it, d]);
    }
    return out;
  }
}

export class Context {
  constructor(d, lp) {
    this.lp = lp;
    this.landuse = {};
    for (const [cls, items] of Object.entries(d.landuse)) this.landuse[cls] = new Index(lp, items, 500);
    this.places = d.places.map((p) => ({ ...p, c: centroidM(lp.geom(p.g)) }));
    this.fences = new Index(lp, d.barriersLine.filter((b) => FENCE_TYPES.has(b.tags.barrier)));
    this.gateNodes = new Index(lp, d.barriersNode.filter((b) => GATE_TYPES.has(b.tags.barrier)));
    this.gateLines = new Index(lp, d.barriersLine.filter((b) => GATE_TYPES.has(b.tags.barrier)));
    this.guard = new Index(lp, d.guardObjs);
    this.access = new Index(lp, d.accessAreas, 500);
    this.military = new Index(lp, d.military, 500);
    this.buildings = new Index(lp, d.buildings.map((b) => ({ ...b, c: centroidM(lp.geom(b.g)) })), 150);
  }
  landuseAt(p) {
    const out = {};
    for (const [cls, idx] of Object.entries(this.landuse)) { const h = idx.containing(p); if (h.length) out[cls] = h[0].tags; }
    return out;
  }
  settlement(p) {
    let best = null;
    for (const s of this.places) {
      const d = Math.hypot(s.c[0] - p[0], s.c[1] - p[1]);
      if (d <= s.r && (!best || d / s.r < best[0])) best = [d / s.r, s.place, s.name];
    }
    return best;
  }
  countBuildings(p, r) {
    let n = 0, act = 0;
    for (const b of this.buildings.grid.query([p[0], p[1], p[0], p[1]], r)) {
      if (Math.hypot(b.c[0] - p[0], b.c[1] - p[1]) <= r) {
        n++;
        if (['shop', 'amenity', 'office', 'craft'].some((k) => k in b.tags) && !isLifecycle(b.tags)) act++;
      }
    }
    return [n, act];
  }
  features(p, m, ownTags) {
    const f = {};
    const lu = this.landuseAt(p);
    f.landuse = Object.keys(lu).sort();
    for (const cls of LU_CLASSES) f['in_' + cls] = cls in lu;
    f.industrial_disused = !!(lu.industrial && isLifecycle(lu.industrial));
    const st = this.settlement(p);
    f.near_place = st ? st[1] : null;
    f.near_place_name = st ? st[2] : null;
    f.in_settlement = !!(f.in_residential || f.in_place_area || (st && ['city', 'town', 'village', 'suburb', 'quarter', 'neighbourhood'].includes(st[1])));
    f.in_dacha = !!(f.in_allotments || (st && st[1] === 'allotments'));
    f.outside_settlement = !(f.in_settlement || f.in_dacha || f.in_industrial || f.in_commercial || f.in_retail || f.in_garages);
    const mil = this.military.containing(p).concat(this.military.within(m, 30).map((x) => x[0]));
    f.in_military = mil.length > 0 || f.in_military;
    f.military_disused = mil.some((x) => isLifecycle(x.tags));
    f.military_tags = [...new Set(mil.filter((x) => x.tags.military).map((x) => 'military=' + x.tags.military))].sort().slice(0, 4);
    const fences = this.fences.within(m, 35);
    f.fence_near = fences.length;
    f.fence_strong = fences.some(([x]) => STRONG_FENCES.has(x.tags.barrier));
    f.enclosed_by_fence = fences.some(([x]) => {
      const c = x.m.type === 'Line' ? x.m.c : null;
      return c && c.length >= 4 && same(c[0], c[c.length - 1]) && inRing(p, c);
    });
    const gates = this.gateNodes.within(m, 150).concat(this.gateLines.within(m, 150));
    f.gates = [...new Set(gates.map(([x]) => x.tags.barrier))].sort();
    f.gate_dist = gates.length ? Math.min(...gates.map((g) => g[1])) : null;
    f.strong_gate = gates.some(([x]) => STRONG_GATES.has(x.tags.barrier));
    const guards = this.guard.within(m, 200);
    f.guardhouse = guards.length > 0;
    f.guardhouse_dist = guards.length ? Math.min(...guards.map((g) => g[1])) : null;
    const accA = this.access.containing(p);
    f.access = (ownTags && ownTags.access) || (accA.length ? accA[0].tags.access : null);
    const [n80, act] = this.countBuildings(p, 80);
    f.osm_buildings_80m = n80;
    f.active_neighbours = act;
    f.footprints_100m = this.countBuildings(p, 100)[0];   // в телефонной версии нет контуров Microsoft — считаем по OSM
    return f;
  }
}

/* ============================================================== кандидаты */
const BUILDINGISH = ['building', 'abandoned:building', 'disused:building', 'ruins:building', 'abandoned:amenity', 'disused:amenity',
  'abandoned:military', 'disused:military', 'abandoned:man_made', 'disused:man_made', 'abandoned:industrial', 'disused:industrial'];
export function buildingLike(t, m) {
  if (['barrier', 'highway', 'railway', 'power', 'waterway'].some((k) => k in t) && !('building' in t)) return false;
  if (!isLifecycle(t) && !('military' in t) && t.landuse !== 'military') return false;
  if (t.historic && !['ruins', 'fort', 'bunker', 'military'].includes(t.historic) && !t.building) return false;
  if (BUILDINGISH.some((k) => k in t) || ['ruins', 'fort', 'bunker'].includes(t.historic) || t.ruins
      || ['bunker', 'barracks', 'checkpoint', 'office'].includes(t.military)
      || ['water_tower', 'tower', 'chimney', 'works', 'silo', 'bunker_silo'].includes(t.man_made)) {
    return isArea(m) ? areaM(m) >= 15 : true;
  }
  return isArea(m) ? areaM(m) >= 300 : false;
}

function newCand(key, g, lp, kind, tags, sources) {
  const m = lp.geom(g);
  const p = repPointM(m);
  const [lon, lat] = lp.inv(p[0], p[1]);
  return { key, lat, lon, kind, title: title(tags), g: isArea(g) ? g : null, tags: { ...tags }, sources: new Set(sources),
    osm_ids: [], f: {}, score: 0, reasons: [], guard: 'yellow', guard_reasons: [], p };
}

export function assemble(d, areaLL, lp) {
  const areaM_ = lp.geom(areaLL);
  const inArea = (p) => distPM(p, areaM_) <= 30;
  const cands = new Map();
  const bldById = new Map();
  for (const b of d.buildings) {
    const c = newCand('osm:' + b.id, b.g, lp, 'building', b.tags, ['OSM']);
    if (!inArea(c.p)) continue;
    c.osm_ids.push(b.id);
    cands.set(c.key, c); bldById.set(b.id, c);
  }
  const bg = new Grid(150);
  for (const c of cands.values()) if (c.g) bg.add(c, lp.geom(c.g).bbox);
  const seen = new Set();
  for (const obj of d.lifecycle.concat(d.military)) {
    if (seen.has(obj.id) || bldById.has(obj.id)) continue;
    seen.add(obj.id);
    const m = lp.geom(obj.g);
    const p = repPointM(m);
    if (!inArea(p)) continue;
    let merged = false;
    if (obj.g.type === 'Point') {
      for (const tgt of bg.query([p[0], p[1], p[0], p[1]], 2)) {
        if (distPM(p, lp.geom(tgt.g)) <= 2) {
          for (const [k, v] of Object.entries(obj.tags)) if (!GONE_PREFIXES.some((g) => k.startsWith(g + ':')) && !(k in tgt.tags)) tgt.tags[k] = v;
          tgt.osm_ids.push(obj.id); merged = true;
        }
      }
    } else if (isArea(m) && areaM(m) > 0) {
      const inside = bg.query(m.bbox).filter((tgt) => intersectsMM(lp.geom(tgt.g), m));
      for (const tgt of inside) {
        tgt.parent_tags = { ...(tgt.parent_tags || {}) };
        for (const [k, v] of Object.entries(obj.tags)) if (k !== 'name') tgt.parent_tags[k] = v;
        tgt.parent_lifecycle = Math.max(tgt.parent_lifecycle || 0, lifecycleStrength(obj.tags)[0]);
      }
      if (inside.length && areaM(m) > 3000) merged = true;
    }
    if (merged || !buildingLike(obj.tags, m)) continue;
    const c = newCand('osm:' + obj.id, obj.g, lp, tagsType(obj.tags), obj.tags, ['OSM']);
    c.osm_ids.push(obj.id);
    cands.set(c.key, c);
  }
  return [...cands.values()];
}

export function computeContext(cands, ctx) {
  const lp = ctx.lp;
  for (const c of cands) {
    const m = c.g ? lp.geom(c.g) : { type: 'Point', c: c.p, bbox: [c.p[0], c.p[1], c.p[0], c.p[1]] };
    const f = ctx.features(c.p, m, c.tags);
    if (c.g) f.area_m2 = Math.round(areaM(m) * 10) / 10;
    Object.assign(c.f, f);
    if (c.kind === 'building') c.kind = tagsType(c.tags, { in_military: f.in_military, in_farmyard: f.in_farmyard,
      in_industrial: f.in_industrial, in_allotments: f.in_dacha, in_residential: f.in_settlement });
  }
}

/* ============================================================== балл (scoring.py без признаков по снимку) */
export const WEIGHTS = {
  bias: -2.0,   // без нейросетей: объект с тегом заброшенности OSM и без минусов получает ~0,6–0,8
  osm_lifecycle: 3.0, military_disused: 1.0, military_ctx: 0.3, outside: 0.5, farm: 0.3, industrial: 0.1,
  isolated: 0.3, dacha: 0.0, settlement: -0.5, dense: -0.8, active_neighbours: -0.8, garages: -1.5, park: -2.5,
  museum: -2.5, construction: -2.0, protected: -0.5, monument: -2.0, cemetery: -1.5,
};
const CONTEXT_GROUP = ['outside', 'isolated', 'farm', 'industrial', 'military_ctx'];
const ORDINARY_GROUP = ['settlement', 'dense', 'active_neighbours', 'protected'];
export const DENSE_N = 12;
export const denseCluster = (f) => Math.max(f.footprints_100m || 0, Math.floor(1.5 * (f.osm_buildings_80m || 0))) >= DENSE_N;

export function featureVector(c) {
  const f = c.f, t = c.tags, x = {};
  let [lc, why] = lifecycleStrength(t);
  const plc = c.sources.has('OSM') ? (c.parent_lifecycle || 0) : 0;
  if (plc && plc * 0.7 > lc) {
    const pt = c.parent_tags || {};
    const keys = Object.keys(pt).filter((k) => isLifecycle({ [k]: pt[k] })).slice(0, 2);
    lc = plc * 0.7; why = 'Внутри территории с OSM-тегом заброшенности (' + (keys.map((k) => `${k}=${pt[k]}`).join(', ') || 'территория') + ')';
  }
  if (lc) x.osm_lifecycle = [lc / 3, why];
  if (f.in_military) {
    if (f.military_disused) x.military_disused = [1, 'Бывшая военная территория (OSM)'];
    else x.military_ctx = [1, 'Военная территория/объект в OSM ' + (f.military_tags || []).join(' ')];
  }
  const dense = denseCluster(f);
  if (f.outside_settlement && !dense) x.outside = [1, 'Вне населённых пунктов и садоводств'];
  else if (f.in_dacha && !dense) x.dense = [0.6, 'В садоводстве (дачи) — участки обычно используются'];
  if (dense && !f.in_settlement) x.dense = [1, 'Плотная застройка вокруг (похоже на садоводство/посёлок)'];
  if (['garage', 'garages', 'carport'].includes(t.building) || t.amenity === 'parking' || f.in_garages || String(t['disused:building'] || '').includes('garage'))
    x.garages = [1, 'Гаражи — обычно используются, выглядят «заброшенно» из-за ржавых крыш'];
  if (f.in_settlement) x.settlement = [1, 'В населённом пункте' + (f.near_place_name ? ` (${f.near_place_name})` : '')];
  if (f.in_park) x.park = [1, 'Внутри парка/сквера (OSM) — действующая территория'];
  if (f.in_museum) x.museum = [1, 'Музей/заповедник-музей (OSM) — действующая территория'];
  if (f.in_protected) x.protected = [1, 'Охраняемая природная территория/заповедник'];
  if ((f.in_construction || isConstruction(t)) && lc < 2.2) x.construction = [1, 'Стройплощадка (OSM) — территория используется'];
  if (f.in_cemetery) x.cemetery = [1, 'Кладбище'];
  const hist = t.historic;
  if (hist && !['ruins', 'fort', 'bunker', 'military'].includes(hist) && lc < 2.2) x.monument = [1, `Памятник/исторический объект (historic=${hist}) — обычно ухоженный`];
  if (c.kind === 'farm') x.farm = [1, 'Сельхоз-постройка / ферма'];
  if (c.kind === 'industrial' || f.in_industrial) x.industrial = [1, 'Промышленная постройка/зона'];
  if (f.outside_settlement && (f.footprints_100m ?? 99) <= 2) x.isolated = [1, 'Одиночная постройка (соседей ≤2 в 100 м)'];
  if (f.active_neighbours) x.active_neighbours = [Math.min(f.active_neighbours, 3) / 3, 'Рядом действующие объекты (магазины/учреждения)'];
  return x;
}

export function score(c, W = WEIGHTS) {
  const x = featureVector(c);
  const contrib = {};
  for (const [k, [v]] of Object.entries(x)) contrib[k] = (W[k] || 0) * v;
  const notes = {};
  const pos = CONTEXT_GROUP.reduce((s, k) => s + Math.max(0, contrib[k] || 0), 0);
  if (pos > 0.9) for (const k of CONTEXT_GROUP) if ((contrib[k] || 0) > 0) { contrib[k] *= 0.9 / pos; notes[k] = ' *'; }
  // явный тег заброшенности: «вокруг город/дома/магазины» не должно перевешивать его (на ПК это уравновешивают снимки)
  if (lifecycleStrength(c.tags)[0] >= 2.2) {
    const neg = ORDINARY_GROUP.reduce((s, k) => s + Math.min(0, contrib[k] || 0), 0);
    if (neg < -0.8) for (const k of ORDINARY_GROUP) if ((contrib[k] || 0) < 0) { contrib[k] *= -0.8 / neg; notes[k] = ' *'; }
  }
  const z = W.bias + Object.values(contrib).reduce((a, b) => a + b, 0);
  const reasons = Object.entries(x).map(([k, [, text]]) => ({ w: Math.round(contrib[k] * 100) / 100, text: text + (notes[k] || ''), k }));
  reasons.sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  return [1 / (1 + Math.exp(-z)), reasons];
}

/** противоречия (как scoring.confirmation, только по OSM) */
export function contradictions(c) {
  const f = c.f, t = c.tags, lc = lifecycleStrength(t)[0], neg = [];
  if (f.in_park) neg.push('парк/сквер — действующая территория');
  if (f.in_museum) neg.push('музей/заповедник-музей');
  if (f.in_construction) neg.push('стройплощадка');
  if (t.historic && !['ruins', 'fort', 'bunker', 'military'].includes(t.historic) && lc < 2.2) neg.push(`памятник (historic=${t.historic})`);
  return neg;
}

/** «Надёжная метка» телефонной версии: тег заброшенности OSM на самом здании и ничего не противоречит */
export function reliable(c) {
  const t = c.tags, lc = lifecycleStrength(t)[0];
  if (c.f.contra && c.f.contra.length) return false;
  if (NOT_BUILDINGS.has(t.building)) return false;
  return lc >= 2.2 && !['deadend', 'clearing', 'area'].includes(c.kind)
    && !!(c.g || t.historic === 'ruins' || t.ruins || t.building);
}

/* ============================================================== охрана (scoring.guard_status без снимков) */
export function guardStatus(c) {
  const f = c.f, t = c.tags, strong = [], weak = [];
  if (f.in_military && !f.military_disused) strong.push([2.0, 'Действующая военная территория по OSM ' + (f.military_tags || []).join(' ')]);
  const acc = t.access || f.access;
  if (['private', 'no', 'military', 'permit'].includes(acc)) strong.push([1.5, `Доступ ограничен: access=${acc}`]);
  if (f.guardhouse) strong.push([2.0, `Будка охраны/КПП в ${Math.round(f.guardhouse_dist || 0)} м`]);
  if (f.strong_gate) strong.push([1.2, `Шлагбаум/КПП в ${Math.round(f.gate_dist || 0)} м`]);
  if (f.in_military && f.military_disused) weak.push([0.3, 'Бывшая военная территория']);
  if (f.enclosed_by_fence) weak.push([1.0, 'Объект внутри замкнутого забора/стены (OSM barrier)']);
  else if (f.fence_strong) weak.push([0.8, 'Забор или стена ближе 35 м (OSM barrier)']);
  else if (f.fence_near) weak.push([0.3, 'Рядом ограждение (OSM barrier)']);
  if (f.gates && f.gates.length && !f.strong_gate) weak.push([0.4, `Ворота (${f.gates.join(', ')}) в ${Math.round(f.gate_dist || 0)} м`]);
  if (f.in_industrial && !f.industrial_disused) weak.push([0.6, 'Действующая промзона (landuse=industrial)']);
  if (f.in_commercial || f.in_retail) weak.push([0.5, 'Коммерческая территория']);
  if (f.active_neighbours) weak.push([0.4, 'Рядом действующие объекты']);
  if (f.in_settlement || denseCluster(f)) weak.push([0.3, 'Рядом жилые дома/участки — есть люди']);
  const sc = c.score || 0;
  const k = sc >= 0.7 || lifecycleStrength(t)[0] >= 2.2 ? 0.5 : 1.0;
  const sPts = strong.reduce((a, [w]) => a + w, 0), wPts = weak.reduce((a, [w]) => a + w, 0) * k;
  const R = strong.map(([w, text]) => ({ w, text })).concat(weak.map(([w, text]) => ({ w: Math.round(w * k * 100) / 100,
    text: text + (k < 1 ? ' (объект заброшен — ограждение могло разрушиться, вес ×0.5)' : '') })));
  if (strong.length && sPts + wPts >= 2.0) return ['red', R];
  const need = denseCluster(f) || f.in_dacha || f.in_settlement ? 0.6 : 0.35;
  if (!strong.length && wPts < 1.0 && sc >= need) {
    const G = [{ w: 0, text: weak.length ? `Только слабые признаки ограждения (сумма ${wPts.toFixed(1)} < 1) — на месте проверьте`
      : 'Ограждений, ворот и КПП рядом в OSM нет' }];
    return ['green', G.concat(R)];
  }
  if (!R.length) R.push({ w: 0, text: 'Данных об охране нет — по умолчанию «неясно»' });
  else if (!strong.length) R.push({ w: 0, text: 'Сильных признаков охраны (КПП, шлагбаум, действующая часть, access=private) нет' });
  else R.push({ w: 0, text: `Признаков охраны недостаточно для красного (сумма ${(sPts + wPts).toFixed(1)} < 2)` });
  return ['yellow', R];
}

export function apply(cands, W = WEIGHTS) {
  for (const c of cands) {
    if (c.kind === 'complex') continue;
    [c.score, c.reasons] = score(c, W);
    c.f.contra = contradictions(c);
    c.f.reliable = reliable(c);
    c.f.confirm = lifecycleStrength(c.tags)[0] >= 2.2 ? ['OSM: объект отмечен как заброшенный/руины'] : [];
    [c.guard, c.guard_reasons] = guardStatus(c);
  }
}

/** мелкие пристройки (<120 м²) рядом с крупным зданием — части одного объекта */
export function absorbAnnexes(cands, lp, radius = 40, small = 120) {
  const big = cands.filter((c) => c.g && (c.f.area_m2 || 0) >= small);
  const g = new Grid(100);
  for (const c of big) g.add(c, lp.geom(c.g).bbox);
  const out = [];
  let n = 0;
  for (const c of cands) {
    const a = c.f.area_m2 || 0;
    if (!c.g || a >= small || a === 0 || c.f.reliable) { out.push(c); continue; }
    const m = lp.geom(c.g);
    let best = null, bd = radius;
    for (const o of g.query(m.bbox, radius)) {
      if ((o.f.area_m2 || 0) < 2 * a || o.score < c.score - 0.1) continue;
      const d = distMM(lp.geom(o.g), m);
      if (d <= bd) { best = o; bd = d; }
    }
    if (!best) { out.push(c); continue; }
    n++; best.f.annexes = (best.f.annexes || 0) + 1;
  }
  cands.length = 0; cands.push(...out);
  return n;
}

/* ============================================================== территории (complexes.py) */
const nBuildings = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'здание' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'здания' : 'зданий'}`;
function guardOf(mem) {
  const gs = mem.map((m) => m.guard);
  if (gs.includes('red')) return 'red';
  return gs.filter((g) => g === 'green').length > gs.length / 2 ? 'green' : 'yellow';
}
export function buildComplexes(cands, lp) {
  for (const c of cands) delete c.f.complex_key;
  const blds = cands.filter((c) => c.g && !['deadend', 'clearing', 'area', 'complex'].includes(c.kind));
  const grid = new Grid(100);
  blds.forEach((c, i) => { c._i = i; grid.add(c, lp.geom(c.g).bbox); });
  const groups = [], used = new Set(), terrOf = new Map();
  const terrs = cands.filter((c) => c.g && ['area', 'military', 'industrial'].includes(c.kind) && isLifecycle(c.tags)
    && !('building' in c.tags) && !isConstruction(c.tags) && !c.f.in_construction);
  for (const t of terrs) {
    const tm = lp.geom(t.g);
    if (areaM(tm) < 1500) continue;
    const idx = grid.query(tm.bbox).filter((c) => c !== t && !used.has(c._i) && intersectsMM(lp.geom(c.g), tm)).map((c) => c._i);
    if (idx.length) { groups.push(idx); idx.forEach((i) => used.add(i)); terrOf.set(groups.length - 1, t); }
  }
  const seeds = blds.filter((c) => c.score >= 0.35 && !used.has(c._i)).map((c) => c._i);
  const seedSet = new Set(seeds);
  const parent = new Map(seeds.map((i) => [i, i]));
  const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  for (const i of seeds) {
    const m = lp.geom(blds[i].g);
    for (const o of grid.query(m.bbox, 40)) {
      if (!seedSet.has(o._i) || o._i === i) continue;
      if (distMM(lp.geom(o.g), m) <= 40) parent.set(find(o._i), find(i));
    }
  }
  const cl = new Map();
  for (const i of seeds) { const r = find(i); if (!cl.has(r)) cl.set(r, []); cl.get(r).push(i); }
  for (const mem of cl.values()) if (mem.length >= 2) groups.push(mem);
  const out = [];
  groups.forEach((members, gi) => {
    const mem = members.map((i) => blds[i]);
    const terr = terrOf.get(gi);
    let g, tags = {};
    if (terr) { g = terr.g; tags = { ...terr.tags }; }
    else {
      const pts = mem.flatMap((m) => allCoordsFull(lp.geom(m.g)));
      const hull = convexHull(pts);
      const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length, cy = hull.reduce((s, p) => s + p[1], 0) / hull.length;
      const ring = hull.map(([x, y]) => { const d = Math.hypot(x - cx, y - cy) || 1; return lp.inv(x + (x - cx) / d * 6, y + (y - cy) / d * 6); });
      ring.push(ring[0]);
      g = { type: 'Polygon', rings: [ring] };
    }
    let best = mem.reduce((a, b) => (b.score > a.score ? b : a));
    if (terr && terr.score > best.score) best = terr;
    const nRel = mem.filter((m) => m.f.reliable).length;
    const kinds = {};
    for (const m of mem) if (!['house', 'building', 'unmapped'].includes(m.kind)) kinds[m.kind] = (kinds[m.kind] || 0) + 1;
    const top = Object.entries(kinds).sort((a, b) => b[1] - a[1])[0];
    const what = { military: 'военный объект', farm: 'ферма', industrial: 'промзона', ruins: 'руины' }[top ? top[0] : ''] || 'постройки';
    const cx = newCand('cx:' + mem.map((m) => m.key).sort()[0], g, lp, 'complex', tags, [...new Set(mem.flatMap((m) => [...m.sources]))]);
    cx.title = (terr && terr.title ? terr.title + ' — ' : '') + `${what}, ${nBuildings(mem.length)}`;
    const nStrong = mem.filter((m) => m.score >= 0.5).length;
    cx.score = Math.min(0.99, Math.max(best.score, terr ? terr.score : 0) + 0.03 * Math.max(0, nStrong - 1));
    cx.f = { members: mem.map((m) => m.key), n_members: mem.length, n_reliable: nRel, area_m2: Math.round(areaM(lp.geom(g))),
      confirm: [...new Set(mem.flatMap((m) => m.f.confirm || []))].slice(0, 6), reliable: nRel > 0 || !!(terr && terr.f.reliable),
      in_settlement: best.f.in_settlement, near_place_name: best.f.near_place_name };
    cx.reasons = [{ w: 0, text: `Территория: ${nBuildings(mem.length)}, с высоким баллом ${nStrong}, надёжных ${nRel}`, k: 'complex' }]
      .concat(best.reasons.slice(0, 6).map((r) => ({ ...r, text: 'Лучшее здание: ' + r.text })));
    cx.guard = guardOf(mem);
    const cnt = {}; for (const m of mem) cnt[m.guard] = (cnt[m.guard] || 0) + 1;
    cx.guard_reasons = [{ w: 0, text: 'По зданиям комплекса: ' + Object.entries(cnt).map(([k, v]) => `${k} ${v}`).join(', ') }].concat(best.guard_reasons.slice(0, 5));
    for (const m of mem) m.f.complex_key = cx.key;
    if (terr) terr.f.complex_key = cx.key;
    out.push(cx);
  });
  for (const c of blds) delete c._i;
  return out;
}

/* ============================================================== весь поиск */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** areaLL: Polygon в градусах. hooks — как в fetchOSM + elements (готовые элементы OSM, для тестов) */
export async function search(areaLL, hooks = {}) {
  const t0 = Date.now();
  const st = (msg, d = 0, n = 0) => hooks.progress?.(d, n, msg);
  const b = bboxOf(areaLL);
  const lp = new LocalProj((b[1] + b[3]) / 2, (b[0] + b[2]) / 2);
  let elements = hooks.elements, failed = [];
  if (!elements) ({ elements, failed } = await fetchOSM([b[1], b[0], b[3], b[2]], hooks));
  const tOsm = Date.now();
  st('Разбор данных OSM…'); await tick();
  const d = parse(elements);
  await tick();
  const cands = assemble(d, areaLL, lp);
  st('Контекст: дачи, парки, заборы, военные территории…', 0, cands.length); await tick();
  const ctx = new Context(d, lp);
  const B = 400;
  for (let i = 0; i < cands.length; i += B) {
    computeContext(cands.slice(i, i + B), ctx);
    st('Контекст: дачи, парки, заборы, военные территории…', Math.min(i + B, cands.length), cands.length);
    if (hooks.signal?.aborted) throw new Error('отменено');
    await tick();
  }
  apply(cands, hooks.weights || WEIGHTS);
  const nAnnex = absorbAnnexes(cands, lp);
  apply(cands, hooks.weights || WEIGHTS);
  const complexes = buildComplexes(cands, lp);
  const all = cands.concat(complexes);
  // на телефоне храним только то, что может пригодиться: всё с тегами OSM, военное, территории и балл ≥ 0,3
  const keep = all.filter((c) => c.score >= (hooks.minScore ?? 0.3) || c.f.reliable || c.f.complex_key || c.kind === 'complex'
    || c.f.in_military || lifecycleStrength(c.tags)[0] > 0 || c.parent_lifecycle);
  const stats = { osm_elements: elements.length, osm_failed: failed, osm_buildings: d.buildings.length, candidates: cands.length,
    kept: keep.length, reliable: keep.filter((c) => c.f.reliable && !c.f.complex_key).length, complexes: complexes.length,
    annexes: nAnnex, osm_s: Math.round((tOsm - t0) / 1000), total_s: Math.round((Date.now() - t0) / 1000) };
  return { cands: keep, stats };
}

/** компактная форма для хранения/показа (геометрия — GeoJSON) */
export function toPlain(c) {
  const gj = (g) => (!g ? null : g.type === 'Polygon' ? { type: 'Polygon', coordinates: g.rings }
    : g.type === 'MultiPolygon' ? { type: 'MultiPolygon', coordinates: g.polys } : null);
  const f = { ...c.f };
  delete f.landuse;
  return { key: c.key, lat: +c.lat.toFixed(6), lon: +c.lon.toFixed(6), kind: c.kind, title: c.title, tags: c.tags,
    sources: [...c.sources], f, score: +c.score.toFixed(4), reasons: c.reasons, guard: c.guard, guard_reasons: c.guard_reasons,
    footprint: gj(c.g) };
}
