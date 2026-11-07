// Проверки воркера в Node 18+: node kino-bot/tests/test_worker.mjs
// Telegram и Jellyfin подменяются заглушками, Internet Archive опрашивается по-настоящему
// (нужен интернет; без него: SKIP_NETWORK=1).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import worker from '../worker.js';

const TOKEN = '123456:TEST-token';
const ORIGIN = 'https://kino.example.workers.dev';
const JF = 'https://jf.example.com';
const NET = !process.env.SKIP_NETWORK;

const realFetch = globalThis.fetch;
const tgCalls = [];
let jfHandler = null;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://api.telegram.org/')) {
    const method = url.split('/').pop();
    tgCalls.push({ method, body: JSON.parse(init.body || '{}') });
    return Response.json({ ok: true, result: method === 'getMe' ? { username: 'test_kino_bot' } : true });
  }
  if (url.startsWith(JF)) return jfHandler(new URL(url), init);
  if (!NET) throw new Error('network disabled: ' + url);
  const { cf, ...rest } = init; // eslint-disable-line no-unused-vars
  return realFetch(input, rest);
};

function initData(user, token = TOKEN, authDate = Math.floor(Date.now() / 1000)) {
  const p = new URLSearchParams({ query_id: 'AAHtest', user: JSON.stringify(user), auth_date: String(authDate) });
  const check = [...p].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return p.toString();
}

const webhookSecret = crypto.createHash('sha256').update('kinobot-webhook:' + TOKEN).digest('hex').slice(0, 48);

async function call(path, { env = {}, method = 'GET', headers = {}, body } = {}) {
  const waits = [];
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers, body }), env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return res;
}

function update(text, fromId = 111) {
  return {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': webhookSecret, 'Content-Type': 'application/json' },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: fromId, type: 'private' }, from: { id: fromId, first_name: 'T' }, text } }),
  };
}

const tests = [];
const test = (name, fn, needsNet = false) => tests.push({ name, fn, needsNet });

// ------------------------------------------------------------------ мини-приложение

test('страница мини-приложения отдаётся и её скрипт без синтаксических ошибок', async () => {
  const res = await call('/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.ok(!html.includes('__HLS_JS__'), 'адрес hls.js подставлен');
  assert.ok(html.includes('https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js'));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1);
  new vm.Script(scripts[0]); // бросит SyntaxError, если что-то не так
});

// ------------------------------------------------------------------ setup / webhook

test('/setup без токена объясняет, что делать', async () => {
  const html = await (await call('/setup')).text();
  assert.match(html, /BOT_TOKEN/);
});

test('/setup регистрирует вебхук, команды и кнопку меню', async () => {
  tgCalls.length = 0;
  const html = await (await call('/setup', { env: { BOT_TOKEN: TOKEN } })).text();
  assert.match(html, /Готово/);
  const wh = tgCalls.find((c) => c.method === 'setWebhook');
  assert.equal(wh.body.url, ORIGIN + '/tg');
  assert.equal(wh.body.secret_token, webhookSecret);
  const menu = tgCalls.find((c) => c.method === 'setChatMenuButton');
  assert.equal(menu.body.menu_button.web_app.url, ORIGIN + '/');
  assert.ok(tgCalls.some((c) => c.method === 'setMyCommands'));
});

test('вебхук без секрета отклоняется', async () => {
  const res = await call('/tg', { env: { BOT_TOKEN: TOKEN }, method: 'POST', body: '{}' });
  assert.equal(res.status, 403);
});

test('/start присылает кнопку мини-приложения', async () => {
  tgCalls.length = 0;
  const res = await call('/tg', { env: { BOT_TOKEN: TOKEN }, ...update('/start') });
  assert.equal(res.status, 200);
  const m = tgCalls.find((c) => c.method === 'sendMessage');
  assert.match(m.body.text, /Кинотеатр/);
  assert.equal(m.body.reply_markup.inline_keyboard[0][0].web_app.url, ORIGIN + '/');
});

test('/id отвечает ID даже в закрытом боте', async () => {
  tgCalls.length = 0;
  await call('/tg', { env: { BOT_TOKEN: TOKEN, ALLOWED_USERS: '999' }, ...update('/id', 111) });
  assert.match(tgCalls.find((c) => c.method === 'sendMessage').body.text, /111/);
});

test('закрытый бот не пускает чужих', async () => {
  tgCalls.length = 0;
  await call('/tg', { env: { BOT_TOKEN: TOKEN, ALLOWED_USERS: '999' }, ...update('/start', 111) });
  const m = tgCalls.find((c) => c.method === 'sendMessage');
  assert.match(m.body.text, /личный бот/);
  assert.equal(m.body.reply_markup, undefined);
});

