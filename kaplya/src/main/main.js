'use strict';
// Kaplya: a small island at the top of the screen. This is the main process:
// windows, the tray, hotkeys, and everything the pages are not allowed to do
// themselves (files, clipboard, screen capture, talking to Windows).

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const {
  app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell, protocol, net,
  globalShortcut, dialog, session, desktopCapturer,
} = require('electron');

const { Store } = require('./store.js');
const { WinHelper } = require('./winhelper.js');
const { SystemWatch } = require('./system.js');
const { ClipWatch } = require('./clipwatch.js');
const clipio = require('./clipio.js');
const { NetApi } = require('./netapi.js');
const { Wifi } = require('./wifi.js');
const { Launcher } = require('./launcher.js');
const { ObsClient, ObsControl } = require('./obs.js');
const secret = require('./secret.js');
const { Icons } = require('./icons.js');
const { Activity } = require('./activity.js');

const TEST = process.env.KAPLYA_TEST === '1';
// Tests start from an empty profile every time; the first-start greeting would get
// in their way, so it is shown only to the test that asks for it.
const TEST_QUIET = TEST && process.env.KAPLYA_TEST_WELCOME !== '1';
const SRC = path.join(__dirname, '..');
const RENDERER_DIR = path.join(SRC, 'renderer');
const SHARED_DIR = path.join(SRC, 'shared');
const ASSETS_DIR = path.join(SRC, '..', 'assets');
const PRELOAD = path.join(SRC, 'preload.js');
const VERSION = require('../../package.json').version;

if (process.env.KAPLYA_USERDATA) app.setPath('userData', process.env.KAPLYA_USERDATA);
app.setAppUserModelId('io.github.kaplya.island');

protocol.registerSchemesAsPrivileged([
  { scheme: 'kaplya', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

if (!TEST && !app.requestSingleInstanceLock()) {
  app.quit();
}

// ------------------------------------------------------------------ state

/** @type {Store} */ let store;
/** @type {WinHelper} */ let helper;
/** @type {SystemWatch} */ let system;
/** @type {ClipWatch} */ let clips;
/** @type {NetApi} */ let netApi;
/** @type {Wifi} */ let wifi;
/** @type {Launcher} */ let launcher;
/** @type {ObsControl} */ let obs;
/** @type {Icons} */ let icons;
/** @type {Activity} */ let activity;
let shared = {};

/** @type {BrowserWindow|null} */ let island = null;
/** @type {BrowserWindow|null} */ let overlay = null;
/** @type {BrowserWindow|null} */ let settingsWin = null;
/** @type {Tray|null} */ let tray = null;

let zoom = 1;
let hitRects = [];
let hover = false;
let hold = false;
let cursorTimer = null;
let testCursor = null;
let hotkeyStatus = {};
let quitting = false;
let lastDrag = null; // tests only: the files of the last drag out of the island

const captures = new Map(); // id -> PNG buffer shown by the overlay
let captureSeq = 1;
let captureJob = null; // { id, mode, display }
let rec = null; // { pending, displayId, audio, file, stream, startedAt }

// ------------------------------------------------------------------ helpers

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isOurs(url) {
  try {
    return new URL(url).protocol === 'kaplya:';
  } catch {
    return false;
  }
}

function trusted(event) {
  const frame = event.senderFrame;
  return Boolean(frame && isOurs(frame.url));
}

function handle(channel, fn) {
  ipcMain.handle('k:' + channel, (event, ...args) => {
    if (!trusted(event)) throw new Error('forbidden');
    return fn(...args, event);
  });
}

function listen(channel, fn) {
  ipcMain.on('k:' + channel, (event, ...args) => {
    if (trusted(event)) fn(...args, event);
  });
}

function sendIsland(channel, ...args) {
  if (island && !island.isDestroyed()) island.webContents.send('k:' + channel, ...args);
}

function broadcast(channel, ...args) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && isOurs(win.webContents.getURL())) win.webContents.send('k:' + channel, ...args);
  }
}

