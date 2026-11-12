// Synced lyrics in the LRC format: "[01:23.45] line".

/** @returns {{ t: number, text: string }[]} sorted by time, in seconds */
export function parseLrc(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const stamps = [];
    let rest = raw;
    for (;;) {
      const m = /^\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/.exec(rest);
      if (!m) break;
      const frac = m[3] ? Number('0.' + m[3]) : 0;
      stamps.push(Number(m[1]) * 60 + Number(m[2]) + frac);
      rest = rest.slice(m[0].length);
    }
    if (!stamps.length) continue;
    const line = rest.trim();
    for (const t of stamps) out.push({ t, text: line });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Index of the line being sung at `seconds`, or -1 before the first one. */
export function lineAt(lines, seconds) {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= seconds) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** "3:07" */
export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
