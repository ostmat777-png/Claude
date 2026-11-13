'use strict';
// Settings and user data: one JSON file in the app's data folder.

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const DEFAULTS = {
  version: 1,
  settings: {
    accent: '#6cc6ff',
    theme: 'dark', // dark | light | system
    scale: 1,
    autostart: false,
    expandOnHover: true,
    hoverDelay: 90,
    collapseDelay: 380,
    hideOnFullscreen: true,
    showSeconds: false,
    showWeather: true,
    copyToast: true,
    trackToast: true,
    lyrics: true,
    coverSearch: true, // look for a cover on the internet when the player gives none
    weather: { place: null, askedOnce: false },
    hotkeys: {
      palette: 'Alt+Space',
      region: 'Ctrl+Alt+S',
      ocr: 'Ctrl+Alt+T',
      color: 'Ctrl+Alt+C',
      record: 'Ctrl+Alt+R',
    },
    screenshots: { dir: '', save: true },
    record: {
      engine: 'builtin', // builtin | obs
      dir: '',
      format: 'mp4',
      audio: 'system',
      fps: 30,
      obs: { host: '127.0.0.1', port: 4455, launch: true },
    },
    home: {
      tools: ['region', 'screen', 'ocr', 'qr', 'color', 'plain', 'record', 'command'],
      showClipboard: true,
      showVolume: true,
      showApps: true,
    },
    clipboard: { limit: 60, images: true },
    search: 'google', // google | yandex | duckduckgo
    musicSearch: 'yandex', // where "find this track" opens: yandex | vk | youtube | ytmusic | spotify
    chat: { service: 'deepseek', custom: '' },
    ocrLang: '',
  },
  tab: 'home',
  welcomed: false,
  obsSecret: '', // the OBS WebSocket password, encrypted (see secret.js)
  notes: [{ id: 'n1', text: '' }],
  activeNote: 'n1',
  reminders: [],
  apps: [],
  shelf: [],
  likes: [], // tracks marked with the heart
};

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Saved values win; anything missing (new settings after an update) comes from the defaults. */
function merge(defaults, saved) {
  if (!isObject(defaults)) return saved === undefined ? defaults : saved;
  const out = {};
  for (const key of Object.keys(defaults)) {
    const d = defaults[key];
    const s = isObject(saved) ? saved[key] : undefined;
    if (isObject(d)) out[key] = merge(d, isObject(s) ? s : {});
    else if (s === undefined || (d !== null && s !== null && typeof s !== typeof d)) out[key] = clone(d);
    else out[key] = s;
  }
  if (isObject(saved)) {
    for (const key of Object.keys(saved)) if (!(key in out)) out[key] = saved[key];
  }
  return out;
}

function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

class Store extends EventEmitter {
  constructor(file, defaults = DEFAULTS) {
    super();
    this.file = file;
    this.defaults = defaults;
    this.data = clone(defaults);
    this.timer = null;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.data = merge(this.defaults, JSON.parse(raw));
    } catch {
      this.data = clone(this.defaults);
    }
  }

  /** get('settings.accent') */
  get(key) {
    let node = this.data;
    for (const part of String(key).split('.')) {
      if (node === null || typeof node !== 'object') return undefined;
      node = node[part];
    }
    return clone(node);
  }

  set(key, value) {
    const parts = String(key).split('.');
    if (parts.some((p) => p === '__proto__' || p === 'constructor' || p === 'prototype')) return;
    let node = this.data;
    for (const part of parts.slice(0, -1)) {
      if (!isObject(node[part])) node[part] = {};
      node = node[part];
    }
    node[parts[parts.length - 1]] = clone(value);
    this.scheduleSave();
    this.emit('change', key, clone(value));
  }

  scheduleSave() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.saveNow();
    }, 400);
  }

  saveNow() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch {
      // A read-only disk must not take the app down; the settings live on in memory.
    }
  }
}

module.exports = { Store, DEFAULTS, merge };
