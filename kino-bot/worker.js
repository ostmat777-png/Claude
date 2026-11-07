/*
 * Кино-бот для Telegram: бот + мини-приложение с плеером.
 * Один файл для Cloudflare Workers, ставится и настраивается с телефона (см. README.md).
 *
 * Источники (только легальные):
 *   • Internet Archive: фильмы в общественном достоянии (вышли не позже чем 96 лет назад,
 *     из курируемых коллекций архива) и архив Прелинджера;
 *   • ваша медиатека Jellyfin (необязательно): ваши фильмы и сериалы, выбор озвучки (аудиодорожки),
 *     качества и субтитров.
 *
 * Переменные (Settings → Variables and Secrets):
 *   BOT_TOKEN          токен от @BotFather (обязательно, тип Secret)
 *   ALLOWED_USERS      Telegram ID через запятую: бот только для них (нужно для Jellyfin)
 *   JELLYFIN_URL       https-адрес сервера Jellyfin
 *   JELLYFIN_USER      пользователь Jellyfin (лучше отдельный, без прав администратора)
 *   JELLYFIN_PASSWORD  его пароль (тип Secret)
 *   PUBLIC_URL         свой домен для мини-приложения, если *.workers.dev не открывается
 */

const VERSION = '1.0.0';
const HLS_JS = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js';

// Курируемые коллекции архива. Из них берём только то, что вышло до PD_YEAR включительно
// (в США фильм переходит в общественное достояние 1 января через 95 лет после выхода).
const IA_PD_COLLECTIONS = ['feature_films', 'silent_films', 'SciFi_Horror', 'Comedy_Films', 'Film_Noir',
  'classic_cartoons', 'animationandcartoons'];
// Коллекции, где всё свободное независимо от года.
const IA_FREE_COLLECTIONS = ['prelinger'];

function pdYear() { return new Date().getUTCFullYear() - 96; }

function iaBaseFilter() {
  return 'mediatype:movies AND ((collection:(' + IA_PD_COLLECTIONS.join(' OR ') + ') AND year:[1880 TO ' + pdYear() +
    ']) OR collection:(' + IA_FREE_COLLECTIONS.join(' OR ') + '))';
}

function iaPdOnly(extra) {
  return 'mediatype:movies AND collection:(' + IA_PD_COLLECTIONS.join(' OR ') + ') AND year:[1880 TO ' + pdYear() + ']' +
    (extra ? ' AND ' + extra : '');
}

const IA_PRESETS = {
  popular: { title: 'Популярное', q: () => iaPdOnly(), sort: 'downloads desc' },
  talkies: { title: 'Первые звуковые фильмы', q: () => iaPdOnly('year:[1927 TO ' + pdYear() + '] AND NOT collection:silent_films'), sort: 'num_favorites desc' },
  silent: { title: 'Немое кино', q: () => iaPdOnly('collection:silent_films'), sort: 'num_favorites desc' },
  rus: { title: 'Русское и советское кино', q: () => iaPdOnly('language:(rus OR russian OR Russian)'), sort: 'num_favorites desc' },
  horror: { title: 'Фантастика и ужасы', q: () => iaPdOnly('collection:SciFi_Horror'), sort: 'num_favorites desc' },
  comedy: { title: 'Комедии', q: () => iaPdOnly('collection:Comedy_Films'), sort: 'num_favorites desc' },
  cartoons: { title: 'Мультфильмы', q: () => iaPdOnly('collection:(classic_cartoons OR animationandcartoons)'), sort: 'num_favorites desc' },
  prelinger: { title: 'Архив Прелинджера (документальное)', q: () => 'mediatype:movies AND collection:prelinger', sort: 'num_favorites desc' },
};
const HOME_PRESETS = ['popular', 'rus', 'talkies', 'silent', 'horror', 'comedy', 'cartoons', 'prelinger'];

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env || {}, ctx);
    } catch (e) {
      const status = e && e.status || 500;
      if (status >= 500) console.error(e && e.stack || e);
      return json({ error: e && e.message || String(e) }, status);
    }
  },
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const c = cfg(env);

  if (path === '/tg') {
    if (request.method !== 'POST') return new Response('Webhook ждёт POST от Telegram', { status: 405 });
    return handleWebhook(request, c, ctx);
  }
  if (path === '/setup') return handleSetup(request, c);
  if (path === '/' || path === '/index.html') {
    return new Response(APP_HTML, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
    });
  }
  if (path === '/favicon.ico') return new Response(null, { status: 204 });

  if (path.startsWith('/api/')) {
    if (path === '/api/sub') return handleSub(url, c);
    const access = await apiAccess(request, c);
    if (path === '/api/home') return json(await apiHome(c, access));
    if (path === '/api/search') return json(await apiSearch(url, c, access));
    if (path === '/api/item') return json(await apiItem(url, c, access));
    if (path === '/api/play') return json(await apiPlay(url, c, access));
    throw new HttpError(404, 'Нет такого метода');
  }
  return new Response('Не найдено', { status: 404 });
}

function cfg(env) {
  const allowed = String(env.ALLOWED_USERS || '').split(/[\s,;]+/).filter(Boolean);
  const jfUrl = String(env.JELLYFIN_URL || '').trim().replace(/\/+$/, '');
  const jfUser = String(env.JELLYFIN_USER || '').trim();
  return {
    token: String(env.BOT_TOKEN || '').trim(),
    allowed,
    restricted: allowed.length > 0,
    // Медиатека доступна только при закрытом боте: в ссылки на видео попадает токен пользователя Jellyfin.
    jf: jfUrl && jfUser ? { url: jfUrl, user: jfUser, pass: String(env.JELLYFIN_PASSWORD || '') } : null,
    publicUrl: String(env.PUBLIC_URL || '').trim().replace(/\/+$/, ''),
  };
}

// ---------------------------------------------------------------- crypto / utils

const te = new TextEncoder();

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? te.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, typeof data === 'string' ? te.encode(data) : data));
}

async function sha256hex(s) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(s))));
}

