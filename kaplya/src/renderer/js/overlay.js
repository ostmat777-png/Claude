// The capture overlay. It shows a frozen picture of the screen; you select a
// part of it and, for a screenshot, draw on it. Depending on the mode the result
// is a picture, a colour, the text of a QR code, or just the chosen rectangle.

import { h, clear, icon, inkFor } from './ui.js';

const api = window.kaplya;
const params = new URLSearchParams(location.search);
const mode = params.get('mode') || 'region'; // region | ocr | qr | color | record
const accent = /^#[0-9a-f]{6}$/i.test(params.get('accent') || '') ? params.get('accent') : '#6cc6ff';

document.documentElement.style.setProperty('--accent', accent);
document.documentElement.style.setProperty('--accent-ink', inkFor(accent));
document.body.dataset.mode = mode;
document.body.dataset.phase = 'select';

const canvas = document.querySelector('#stage');
const g = canvas.getContext('2d');
const hint = document.querySelector('#hint');
const sizeLabel = document.querySelector('#size');
const loupe = document.querySelector('#loupe');
const toolbar = document.querySelector('#toolbar');
const entry = document.querySelector('#entry');

const HINTS = {
  region: 'Выделите область мышью · Esc — отмена',
  ocr: 'Выделите текст, который нужно скопировать · Esc — отмена',
  qr: 'Выделите QR-код или щёлкните, чтобы искать на всём экране',
  color: 'Щёлкните по нужному цвету · Esc — отмена',
  record: 'Выделите область для записи или нажмите Enter, чтобы записать весь экран',
};
hint.textContent = HINTS[mode] || '';

const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff', '#111111'];
const SIZES = [3, 5, 9]; // line width in CSS px

const img = new Image();
let W = 0; // picture size in its own pixels
let H = 0;
let k = 1; // picture pixels per CSS pixel
let sel = null; // { x, y, w, h } in picture pixels
let phase = 'select'; // select | annotate
let dragFrom = null;
let shapes = [];
let undone = [];
let current = null; // shape being drawn
let tool = 'arrow';
let color = COLORS[0];
let sizeIndex = 0;
let pixels = null; // 2d context used to read colours
let finished = false;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const toPic = (e) => ({ x: clamp(e.clientX * k, 0, W), y: clamp(e.clientY * k, 0, H) });

// ------------------------------------------------------------------ drawing

function strokeFor(shape) {
  return SIZES[shape.size] * k;
}

