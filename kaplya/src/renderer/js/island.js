// The island page: one shape that is a pill, a toast, a panel with tabs or the
// command line. This file owns the shape and its states; the tabs live in ./tabs.

import { h, clear, icon, applyLook, chime } from './ui.js';
import { weatherTint, translateUrl } from './common.js';
import { formatTemp, describeCode } from '../shared/weather.mjs';
import { Timer, clock, spell } from './timer.js';
import { setupRecorder } from './recorder.js';
import { setupCommand } from './command.js';
import home from './tabs/home.js';
import clipboardTab from './tabs/clipboard.js';
import shelf from './tabs/shelf.js';
import text from './tabs/text.js';
import notes from './tabs/notes.js';
import weather from './tabs/weather.js';
import control from './tabs/control.js';
import chat from './tabs/chat.js';
import activity from './tabs/activity.js';
import music from './tabs/music.js';

const api = window.kaplya;
const $ = (sel) => document.querySelector(sel);

const TABS = [home, clipboardTab, shelf, text, notes, weather, control, activity, music, chat];
const TOP = 6; // gap between the screen edge and the island, px

const el = {
  island: $('#island'),
  pill: $('#pill'),
  pillLeft: $('#pill-left'),
  pillTime: $('#pill-time'),
  pillWeather: $('#pill-weather'),
  pillRight: $('#pill-right'),
  toast: $('#toast'),
  panel: $('#panel'),
  rail: $('#rail'),
  headTitle: $('#head-title'),
  headNote: $('#head-note'),
  headActions: $('#head-actions'),
  views: $('#views'),
  banner: $('#banner'),
  command: $('#command'),
  pin: $('#btn-pin'),
  settings: $('#btn-settings'),
};

// ------------------------------------------------------------------ shared state

const handlers = new Map();

export const app = {
  api,
  data: null,
  sys: { media: null, volume: { available: false, level: 0, muted: false }, dark: false, helper: false },
  clips: [],
  weather: null,
  recording: null, // { startedAt } while a screen recording runs
  timer: new Timer(),
  platform: 'win32',
  get settings() {
    return this.data.settings;
  },
  on(name, fn) {
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name).add(fn);
    return () => handlers.get(name).delete(fn);
  },
  emit(name, payload) {
    for (const fn of handlers.get(name) || []) {
      try {
        fn(payload);
      } catch (err) {
        console.error(err);
      }
    }
  },
  /** Changes a stored value here and on disk. */
  set(key, value) {
    setPath(app.data, key, value);
    api.invoke('store:set', key, value);
    app.emit('store', key);
  },
  openTab: (id, arg) => openTab(id, arg),
  collapse: () => collapse(),
  toast: (t) => pushToast({ id: Date.now(), ...t }),
  relayout: () => layout(),
  setHeadNote: (s) => {
    el.headNote.textContent = s || '';
  },
  refreshWeather: (force) => refreshWeather(force),
  translate: (t) => translate(t),
  addReminder: (at, textValue) => {
    const list = [...(app.data.reminders || []), { id: 'r' + Date.now(), at, text: textValue, fired: false }];
    app.set('reminders', list.sort((a, b) => a.at - b.at));
  },
};

function setPath(obj, key, value) {
  const parts = key.split('.');
  let node = obj;
  for (const p of parts.slice(0, -1)) {
    if (!node[p] || typeof node[p] !== 'object') node[p] = {};
    node = node[p];
  }
  node[parts[parts.length - 1]] = value;
}

function getPath(obj, key) {
  let node = obj;
  for (const p of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[p];
  }
  return node;
}

// ------------------------------------------------------------------ shape and states

let mode = 'pill'; // pill | toast | open | command
let hover = false;
let pinned = false;
let fullscreen = false;
let openTimer = 0;
let closeTimer = 0;
let current = null; // active tab definition
const views = {}; // id -> { el, ctl }

function layerFor(m) {
  return m === 'open' ? el.panel : m === 'toast' ? el.toast : m === 'command' ? el.command : el.pill;
}

