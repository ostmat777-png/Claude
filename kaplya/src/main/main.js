'use strict';
// Kaplya: a small island at the top of the screen. This is the main process:
// windows, the tray, hotkeys, and everything the pages are not allowed to do
// themselves (files, clipboard, screen capture, talking to Windows).

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
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

const TEST = process.env.KAPLYA_TEST === '1';
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
    if (url.host !== 'app') return new Response('not found', { status: 404 });
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

function islandBounds() {
  const d = screen.getPrimaryDisplay();
  zoom = clamp(Number(store.get('settings.scale')) || 1, 0.8, 1.4);
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
  island.loadURL('kaplya://app/island.html');
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
  rec = { pending: true, displayId: String(display.id), audio: s.audio, file: null, stream: null, startedAt: 0 };
  // `rect` is in screen pixels, the same pixels the video frames are made of.
  // H.264 wants even sizes.
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  const crop = rect ? { x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width: even(rect.w), height: even(rect.h) } : null;
  sendIsland('rec:begin', { crop, audio: s.audio, format: s.format, fps: clamp(Number(s.fps) || 30, 10, 60) });
}

function stopRecording() {
  if (rec) sendIsland('rec:stop');
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
    case 'record': return rec ? stopRecording() : startCapture('record');
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
    { label: rec ? 'Остановить запись' : 'Запись экрана', click: () => runAction('record') },
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

const STORE_KEYS = ['tab', 'notes', 'activeNote', 'reminders', 'apps', 'shelf'];
const storeKeyAllowed = (key) => typeof key === 'string' && (key.startsWith('settings.') || STORE_KEYS.includes(key));

function registerIpc() {
  handle('app:init', () => ({
    version: VERSION,
    platform: process.platform,
    test: TEST,
    data: store.data,
    system: system.snapshot(),
    clips: clips.list(),
    hotkeys: hotkeyStatus,
    recording: Boolean(rec && !rec.pending),
  }));

  handle('store:get', (key) => store.get(key));
  handle('store:set', (key, value) => {
    if (!storeKeyAllowed(key)) throw new Error('bad key');
    store.set(key, value);
    return true;
  });

  // --- island geometry and focus
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
    // Keep the island itself out of the video where Windows allows it.
    if (island && !island.isDestroyed()) island.setContentProtection(true);
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
  handle('rec:stop', () => stopRecording());

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

  // --- pinned programs on the home tab
  handle('apps:pick', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Добавить программу на остров',
      properties: ['openFile'],
      filters: [{ name: 'Программы и ярлыки', extensions: ['exe', 'lnk', 'url', 'bat', 'cmd'] }, { name: 'Все файлы', extensions: ['*'] }],
    });
    if (res.canceled || !res.filePaths.length) return null;
    const file = res.filePaths[0];
    const apps = store.get('apps') || [];
    if (!apps.some((a) => a.path === file)) {
      apps.push({ path: file, name: path.basename(file).replace(/\.(exe|lnk|url|bat|cmd)$/i, '') });
      store.set('apps', apps);
    }
    return apps;
  });
  handle('apps:open', async (file) => {
    const apps = store.get('apps') || [];
    if (!apps.some((a) => a.path === file)) return false;
    return (await shell.openPath(file)) === '';
  });
  handle('file:icon', async (file) => {
    const img = await fileIcon(String(file));
    return img && !img.isEmpty() ? img.toDataURL() : null;
  });

  // --- shelf
  handle('shelf:add', (paths) => {
    const shelf = store.get('shelf') || [];
    for (const p of Array.isArray(paths) ? paths : []) {
      const info = describeFile(String(p));
      if (info && !shelf.some((s) => s.path === info.path)) shelf.push(info);
    }
    store.set('shelf', shelf.slice(-40));
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
      if (!/^https:\/\//i.test(String(params.src || ''))) event.preventDefault();
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
            webPreferences: { partition: CHAT_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
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

  // Chat sites see an ordinary Chrome; some refuse to sign in to anything else.
  const chat = session.fromPartition(CHAT_PARTITION);
  chat.setUserAgent(own.getUserAgent().replace(/\s(Kaplya|kaplya|Electron)\/\S+/g, ''));
  chat.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['clipboard-sanitized-write', 'clipboard-read', 'media', 'fullscreen'].includes(permission));
  });
}

// ------------------------------------------------------------------ start

async function loadShared() {
  const load = (name) => import(pathToFileURL(path.join(SHARED_DIR, name)).href);
  const [weather, lrc, netsh, fuzzy, calc, remind] = await Promise.all(
    ['weather.mjs', 'lrc.mjs', 'netsh.mjs', 'fuzzy.mjs', 'calc.mjs', 'remind.mjs'].map(load),
  );
  shared = { weather, lrc, netsh, fuzzy, calc, remind };
}

async function main() {
  await app.whenReady();
  await loadShared();
  Menu.setApplicationMenu(null);

  store = new Store(path.join(app.getPath('userData'), 'kaplya.json'));
  const helperCmd = process.env.KAPLYA_HELPER_CMD ? JSON.parse(process.env.KAPLYA_HELPER_CMD) : null;
  const helperScript = path.join(SRC, 'helper', 'helper.ps1').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  helper = new WinHelper({ script: helperScript, command: helperCmd });
  system = new SystemWatch(helper, { ownPids: [process.pid] });
  clips = new ClipWatch(
    {
      io: clipio,
      seq: () => (helper.supported ? helper.call('clip.seq', {}, 3000) : Promise.resolve(null)),
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
  system.on('theme', (dark) => broadcast('sys:theme', dark));
  system.on('fullscreen', (full) => sendIsland('island:fullscreen', full && store.get('settings.hideOnFullscreen') !== false));
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
    broadcast('store:changed', key, value);
    if (key === 'settings.scale') placeIsland();
    if (key === 'settings.autostart') {
      applyAutostart();
      refreshTray();
    }
    if (key.startsWith('settings.hotkeys')) registerHotkeys();
    if (key === 'settings.clipboard.limit') clips.limit = clamp(Number(value) || 60, 10, 300);
    if (key === 'settings.clipboard.images') clips.keepImages = value !== false;
    if (key === 'settings.hideOnFullscreen') sendIsland('island:fullscreen', system.fullscreen && value !== false);
  });

  createIsland();
  createTray();
  registerHotkeys();
  applyAutostart();
  system.start();
  clips.start();
  launcher.refresh().catch(() => {});
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
      store,
      clips,
      clipio,
      system,
      checkReminders,
    };
  }
}

main().catch((err) => {
  console.error(err);
  app.exit(1);
});