function paintShape(c, s) {
  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.strokeStyle = s.color;
  c.fillStyle = s.color;
  c.lineWidth = strokeFor(s);
  switch (s.tool) {
    case 'arrow': {
      const dx = s.b.x - s.a.x;
      const dy = s.b.y - s.a.y;
      const len = Math.hypot(dx, dy);
      if (len < 2) break;
      const head = Math.min(len * 0.6, c.lineWidth * 4.2 + 6 * k);
      const ang = Math.atan2(dy, dx);
      // stop the shaft inside the head so the tip stays sharp
      const bx = s.b.x - Math.cos(ang) * head * 0.7;
      const by = s.b.y - Math.sin(ang) * head * 0.7;
      c.beginPath();
      c.moveTo(s.a.x, s.a.y);
      c.lineTo(bx, by);
      c.stroke();
      c.beginPath();
      c.moveTo(s.b.x, s.b.y);
      c.lineTo(s.b.x - Math.cos(ang - 0.42) * head, s.b.y - Math.sin(ang - 0.42) * head);
      c.lineTo(s.b.x - Math.cos(ang + 0.42) * head, s.b.y - Math.sin(ang + 0.42) * head);
      c.closePath();
      c.fill();
      break;
    }
    case 'rect': {
      const r = box(s.a, s.b);
      c.strokeRect(r.x, r.y, r.w, r.h);
      break;
    }
    case 'pen':
    case 'marker': {
      if (s.tool === 'marker') {
        c.globalAlpha = 0.42;
        c.lineCap = 'butt';
        c.lineWidth = strokeFor(s) * 3.4 + 4 * k;
      }
      const p = s.points;
      c.beginPath();
      c.moveTo(p[0].x, p[0].y);
      if (p.length === 1) c.lineTo(p[0].x + 0.01, p[0].y);
      for (let i = 1; i < p.length - 1; i++) {
        const mx = (p[i].x + p[i + 1].x) / 2;
        const my = (p[i].y + p[i + 1].y) / 2;
        c.quadraticCurveTo(p[i].x, p[i].y, mx, my);
      }
      if (p.length > 1) c.lineTo(p[p.length - 1].x, p[p.length - 1].y);
      c.stroke();
      break;
    }
    case 'text': {
      const fs = fontSize(s.size) * k;
      c.font = `600 ${fs}px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`;
      c.textBaseline = 'top';
      c.lineWidth = Math.max(2, fs / 7);
      c.strokeStyle = s.color === '#111111' ? 'rgba(255,255,255,.75)' : 'rgba(0,0,0,.5)';
      s.text.split('\n').forEach((line, i) => {
        const y = s.a.y + i * fs * 1.25;
        c.strokeText(line, s.a.x, y);
        c.fillText(line, s.a.x, y);
      });
      break;
    }
    case 'blur': {
      // A mosaic of the original picture: what is under it cannot be read back.
      const r = box(s.a, s.b);
      if (r.w < 2 || r.h < 2) break;
      const cell = Math.max(6, Math.round(10 * k));
      const tw = Math.max(1, Math.round(r.w / cell));
      const th = Math.max(1, Math.round(r.h / cell));
      const tmp = document.createElement('canvas');
      tmp.width = tw;
      tmp.height = th;
      tmp.getContext('2d').drawImage(img, r.x, r.y, r.w, r.h, 0, 0, tw, th);
      c.imageSmoothingEnabled = false;
      c.drawImage(tmp, 0, 0, tw, th, r.x, r.y, r.w, r.h);
      break;
    }
    default:
  }
  c.restore();
}

const fontSize = (i) => [16, 22, 32][i];

function box(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function draw() {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(img, 0, 0);
  if (mode === 'color') return;
  g.fillStyle = 'rgba(0, 0, 0, 0.48)';
  if (!sel) {
    g.fillRect(0, 0, W, H);
    return;
  }
  g.fillRect(0, 0, W, sel.y);
  g.fillRect(0, sel.y + sel.h, W, H - sel.y - sel.h);
  g.fillRect(0, sel.y, sel.x, sel.h);
  g.fillRect(sel.x + sel.w, sel.y, W - sel.x - sel.w, sel.h);

  g.save();
  g.beginPath();
  g.rect(sel.x, sel.y, sel.w, sel.h);
  g.clip();
  for (const s of shapes) paintShape(g, s);
  if (current) paintShape(g, current);
  g.restore();

  g.strokeStyle = accent;
  g.lineWidth = Math.max(1, 1.5 * k);
  g.strokeRect(sel.x, sel.y, sel.w, sel.h);
}

function placeSizeLabel() {
  if (!sel || sel.w < 2) {
    sizeLabel.hidden = true;
    return;
  }
  sizeLabel.hidden = false;
  sizeLabel.textContent = `${Math.round(sel.w)} × ${Math.round(sel.h)}`;
  const top = sel.y / k - 24;
  sizeLabel.style.left = Math.max(4, sel.x / k) + 'px';
  sizeLabel.style.top = (top < 4 ? sel.y / k + 6 : top) + 'px';
}

// ------------------------------------------------------------------ results

function cropCanvas(scaleUp = 1) {
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(sel.w * scaleUp));
  out.height = Math.max(1, Math.round(sel.h * scaleUp));
  const c = out.getContext('2d');
  c.imageSmoothingQuality = 'high';
  c.scale(scaleUp, scaleUp);
  c.translate(-sel.x, -sel.y);
  c.drawImage(img, 0, 0);
  for (const s of shapes) paintShape(c, s);
  return out;
}

async function pngOf(canvasEl) {
  const blob = await new Promise((resolve) => canvasEl.toBlob(resolve, 'image/png'));
  return blob.arrayBuffer();
}

async function finish(result) {
  if (finished) return;
  finished = true;
  await api.invoke('capture:done', result);
}

