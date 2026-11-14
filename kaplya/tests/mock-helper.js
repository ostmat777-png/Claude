'use strict';
// A stand-in for helper.ps1 that speaks the same JSON lines, for running the app
// where there is no Windows: tests and screenshots. It plays a "song", has a
// volume knob, two radios and three Wi-Fi networks.

const readline = require('node:readline');

const cover = (a, b) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="200" height="200" fill="url(#g)"/><circle cx="140" cy="70" r="34" fill="#fff" opacity=".85"/><path d="M0 150 Q50 110 100 150 T200 140 V200 H0Z" fill="#000" opacity=".35"/></svg>`;
  return { mime: 'image/svg+xml', data: Buffer.from(svg).toString('base64') };
};

const tracks = [
  { title: 'Тёплый берег', artist: 'Прибой', album: 'Лето', duration: 214, thumb: cover('#ff9a5a', '#7a3cff') },
  { title: 'Northern Lights', artist: 'Aurora Line', album: 'Night Drive', duration: 187, thumb: cover('#22c1c3', '#1a2a6c') },
];

const state = {
  track: 0,
  playing: true,
  startedAt: Date.now() - 42000,
  pausedAt: 0,
  hasMedia: process.env.MOCK_NO_MEDIA !== '1',
  second: false, // a browser tab playing too
  ytWindow: '', // the title of a browser window with YouTube, for a browser that tells Windows nothing
  active: null, // the program in front: { pid, exe, path, name, title }
  idleMs: 0,
  volume: { available: true, level: 0.62, muted: false },
  dark: true,
  fullscreen: false,
  radios: { wifi: true, bluetooth: false },
  connected: 'Home-5G',
  power: [],
  calls: [],
};

const networks = () => [
  { ssid: 'Home-5G', bars: 4, rssi: -42, secure: true },
  { ssid: 'Cafe Wi-Fi', bars: 3, rssi: -61, secure: false },
  { ssid: 'Neighbour', bars: 2, rssi: -74, secure: true },
].map((n) => ({ ...n, connected: n.ssid === state.connected }))
  .sort((a, b) => Number(b.connected) - Number(a.connected) || b.rssi - a.rssi);

function position() {
  const t = tracks[state.track];
  const p = state.playing ? (Date.now() - state.startedAt) / 1000 : state.pausedAt;
  return Math.min(p, t.duration);
}

const browserTrack = { title: 'Lo-fi beats to study to', artist: 'Lofi Girl', album: '', duration: 0 };

function media(have, appId) {
  if (state.second && appId === 'chrome.exe') {
    const now = Date.now();
    return { app: 'chrome.exe', ...browserTrack, status: 'Playing', position: 12, duration: 600, updated: now, now, key: 'chrome|lofi', canPrev: false, canNext: true, canSeek: true };
  }
  if (!state.hasMedia) {
    const m = /^(.+?) - (YouTube)/.exec(state.ytWindow || '');
    if (!m) return null;
    const now = Date.now();
    return { app: 'title:chrome.exe', title: m[1], artist: m[2], album: '', status: 'Unknown', position: 0, duration: 0, updated: now, now, key: 'title:chrome.exe|' + m[1], canPrev: true, canNext: true, canSeek: false, fromTitle: true };
  }
  const t = tracks[state.track];
  const key = `mock|${t.title}|${t.artist}|${t.album}`;
  const now = Date.now();
  const res = {
    app: 'MockPlayer.exe', title: t.title, artist: t.artist, album: t.album,
    status: state.playing ? 'Playing' : 'Paused', position: position(), duration: t.duration,
    updated: now, now, key, canPrev: true, canNext: true, canSeek: true,
  };
  if (have !== key) res.thumb = t.thumb;
  if (state.noTime) {
    // like many real players: the track, but no time and no length
    Object.assign(res, { position: 0, duration: 0, updated: -11644473600000, canSeek: false });
  }
  return res;
}

function run(cmd, a) {
  state.calls.push(cmd);
  if (state.calls.length > 200) state.calls.shift();
  switch (cmd) {
    case 'ping': return { pong: true, windows: true, ps: 'mock' };
    case 'echo': return a;
    case 'media.get': return media(a.have, a.app);
    case 'media.sessions': {
      const list = state.hasMedia ? [{ ...media('*'), current: true }] : [];
      if (state.second) list.push({ ...media('*', 'chrome.exe'), current: false });
      for (const s of list) delete s.thumb;
      return { sessions: list, youtubeWindows: state.ytWindow ? [{ exe: 'chrome.exe', title: state.ytWindow }] : [] };
    }
    case 'page.read':
      return { found: Boolean(state.pageLike), liked: state.pageLike ? state.pageLiked : null, likeName: 'Нравится', position: state.pagePos === undefined ? null : state.pagePos, duration: state.pagePos === undefined ? null : 300, url: '' };
    case 'page.like': {
      if (!state.pageLike) return { found: false, pressed: false, liked: null };
      if (typeof a.want === 'boolean' && a.want === Boolean(state.pageLiked)) return { found: true, pressed: false, liked: Boolean(state.pageLiked) };
      state.pageLiked = !state.pageLiked;
      return { found: true, pressed: true, liked: state.pageLiked, likeName: 'Нравится' };
    }
    case 'media.cmd': {
      if (!state.hasMedia) return false;
      if (a.action === 'toggle' || a.action === 'play' || a.action === 'pause') {
        const want = a.action === 'toggle' ? !state.playing : a.action === 'play';
        if (want && !state.playing) state.startedAt = Date.now() - state.pausedAt * 1000;
        if (!want && state.playing) state.pausedAt = position();
        state.playing = want;
      } else if (a.action === 'next' || a.action === 'prev') {
        state.track = (state.track + (a.action === 'next' ? 1 : tracks.length - 1)) % tracks.length;
        state.startedAt = Date.now();
        state.pausedAt = 0;
      } else if (a.action === 'seek') {
        state.startedAt = Date.now() - a.position * 1000;
        state.pausedAt = a.position;
      }
      return true;
    }
    case 'volume.get': return state.volume;
    case 'volume.set':
      if (typeof a.level === 'number') state.volume.level = Math.max(0, Math.min(1, a.level));
      if (typeof a.muted === 'boolean') state.volume.muted = a.muted;
      return state.volume;
    case 'sys.poll': return { fullscreen: state.fullscreen, dark: state.dark, volume: state.volume, active: state.active, idleMs: state.idleMs };
    case 'theme.set': state.dark = Boolean(a.dark); return { dark: state.dark };
    case 'radio.get': return state.radios;
    case 'radio.set': state.radios[a.kind === 'bluetooth' ? 'bluetooth' : 'wifi'] = Boolean(a.on); return state.radios;
    case 'wifi.list': return { available: true, connected: state.connected, networks: networks() };
    case 'wifi.connect': {
      const net = networks().find((n) => n.ssid === a.ssid);
      if (!net) throw new Error('not-found');
      if (net.secure && a.password !== 'correct-horse') return { status: 'InvalidCredential' };
      state.connected = net.ssid;
      return { status: 'Success' };
    }
    case 'wifi.disconnect': state.connected = null; return true;
    case 'ocr': return { text: 'Встречу перенесли на пятницу, 15:00.\nПринесите слайды и отчёт.', lang: 'ru' };
    case 'ocr.langs': return { langs: [{ tag: 'ru', name: 'Русский' }, { tag: 'en-US', name: 'English (United States)' }] };
    case 'power': state.power.push(a.action); return true;
    case 'clip.seq': return null; // "unknown": the app falls back to reading the clipboard
    case 'clip.info': return null;
    case 'apps.list': return { apps: [{ name: 'Калькулятор', id: 'Mock.Calculator' }, { name: 'Параметры', id: 'Mock.Settings' }, { name: 'Блокнот', id: 'Mock.Notepad' }] };
    // test controls
    case 'mock.set': Object.assign(state, a); return true;
    case 'mock.state': return { power: state.power, calls: state.calls, playing: state.playing, pageLiked: Boolean(state.pageLiked), track: state.track, volume: state.volume, dark: state.dark, connected: state.connected, radios: state.radios };
    default: throw new Error('unknown command: ' + cmd);
  }
}

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
out({ ready: true, windows: true });

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let id = null;
  try {
    const req = JSON.parse(line);
    id = req.id;
    out({ id, ok: true, result: run(req.cmd, req.args || {}) });
  } catch (err) {
    out({ id, ok: false, error: String(err.message || err) });
  }
}).on('close', () => process.exit(0));