/** Sizes the island to the active layer and tells the main process where it is. */
function layout() {
  const layer = layerFor(mode);
  const w = Math.ceil(layer.offsetWidth);
  const hgt = Math.ceil(layer.offsetHeight);
  if (!w || !hgt) return;
  el.island.style.width = w + 'px';
  el.island.style.height = hgt + 'px';
  el.island.style.borderRadius = (mode === 'pill' ? hgt / 2 : mode === 'toast' ? Math.min(26, hgt / 2) : 24) + 'px';

  const hidden = fullscreen && mode === 'pill' && !hover;
  el.island.dataset.hidden = String(hidden);
  const vw = window.innerWidth;
  let rect;
  if (hidden) {
    // Only a thin strip at the very top: touch it and the island comes out.
    rect = { x: (vw - 260) / 2, y: 0, w: 260, h: 3 };
  } else {
    const m = mode === 'pill' ? 5 : 14;
    rect = { x: (vw - w) / 2 - m, y: 0, w: w + m * 2, h: TOP + hgt + m };
  }
  api.send('island:rects', [rect]);
}

function setMode(next) {
  if (mode === next) {
    layout();
    return;
  }
  const prev = mode;
  mode = next;
  el.island.dataset.mode = next;
  if (prev === 'open' && current) views[current.id]?.ctl.hide?.();
  if (prev === 'command') commandLine.close();
  // Opening the island answers an ordinary toast; a ringing timer or a reminder
  // stays until it is acknowledged and comes back when the island closes.
  if ((next === 'open' || next === 'command') && activeToast && !activeToast.sticky) {
    clearTimeout(toastTimer);
    activeToast = null;
  }
  if (next !== 'open' && next !== 'command') releaseFocus();
  layout();
  app.emit('mode', next);
}

function releaseFocus() {
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  api.send('island:blurme');
}

function isTyping() {
  const a = document.activeElement;
  return Boolean(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'WEBVIEW' || a.isContentEditable));
}

function collapse() {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  pinned = false;
  paintPin();
  if (activeToast) setMode('toast');
  else setMode('pill');
}

function maybeCollapse() {
  if (hover || pinned || mode !== 'open') return;
  // While something is being typed the island stays, until the window loses focus.
  if (document.hasFocus() && isTyping()) return;
  collapse();
}

function onHover(value) {
  hover = value;
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  if (hover) {
    // A toast with buttons waits under the cursor; a passing note ("copied", a new
    // track) gives way to the island, like the pill does.
    const passing = mode === 'toast' && activeToast && activeToast.quiet;
    if ((mode === 'pill' || passing) && app.settings.expandOnHover !== false && !app.recording) {
      openTimer = setTimeout(() => openTab(), Math.max(0, Number(app.settings.hoverDelay) || 0));
    }
    if (mode === 'toast') clearTimeout(toastTimer);
  } else {
    if (mode === 'open' && !pinned) closeTimer = setTimeout(maybeCollapse, Math.max(120, Number(app.settings.collapseDelay) || 380));
    if (mode === 'toast') armToast(1600);
  }
  layout();
}

// ------------------------------------------------------------------ tabs

function buildRail() {
  clear(el.rail);
  for (const tab of TABS) {
    el.rail.append(h('button', {
      title: tab.title,
      'aria-label': tab.title,
      data: { tab: tab.id },
      onclick: () => openTab(tab.id),
    }, icon(tab.icon, 18)));
  }
  paintRail();
}

function paintRail() {
  for (const b of el.rail.children) {
    b.setAttribute('aria-current', String(Boolean(current && b.dataset.tab === current.id)));
    const old = b.querySelector('.badge');
    if (old) old.remove();
    if (b.dataset.tab === 'shelf' && (app.data.shelf || []).length) {
      b.append(h('span', { class: 'badge', text: String(app.data.shelf.length) }));
    }
  }
}

function openTab(id, arg) {
  const want = TABS.find((t) => t.id === (id || app.data.tab)) || TABS[0];
  if (current && current.id !== want.id && views[current.id]) {
    views[current.id].el.hidden = true;
    views[current.id].ctl.hide?.();
  }
  if (!views[want.id]) {
    const root = h('div', { class: 'view view-' + want.id });
    el.views.append(root);
    views[want.id] = { el: root, ctl: want.mount(root, app) || {} };
  }
  current = want;
  views[want.id].el.hidden = false;
  el.panel.style.setProperty('--panel-w', (want.width || 700) + 'px');
  el.headTitle.textContent = want.title;
  el.headNote.textContent = '';
  clear(el.headActions, views[want.id].ctl.actions || []);
  hideBanner();
  if (app.data.tab !== want.id) app.set('tab', want.id);
  paintRail();
  if (mode !== 'open') setMode('open');
  views[want.id].ctl.show?.(arg);
  layout();
}

function paintPin() {
  clear(el.pin, icon(pinned ? 'pin-off' : 'pin', 15));
  el.pin.classList.toggle('on', pinned);
  el.pin.title = pinned ? 'Остров закреплён: нажмите, чтобы отпустить' : 'Не закрывать остров';
}

