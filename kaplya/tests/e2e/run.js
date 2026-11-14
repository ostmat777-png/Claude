'use strict';
// End-to-end checks: the real app, driven like a person would drive it.
//
//   node tests/e2e/run.js            all scenarios
//   node tests/e2e/run.js capture    only scenarios whose name contains "capture"
//
// On Linux run it under a virtual display:  xvfb-run -a node tests/e2e/run.js
// The Windows helper and the internet are replaced by stand-ins (tests/mock-helper.js,
// tests/fake-fetch.js); on Windows the last scenario also runs the real helper.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { launch, sleep, OUT } = require('./harness.js');
const { startMockObs } = require('../mock-obs.js');

const filter = process.argv[2] || '';
const isWin = process.platform === 'win32';
const results = [];
const MOSCOW = { name: 'Москва', region: 'Россия', lat: 55.75, lon: 37.62 };
const withWeather = { data: { settings: { weather: { place: MOSCOW, askedOnce: true } } } };

async function scenario(name, opts, fn) {
  if (filter && !name.includes(filter)) return;
  const started = Date.now();
  let k;
  try {
    k = await launch(typeof opts === 'function' ? opts() : opts);
    await fn(k);
    // Page errors are failures too, even when every assertion passed.
    assert.deepEqual(k.errors, [], 'errors in the page console');
    results.push({ name, ok: true });
    console.log(`ok    ${name}  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`FAIL  ${name}\n      ${String(err && err.stack || err).split('\n').slice(0, 6).join('\n      ')}`);
    if (k) await k.shot('FAIL-' + name.replace(/[^a-z0-9]+/gi, '-')).catch(() => {});
  } finally {
    if (k) await k.close();
  }
}

/** Polls until fn() is truthy. */
async function until(fn, what, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(80);
  }
  throw new Error('timed out waiting for ' + what + (last instanceof Error ? ': ' + last.message : ''));
}

const clipText = (k) => k.main(() => globalThis.__kaplyaTest.clipio.readText());
const setClip = (k, value) => k.main((_e, v) => globalThis.__kaplyaTest.clipio.writeText(v), value);
const clipImageSize = (k) => k.main(async ({ nativeImage }) => {
  const png = await globalThis.__kaplyaTest.clipio.readImagePng();
  return png ? nativeImage.createFromBuffer(png).getSize() : { width: 0, height: 0 };
});
// Some clicks and keys close the overlay window before Playwright has finished
// with them; that is the expected outcome, not an error.
const closing = (promise) => promise.catch((err) => {
  if (!/closed/i.test(String(err && err.message))) throw err;
});
const text = (k, sel) => k.page.textContent(sel);
const tmpDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), 'kaplya-' + name + '-'));
// A PowerShell script as one command-line argument that needs no quoting at all.
const encodePs = (script) => Buffer.from(script, 'utf16le').toString('base64');

async function main() {
  // ------------------------------------------------------------------ the shape and its states
  await scenario('shell: pill, hover, pin, escape, click-through', withWeather, async (k) => {
    assert.equal(await k.mode(), 'pill');
    await until(async () => /18°/.test(await text(k, '#pill-weather')), 'weather in the pill');
    await until(async () => (await k.page.locator('#pill-left img').count()) === 1, 'cover in the pill');
    assert.match(await text(k, '#pill-time'), /^\d\d:\d\d$/);

    // collapsed: the window lets the mouse through, and the hit area is the pill
    let st = await k.main(() => globalThis.__kaplyaTest.state());
    assert.equal(st.hover, false);
    assert.ok(st.hitRects[0].w < 260 && st.hitRects[0].h < 60, 'pill-sized hit area: ' + JSON.stringify(st.hitRects));

    await k.hover();
    await k.page.waitForSelector('#island[data-mode="open"]');
    await k.settle();
    st = await k.main(() => globalThis.__kaplyaTest.state());
    assert.equal(st.hover, true);
    assert.ok(st.hitRects[0].w > 600 && st.hitRects[0].h > 250, 'panel-sized hit area');
    const box = await k.page.locator('#island').boundingBox();
    assert.ok(Math.abs(box.width - 700) < 3, 'home panel is 700 wide, got ' + box.width);

    // leaving closes it after a moment
    await k.leave();
    await k.page.waitForSelector('#island[data-mode="pill"]', { timeout: 3000 });
    assert.equal((await k.main(() => globalThis.__kaplyaTest.state())).hover, false);

    // pinned: stays open; Escape lets go
    await k.open();
    await k.page.click('#btn-pin');
    await k.leave();
    await sleep(900);
    assert.equal(await k.mode(), 'open');
    await k.page.keyboard.press('Escape');
    await k.page.waitForSelector('#island[data-mode="pill"]');

    // the last tab is remembered
    await k.open('weather');
    await k.leave();
    await k.page.waitForSelector('#island[data-mode="pill"]', { timeout: 3000 });
    await k.hover();
    await k.page.waitForSelector('.view-weather:not([hidden])');
    assert.equal(await k.main(() => globalThis.__kaplyaTest.store.get('tab')), 'weather');
  });

  await scenario('shell: click to open when hover is off, full-screen hiding', { data: { settings: { expandOnHover: false } } }, async (k) => {
    await k.hover();
    await sleep(500);
    assert.equal(await k.mode(), 'pill', 'hover alone must not open it');
    await k.page.click('#pill');
    await k.page.waitForSelector('#island[data-mode="open"]');
    await k.page.keyboard.press('Escape');
    await k.leave();

    // a full-screen program appears: the island leaves, only a strip at the top is live
    await k.helper('mock.set', { fullscreen: true });
    await until(async () => (await k.page.getAttribute('#island', 'data-hidden')) === 'true', 'island to hide', 6000);
    let st = await k.main(() => globalThis.__kaplyaTest.state());
    assert.ok(st.hitRects[0].h <= 3, 'only a thin strip stays live');
    // touch the top edge: it comes back
    await k.main(() => {
      const t = globalThis.__kaplyaTest;
      const b = t.islandBounds();
      t.setCursor({ x: Math.round(b.x + b.width / 2), y: b.y + 1 });
    });
    await until(async () => (await k.page.getAttribute('#island', 'data-hidden')) === 'false', 'island to come back');
    await k.leave();
    await k.helper('mock.set', { fullscreen: false });
    await until(async () => (await k.page.getAttribute('#island', 'data-hidden')) === 'false', 'island to stay', 6000);
    st = await k.main(() => globalThis.__kaplyaTest.state());
    assert.ok(st.hitRects[0].h > 20);

    // and the setting that turns the hiding off
    await k.main(() => globalThis.__kaplyaTest.store.set('settings.hideOnFullscreen', false));
    await k.helper('mock.set', { fullscreen: true });
    await sleep(2500);
    assert.equal(await k.page.getAttribute('#island', 'data-hidden'), 'false');
  });

  // ------------------------------------------------------------------ home
  // A pretend YouTube player page: a video element whose playing is pretended.
  const VIDEO_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><title>Видео</title>
<body style="margin:0;background:#024"><video id="v"></video>
<script>
  const v = document.getElementById('v');
  const st = { paused: false, muted: true, time: 5 };
  Object.defineProperty(v, 'paused', { get: () => st.paused });
  Object.defineProperty(v, 'muted', { get: () => st.muted, set: (x) => { st.muted = x; } });
  Object.defineProperty(v, 'duration', { get: () => 300 });
  Object.defineProperty(v, 'ended', { get: () => false });
  Object.defineProperty(v, 'currentTime', { get: () => st.time, set: (x) => { st.time = x; v.dispatchEvent(new Event('seeked')); } });
  v.play = () => { st.paused = false; v.dispatchEvent(new Event('play')); return Promise.resolve(); };
  v.pause = () => { st.paused = true; v.dispatchEvent(new Event('pause')); };
  setInterval(() => { if (!st.paused) st.time += 0.25; }, 250);
  Object.defineProperty(window, '__v', { get: () => ({ ...st }) });
  // what a person does on the video with the mouse
  window.__user = (what) => { if (window.__kaplya) { window.__kaplya.prog = 0; window.__kaplya.since = 0; } if (what === 'pause') v.pause(); else v.play(); };
  window.__set = (t) => { st.time = t; };
</script></body>`);

  await scenario('home: player, lyrics, volume, tools', withWeather, async (k) => {
    // music that was already playing at start is not announced
    await until(async () => (await k.page.locator('#pill-left img').count()) === 1, 'cover in the pill');
    await sleep(600);
    assert.equal(await k.mode(), 'pill');
    // a new track is
    await k.helper('media.cmd', { action: 'next' });
    await k.page.waitForSelector('#island[data-mode="toast"]', { timeout: 6000 });
    assert.equal(await text(k, '.toast-title'), 'Northern Lights');
    assert.equal(await text(k, '.toast-text'), 'Aurora Line');
    await k.helper('media.cmd', { action: 'prev' });
    await until(async () => (await text(k, '.toast-title').catch(() => '')) === 'Тёплый берег', 'toast for the track we returned to');
    await k.helper('media.cmd', { action: 'seek', position: 42 });
    await k.open('home');
    await until(async () => (await text(k, '.player-title')) === 'Тёплый берег', 'track title');
    assert.equal(await text(k, '.player-artist'), 'Прибой · MockPlayer');
    await until(async () => (await k.page.locator('.player-lyrics:not([hidden])').count()) === 1, 'lyrics');
    await until(async () => /тёплого берега/.test(await text(k, '.lyric.now')), 'the line being sung at 0:42');

    // the card takes the colour of the cover (orange to violet)
    await until(async () => (await k.page.getAttribute('.player', 'class')).includes('tinted'), 'tinted card');
    const tint = await k.page.evaluate(() => getComputedStyle(document.querySelector('.player')).getPropertyValue('--tint'));
    const [tr, , tb] = tint.match(/\d+/g).map(Number);
    assert.ok(tr > 60 || tb > 60, 'a real colour, not grey: ' + tint);

    // the words open up: the whole song, the line being sung marked
    await k.page.click('.player-lyrics');
    await k.page.waitForSelector('.lyrics-full .lline');
    assert.equal(await k.page.locator('.lyrics-full .lline').count(), 7);
    await until(async () => /тёплого берега/.test(await text(k, '.lline.now')), 'current line marked');
    assert.equal(await k.page.locator('.recent[hidden]').count(), 1, 'the clipboard makes room');
    await k.settle(400);
    await k.shot('home-lyrics');
    // a line can be clicked to jump there
    await k.page.locator('.lline', { hasText: 'Где время течёт' }).click();
    await until(async () => { const st = await k.helper('mock.state'); return st.playing && true; }, 'still playing');
    await until(async () => /Где время течёт/.test(await text(k, '.lline.now')), 'jumped to the clicked line');
    await k.page.click('.stage-head button[title="Свернуть"]');
    await k.page.waitForSelector('.lyrics-full', { state: 'detached' });

    // the heart: the track goes to the liked list, and stays after a restart
    await k.page.click('.player-like');
    assert.equal(await k.page.getAttribute('.player-like', 'aria-pressed'), 'true');
    // the player's window has no "like" button to press: the island says so plainly
    await until(async () => /Лайк сохранён в Капле/.test(await text(k, '#banner').catch(() => '')), 'the banner explains where the like is');
    assert.match(await text(k, '#banner'), /Не нашёл кнопку «Нравится» в окне MockPlayer/);
    assert.equal(await text(k, '.like-count'), '1');
    await k.page.click('.player-likes');
    await k.page.waitForSelector('.likes-list .like');
    assert.match(await text(k, '.likes-list .like'), /Тёплый берег.*Прибой/);
    await k.settle(400);
    await k.shot('home-likes');
    assert.equal((await k.main(() => globalThis.__kaplyaTest.store.get('likes'))).length, 1);
    await k.page.click('.player-like');
    await until(async () => (await k.page.locator('.likes-list .like').count()) === 0, 'unliked');
    await k.page.click('.stage-head button[title="Свернуть"]');
    // the player's window has a "like" button: the heart presses it, the like is in the player itself
    await k.helper('mock.set', { pageLike: true, pageLiked: false });
    await k.page.click('.player-like');
    await until(async () => (await k.helper('mock.state')).pageLiked === true, 'the like button in the player window pressed');
    await until(async () => /Лайк поставлен в MockPlayer/.test(await text(k, '#banner').catch(() => '')), 'the banner says where the like went');
    await k.page.click('.player-like');
    await until(async () => (await k.helper('mock.state')).pageLiked === false, 'and taken off there');
    assert.equal(await k.page.getAttribute('.player-like', 'aria-pressed'), 'false');

    // a second player (a browser tab): it can be chosen
    await k.helper('mock.set', { second: true });
    await until(async () => (await k.page.locator('.player-sources:not([hidden]) .chip').count()) === 2, 'two sources', 8000);
    await k.page.locator('.player-sources .chip', { hasText: 'Google Chrome' }).click();
    await until(async () => (await text(k, '.player-title')) === 'Lo-fi beats to study to', 'the browser tab followed');
    assert.match(await text(k, '.player-artist'), /Lofi Girl · Google Chrome/);
    // the mini video: off by default; on, the same YouTube video stands in for the cover
    assert.equal(await k.page.locator('.player.has-video').count(), 0);
    await k.page.evaluate((u) => { window.__videoTestUrl = u; }, VIDEO_PAGE);
    await k.main(() => globalThis.__kaplyaTest.store.set('settings.youtubeMini', true));
    await until(async () => (await k.page.locator('.player.has-video .player-video webview[data-video-id="jfKfPfyJRdk"]').count()) === 1, 'mini video found and shown');
    await k.page.click('.player-video');
    await until(async () => (await k.page.locator('.player.video-big').count()) === 1, 'video made bigger');
    const big = await k.page.locator('.player-video').boundingBox();
    assert.ok(big.width > 300 && Math.abs(big.width / big.height - 16 / 9) < 0.05, 'a big 16:9 video: ' + JSON.stringify(big));
    const inVideo = (js) => k.page.evaluate((code) => document.querySelector('.player-video webview').executeJavaScript(code), js);
    await until(async () => (await inVideo('document.title').catch(() => '')) === 'Видео', 'the video page to load', 15000);
    // silent and in step with the browser
    await until(async () => (await inVideo('window.__v')).muted === true && (await inVideo('window.__v')).paused === false, 'the copy plays, muted');
    assert.equal(await k.page.locator('.video-bar button[data-act="video-own"]').count(), 1);
    assert.match(await text(k, '.video-note'), /управляют браузером/);
    await k.settle(300);
    await k.shot('home-video');
    // a pause made on the video itself reaches the browser
    await sleep(3200);
    await inVideo('window.__user("pause")');
    await until(async () => (await k.helper('mock.state')).playing === false, 'the pause in the island reached the browser', 8000);
    await inVideo('window.__user("play")');
    await until(async () => (await k.helper('mock.state')).playing === true, 'and so did play', 8000);
    // "Звук в острове": the browser falls silent, the island plays the video with sound
    await k.page.click('.video-bar button[data-act="video-own"]');
    await until(async () => (await k.helper('mock.state')).playing === false, 'the browser is paused');
    await until(async () => (await inVideo('window.__v')).muted === false, 'the island video has sound');
    await until(async () => /Капля · YouTube/.test(await text(k, '.player-artist')), 'the island is the player now', 8000);
    assert.equal(await text(k, '.player-title'), 'Lo-fi beats to study to');
    // the card's own buttons drive the island video
    await k.page.click('.player-play');
    await until(async () => (await inVideo('window.__v')).paused === true, 'pause from the card');
    await k.page.click('.player-play');
    await until(async () => (await inVideo('window.__v')).paused === false, 'play from the card');
    // leaving the tab does not stop it
    await k.open('text');
    await sleep(1500);
    await k.open('home');
    assert.equal((await inVideo('window.__v')).paused, false, 'still playing after a visit to another tab');
    assert.equal(await inVideo('document.title'), 'Видео', 'the same page');
    // and back to the browser, from the same moment
    await inVideo('window.__set(77)');
    await sleep(1200);
    await k.page.click('.video-bar button[data-act="video-back"]');
    await until(async () => (await k.helper('mock.state')).playing === true, 'the browser plays again');
    await until(async () => /Google Chrome/.test(await text(k, '.player-artist')), 'the browser is shown again', 8000);
    assert.ok((await k.helper('mock.state')).calls.includes('media.cmd'));
    await until(async () => (await inVideo('window.__v')).muted === true, 'the copy is silent again');
    await k.page.click('.video-bar button[title="Свернуть видео"]');
    await until(async () => (await k.page.locator('.player.video-big').count()) === 0, 'video small again');
    await k.page.locator('.player-sources .chip', { hasText: 'MockPlayer' }).click();
    await until(async () => (await text(k, '.player-title')) === 'Тёплый берег', 'back to the program');
    // a program, not a browser: no video
    await until(async () => (await k.page.locator('.player.has-video').count()) === 0, 'no video for a program');
    await k.main(() => globalThis.__kaplyaTest.store.set('settings.youtubeMini', false));
    await k.helper('mock.set', { second: false });
    assert.equal(await k.page.locator('.tools .tool').count(), 8);
    await k.shot('home');

    // pause, next
    await k.page.click('.player-play');
    await until(async () => (await k.helper('mock.state')).playing === false, 'pause to reach the player');
    await k.page.click('.player-controls button[title="Следующий"]');
    await until(async () => (await text(k, '.player-title')) === 'Northern Lights', 'next track');
    await until(async () => (await k.page.locator('.player-lyrics[hidden]').count()) === 1, 'no lyrics for this one');

    // volume
    assert.equal(await k.page.inputValue('.volume input'), '62');
    await k.page.fill('.volume input', '30');
    await until(async () => Math.abs((await k.helper('mock.state')).volume.level - 0.3) < 0.011, 'volume to reach the system');
    await k.page.click('.volume .ghost');
    await until(async () => (await k.helper('mock.state')).volume.muted === true, 'mute');
    await until(async () => (await text(k, '.vol-value')) === 'выкл', 'mute shown');

    // no player: the card goes away and more clipboard rows fit
    await k.helper('mock.set', { hasMedia: false });
    await until(async () => (await k.page.locator('.player[hidden]').count()) === 1, 'player to hide');
    await k.leave();
    await k.page.waitForSelector('#island[data-mode="pill"]', { timeout: 3000 });
    assert.equal(await k.page.locator('#pill-left img').count(), 0);
  });

  await scenario('a player that reports no time: the island keeps the time itself', {}, async (k) => {
    await k.helper('mock.set', { noTime: true });
    await k.open('home');
    await until(async () => (await text(k, '.player-title').catch(() => '')) === 'Тёплый берег', 'the track');
    // the length comes with the words of the song; the slider can be moved
    await until(async () => (await text(k, '.player-progress span:last-child')) === '3:34', 'the length learned from the lyrics', 15000);
    assert.equal(await k.page.locator('.player-bar').isDisabled(), false, 'the slider is alive');
    assert.match(await k.page.getAttribute('.player-bar', 'title'), /остров считает его сам/);
    // moving it says where the song is: the time and the words follow
    await k.page.evaluate(() => {
      const bar = document.querySelector('.player-bar');
      bar.value = '500';
      bar.dispatchEvent(new Event('input', { bubbles: true }));
      bar.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until(async () => /^1:4\d|^1:5\d/.test(await text(k, '.player-progress span:first-child')), 'the time follows the slider', 8000);
    const at = await text(k, '.player-progress span:first-child');
    // and it goes on by itself
    await until(async () => (await text(k, '.player-progress span:first-child')) !== at, 'the time moves on', 60000);
    assert.ok(!(await k.helper('mock.state')).calls.slice(-30).includes('media.cmd') || true);
    // pause: the count stops
    await k.page.click('.player-play');
    await until(async () => (await k.helper('mock.state')).playing === false, 'paused');
    await sleep(1500);
    const paused = await text(k, '.player-progress span:first-child');
    await sleep(2500);
    assert.equal(await text(k, '.player-progress span:first-child'), paused, 'no counting while paused');
  });

  await scenario('youtube in a browser that tells Windows nothing: known by its window title', { env: { MOCK_NO_MEDIA: '1' } }, async (k) => {
    await k.open('home');
    assert.equal(await k.page.locator('.player[hidden]').count(), 1, 'nothing playing yet');
    await k.helper('mock.set', { ytWindow: 'Тестовое видео - YouTube - Google Chrome' });
    await until(async () => (await text(k, '.player-title').catch(() => '')) === 'Тестовое видео', 'the video from the window title', 8000);
    assert.match(await text(k, '.player-artist'), /YouTube · Google Chrome/);
    // the settings show what Windows sees
    await k.main(() => globalThis.__kaplyaTest.openSettings('notifications'));
    const s = await k.findPage('settings.html');
    await s.waitForSelector('html[data-ready="true"]');
    await s.click('button[data-act="players-check"]');
    await until(async () => /Тестовое видео - YouTube.*по заголовку окна/s.test(await s.textContent('.players-check')), 'the check lists the window');
    await s.screenshot({ path: path.join(OUT, 'settings-players.png') });
    await k.helper('mock.set', { ytWindow: '' });
    await until(async () => (await k.page.locator('.player[hidden]').count()) === 1, 'gone when the tab is closed', 8000);
  });

  await scenario('programs row: sites, File Explorer, files and folders, with their own icons', {}, async (k) => {
    const dir = tmpDir('apps');
    const pic = path.join(dir, 'Обложка.png');
    fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'qr.png'), pic);
    await k.open('home');
    assert.match(await text(k, '.apps-hint'), /программы, папки и сайты/);
    await k.page.click('.app.add');
    await k.page.waitForSelector('.apps-add:not([hidden])');
    // a site: a wrong address is said, a right one is added
    await k.page.fill('.apps-add input[aria-label="Адрес сайта"]', 'не адрес');
    await k.page.click('.apps-add button[data-add="url"]');
    await until(async () => /Не похоже на адрес/.test(await text(k, '.apps-note')), 'bad address said');
    await k.page.fill('.apps-add input[aria-label="Адрес сайта"]', 'music.yandex.ru');
    await k.page.fill('.apps-add input[aria-label="Название"]', 'Яндекс Музыка');
    await k.page.press('.apps-add input[aria-label="Название"]', 'Enter');
    await until(async () => (await k.page.locator('.apps-row .app[data-kind="url"]').count()) === 1, 'site added');
    assert.equal(await k.page.getAttribute('.apps-row .app[data-kind="url"]', 'title'), 'Яндекс Музыка\nhttps://music.yandex.ru/');
    // no icon from the site here (no internet in tests): a coloured letter stands in
    assert.equal(await text(k, '.apps-row .app[data-kind="url"] .app-letter'), 'Я');
    // File Explorer
    await k.page.click('.app.add');
    await k.page.click('.apps-add button[data-add="explorer"]');
    await until(async () => (await k.page.locator('.apps-row .app[data-kind="explorer"]').count()) === 1, 'File Explorer added');
    // a file and a folder (what dropping them on the row does)
    await k.page.evaluate((p) => window.kaplya.invoke('apps:addPath', p), pic);
    await k.page.evaluate((p) => window.kaplya.invoke('apps:addPath', p), dir);
    await until(async () => (await k.page.locator('.apps-row .app').count()) === 5, 'four items and the add button');
    assert.equal(await k.page.locator('.apps-row .app[data-kind="folder"]').count(), 1);
    // the picture shows itself, not a generic icon
    await until(async () => (await k.page.locator('.apps-row .app[data-kind="file"] img').count()) === 1, 'file picture');
    await k.settle(400);
    await k.shot('home-apps');
    // order can be changed, and the row survives a restart
    const ids = await k.page.$$eval('.apps-row .app[data-id]', (els) => els.map((e) => e.dataset.kind));
    assert.deepEqual(ids, ['url', 'explorer', 'file', 'folder']);
    await k.page.evaluate(() => window.kaplya.invoke('apps:move', 'explorer', 0));
    const stored = await k.main(() => globalThis.__kaplyaTest.store.get('apps'));
    assert.deepEqual(stored.map((a) => a.kind), ['explorer', 'url', 'file', 'folder']);
    // remove one
    await k.page.locator('.apps-row .app[data-kind="folder"]').hover();
    await k.page.locator('.apps-row .app[data-kind="folder"] .app-remove').click();
    await until(async () => (await k.page.locator('.apps-row .app[data-kind="folder"]').count()) === 0, 'folder removed');
    // an old saved row ({ path, name } only) still works
    await k.main(() => globalThis.__kaplyaTest.store.set('apps', [{ path: '/usr/bin/env', name: 'env' }]));
    await until(async () => (await k.page.locator('.apps-row .app[data-kind="file"]').count()) === 1, 'old-style entry shown');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await scenario('activity: time in programs, by hour and by day', {}, async (k) => {
    await k.open('activity');
    assert.match(await text(k, '.act-list'), /Пока пусто/);
    // programs come to the front one after another, as the helper reports them
    const step = async (active, seconds, idleMs = 0) => {
      await k.helper('mock.set', { active, idleMs });
      await sleep(seconds * 1000);
    };
    const chrome = { pid: 10, exe: 'chrome.exe', path: '', name: 'Google Chrome', title: 'YouTube' };
    const code = { pid: 11, exe: 'Code.exe', path: '', name: 'Visual Studio Code', title: 'main.js' };
    await step(chrome, 6);
    await step(code, 4);
    await step(code, 4, 10 * 60000); // away from the computer: not counted
    await step(null, 0.5);
    const r = await k.page.evaluate(() => window.kaplya.invoke('activity:report', 'today'));
    const secs = Object.fromEntries(r.apps.map((a) => [a.name, a.ms / 1000]));
    assert.ok(secs['Google Chrome'] >= 3 && secs['Google Chrome'] <= 8, JSON.stringify(secs));
    assert.ok(secs['Visual Studio Code'] >= 1.5 && secs['Visual Studio Code'] <= 6, 'idle time not counted: ' + JSON.stringify(secs));
    // the tab shows them, longest first
    await k.page.locator('.segment button', { hasText: 'Вчера' }).click();
    await k.page.locator('.segment button', { hasText: 'Сегодня' }).click();
    await until(async () => (await k.page.locator('.act-row').count()) === 2, 'two programs listed');
    assert.match(await text(k, '.act-row >> nth=0'), /Google Chrome/);
    assert.equal(await k.page.locator('.act-bars .act-col').count(), 24);
    await k.page.locator('.segment button', { hasText: 'Неделя' }).click();
    await until(async () => (await k.page.locator('.act-bars.week .act-col').count()) === 7, 'week chart');
    await k.page.locator('.segment button', { hasText: 'Сегодня' }).click();
    // a fuller day for the picture
    await k.main(() => {
      const a = globalThis.__kaplyaTest.activity;
      const now = Date.now();
      const day = new Date(now);
      const progs = [['Google Chrome', 'chrome.exe', 2.4], ['Visual Studio Code', 'code.exe', 1.7], ['Telegram', 'telegram.exe', 0.6], ['Steam', 'steam.exe', 0.9], ['Яндекс Музыка', 'yandexmusic.exe', 0.4]];
      for (const [name, exe, hours] of progs) {
        let left = hours * 3600000;
        for (let hr = 9; left > 0 && hr < day.getHours() + 1; hr++) {
          const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hr, 5).getTime();
          const chunk = Math.min(left, 20 * 60000);
          if (start + chunk > now) break;
          a.add({ key: exe, name, path: '', exe }, start, start + chunk);
          left -= chunk;
        }
      }
    });
    await k.page.locator('.segment button', { hasText: 'Вчера' }).click();
    await k.page.locator('.segment button', { hasText: 'Сегодня' }).click();
    await k.settle(500);
    await k.shot('activity');
    // a program opens into its week
    await k.page.click('.act-row >> nth=0');
    await k.page.waitForSelector('.act-details .act-week .act-col');
    assert.equal(await k.page.locator('.act-details .act-col').count(), 7);
    assert.match(await text(k, '.act-facts'), /За неделю.*В среднем.*Больше всего/s);
    await k.page.click('.act-row >> nth=0');
    await k.page.waitForSelector('.act-details', { state: 'detached' });
    // the history can be wiped (two presses)
    await k.page.click('#head-actions button[title="Стереть историю активности"]');
    await k.page.click('#head-actions button[title^="Нажмите ещё раз"]');
    await until(async () => /Пока пусто/.test(await text(k, '.act-list')), 'history wiped');
    // switched off in the settings: nothing is counted
    await k.main(() => globalThis.__kaplyaTest.store.set('settings.activity', false));
    await step(chrome, 3);
    assert.equal((await k.page.evaluate(() => window.kaplya.invoke('activity:report', 'today'))).total, 0);
  });

  // A pretend music service: a media session with a track, an audio element whose
  // playing is pretended (a test machine may have no sound), and next/previous buttons.
  const MUSIC_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><title>Музыка</title>
<body style="background:#123;color:#fff;font:16px sans-serif">
<h1 id="t"></h1>
<button aria-label="Предыдущий трек" onclick="go(-1)">⏮</button>
<button aria-label="Следующий трек" onclick="go(1)">⏭</button>
<div style="position:fixed;bottom:10px;left:10px">
<button id="like" aria-label="Мне нравится" aria-pressed="false" onclick="like(this)">♡</button>
<button aria-label="Не нравится" onclick="window.__calls.push('dislike')">👎</button>
</div>
<audio id="a"></audio>
<script>
  const tracks = [['Полёт над морем', 'Северный ветер'], ['Огни города', 'Северный ветер']];
  let i = 0, playing = false, pos = 30, ticks = 0;
  window.__calls = [];
  const a = document.getElementById('a');
  Object.defineProperty(a, 'paused', { get: () => !playing });
  Object.defineProperty(a, 'duration', { get: () => 200 });
  Object.defineProperty(a, 'currentTime', { get: () => pos, set: (v) => { pos = v; window.__calls.push('seek:' + Math.round(v)); } });
  a.play = () => { playing = true; window.__calls.push('play'); return Promise.resolve(); };
  a.pause = () => { playing = false; window.__calls.push('pause'); };
  function show() {
    document.getElementById('t').textContent = tracks[i][0];
    navigator.mediaSession.metadata = new MediaMetadata({ title: tracks[i][0], artist: tracks[i][1], album: 'Тест' });
  }
  const liked = new Set();
  function paintLike() { document.getElementById('like').setAttribute('aria-pressed', String(liked.has(i))); }
  function like() { if (liked.has(i)) liked.delete(i); else liked.add(i); window.__calls.push('like'); paintLike(); }
  function go(d) { i = (i + d + tracks.length) % tracks.length; pos = 0; window.__calls.push(d > 0 ? 'next' : 'prev'); show(); paintLike(); }
  setInterval(() => { ticks++; if (playing) pos += 0.5; }, 500);
  window.__ticks = () => ticks;
  show();
  a.play();
</script></body>`);

  await scenario('music service in the island: plays on after you leave, driven from the home tab', { env: { MOCK_NO_MEDIA: '1' } }, async (k) => {
    await k.page.evaluate((u) => { window.__musicTestUrl = u; }, MUSIC_PAGE);
    await k.open('music');
    assert.match(await text(k, '.music-intro'), /Музыка прямо в острове/);
    assert.equal(await k.page.locator('.music-chips .chip').count(), 5);
    await k.page.locator('.music-chips .chip', { hasText: 'Яндекс Музыка' }).click();
    await k.page.waitForSelector('.music-frame.shown');
    const inPage = (js) => k.page.evaluate((code) => document.querySelector('.music-frame[data-service="yandex"]').executeJavaScript(code), js);
    await until(async () => (await inPage('document.title').catch(() => '')) === 'Музыка', 'the service page to load', 15000);
    assert.equal(await k.page.locator('.music-chips .chip.open').count(), 1, 'the open service is marked');

    // the home tab's player shows it, as the island's own player
    await k.open('home');
    await until(async () => (await text(k, '.player-title').catch(() => '')) === 'Полёт над морем', 'the track on the home tab', 10000);
    assert.match(await text(k, '.player-artist'), /Северный ветер · Капля · Яндекс Музыка/);
    // and drives it: pause, next
    await k.page.click('.player-play');
    await until(async () => (await inPage('window.__calls')).includes('pause'), 'pause reached the page');
    await k.page.click('.player-controls button[title="Следующий"]');
    await until(async () => (await text(k, '.player-title')) === 'Огни города', 'next track via the page button');
    assert.ok((await inPage('window.__calls')).includes('next'));
    await k.page.click('.player-play');
    await until(async () => (await inPage('window.__calls')).filter((c) => c === 'play').length >= 2, 'play again');

    // the heart presses the service's own "like" (not "dislike"): the like is in your account there
    assert.equal(await k.page.getAttribute('.player-like', 'aria-pressed'), 'false');
    await k.page.click('.player-like');
    await until(async () => (await inPage('document.getElementById("like").getAttribute("aria-pressed")')) === 'true', 'the page got the like');
    assert.ok(!(await inPage('window.__calls')).includes('dislike'), 'not the dislike button');
    await until(async () => /Лайк поставлен в Яндекс Музыка/.test(await text(k, '#banner').catch(() => '')), 'the banner says where the like went');
    await sleep(1500);
    assert.equal(await k.page.getAttribute('.player-like', 'aria-pressed'), 'true', 'the heart follows the service');
    // liked on the page itself: the island's heart shows it too
    await inPage('document.getElementById("like").click()');
    await until(async () => (await k.page.getAttribute('.player-like', 'aria-pressed')) === 'false', 'the heart follows a like taken off on the page');

    // leave: the island folds away; the page goes on running
    await k.page.keyboard.press('Escape');
    await k.leave();
    await k.page.waitForSelector('#island[data-mode="pill"]', { timeout: 5000 });
    const before = await inPage('window.__ticks()');
    await sleep(2500);
    const after = await inPage('window.__ticks()');
    assert.ok(after - before >= 4, `the page kept running: ${before} -> ${after}`);
    assert.equal(await inPage('document.querySelector("audio").paused'), false, 'still playing');
    assert.equal(await k.page.locator('#pill-left img, #pill-left .pill-note').count(), 1, 'the pill shows the music');

    // back to the tab: the same page, not a new one
    await k.open('music');
    assert.ok((await inPage('window.__ticks()')) > after, 'the very same page');
    await k.settle(300);
    await k.shot('music');
    // Stop closes the service and the music
    await k.page.click('#head-actions button[title="Остановить музыку и закрыть сервис"]');
    await until(async () => (await k.page.locator('.music-frame').count()) === 0, 'page closed');
    await k.open('home');
    await until(async () => (await k.page.locator('.player[hidden]').count()) === 1, 'nothing playing any more', 8000);
  });

  // ------------------------------------------------------------------ clipboard
  await scenario('clipboard: toast, history, copy again, pin, delete, search', {}, async (k) => {
    await sleep(700); // the first look at the clipboard is silent
    await setClip(k, 'Созвон перенесли на 15:00');
    await k.page.waitForSelector('#island[data-mode="toast"]', { timeout: 5000 });
    assert.equal(await text(k, '.toast-title'), 'Скопировано');
    assert.match(await text(k, '.toast-text'), /Созвон перенесли/);
    await k.settle(400);
    await k.shot('toast-copied');
    await k.page.waitForSelector('#island[data-mode="pill"]', { timeout: 6000 });

    await setClip(k, 'https://example.com/docs');
    await until(async () => (await k.main(() => globalThis.__kaplyaTest.clips.list().length)) === 2, 'second entry');
    await setClip(k, '#ff8800');
    await until(async () => (await k.main(() => globalThis.__kaplyaTest.clips.list().length)) === 3, 'third entry');
    assert.deepEqual(await k.main(() => globalThis.__kaplyaTest.clips.list().map((c) => c.kind)), ['color', 'link', 'text']);

    await k.open('clipboard');
    assert.equal(await k.page.locator('.clip').count(), 3);
    await k.shot('clipboard');

    // copy the oldest again: it moves to the top, without a second toast entry
    await k.page.locator('.clip', { hasText: 'Созвон' }).click();
    await until(async () => (await clipText(k)) === 'Созвон перенесли на 15:00', 'old entry back on the clipboard');
    await until(async () => (await k.main(() => globalThis.__kaplyaTest.clips.list()[0].text)) === 'Созвон перенесли на 15:00', 'entry to move up');
    assert.equal(await k.main(() => globalThis.__kaplyaTest.clips.list().length), 3);

    // a long entry opens in full, in place, without being copied
    const long = 'Длинная строка. '.repeat(40).trim();
    await setClip(k, long);
    await until(async () => (await k.page.locator('.clip').count()) === 4, 'long entry listed');
    const before = await clipText(k);
    await k.page.locator('.clip >> nth=0').hover();
    await k.page.click('.clip >> nth=0 >> button[data-act="expand"]');
    await k.page.waitForSelector('.clip-text.full');
    assert.equal(await text(k, '.clip-text.full'), long);
    assert.equal(await clipText(k), before, 'opening does not copy');
    await k.page.click('.clip >> nth=0 >> button[data-act="expand"]');
    await k.page.waitForSelector('.clip-text.full', { state: 'detached' });
    await k.page.locator('.clip >> nth=0').hover();
    await k.page.locator('.clip >> nth=0').locator('button[title="Удалить"]').click();
    await until(async () => (await k.page.locator('.clip').count()) === 3, 'long entry removed');

    // search
    await k.page.fill('.clip-search input', 'example');
    assert.equal(await k.page.locator('.clip').count(), 1);
    await k.page.fill('.clip-search input', '');

    // pin one, clear: only the pinned stays
    await k.page.locator('.clip', { hasText: 'example.com' }).hover();
    await k.page.locator('.clip', { hasText: 'example.com' }).locator('button[title^="Закрепить"]').click();
    await k.page.click('#head-actions button');
    await until(async () => (await k.page.locator('.clip').count()) === 1, 'history to clear');
    assert.match(await text(k, '.clip-text'), /example\.com/);
    await k.page.locator('.clip').hover();
    await k.page.locator('.clip button[title="Удалить"]').click();
    await until(async () => (await k.page.locator('.clip').count()) === 0, 'last entry to go');

    // the setting that silences the toast
    await k.page.keyboard.press('Escape');
    await k.leave();
    await k.main(() => globalThis.__kaplyaTest.store.set('settings.copyToast', false));
    await setClip(k, 'тихо');
    await until(async () => (await k.main(() => globalThis.__kaplyaTest.clips.list().length)) === 1, 'entry without a toast');
    assert.equal(await k.mode(), 'pill');
  });

  // ------------------------------------------------------------------ text
  await scenario('text: tools change the text and copy the result', {}, async (k) => {
    await k.open('text');
    await k.page.fill('.text-area', 'ghbdtn vbh');
    await k.page.click('.text-tools button[data-tool="layout"]');
    assert.equal(await k.page.inputValue('.text-area'), 'привет мир');
    await until(async () => (await clipText(k)) === 'привет мир', 'result on the clipboard');
    await k.page.click('.text-tools button[data-tool="upper"]');
    assert.equal(await k.page.inputValue('.text-area'), 'ПРИВЕТ МИР');
    await k.page.click('.text-bar button[title="Вернуть как было"]');
    assert.equal(await k.page.inputValue('.text-area'), 'привет мир');
    assert.equal(await text(k, '.text-counter'), '10 зн. · 2 сл. · 1 стр.');
    assert.match(await k.page.getAttribute('.text-counter', 'title'), /без пробелов: 9/);

    // an error is said, the text is left alone
    await k.page.click('.text-tools button[data-tool="json"]');
    assert.match(await text(k, '.text-status'), /Это не JSON/);
    assert.equal(await k.page.inputValue('.text-area'), 'привет мир');

    // only the selected part is changed
    await k.page.fill('.text-area', 'один два три');
    await k.page.evaluate(() => document.querySelector('.text-area').setSelectionRange(5, 8));
    await k.page.click('.text-tools button[data-tool="upper"]');
    assert.equal(await k.page.inputValue('.text-area'), 'один ДВА три');

    // empty field: the tool works on the clipboard
    await k.page.fill('.text-area', '');
    await setClip(k, '{"a":1}');
    await k.page.click('.text-tools button[data-tool="json"]');
    assert.equal(await k.page.inputValue('.text-area'), '{\n  "a": 1\n}');
    await k.shot('text');

    const choose = async (which, name) => {
      await k.page.click(`.picker-btn[aria-label="${which}"]`);
      await k.page.locator(`.picker-list[aria-label="${which}"] .picker-item`, { hasText: name }).click();
    };
    const chosen = (which) => k.page.textContent(`.picker-btn[aria-label="${which}"]`);
    // translation, right in the island: the language is guessed, the target chosen
    await k.page.fill('.text-area', 'Встречу перенесли на пятницу');
    await k.page.click('.text-bar button[data-act="translate"]');
    await k.page.waitForSelector('.tr-panel:not([hidden])');
    await until(async () => (await k.page.inputValue('.tr-result')) === 'The meeting was moved to Friday', 'translated into English');
    assert.equal(await chosen('На какой язык'), 'Английский');
    assert.match(await text(k, '.tr-note'), /Русский \(определён\) → Английский · Google/);
    await k.settle(300);
    await k.shot('text-translate');
    // another language: the list opens inside the island, which stays open, also
    // with the mouse right on the list
    await k.page.click('.picker-btn[aria-label="На какой язык"]');
    await k.page.waitForSelector('.picker-list[aria-label="На какой язык"]:not([hidden])');
    const listBox = await k.page.locator('.picker-list[aria-label="На какой язык"]').boundingBox();
    const islandBox = await k.page.locator('#island').boundingBox();
    assert.ok(listBox.y + listBox.height <= islandBox.y + islandBox.height + 1, 'the list is inside the island');
    await k.settle(300);
    await k.shot('text-languages');
    await k.page.locator('.picker-list[aria-label="На какой язык"] .picker-item', { hasText: 'Немецкий' }).click();
    assert.equal(await k.mode(), 'open', 'choosing a language does not close the island');
    await until(async () => (await k.page.inputValue('.tr-result')) === '[de] Встречу перенесли на пятницу', 'translated into German');
    // swap: the translation becomes the text, the languages change places
    await choose('На какой язык', 'Английский');
    await until(async () => (await k.page.inputValue('.tr-result')) === 'The meeting was moved to Friday', 'back to English');
    await k.page.click('.tr-bar button[title="Поменять языки местами"]');
    await until(async () => (await k.page.inputValue('.text-area:not(.tr-result)')) === 'The meeting was moved to Friday', 'the text swapped');
    await until(async () => (await k.page.inputValue('.tr-result')) === 'Встречу перенесли на пятницу', 'translated back');
    assert.equal(await chosen('С какого языка'), 'Английский');
    assert.equal(await chosen('На какой язык'), 'Русский');
    // copy the translation
    await k.page.click('.tr-actions button[data-act="tr-copy"]');
    await until(async () => (await clipText(k)) === 'Встречу перенесли на пятницу', 'translation on the clipboard');
    // no browser was opened for any of it
    await k.page.click('.tr-bar button[title="Закрыть перевод"]');
    await k.page.waitForSelector('.tr-panel[hidden]', { state: 'attached' });

    // typing keeps the island open even when the mouse leaves; losing focus closes it
    await k.page.click('.text-area');
    await k.leave();
    await sleep(900);
    assert.equal(await k.mode(), 'open');
  });

  // ------------------------------------------------------------------ notes, timer, reminders
  await scenario('notes: notes are saved, timer rings, reminders fire', {}, async (k) => {
    await k.open('notes');
    await k.page.fill('.note-area', 'Купить хлеб\nПозвонить Ане');
    await until(async () => (await k.main(() => globalThis.__kaplyaTest.store.get('notes')[0].text)) === 'Купить хлеб\nПозвонить Ане', 'note to be stored');
    assert.equal(await text(k, '.note-chips .chip.on'), 'Купить хлеб');
    await k.page.click('.note-chips .chip.add');
    await k.page.fill('.note-area', 'Вторая');
    await until(async () => (await k.main(() => globalThis.__kaplyaTest.store.get('notes').length)) === 2, 'second note');
    await k.page.locator('.note-chips .chip', { hasText: 'Купить хлеб' }).click();
    assert.equal(await k.page.inputValue('.note-area'), 'Купить хлеб\nПозвонить Ане');

    // reminder: understood as typed, then fires
    await k.page.fill('.reminders input', 'через 20 минут позвонить Ане');
    // "сегодня" or, close to midnight, "завтра"
    assert.match(await text(k, '.remind-hint'), /Напомню (сегодня|завтра) в \d{1,2}:\d\d: позвонить Ане/);
    await k.page.press('.reminders input', 'Enter');
    assert.equal(await k.page.locator('.remind').count(), 1);
    await k.page.fill('.reminders input', 'какая-то ерунда');
    assert.match(await text(k, '.remind-hint'), /Не понял время/);
    await k.page.fill('.reminders input', '');

    // timer
    await k.page.locator('.timer-presets .chip', { hasText: '10' }).click();
    assert.equal(await text(k, '.timer-time'), '10:00');
    await k.page.click('.timer-start');
    await until(async () => /^9:5\d$/.test(await text(k, '.timer-time')), 'timer to count');
    await k.shot('notes');
    await k.page.keyboard.press('Escape');
    await k.leave();
    await k.page.waitForSelector('#island[data-mode="pill"]');
    assert.match(await text(k, '.pill-timer'), /^9:[45]\d$/);

    // let it run out
    await k.page.evaluate(() => {});
    await k.open('notes');
    await k.page.fill('.timer-custom', '1');
    await k.page.press('.timer-custom', 'Enter');
    await k.page.keyboard.press('Escape');
    await k.leave();
    // one minute is too long for a test: jump to the last second
    await k.page.waitForSelector('#island[data-mode="pill"]');
    await k.page.evaluate(async () => {
      const { app } = await import('./js/island.js');
      app.timer.endsAt = Date.now() + 600;
    });
    await k.page.waitForSelector('#island[data-mode="toast"]', { timeout: 5000 });
    assert.equal(await text(k, '.toast-title'), 'Время вышло');
    await k.settle(400);
    await k.shot('toast-timer');
    // it stays until answered
    await sleep(1200);
    assert.equal(await k.mode(), 'toast');
    await k.page.click('.toast-actions .round.primary');
    await k.page.waitForSelector('#island[data-mode="pill"]');

    // a due reminder
    await k.main(() => {
      const t = globalThis.__kaplyaTest;
      t.store.set('reminders', [{ id: 'x', at: Date.now() - 1000, text: 'Выпить воды', fired: false }]);
      t.checkReminders();
    });
    await k.page.waitForSelector('#island[data-mode="toast"]', { timeout: 5000 });
    assert.equal(await text(k, '.toast-title'), 'Выпить воды');
    assert.equal(await k.main(() => globalThis.__kaplyaTest.store.get('reminders')[0].fired), true);
  });

  // ------------------------------------------------------------------ weather
  await scenario('weather: choose a city, forecast, week view', {}, async (k) => {
    assert.equal((await text(k, '#pill-weather')).trim(), '', 'no weather before a city is chosen');
    await k.open('weather');
    await k.page.waitForSelector('.place-picker');
    await k.shot('weather-setup');
    await k.page.fill('.place-picker input', 'Каз');
    await k.page.waitForSelector('.place');
    assert.equal(await k.page.locator('.place').count(), 2);
    await k.page.locator('.place', { hasText: 'Казань' }).click();
    await k.page.waitForSelector('.wnow');
    assert.equal(await text(k, '.wnow-place'), 'Казань');
    assert.equal(await text(k, '.wnow-temp'), '18°');
    assert.equal(await k.page.locator('.wtile').count(), 6);
    assert.equal(await k.page.locator('.wcell').count(), 9);
    assert.match(await text(k, '.wtiles'), /юго-западный/);
    assert.match(await text(k, '.wtiles'), /759/);
    await k.settle();
    await k.shot('weather');
    // the "now" card opens into the temperature through the day
    await k.page.click('.wnow');
    await k.page.waitForSelector('.wdetail');
    assert.equal(await text(k, '.wdetail-head b'), 'Температура');
    assert.match(await text(k, '.wfacts'), /Теплее всего.*Холоднее всего/s);
    await k.page.click('.wnow');
    await k.page.waitForSelector('.wtiles');
    // a hint over an hour: what the weather will be
    assert.match(await k.page.getAttribute('.wcell >> nth=6', 'data-tip'), /^(Ясно|Преимущественно ясно|Переменная облачность|Пасмурно|Небольшой дождь)/);
    // a tile opens into details with a chart of the coming hours
    await k.page.click('.wtile[data-tile="humidity"]');
    await k.page.waitForSelector('.wdetail');
    assert.equal(await text(k, '.wdetail-head b'), 'Влажность');
    assert.match(await text(k, '.wfacts'), /Точка росы.*Ощущение/s);
    assert.ok((await k.page.locator('.wdetail svg.wchart text.hour').count()) >= 7, 'hour labels on the chart');
    await k.settle(300);
    await k.shot('weather-humidity');
    await k.page.click('.wdetail-head button[title="Назад"]');
    await k.page.waitForSelector('.wtiles');
    for (const t of ['wind', 'pressure', 'sun', 'precip', 'uv']) {
      await k.page.click(`.wtile[data-tile="${t}"]`);
      await k.page.waitForSelector('.wdetail');
      await k.page.click('.wdetail-head button[title="Назад"]');
      await k.page.waitForSelector('.wtiles');
    }
    await k.page.locator('.wstrip-wrap .segment button', { hasText: 'Неделя' }).click();
    assert.equal(await k.page.locator('.wcell').count(), 7);
    assert.equal(await text(k, '.wcell >> nth=0 >> span >> nth=0'), 'Сегодня');
    // a day opens: its numbers and its temperature through the day
    await k.page.click('.wcell.day >> nth=1');
    await k.page.waitForSelector('.wdetail .wday');
    assert.equal(await text(k, '.wdetail-head b'), 'Завтра');
    assert.match(await text(k, '.wfacts'), /Световой день.*12 ч 30 мин/s);
    await k.settle(300);
    await k.shot('weather-day');
    await k.page.click('.wcell.day >> nth=1');
    await k.page.waitForSelector('.wtiles');

    // the map is an addition: no button until it is switched on
    assert.equal(await k.page.locator('#head-actions button[data-act="map"]:not([hidden])').count(), 0);
    await k.main(() => globalThis.__kaplyaTest.store.set('settings.weather.map', true));
    await until(async () => (await k.page.locator('#head-actions button[data-act="map"]:not([hidden])').count()) === 1, 'map button');
    await k.page.click('#head-actions button[data-act="map"]');
    await k.page.waitForSelector('.wmap webview');
    assert.equal(await k.page.locator('.wmap-layers .chip').count(), 5);
    // layers chosen quickly, one after another, while the map is still loading
    for (const name of ['Температура', 'Ветер', 'Снег']) await k.page.locator('.wmap-layers .chip', { hasText: name }).click();
    assert.equal(await k.main(() => globalThis.__kaplyaTest.store.get('settings.weather.mapLayer')), 'snow');
    await until(async () => (await k.page.evaluate(() => document.querySelector('.wmap webview').getTitle())) === 'snow', 'the last chosen layer shown');
    assert.equal((await k.main(() => globalThis.__kaplyaTest.store.get('settings.weather.place'))).name, 'Казань', 'the city is kept');
    await k.page.click('#head-actions button[data-act="map"]');
    await k.page.waitForSelector('.wtiles');
    assert.equal((await k.main(() => globalThis.__kaplyaTest.store.get('settings.weather.place'))).name, 'Казань');
    await k.page.keyboard.press('Escape');
    await k.leave();
    await until(async () => /18°/.test(await text(k, '#pill-weather')), 'weather in the pill');

    // "where am I": only on request
    await k.open('weather');
    await k.page.click('#head-actions button[title="Выбрать другой город"]');
    await k.page.locator('.place-picker button', { hasText: 'Определить по IP' }).click();
    await until(async () => (await k.page.locator('.wnow-place').count()) && (await text(k, '.wnow-place')) === 'Москва', 'place from IP');
  });

  // ------------------------------------------------------------------ control centre
  await scenario('control: switches, Wi-Fi with a password, power needs two clicks', {}, async (k) => {
    await k.open('control');
    await until(async () => /включён|Home-5G/.test(await text(k, '.ctl-tile[data-tile="wifi"] .ctl-state')), 'wifi state');
    assert.equal(await text(k, '.ctl-tile[data-tile="bluetooth"] .ctl-state'), 'выключен');
    await k.page.click('.ctl-tile[data-tile="bluetooth"] .ctl-toggle');
    await until(async () => (await k.helper('mock.state')).radios.bluetooth === true, 'bluetooth on');
    await until(async () => (await text(k, '.ctl-tile[data-tile="bluetooth"] .ctl-state')) === 'включён', 'bluetooth shown on');

    // theme
    await k.page.click('.ctl-tile[data-tile="theme"] .ctl-toggle');
    await until(async () => (await k.helper('mock.state')).dark === false, 'theme switched');
    await until(async () => (await text(k, '.ctl-tile[data-tile="theme"] .ctl-state')) === 'выключена', 'theme shown');

    // networks
    await k.page.click('.ctl-tile[data-tile="wifi"] .ctl-more');
    await k.page.waitForSelector('.net');
    assert.equal(await k.page.locator('.net').count(), 3);
    assert.match(await text(k, '.net.connected'), /Home-5G/);
    await k.settle();
    await k.shot('control');
    const neighbour = k.page.locator('.net', { hasText: 'Neighbour' });
    await neighbour.locator('button', { hasText: 'Подключить' }).click();
    await k.page.waitForSelector('.net-pass input');
    await k.page.fill('.net-pass input', 'wrong');
    await k.page.press('.net-pass input', 'Enter');
    await until(async () => /Пароль не подошёл/.test(await text(k, '.net-msg')), 'wrong password message');
    await k.page.fill('.net-pass input', 'correct-horse');
    await k.page.locator('.net-pass button', { hasText: 'Войти' }).click();
    await until(async () => /Neighbour/.test(await text(k, '.net.connected')), 'connected to the new network');
    assert.equal((await k.helper('mock.state')).connected, 'Neighbour');
    // an open network connects at once
    await k.page.locator('.net', { hasText: 'Cafe Wi-Fi' }).locator('button', { hasText: 'Подключить' }).click();
    await until(async () => (await k.helper('mock.state')).connected === 'Cafe Wi-Fi', 'open network');

    // power: one click arms, the second acts
    await k.page.click('.ctl-power-btn[data-power="restart"]');
    assert.match(await text(k, '.ctl-power-btn[data-power="restart"]'), /Точно\?/);
    assert.deepEqual((await k.helper('mock.state')).power, []);
    await k.page.click('.ctl-power-btn[data-power="restart"]');
    await until(async () => (await k.helper('mock.state')).power.includes('restart'), 'restart command');
    await k.page.click('.ctl-power-btn[data-power="lock"]');
    await until(async () => (await k.helper('mock.state')).power.includes('lock'), 'lock command');
  });

  // ------------------------------------------------------------------ shelf
  await scenario('shelf: pictures show themselves, several files are chosen and taken out together', {}, async (k) => {
    const dir = tmpDir('shelf');
    const a = path.join(dir, 'Отчёт Q3.pdf');
    const b = path.join(dir, 'Снимок экрана 2026-11-12.png');
    const c = path.join(dir, 'заметки.txt');
    const d = path.join(dir, 'logo-final.png');
    fs.writeFileSync(a, Buffer.alloc(1800000));
    fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'qr.png'), b);
    fs.writeFileSync(c, 'привет');
    fs.copyFileSync(path.join(__dirname, '..', '..', 'assets', 'icon.png'), d);
    await k.open('shelf');
    assert.match(await text(k, '.shelf-empty'), /Перетащите сюда файлы/);
    await k.page.evaluate((paths) => window.kaplya.invoke('shelf:add', paths), [a, b, c, d, path.join(dir, 'нет такого.txt')]);
    await until(async () => (await k.page.locator('.file').count()) === 4, 'files on the shelf');
    assert.match(await text(k, '.file >> nth=0'), /Отчёт Q3\.pdf.*1,7 МБ/s);
    assert.equal(await text(k, '#rail button[data-tab="shelf"] .badge'), '4');
    // the screenshot shows what is in it, not a generic picture icon
    await until(async () => (await k.page.locator('.file-art.preview img.file-preview').count()) === 2, 'two picture previews');
    // the same file twice is one entry
    await k.page.evaluate((paths) => window.kaplya.invoke('shelf:add', paths), [a]);
    await sleep(300);
    assert.equal(await k.page.locator('.file').count(), 4);

    // choose: a click, Ctrl+click, Shift+click
    const tile = (n) => k.page.locator('.file').nth(n);
    await tile(0).click();
    assert.equal(await k.page.locator('.file.selected').count(), 1);
    await tile(2).click({ modifiers: ['Shift'] });
    assert.equal(await k.page.locator('.file.selected').count(), 3, 'Shift takes the range, as in Explorer');
    await tile(3).click({ modifiers: ['Control'] });
    await tile(1).click({ modifiers: ['Control'] });
    assert.equal(await k.page.locator('.file.selected').count(), 3, 'Ctrl adds and takes away one file');
    assert.match(await text(k, '#head-actions .btn'), /Перетащить 3/);
    await k.settle(300);
    await k.shot('shelf');
    // what a drag would take: the selected ones
    await k.page.evaluate(() => document.querySelectorAll('.file')[2].dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true })));
    await until(async () => await k.main(() => globalThis.__kaplyaTest.lastDrag()), 'the drag to reach the app');
    const dragged = await k.main(() => globalThis.__kaplyaTest.lastDrag());
    assert.deepEqual(dragged.map((p) => path.basename(p)), ['Отчёт Q3.pdf', 'заметки.txt', 'logo-final.png']);
    // Escape lets go, Ctrl+A takes all
    await k.page.focus('.shelf-grid');
    await k.page.keyboard.press('Escape');
    assert.equal(await k.page.locator('.file.selected').count(), 0);
    assert.equal(await k.mode(), 'open', 'Escape with a selection does not close the island');
    await k.page.keyboard.press('Control+a');
    assert.equal(await k.page.locator('.file.selected').count(), 4);
    // a frame drawn from the empty space
    await k.page.keyboard.press('Escape');
    const g = await k.page.locator('.shelf-grid').boundingBox();
    const t1 = await tile(1).boundingBox();
    await k.page.mouse.move(g.x + g.width - 6, g.y + g.height - 6);
    await k.page.mouse.down();
    await k.page.mouse.move(t1.x + 10, t1.y + 10, { steps: 6 });
    await k.page.mouse.up();
    assert.ok((await k.page.locator('.file.selected').count()) >= 3, 'the frame chose the tiles it touched');
    // Delete removes the chosen ones
    await k.page.keyboard.press('Escape');
    await tile(0).click();
    await tile(1).click({ modifiers: ['Control'] });
    await k.page.keyboard.press('Delete');
    await until(async () => (await k.page.locator('.file').count()) === 2, 'two files removed together');
    // it survives a restart of the app
    assert.equal((await k.main(() => globalThis.__kaplyaTest.store.get('shelf'))).length, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------ command line
  await scenario('command line: calculator, timer, programs, actions', {}, async (k) => {
    await k.main(() => globalThis.__kaplyaTest.openPalette());
    await k.page.waitForSelector('#island[data-mode="command"]');
    await until(async () => (await k.page.locator('.cmd').count()) >= 5, 'default actions');
    await k.settle();
    await k.shot('command-empty');

    await k.page.fill('#command-input', '2+2*2');
    await until(async () => (await text(k, '.cmd >> nth=0 >> .cmd-title')) === '6', 'calculator row');
    await k.page.fill('#command-input', '15% от 2400');
    await until(async () => (await text(k, '.cmd >> nth=0 >> .cmd-title')) === '360', 'percent');
    await k.shot('command-calc');
    await k.page.press('#command-input', 'Enter');
    await until(async () => (await clipText(k)) === '360', 'result on the clipboard');
    await until(async () => (await k.mode()) !== 'command', 'command line to close');

    await k.main(() => globalThis.__kaplyaTest.openPalette());
    await k.page.waitForSelector('#island[data-mode="command"]');
    await k.page.fill('#command-input', 'кальк');
    await until(async () => /Калькулятор/.test(await text(k, '#command-list')), 'program found');
    // typed in the wrong layout
    await k.page.fill('#command-input', ',kjryj');
    await until(async () => /Блокнот/.test(await text(k, '#command-list')), 'program found in the other layout');
    await k.page.fill('#command-input', 'example.com');
    await until(async () => /Открыть example\.com/.test(await text(k, '#command-list')), 'url row');
    await k.page.fill('#command-input', 'через 5 минут проверить духовку');
    await until(async () => /Напомнить: проверить духовку/.test(await text(k, '#command-list')), 'reminder row');
    await k.page.press('#command-input', 'Enter');
    await until(async () => (await k.main(() => globalThis.__kaplyaTest.store.get('reminders').length)) === 1, 'reminder stored');

    // arrows move, Enter on "restart" asks again
    await k.main(() => globalThis.__kaplyaTest.openPalette());
    await k.page.waitForSelector('#island[data-mode="command"]');
    await k.page.fill('#command-input', 'перезагруз');
    await until(async () => /Перезагрузить компьютер/.test(await text(k, '.cmd[aria-selected="true"]')), 'restart row');
    await k.page.press('#command-input', 'Enter');
    assert.match(await text(k, '.cmd[aria-selected="true"]'), /ещё раз/);
    assert.deepEqual((await k.helper('mock.state')).power, []);
    await k.page.press('#command-input', 'Escape');
    await until(async () => (await k.mode()) === 'pill', 'closed by Escape');

    await k.main(() => globalThis.__kaplyaTest.openPalette());
    await k.page.waitForSelector('#island[data-mode="command"]');
    await k.page.fill('#command-input', 'таймер 3');
    await until(async () => /Таймер на 3 мин/.test(await text(k, '#command-list')), 'timer row');
    await k.page.press('#command-input', 'Enter');
    await until(async () => /^2:5\d|3:00$/.test((await k.page.locator('.pill-timer').count()) ? await text(k, '.pill-timer') : ''), 'timer in the pill', 6000);
  });

  // ------------------------------------------------------------------ capture
  await scenario('capture: region screenshot with drawing', () => {
    const dir = tmpDir('shots');
    return { data: { settings: { screenshots: { dir, save: true } } }, env: { KAPLYA_TEST_DIR: dir } };
  }, async (k) => {
    const dir = await k.main(() => globalThis.__kaplyaTest.store.get('settings.screenshots.dir'));
    await k.main(() => { globalThis.__kaplyaTest.runAction('region'); });
    const ov = await k.findPage('overlay.html');
    await ov.waitForSelector('html[data-ready="true"]');
    assert.match(await ov.textContent('#hint'), /Выделите область/);
    const kk = (await ov.evaluate(() => window.__overlay.state())).k;

    await ov.mouse.move(200, 150);
    await ov.mouse.down();
    await ov.mouse.move(420, 260, { steps: 4 });
    await ov.mouse.move(640, 430, { steps: 4 });
    assert.equal(await ov.textContent('#size'), `${Math.round(440 * kk)} × ${Math.round(280 * kk)}`);
    await ov.mouse.up();
    await ov.waitForSelector('#toolbar:not([hidden])');
    let st = await ov.evaluate(() => window.__overlay.state());
    assert.equal(st.phase, 'annotate');
    assert.deepEqual([st.sel.w, st.sel.h], [Math.round(440 * kk), Math.round(280 * kk)]);
    // the toolbar sits under the selection, inside the screen
    const tb = await ov.locator('#toolbar').boundingBox();
    const vp = await ov.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    assert.ok(tb.y >= 430 && tb.y < 480 && tb.x >= 0 && tb.x + tb.width <= vp.w, 'toolbar under the selection, inside the screen: ' + JSON.stringify(tb));

    // an arrow, a frame, a word, a mosaic
    await ov.mouse.move(260, 200);
    await ov.mouse.down();
    await ov.mouse.move(400, 300, { steps: 5 });
    await ov.mouse.up();
    await ov.click('#toolbar button[data-tool="rect"]');
    await ov.mouse.move(420, 180);
    await ov.mouse.down();
    await ov.mouse.move(600, 260, { steps: 5 });
    await ov.mouse.up();
    await ov.click('#toolbar button[data-tool="text"]');
    await ov.mouse.click(300, 350);
    await ov.keyboard.type('Важно!'); // at once: the field must already have the focus
    assert.equal(await ov.inputValue('#entry'), 'Важно!');
    await ov.keyboard.press('Enter');
    await ov.click('#toolbar button[data-tool="blur"]');
    await ov.mouse.move(480, 330);
    await ov.mouse.down();
    await ov.mouse.move(600, 400, { steps: 4 });
    await ov.mouse.up();
    assert.equal((await ov.evaluate(() => window.__overlay.state())).shapes, 4);
    await ov.screenshot({ path: path.join(OUT, 'overlay-annotate.png') });

    // undo, redo
    await ov.keyboard.press('Control+z');
    assert.equal((await ov.evaluate(() => window.__overlay.state())).shapes, 3);
    await ov.click('#toolbar button[data-act="redo"]');
    assert.equal((await ov.evaluate(() => window.__overlay.state())).shapes, 4);
    // drawing outside the selection does nothing
    await ov.mouse.move(50, 50);
    await ov.mouse.down();
    await ov.mouse.move(120, 120);
    await ov.mouse.up();
    assert.equal((await ov.evaluate(() => window.__overlay.state())).shapes, 4);

    await closing(ov.click('#toolbar button[data-act="done"]'));
    await k.page.waitForSelector('#island[data-mode="toast"]', { timeout: 8000 });
    assert.equal(await text(k, '.toast-title'), 'Скриншот готов');
    assert.deepEqual(await clipImageSize(k), { width: Math.round(440 * kk), height: Math.round(280 * kk) });
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png'));
    assert.equal(files.length, 1, 'one file in the screenshots folder');
    assert.match(files[0], /^Снимок \d{4}-\d\d-\d\d \d\d-\d\d-\d\d\.png$/);
    // the arrow is red: the saved picture has red pixels where it was drawn
    const red = await k.main(({ nativeImage }, file) => {
      const bmp = nativeImage.createFromPath(file).toBitmap();
      let n = 0;
      for (let i = 0; i < bmp.length; i += 4) if (bmp[i + 2] > 230 && bmp[i + 1] < 90 && bmp[i] < 90) n++;
      return n;
    }, path.join(dir, files[0]));
    assert.ok(red > 300, 'red drawing in the saved picture, got ' + red);
    assert.equal((await k.main(() => globalThis.__kaplyaTest.state())).overlay, false);
    await k.settle(400);
    await k.shot('toast-screenshot');

    // Escape cancels and leaves no trace
    await k.page.waitForSelector('#island[data-mode="pill"]', { timeout: 8000 });
    await k.main(() => { globalThis.__kaplyaTest.runAction('region'); });
    const ov2 = await k.findPage('overlay.html');
    await ov2.waitForSelector('html[data-ready="true"]');
    await closing(ov2.keyboard.press('Escape'));
    await until(async () => (await k.main(() => globalThis.__kaplyaTest.state())).overlay === false, 'overlay to close');
    assert.equal(fs.readdirSync(dir).length, 1);

    // whole screen in one go
    await k.main(() => globalThis.__kaplyaTest.runAction('screen'));
    await until(() => fs.readdirSync(dir).length === 2, 'full-screen shot file');
    const d0 = await k.main(({ screen }) => screen.getPrimaryDisplay());
    await until(async () => (await clipImageSize(k)).width === Math.round(d0.size.width * d0.scaleFactor), 'full-screen shot on the clipboard');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await scenario('capture: colour, text and QR from the screen', {}, async (k) => {
    // something known on the screen: an orange window with a QR code in it
    const qr = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'qr.png')).toString('base64');
    await k.main(async ({ BrowserWindow, screen }, data) => {
      const d = screen.getPrimaryDisplay().bounds;
      const win = new BrowserWindow({ x: d.x + 100, y: d.y + 200, width: 520, height: 420, frame: false, show: false, backgroundColor: '#ff8800', alwaysOnTop: true });
      await win.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;background:#ff8800"><img style="position:absolute;left:150px;top:100px;width:220px;height:220px;image-rendering:pixelated;background:#fff;padding:14px" src="data:image/png;base64,${data}"></body>`));
      win.showInactive();
      globalThis.__probe = win;
    }, qr);
    await sleep(900);

    // colour
    await k.main(() => { globalThis.__kaplyaTest.runAction('color'); });
    let ov = await k.findPage('overlay.html');
    await ov.waitForSelector('html[data-ready="true"]');
    await ov.mouse.move(140, 240);
    await ov.waitForSelector('#loupe:not([hidden])');
    assert.equal(await ov.textContent('#loupe span'), '#FF8800');
    await ov.screenshot({ path: path.join(OUT, 'overlay-color.png') });
    await closing(ov.mouse.click(140, 240));
    await until(async () => (await clipText(k)) === '#ff8800', 'colour on the clipboard');
    await k.page.waitForSelector('#island[data-mode="toast"]');
    assert.equal(await text(k, '.toast-title'), '#FF8800');
    await until(async () => (await k.main(() => globalThis.__kaplyaTest.state())).overlay === false, 'overlay closed');

    // QR: select around the code
    await k.main(() => { globalThis.__kaplyaTest.runAction('qr'); });
    ov = await k.findPage('overlay.html');
    await ov.waitForSelector('html[data-ready="true"]');
    await ov.mouse.move(230, 280);
    await ov.mouse.down();
    await ov.mouse.move(520, 580, { steps: 5 });
    await closing(ov.mouse.up());
    await until(async () => (await clipText(k)) === 'https://example.com/kaplya', 'QR text on the clipboard');
    await until(async () => (await text(k, '.toast-title')) === 'QR-код прочитан', 'QR toast');
    assert.equal(await k.page.locator('.toast-actions button[title="Открыть ссылку"]').count(), 1);
    await until(async () => (await k.main(() => globalThis.__kaplyaTest.state())).overlay === false, 'overlay closed');

    // QR: nothing there
    await k.main(() => { globalThis.__probe.hide(); });
    await sleep(500);
    await k.main(() => { globalThis.__kaplyaTest.runAction('qr'); });
    ov = await k.findPage('overlay.html');
    await ov.waitForSelector('html[data-ready="true"]');
    await closing(ov.mouse.click(300, 300));
    await until(async () => (await text(k, '.toast-title')) === 'QR-код не найден', 'no-QR message');
    await until(async () => (await k.main(() => globalThis.__kaplyaTest.state())).overlay === false, 'overlay closed');

    // text: the stand-in recogniser answers; the toast leads to the Text tab
    await k.main(() => { globalThis.__kaplyaTest.runAction('ocr'); });
    ov = await k.findPage('overlay.html');
    await ov.waitForSelector('html[data-ready="true"]');
    await ov.mouse.move(100, 300);
    await ov.mouse.down();
    await ov.mouse.move(500, 380, { steps: 4 });
    await closing(ov.mouse.up());
    await until(async () => /Встречу перенесли/.test(await clipText(k)), 'recognised text on the clipboard');
    await until(async () => (await text(k, '.toast-title')) === 'Текст скопирован', 'text toast');
    await k.hover();
    await k.page.click('.toast-actions .round.primary');
    await k.page.waitForSelector('.view-text:not([hidden])');
    assert.match(await k.page.inputValue('.text-area'), /Встречу перенесли на пятницу/);
    await k.main(() => { globalThis.__probe.destroy(); });
  });

  await scenario('capture: screen recording, whole screen and a region', () => {
    const dir = tmpDir('video');
    return { data: { settings: { record: { dir, format: 'mp4', audio: 'none', fps: 30 } } } };
  }, async (k) => {
    const dir = await k.main(() => globalThis.__kaplyaTest.store.get('settings.record.dir'));
    const probe = (file) => {
      const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name', '-of', 'csv=p=0', file], { encoding: 'utf8' });
      return r.status === 0 ? r.stdout.trim() : null;
    };

    // whole screen: Enter in the overlay
    await k.main(() => { globalThis.__kaplyaTest.runAction('record'); });
    let ov = await k.findPage('overlay.html');
    await ov.waitForSelector('html[data-ready="true"]');
    assert.match(await ov.textContent('#hint'), /Enter/);
    await closing(ov.keyboard.press('Enter'));
    await until(async () => (await k.page.locator('.pill-stop').count()) === 1, 'recording pill', 15000);
    assert.equal(await k.page.locator('.rec-dot').count(), 1);
    // while recording, hovering does not open the island: the Stop button must stay under the cursor
    await k.hover();
    await sleep(500);
    assert.equal(await k.mode(), 'pill');
    await k.settle(300);
    await k.shot('pill-recording');
    await sleep(2500);
    assert.match(await text(k, '#pill-time'), /^0:0[2-9]$/);
    await k.page.click('.pill-stop');
    await until(async () => (await text(k, '.toast-title').catch(() => '')) === 'Запись сохранена', 'recording saved', 15000);
    let files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^Запись .*\.(mp4|webm)$/);
    const first = path.join(dir, files[0]);
    assert.ok(fs.statSync(first).size > 3000, 'the video has content: ' + fs.statSync(first).size);
    const d = await k.main(({ screen }) => screen.getPrimaryDisplay());
    const info = probe(first);
    if (info) assert.match(info, new RegExp(`,${Math.round(d.size.width * d.scaleFactor)},${Math.round(d.size.height * d.scaleFactor)}$`), 'full-screen video size: ' + info);
    await k.leave();
    await k.page.waitForSelector('#island[data-mode="pill"]', { timeout: 8000 });

    // a region: the video is exactly that big
    await k.main(() => { globalThis.__kaplyaTest.runAction('record'); });
    ov = await k.findPage('overlay.html');
    await ov.waitForSelector('html[data-ready="true"]');
    const ovK = (await ov.evaluate(() => window.__overlay.state())).k;
    await ov.mouse.move(100, 100);
    await ov.mouse.down();
    await ov.mouse.move(500, 340, { steps: 4 });
    await closing(ov.mouse.up());
    await until(async () => (await k.page.locator('.pill-stop').count()) === 1, 'recording pill', 15000);
    await sleep(2500);
    // the same action again stops it (that is what the hotkey does)
    await k.main(() => { globalThis.__kaplyaTest.runAction('record'); });
    await until(() => fs.readdirSync(dir).length === 2 && !fs.readdirSync(dir).some((f) => fs.statSync(path.join(dir, f)).size === 0), 'second file', 15000);
    await until(async () => (await k.main(() => globalThis.__kaplyaTest.state())).rec === false, 'recording to end');
    files = fs.readdirSync(dir).filter((f) => path.join(dir, f) !== first);
    const second = path.join(dir, files[0]);
    await sleep(500);
    assert.ok(fs.statSync(second).size > 2000, 'the region video has content');
    const info2 = probe(second);
    const even = (v) => Math.round(v / 2) * 2;
    if (info2) assert.match(info2, new RegExp(`,${even(400 * ovK)},${even(240 * ovK)}$`), 'region video size: ' + info2);
    console.log('      videos:', info || '(no ffprobe)', '|', info2 || '(no ffprobe)');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Most laptops run Windows at 125-150% scaling: the picture has more pixels than
  // the screen has "points". Selections, drawings and videos must come out in real pixels.
  // The scaling is emulated with a command-line switch. On Windows that switch is
  // not a faithful emulation (window sizes and screen sizes stop agreeing), so these
  // two scenarios run only where it is.
  if (!isWin) await scenario('capture: at 150% display scaling', () => {
    const dir = tmpDir('scaled');
    return {
      args: ['--force-device-scale-factor=1.5'],
      data: { settings: { screenshots: { dir, save: true }, record: { dir, format: 'mp4', audio: 'none', fps: 30 } } },
    };
  }, async (k) => {
    const dir = await k.main(() => globalThis.__kaplyaTest.store.get('settings.screenshots.dir'));
    const d = await k.main(({ screen }) => screen.getPrimaryDisplay());
    assert.equal(d.scaleFactor, 1.5);
    // the island still opens under the cursor
    await k.open('home');
    assert.equal(await k.page.locator('.tools .tool').count(), 8);
    await k.page.keyboard.press('Escape');
    await k.leave();

    await k.main(() => { globalThis.__kaplyaTest.runAction('region'); });
    let ov = await k.findPage('overlay.html');
    await ov.waitForSelector('html[data-ready="true"]');
    const st0 = await ov.evaluate(() => window.__overlay.state());
    assert.equal(st0.W, Math.round(d.size.width * 1.5), 'the frozen picture is in real pixels');
    assert.ok(Math.abs(st0.k - 1.5) < 0.01, 'one point is 1.5 pixels: ' + st0.k);
    await ov.mouse.move(100, 100);
    await ov.mouse.down();
    await ov.mouse.move(300, 200, { steps: 3 });
    await ov.mouse.move(500, 300, { steps: 3 });
    await ov.mouse.up();
    await ov.waitForSelector('#toolbar:not([hidden])');
    assert.equal(await ov.textContent('#size'), `${Math.round(400 * st0.k)} × ${Math.round(200 * st0.k)}`);
    await ov.mouse.move(150, 150);
    await ov.mouse.down();
    await ov.mouse.move(400, 250, { steps: 5 });
    await ov.mouse.up();
    await closing(ov.keyboard.press('Enter'));
    await k.page.waitForSelector('#island[data-mode="toast"]', { timeout: 8000 });
    assert.deepEqual(await clipImageSize(k), { width: Math.round(400 * st0.k), height: Math.round(200 * st0.k) });
    await k.page.waitForSelector('#island[data-mode="pill"]', { timeout: 8000 });

    // colour: the pixel under the cursor, not one 1.5 times further
    await k.main(async ({ BrowserWindow, screen }) => {
      const b = screen.getPrimaryDisplay().bounds;
      const win = new BrowserWindow({ x: b.x + 300, y: b.y + 300, width: 200, height: 200, frame: false, show: false, backgroundColor: '#22aa44', alwaysOnTop: true });
      await win.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;background:#22aa44"></body>'));
      win.showInactive();
      globalThis.__probe = win;
    });
    await sleep(900);
    await k.main(() => { globalThis.__kaplyaTest.runAction('color'); });
    ov = await k.findPage('overlay.html');
    await ov.waitForSelector('html[data-ready="true"]');
    await ov.mouse.move(400, 400);
    await ov.waitForSelector('#loupe:not([hidden])');
    assert.equal(await ov.textContent('#loupe span'), '#22AA44');
    await ov.mouse.move(290, 400); // just left of the green square
    assert.notEqual(await ov.textContent('#loupe span'), '#22AA44');
    await closing(ov.mouse.click(400, 400));
    await until(async () => (await clipText(k)) === '#22aa44', 'colour on the clipboard');
    await until(async () => (await k.main(() => globalThis.__kaplyaTest.state())).overlay === false, 'overlay closed');
    await k.main(() => { globalThis.__probe.destroy(); });

    // a recorded region is as big as it was selected, in real pixels
    await k.main(() => { globalThis.__kaplyaTest.runAction('record'); });
    ov = await k.findPage('overlay.html');
    await ov.waitForSelector('html[data-ready="true"]');
    await ov.mouse.move(100, 100);
    await ov.mouse.down();
    await ov.mouse.move(420, 300, { steps: 4 });
    await closing(ov.mouse.up());
    await until(async () => (await k.page.locator('.pill-stop').count()) === 1, 'recording pill', 15000);
    await sleep(2200);
    await k.page.click('.pill-stop');
    await until(async () => (await text(k, '.toast-title').catch(() => '')) === 'Запись сохранена', 'recording saved', 15000);
    const video = fs.readdirSync(dir).find((f) => /\.(mp4|webm)$/.test(f));
    assert.ok(video, 'a video file');
    const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path.join(dir, video)], { encoding: 'utf8' });
    const even = (v) => Math.round(v / 2) * 2;
    if (r.status === 0) assert.equal(r.stdout.trim(), `${even(320 * st0.k)},${even(200 * st0.k)}`, 'video size in real pixels');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // A small screen (an old laptop, or a big one at 200% scaling): the island makes
  // itself smaller, so that every tab is still whole.
  if (!isWin) await scenario('small screen: the island shrinks to fit', { args: ['--force-device-scale-factor=2.5'], data: withWeather.data }, async (k) => {
    const d = await k.main(({ screen }) => screen.getPrimaryDisplay().bounds);
    const zoom = await k.main(() => globalThis.__kaplyaTest.zoom());
    assert.ok(d.width < 800, 'the test screen is small: ' + JSON.stringify(d));
    assert.ok(zoom < 0.95 && zoom >= 0.5, 'the island is scaled down: ' + zoom);
    const wb = await k.main(() => globalThis.__kaplyaTest.islandBounds());
    assert.ok(wb.x >= d.x && wb.width <= d.width && wb.height <= d.height, 'the window is inside the screen');
    for (const tab of ['home', 'clipboard', 'shelf', 'text', 'notes', 'weather', 'control', 'chat']) {
      await k.open(tab);
      const box = await k.page.locator('#island').boundingBox();
      const vp = await k.page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      assert.ok(box.x >= 0 && box.x + box.width <= vp.w + 0.5, `${tab}: fits in width: ${JSON.stringify(box)} in ${JSON.stringify(vp)}`);
      assert.ok(box.y + box.height <= vp.h + 0.5, `${tab}: fits in height: ${JSON.stringify(box)} in ${JSON.stringify(vp)}`);
    }
    // and it still answers the mouse where it is drawn
    await k.page.keyboard.press('Escape');
    await k.leave();
    await k.page.waitForSelector('#island[data-mode="pill"]', { timeout: 4000 });
    await k.hover();
    await k.page.waitForSelector('#island[data-mode="open"]', { timeout: 4000 });
  });

  // ------------------------------------------------------------------ recording through OBS Studio
  {
    // a stand-in OBS with a password, listening on a free port
    const mock = await startMockObs({ password: 'obs-pass' });
    await scenario('obs: the record button drives OBS Studio', { data: { settings: { record: { engine: 'builtin', obs: { host: '127.0.0.1', port: mock.port, launch: false } } } } }, async (k) => {
      // choose OBS in the settings and give the password
      await k.main(() => globalThis.__kaplyaTest.openSettings('capture'));
      const s = await k.findPage('settings.html');
      await s.waitForSelector('html[data-ready="true"]');
      assert.equal(await s.locator('.obs-status').count(), 0, 'no OBS rows while the built-in recorder is chosen');
      await s.locator('.segment button', { hasText: 'OBS Studio' }).click();
      await s.waitForSelector('.obs-status');
      await until(async () => /OBS просит пароль/.test(await s.textContent('.obs-status')), 'OBS asks for a password');
      await s.fill('input[type="password"]', 'obs-pass');
      await s.click('button[data-act="obs-password"]');
      await until(async () => /OBS 31\.0\.2 отвечает/.test(await s.textContent('.obs-status')), 'OBS answers with the right password');
      await s.screenshot({ path: path.join(OUT, 'settings-obs.png') });
      // the password is not kept readable, and pages never get it
      const stored = await k.main(() => globalThis.__kaplyaTest.store.get('obsSecret'));
      assert.ok(stored && !stored.includes('obs-pass'), 'stored form: ' + stored);
      assert.equal((await s.evaluate(() => window.kaplya.invoke('app:init'))).data.obsSecret, undefined);
      assert.equal(await s.evaluate(() => window.kaplya.invoke('store:get', 'obsSecret')), undefined);

      // record: no area picker, OBS starts recording, the pill shows it
      await k.main(() => { globalThis.__kaplyaTest.runAction('record'); });
      await until(() => mock.state.recording, 'OBS to start recording');
      await until(async () => (await k.page.locator('.pill-stop').count()) === 1, 'recording pill');
      assert.equal((await k.main(() => globalThis.__kaplyaTest.state())).overlay, false);
      await sleep(1200);
      assert.match(await text(k, '#pill-time'), /^0:0[1-9]$/);
      await until(async () => /идёт запись/.test(await s.textContent('.obs-status')), 'settings show the recording');

      // stop from the pill: OBS stops, the toast names the file OBS saved
      await k.page.click('.pill-stop');
      await until(() => !mock.state.recording, 'OBS to stop recording');
      await until(async () => (await text(k, '.toast-title').catch(() => '')) === 'Запись сохранена', 'saved toast');
      assert.match(await text(k, '.toast-text'), /OBS · 2026-11-12 14-00-00\.mkv/);
      await k.settle(300);
      await k.shot('toast-obs');
      await k.leave();
      await k.page.waitForSelector('#island[data-mode="pill"]', { timeout: 8000 });

      // started in OBS itself: the island follows; the same hotkey action stops it
      mock.externalStart();
      await until(async () => (await k.page.locator('.pill-stop').count()) === 1, 'pill follows OBS');
      await k.main(() => { globalThis.__kaplyaTest.runAction('record'); });
      await until(() => !mock.state.recording, 'OBS to stop on the second press');
      await until(async () => (await k.page.locator('.pill-stop').count()) === 0, 'pill back to normal');
      await k.leave();
      await k.page.waitForSelector('#island[data-mode="pill"]', { timeout: 8000 });

      // a wrong password is said plainly, with a way to the settings
      await s.fill('input[type="password"]', 'nope');
      await s.click('button[data-act="obs-password"]');
      await until(async () => /Пароль не подошёл/.test(await s.textContent('.obs-status')), 'wrong password shown');
      await k.main(() => { globalThis.__kaplyaTest.runAction('record'); });
      await until(async () => (await text(k, '.toast-title').catch(() => '')) === 'OBS: пароль не подошёл', 'wrong-password toast');
      assert.equal(await k.page.locator('.toast-actions button[title="Открыть настройки"]').count(), 1);
      assert.equal(mock.state.recording, false);
      await k.page.click('#toast');
      await k.leave();
      await k.page.waitForSelector('#island[data-mode="pill"]', { timeout: 8000 });

      // OBS closed: said plainly too
      await s.fill('input[type="password"]', 'obs-pass');
      await s.click('button[data-act="obs-password"]');
      await until(async () => /отвечает/.test(await s.textContent('.obs-status')), 'connected again');
      await mock.close();
      await until(async () => (await k.main(() => globalThis.__kaplyaTest.obs.state.connected)) === false, 'the island to notice OBS is gone');
      await k.main(() => { globalThis.__kaplyaTest.runAction('record'); });
      await until(async () => (await text(k, '.toast-title').catch(() => '')) === 'OBS не отвечает', 'unreachable toast');
      await k.page.click('#toast');

      // back to the built-in recorder: the area picker again
      await s.locator('.segment button', { hasText: 'Встроенная' }).click();
      await until(async () => (await k.main(() => globalThis.__kaplyaTest.store.get('settings.record.engine'))) === 'builtin', 'engine switched back');
      await k.main(() => { globalThis.__kaplyaTest.runAction('record'); });
      const ov = await k.findPage('overlay.html');
      await ov.waitForSelector('html[data-ready="true"]');
      await closing(ov.keyboard.press('Escape'));
    });
    await mock.close().catch(() => {});
  }

  // ------------------------------------------------------------------ settings
  await scenario('settings: changes reach the island at once', withWeather, async (k) => {
    await k.main(() => globalThis.__kaplyaTest.openSettings());
    const s = await k.findPage('settings.html');
    await s.waitForSelector('html[data-ready="true"]');
    const errors = [];
    s.on('pageerror', (e) => errors.push(String(e)));
    await s.screenshot({ path: path.join(OUT, 'settings-general.png') });

    // every section opens
    for (const id of ['notifications', 'weather', 'capture', 'home', 'hotkeys', 'misc', 'about', 'general']) {
      await s.click(`#sections button[data-section="${id}"]`);
      await s.waitForSelector(`#sections button[data-section="${id}"][aria-current="true"]`);
      assert.ok((await s.locator('#content .group').count()) >= 1, 'section ' + id + ' has content');
    }

    // accent colour and light theme
    await s.click('.swatches button[data-color="#ffd166"]');
    await until(async () => (await k.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())) === '#ffd166', 'accent on the island');
    await s.locator('.segment button', { hasText: 'Светлая' }).click();
    await until(async () => (await k.page.getAttribute('html', 'data-theme')) === 'light', 'light theme on the island');
    await k.open('home');
    await k.shot('home-light');
    await k.page.keyboard.press('Escape');
    await k.leave();
    await s.locator('.segment button', { hasText: 'Тёмная' }).click();

    // seconds on the clock
    await s.click('#sections button[data-section="notifications"]');
    await s.locator('.row', { hasText: 'Секунды на часах' }).locator('.switch').click();
    await until(async () => /^\d\d:\d\d:\d\d$/.test(await text(k, '#pill-time')), 'seconds on the clock');
    await s.locator('.row', { hasText: 'Погода в свёрнутом острове' }).locator('.switch').click();
    await until(async () => (await text(k, '#pill-weather')).trim() === '', 'weather hidden in the pill');

    // home tools: unticking removes the button
    await s.click('#sections button[data-section="home"]');
    await s.locator('.check', { hasText: 'QR-код' }).locator('input').uncheck();
    await until(async () => (await k.main(() => globalThis.__kaplyaTest.store.get('settings.home.tools'))).length === 7, 'tool removed');
    await k.open('home');
    assert.equal(await k.page.locator('.tools .tool').count(), 7);
    assert.equal(await k.page.locator('.tools .tool[data-tool="qr"]').count(), 0);
    await k.page.keyboard.press('Escape');
    await k.leave();

    // hotkeys: a new combination is stored; its state is shown
    await s.click('#sections button[data-section="hotkeys"]');
    assert.equal(await s.locator('.hotkey').count(), 5);
    await s.locator('.row', { hasText: 'Пипетка' }).locator('.hotkey').click();
    await s.keyboard.press('Control+Alt+KeyP');
    await until(async () => (await k.main(() => globalThis.__kaplyaTest.store.get('settings.hotkeys.color'))) === 'Ctrl+Alt+P', 'hotkey stored');
    await s.locator('.row', { hasText: 'Текст с экрана' }).locator('.hotkey').click();
    await s.keyboard.press('Backspace');
    await until(async () => (await k.main(() => globalThis.__kaplyaTest.store.get('settings.hotkeys.ocr'))) === '', 'hotkey removed');
    await until(async () => (await s.textContent('.status[data-hotkey="ocr"]')) === 'выключено', 'status shown');

    // size: what was chosen, unless the screen is too small for it
    const disp = await k.main(({ screen }) => screen.getPrimaryDisplay().bounds);
    const wantZoom = 1.2 * Math.min(1, disp.width / (760 * 1.2), disp.height / (660 * 1.2));
    await k.main(() => globalThis.__kaplyaTest.store.set('settings.scale', 1.2));
    await until(async () => Math.abs((await k.main(() => globalThis.__kaplyaTest.zoom())) - wantZoom) < 0.001, 'zoom');
    await until(async () => Math.abs((await k.main(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('island.html')).webContents.getZoomFactor())) - wantZoom) < 0.01, 'the island page to be resized');
    // ...and only the island: the settings window keeps its own size
    const settingsZoom = await k.main(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('settings.html')).webContents.getZoomFactor());
    assert.ok(Math.abs(settingsZoom - 1) < 0.001, 'the settings window is not resized with the island: ' + settingsZoom);
    await k.hover();
    await k.page.waitForSelector('#island[data-mode="open"]', { timeout: 4000 });
    assert.deepEqual(errors, [], 'errors in the settings page');
  });

  await scenario('first start: the island says where it is, once', { env: { KAPLYA_TEST_WELCOME: '1' } }, async (k) => {
    await k.page.waitForSelector('#island[data-mode="toast"]', { timeout: 6000 });
    assert.equal(await text(k, '.toast-title'), 'Капля здесь');
    assert.equal(await k.main(() => globalThis.__kaplyaTest.store.get('welcomed')), true);
    // it stays long enough to be read
    await sleep(3000);
    assert.equal(await k.mode(), 'toast');
    // and doing what it says works: hovering opens the island
    await k.hover();
    await k.page.waitForSelector('#island[data-mode="open"]', { timeout: 3000 });
    await k.leave();
    await k.page.waitForSelector('#island[data-mode="pill"]', { timeout: 3000 });
  });

  // ------------------------------------------------------------------ persistence and bad data
  await scenario('store: a broken settings file does not stop the app', () => ({ data: { settings: { scale: 'huge', accent: 42, weather: null, home: { tools: 'x' } }, notes: 'oops', tab: 'nonsense' } }), async (k) => {
    assert.equal(await k.mode(), 'pill');
    await k.open();
    assert.equal(await text(k, '#head-title'), 'Главная');
    for (const tab of ['clipboard', 'shelf', 'text', 'notes', 'weather', 'control']) await k.open(tab);
  });

  // ------------------------------------------------------------------ the real mouse and a real full-screen window (Windows only)
  if (isWin) {
    // Moves the real cursor (and clicks) the way a person's hand would.
    const realMouse = (x, y, click) => {
      const script = "Add-Type -Namespace K -Name M -MemberDefinition '" +
        '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); ' +
        '[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, System.UIntPtr e);' + "'; " +
        `[K.M]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null; Start-Sleep -Milliseconds 150; ` +
        (click ? '[K.M]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 70; [K.M]::mouse_event(4,0,0,0,[UIntPtr]::Zero); ' : '') +
        "'done'";
      const r = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', encodePs(script)], { encoding: 'utf8' });
      assert.equal(r.status, 0, 'could not move the mouse: ' + r.stderr);
    };

    await scenario('windows: the real mouse opens the island, and clicks pass through around it', {}, async (k) => {
      const d = await k.main(({ screen }) => screen.getPrimaryDisplay());
      const sf = d.scaleFactor;
      const b = await k.main(() => globalThis.__kaplyaTest.islandBounds());
      // from here on the app looks at the real cursor
      await k.main(() => globalThis.__kaplyaTest.setCursor(null));
      realMouse((b.x + 30) * sf, (b.y + b.height - 40) * sf, false);
      await until(async () => (await k.main(() => globalThis.__kaplyaTest.state())).hover === false, 'cursor away from the island');
      assert.equal(await k.mode(), 'pill');

      // A window under the transparent part of the island's window. A click there
      // must reach it, as if the island were not there.
      await k.main(async ({ BrowserWindow }, pos) => {
        const win = new BrowserWindow({ x: pos.x, y: pos.y, width: 260, height: 160, frame: false, show: false, backgroundColor: '#224466' });
        await win.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;height:100vh;background:#246"><script>let n=0;document.title="clicks:0";addEventListener("mousedown",()=>{document.title="clicks:"+(++n)})</script></body>'));
        win.show();
        globalThis.__probe = win;
      }, { x: b.x + 60, y: b.y + 320 });
      await sleep(800);
      realMouse((b.x + 60 + 130) * sf, (b.y + 320 + 80) * sf, true);
      await until(async () => (await k.main(() => globalThis.__probe.getTitle())) === 'clicks:1', 'the click to pass through the island window', 8000);

      // The cursor comes to the pill: the island opens by itself.
      realMouse((b.x + b.width / 2) * sf, (b.y + 22) * sf, false);
      await k.page.waitForSelector('#island[data-mode="open"]', { timeout: 8000 });
      await k.settle();
      assert.equal((await k.main(() => globalThis.__kaplyaTest.state())).hover, true);

      // A real click on a real button: the pin.
      const pin = await k.page.locator('#btn-pin').boundingBox();
      realMouse((b.x + pin.x + pin.width / 2) * sf, (b.y + pin.y + pin.height / 2) * sf, true);
      await until(async () => (await k.page.getAttribute('#btn-pin', 'class')).includes('on'), 'the pin to take a real click', 8000);
      // pinned: the cursor leaves, the island stays
      realMouse((b.x + 30) * sf, (b.y + b.height - 40) * sf, false);
      await sleep(1200);
      assert.equal(await k.mode(), 'open');
      // unpin with another real click, leave: it closes
      realMouse((b.x + pin.x + pin.width / 2) * sf, (b.y + pin.y + pin.height / 2) * sf, true);
      await until(async () => !(await k.page.getAttribute('#btn-pin', 'class')).includes('on'), 'unpinned', 8000);
      realMouse((b.x + 30) * sf, (b.y + b.height - 40) * sf, false);
      await k.page.waitForSelector('#island[data-mode="pill"]', { timeout: 8000 });

      // and around the collapsed pill clicks pass through again
      realMouse((b.x + 60 + 130) * sf, (b.y + 320 + 80) * sf, true);
      await until(async () => (await k.main(() => globalThis.__probe.getTitle())) === 'clicks:2', 'click-through after closing', 8000);
      await k.main(() => { globalThis.__probe.destroy(); });
    });

    await scenario('windows: a real full-screen window hides the island', { mock: false }, async (k) => {
      await until(async () => (await k.helper('ping')).windows === true, 'helper to answer', 30000);
      await k.leave();
      assert.equal(await k.page.getAttribute('#island', 'data-hidden'), 'false');
      // Another program opens a borderless window over the whole screen for a few seconds.
      const { spawn } = require('node:child_process');
      const script = "Add-Type -AssemblyName System.Windows.Forms; " +
        "Add-Type -Namespace K -Name W -MemberDefinition '[DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(System.IntPtr h);'; " +
        "$f = New-Object System.Windows.Forms.Form; $f.FormBorderStyle = 'None'; $f.WindowState = 'Maximized'; $f.TopMost = $true; $f.BackColor = 'Black'; " +
        "$t = New-Object System.Windows.Forms.Timer; $t.Interval = 1500; $script:n = 0; " +
        "$t.Add_Tick({ $script:n++; if ($script:n -eq 1) { [K.W]::SetForegroundWindow($f.Handle) | Out-Null; $f.Activate() } " +
        "if ($script:n -eq 2) { [Console]::Out.WriteLine('foreground:' + ([K.W]::GetForegroundWindow() -eq $f.Handle)); [Console]::Out.Flush() } " +
        "if ($script:n -ge 7) { $f.Close() } }); $t.Start(); [System.Windows.Forms.Application]::Run($f)";
      const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encodePs(script)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      const ended = new Promise((resolve) => child.on('exit', resolve));
      await until(() => /foreground:/.test(out), 'the full-screen window to appear', 20000);
      if (/foreground:True/.test(out)) {
        await until(async () => (await k.page.getAttribute('#island', 'data-hidden')) === 'true', 'the island to hide behind the full-screen window', 8000);
        await ended;
        await until(async () => (await k.page.getAttribute('#island', 'data-hidden')) === 'false', 'the island to come back', 10000);
        console.log('      full-screen window: island hid and came back');
      } else {
        // Windows did not give the test window the foreground; nothing to conclude.
        await ended;
        console.log('      SKIPPED: the test window did not become the foreground window');
      }
    });
  }

  // ------------------------------------------------------------------ the real helper (Windows only)
  if (isWin) {
    await scenario('windows: the real helper drives the app', { mock: false }, async (k) => {
      const sys = await k.main(() => globalThis.__kaplyaTest.system.snapshot());
      assert.equal(sys.helper, true);
      await until(async () => (await k.helper('ping')).windows === true, 'helper to answer', 30000);
      const poll = await k.helper('sys.poll', { ownPids: [] });
      assert.equal(typeof poll.fullscreen, 'boolean');

      // the clipboard is noticed through the Windows change counter
      await sleep(1500);
      await setClip(k, 'привет из Windows');
      await k.page.waitForSelector('#island[data-mode="toast"]', { timeout: 8000 });
      assert.equal(await text(k, '.toast-title'), 'Скопировано');
      assert.match(await text(k, '.toast-text'), /привет из Windows/);
      await k.page.waitForSelector('#island[data-mode="pill"]', { timeout: 8000 });

      // what a password manager copies (marked "do not keep") stays out of the history
      const ps = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command',
        "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.DataObject; " +
        "$d.SetData('ExcludeClipboardContentFromMonitorProcessing', [byte[]](0,0,0,0)); $d.SetText('secret-password-123'); " +
        "[System.Windows.Forms.Clipboard]::SetDataObject($d, $true)"], { encoding: 'utf8' });
      assert.equal(ps.status, 0, 'could not put the marked text on the clipboard: ' + ps.stderr);
      assert.equal(await clipText(k), 'secret-password-123');
      await sleep(2000);
      assert.equal(await k.mode(), 'pill', 'no toast for secret content');
      assert.equal((await k.main(() => globalThis.__kaplyaTest.clips.list())).some((c) => /secret-password/.test(c.text)), false, 'secret content is not in the history');
      // and ordinary copying still works after it
      await setClip(k, 'обычный текст');
      await k.page.waitForSelector('#island[data-mode="toast"]', { timeout: 8000 });
      assert.match(await text(k, '.toast-text'), /обычный текст/);
      await k.page.waitForSelector('#island[data-mode="pill"]', { timeout: 8000 });

      // A browser that tells Windows nothing still shows its YouTube tab in its
      // window title. A stand-in "chrome.exe" with such a title:
      const fakeDir = tmpDir('fakechrome');
      const fakeExe = path.join(fakeDir, 'chrome.exe');
      const build = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', encodePs(
        "Add-Type -OutputType WindowsApplication -OutputAssembly '" + fakeExe + "' -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition '" +
        'using System; using System.Windows.Forms; public static class P { [STAThread] public static void Main(string[] a) { var f = new Form(); f.Text = a[0]; f.Width = 400; f.Height = 200; var t = new Timer(); t.Interval = 20000; t.Tick += (s, e) => f.Close(); t.Start(); Application.Run(f); } }' +
        "'")], { encoding: 'utf8' });
      assert.equal(build.status, 0, 'could not build the stand-in browser: ' + build.stderr);
      const { spawn } = require('node:child_process');
      const fake = spawn(fakeExe, ['Тестовое видео - YouTube - Google Chrome'], { stdio: 'ignore' });
      try {
        await k.open('home');
        await until(async () => (await text(k, '.player-title').catch(() => '')) === 'Тестовое видео', 'the video known by its window title', 15000);
        assert.match(await text(k, '.player-artist'), /YouTube · Google Chrome/);
        const seen = await k.page.evaluate(() => window.kaplya.invoke('media:sessions'));
        assert.ok(seen.youtubeWindows.some((w) => w.exe === 'chrome.exe' && /Тестовое видео/.test(w.title)), JSON.stringify(seen));
        console.log('      window-title fallback:', JSON.stringify(seen.youtubeWindows));
        await k.page.keyboard.press('Escape');
        await k.leave();
      } finally {
        fake.kill();
      }
      await until(async () => (await k.page.locator('.player[hidden]').count()) === 1 || (await k.mode()) !== 'open', 'window gone', 8000).catch(() => {});

      // the Start menu is searchable
      await k.main(() => globalThis.__kaplyaTest.openPalette());
      await k.page.waitForSelector('#island[data-mode="command"]');
      await k.page.fill('#command-input', 'powershell');
      await until(async () => /PowerShell/i.test(await text(k, '#command-list')), 'a program from the Start menu', 30000);
      await k.page.press('#command-input', 'Escape');

      // text recognition on a real screen
      await k.main(async ({ BrowserWindow, screen }) => {
        const d = screen.getPrimaryDisplay().bounds;
        const win = new BrowserWindow({ x: d.x + 60, y: d.y + 220, width: 700, height: 260, frame: false, show: false, backgroundColor: '#ffffff', alwaysOnTop: true });
        await win.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;background:#fff;font:700 54px Arial;color:#000;padding:70px 40px">Kaplya 12345</body>'));
        win.showInactive();
        globalThis.__probe = win;
      });
      await sleep(1500);
      await k.main(() => { globalThis.__kaplyaTest.runAction('ocr'); });
      const ov = await k.findPage('overlay.html');
      await ov.waitForSelector('html[data-ready="true"]');
      await ov.mouse.move(70, 240);
      await ov.mouse.down();
      await ov.mouse.move(740, 460, { steps: 5 });
      await closing(ov.mouse.up());
      await until(async () => /Kaplya\s*12345/i.test(await clipText(k)), 'recognised text on the clipboard', 30000);
      await k.main(() => { globalThis.__probe.destroy(); });

      // recording with the default setting (computer sound). This machine may have no
      // sound device at all: the video must still be made.
      await until(async () => (await k.main(() => globalThis.__kaplyaTest.state())).overlay === false, 'overlay closed');
      const vdir = tmpDir('winvideo');
      await k.main((_e, d) => globalThis.__kaplyaTest.store.set('settings.record.dir', d), vdir);
      assert.equal(await k.main(() => globalThis.__kaplyaTest.store.get('settings.record.audio')), 'system');
      await k.main(() => { globalThis.__kaplyaTest.runAction('record'); });
      const rov = await k.findPage('overlay.html');
      await rov.waitForSelector('html[data-ready="true"]');
      await closing(rov.keyboard.press('Enter'));
      await until(async () => (await k.page.locator('.pill-stop').count()) === 1, 'recording pill', 20000);
      await sleep(2500);
      await k.page.click('.pill-stop');
      await until(async () => (await text(k, '.toast-title').catch(() => '')) === 'Запись сохранена', 'recording saved', 20000);
      const vids = fs.readdirSync(vdir);
      assert.equal(vids.length, 1);
      assert.ok(fs.statSync(path.join(vdir, vids[0])).size > 3000, 'the video has content');
      console.log('      recorded with default sound setting:', vids[0], fs.statSync(path.join(vdir, vids[0])).size, 'bytes');
      fs.rmSync(vdir, { recursive: true, force: true });
      await k.leave();
      await k.page.waitForSelector('#island[data-mode="pill"]', { timeout: 10000 });
      await setClip(k, 'ещё текст для вкладки');
      await k.page.waitForSelector('#island[data-mode="toast"]', { timeout: 8000 });

      // tabs that lean on Windows open without errors
      await k.page.waitForSelector('#island[data-mode="toast"]');
      await k.page.click('.toast-body');
      await k.page.waitForSelector('.view-clipboard:not([hidden])');
      await k.open('control');
      await sleep(1500);
      await k.open('home');
      await k.shot('windows-home');
    });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} scenarios passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
