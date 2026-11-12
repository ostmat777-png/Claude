'use strict';
// Starts the BUILT program (what the installer puts on the disk) and checks that
// it found its own files: pages, shared modules, icons, the Windows helper.
//
//   npm run dist                      (on Windows)
//   node tests/e2e/packaged.js [path\to\Kaplya.exe]

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { launch, sleep, ROOT } = require('./harness.js');

function findExe() {
  if (process.argv[2]) return process.argv[2];
  const candidates = [
    path.join(ROOT, 'dist', 'win-unpacked', 'Kaplya.exe'),
    path.join(ROOT, 'dist', 'linux-unpacked', 'kaplya'),
  ];
  return candidates.find((f) => fs.existsSync(f));
}

(async () => {
  const exe = findExe();
  if (!exe) {
    console.log('No built program found. Build it first: npm run dist');
    process.exit(1);
  }
  console.log('starting', exe);
  const real = process.platform === 'win32';
  const k = await launch({ exe, mock: !real });
  let failed = false;
  try {
    const info = await k.page.evaluate(() => window.kaplya.invoke('app:init'));
    assert.equal(info.version, require(path.join(ROOT, 'package.json')).version);
    assert.equal(await k.mode(), 'pill');
    assert.match(await k.page.textContent('#pill-time'), /^\d\d:\d\d$/);

    // shared modules were loaded by the main process: the calculator answers
    const rows = await k.page.evaluate(() => window.kaplya.invoke('palette:query', '2+2*2'));
    assert.equal(rows[0].title, '6');

    // the helper was found next to the program and answers
    const ping = await k.helper('ping');
    assert.equal(ping.pong, true);
    if (real) assert.equal(ping.windows, true);

    // pages, styles and icons are in place
    await k.open('home');
    assert.equal(await k.page.locator('.tools .tool').count(), 8);
    assert.ok((await k.page.locator('#rail svg').count()) >= 8);
    for (const tab of ['clipboard', 'shelf', 'text', 'notes', 'weather', 'control']) await k.open(tab);
    await k.main(() => globalThis.__kaplyaTest.openSettings());
    const s = await k.findPage('settings.html');
    await s.waitForSelector('html[data-ready="true"]');
    const iconOk = await s.evaluate(() => {
      const img = document.querySelector('#brand img');
      return img.complete && img.naturalWidth > 0;
    });
    assert.equal(iconOk, true, 'the app icon is shown in settings');
    await sleep(300);
    assert.deepEqual(k.errors, []);
    console.log('ok    the built program starts and finds its files');
  } catch (err) {
    failed = true;
    console.log('FAIL  ' + (err && err.stack || err));
  } finally {
    await k.close();
  }
  process.exit(failed ? 1 : 0);
})();
