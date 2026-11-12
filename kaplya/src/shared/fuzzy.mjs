// Ranking for the command line: how well does a name match what was typed?

import { switchLayout } from './texttools.mjs';

const norm = (s) => String(s).toLowerCase().replace(/ё/g, 'е');

/** 0 = no match; higher is better. */
export function score(name, query) {
  const n = norm(name);
  const q = norm(query).trim();
  if (!q) return 0;
  if (n === q) return 1000;
  if (n.startsWith(q)) return 800 - Math.min(200, n.length - q.length);
  // start of a word: "code" in "Visual Studio Code"
  const wordAt = n.search(new RegExp('(^|[\\s\\-_.(])' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  if (wordAt >= 0) return 600 - Math.min(100, wordAt);
  // initials: "vsc" -> "Visual Studio Code"
  const initials = n.split(/[\s\-_.]+/).map((w) => w[0] || '').join('');
  if (q.length >= 2 && initials.startsWith(q)) return 500;
  const at = n.indexOf(q);
  if (at >= 0) return 400 - Math.min(100, at);
  // letters in order: "pshop" -> "Photoshop"
  if (q.length >= 3) {
    let i = 0;
    let gaps = 0;
    let last = -1;
    for (let k = 0; k < n.length && i < q.length; k++) {
      if (n[k] === q[i]) {
        if (last >= 0) gaps += k - last - 1;
        last = k;
        i++;
      }
    }
    if (i === q.length && gaps <= q.length * 2) return 200 - Math.min(150, gaps * 10);
  }
  return 0;
}

/**
 * Best matches first. Also tries the query as if typed in the other keyboard layout
 * ("сщву" finds "Code"), at a small penalty.
 * @template T
 * @param {T[]} items
 * @param {string} query
 * @param {(item: T) => string} nameOf
 * @returns {T[]}
 */
export function rank(items, query, nameOf, limit = 8) {
  const alt = switchLayout(query);
  const scored = [];
  for (const item of items) {
    const name = nameOf(item);
    const s = Math.max(score(name, query), alt !== query ? score(name, alt) - 50 : 0);
    if (s > 0) scored.push({ item, s, name });
  }
  scored.sort((a, b) => b.s - a.s || a.name.length - b.name.length || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((x) => x.item);
}