// ------------------------------------------------------------------ the pill

let lastClock = '';

function paintClock() {
  const s = new Date().toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: app.settings.showSeconds ? '2-digit' : undefined,
  });
  if (s !== lastClock) {
    lastClock = s;
    el.pillTime.textContent = s;
  }
}

function paintPill() {
  const media = app.sys.media;
  const rec = app.recording;
  const timer = app.timer;

  // left: what is going on
  if (rec) {
    clear(el.pillLeft, h('span', { class: 'rec-dot' }));
  } else if (media) {
    clear(el.pillLeft, media.cover
      ? h('img', { class: 'pill-cover', src: media.cover, alt: '' })
      : h('span', { class: 'pill-note' }, icon('music', 13)));
  } else {
    clear(el.pillLeft);
  }

  // centre: the clock, or the length of the recording
  if (rec) {
    el.pillTime.textContent = clock((Date.now() - rec.startedAt) / 1000);
    lastClock = '';
  } else {
    paintClock();
  }

  // weather
  const w = app.weather;
  if (!rec && app.settings.showWeather !== false && w && w.current) {
    const d = describeCode(w.current.code, w.current.isDay);
    const ic = icon(d.icon, 15);
    ic.style.color = weatherTint(d.icon);
    clear(el.pillWeather, ic, formatTemp(w.current.temp));
    el.pillWeather.title = `${w.place.name}: ${d.text}`;
  } else {
    clear(el.pillWeather);
  }

  // right: stop button, timer, sound bars
  if (rec) {
    clear(el.pillRight, h('button', {
      class: 'pill-stop',
      title: 'Остановить запись',
      onclick: (e) => {
        e.stopPropagation();
        api.invoke('rec:stop');
      },
    }, icon('square', 10, 3), 'Стоп'));
  } else if (timer.active) {
    clear(el.pillRight, h('span', { class: 'pill-timer' }, icon(timer.running ? 'timer' : 'pause', 14), clock(timer.remaining())));
  } else if (media) {
    clear(el.pillRight, h('span', { class: 'bars' + (media.playing ? '' : ' paused') }, h('i'), h('i'), h('i'), h('i')));
  } else {
    clear(el.pillRight);
  }
}

async function refreshWeather(force = false) {
  if (!app.settings.weather.place) {
    app.weather = null;
  } else {
    const w = await api.invoke('weather:get', Boolean(force));
    // keep the last good forecast if this one failed
    if (w && !w.error) app.weather = w;
    else if (!app.weather) app.weather = w;
  }
  app.emit('weather', app.weather);
  paintPill();
}

// ------------------------------------------------------------------ toasts

let activeToast = null;
let toastTimer = 0;
let bannerTimer = 0;
const toastQueue = [];

const TOAST_ICONS = {
  copied: 'clipboard',
  text: 'scan-text',
  qr: 'qr-code',
  color: 'pipette',
  record: 'video',
  timer: 'alarm-clock',
  reminder: 'bell-ring',
  track: 'music',
  info: 'info',
  error: 'triangle-alert',
  screenshot: 'image',
};
const KIND_ICONS = { link: 'link', color: 'pipette', mail: 'at-sign', image: 'image', text: 'clipboard' };

function pushToast(t) {
  if (t.sound) chime(t.type === 'timer' ? 3 : 2);
  if (mode === 'open' || mode === 'command') {
    if (!t.quiet) showBanner(t);
    return;
  }
  if (activeToast && activeToast.sticky) {
    if (!t.quiet) toastQueue.push(t);
    return;
  }
  showToast(t);
}

function showToast(t) {
  activeToast = t;
  paintToast(t);
  setMode('toast');
  layout();
  armToast();
}

function armToast(ms) {
  clearTimeout(toastTimer);
  if (!activeToast || (hover && mode === 'toast')) return;
  const life = ms || activeToast.hold || (activeToast.sticky ? 90000 : activeToast.quiet ? 2400 : 4600);
  toastTimer = setTimeout(endToast, life);
}

function endToast() {
  clearTimeout(toastTimer);
  activeToast = null;
  const next = toastQueue.shift();
  if (next) showToast(next);
  else if (mode === 'toast') {
    setMode('pill');
    if (hover) onHover(true);
  }
}