function cancel() {
  if (finished) return;
  finished = true;
  api.invoke('capture:cancel');
}

async function selectionDone() {
  if (mode === 'region') {
    phase = 'annotate';
    document.body.dataset.phase = 'annotate';
    hint.classList.add('away');
    buildToolbar();
    placeToolbar();
    draw();
    return;
  }
  if (mode === 'ocr') {
    // Small print is recognised better when enlarged.
    const up = sel.h < 60 ? 3 : sel.h < 400 ? 2 : 1;
    const safe = Math.min(up, 6000 / Math.max(sel.w, sel.h));
    return finish({ png: await pngOf(cropCanvas(Math.max(1, safe))) });
  }
  if (mode === 'qr') {
    const out = cropCanvas(1);
    const data = out.getContext('2d').getImageData(0, 0, out.width, out.height);
    let text = '';
    try {
      const hit = window.jsQR(data.data, out.width, out.height);
      text = hit ? hit.data : '';
    } catch {
      text = '';
    }
    return finish({ text });
  }
  if (mode === 'record') {
    // in the picture's own pixels: the video frames are the same size as the picture
    return finish({ rect: { x: sel.x, y: sel.y, w: sel.w, h: sel.h } });
  }
  return undefined;
}

// ------------------------------------------------------------------ toolbar

const TOOLS = [
  ['arrow', 'arrow-up-right', 'Стрелка'],
  ['rect', 'square', 'Рамка'],
  ['pen', 'pencil', 'Карандаш'],
  ['marker', 'highlighter', 'Маркер'],
  ['text', 'type', 'Текст'],
  ['blur', 'grid-3x3', 'Скрыть: мозаика поверх лишнего'],
];

function buildToolbar() {
  const press = (el, on) => el.setAttribute('aria-pressed', String(on));
  const toolButtons = TOOLS.map(([id, ic, title]) => {
    const b = h('button', {
      class: 'ghost',
      title,
      data: { tool: id },
      onclick: () => {
        commitText();
        tool = id;
        toolButtons.forEach((x) => press(x, x.dataset.tool === tool));
        canvas.style.cursor = id === 'text' ? 'text' : 'crosshair';
      },
    }, icon(ic, 17));
    press(b, id === tool);
    return b;
  });
  const swatches = COLORS.map((c) => {
    const b = h('button', {
      class: 'swatch',
      title: 'Цвет',
      style: { background: c },
      data: { color: c },
      onclick: () => {
        color = c;
        swatches.forEach((x) => press(x, x.dataset.color === color));
        entry.style.color = color;
      },
    });
    press(b, c === color);
    return b;
  });
  const dots = SIZES.map((_, i) => {
    const d = 5 + i * 4;
    const b = h('button', {
      class: 'dot',
      title: 'Толщина',
      data: { size: String(i) },
      onclick: () => {
        sizeIndex = i;
        dots.forEach((x) => press(x, Number(x.dataset.size) === sizeIndex));
      },
    }, h('i', { style: { width: d + 'px', height: d + 'px' } }));
    press(b, i === sizeIndex);
    return b;
  });
  const sep = () => h('span', { class: 'sep' });
  clear(toolbar,
    toolButtons, sep(), swatches, sep(), dots, sep(),
    h('button', { class: 'ghost', title: 'Отменить (Ctrl+Z)', data: { act: 'undo' }, onclick: undo }, icon('undo-2', 16)),
    h('button', { class: 'ghost', title: 'Вернуть (Ctrl+Y)', data: { act: 'redo' }, onclick: redo }, icon('redo-2', 16)),
    h('button', { class: 'ghost', title: 'Выделить заново', data: { act: 'reselect' }, onclick: reselect }, icon('crop', 16)),
    h('button', { class: 'ghost', title: 'Отмена (Esc)', data: { act: 'cancel' }, onclick: cancel }, icon('x', 16)),
    h('button', { class: 'btn primary', title: 'В буфер обмена (Enter)', data: { act: 'done' }, onclick: done }, icon('check', 15, 2.4), 'Готово'));
  toolbar.hidden = false;
  canvas.style.cursor = 'crosshair';
}