/** Shows a message on the island. */
function toast(t) {
  sendIsland('toast', { id: Date.now() + Math.random(), ...t });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function safeDir(kind) {
  const custom = store.get(kind === 'video' ? 'settings.record.dir' : 'settings.screenshots.dir');
  let dir = custom;
  if (!dir) {
    let base;
    try {
      base = app.getPath(kind === 'video' ? 'videos' : 'pictures');
    } catch {
      base = app.getPath('home');
    }
    dir = path.join(base, 'Kaplya');
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ------------------------------------------------------------------ protocol

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

function registerProtocol() {
  protocol.handle('kaplya', async (request) => {
    const url = new URL(request.url);
    // Two names for the same files. The island lives under its own name because the
    // browser engine keeps one zoom level per site name: the island's size must not
    // leak into the settings window or the capture overlay.
    if (url.host !== 'app' && url.host !== 'island') return new Response('not found', { status: 404 });
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    // The frozen screen for the capture overlay. Same origin as the page, so the
    // page may read its pixels.
    if (rel.startsWith('capture/')) {
      const buf = captures.get(rel.slice('capture/'.length).replace(/\.png$/, ''));
      if (!buf) return new Response('gone', { status: 404 });
      return new Response(buf, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
    }
    let file;
    if (rel === 'vendor/jsqr.js') {
      file = require.resolve('jsqr/dist/jsQR.js');
    } else {
      let base = RENDERER_DIR;
      if (rel.startsWith('shared/')) {
        base = SHARED_DIR;
        rel = rel.slice('shared/'.length);
      } else if (rel.startsWith('assets/')) {
        base = ASSETS_DIR;
        rel = rel.slice('assets/'.length);
      }
      file = path.normalize(path.join(base, rel));
      if (!file.startsWith(base + path.sep)) return new Response('forbidden', { status: 403 });
    }
    try {
      const data = await fs.promises.readFile(file);
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const headers = { 'content-type': type, 'cache-control': 'no-cache' };
      if (type.startsWith('text/html')) headers['content-security-policy'] = CSP;
      return new Response(data, { headers });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

// ------------------------------------------------------------------ the island window

// The widest tab is 720 points wide and the tallest about 600 high. With room for
// the shadow that is the space the island needs at 100% size.
const NEED_W = 760;
const NEED_H = 660;

/** The island's size factor: what the person chose, made smaller if the screen is too small for it. */
function fitZoom(display, chosen) {
  const want = clamp(Number(chosen) || 1, 0.8, 1.4);
  const fit = Math.min(1, display.bounds.width / (NEED_W * want), display.bounds.height / (NEED_H * want));
  return Math.max(0.5, want * fit);
}

function islandBounds() {
  const d = screen.getPrimaryDisplay();
  zoom = fitZoom(d, store.get('settings.scale'));
  const width = Math.min(d.bounds.width, Math.round(940 * zoom));
  const height = Math.min(d.bounds.height, Math.round(740 * zoom));
  return { x: d.bounds.x + Math.round((d.bounds.width - width) / 2), y: d.bounds.y, width, height };
}

function createIsland() {
  const b = islandBounds();
  island = new BrowserWindow({
    ...b,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    focusable: true,
    type: process.platform === 'win32' ? 'toolbar' : undefined,
    title: 'Капля',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webviewTag: true,
      spellcheck: false,
    },
  });
  island.setAlwaysOnTop(true, 'screen-saver');
  island.setIgnoreMouseEvents(true);
  island.webContents.on('did-finish-load', () => island.webContents.setZoomFactor(zoom));
  island.once('ready-to-show', () => {
    island.showInactive();
    startCursorWatch();
  });
  island.on('blur', () => sendIsland('island:blur'));
  island.on('closed', () => {
    island = null;
  });
  // Our pages never navigate; anything else is a link and belongs in the browser.
  island.webContents.on('will-navigate', (e, url) => {
    if (!isOurs(url)) {
      e.preventDefault();
      openExternal(url);
    }
  });
  island.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  island.loadURL('kaplya://island/island.html');
}

function placeIsland() {
  if (!island || island.isDestroyed()) return;
  island.setBounds(islandBounds());
  island.webContents.setZoomFactor(zoom);
  island.setAlwaysOnTop(true, 'screen-saver');
}

function cursorPoint() {
  if (TEST && testCursor) return testCursor;
  return screen.getCursorScreenPoint();
}

// The window is much bigger than the island and lets clicks through. It starts to
// take the mouse only while the cursor is over the island itself. The island tells
// us where it is (hitRects); we watch the cursor.
function tickCursor() {
  if (!island || island.isDestroyed() || !island.isVisible()) return;
  const p = cursorPoint();
  const b = island.getBounds();
  const x = (p.x - b.x) / zoom;
  const y = (p.y - b.y) / zoom;
  let inside = hold;
  if (!inside) {
    for (const r of hitRects) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        inside = true;
        break;
      }
    }
  }
  if (inside !== hover) {
    hover = inside;
    island.setIgnoreMouseEvents(!inside);
    sendIsland('island:hover', inside);
  }
}

function startCursorWatch() {
  if (cursorTimer) clearInterval(cursorTimer);
  cursorTimer = setInterval(tickCursor, 30);
}

function openPalette() {
  if (!island || island.isDestroyed()) return;
  island.show();
  island.focus();
  sendIsland('island:open', { mode: 'command' });
}

function openTab(tab) {
  if (!island || island.isDestroyed()) return;
  sendIsland('island:open', { mode: 'open', tab });
}

// ------------------------------------------------------------------ links and files

function openExternal(url) {
  if (/^(https?:|mailto:|ms-settings:)/i.test(String(url))) shell.openExternal(String(url)).catch(() => {});
}

async function fileIcon(file, size = 'normal') {
  try {
    return await app.getFileIcon(file, { size });
  } catch {
    return null;
  }
}

function describeFile(file) {
  try {
    const st = fs.statSync(file);
    return { path: file, name: path.basename(file) || file, size: st.isDirectory() ? 0 : st.size, dir: st.isDirectory() };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ the row of programs on the home tab

/** The saved list, in today's shape (older versions stored only { path, name }). */
function appsList() {
  const raw = store.get('apps');
  const out = [];
  for (const a of Array.isArray(raw) ? raw : []) {
    if (!a || typeof a !== 'object') continue;
    const kind = ['file', 'folder', 'url', 'explorer'].includes(a.kind) ? a.kind : 'file';
    const item = { id: String(a.id || a.path || a.url || ''), kind, path: String(a.path || ''), url: String(a.url || ''), name: String(a.name || '') };
    if (item.id && !out.some((x) => x.id === item.id)) out.push(item);
  }
  return out;
}

function appsAdd(item) {
  const list = appsList();
  if (list.some((a) => a.id === item.id)) return;
  list.push({ path: '', url: '', ...item });
  store.set('apps', list.slice(0, 40));
}

// ------------------------------------------------------------------ screen capture

function captureDisplay() {
  return screen.getDisplayNearestPoint(cursorPoint());
}

async function grabDisplay(display) {
  const size = {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
  };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!src || src.thumbnail.isEmpty()) throw new Error('capture failed');
  return src.thumbnail;
}

/** Hides the island for the moment of the shot, so it is not in the picture. */
async function withIslandHidden(fn) {
  const canFade = island && !island.isDestroyed() && process.platform !== 'linux';
  if (canFade) {
    island.setOpacity(0);
    await sleep(140);
  }
  try {
    return await fn();
  } finally {
    if (canFade && !overlay) island.setOpacity(1);
  }
}

async function startCapture(mode) {
  if (overlay || captureJob) return;
  if (mode === 'record' && rec) {
    stopRecording();
    return;
  }
  sendIsland('island:collapse');
  const display = captureDisplay();
  let image;
  try {
    image = await withIslandHidden(() => grabDisplay(display));
  } catch {
    if (island && !island.isDestroyed()) island.setOpacity(1);
    toast({ type: 'error', title: 'Не получилось снять экран' });
    return;
  }
  const id = 'c' + captureSeq++;
  captures.set(id, image.toPNG());
  captureJob = { id, mode, display };

  overlay = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    show: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    backgroundColor: '#000000',
    title: 'Капля: выбор области',
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.once('ready-to-show', () => {
    if (!overlay) return;
    overlay.show();
    overlay.focus();
  });
  overlay.on('closed', () => {
    overlay = null;
    captures.delete(id);
    captureJob = null;
    if (island && !island.isDestroyed()) island.setOpacity(1);
  });
  const q = new URLSearchParams({ cap: id, mode, sf: String(display.scaleFactor), accent: store.get('settings.accent') || '' });
  overlay.loadURL('kaplya://app/overlay.html?' + q);
}

function closeOverlay() {
  if (overlay && !overlay.isDestroyed()) overlay.close();
}

async function finishScreenshot(png) {
  const image = nativeImage.createFromBuffer(png);
  if (image.isEmpty()) {
    toast({ type: 'error', title: 'Снимок не получился' });
    return null;
  }
  try {
    await clips.writeOwnImage(png);
  } catch {
    toast({ type: 'error', title: 'Не получилось положить снимок в буфер' });
  }
  let file = null;
  if (store.get('settings.screenshots.save') !== false) {
    try {
      file = path.join(safeDir('picture'), `Снимок ${stamp()}.png`);
      fs.writeFileSync(file, png);
    } catch {
      file = null;
    }
  }
  const size = image.getSize();
  const thumb = image.resize({ width: Math.min(360, size.width), quality: 'good' }).toDataURL();
  toast({ type: 'screenshot', title: 'Скриншот готов', text: `${size.width}×${size.height} · в буфере` + (file ? ' и в папке' : ''), image: thumb, file });
  return file;
}

async function fullScreenshot() {
  sendIsland('island:collapse');
  try {
    const image = await withIslandHidden(() => grabDisplay(captureDisplay()));
    return finishScreenshot(image.toPNG());
  } catch {
    toast({ type: 'error', title: 'Не получилось снять экран' });
    return null;
  }
}

async function recognizeText(png) {
  const file = path.join(os.tmpdir(), `kaplya-ocr-${process.pid}-${Date.now()}.png`);
  try {
    fs.writeFileSync(file, png);
    const r = await helper.call('ocr', { path: file, lang: store.get('settings.ocrLang') || '' }, 60000);
    const text = String(r.text || '').trim();
    if (!text) {
      toast({ type: 'error', title: 'Текст не найден', text: 'Попробуйте выделить область крупнее' });
      return;
    }
    await clips.writeOwn(text);
    toast({ type: 'text', title: 'Текст скопирован', text: text.replace(/\s+/g, ' ').slice(0, 120), payload: text });
  } catch (err) {
    const msg = String(err && err.message || err);
    toast({
      type: 'error',
      title: 'Текст распознать не удалось',
      text: /not-windows/.test(msg) ? 'Распознавание работает только в Windows'
        : /no-ocr-language/.test(msg) ? 'В Windows не установлен языковой пакет с распознаванием текста'
          : msg.slice(0, 120),
    });
  } finally {
    try { fs.unlinkSync(file); } catch {}
  }
}

// ------------------------------------------------------------------ screen recording

function beginRecording(display, rect) {
  const s = store.get('settings.record');
  rec = { pending: true, askedAt: Date.now(), displayId: String(display.id), audio: s.audio, file: null, stream: null, startedAt: 0 };
  // `rect` is in screen pixels, the same pixels the video frames are made of.
  // H.264 wants even sizes.
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  const crop = rect ? { x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width: even(rect.w), height: even(rect.h) } : null;
  sendIsland('rec:begin', { crop, audio: s.audio, format: s.format, fps: clamp(Number(s.fps) || 30, 10, 60) });
}

function stopRecording() {
  if (rec) sendIsland('rec:stop');
}

function isRecording() {
  return Boolean((rec && !rec.pending) || (obs && obs.state.recording));
}

// ------------------------------------------------------------------ recording through OBS Studio

function recordEngine() {
  return store.get('settings.record.engine') === 'obs' ? 'obs' : 'builtin';
}

function obsConfig() {
  const c = store.get('settings.record.obs') || {};
  return {
    host: String(c.host || '127.0.0.1').trim() || '127.0.0.1',
    port: clamp(Math.round(Number(c.port)) || 4455, 1, 65535),
    launch: c.launch !== false,
  };
}

const OBS_ERRORS = {
  unreachable: ['OBS не отвечает', 'Запустите OBS Studio и включите в ней сервер WebSocket'],
  'no-websocket': ['OBS открыта, но не отвечает', 'В OBS: Сервис → Настройки сервера WebSocket → включить сервер'],
  auth: ['OBS: пароль не подошёл', 'Укажите пароль сервера WebSocket в настройках Капли'],
  'auth-missing': ['OBS просит пароль', 'Укажите пароль сервера WebSocket в настройках Капли'],
  'not-installed': ['OBS Studio не найдена', 'Установите OBS или выберите встроенную запись'],
  timeout: ['OBS не ответила вовремя', 'Попробуйте ещё раз'],
  closed: ['Связь с OBS оборвалась', 'Попробуйте ещё раз'],
};

function obsErrorToast(err) {
  const code = err && err.code === 'auth' && !store.get('obsSecret') ? 'auth-missing' : err && err.code;
  const known = OBS_ERRORS[code];
  if (known) return { type: 'error', title: known[0], text: known[1], settings: 'capture', hold: 8000 };
  return { type: 'error', title: 'OBS не смогла выполнить команду', text: String((err && err.message) || err).slice(0, 140), settings: 'capture', hold: 8000 };
}

async function obsToggle() {
  sendIsland('island:collapse');
  try {
    await obs.toggle();
  } catch (err) {
    toast(obsErrorToast(err));
  }
}

async function obsStop() {
  try {
    await obs.stop();
  } catch (err) {
    toast(obsErrorToast(err));
  }
}

function findObsProgram() {
  const dirs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432].filter(Boolean);
  for (const dir of dirs) {
    const exe = path.join(dir, 'obs-studio', 'bin', '64bit', 'obs64.exe');
    if (fs.existsSync(exe)) return { exe, cwd: path.dirname(exe) };
  }
  // Installed somewhere else (Steam, another disk): the Start menu shortcut knows where.
  const entry = launcher.apps.find((a) => a.kind === 'file' && /^obs studio/i.test(a.name));
  if (entry) {
    try {
      const link = shell.readShortcutLink(entry.target);
      if (link && link.target && fs.existsSync(link.target)) return { exe: link.target, cwd: link.cwd || path.dirname(link.target) };
    } catch {}
  }
  return null;
}

/** Starts OBS minimised to the tray. @returns {Promise<boolean>} false when OBS is not on this computer */
async function launchObs() {
  if (process.platform !== 'win32') return false;
  await launcher.refresh().catch(() => {});
  const found = findObsProgram();
  if (!found) return false;
  try {
    // OBS must be started from its own folder, or it cannot find its files.
    spawn(found.exe, ['--minimize-to-tray'], { cwd: found.cwd, detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return true;
  } catch {
    return false;
  }
}

function obsProgramRunning() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('tasklist.exe', ['/FI', 'IMAGENAME eq obs64.exe', '/NH', '/FO', 'CSV'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      resolve(!err && /obs64\.exe/i.test(String(stdout)));
    });
  });
}

function canExcludeFromCapture() {
  if (process.platform !== 'win32') return true;
  const build = Number(String(os.release()).split('.')[2]) || 0;
  return build >= 19041;
}

function recordingEnded(error) {
  const r = rec;
  rec = null;
  if (island && !island.isDestroyed()) island.setContentProtection(false);
  broadcast('rec:state', { recording: false });
  if (!r) return;
  const done = () => {
    if (error || !r.file) {
      if (r.file) { try { fs.unlinkSync(r.file); } catch {} }
      toast({ type: 'error', title: 'Запись не получилась', text: String(error || '').slice(0, 140) });
      return;
    }
    const secs = Math.max(1, Math.round((Date.now() - r.startedAt) / 1000));
    toast({ type: 'record', title: 'Запись сохранена', text: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} · ${path.basename(r.file)}`, file: r.file });
  };
  if (r.stream) r.stream.end(done);
  else done();
}

// ------------------------------------------------------------------ actions shared by buttons, hotkeys and the command line

async function runAction(id) {
  switch (id) {
    case 'region': return startCapture('region');
    case 'ocr': return startCapture('ocr');
    case 'qr': return startCapture('qr');
    case 'color': return startCapture('color');
    case 'record':
      // OBS records when it is chosen in the settings, or when it is recording right now.
      if (!rec && (recordEngine() === 'obs' || obs.state.recording)) return obsToggle();
      // A recording that was asked for but never began (the page did not answer)
      // must not block the next attempt for ever.
      if (rec && rec.pending && Date.now() - rec.askedAt > 15000) rec = null;
      return rec ? stopRecording() : startCapture('record');
    case 'screen': return fullScreenshot();
    case 'plain': {
      const text = await clipio.readText();
      if (!text) return toast({ type: 'error', title: 'В буфере нет текста' });
      await clips.writeOwn(text);
      return toast({ type: 'info', icon: 'eraser', title: 'Форматирование убрано', text: text.replace(/\s+/g, ' ').slice(0, 100) });
    }
    case 'command': return openPalette();
    case 'theme': return system.setTheme(!system.dark).catch(() => toast({ type: 'error', title: 'Тему переключить не удалось' }));
    case 'lock': case 'sleep': case 'restart': case 'shutdown':
      return helper.call('power', { action: id }).catch(() => toast({ type: 'error', title: 'Не получилось', text: 'Команда доступна только в Windows' }));
    case 'settings': return openSettings();
    case 'quit': return quit();
    default: return undefined;
  }
}

function quit() {
  quitting = true;
  app.quit();
}

// ------------------------------------------------------------------ settings window, tray, hotkeys

function openSettings(section) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    if (section) settingsWin.webContents.send('k:settings:section', section);
    return;
  }
  settingsWin = new BrowserWindow({
    width: 820,
    height: 660,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: 'Капля: настройки',
    backgroundColor: '#111114',
    autoHideMenuBar: true,
    icon: path.join(ASSETS_DIR, 'icon.png'),
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
  settingsWin.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  settingsWin.loadURL('kaplya://app/settings.html' + (section ? '#' + encodeURIComponent(section) : ''));
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(ASSETS_DIR, 'tray.png'));
    if (img.isEmpty()) return;
    tray = new Tray(img);
    tray.setToolTip('Капля');
    tray.on('click', () => openTab(store.get('tab') || 'home'));
    refreshTray();
  } catch {
    tray = null;
  }
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть остров', click: () => openTab(store.get('tab') || 'home') },
    { label: 'Командная строка', click: () => openPalette() },
    { type: 'separator' },
    { label: 'Скриншот области', click: () => runAction('region') },
    { label: 'Текст с экрана', click: () => runAction('ocr') },
    { label: isRecording() ? 'Остановить запись' : 'Запись экрана', click: () => runAction('record') },
    { type: 'separator' },
    { label: 'Запускать вместе с Windows', type: 'checkbox', checked: Boolean(store.get('settings.autostart')), click: (item) => store.set('settings.autostart', item.checked) },
    { label: 'Настройки…', click: () => openSettings() },
    { type: 'separator' },
    { label: 'Выход', click: () => quit() },
  ]));
}

function applyAutostart() {
  if (process.platform !== 'win32' || TEST) return;
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(store.get('settings.autostart')),
      path: exe,
      args: app.isPackaged ? [] : [app.getAppPath()],
    });
  } catch {}
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const keys = store.get('settings.hotkeys') || {};
  const status = {};
  const reg = (name, fn) => {
    const acc = String(keys[name] || '').trim();
    if (!acc) {
      status[name] = 'off';
      return;
    }
    try {
      status[name] = globalShortcut.register(acc, fn) ? 'ok' : 'busy';
    } catch {
      status[name] = 'invalid';
    }
  };
  reg('palette', () => openPalette());
  reg('region', () => runAction('region'));
  reg('ocr', () => runAction('ocr'));
  reg('color', () => runAction('color'));
  reg('record', () => runAction('record'));
  hotkeyStatus = status;
  broadcast('hotkeys:status', status);
}

// ------------------------------------------------------------------ reminders

function checkReminders() {
  const list = store.get('reminders') || [];
  const now = Date.now();
  let changed = false;
  for (const r of list) {
    if (!r.fired && r.at <= now) {
      r.fired = true;
      changed = true;
      toast({ type: 'reminder', title: r.text || 'Напоминание', text: 'Напоминание', sound: true, sticky: true });
    }
  }
  if (changed) store.set('reminders', list);
}

// ------------------------------------------------------------------ IPC

const STORE_KEYS = ['tab', 'notes', 'activeNote', 'reminders', 'apps', 'shelf', 'likes'];
const storeKeyAllowed = (key) => typeof key === 'string' && (key.startsWith('settings.') || STORE_KEYS.includes(key));

function registerIpc() {
  handle('app:init', () => ({
    version: VERSION,
    platform: process.platform,
    test: TEST,
    data: { ...store.data, obsSecret: undefined }, // pages never see the stored password
    system: system.snapshot(),
    clips: clips.list(),
    hotkeys: hotkeyStatus,
    recording: isRecording(),
    recordingSince: obs.state.recording ? obs.state.startedAt : rec && rec.startedAt ? rec.startedAt : 0,
  }));

  handle('store:get', (key) => (String(key).startsWith('obsSecret') ? undefined : store.get(key)));
  handle('store:set', (key, value) => {
    if (!storeKeyAllowed(key)) throw new Error('bad key');
    store.set(key, value);
    return true;
  });

  // --- island geometry and focus
  // The page is up: on the very first start, say where the island is.
  handle('island:ready', () => {
    if (store.get('welcomed') || TEST_QUIET) return false;
    store.set('welcomed', true);
    setTimeout(() => toast({ type: 'info', icon: 'droplet', title: 'Капля здесь', text: 'Наведите курсор, чтобы раскрыть остров', hold: 9000, quiet: true }), 900);
    return true;
  });
  listen('island:rects', (rects) => {
    hitRects = Array.isArray(rects) ? rects.filter((r) => r && [r.x, r.y, r.w, r.h].every(Number.isFinite)) : [];
    tickCursor();
  });
  listen('island:hold', (v) => {
    hold = Boolean(v);
  });
  listen('island:blurme', () => {
    if (island && !island.isDestroyed() && island.isFocused()) island.blur();
  });
  listen('island:focusme', () => {
    if (island && !island.isDestroyed()) island.focus();
  });

  // --- music and volume
  handle('media:cmd', (action, position) => system.mediaCommand(String(action), Number(position) || 0));
  handle('volume:set', (change) => system.setVolume(change || {}).catch(() => system.volume));
  handle('lyrics:get', (track) => (store.get('settings.lyrics') === false ? null : netApi.lyrics(track || {})));
  handle('media:sessions', async () => {
    const r = await helper.tryCall('media.sessions', {}, { sessions: [] }, 8000);
    return { sessions: system.sessions((r && r.sessions) || []) };
  });
  // the music service inside the island: what it plays, and its cover
  const webCovers = new Map();
  listen('webmedia:state', async (state) => {
    if (!state || typeof state !== 'object') return system.setWeb(null);
    const clean = {
      service: String(state.service || '').slice(0, 40),
      title: String(state.title || '').slice(0, 300),
      artist: String(state.artist || '').slice(0, 300),
      album: String(state.album || '').slice(0, 300),
      art: /^https:\/\//i.test(String(state.art || '')) ? String(state.art) : '',
      playing: Boolean(state.playing),
      position: Number(state.position) || 0,
      duration: Number(state.duration) || 0,
    };
    let cover = clean.art ? webCovers.get(clean.art) : null;
    system.setWeb(clean, cover || null);
    if (clean.art && cover === undefined) {
      webCovers.set(clean.art, null);
      try {
        cover = await netApi.imageDataUrl(clean.art);
        webCovers.set(clean.art, cover);
        if (webCovers.size > 40) webCovers.delete(webCovers.keys().next().value);
        if (system.web && system.web.state.art === clean.art) system.web.cover = cover;
      } catch {}
    }
    return undefined;
  });
  handle('media:follow', (id) => system.follow(String(id || '')));
  handle('youtube:find', (title, channel) => netApi.youtubeFind(String(title || ''), String(channel || '')));

  // --- clipboard
  handle('clip:list', () => clips.list());
  handle('clip:copy', (id) => clips.copy(Number(id)));
  handle('clip:delete', (id) => clips.remove(Number(id)));
  handle('clip:pin', (id) => clips.togglePin(Number(id)));
  handle('clip:clear', () => clips.clear());
  handle('clip:write', async (text) => {
    await clips.writeOwn(String(text || ''));
    return true;
  });
  handle('clip:read', () => clipio.readText());

  // --- tools
  handle('action', (id) => runAction(String(id)));
  handle('capture:done', async (result) => {
    const job = captureJob;
    if (!job || !result) return closeOverlay();
    const png = result.png ? Buffer.from(result.png) : null;
    closeOverlay();
    switch (job.mode) {
      case 'region':
        if (png) await finishScreenshot(png);
        break;
      case 'ocr':
        if (png) await recognizeText(png);
        break;
      case 'qr': {
        const text = String(result.text || '');
        if (!text) {
          toast({ type: 'error', title: 'QR-код не найден', text: 'Выделите область с кодом целиком' });
        } else {
          await clips.writeOwn(text);
          toast({ type: 'qr', title: 'QR-код прочитан', text: text.slice(0, 140), payload: text });
        }
        break;
      }
      case 'color': {
        const color = String(result.color || '');
        if (/^#[0-9a-f]{6}$/i.test(color)) {
          await clips.writeOwn(color);
          toast({ type: 'color', title: color.toUpperCase(), text: 'Цвет скопирован', color });
        }
        break;
      }
      case 'record':
        beginRecording(job.display, result.rect || null);
        break;
      default:
    }
    return true;
  });
  handle('capture:cancel', () => closeOverlay());
  handle('capture:info', () => (captureJob ? { id: captureJob.id, mode: captureJob.mode } : null));

  // --- recording (the island page records, we keep the file)
  handle('rec:started', (info) => {
    if (!rec) return false;
    const ext = /mp4/i.test(String(info && info.mime)) ? 'mp4' : 'webm';
    rec.file = path.join(safeDir('video'), `Запись ${stamp()}.${ext}`);
    rec.stream = fs.createWriteStream(rec.file);
    rec.stream.on('error', () => {});
    rec.pending = false;
    rec.startedAt = Date.now();
    // Keep the island itself out of the video. Only where Windows can leave a window
    // out of a capture (Windows 10 version 2004 and later); older versions would
    // paint a black box over the whole window instead.
    if (island && !island.isDestroyed() && canExcludeFromCapture()) island.setContentProtection(true);
    broadcast('rec:state', { recording: true, startedAt: rec.startedAt });
    refreshTray();
    return true;
  });
  listen('rec:chunk', (chunk) => {
    if (rec && rec.stream && chunk) rec.stream.write(Buffer.from(chunk));
  });
  handle('rec:finish', (error) => {
    recordingEnded(error || null);
    refreshTray();
    return true;
  });
  handle('rec:stop', () => (obs.state.recording ? obsStop() : stopRecording()));

  // --- recording through OBS Studio
  handle('obs:info', () => ({
    engine: recordEngine(),
    hasPassword: Boolean(store.get('obsSecret')),
    connected: obs.state.connected,
    version: obs.state.version,
    recording: obs.state.recording,
  }));
  // "auth" without a stored password means "OBS wants one"; with one, "it is wrong".
  const obsTest = async () => ({ ...(await obs.test()), hasPassword: Boolean(store.get('obsSecret')) });
  handle('obs:setPassword', async (password) => {
    store.set('obsSecret', await secret.seal(String(password || '')));
    return obsTest();
  });
  handle('obs:test', obsTest);

  // --- weather
  handle('weather:get', async (force) => {
    const place = store.get('settings.weather.place');
    if (!place) return null;
    try {
      return await netApi.weather(place, Boolean(force));
    } catch {
      return { error: true, place };
    }
  });
  handle('weather:search', (q) => netApi.searchPlaces(q).catch(() => []));
  handle('translate', async (text, from, to) => {
    try {
      return { ok: true, ...(await netApi.translate(String(text || '').slice(0, 30000), String(from || 'auto'), String(to || 'ru'))) };
    } catch {
      return { ok: false };
    }
  });
  handle('weather:locate', () => netApi.locate().catch(() => null));

  // --- control centre
  handle('wifi:list', (scan) => wifi.list(Boolean(scan)));
  handle('wifi:connect', (ssid, password) => wifi.connect(String(ssid), password ? String(password) : ''));
  handle('wifi:disconnect', () => wifi.disconnect());
  handle('radio:get', () => helper.tryCall('radio.get', {}, { wifi: null, bluetooth: null }, 15000));
  handle('radio:set', (kind, on) => helper.call('radio.set', { kind: String(kind), on: Boolean(on) }, 15000));
  handle('theme:set', (dark) => system.setTheme(Boolean(dark)));

  // --- command line
  handle('palette:query', (q) => launcher.query(q, { search: store.get('settings.search') }));
  handle('palette:app', async (kind, target) => {
    const res = launcher.openApp(String(kind), String(target));
    if (res && res.path) return (await shell.openPath(res.path)) === '';
    return Boolean(res);
  });

  // --- the row of programs, folders and links on the home tab
  handle('apps:list', () => appsList());
  handle('apps:pickFile', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Добавить на остров',
      properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
      filters: [{ name: 'Программы, ярлыки и файлы', extensions: ['*'] }],
    });
    if (res.canceled) return appsList();
    for (const file of res.filePaths) {
      appsAdd({ id: file, kind: 'file', path: file, name: path.basename(file).replace(/\.(exe|lnk|url|bat|cmd|appref-ms)$/i, '') });
    }
    return appsList();
  });
  handle('apps:pickFolder', async () => {
    const res = await dialog.showOpenDialog({ title: 'Добавить папку на остров', properties: ['openDirectory'] });
    if (res.canceled) return appsList();
    for (const dir of res.filePaths) appsAdd({ id: dir, kind: 'folder', path: dir, name: path.basename(dir) || dir });
    return appsList();
  });
  handle('apps:addPath', (file) => {
    const info = describeFile(String(file || ''));
    if (!info) return appsList();
    appsAdd({ id: info.path, kind: info.dir ? 'folder' : 'file', path: info.path, name: info.name.replace(/\.(exe|lnk|url|bat|cmd|appref-ms)$/i, '') });
    return appsList();
  });
  handle('apps:addUrl', (address, name) => {
    let url = String(address || '').trim();
    if (!url) throw new Error('empty');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('bad-url');
    }
    if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname.includes('.')) throw new Error('bad-url');
    appsAdd({ id: 'url:' + parsed.href, kind: 'url', url: parsed.href, name: String(name || '').trim() || parsed.hostname.replace(/^www\./, '') });
    return appsList();
  });
  handle('apps:addExplorer', () => {
    appsAdd({ id: 'explorer', kind: 'explorer', name: 'Проводник' });
    return appsList();
  });
  handle('apps:remove', (id) => {
    store.set('apps', appsList().filter((a) => a.id !== id));
    return appsList();
  });
  handle('apps:move', (id, toIndex) => {
    const list = appsList();
    const from = list.findIndex((a) => a.id === id);
    if (from < 0) return list;
    const [item] = list.splice(from, 1);
    list.splice(clamp(Math.round(Number(toIndex)) || 0, 0, list.length), 0, item);
    store.set('apps', list);
    return list;
  });
  handle('apps:open', async (id) => {
    const item = appsList().find((a) => a.id === id);
    if (!item) return false;
    if (item.kind === 'url') {
      openExternal(item.url);
      return true;
    }
    if (item.kind === 'explorer') {
      if (process.platform !== 'win32') return (await shell.openPath(app.getPath('home'))) === '';
      try {
        spawn('explorer.exe', [], { detached: true, stdio: 'ignore' }).unref();
        return true;
      } catch {
        return false;
      }
    }
    return (await shell.openPath(item.path)) === '';
  });
  handle('apps:icon', async (id) => {
    const item = appsList().find((a) => a.id === id);
    if (!item) return null;
    if (item.kind === 'url') return icons.forSite(item.url);
    if (item.kind === 'explorer') return icons.forFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'));
    if (item.kind === 'folder') return (await icons.thumbnail(item.path, 96)) || icons.forFile(item.path);
    return icons.forFile(item.path);
  });
  handle('file:thumb', (file) => icons.forShelf(String(file)));

  // --- time spent in programs
  handle('activity:report', (range) => activity.report(['today', 'yesterday', 'week'].includes(range) ? range : 'today'));
  handle('activity:icon', (file) => (file && fs.existsSync(String(file)) ? icons.forFile(String(file)) : null));
  handle('activity:clear', () => {
    activity.clear();
    return true;
  });
  handle('file:icon', (file) => icons.forFile(String(file)));
  handle('apps:pick', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Добавить программу на остров',
      properties: ['openFile', 'dontAddToRecent'],
      filters: [{ name: 'Программы и ярлыки', extensions: ['exe', 'lnk', 'url', 'bat', 'cmd'] }, { name: 'Все файлы', extensions: ['*'] }],
    });
    if (res.canceled || !res.filePaths.length) return null;
    const file = res.filePaths[0];
    appsAdd({ id: file, kind: 'file', path: file, name: path.basename(file).replace(/\.(exe|lnk|url|bat|cmd)$/i, '') });
    return appsList();
  });

  // --- shelf
  handle('shelf:add', (paths) => {
    const shelf = store.get('shelf') || [];
    for (const p of Array.isArray(paths) ? paths : []) {
      const info = describeFile(String(p));
      if (info && !shelf.some((s) => s.path === info.path)) shelf.push(info);
    }
    store.set('shelf', shelf.slice(-60));
    return store.get('shelf');
  });
  handle('shelf:pick', async () => {
    const res = await dialog.showOpenDialog({ title: 'Положить на полку', properties: ['openFile', 'multiSelections', 'dontAddToRecent'] });
    if (res.canceled) return store.get('shelf');
    const shelf = store.get('shelf') || [];
    for (const p of res.filePaths) {
      const info = describeFile(p);
      if (info && !shelf.some((x) => x.path === info.path)) shelf.push(info);
    }
    store.set('shelf', shelf.slice(-60));
    return store.get('shelf');
  });
  handle('shelf:removeMany', (files) => {
    const gone = new Set(Array.isArray(files) ? files.map(String) : []);
    store.set('shelf', (store.get('shelf') || []).filter((x) => !gone.has(x.path)));
    return store.get('shelf');
  });
  handle('shelf:remove', (file) => {
    store.set('shelf', (store.get('shelf') || []).filter((s) => s.path !== file));
    return store.get('shelf');
  });
  handle('shelf:clear', () => {
    store.set('shelf', []);
    return [];
  });
  // Dragging out of the island: files from the shelf, or a fresh screenshot.
  listen('file:drag', async (paths, event) => {
    const known = new Set((store.get('shelf') || []).map((s) => s.path));
    const dirs = [safeDir('picture'), safeDir('video')];
    const files = (Array.isArray(paths) ? paths : []).map(String)
      .filter((f) => (known.has(f) || dirs.some((d) => f.startsWith(d + path.sep))) && fs.existsSync(f));
    if (!files.length) return;
    if (TEST) {
      // A virtual test screen has no drag and drop; say what would have been dragged.
      lastDrag = files;
      return;
    }
    let icon = await fileIcon(files[0]);
    if (!icon || icon.isEmpty()) icon = nativeImage.createFromPath(path.join(ASSETS_DIR, 'tray.png'));
    try {
      event.sender.startDrag({ file: files[0], files, icon });
    } catch {}
  });

  // --- opening things
  handle('open:external', (url) => openExternal(url));
  handle('open:file', async (file) => {
    const f = String(file);
    const known = (store.get('shelf') || []).some((s) => s.path === f) || [safeDir('picture'), safeDir('video')].some((d) => f.startsWith(d + path.sep));
    return known ? (await shell.openPath(f)) === '' : false;
  });
  handle('open:reveal', (file) => {
    const f = String(file);
    if (fs.existsSync(f)) shell.showItemInFolder(f);
  });
  handle('open:folder', (kind) => shell.openPath(safeDir(kind === 'video' ? 'video' : 'picture')));
  handle('open:settings', (section) => openSettings(section));
  handle('dialog:folder', async (title) => {
    const res = await dialog.showOpenDialog({ title: String(title || 'Выберите папку'), properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });
  handle('ocr:langs', () => helper.tryCall('ocr.langs', {}, { langs: [] }, 15000));
  handle('chat:popout', (url) => openChatWindow(String(url)));
  handle('app:quit', () => quit());
}

// ------------------------------------------------------------------ chat windows

const CHAT_PARTITION = 'persist:chat';

function openChatWindow(url) {
  if (!/^https:\/\//i.test(url)) return;
  const win = new BrowserWindow({
    width: 560,
    height: 780,
    title: 'Капля: чат',
    autoHideMenuBar: true,
    backgroundColor: '#111114',
    icon: path.join(ASSETS_DIR, 'icon.png'),
    webPreferences: { partition: CHAT_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(url);
}

function hardenWebContents() {
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (event, webPreferences, params) => {
      delete webPreferences.preload;
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      const src = String(params.src || '');
      // web pages only; tests also use small pages of their own
      if (!/^https:\/\//i.test(src) && src !== 'about:blank' && !(TEST && /^data:text\/html/i.test(src))) event.preventDefault();
    });
    if (contents.getType() === 'webview') {
      // Sign-in pop-ups must share the chat's cookies; they open as small windows.
      contents.setWindowOpenHandler(({ url }) => {
        if (!/^https:\/\//i.test(url)) return { action: 'deny' };
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 520,
            height: 720,
            autoHideMenuBar: true,
            // sign-in windows share the page's cookies
            webPreferences: { session: contents.session, sandbox: true, contextIsolation: true, nodeIntegration: false },
          },
        };
      });
    }
  });
}

function setupSessions() {
  const own = session.defaultSession;
  own.setPermissionRequestHandler((wc, permission, callback) => {
    callback(isOurs(wc.getURL()) && ['media', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission));
  });
  own.setPermissionCheckHandler((_wc, _permission, origin) => isOurs(origin));
  // The island page asks for "the screen"; we decide which one, there is no picker.
  own.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      if (!rec || !rec.pending) return callback({});
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const video = sources.find((s) => String(s.display_id) === rec.displayId) || sources[0];
      if (!video) return callback({});
      const streams = { video };
      const wantSound = rec.audio === 'system' || rec.audio === 'both';
      if (wantSound && request.audioRequested && process.platform === 'win32') streams.audio = 'loopback';
      return callback(streams);
    } catch {
      return callback({});
    }
  });

  // Web pages shown in the island (chats, the weather map, music services, YouTube)
  // each live in their own storage, apart from the app's pages.
  for (const name of WEB_PARTITIONS) setupWebSession(session.fromPartition(name), own);
}

const WEB_PARTITIONS = [CHAT_PARTITION, 'persist:web', 'persist:music'];
const mediaAllowed = new Map(); // origin -> true | false, until the app is closed

function setupWebSession(chat, own) {
  // These sites see an ordinary Chrome; some refuse to sign in to anything else.
  chat.setUserAgent(own.getUserAgent().replace(/\s(Kaplya|kaplya|Electron)\/\S+/g, ''));
  // They are ordinary web pages. They may copy to the clipboard, go full screen and
  // play sound; the microphone and camera only after the person says yes, per
  // site; nothing else (reading the clipboard, location, notifications).
  const originOf = (url) => {
    try {
      return new URL(url).origin;
    } catch {
      return '';
    }
  };
  chat.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission === 'clipboard-sanitized-write' || permission === 'fullscreen') return callback(true);
    if (permission !== 'media') return callback(false);
    // playing sound or video asks for nothing; only a microphone or camera does
    if (details && Array.isArray(details.mediaTypes) && details.mediaTypes.length === 0) return callback(true);
    const origin = originOf((details && details.requestingUrl) || wc.getURL());
    if (!/^https:/.test(origin)) return callback(false);
    if (mediaAllowed.has(origin)) return callback(mediaAllowed.get(origin));
    const what = (details && details.mediaTypes) || [];
    const names = [what.includes('audio') ? 'микрофону' : '', what.includes('video') ? 'камере' : ''].filter(Boolean).join(' и ') || 'микрофону';
    return dialog.showMessageBox({
      type: 'question',
      title: 'Капля',
      message: `Сайт ${origin.replace(/^https:\/\//, '')} просит доступ к ${names}.`,
      detail: 'Разрешение действует, пока Капля не закрыта.',
      buttons: ['Разрешить', 'Запретить'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    }).then((res) => {
      const ok = res.response === 0;
      mediaAllowed.set(origin, ok);
      callback(ok);
    }).catch(() => callback(false));
  });
  chat.setPermissionCheckHandler((_wc, permission, origin) => {
    if (permission === 'clipboard-sanitized-write' || permission === 'fullscreen') return true;
    if (permission === 'media') return mediaAllowed.get(originOf(origin)) === true;
    return false;
  });
}

// ------------------------------------------------------------------ start

async function loadShared() {
  const load = (name) => import(pathToFileURL(path.join(SHARED_DIR, name)).href);
  const [weather, lrc, netsh, fuzzy, calc, remind, languages] = await Promise.all(
    ['weather.mjs', 'lrc.mjs', 'netsh.mjs', 'fuzzy.mjs', 'calc.mjs', 'remind.mjs', 'languages.mjs'].map(load),
  );
  shared = { weather, lrc, netsh, fuzzy, calc, remind, languages };
}

async function main() {
  await app.whenReady();
  await loadShared();
  Menu.setApplicationMenu(null);

  store = new Store(path.join(app.getPath('userData'), 'kaplya.json'));
  const helperCmd = process.env.KAPLYA_HELPER_CMD ? JSON.parse(process.env.KAPLYA_HELPER_CMD) : null;
  const helperScript = path.join(SRC, 'helper', 'helper.ps1').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  helper = new WinHelper({ script: helperScript, command: helperCmd });
  system = new SystemWatch(helper, {
    ownPids: [process.pid],
    // Our own music service may also appear in Windows' list of players; it is
    // shown once, as the island's own.
    isOwnApp: (id) => /kaplya|^electron/i.test(String(id || '')),
    findCover: (track) => (store.get('settings.coverSearch') === false ? null : netApi.cover(track)),
  });
  clips = new ClipWatch(
    {
      io: clipio,
      seq: () => (helper.supported ? helper.call('clip.info', {}, 3000) : Promise.resolve(null)),
      describeImage: (png) => {
        const img = nativeImage.createFromBuffer(png);
        if (img.isEmpty()) return null;
        const size = img.getSize();
        return { ...size, thumb: img.resize({ width: Math.min(320, size.width), quality: 'good' }).toDataURL() };
      },
    },
    { limit: store.get('settings.clipboard.limit'), images: store.get('settings.clipboard.images') },
  );
  // Tests replace the internet with canned answers.
  const fetchFn = TEST && process.env.KAPLYA_TEST_FETCH ? require(process.env.KAPLYA_TEST_FETCH) : (url, init) => net.fetch(url, init);
  netApi = new NetApi(fetchFn, shared);
  wifi = new Wifi(helper, shared);
  icons = new Icons({
    app,
    shell,
    nativeImage,
    fetch: fetchFn,
    dir: path.join(app.getPath('userData'), 'icons'),
    helper: (cmd, args) => helper.call(cmd, args, 8000),
  });
  activity = new Activity({
    file: path.join(app.getPath('userData'), 'activity.json'),
    enabled: () => store.get('settings.activity') !== false,
    ownExe: path.basename(process.execPath),
  });
  obs = new ObsControl({
    client: new ObsClient(),
    getConfig: obsConfig,
    getPassword: () => secret.open(store.get('obsSecret')),
    isRunning: obsProgramRunning,
    launch: launchObs,
  });
  launcher = new Launcher({ helper, shared, getFileIcon: (f) => fileIcon(f) });

  registerProtocol();
  hardenWebContents();
  setupSessions();
  registerIpc();

  system.on('media', (media, info) => {
    sendIsland('sys:media', media);
    if (media && info && info.trackChanged && media.playing && store.get('settings.trackToast') !== false) {
      toast({ type: 'track', title: media.title, text: media.artist, image: media.cover || null, quiet: true });
    }
  });
  system.on('volume', (v) => broadcast('sys:volume', v));
  system.on('webcmd', (action, position) => sendIsland('webmedia:cmd', String(action), Number(position) || 0));
  system.on('poll', (r) => activity.sample(r));
  system.on('theme', (dark) => broadcast('sys:theme', dark));
  system.on('fullscreen', (full) => sendIsland('island:fullscreen', full && store.get('settings.hideOnFullscreen') !== false));
  obs.on('state', (s) => {
    broadcast('rec:state', { recording: s.recording, startedAt: s.startedAt, engine: 'obs' });
    broadcast('obs:state', { connected: s.connected, version: s.version, recording: s.recording });
    // Keep the island itself out of what OBS records, where Windows can do that.
    if (island && !island.isDestroyed() && canExcludeFromCapture()) island.setContentProtection(s.recording);
    refreshTray();
  });
  obs.on('saved', (file) => {
    toast({ type: 'record', title: 'Запись сохранена', text: file ? 'OBS · ' + String(file).split(/[\\/]/).pop() : 'OBS сохранила запись в свою папку', file: file || null });
  });
  obs.on('launching', () => {
    toast({ type: 'info', icon: 'video', title: 'Запускаю OBS…', text: 'Запись начнётся, как только OBS ответит', hold: 7000 });
  });
  clips.on('change', (list) => sendIsland('clip:changed', list));
  clips.on('copied', (item) => {
    if (store.get('settings.copyToast') === false) return;
    toast({
      type: 'copied',
      title: 'Скопировано',
      text: item.kind === 'image' ? `Изображение ${item.width}×${item.height}` : item.text.replace(/\s+/g, ' ').slice(0, 90),
      image: item.kind === 'image' ? item.thumb : null,
      kind: item.kind,
      quiet: true,
    });
  });

  store.on('change', (key, value) => {
    if (key !== 'obsSecret') broadcast('store:changed', key, value); // the stored password stays here
    if (key === 'settings.scale') placeIsland();
    if (key === 'settings.autostart') {
      applyAutostart();
      refreshTray();
    }
    if (key.startsWith('settings.hotkeys')) registerHotkeys();
    if (key === 'settings.clipboard.limit') clips.limit = clamp(Number(value) || 60, 10, 300);
    if (key === 'settings.clipboard.images') clips.keepImages = value !== false;
    if (key === 'settings.hideOnFullscreen') sendIsland('island:fullscreen', system.fullscreen && value !== false);
    if (key === 'settings.record.engine' || key === 'settings.record') obs.setEnabled(recordEngine() === 'obs');
    if (key.startsWith('settings.record.obs') || key === 'obsSecret') obs.reconnect();
  });

  createIsland();
  createTray();
  registerHotkeys();
  applyAutostart();
  system.start();
  clips.start();
  launcher.refresh().catch(() => {});
  obs.setEnabled(recordEngine() === 'obs');
  setInterval(checkReminders, 5000);

  screen.on('display-metrics-changed', placeIsland);
  screen.on('display-added', placeIsland);
  screen.on('display-removed', placeIsland);

  app.on('second-instance', () => openTab(store.get('tab') || 'home'));
  // The app lives in the tray: closing the settings window must not end it.
  app.on('window-all-closed', () => {
    if (quitting) app.quit();
  });
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (rec && rec.stream) rec.stream.end();
    store.saveNow();
    system.stop();
    clips.stop();
    helper.stop();
    obs.setEnabled(false);
    activity.save();
  });

  if (TEST) {
    globalThis.__kaplyaTest = {
      setCursor: (p) => {
        testCursor = p;
        tickCursor();
      },
      islandBounds: () => island.getBounds(),
      zoom: () => zoom,
      toast,
      runAction,
      openPalette,
      openSettings,
      state: () => ({ hover, hitRects, rec: Boolean(rec), overlay: Boolean(overlay), hotkeys: hotkeyStatus }),
      lastDrag: () => lastDrag,
      store,
      clips,
      clipio,
      obs,
      activity,
      system,
      checkReminders,
    };
  }
}

main().catch((err) => {
  console.error(err);
  app.exit(1);
});