function paintToast(t) {
  const iconName = t.icon || (t.type === 'copied' && KIND_ICONS[t.kind]) || TOAST_ICONS[t.type] || 'info';
  let art;
  if (t.type === 'screenshot' && t.image) {
    art = h('div', {
      class: 'toast-art wide',
      title: 'Перетащите снимок в чат или папку',
      draggable: true,
      ondragstart: (e) => {
        e.preventDefault();
        if (t.file) api.send('file:drag', [t.file]);
      },
    }, h('img', { src: t.image, alt: '', draggable: false }));
  } else if (t.image) {
    art = h('div', { class: 'toast-art' }, h('img', { src: t.image, alt: '' }));
  } else if (t.type === 'color') {
    art = h('div', { class: 'toast-art', style: { background: t.color } });
  } else {
    art = h('div', { class: 'toast-art' + (t.type === 'error' ? ' error' : '') + (t.type === 'timer' || t.type === 'reminder' ? ' ring' : '') }, icon(iconName, 19));
  }

  const actions = [];
  const round = (name, title, fn, primary) => h('button', {
    class: 'round' + (primary ? ' primary' : ''),
    title,
    onclick: (e) => {
      e.stopPropagation();
      fn();
    },
  }, icon(name, 15));

  if (t.type === 'screenshot' || t.type === 'record') {
    if (t.file) actions.push(round('folder-open', 'Показать в папке', () => api.invoke('open:reveal', t.file)));
  }
  if (t.type === 'text') {
    actions.push(round('languages', 'Перевести', () => openTab('text', { text: t.payload, translate: true })));
    actions.push(round('type', 'Открыть во вкладке «Текст»', () => openTab('text', { text: t.payload }), true));
  }
  if (t.type === 'qr' && /^https?:\/\//i.test(t.payload || '')) {
    actions.push(round('external-link', 'Открыть ссылку', () => {
      api.invoke('open:external', t.payload);
      endToast();
    }, true));
  }
  if (t.type === 'timer') {
    actions.push(h('button', {
      class: 'btn small',
      text: 'Ещё раз',
      onclick: (e) => {
        e.stopPropagation();
        app.timer.start();
        endToast();
      },
    }));
  }
  if (t.settings) {
    // an error that is fixed in the settings: one click takes you there
    actions.push(round('settings', 'Открыть настройки', () => {
      api.invoke('open:settings', t.settings);
      endToast();
    }, true));
  }
  if (t.sticky) actions.push(round('check', 'Понятно', () => endToast(), true));

  clear(el.toast, art,
    h('div', { class: 'toast-body' },
      h('div', { class: 'toast-title ellipsis', text: t.title || '' }),
      t.text ? h('div', { class: 'toast-text ellipsis', text: t.text }) : null),
    actions.length ? h('div', { class: 'toast-actions' }, actions) : null);
  el.toast.onclick = () => toastClicked(t);
}

function toastClicked(t) {
  switch (t.type) {
    case 'copied': return openTab('clipboard');
    case 'track': return openTab('home');
    case 'text': return openTab('text', { text: t.payload });
    case 'screenshot': return t.file ? api.invoke('open:file', t.file).then(endToast) : endToast();
    case 'record': return t.file ? api.invoke('open:reveal', t.file).then(endToast) : endToast();
    case 'timer': case 'reminder': return undefined; // needs the tick button
    default: return endToast();
  }
}

function showBanner(t) {
  clearTimeout(bannerTimer);
  el.banner.className = t.type === 'error' ? 'error' : '';
  clear(el.banner,
    icon(t.icon || TOAST_ICONS[t.type] || 'info', 15),
    h('b', { text: t.title || '' }),
    // a long explanation wraps onto its own lines instead of being cut off
    t.text ? h('span', { class: t.text.length > 70 ? 'muted banner-long' : 'muted ellipsis', text: t.text }) : null);
  el.banner.hidden = false;
  layout();
  bannerTimer = setTimeout(hideBanner, t.hold || (t.sticky ? 12000 : 3800));
}

function hideBanner() {
  clearTimeout(bannerTimer);
  if (el.banner.hidden) return;
  el.banner.hidden = true;
  layout();
}

function translate(textValue) {
  api.invoke('open:external', translateUrl(app.settings.search, textValue));
}

// ------------------------------------------------------------------ command line

const commandLine = setupCommand(app, {
  relayout: () => layout(),
  close: () => collapse(),
});

function openCommand() {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  setMode('command');
  commandLine.open();
}

// ------------------------------------------------------------------ wiring