function placeToolbar() {
  const tw = toolbar.offsetWidth;
  const th = toolbar.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const right = (sel.x + sel.w) / k;
  const bottom = (sel.y + sel.h) / k;
  let top = bottom + 8;
  if (top + th > vh - 4) top = sel.y / k - th - 8; // no room below: go above
  if (top < 4) top = bottom - th - 8; // no room above either: inside, at the bottom
  toolbar.style.top = clamp(top, 4, vh - th - 4) + 'px';
  toolbar.style.left = clamp(right - tw, 4, vw - tw - 4) + 'px';
}

function undo() {
  commitText();
  if (!shapes.length) return;
  undone.push(shapes.pop());
  draw();
}

function redo() {
  if (!undone.length) return;
  shapes.push(undone.pop());
  draw();
}

function reselect() {
  commitText();
  shapes = [];
  undone = [];
  sel = null;
  phase = 'select';
  document.body.dataset.phase = 'select';
  toolbar.hidden = true;
  sizeLabel.hidden = true;
  hint.classList.remove('away');
  canvas.style.cursor = '';
  draw();
}

async function done() {
  commitText();
  await finish({ png: await pngOf(cropCanvas(1)) });
}

// ------------------------------------------------------------------ text tool

let textAt = null;

function startText(p) {
  commitText();
  textAt = p;
  const fs = fontSize(sizeIndex);
  entry.hidden = false;
  entry.value = '';
  entry.style.left = p.x / k + 'px';
  entry.style.top = p.y / k + 'px';
  entry.style.fontSize = fs + 'px';
  entry.style.color = color;
  entry.dataset.size = String(sizeIndex);
  growEntry();
  entry.focus();
  // once more after the click has finished, in case the click itself took the focus away
  setTimeout(() => {
    if (!entry.hidden) entry.focus();
  }, 0);
}

function growEntry() {
  const lines = entry.value.split('\n');
  entry.rows = lines.length;
  entry.style.width = Math.max(3, ...lines.map((l) => l.length)) + 1.5 + 'ch';
}

function commitText() {
  if (entry.hidden || !textAt) return;
  const text = entry.value.replace(/\s+$/, '');
  if (text) {
    shapes.push({ tool: 'text', color, size: Number(entry.dataset.size), a: { x: textAt.x + 3 * k, y: textAt.y + 1 * k }, text });
    undone = [];
  }
  entry.hidden = true;
  textAt = null;
  draw();
}

entry.addEventListener('input', growEntry);
entry.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    commitText();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    entry.value = '';
    commitText();
  }
});
entry.addEventListener('blur', () => commitText());

// ------------------------------------------------------------------ colour picker

function hexAt(p) {
  const x = clamp(Math.floor(p.x), 0, W - 1);
  const y = clamp(Math.floor(p.y), 0, H - 1);
  const d = pixels.getImageData(x, y, 1, 1).data;
  return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function moveLoupe(e) {
  const p = toPic(e);
  const c = loupe.querySelector('canvas').getContext('2d');
  const n = 11; // picture pixels across the loupe
  const cell = 132 / n;
  c.imageSmoothingEnabled = false;
  c.fillStyle = '#000';
  c.fillRect(0, 0, 132, 132);
  c.drawImage(img, Math.floor(p.x) - 5, Math.floor(p.y) - 5, n, n, 0, 0, 132, 132);
  c.strokeStyle = 'rgba(255,255,255,.9)';
  c.lineWidth = 2;
  c.strokeRect(5 * cell, 5 * cell, cell, cell);
  c.strokeStyle = 'rgba(0,0,0,.6)';
  c.lineWidth = 1;
  c.strokeRect(5 * cell - 1.5, 5 * cell - 1.5, cell + 3, cell + 3);
  loupe.querySelector('span').textContent = hexAt(p).toUpperCase();
  loupe.hidden = false;
  const lw = 132;
  const lh = loupe.offsetHeight || 158;
  let x = e.clientX + 22;
  let y = e.clientY + 22;
  if (x + lw > window.innerWidth - 4) x = e.clientX - lw - 22;
  if (y + lh > window.innerHeight - 4) y = e.clientY - lh - 22;
  loupe.style.left = x + 'px';
  loupe.style.top = y + 'px';
}

// ------------------------------------------------------------------ mouse and keys

canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 2) return cancel();
  if (e.button !== 0) return undefined;
  canvas.setPointerCapture(e.pointerId);
  const p = toPic(e);
  if (mode === 'color') return finish({ color: hexAt(p) });
  if (phase === 'select') {
    dragFrom = p;
    sel = { x: p.x, y: p.y, w: 0, h: 0 };
    hint.classList.add('away');
    draw();
    return undefined;
  }
  // annotate: only inside the selection
  if (p.x < sel.x || p.x > sel.x + sel.w || p.y < sel.y || p.y > sel.y + sel.h) {
    commitText();
    return undefined;
  }
  if (tool === 'text') {
    e.preventDefault();
    startText(p);
    return undefined;
  }
  commitText();
  current = tool === 'pen' || tool === 'marker'
    ? { tool, color, size: sizeIndex, points: [p] }
    : { tool, color, size: sizeIndex, a: p, b: p };
  draw();
  return undefined;
});

