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
    assert.equal(await text(k, '.player-artist'), 'Прибой');
    await until(async () => (await k.page.locator('.player-lyrics:not([hidden])').count()) === 1, 'lyrics');
    await until(async () => /тёплого берега/.test(await text(k, '.lyric.now')), 'the line being sung at 0:42');
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
    assert.match(await text(k, '.remind-hint'), /Напомню сегодня в \d{1,2}:\d\d: позвонить Ане/);
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
    await k.page.locator('.wstrip-wrap .segment button', { hasText: 'Неделя' }).click();
    assert.equal(await k.page.locator('.wcell').count(), 7);
    assert.equal(await text(k, '.wcell >> nth=0 >> span >> nth=0'), 'Сегодня');
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
  await scenario('shelf: files come in, are listed, leave', {}, async (k) => {
    const dir = tmpDir('shelf');
    const a = path.join(dir, 'Отчёт Q3.pdf');
    const b = path.join(dir, 'logo-final.png');
    fs.writeFileSync(a, Buffer.alloc(1800000));
    fs.writeFileSync(b, Buffer.alloc(402000));
    await k.open('shelf');
    assert.match(await text(k, '.shelf-empty'), /Перетащите сюда файлы/);
    await k.page.evaluate((paths) => window.kaplya.invoke('shelf:add', paths), [a, b, path.join(dir, 'нет такого.txt')]);
    await until(async () => (await k.page.locator('.file').count()) === 2, 'files on the shelf');
    assert.match(await text(k, '.file >> nth=0'), /Отчёт Q3\.pdf.*1,7 МБ/s);
    assert.equal(await text(k, '#rail button[data-tab="shelf"] .badge'), '2');
    await k.settle();
    await k.shot('shelf');
    // the same file twice is one entry
    await k.page.evaluate((paths) => window.kaplya.invoke('shelf:add', paths), [a]);
    await sleep(300);
    assert.equal(await k.page.locator('.file').count(), 2);
    await k.page.locator('.file >> nth=0').hover();
    await k.page.locator('.file >> nth=0').locator('button[title="Убрать с полки"]').click();
    await until(async () => (await k.page.locator('.file').count()) === 1, 'file to leave');
    // it survives a restart of the app
    assert.equal((await k.main(() => globalThis.__kaplyaTest.store.get('shelf'))).length, 1);
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
  await scenario('capture: at 150% display scaling', () => {
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

    // size
    await k.main(() => globalThis.__kaplyaTest.store.set('settings.scale', 1.2));
    await until(async () => Math.abs((await k.main(() => globalThis.__kaplyaTest.zoom())) - 1.2) < 0.001, 'zoom');
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