test('поиск в боте присылает фильмы кнопками мини-приложения', async () => {
  tgCalls.length = 0;
  await call('/tg', { env: { BOT_TOKEN: TOKEN }, ...update('nosferatu') });
  const m = tgCalls.find((c) => c.method === 'sendMessage');
  const kb = m.body.reply_markup.inline_keyboard;
  assert.ok(kb.length >= 2, 'нашлось несколько вариантов');
  assert.match(kb[0][0].text, /nosferatu/i);
  assert.match(kb[0][0].web_app.url, /^https:\/\/kino\.example\.workers\.dev\/\?open=ia%3A/);
}, true);

// ------------------------------------------------------------------ доступ к API

test('API открытого бота работает без initData', async () => {
  const res = await call('/api/search?q=caligari');
  assert.equal(res.status, 200);
}, true);

test('API закрытого бота: без подписи 401, с чужой 401, с верной 200', async () => {
  const env = { BOT_TOKEN: TOKEN, ALLOWED_USERS: '42, 43' };
  assert.equal((await call('/api/search?q=x', { env })).status, 401);
  const forged = initData({ id: 42 }, 'другой:токен');
  assert.equal((await call('/api/search?q=x', { env, headers: { 'X-Tg-Init': forged } })).status, 401);
  const stranger = initData({ id: 7 });
  const r = await call('/api/search?q=x', { env, headers: { 'X-Tg-Init': stranger } });
  assert.equal(r.status, 401);
  assert.match((await r.json()).error, /ID 7/);
  const old = initData({ id: 42 }, TOKEN, Math.floor(Date.now() / 1000) - 8 * 86400);
  assert.equal((await call('/api/search?q=x', { env, headers: { 'X-Tg-Init': old } })).status, 401);
  const tampered = initData({ id: 42 }).replace('%22id%22%3A42', '%22id%22%3A43');
  assert.equal((await call('/api/search?q=x', { env, headers: { 'X-Tg-Init': tampered } })).status, 401);
  if (NET) assert.equal((await call('/api/search?q=caligari', { env, headers: { 'X-Tg-Init': initData({ id: 43 }) } })).status, 200);
});

// ------------------------------------------------------------------ Internet Archive

test('поиск по-русски находит через транслит («Броненосец»)', async () => {
  const d = await (await call('/api/search?q=' + encodeURIComponent('Броненосец'))).json();
  assert.ok(d.items.some((x) => /bronenosets|potemkin/i.test(x.title)), JSON.stringify(d.items.slice(0, 3)));
}, true);

test('в результатах только фильмы до границы общественного достояния', async () => {
  const d = await (await call('/api/search?q=dracula')).json();
  for (const it of d.items) if (it.year) assert.ok(it.year <= new Date().getUTCFullYear() - 96 || it.src !== 'ia', it.title + ' ' + it.year);
}, true);

test('карточка фильма: части, качества, прямые ссылки на видео', async () => {
  const d = await (await call('/api/item?src=ia&id=Nosferatu_DVD_quality')).json();
  assert.equal(d.year, 1922);
  assert.equal(d.kind, 'series', 'фильм залит пятью частями');
  assert.equal(d.parts.length, 5);
  for (const p of d.parts) {
    assert.ok(p.title);
    assert.ok(p.play.qualities.length >= 1);
    assert.match(p.play.qualities[0].url, /^https:\/\/archive\.org\/download\/Nosferatu_DVD_quality\/.+\.(mp4|m4v|webm)$/);
  }
  // Элемент без года не пускаем: нельзя проверить, что он в общественном достоянии.
  assert.equal((await call('/api/item?src=ia&id=nosferatu-rescored-1922')).status, 403);
}, true);

test('не из общественного достояния: 403 (и для карточки, и для субтитров)', async () => {
  for (const id of ['fantastic-planet__1973', 'filmography-alfred-hitchcock', 'sex_madness']) {
    const r = await call('/api/item?src=ia&id=' + id);
    assert.equal(r.status, 403, id);
  }
  const s = await call('/api/sub?src=ia&id=sex_madness&f=sex_madness.asr.srt');
  assert.equal(s.status, 403);
}, true);

test('подборки на главной', async () => {
  const d = await (await call('/api/home')).json();
  assert.equal(d.jf, false);
  assert.ok(d.sections.length >= 4, 'есть подборки');
  assert.ok(d.sections.every((s) => s.items.length));
  const more = await (await call('/api/search?preset=silent&page=2')).json();
  assert.ok(more.items.length > 0);
}, true);

