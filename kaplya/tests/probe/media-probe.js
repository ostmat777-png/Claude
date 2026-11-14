'use strict';
// A real browser playing real sound on real Windows: does the helper see it the
// way the island needs? Run by the "Kaplya media probe" job.
//
//   node tests/probe/media-probe.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WinHelper } = require('../../src/main/winhelper.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wav(seconds) {
  const rate = 8000;
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / 6) * 300), 44 + i * 2);
  return buf;
}

function findBrowser() {
  const list = [
    process.env.KAPLYA_PROBE_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return list.find((p) => p && fs.existsSync(p));
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('SKIP: Windows only');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaplya-probe-'));
  fs.writeFileSync(path.join(dir, 'tone.wav'), wav(120));
  fs.writeFileSync(path.join(dir, 'page.html'), `<!doctype html><meta charset="utf-8"><title>Тестовая песня - YouTube</title>
<body>
<audio id="a" src="tone.wav" autoplay loop controls></audio>
<div role="slider" aria-label="Ползунок перемотки" aria-valuemin="0" aria-valuemax="120" aria-valuenow="0" id="seek" tabindex="0">seek</div>
<button id="like" aria-label="Нравится это видео и ещё 12 пользователям" aria-pressed="false">like</button>
<button id="dislike" aria-label="Видео не понравилось" aria-pressed="false">dislike</button>
<script>
  const a = document.getElementById('a');
  navigator.mediaSession.metadata = new MediaMetadata({ title: 'Тестовая песня', artist: 'Проба', album: 'Капля' });
  for (const act of ['play', 'pause', 'seekto', 'nexttrack', 'previoustrack']) {
    navigator.mediaSession.setActionHandler(act, (d) => {
      if (act === 'play') a.play();
      if (act === 'pause') a.pause();
      if (act === 'seekto') a.currentTime = d.seekTime;
    });
  }
  setInterval(() => {
    document.getElementById('seek').setAttribute('aria-valuenow', String(Math.floor(a.currentTime)));
    if (a.duration) navigator.mediaSession.setPositionState({ duration: a.duration, position: a.currentTime, playbackRate: 1 });
  }, 500);
  const marks = new Set();
  const paint = () => { document.title = 'Тестовая песня' + [...marks].map((m) => ' [' + m + ']').join('') + ' - YouTube'; };
  for (const id of ['like', 'dislike']) {
    document.getElementById(id).onclick = (e) => {
      const b = e.currentTarget;
      const on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(on));
      if (on) marks.add(id); else marks.delete(id);
      paint();
    };
  }
</script></body>`);

  const exe = findBrowser();
  console.log('browser:', exe);
  const child = spawn(exe, [
    '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
    '--user-data-dir=' + path.join(dir, 'profile'), '--window-size=900,700',
    'file:///' + path.join(dir, 'page.html').replace(/\\/g, '/'),
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  const helper = new WinHelper({ script: path.join(__dirname, '..', '..', 'src', 'helper', 'helper.ps1') });
  const call = async (cmd, args, ms = 30000) => {
    try {
      const r = await helper.call(cmd, args || {}, ms);
      const s = JSON.stringify(r, (k, v) => (k === 'data' && typeof v === 'string' ? `<${v.length} chars>` : v));
      console.log(`\n${cmd} ${JSON.stringify(args || {})}\n  -> ${s}`);
      return r;
    } catch (err) {
      console.log(`\n${cmd} ${JSON.stringify(args || {})}\n  !! ${err && err.message}`);
      return null;
    }
  };

  await sleep(9000);
  await call('media.sessions');
  const m = await call('media.get');
  await sleep(2000);
  await call('media.get', { have: m && m.key });
  if (m && !m.fromTitle) {
    await call('media.cmd', { action: 'pause', app: m.app });
    await sleep(1200);
    await call('media.get', { have: m.key });
    await call('media.cmd', { action: 'seek', position: 60, app: m.app });
    await call('media.cmd', { action: 'play', app: m.app });
    await sleep(1500);
    await call('media.get', { have: m.key });
  }
  // what a page in a browser tells through UI Automation
  await call('page.read', { app: m ? m.app : '' }, 60000);
  await call('page.like', { app: m ? m.app : '' }, 60000);
  await sleep(1000);
  await call('media.sessions');
  await call('page.read', { app: m ? m.app : '' }, 60000);

  helper.stop();
  try {
    process.kill(child.pid);
  } catch {}
  spawn('taskkill', ['/F', '/IM', path.basename(exe)], { stdio: 'ignore' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