function wire() {
  api.on('island:hover', onHover);
  api.on('island:fullscreen', (v) => {
    fullscreen = Boolean(v);
    layout();
  });
  api.on('island:blur', () => {
    if (mode === 'command') collapse();
    else if (mode === 'open' && !hover && !pinned) collapse();
  });
  api.on('island:open', (req) => {
    if (req && req.mode === 'command') openCommand();
    else openTab(req && req.tab);
  });
  api.on('island:collapse', () => collapse());
  api.on('toast', pushToast);

  api.on('sys:media', (m) => {
    app.sys.media = m;
    paintPill();
    app.emit('media', m);
  });
  api.on('sys:volume', (v) => {
    app.sys.volume = v;
    app.emit('volume', v);
  });
  api.on('sys:theme', (dark) => {
    app.sys.dark = dark;
    applyLook(app.settings, dark);
    app.emit('theme', dark);
  });
  api.on('clip:changed', (list) => {
    app.clips = list;
    app.emit('clips', list);
  });
  api.on('rec:state', (s) => {
    app.recording = s.recording ? { startedAt: s.startedAt || Date.now() } : null;
    paintPill();
    app.emit('recording', app.recording);
  });
  api.on('store:changed', (key, value) => {
    if (JSON.stringify(getPath(app.data, key)) === JSON.stringify(value)) return;
    setPath(app.data, key, value);
    app.emit('store', key);
  });

  app.on('store', (key) => {
    if (key.startsWith('settings.')) applyLook(app.settings, app.sys.dark);
    // a new city (not the map's layer) means a new forecast
    if (key === 'settings.weather' || key === 'settings.weather.place') refreshWeather(true);
    if (key === 'settings.weather.map') app.emit('weather', app.weather);
    if (key === 'settings.showSeconds' || key === 'settings.showWeather') {
      lastClock = '';
      paintPill();
    }
    if (key === 'shelf') paintRail();
  });

  app.timer.addEventListener('change', () => {
    paintPill();
    app.emit('timer');
  });
  app.timer.addEventListener('done', (e) => {
    pushToast({ id: Date.now(), type: 'timer', title: 'Время вышло', text: 'Таймер · ' + spell(e.detail.total), sticky: true, sound: true });
  });

  el.pill.addEventListener('click', () => openTab());
  el.pin.addEventListener('click', () => {
    pinned = !pinned;
    paintPin();
  });
  el.settings.addEventListener('click', () => api.invoke('open:settings'));
  clear(el.settings, icon('settings', 15));
  clear($('#command-icon'), icon('search', 18));

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (mode === 'open' || mode === 'command')) {
      e.preventDefault();
      collapse();
    }
  });

  // While a button is held (a slider being dragged past the edge) the window must
  // keep the mouse; the main process is told through "hold".
  let held = false;
  const setHold = (v) => {
    if (held === v) return;
    held = v;
    api.send('island:hold', v);
  };
  window.addEventListener('pointerdown', () => setHold(true), true);
  window.addEventListener('pointerup', () => setHold(false), true);
  window.addEventListener('pointercancel', () => setHold(false), true);
  window.addEventListener('dragstart', () => setHold(false), true);
  window.addEventListener('blur', () => setHold(false));
  window.addEventListener('pointermove', (e) => {
    if (held && e.buttons === 0) setHold(false);
  }, true);

  // Files dragged onto the island land on the shelf.
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (mode !== 'open' || !current || current.id !== 'shelf') openTab('shelf');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    if (paths.length) await api.invoke('shelf:add', paths);
  });

  const ro = new ResizeObserver(() => layout());
  for (const layer of [el.pill, el.toast, el.panel, el.command]) ro.observe(layer);
  window.addEventListener('resize', () => layout());
}

async function boot() {
  const init = await api.invoke('app:init');
  app.data = init.data;
  app.sys = init.system;
  app.clips = init.clips;
  app.platform = init.platform;
  app.version = init.version;
  app.test = init.test;
  if (init.recording) app.recording = { startedAt: init.recordingSince || Date.now() };

  applyLook(app.settings, app.sys.dark);
  buildRail();
  paintPin();
  wire();
  setupRecorder(app);
  paintPill();
  setInterval(() => {
    if (app.recording) paintPill();
    else paintClock();
  }, 1000);
  setInterval(() => refreshWeather(false), 15 * 60 * 1000);
  refreshWeather(false);

  el.island.classList.add('booting');
  layout();
  requestAnimationFrame(() => requestAnimationFrame(() => el.island.classList.remove('booting')));
  document.documentElement.dataset.ready = 'true';
  api.invoke('island:ready');
}

boot();