test('SRT → WebVTT для субтитров архива', async () => {
  // Ищем фильм с субтитрами в общественном достоянии.
  const p = new URLSearchParams({ q: 'collection:silent_films AND mediatype:movies AND format:SubRip AND year:[1880 TO 1930]', rows: '5', output: 'json' });
  p.append('fl[]', 'identifier');
  const docs = (await (await realFetch('https://archive.org/advancedsearch.php?' + p)).json()).response.docs;
  for (const { identifier } of docs) {
    const d = await (await call('/api/item?src=ia&id=' + identifier)).json();
    const sub = d.parts && d.parts.flatMap((x) => x.play.subtitles)[0];
    if (!sub) continue;
    const r = await call(sub.url);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/vtt/);
    const text = await r.text();
    assert.match(text, /^WEBVTT/);
    assert.ok(!/\d\d:\d\d:\d\d,\d\d\d/.test(text), 'запятые в таймкодах заменены');
    return;
  }
  console.log('    (не нашлось фильма с субтитрами, пропуск)');
}, true);

// ------------------------------------------------------------------ Jellyfin (заглушка)

const U = 'a'.repeat(32), MOVIE = 'b'.repeat(32), SERIES = 'c'.repeat(32), EP1 = 'd'.repeat(32), EP2 = 'e'.repeat(32);
let jfAuths = 0, jfExpireOnce = false;
jfHandler = async (u, init) => {
  const auth = String((init.headers || {}).Authorization || '');
  if (u.pathname === '/Users/AuthenticateByName') {
    const body = JSON.parse(init.body);
    if (body.Pw !== 'secret') return new Response('', { status: 401 });
    jfAuths++;
    return Response.json({ AccessToken: 'tok' + jfAuths, User: { Id: U } });
  }
  if (!/Token="tok\d+"/.test(auth)) return new Response('', { status: 401 });
  if (jfExpireOnce) { jfExpireOnce = false; return new Response('', { status: 401 }); }
  if (u.pathname === '/Items' && u.searchParams.get('searchTerm')) {
    assert.equal(u.searchParams.get('userId'), U);
    return Response.json({ Items: [{ Id: MOVIE, Name: 'Мой фильм', ProductionYear: 2020, Type: 'Movie' }, { Id: SERIES, Name: 'Мой сериал', Type: 'Series' }], TotalRecordCount: 2 });
  }
  if (u.pathname === '/Items' && u.searchParams.get('ids') === MOVIE) {
    return Response.json({ Items: [{ Id: MOVIE, Name: 'Мой фильм', ProductionYear: 2020, Type: 'Movie', Overview: 'Описание', Genres: ['Драма'] }] });
  }
  if (u.pathname === '/Items' && u.searchParams.get('ids') === SERIES) {
    return Response.json({ Items: [{ Id: SERIES, Name: 'Мой сериал', Type: 'Series' }] });
  }
  if (u.pathname === '/Items' && u.searchParams.get('SortBy') === 'DateCreated') {
    return Response.json({ Items: [{ Id: MOVIE, Name: 'Мой фильм', Type: 'Movie' }], TotalRecordCount: 1 });
  }
  if (u.pathname === '/Shows/' + SERIES + '/Episodes') {
    return Response.json({ Items: [
      { Id: EP1, Name: 'Пилот', ParentIndexNumber: 1, IndexNumber: 1 },
      { Id: EP2, Name: 'Вторая', ParentIndexNumber: 1, IndexNumber: 2 },
    ] });
  }
  if (u.pathname === '/Items/' + MOVIE + '/PlaybackInfo') {
    assert.equal(init.method, 'POST');
    return Response.json({
      PlaySessionId: 'ps1',
      MediaSources: [{ Id: MOVIE, RunTimeTicks: 72000000000, MediaStreams: [
        { Type: 'Video', Index: 0, Height: 1080 },
        { Type: 'Audio', Index: 1, Language: 'rus', Title: 'Дубляж', IsDefault: true },
        { Type: 'Audio', Index: 2, Language: 'rus', Title: 'MVO' },
        { Type: 'Audio', Index: 3, Language: 'eng', DisplayTitle: 'English - AAC - Stereo' },
        { Type: 'Subtitle', Index: 4, Language: 'rus', Title: 'Полные', IsTextSubtitleStream: true },
        { Type: 'Subtitle', Index: 5, Language: 'eng', IsTextSubtitleStream: false },
      ] }],
    });
  }
  if (u.pathname === '/Videos/' + MOVIE + '/' + MOVIE + '/Subtitles/4/0/Stream.vtt') {
    return new Response('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nПривет\n', { headers: { 'Content-Type': 'text/vtt' } });
  }
  return new Response('not mocked ' + u.pathname, { status: 404 });
};

const JF_ENV = { BOT_TOKEN: TOKEN, ALLOWED_USERS: '42', JELLYFIN_URL: JF + '/', JELLYFIN_USER: 'bot', JELLYFIN_PASSWORD: 'secret' };
const asOwner = { headers: { 'X-Tg-Init': initData({ id: 42 }) } };