canvas.addEventListener('pointermove', (e) => {
  if (mode === 'color') return moveLoupe(e);
  const p = toPic(e);
  if (phase === 'select' && dragFrom) {
    sel = box(dragFrom, p);
    placeSizeLabel();
    draw();
  } else if (current) {
    const q = { x: clamp(p.x, sel.x, sel.x + sel.w), y: clamp(p.y, sel.y, sel.y + sel.h) };
    if (current.points) current.points.push(q);
    else current.b = e.shiftKey && current.tool === 'arrow' ? snap(current.a, q) : q;
    draw();
  }
  return undefined;
});

// Shift keeps an arrow horizontal, vertical or at 45 degrees.
function snap(a, b) {
  const ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
}

canvas.addEventListener('pointerup', (e) => {
  if (phase === 'select' && dragFrom) {
    dragFrom = null;
    if (!sel || sel.w < 5 * k || sel.h < 5 * k) {
      // a click without dragging means "everything"
      sel = { x: 0, y: 0, w: W, h: H };
      if (mode === 'record') return finish({ rect: null });
    }
    sel = { x: Math.round(sel.x), y: Math.round(sel.y), w: Math.round(sel.w), h: Math.round(sel.h) };
    placeSizeLabel();
    draw();
    return selectionDone();
  }
  if (current) {
    const s = current;
    current = null;
    const tiny = s.points ? false : Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) < 3 * k;
    if (!tiny) {
      shapes.push(s);
      undone = [];
    }
    draw();
  }
  return e;
});

// With the text tool the click must not pull the focus out of the field being typed in.
canvas.addEventListener('mousedown', (e) => {
  if (phase === 'annotate' && tool === 'text') e.preventDefault();
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  cancel();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return cancel();
  if (mode === 'record' && phase === 'select' && e.key === 'Enter') return finish({ rect: null });
  if (phase !== 'annotate') return undefined;
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === 'Enter' || (ctrl && e.code === 'KeyC')) {
    e.preventDefault();
    return done();
  }
  if (ctrl && e.code === 'KeyZ' && !e.shiftKey) {
    e.preventDefault();
    return undo();
  }
  if (ctrl && (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey))) {
    e.preventDefault();
    return redo();
  }
  return undefined;
});

// ------------------------------------------------------------------ start

async function start() {
  img.src = `capture/${encodeURIComponent(params.get('cap') || '')}.png`;
  try {
    await img.decode();
  } catch {
    return cancel();
  }
  W = img.naturalWidth;
  H = img.naturalHeight;
  canvas.width = W;
  canvas.height = H;
  k = W / window.innerWidth;
  if (mode === 'color') {
    const store = document.createElement('canvas');
    store.width = W;
    store.height = H;
    pixels = store.getContext('2d', { willReadFrequently: true });
    pixels.drawImage(img, 0, 0);
  }
  draw();
  document.documentElement.dataset.ready = 'true';
  return undefined;
}

// What the tests look at.
window.__overlay = {
  state: () => ({ mode, phase, sel, shapes: shapes.length, tool, color, k, W, H }),
};

start();