function hex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function randomHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return hex(b);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stripHtml(s) {
  if (Array.isArray(s)) s = s.join('\n');
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

function first(v) { return Array.isArray(v) ? v[0] : v; }

async function getJson(url, init, cacheTtl) {
  const opts = Object.assign({}, init);
  if (cacheTtl) opts.cf = { cacheTtl, cacheEverything: true };
  const r = await fetch(url, opts);
  if (!r.ok) throw new HttpError(502, 'Источник ответил ошибкой ' + r.status);
  return r.json();
}

// ---------------------------------------------------------------- доступ

/** Проверка подписи Telegram WebApp initData. Возвращает объект user или null. */
async function verifyInitData(initData, botToken, maxAgeSec = 7 * 86400) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  const pairs = [];
  for (const [k, v] of params) if (k !== 'hash') pairs.push([k, v]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const dataCheck = pairs.map(([k, v]) => k + '=' + v).join('\n');
  const secret = await hmac('WebAppData', botToken);
  const calc = hex(await hmac(secret, dataCheck));
  if (!safeEqual(calc, hash)) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;
  try { return JSON.parse(params.get('user') || 'null'); } catch { return null; }
}

async function apiAccess(request, c) {
  const user = await verifyInitData(request.headers.get('X-Tg-Init') || '', c.token);
  const allowed = !!user && c.allowed.includes(String(user.id));
  if (c.restricted && !allowed) {
    throw new HttpError(401, user
      ? 'Нет доступа. Попросите владельца бота добавить ваш ID ' + user.id + ' в ALLOWED_USERS.'
      : 'Откройте кинотеатр через бота в Telegram.');
  }
  return { user, jf: !!(c.jf && c.restricted && allowed) };
}

// ---------------------------------------------------------------- Internet Archive

const IA_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function translit(s) {
  return s.toLowerCase().replace(/[а-яё]/g, (ch) => TRANSLIT[ch] ?? ch);
}

function cleanQuery(q) {
  return String(q || '').replace(/[+\-&|!(){}\[\]^"~*?:\\/<>=]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

function iaPoster(id) { return 'https://archive.org/services/img/' + encodeURIComponent(id); }

function iaYear(doc) {
  const y = first(doc.year) || String(first(doc.date) || '').slice(0, 4);
  const n = parseInt(y, 10);
  return n > 1800 && n < 3000 ? n : null;
}

async function iaQuery(query, sort, page, rows) {
  const p = new URLSearchParams({ q: query, rows: String(rows), page: String(page), output: 'json' });
  for (const f of ['identifier', 'title', 'year', 'date']) p.append('fl[]', f);
  if (sort) p.append('sort[]', sort);
  const d = await getJson('https://archive.org/advancedsearch.php?' + p, null, 3600);
  const resp = d.response || { docs: [], numFound: 0 };
  const items = (resp.docs || []).filter((x) => IA_ID_RE.test(x.identifier || '')).map((x) => ({
    src: 'ia', id: x.identifier, title: stripHtml(first(x.title)) || x.identifier, year: iaYear(x), poster: iaPoster(x.identifier),
  }));
  return { items, more: page * rows < (resp.numFound || 0), total: resp.numFound || 0 };
}

function iaSearch(q, page, rows = 24) {
  const terms = cleanQuery(q);
  if (!terms) return { items: [], more: false, total: 0 };
  const variants = [terms];
  const tr = translit(terms);
  if (tr !== terms.toLowerCase()) variants.push(tr);
  const query = '(' + variants.map((v) => 'title:(' + v + ')').join(' OR ') + ') AND ' + iaBaseFilter();
  return iaQuery(query, 'num_favorites desc', page, rows);
}

function iaPreset(name, page, rows = 24) {
  const p = IA_PRESETS[name];
  if (!p) throw new HttpError(404, 'Нет такой подборки');
  return iaQuery(p.q(), p.sort, page, rows);
}

/** Можно ли показывать этот элемент архива (та же проверка, что и при поиске). */
function iaAllowed(meta) {
  const cols = [].concat(meta.collection || []);
  if (cols.some((x) => IA_FREE_COLLECTIONS.includes(x))) return true;
  const year = iaYear(meta);
  return !!year && year <= pdYear() && cols.some((x) => IA_PD_COLLECTIONS.includes(x));
}

const IA_FORMAT_RANK = { 'h.264': 1, 'h.264 HD': 1, 'h.264 IA': 2, '512Kb MPEG4': 3, 'HiRes MPEG4': 4, 'MPEG4': 5, 'WebM': 6 };

function iaFileUrl(id, name) {
  return 'https://archive.org/download/' + encodeURIComponent(id) + '/' + name.split('/').map(encodeURIComponent).join('/');
}

function baseName(name) { return name.replace(/^.*\//, '').replace(/\.[^.]+$/, ''); }

function subLabel(name) {
  const n = name.toLowerCase();
  if (/\.asr\.(srt|vtt)$/.test(n)) return 'Авто (англ.)';
  if (/(^|[._\-\s])(ru|rus|russian)([._\-\s]|$)/.test(n)) return 'Русские';
  if (/(^|[._\-\s])(en|eng|english)([._\-\s]|$)/.test(n)) return 'English';
  return baseName(name).slice(0, 40);
}

/** Метаданные элемента архива; бросает 403, если элемент не из общественного достояния. */
async function iaMeta(id) {
  if (!IA_ID_RE.test(id)) throw new HttpError(400, 'Неверный id');
  const d = await getJson('https://archive.org/metadata/' + encodeURIComponent(id), null, 86400);
  if (!d || !d.metadata) throw new HttpError(404, 'Фильм не найден в архиве');
  if (!iaAllowed(d.metadata)) throw new HttpError(403, 'Этот фильм не входит в общественное достояние, его здесь нет.');
  return d;
}

async function iaItem(id) {
  const d = await iaMeta(id);
  const meta = d.metadata;

  const files = Array.isArray(d.files) ? d.files : [];
  const groups = new Map();
  for (const f of files) {
    const name = String(f.name || '');
    if (!/\.(mp4|m4v|webm)$/i.test(name)) continue;
    const key = f.source === 'derivative' && f.original ? String(f.original) : name;
    if (!groups.has(key)) groups.set(key, { key, files: [], title: null });
    groups.get(key).files.push(f);
  }
  for (const f of files) {
    if (f.title && groups.has(f.name)) groups.get(f.name).title = stripHtml(f.title);
  }
  const subs = files.filter((f) => /\.(srt|vtt)$/i.test(String(f.name || '')));

  const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  const parts = keys.map((key) => {
    const g = groups.get(key);
    const byLabel = new Map();
    for (const f of g.files) {
      const h = parseInt(f.height, 10) || (f.format === '512Kb MPEG4' ? 240 : 0);
      const label = h ? h + 'p' : 'Оригинал';
      const rank = IA_FORMAT_RANK[f.format] || 7;
      const prev = byLabel.get(label);
      if (!prev || rank < prev.rank) byLabel.set(label, { label, h, rank, url: iaFileUrl(id, f.name) });
    }
    const qualities = [...byLabel.values()]
      .sort((a, b) => (b.h || 99999) - (a.h || 99999) || a.rank - b.rank)
      .map(({ label, h, url }) => ({ label, h, url }));
    const b = baseName(key).toLowerCase();
    const subtitles = subs
      .filter((s) => keys.length === 1 || baseName(s.name).toLowerCase().startsWith(b))
      .map((s) => ({ label: subLabel(s.name), url: '/api/sub?src=ia&id=' + encodeURIComponent(id) + '&f=' + encodeURIComponent(s.name) }));
    const ep = keys.length > 1 ? (g.title || baseName(key).replace(/[_]+/g, ' ').trim()) : null;
    return { id: key, title: ep, play: { qualities, audio: [], subtitles } };
  }).filter((p) => p.play.qualities.length);

  return {
    src: 'ia', id,
    title: stripHtml(first(meta.title)) || id,
    year: iaYear(meta),
    description: stripHtml(meta.description).slice(0, 3000),
    poster: iaPoster(id),
    genres: [],
    kind: parts.length > 1 ? 'series' : 'movie',
    parts,
    source: 'Internet Archive · общественное достояние',
    sourceUrl: 'https://archive.org/details/' + encodeURIComponent(id),
  };
}

function srtToVtt(text) {
  const body = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (/^WEBVTT/.test(body)) return body;
  return 'WEBVTT\n\n' + body.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}

// ---------------------------------------------------------------- Jellyfin

let JF_AUTH = null;
const JF_CACHE_URL = 'https://kino-bot.internal/jellyfin-auth/';

function jfHeader(deviceId, token) {
  return 'MediaBrowser Client="KinoBot", Device="Telegram bot", DeviceId="' + deviceId + '", Version="' + VERSION + '"' +
    (token ? ', Token="' + token + '"' : '');
}

/**
 * Вход в Jellyfin. Токен общий для всех копий воркера: хранится в памяти и в кэше Cloudflare.
 * У каждой новой авторизации свой DeviceId, иначе Jellyfin отзывает предыдущий токен и обрывает
 * уже идущий просмотр.
 */
async function jfAuth(c, force) {
  const cacheKey = JF_CACHE_URL + (await sha256hex(c.jf.url + '|' + c.jf.user + '|' + c.jf.pass));
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (!force && JF_AUTH && JF_AUTH.key === cacheKey) return JF_AUTH;
  if (!force && cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) {
      JF_AUTH = Object.assign(await hit.json(), { key: cacheKey });
      return JF_AUTH;
    }
  }
  const deviceId = 'kinobot-' + randomHex(6);
  const r = await fetch(c.jf.url + '/Users/AuthenticateByName', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: jfHeader(deviceId) },
    body: JSON.stringify({ Username: c.jf.user, Pw: c.jf.pass }),
  });
  if (!r.ok) throw new HttpError(502, 'Jellyfin не пустил (' + r.status + '). Проверьте JELLYFIN_URL, JELLYFIN_USER и JELLYFIN_PASSWORD.');
  const d = await r.json();
  const auth = { token: d.AccessToken, userId: d.User && d.User.Id, deviceId };
  if (!auth.token || !auth.userId) throw new HttpError(502, 'Jellyfin вернул странный ответ на вход');
  if (cache) {
    await cache.put(cacheKey, new Response(JSON.stringify(auth), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=2592000' },
    })).catch(() => {});
  }
  JF_AUTH = Object.assign(auth, { key: cacheKey });
  return JF_AUTH;
}

async function jfFetch(c, method, path, params, body, raw) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const a = await jfAuth(c, attempt > 0);
    const u = new URL(c.jf.url + path);
    for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, String(v));
    if (!raw) u.searchParams.set('userId', a.userId);
    const r = await fetch(u.toString(), {
      method,
      headers: { Authorization: jfHeader(a.deviceId, a.token), 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    if (r.status === 401 && attempt === 0) continue;
    if (!r.ok) throw new HttpError(502, 'Jellyfin ответил ошибкой ' + r.status);
    return { res: r, auth: a };
  }
  throw new HttpError(502, 'Jellyfin не принимает токен');
}

async function jfJson(c, method, path, params, body) {
  const { res, auth } = await jfFetch(c, method, path, params, body, false);
  return { data: await res.json(), auth };
}

const JF_ID_RE = /^[0-9a-fA-F-]{32,36}$/;

function jfImg(c, id) { return c.jf.url + '/Items/' + id + '/Images/Primary?maxHeight=450&quality=85'; }

function jfCard(c, it) {
  return { src: 'jf', id: it.Id, title: it.Name, year: it.ProductionYear || null, poster: jfImg(c, it.Id), kind: it.Type === 'Series' ? 'series' : 'movie' };
}

async function jfList(c, params, page, rows = 24) {
  const { data } = await jfJson(c, 'GET', '/Items', Object.assign({
    IncludeItemTypes: 'Movie,Series', Recursive: 'true', Limit: rows, StartIndex: (page - 1) * rows,
    Fields: 'ProductionYear', EnableImageTypes: 'Primary', ImageTypeLimit: 1,
  }, params));
  const items = (data.Items || []).map((it) => jfCard(c, it));
  return { items, more: page * rows < (data.TotalRecordCount || 0), total: data.TotalRecordCount || 0 };
}

function jfSearch(c, q, page) {
  const term = String(q || '').trim().slice(0, 100);
  if (!term) return { items: [], more: false, total: 0 };
  return jfList(c, { searchTerm: term }, page);
}

function jfLatest(c, page, rows = 16) {
  return jfList(c, { SortBy: 'DateCreated', SortOrder: 'Descending' }, page, rows);
}

async function jfItem(c, id) {
  if (!JF_ID_RE.test(id)) throw new HttpError(400, 'Неверный id');
  const { data } = await jfJson(c, 'GET', '/Items', { ids: id, Fields: 'Overview,Genres,ProductionYear' });
  const it = data.Items && data.Items[0];
  if (!it) throw new HttpError(404, 'Не найдено в медиатеке');
  const item = {
    src: 'jf', id: it.Id, title: it.Name, year: it.ProductionYear || null,
    description: it.Overview || '', poster: jfImg(c, it.Id), genres: (it.Genres || []).slice(0, 4),
    source: 'Моя медиатека', sourceUrl: null,
  };
  if (it.Type === 'Series') {
    const { data: eps } = await jfJson(c, 'GET', '/Shows/' + it.Id + '/Episodes', { Fields: 'Overview' });
    item.kind = 'series';
    item.parts = (eps.Items || []).map((e) => ({
      id: e.Id, title: e.Name, season: e.ParentIndexNumber ?? null, ep: e.IndexNumber ?? null,
    }));
  } else {
    item.kind = 'movie';
    item.parts = [{ id: it.Id, title: null }];
  }
  return item;
}

function jfAudioLabel(s) {
  const lang = s.Language ? s.Language.toUpperCase() : '';
  const t = s.Title || '';
  if (t) return lang && !t.toUpperCase().includes(lang) ? t + ' · ' + lang : t;
  return s.DisplayTitle || lang || 'Дорожка ' + s.Index;
}

const JF_LADDER = [[2160, 20000000], [1440, 12000000], [1080, 8000000], [720, 4000000], [480, 1500000], [360, 800000]];

async function jfPlay(c, id) {
  if (!JF_ID_RE.test(id)) throw new HttpError(400, 'Неверный id');
  const { data, auth } = await jfJson(c, 'POST', '/Items/' + id + '/PlaybackInfo', {}, {});
  const ms = (data.MediaSources || [])[0];
  if (!ms) throw new HttpError(404, 'У этого элемента нет видео');
  const streams = ms.MediaStreams || [];
  const video = streams.find((s) => s.Type === 'Video');
  const height = video && video.Height || 0;

  const base = new URLSearchParams({
    MediaSourceId: ms.Id, PlaySessionId: data.PlaySessionId || randomHex(16), ApiKey: auth.token,
    VideoCodec: 'h264', AudioCodec: 'aac', MaxAudioChannels: '2', TranscodingMaxAudioChannels: '2', AudioBitrate: '192000',
    SegmentContainer: 'ts', MinSegments: '1', BreakOnNonKeyFrames: 'true', AllowAudioStreamCopy: 'true',
    EnableAdaptiveBitrateStreaming: 'false', RequireAvc: 'false',
  });
  const hlsBase = c.jf.url + '/Videos/' + id + '/master.m3u8?' + base.toString();

  const qualities = [{
    label: height ? 'Оригинал ' + height + 'p' : 'Оригинал', h: height || 100000,
    params: 'AllowVideoStreamCopy=true&VideoBitrate=200000000',
  }];
  for (const [h, br] of JF_LADDER) {
    if (height && h >= height) continue;
    qualities.push({ label: h + 'p', h, params: 'AllowVideoStreamCopy=false&MaxHeight=' + h + '&VideoBitrate=' + br });
  }

  const audio = streams.filter((s) => s.Type === 'Audio').map((s) => ({
    label: jfAudioLabel(s), lang: (s.Language || '').toLowerCase(), def: !!s.IsDefault, params: 'AudioStreamIndex=' + s.Index,
  }));

  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const subtitles = [];
  for (const s of streams) {
    if (s.Type !== 'Subtitle' || !s.IsTextSubtitleStream) continue;
    const sig = await subSig(c, id, ms.Id, s.Index, exp);
    subtitles.push({
      label: s.Title || s.DisplayTitle || (s.Language || 'Субтитры').toUpperCase(),
      lang: (s.Language || '').toLowerCase(),
      url: '/api/sub?src=jf&id=' + id + '&ms=' + encodeURIComponent(ms.Id) + '&i=' + s.Index + '&exp=' + exp + '&sig=' + sig,
    });
  }
  return { hlsBase, qualities, audio, subtitles, duration: ms.RunTimeTicks ? ms.RunTimeTicks / 1e7 : null };
}

async function subSig(c, id, ms, i, exp) {
  return hex(await hmac('kinobot-sub:' + c.token, ['jfsub', id, ms, i, exp].join('|'))).slice(0, 32);
}

// ---------------------------------------------------------------- API

async function apiHome(c, access) {
  const tasks = HOME_PRESETS.map((name) => iaPreset(name, 1, 16)
    .then((r) => ({ id: name, title: IA_PRESETS[name].title, items: r.items, preset: name }))
    .catch(() => null));
  if (access.jf) {
    tasks.unshift(jfLatest(c, 1)
      .then((r) => ({ id: 'jf-latest', title: 'Моя медиатека: новое', items: r.items, preset: 'jf-latest' }))
      .catch((e) => ({ id: 'jf-error', title: 'Моя медиатека', items: [], error: e.message })));
  }
  const sections = (await Promise.all(tasks)).filter((s) => s && (s.items.length || s.error));
  return { jf: access.jf, pdYear: pdYear(), sections };
}

async function apiSearch(url, c, access) {
  const q = url.searchParams.get('q') || '';
  const page = Math.max(1, Math.min(50, parseInt(url.searchParams.get('page'), 10) || 1));
  const preset = url.searchParams.get('preset');
  const src = url.searchParams.get('src') || 'all';
  if (preset === 'jf-latest') {
    if (!access.jf) throw new HttpError(403, 'Медиатека недоступна');
    return jfLatest(c, page, 24);
  }
  if (preset) return iaPreset(preset, page);
  return searchAll(q, c, access.jf && src !== 'ia', src !== 'jf', page);
}

async function searchAll(q, c, useJf, useIa, page) {
  const tasks = [];
  const errors = [];
  if (useJf) tasks.push(jfSearch(c, q, page).catch((e) => { errors.push('Медиатека: ' + e.message); return null; }));
  if (useIa) tasks.push(iaSearch(q, page).catch((e) => { errors.push('Архив: ' + e.message); return null; }));
  const res = (await Promise.all(tasks)).filter(Boolean);
  return {
    items: res.flatMap((r) => r.items),
    more: res.some((r) => r.more),
    errors,
  };
}

async function apiItem(url, c, access) {
  const src = url.searchParams.get('src');
  const id = url.searchParams.get('id') || '';
  if (src === 'ia') return iaItem(id);
  if (src === 'jf') {
    if (!access.jf) throw new HttpError(403, 'Медиатека недоступна');
    return jfItem(c, id);
  }
  throw new HttpError(400, 'Неизвестный источник');
}

async function apiPlay(url, c, access) {
  const src = url.searchParams.get('src');
  const id = url.searchParams.get('id') || '';
  if (src === 'jf') {
    if (!access.jf) throw new HttpError(403, 'Медиатека недоступна');
    return jfPlay(c, id);
  }
  throw new HttpError(400, 'Неизвестный источник');
}

async function handleSub(url, c) {
  const src = url.searchParams.get('src');
  let text;
  if (src === 'ia') {
    const id = url.searchParams.get('id') || '';
    const f = url.searchParams.get('f') || '';
    if (!IA_ID_RE.test(id) || !/\.(srt|vtt)$/i.test(f) || f.includes('..')) throw new HttpError(400, 'Неверные параметры');
    const d = await iaMeta(id);
    if (!(d.files || []).some((x) => x.name === f)) throw new HttpError(404, 'Субтитры не найдены');
    const r = await fetch(iaFileUrl(id, f), { cf: { cacheTtl: 86400, cacheEverything: true } });
    if (!r.ok) throw new HttpError(404, 'Субтитры не найдены');
    text = await r.text();
  } else if (src === 'jf') {
    if (!c.jf || !c.restricted) throw new HttpError(403, 'Медиатека недоступна');
    const id = url.searchParams.get('id') || '';
    const ms = url.searchParams.get('ms') || '';
    const i = url.searchParams.get('i') || '';
    const exp = url.searchParams.get('exp') || '';
    if (!JF_ID_RE.test(id) || !/^[0-9a-zA-Z-]{1,64}$/.test(ms) || !/^\d{1,4}$/.test(i) || !/^\d{1,12}$/.test(exp)) {
      throw new HttpError(400, 'Неверные параметры');
    }
    if (Number(exp) < Date.now() / 1000) throw new HttpError(403, 'Ссылка устарела, откройте фильм заново');
    if (!safeEqual(await subSig(c, id, ms, i, exp), url.searchParams.get('sig') || '')) throw new HttpError(403, 'Неверная подпись');
    const { res } = await jfFetch(c, 'GET', '/Videos/' + id + '/' + ms + '/Subtitles/' + i + '/0/Stream.vtt', {}, null, true);
    text = await res.text();
  } else {
    throw new HttpError(400, 'Неизвестный источник');
  }
  return new Response(srtToVtt(text), {
    headers: { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'private, max-age=3600' },
  });
}

// ---------------------------------------------------------------- Telegram

async function tg(c, method, body) {
  const r = await fetch('https://api.telegram.org/bot' + c.token + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const d = await r.json().catch(() => ({ ok: false, description: 'HTTP ' + r.status }));
  if (!d.ok) console.error('Telegram ' + method + ': ' + d.description);
  return d;
}

function webhookSecret(token) { return sha256hex('kinobot-webhook:' + token).then((h) => h.slice(0, 48)); }

function appUrl(origin, params) {
  const qs = new URLSearchParams(params || {}).toString();
  return origin + '/' + (qs ? '?' + qs : '');
}

async function handleWebhook(request, c, ctx) {
  if (!c.token) return new Response('BOT_TOKEN не задан', { status: 500 });
  if (!safeEqual(request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '', await webhookSecret(c.token))) {
    return new Response('forbidden', { status: 403 });
  }
  const update = await request.json().catch(() => null);
  if (!update) return new Response('bad request', { status: 400 });
  const origin = c.publicUrl || new URL(request.url).origin;
  const job = handleUpdate(update, c, origin).catch((e) => console.error('update failed', e && e.stack || e));
  if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
  return new Response('ok');
}

const SRC_ICON = { jf: '🏠', ia: '🎞' };

async function handleUpdate(update, c, origin) {
  const msg = update.message;
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;
  if (msg.chat.type !== 'private') return; // кнопки мини-приложения работают только в личке
  const from = msg.from || {};
  const text = String(msg.text || '').trim();
  const isAllowed = c.allowed.includes(String(from.id));

  if (/^\/id(@\w+)?$/.test(text)) {
    return tg(c, 'sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: 'Ваш Telegram ID: <code>' + from.id + '</code>' });
  }
  if (c.restricted && !isAllowed) {
    return tg(c, 'sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: '🔒 Это личный бот.\n\nВаш Telegram ID: <code>' + from.id + '</code>\nПопросите владельца добавить его в ALLOWED_USERS.',
    });
  }
  const jf = !!(c.jf && c.restricted && isAllowed);
  const openBtn = { text: '🎬 Открыть кинотеатр', web_app: { url: appUrl(origin) } };

  if (/^\/(start|help|menu)(@\w+)?(\s|$)/.test(text) || (!text && !msg.text)) {
    const lines = [
      '🎬 <b>Кинотеатр</b>',
      '',
      'Напишите название фильма, и я пришлю, что нашлось. Или откройте кинотеатр кнопкой ниже: поиск, подборки, выбор качества' +
        (jf ? ', озвучки' : '') + ' и субтитров, «продолжить просмотр», избранное.',
      '',
      'Без рекламы и без подписок.',
      '',
      '<b>Откуда фильмы</b>',
    ];
    if (jf) lines.push('🏠 ваша медиатека Jellyfin: всё, что у вас есть, со сменой озвучки и качества;');
    lines.push('🎞 Internet Archive: классика кино в общественном достоянии (до ' + pdYear() + ' года), немое кино, документальное.');
    return tg(c, 'sendMessage', {
      chat_id: chatId, parse_mode: 'HTML', text: lines.join('\n'),
      reply_markup: { inline_keyboard: [[openBtn]] },
    });
  }
  if (text.startsWith('/')) {
    return tg(c, 'sendMessage', { chat_id: chatId, text: 'Не знаю такой команды. Просто напишите название фильма.', reply_markup: { inline_keyboard: [[openBtn]] } });
  }
  if (!text) return;

  await tg(c, 'sendChatAction', { chat_id: chatId, action: 'typing' });
  const res = await searchAll(text, c, jf, true, 1);
  const items = res.items.slice(0, 10);
  if (!items.length) {
    const hint = jf ? '' : '\n\nВ архиве в основном старые зарубежные фильмы: попробуйте название по-английски.';
    return tg(c, 'sendMessage', {
      chat_id: chatId,
      text: '😕 По запросу «' + text.slice(0, 100) + '» ничего не нашёл.' + (res.errors.length ? '\n(' + res.errors.join('; ') + ')' : '') + hint,
      reply_markup: { inline_keyboard: [[openBtn]] },
    });
  }
  const keyboard = items.map((it) => [{
    text: (SRC_ICON[it.src] || '') + ' ' + it.title.slice(0, 50) + (it.year ? ' (' + it.year + ')' : ''),
    web_app: { url: appUrl(origin, { open: it.src + ':' + it.id }) },
  }]);
  if (res.more || res.items.length > items.length) {
    keyboard.push([{ text: '🔎 Все результаты', web_app: { url: appUrl(origin, { q: text.slice(0, 100) }) } }]);
  }
  return tg(c, 'sendMessage', {
    chat_id: chatId, parse_mode: 'HTML',
    text: '🔎 «' + esc(text.slice(0, 100)) + '»: выберите фильм',
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function handleSetup(request, c) {
  const page = (title, body) => new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(title) + '</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:24px auto;padding:0 16px">' +
    '<h1 style="font-size:22px">' + esc(title) + '</h1>' + body + '</body>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

  if (!c.token) {
    return page('Не хватает токена', '<p>Добавьте переменную <b>BOT_TOKEN</b> (Settings → Variables and Secrets → Add, тип Secret), ' +
      'нажмите Deploy и откройте эту страницу ещё раз.</p>');
  }
  const origin = c.publicUrl || new URL(request.url).origin;
  const me = await tg(c, 'getMe');
  if (!me.ok) return page('Неверный токен', '<p>Telegram не принял BOT_TOKEN: ' + esc(me.description) + '. Скопируйте токен у @BotFather заново.</p>');
  const steps = [
    ['Вебхук', await tg(c, 'setWebhook', {
      url: origin + '/tg', secret_token: await webhookSecret(c.token), allowed_updates: ['message'], drop_pending_updates: true,
    })],
    ['Команды', await tg(c, 'setMyCommands', {
      commands: [
        { command: 'start', description: 'Открыть кинотеатр' },
        { command: 'id', description: 'Узнать свой Telegram ID' },
      ],
    })],
    ['Кнопка меню', await tg(c, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'Кино', web_app: { url: appUrl(origin) } } })],
    ['Описание', await tg(c, 'setMyDescription', {
      description: 'Поиск и просмотр фильмов без рекламы: классика в общественном достоянии и ваша медиатека Jellyfin.',
    })],
  ];
  const list = steps.map(([name, r]) => '<li>' + (r.ok ? '✅ ' : '❌ ') + esc(name) + (r.ok ? '' : ': ' + esc(r.description)) + '</li>').join('');
  const ok = steps.every(([, r]) => r.ok);
  const user = me.result.username;
  const notes = [];
  if (c.jf && !c.restricted) notes.push('⚠️ Jellyfin настроен, но выключен: задайте ALLOWED_USERS (свой ID узнаете командой /id).');
  if (c.restricted) notes.push('🔒 Бот закрыт: доступ только у ' + c.allowed.length + ' пользовател' + (c.allowed.length === 1 ? 'я' : 'ей') + ' из ALLOWED_USERS.');
  else notes.push('🌐 Бот открыт для всех. Чтобы закрыть, задайте ALLOWED_USERS.');
  return page(ok ? 'Готово!' : 'Есть ошибки',
    '<ul>' + list + '</ul>' +
    '<p>Бот: <a href="https://t.me/' + esc(user) + '">@' + esc(user) + '</a>. Откройте его и нажмите «Запустить».</p>' +
    '<p>' + notes.map(esc).join('<br>') + '</p>' +
    '<p style="color:#888">Мини-приложение: ' + esc(appUrl(origin)) + '<br>Версия ' + VERSION + '</p>');
}

// ---------------------------------------------------------------- мини-приложение

const APP_HTML = String.raw`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>Кинотеатр</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root {
  --fb-bg: #0f1115; --fb-bg2: #1a1d24; --fb-text: #f1f2f4; --fb-hint: #8d95a3; --fb-accent: #3b82f6; --fb-accent-text: #fff;
  --bg: var(--tg-theme-bg-color, var(--fb-bg));
  --bg2: var(--tg-theme-secondary-bg-color, var(--fb-bg2));
  --text: var(--tg-theme-text-color, var(--fb-text));
  --hint: var(--tg-theme-hint-color, var(--fb-hint));
  --accent: var(--tg-theme-button-color, var(--fb-accent));
  --accent-text: var(--tg-theme-button-text-color, var(--fb-accent-text));
  --link: var(--tg-theme-link-color, var(--accent));
}
@media (prefers-color-scheme: light) {
  :root { --fb-bg: #ffffff; --fb-bg2: #f1f2f5; --fb-text: #15171c; --fb-hint: #6b7280; }
}
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body { margin: 0; background: var(--bg); color: var(--text); }
body { font: 15px/1.4 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; padding-bottom: env(safe-area-inset-bottom); overflow-x: hidden; }
button { font: inherit; color: inherit; }
.top { position: sticky; top: 0; z-index: 5; background: var(--bg); padding: 10px 16px 8px; display: flex; flex-direction: column; gap: 8px; }
.search-row { display: flex; gap: 8px; align-items: center; }
.back { flex: none; width: 38px; height: 38px; border: 0; border-radius: 10px; background: var(--bg2); font-size: 20px; line-height: 1; }
.search { flex: 1; display: flex; }
.search input { width: 100%; height: 38px; border: 0; border-radius: 10px; padding: 0 12px; background: var(--bg2); color: var(--text); font-size: 16px; outline: none; }
.search input::placeholder { color: var(--hint); }
.tabs { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
.tabs::-webkit-scrollbar, .row::-webkit-scrollbar { display: none; }
.chip { flex: none; border: 0; border-radius: 999px; padding: 6px 12px; background: var(--bg2); font-size: 14px; white-space: nowrap; cursor: pointer; }
.chip.on { background: var(--accent); color: var(--accent-text); }
main { padding: 0 16px 24px; }
.sec { margin-top: 18px; }
.sec-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.sec-title { font-size: 17px; font-weight: 650; margin: 0; }
.link { border: 0; background: none; color: var(--link); padding: 0; font-size: 14px; cursor: pointer; flex: none; }
.row { display: flex; gap: 10px; overflow-x: auto; scroll-snap-type: x proximity; margin: 0 -16px; padding: 0 16px 4px; }
.row .card { width: 112px; flex: none; scroll-snap-align: start; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 14px 10px; }
.card { display: block; border: 0; background: none; padding: 0; text-align: left; cursor: pointer; min-width: 0; }
.poster { position: relative; aspect-ratio: 2 / 3; border-radius: 10px; overflow: hidden; background: var(--bg2); }
.poster img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
.poster .ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 34px; font-weight: 700; color: var(--hint); }
.badge { position: absolute; left: 6px; top: 6px; font-size: 11px; padding: 2px 6px; border-radius: 6px; background: rgba(0,0,0,.6); color: #fff; }
.bar { position: absolute; left: 0; right: 0; bottom: 0; height: 4px; background: rgba(255,255,255,.25); }
.bar i { display: block; height: 100%; background: var(--accent); }
.card .t { margin-top: 6px; font-size: 13px; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.card .y { font-size: 12px; color: var(--hint); }
.status { color: var(--hint); padding: 18px 0; text-align: center; }
.err { background: var(--bg2); border-radius: 12px; padding: 14px; margin-top: 16px; }
.btn { display: block; width: 100%; border: 0; border-radius: 10px; padding: 11px; margin-top: 16px; background: var(--bg2); font-size: 15px; cursor: pointer; }
.btn.primary { background: var(--accent); color: var(--accent-text); }
.btn:disabled { opacity: .5; }
.player { position: relative; margin: 0 -16px; background: #000; aspect-ratio: 16 / 9; max-height: 70vh; }
.player video { width: 100%; height: 100%; display: block; background: #000; }
.player-msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 16px; color: #fff; background: rgba(0,0,0,.75); font-size: 14px; }
.item h1 { font-size: 21px; line-height: 1.2; margin: 14px 0 4px; }
.meta { color: var(--hint); font-size: 13px; }
.opt { margin-top: 14px; }
.opt-label { font-size: 13px; color: var(--hint); margin-bottom: 6px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chips.eps .chip { min-width: 44px; text-align: center; }
select { width: 100%; height: 40px; border: 0; border-radius: 10px; padding: 0 10px; background: var(--bg2); color: var(--text); font-size: 15px; }
.part-title { margin-top: 8px; font-size: 14px; }
.desc { margin-top: 14px; white-space: pre-line; font-size: 14px; color: var(--text); opacity: .9; }
.desc.clamp { display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden; }
.actions { display: flex; gap: 8px; margin-top: 14px; }
.actions .btn { margin: 0; }
.actions a.btn { text-align: center; text-decoration: none; color: var(--text); }
.note { color: var(--hint); font-size: 12px; margin-top: 18px; }
.toast { position: fixed; left: 16px; right: 16px; bottom: calc(16px + env(safe-area-inset-bottom)); z-index: 20; background: rgba(20,22,28,.95); color: #fff; padding: 12px 14px; border-radius: 12px; font-size: 14px; transition: opacity .2s, transform .2s; opacity: 0; transform: translateY(10px); pointer-events: none; }
.toast.show { opacity: 1; transform: none; }
.empty { color: var(--hint); font-size: 14px; }
</style>
</head>
<body>
<header class="top">
  <div class="search-row">
    <button class="back" id="backBtn" hidden aria-label="Назад">‹</button>
    <form class="search" id="searchForm" role="search">
      <input id="q" type="search" placeholder="Название фильма или сериала" enterkeyhint="search" autocomplete="off">
    </form>
  </div>
  <div class="tabs" id="srcTabs" hidden></div>
</header>
<main id="view"></main>
<div class="toast" id="toast"></div>
<script>
(function () {
  'use strict';
  var HLS_JS = '__HLS_JS__';
  var tg = window.Telegram && window.Telegram.WebApp;
  var inTg = !!(tg && tg.initData);
  var initData = inTg ? tg.initData : '';
  var view = document.getElementById('view');
  var qInput = document.getElementById('q');
  var backBtn = document.getElementById('backBtn');
  var srcTabs = document.getElementById('srcTabs');
  var toastEl = document.getElementById('toast');

  // ---------- helpers
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
      else if (k === 'style') el.style.cssText = v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) {
      if (c == null || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('kb:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { if (v == null) localStorage.removeItem('kb:' + k); else localStorage.setItem('kb:' + k, JSON.stringify(v)); } catch (e) {} }
  };
  var toastTimer = null;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 3500);
  }
  function fmtTime(s) {
    s = Math.floor(s || 0);
    var hh = Math.floor(s / 3600), mm = Math.floor(s % 3600 / 60), ss = s % 60;
    return (hh ? hh + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(ss).padStart(2, '0');
  }
  function api(path, params) {
    var qs = new URLSearchParams(params || {}).toString();
    return fetch(path + (qs ? '?' + qs : ''), { headers: { 'X-Tg-Init': initData } }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || ('Ошибка ' + r.status));
        return d;
      });
    });
  }
  function haptic() { try { tg && tg.HapticFeedback && tg.HapticFeedback.selectionChanged(); } catch (e) {} }
  var deviceId = store.get('device');
  if (!deviceId) { deviceId = 'kb' + Math.random().toString(36).slice(2, 12); store.set('device', deviceId); }

  // ---------- state
  var state = { stack: [], jf: false, src: store.get('src', 'all'), home: null, cur: null };

  function itemKey(src, id) { return src + ':' + id; }

  // ---------- navigation
  function current() { return state.stack[state.stack.length - 1]; }
  function nav(entry, replace) {
    var top = current();
    if (top) { top.scrollY = window.scrollY; leaveItem(); }
    if (replace && top) state.stack[state.stack.length - 1] = entry; else state.stack.push(entry);
    render(entry, false);
  }
  function back() {
    if (state.stack.length <= 1) { if (inTg) tg.close(); return; }
    leaveItem();
    state.stack.pop();
    render(current(), true);
  }
  function updateBack() {
    var canBack = state.stack.length > 1;
    if (inTg && tg.BackButton && tg.isVersionAtLeast && tg.isVersionAtLeast('6.1')) {
      if (canBack) tg.BackButton.show(); else tg.BackButton.hide();
      backBtn.hidden = true;
    } else {
      backBtn.hidden = !canBack;
    }
  }
  function render(entry, isBack) {
    updateBack();
    if (entry.type !== 'search') qInput.value = '';
    else if (entry.q) qInput.value = entry.q;
    if (isBack && entry.node && entry.type === 'search') {
      view.replaceChildren(entry.node);
      window.scrollTo(0, entry.scrollY || 0);
      return;
    }
    var node;
    if (entry.type === 'home') node = renderHome(entry);
    else if (entry.type === 'search') node = renderSearch(entry);
    else node = renderItem(entry);
    entry.node = node;
    view.replaceChildren(node);
    window.scrollTo(0, isBack ? (entry.scrollY || 0) : 0);
  }

  // ---------- cards
  function card(it, extra) {
    var img = h('img', { src: it.poster || null, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    var poster = h('div', { class: 'poster' }, [
      h('div', { class: 'ph', text: (it.title || '?').trim().charAt(0).toUpperCase() }),
      img,
      state.jf ? h('span', { class: 'badge', text: it.src === 'jf' ? 'Моё' : 'Архив' }) : null,
      extra && extra.progress ? h('div', { class: 'bar' }, [h('i', { style: 'width:' + Math.round(extra.progress * 100) + '%' })]) : null
    ]);
    img.onerror = function () { img.remove(); };
    return h('button', { class: 'card', type: 'button', onclick: function () {
      haptic();
      nav({ type: 'item', src: it.src, id: it.id, part: extra && extra.part });
    } }, [
      poster,
      h('div', { class: 't', text: it.title }),
      h('div', { class: 'y', text: extra && extra.sub || (it.year ? String(it.year) : '') })
    ]);
  }
  function section(title, items, opts) {
    opts = opts || {};
    var head = h('div', { class: 'sec-head' }, [
      h('h2', { class: 'sec-title', text: title }),
      opts.more ? h('button', { class: 'link', type: 'button', text: opts.moreText || 'Все', onclick: opts.more }) : null
    ]);
    var list = h('div', { class: opts.grid ? 'grid' : 'row' }, items.map(function (x) { return x.nodeType ? x : card(x); }));
    return h('section', { class: 'sec' }, [head, list]);
  }

  // ---------- home
  function renderHome(entry) {
    var root = h('div');
    var cont = store.get('continue', []);
    if (cont.length) {
      root.appendChild(section('Продолжить просмотр', cont.map(function (c) {
        return card(c, { part: c.part, progress: c.d ? c.t / c.d : 0, sub: c.partTitle || (c.d ? 'осталось ' + fmtTime(c.d - c.t) : '') });
      }), { more: function () { store.set('continue', []); nav(current(), true); }, moreText: 'Очистить' }));
    }
    var favs = store.get('favs', []);
    if (favs.length) root.appendChild(section('Избранное', favs));
    var box = h('div', null, [h('div', { class: 'status', text: 'Загружаю подборки…' })]);
    root.appendChild(box);
    var fresh = state.home && Date.now() - state.home.at < 10 * 60 * 1000;
    (fresh ? Promise.resolve(state.home.data) : api('/api/home')).then(function (d) {
      state.home = { at: Date.now(), data: d };
      setJf(d.jf);
      box.replaceChildren();
      d.sections.forEach(function (s) {
        if (s.error) { box.appendChild(h('div', { class: 'err' }, [h('b', { text: s.title + ': ' }), s.error])); return; }
        box.appendChild(section(s.title, s.items, { more: function () { nav({ type: 'search', preset: s.preset, title: s.title }); } }));
      });
      box.appendChild(h('div', { class: 'note', text: 'Архив: фильмы, вышедшие до ' + d.pdYear + ' года включительно (общественное достояние), и архив Прелинджера. Без рекламы.' }));
    }).catch(function (e) {
      box.replaceChildren(errorBox(e.message, function () { nav(current(), true); }));
    });
    return root;
  }
  function errorBox(text, retry) {
    return h('div', { class: 'err' }, [
      h('div', { text: '⚠️ ' + text }),
      retry ? h('button', { class: 'btn', type: 'button', text: 'Повторить', onclick: retry }) : null
    ]);
  }
  function setJf(on) {
    state.jf = !!on;
    if (!state.jf) { srcTabs.hidden = true; state.src = 'all'; return; }
    srcTabs.hidden = false;
    srcTabs.replaceChildren();
    [['all', 'Везде'], ['jf', 'Моя медиатека'], ['ia', 'Архив']].forEach(function (t) {
      srcTabs.appendChild(h('button', { class: 'chip' + (state.src === t[0] ? ' on' : ''), type: 'button', text: t[1], onclick: function () {
        state.src = t[0]; store.set('src', t[0]); setJf(true);
        var top = current();
        if (top.type === 'search' && top.q) nav({ type: 'search', q: top.q }, true);
      } }));
    });
  }

  // ---------- search
  function renderSearch(entry) {
    var grid = h('div', { class: 'grid' });
    var status = h('div', { class: 'status', text: 'Ищу…' });
    var more = h('button', { class: 'btn', type: 'button', text: 'Показать ещё', hidden: true });
    var title = entry.preset ? entry.title : 'Поиск: «' + entry.q + '»';
    var root = h('section', { class: 'sec' }, [h('div', { class: 'sec-head' }, [h('h2', { class: 'sec-title', text: title })]), grid, status, more]);
    var page = 0;
    function load() {
      page++;
      more.disabled = true;
      status.hidden = false;
      status.textContent = 'Ищу…';
      var params = entry.preset ? { preset: entry.preset, page: page } : { q: entry.q, page: page, src: state.src };
      api('/api/search', params).then(function (d) {
        d.items.forEach(function (it) { grid.appendChild(card(it)); });
        status.hidden = grid.children.length > 0 && !(d.errors && d.errors.length);
        if (!grid.children.length) {
          status.textContent = 'Ничего не нашлось.' + (state.jf ? '' : ' В архиве в основном старые зарубежные фильмы: попробуйте название по-английски.');
        }
        if (d.errors && d.errors.length) status.textContent = (grid.children.length ? '' : status.textContent + ' ') + d.errors.join('; ');
        more.hidden = !d.more;
        more.disabled = false;
      }).catch(function (e) {
        status.hidden = true;
        root.appendChild(errorBox(e.message));
        more.disabled = false;
      });
    }
    more.onclick = load;
    load();
    return root;
  }

  // ---------- item / player
  var hlsLoader = null;
  function loadHls() {
    if (!hlsLoader) hlsLoader = new Promise(function (res, rej) {
      if (window.Hls) return res(window.Hls);
      var s = document.createElement('script');
      s.src = HLS_JS;
      s.onload = function () { res(window.Hls); };
      s.onerror = function () { hlsLoader = null; rej(new Error('Не удалось загрузить HLS-плеер')); };
      document.head.appendChild(s);
    });
    return hlsLoader;
  }

  function renderItem(entry) {
    var root = h('section', { class: 'item' }, [h('div', { class: 'status', text: 'Загружаю…' })]);
    api('/api/item', { src: entry.src, id: entry.id }).then(function (it) {
      if (current() !== entry) return;
      buildItem(root, entry, it);
    }).catch(function (e) {
      root.replaceChildren(errorBox(e.message, function () { nav(entry, true); }));
    });
    return root;
  }

  function leaveItem() {
    var cur = state.cur;
    if (!cur) return;
    saveProgress();
    try { cur.video.pause(); } catch (e) {}
    destroyHls(cur);
    cur.video.removeAttribute('src');
    try { cur.video.load(); } catch (e) {}
    state.cur = null;
  }
  function destroyHls(cur) { if (cur.hls) { try { cur.hls.destroy(); } catch (e) {} cur.hls = null; } }

  function buildItem(root, entry, it) {
    var video = h('video', { controls: true, playsinline: true, 'webkit-playsinline': true, preload: 'metadata', poster: it.poster || null });
    var msg = h('div', { class: 'player-msg', hidden: true });
    var opts = h('div');
    var key = itemKey(it.src, it.id);
    var favs = store.get('favs', []);
    var isFav = favs.some(function (f) { return f.k === key; });
    var favBtn = h('button', { class: 'btn', type: 'button', text: isFav ? '★ В избранном' : '☆ В избранное' });
    favBtn.onclick = function () {
      haptic();
      var list = store.get('favs', []).filter(function (f) { return f.k !== key; });
      isFav = !isFav;
      if (isFav) list.unshift({ k: key, src: it.src, id: it.id, title: it.title, year: it.year, poster: it.poster });
      store.set('favs', list.slice(0, 100));
      favBtn.textContent = isFav ? '★ В избранном' : '☆ В избранное';
    };
    var desc = it.description ? h('div', { class: 'desc clamp', text: it.description }) : null;
    if (desc) desc.onclick = function () { desc.classList.toggle('clamp'); };
    var metaParts = [it.year, (it.genres || []).join(', '), it.source].filter(Boolean);
    root.replaceChildren(
      h('div', { class: 'player' }, [video, msg]),
      h('h1', { text: it.title }),
      h('div', { class: 'meta', text: metaParts.join(' · ') }),
      opts,
      desc,
      h('div', { class: 'actions' }, [
        favBtn,
        it.sourceUrl ? h('a', { class: 'btn', href: it.sourceUrl, target: '_blank', rel: 'noopener', text: 'Страница в архиве', onclick: function (e) {
          if (inTg && tg.openLink) { e.preventDefault(); tg.openLink(it.sourceUrl); }
        } }) : null
      ])
    );
    if (!it.parts || !it.parts.length) { msg.hidden = false; msg.textContent = 'У этого фильма нет видео, которое можно воспроизвести.'; return; }

    var cur = state.cur = { it: it, video: video, msg: msg, opts: opts, part: null, play: null, q: null, a: null, sub: null, hls: null, tried: {}, lastT: 0, lastSave: 0, hlsErrors: 0 };

    video.addEventListener('timeupdate', function () {
      if (state.cur !== cur) return;
      if (video.currentTime > 0) cur.lastT = video.currentTime;
      if (Date.now() - cur.lastSave > 5000) saveProgress();
    });
    video.addEventListener('pause', function () { if (state.cur === cur) saveProgress(); });
    video.addEventListener('playing', function () { msg.hidden = true; });
    video.addEventListener('ended', function () {
      if (state.cur !== cur) return;
      saveProgress(true);
      var idx = it.parts.indexOf(cur.part);
      var next = it.parts[idx + 1];
      if (next) { toast('Следующая серия'); selectPart(cur, next, true, 0); }
    });
    video.addEventListener('error', function () {
      if (state.cur !== cur || !cur.q || cur.play.hlsBase) return;
      cur.tried[cur.q.label] = true;
      var alt = cur.play.qualities.filter(function (q) { return !cur.tried[q.label]; })[0];
      if (alt) {
        toast('Качество ' + cur.q.label + ' не воспроизводится, включаю ' + alt.label);
        cur.q = alt;
        renderOptions(cur);
        start(cur, cur.lastT, true);
      } else {
        showMsg(cur, 'Это видео не воспроизводится на вашем устройстве. Попробуйте открыть страницу в архиве.');
      }
    });

    var startPart = it.parts[0];
    var wanted = entry.part || (store.get('continue', []).filter(function (c) { return c.k === key; })[0] || {}).part;
    if (wanted) startPart = it.parts.filter(function (p) { return p.id === wanted; })[0] || startPart;
    selectPart(cur, startPart, false, null);
  }

  function showMsg(cur, text) { cur.msg.textContent = text; cur.msg.hidden = false; }

  function posKey(cur, part) { return 'pos:' + cur.it.src + ':' + cur.it.id + ':' + part.id; }

  function saveProgress(finished) {
    var cur = state.cur;
    if (!cur || !cur.part) return;
    cur.lastSave = Date.now();
    var v = cur.video;
    var t = v.currentTime || cur.lastT || 0;
    var d = isFinite(v.duration) && v.duration > 0 ? v.duration : (cur.play && cur.play.duration) || 0;
    if (t < 5 && !finished) return;
    var done = finished || (d && t > d - Math.min(120, d * 0.05));
    store.set(posKey(cur, cur.part), done ? null : { t: t, d: d });
    var it = cur.it;
    var key = itemKey(it.src, it.id);
    var list = store.get('continue', []).filter(function (c) { return c.k !== key; });
    var idx = it.parts.indexOf(cur.part);
    var next = it.parts[idx + 1];
    if (!done) {
      list.unshift({ k: key, src: it.src, id: it.id, title: it.title, year: it.year, poster: it.poster, part: cur.part.id, partTitle: partLabel(cur.part), t: t, d: d });
    } else if (next) {
      list.unshift({ k: key, src: it.src, id: it.id, title: it.title, year: it.year, poster: it.poster, part: next.id, partTitle: partLabel(next), t: 0, d: 0 });
    }
    store.set('continue', list.slice(0, 20));
  }

  function partLabel(p) {
    if (!p || !p.title && p.ep == null) return '';
    var n = (p.season != null ? 'S' + p.season + ' ' : '') + (p.ep != null ? 'E' + p.ep : '');
    return (n ? n + ' · ' : '') + (p.title || '');
  }

  function selectPart(cur, part, autoplay, startAt) {
    if (cur.part) saveProgress();
    cur.part = part;
    cur.lastT = 0;
    cur.tried = {};
    cur.play = null;
    cur.hlsErrors = 0;
    renderOptions(cur);
    var p = part.play ? Promise.resolve(part.play) : api('/api/play', { src: cur.it.src, id: part.id });
    p.then(function (play) {
      if (state.cur !== cur || cur.part !== part) return;
      part.play = play;
      cur.play = play;
      cur.q = pickQuality(play.qualities);
      cur.a = pickAudio(play.audio);
      cur.sub = pickSub(play.subtitles);
      renderOptions(cur);
      var at = startAt;
      if (at == null) {
        var pos = store.get(posKey(cur, part));
        at = pos && pos.t > 30 ? pos.t : 0;
        if (at) toast('Продолжаю с ' + fmtTime(at));
      }
      start(cur, at, autoplay);
    }).catch(function (e) {
      if (state.cur === cur) showMsg(cur, e.message);
    });
  }

  function pickQuality(list) {
    var pref = store.get('prefQ', 0);
    if (!list.length) return null;
    if (!pref) return list[0];
    var ok = list.filter(function (q) { return q.h && q.h <= pref; });
    return ok[0] || list[list.length - 1];
  }
  function pickAudio(list) {
    if (!list || !list.length) return null;
    var pref = store.get('prefA', '');
    return list.filter(function (a) { return pref && a.label === pref; })[0]
      || list.filter(function (a) { return a.lang === 'rus' || a.lang === 'ru'; })[0]
      || list.filter(function (a) { return a.def; })[0]
      || list[0];
  }
  function pickSub(list) {
    var pref = store.get('prefS', '');
    if (!list || !list.length || !pref) return null;
    return list.filter(function (s) { return s.label === pref; })[0] || list.filter(function (s) { return s.lang && s.lang === pref; })[0] || null;
  }

  function buildSrc(cur) {
    var play = cur.play;
    if (!play.hlsBase) return { url: cur.q.url, hls: false };
    var u = play.hlsBase + '&' + cur.q.params + (cur.a ? '&' + cur.a.params : '') + '&DeviceId=' + encodeURIComponent(deviceId);
    return { url: u, hls: true };
  }

  function start(cur, at, autoplay) {
    var v = cur.video;
    var src = buildSrc(cur);
    destroyHls(cur);
    cur.msg.hidden = true;
    Array.prototype.slice.call(v.querySelectorAll('track')).forEach(function (t) { t.remove(); });
    if (cur.sub) {
      var tr = h('track', { kind: 'subtitles', src: cur.sub.url, label: cur.sub.label, srclang: cur.sub.lang || 'ru', default: true });
      tr.addEventListener('load', function () { try { tr.track.mode = 'showing'; } catch (e) {} });
      v.appendChild(tr);
    }
    var onMeta = function () {
      v.removeEventListener('loadedmetadata', onMeta);
      if (at > 0 && !src.hls) { try { v.currentTime = at; } catch (e) {} }
      if (cur.sub) { try { v.textTracks[0].mode = 'showing'; } catch (e) {} }
      if (autoplay) { var pr = v.play(); if (pr && pr.catch) pr.catch(function () {}); }
    };
    v.addEventListener('loadedmetadata', onMeta);
    if (!src.hls) { v.src = src.url; v.load(); return; }
    loadHls().then(function (Hls) {
      if (state.cur !== cur) return;
      if (Hls && Hls.isSupported()) {
        var hls = cur.hls = new Hls({ startPosition: at > 0 ? at : -1, maxBufferLength: 30 });
        hls.on(Hls.Events.ERROR, function (ev, data) {
          if (!data.fatal || cur.hls !== hls) return;
          cur.hlsErrors++;
          if (/^manifest/i.test(data.details || '')) {
            showMsg(cur, 'Медиатека не отдала видео (' + (data.response && data.response.code || data.details) + '). Проверьте, что сервер Jellyfin включён и доступен по https.');
            destroyHls(cur);
            return;
          }
          if (cur.hlsErrors > 4) { showMsg(cur, 'Медиатека не отвечает. Проверьте, что сервер Jellyfin включён.'); destroyHls(cur); return; }
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          else { showMsg(cur, 'Ошибка воспроизведения'); destroyHls(cur); }
        });
        hls.loadSource(src.url);
        hls.attachMedia(v);
      } else {
        v.src = src.url;
        if (at > 0) v.addEventListener('loadedmetadata', function f() { v.removeEventListener('loadedmetadata', f); try { v.currentTime = at; } catch (e) {} });
        v.load();
      }
    }).catch(function () {
      v.src = src.url;
      v.load();
    });
  }

  function restart(cur) {
    var v = cur.video;
    var t = v.currentTime || cur.lastT || 0;
    var playing = !v.paused;
    start(cur, t, playing);
  }

  function chipGroup(label, items, isOn, onPick, extraClass) {
    return h('div', { class: 'opt' }, [
      h('div', { class: 'opt-label', text: label }),
      h('div', { class: 'chips' + (extraClass ? ' ' + extraClass : '') }, items.map(function (x) {
        return h('button', { class: 'chip' + (isOn(x) ? ' on' : ''), type: 'button', text: x.label, onclick: function () { haptic(); onPick(x); } });
      }))
    ]);
  }

  function renderOptions(cur) {
    var it = cur.it;
    var box = cur.opts;
    box.replaceChildren();
    if (it.parts.length > 1) {
      var seasons = [];
      it.parts.forEach(function (p) { if (p.season != null && seasons.indexOf(p.season) < 0) seasons.push(p.season); });
      var season = cur.part.season;
      if (seasons.length > 1) {
        box.appendChild(chipGroup('Сезон', seasons.map(function (s) { return { label: s === 0 ? 'Доп.' : String(s), s: s }; }),
          function (x) { return x.s === season; },
          function (x) {
            var firstEp = it.parts.filter(function (p) { return p.season === x.s; })[0];
            if (firstEp && firstEp !== cur.part) selectPart(cur, firstEp, false, null);
          }));
      }
      var inSeason = it.parts.filter(function (p) { return seasons.length <= 1 || p.season === season; });
      var numbered = inSeason.every(function (p) { return p.ep != null; });
      if (numbered && inSeason.length <= 60) {
        box.appendChild(chipGroup(it.src === 'jf' ? 'Серия' : 'Часть', inSeason.map(function (p) { return { label: String(p.ep), p: p }; }),
          function (x) { return x.p === cur.part; },
          function (x) { if (x.p !== cur.part) selectPart(cur, x.p, true, null); }, 'eps'));
      } else {
        var sel = h('select', { onchange: function () { var p = inSeason[sel.selectedIndex]; if (p && p !== cur.part) selectPart(cur, p, true, null); } },
          inSeason.map(function (p, i) { return h('option', { text: (i + 1) + '. ' + (partLabel(p) || 'Часть ' + (i + 1)), selected: p === cur.part }); }));
        box.appendChild(h('div', { class: 'opt' }, [h('div', { class: 'opt-label', text: it.kind === 'series' && it.src === 'jf' ? 'Серия' : 'Часть' }), sel]));
      }
      if (numbered && cur.part.title) box.appendChild(h('div', { class: 'part-title', text: partLabel(cur.part) }));
    }
    var play = cur.play;
    if (!play) { box.appendChild(h('div', { class: 'status', text: 'Готовлю видео…' })); return; }
    if (play.qualities.length > 1) {
      box.appendChild(chipGroup('Качество', play.qualities, function (q) { return q === cur.q; }, function (q) {
        if (q === cur.q) return;
        cur.q = q;
        store.set('prefQ', q.h || 0);
        renderOptions(cur);
        restart(cur);
      }));
    } else if (play.qualities.length === 1) {
      box.appendChild(h('div', { class: 'opt' }, [h('div', { class: 'opt-label', text: 'Качество: ' + play.qualities[0].label })]));
    }
    if (play.audio && play.audio.length > 1) {
      box.appendChild(chipGroup('Озвучка', play.audio, function (a) { return a === cur.a; }, function (a) {
        if (a === cur.a) return;
        cur.a = a;
        store.set('prefA', a.label);
        renderOptions(cur);
        restart(cur);
      }));
    } else if (play.audio && play.audio.length === 1) {
      box.appendChild(h('div', { class: 'opt' }, [h('div', { class: 'opt-label', text: 'Озвучка: ' + play.audio[0].label })]));
    }
    if (play.subtitles && play.subtitles.length) {
      var subs = [{ label: 'Выкл', off: true }].concat(play.subtitles);
      box.appendChild(chipGroup('Субтитры', subs, function (s) { return s.off ? !cur.sub : s === cur.sub; }, function (s) {
        cur.sub = s.off ? null : s;
        store.set('prefS', s.off ? '' : s.label);
        renderOptions(cur);
        setSubs(cur);
      }));
    }
  }

  function setSubs(cur) {
    var v = cur.video;
    Array.prototype.slice.call(v.querySelectorAll('track')).forEach(function (t) { t.remove(); });
    if (!cur.sub) return;
    var tr = h('track', { kind: 'subtitles', src: cur.sub.url, label: cur.sub.label, srclang: cur.sub.lang || 'ru', default: true });
    v.appendChild(tr);
    setTimeout(function () { try { for (var i = 0; i < v.textTracks.length; i++) v.textTracks[i].mode = 'showing'; } catch (e) {} }, 0);
  }

  // ---------- boot
  document.getElementById('searchForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var q = qInput.value.trim();
    if (!q) return;
    qInput.blur();
    var top = current();
    nav({ type: 'search', q: q }, top && top.type === 'search' && !top.preset);
  });
  backBtn.addEventListener('click', back);
  window.addEventListener('pagehide', function () { saveProgress(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) saveProgress(); });

  if (inTg) {
    try {
      tg.ready();
      tg.expand();
      if (tg.isVersionAtLeast && tg.isVersionAtLeast('7.7') && tg.disableVerticalSwipes) tg.disableVerticalSwipes();
      if (tg.BackButton && tg.BackButton.onClick) tg.BackButton.onClick(back);
    } catch (e) {}
  }

  var params = new URLSearchParams(location.search);
  state.stack.push({ type: 'home' });
  var open = params.get('open');
  var q0 = params.get('q');
  if (open && open.indexOf(':') > 0) {
    var i = open.indexOf(':');
    state.stack.push({ type: 'item', src: open.slice(0, i), id: open.slice(i + 1) });
  } else if (q0) {
    state.stack.push({ type: 'search', q: q0 });
  }
  render(current(), false);
  if (current().type !== 'home') {
    api('/api/home').then(function (d) { state.home = { at: Date.now(), data: d }; setJf(d.jf); }).catch(function () {});
  }
})();
</script>
</body>
</html>`.replace('__HLS_JS__', HLS_JS);