test('Jellyfin выключен, если бот открыт (без ALLOWED_USERS)', async () => {
  const env = { ...JF_ENV, ALLOWED_USERS: '' };
  const r = await call('/api/item?src=jf&id=' + MOVIE, { env });
  assert.equal(r.status, 403);
});

test('Jellyfin: поиск, карточка, озвучки, качества, субтитры', async () => {
  const s = await (await call('/api/search?q=' + encodeURIComponent('Мой') + '&src=jf', { env: JF_ENV, ...asOwner })).json();
  assert.deepEqual(s.items.map((x) => x.src + ':' + x.title), ['jf:Мой фильм', 'jf:Мой сериал']);
  assert.equal(s.items[0].poster, JF + '/Items/' + MOVIE + '/Images/Primary?maxHeight=450&quality=85');

  const item = await (await call('/api/item?src=jf&id=' + MOVIE, { env: JF_ENV, ...asOwner })).json();
  assert.equal(item.kind, 'movie');
  assert.equal(item.parts.length, 1);

  const play = await (await call('/api/play?src=jf&id=' + MOVIE, { env: JF_ENV, ...asOwner })).json();
  const base = new URL(play.hlsBase);
  assert.equal(base.pathname, '/Videos/' + MOVIE + '/master.m3u8');
  assert.equal(base.searchParams.get('MediaSourceId'), MOVIE);
  assert.match(base.searchParams.get('ApiKey'), /^tok\d+$/);
  assert.equal(base.searchParams.get('PlaySessionId'), 'ps1');
  assert.deepEqual(play.qualities.map((q) => q.label), ['Оригинал 1080p', '720p', '480p', '360p']);
  assert.deepEqual(play.audio.map((a) => a.label), ['Дубляж · RUS', 'MVO · RUS', 'English - AAC - Stereo']);
  assert.deepEqual(play.audio.map((a) => a.params), ['AudioStreamIndex=1', 'AudioStreamIndex=2', 'AudioStreamIndex=3']);
  assert.equal(play.subtitles.length, 1, 'графические субтитры пропущены');
  assert.equal(play.duration, 7200);

  const sub = await call(play.subtitles[0].url, { env: JF_ENV });
  assert.equal(sub.status, 200);
  assert.match(await sub.text(), /Привет/);
  const bad = await call(play.subtitles[0].url.replace(/sig=\w/, 'sig=0'), { env: JF_ENV });
  assert.equal(bad.status, 403);
});

test('Jellyfin: сериал раскладывается на сезоны и серии', async () => {
  const item = await (await call('/api/item?src=jf&id=' + SERIES, { env: JF_ENV, ...asOwner })).json();
  assert.equal(item.kind, 'series');
  assert.deepEqual(item.parts.map((p) => [p.season, p.ep, p.title]), [[1, 1, 'Пилот'], [1, 2, 'Вторая']]);
});

test('Jellyfin: протухший токен обновляется сам', async () => {
  const before = jfAuths;
  jfExpireOnce = true;
  const r = await call('/api/item?src=jf&id=' + MOVIE, { env: JF_ENV, ...asOwner });
  assert.equal(r.status, 200);
  assert.equal(jfAuths, before + 1);
});

test('Jellyfin: в боте результаты медиатеки идут первыми', async () => {
  tgCalls.length = 0;
  await call('/tg', { env: JF_ENV, ...update('Мой', 42) });
  const kb = tgCalls.find((c) => c.method === 'sendMessage').body.reply_markup.inline_keyboard;
  assert.match(kb[0][0].text, /^🏠 Мой фильм \(2020\)/);
  assert.equal(kb[0][0].web_app.url, ORIGIN + '/?open=jf%3A' + MOVIE);
});

test('Jellyfin: неверный пароль даёт понятную ошибку', async () => {
  const r = await call('/api/home', { env: { ...JF_ENV, JELLYFIN_PASSWORD: 'wrong' }, ...asOwner });
  const d = await r.json();
  const s = d.sections.find((x) => x.id === 'jf-error');
  assert.match(s.error, /JELLYFIN_PASSWORD/);
}, true);

// ------------------------------------------------------------------ запуск

let failed = 0;
for (const t of tests) {
  if (t.needsNet && !NET) { console.log('SKIP', t.name); continue; }
  try {
    await t.fn();
    console.log('ok  ', t.name);
  } catch (e) {
    failed++;
    console.log('FAIL', t.name);
    console.log('     ', e && e.stack || e);
  }
}
console.log(failed ? '\n' + failed + ' не прошло' : '\nвсе проверки прошли');
process.exit(failed ? 1 : 0);
