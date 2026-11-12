// Small DOM helpers shared by every page.

import { icon } from './icons.js';

export { icon };

/** h('button', { class: 'btn', onclick: fn }, icon('check'), 'Готово') */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'data') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k.startsWith('aria-') || k === 'role' || k === 'for' || k === 'list') el.setAttribute(k, String(v));
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const kid of kids.flat(3)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

export function clear(el, ...kids) {
  el.replaceChildren();
  append(el, kids);
  return el;
}

export function debounce(fn, ms) {
  let timer = 0;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

export function throttle(fn, ms) {
  let last = 0;
  let timer = 0;
  let pending = null;
  return (...args) => {
    const now = Date.now();
    pending = args;
    if (now - last >= ms) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = 0;
        last = Date.now();
        fn(...pending);
      }, ms - (now - last));
    }
  };
}

export function timeAgo(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return 'только что';
  if (s < 60) return `${s} с назад`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs} ч назад`;
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

export function fileSize(bytes) {
  if (!bytes) return '';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1).replace('.', ',')) + ' ' + units[i];
}

/** A switch that looks like a toggle and behaves like a checkbox. */
export function toggle(checked, onChange, label) {
  const el = h('button', {
    class: 'switch',
    role: 'switch',
    'aria-checked': String(Boolean(checked)),
    'aria-label': label || '',
    onclick: () => {
      const next = el.getAttribute('aria-checked') !== 'true';
      el.setAttribute('aria-checked', String(next));
      onChange(next);
    },
  });
  el.set = (v) => el.setAttribute('aria-checked', String(Boolean(v)));
  return el;
}

/** segment([['a','Раз'],['b','Два']], 'a', fn) */
export function segment(options, value, onChange) {
  const el = h('div', { class: 'segment', role: 'group' });
  const paint = (v) => {
    for (const b of el.children) b.setAttribute('aria-pressed', String(b.dataset.value === String(v)));
  };
  for (const [val, text] of options) {
    el.append(h('button', {
      text,
      data: { value: String(val) },
      onclick: () => {
        paint(val);
        onChange(val);
      },
    }));
  }
  paint(value);
  el.set = paint;
  return el;
}

/** Keeps the coloured part of a range input in step with its value. */
export function paintRange(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const pct = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty('--fill', pct + '%');
}

/** Hex colour that is readable on top of `hex`. */
export function inkFor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return '#04121c';
  const n = parseInt(m[1], 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum > 0.55 ? '#06131c' : '#ffffff';
}

/** Applies the accent colour and the light/dark choice to a page. */
export function applyLook(settings, systemDark) {
  const root = document.documentElement;
  const accent = /^#[0-9a-f]{6}$/i.test(settings.accent || '') ? settings.accent : '#6cc6ff';
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-ink', inkFor(accent));
  const theme = settings.theme === 'system' ? (systemDark ? 'dark' : 'light') : settings.theme === 'light' ? 'light' : 'dark';
  root.dataset.theme = theme;
}

/** A two-note chime for timers and reminders. */
export function chime(times = 2) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    for (let i = 0; i < times; i++) {
      [880, 1318.5].forEach((freq, k) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const t = now + i * 0.7 + k * 0.16;
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.55);
      });
    }
    setTimeout(() => ctx.close().catch(() => {}), times * 700 + 800);
  } catch {
    // no sound device: the toast is enough
  }
}
