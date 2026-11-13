'use strict';
// Drives the real helper.ps1 through the same bridge the app uses.
//
// On Windows it runs under Windows PowerShell 5.1 and exercises every read-only
// command. Elsewhere it needs PowerShell 7 (`pwsh` in PATH, or KAPLYA_PWSH) and
// checks only the protocol, because the Windows APIs are not there.
//
//   node tests/helper.test.js

const path = require('node:path');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { WinHelper } = require('../src/main/winhelper.js');

const script = path.join(__dirname, '..', 'src', 'helper', 'helper.ps1');
const isWin = process.platform === 'win32';

function findPwsh() {
  for (const exe of [process.env.KAPLYA_PWSH, 'pwsh']) {
    if (!exe) continue;
    const r = spawnSync(exe, ['-NoLogo', '-NoProfile', '-Command', '1'], { encoding: 'utf8' });
    if (r.status === 0) return exe;
  }
  return null;
}

async function main() {
  let command = null;
  if (!isWin) {
    const pwsh = findPwsh();
    if (!pwsh) {
      console.log('SKIP: no PowerShell here (the helper is Windows-only).');
      return;
    }
    command = [pwsh, '-NoLogo', '-NoProfile', '-NonInteractive', '-File', script];
  }
  const helper = new WinHelper({ script, command });
  let failures = 0;
  const check = async (name, fn) => {
    try {
      const out = await fn();
      console.log('ok   ' + name + (out === undefined ? '' : '  ' + JSON.stringify(out).slice(0, 300)));
    } catch (err) {
      failures += 1;
      console.log('FAIL ' + name + '  ' + (err && err.message));
    }
  };

  await check('ping', async () => {
    const r = await helper.call('ping', {}, 30000);
    assert.strictEqual(r.pong, true);
    assert.strictEqual(r.windows, isWin);
    return r;
  });

  await check('non-ASCII text survives both directions', async () => {
    const text = 'Привет, мир — 你好 🙂 "кавычки" \\ / \n перенос';
    const r = await helper.call('echo', { text, list: [1, 'два'], nested: { ok: true } });
    assert.strictEqual(r.text, text);
    assert.deepStrictEqual(r.list, [1, 'два']);
    assert.strictEqual(r.nested.ok, true);
  });

  await check('unknown command is an error, not a crash', async () => {
    await assert.rejects(helper.call('no.such.command'), /unknown command/);
    const r = await helper.call('ping');
    assert.strictEqual(r.pong, true);
  });

  await check('broken JSON does not kill the helper', async () => {
    helper.proc.stdin.write('this is not json\n');
    const r = await helper.call('ping');
    assert.strictEqual(r.pong, true);
  });

  if (isWin) {
    await check('sys.poll', async () => {
      const r = await helper.call('sys.poll', { ownPids: [process.pid] }, 30000);
      assert.strictEqual(typeof r.fullscreen, 'boolean');
      assert.strictEqual(typeof r.dark, 'boolean');
      assert.strictEqual(typeof r.volume.available, 'boolean');
      assert.strictEqual(typeof r.idleMs, 'number');
      // whatever is in front of this test run: it has a name and an exe
      if (r.active) assert.ok(r.active.name && r.active.exe && r.active.pid > 0, JSON.stringify(r.active));
      return r;
    });
    await check('volume.get', async () => {
      const r = await helper.call('volume.get');
      assert.strictEqual(typeof r.available, 'boolean');
      if (r.available) assert.ok(r.level >= 0 && r.level <= 1);
      return r;
    });
    await check('volume.set keeps the level it was given', async () => {
      const before = await helper.call('volume.get');
      if (!before.available) return 'no audio device here';
      const target = before.level > 0.5 ? 0.31 : 0.62;
      const after = await helper.call('volume.set', { level: target });
      assert.ok(Math.abs(after.level - target) < 0.02, 'level ' + after.level);
      await helper.call('volume.set', { level: before.level, muted: before.muted });
      return after;
    });
    await check('media.get', async () => {
      const r = await helper.call('media.get', {}, 30000);
      if (r !== null) assert.strictEqual(typeof r.title, 'string');
      return r;
    });
    await check('media.sessions', async () => {
      const r = await helper.call('media.sessions', {}, 30000);
      assert.ok(Array.isArray(r.sessions));
      return r;
    });
    await check('media.cmd without a player', async () => {
      const cur = await helper.call('media.get');
      if (cur !== null) return 'a player is running, not touching it';
      assert.strictEqual(await helper.call('media.cmd', { action: 'toggle' }), false);
    });
    await check('radio.get', async () => {
      const r = await helper.call('radio.get', {}, 30000);
      assert.ok('wifi' in r && 'bluetooth' in r);
      return r;
    });
    await check('wifi.list', async () => {
      const r = await helper.call('wifi.list', {}, 30000);
      assert.strictEqual(typeof r.available, 'boolean');
      assert.ok(Array.isArray(r.networks));
      return r;
    });
    await check('clip.seq is a number', async () => {
      const r = await helper.call('clip.seq');
      assert.strictEqual(typeof r, 'number');
      return r;
    });
    await check('icon.extract cuts an icon out of a system library', async () => {
      const lib = require('node:path').join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'shell32.dll');
      const r = await helper.call('icon.extract', { path: lib, index: 3, size: 64 }, 30000);
      const png = Buffer.from(r.data, 'base64');
      assert.strictEqual(png.subarray(1, 4).toString('latin1'), 'PNG');
      assert.ok(png.length > 300, 'a real picture: ' + png.length + ' bytes');
      assert.ok(r.size >= 32, 'size ' + r.size);
      await assert.rejects(helper.call('icon.extract', { path: 'C:\\no\\such\\file.dll', index: 0 }), /no-icon/);
      return { bytes: png.length, size: r.size };
    });
    await check('clip.info', async () => {
      const r = await helper.call('clip.info');
      assert.strictEqual(typeof r.seq, 'number');
      assert.strictEqual(typeof r.secret, 'boolean');
      return r;
    });
    await check('apps.list', async () => {
      const r = await helper.call('apps.list', {}, 30000);
      assert.ok(Array.isArray(r.apps));
      for (const a of r.apps) assert.ok(typeof a.name === 'string' && typeof a.id === 'string');
      return r.apps.length + ' apps, e.g. ' + JSON.stringify(r.apps.slice(0, 3));
    });
    await check('ocr.langs', async () => {
      const r = await helper.call('ocr.langs', {}, 30000);
      assert.ok(Array.isArray(r.langs));
      return r;
    });
    if (process.env.KAPLYA_OCR_SAMPLE) {
      await check('ocr reads the sample image', async () => {
        const r = await helper.call('ocr', { path: process.env.KAPLYA_OCR_SAMPLE }, 60000);
        assert.match(r.text, /Kaplya|12345/i);
        return r;
      });
    }
    await check('theme.set to the current value', async () => {
      const cur = await helper.call('sys.poll', { ownPids: [] });
      const r = await helper.call('theme.set', { dark: cur.dark });
      assert.strictEqual(r.dark, cur.dark);
      return r;
    });
  }

  helper.stop();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall helper checks passed');
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
