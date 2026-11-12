// A small calculator for the command line: "2+2*2", "15% от 2400", "200 + 10%", "sqrt(2)".
// Returns null for anything that is not arithmetic. Never evaluates code.

const FUNCS = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  ln: Math.log,
  log: Math.log10,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  корень: Math.sqrt,
};
const CONSTS = { pi: Math.PI, e: Math.E, 'π': Math.PI };

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const s = src.replace(/ /g, ' ');
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ') {
      i++;
      continue;
    }
    if (/[0-9.,]/.test(ch)) {
      let j = i;
      // digits, with spaces allowed as thousands separators: "1 000 000"
      while (j < s.length && (/[0-9.,]/.test(s[j]) || (s[j] === ' ' && /[0-9]/.test(s[j - 1] || '') && /^\d{3}(?!\d)/.test(s.slice(j + 1))))) j++;
      const raw = s.slice(i, j).replace(/ /g, '').replace(/,/g, '.');
      if (!/^(\d+\.?\d*|\.\d+)$/.test(raw)) return null;
      tokens.push({ t: 'num', v: parseFloat(raw) });
      i = j;
      continue;
    }
    if ('+-*/^()%'.includes(ch)) {
      tokens.push({ t: ch });
      i++;
      continue;
    }
    if (ch === '×' || ch === '·') {
      tokens.push({ t: '*' });
      i++;
      continue;
    }
    if (ch === '÷' || ch === ':') {
      tokens.push({ t: '/' });
      i++;
      continue;
    }
    if (ch === '−' || ch === '–') {
      tokens.push({ t: '-' });
      i++;
      continue;
    }
    const word = /^[a-zа-яёπ]+/i.exec(s.slice(i));
    if (word) {
      const w = word[0].toLowerCase();
      if (w === 'от' || w === 'of') tokens.push({ t: 'of' });
      else if (w === 'x' || w === 'х') tokens.push({ t: '*' });
      else if (w in FUNCS) tokens.push({ t: 'fn', v: FUNCS[w] });
      else if (w in CONSTS) tokens.push({ t: 'num', v: CONSTS[w] });
      else return null;
      i += word[0].length;
      continue;
    }
    return null;
  }
  return tokens;
}

function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (t) => (peek() && peek().t === t ? tokens[pos++] : null);

  // Every level returns { v, pct }: pct marks a bare percentage such as "10%".
  function expr() {
    let left = term();
    for (;;) {
      const op = take('+') || take('-');
      if (!op) return left;
      const right = term();
      // "200 + 10%" means "200 plus ten percent of 200"
      const r = right.pct ? left.v * right.v : right.v;
      left = { v: op.t === '+' ? left.v + r : left.v - r, pct: false };
    }
  }
  function term() {
    let left = power();
    for (;;) {
      if (take('of')) {
        // "15% от 2400"
        const right = power();
        left = { v: left.v * right.v, pct: false };
        continue;
      }
      const op = take('*') || take('/');
      if (!op) return left;
      const right = power();
      left = { v: op.t === '*' ? left.v * right.v : left.v / right.v, pct: false };
    }
  }
  function power() {
    const base = unary();
    if (take('^')) {
      const exp = power();
      return { v: Math.pow(base.v, exp.v), pct: false };
    }
    return base;
  }
  function unary() {
    if (take('-')) {
      const u = unary();
      return { v: -u.v, pct: u.pct };
    }
    if (take('+')) return unary();
    return postfix();
  }
  function postfix() {
    const p = primary();
    if (take('%')) return { v: p.v / 100, pct: true };
    return p;
  }
  function primary() {
    const tok = peek();
    if (!tok) throw new Error('end');
    if (tok.t === 'num') {
      pos++;
      return { v: tok.v, pct: false };
    }
    if (tok.t === 'fn') {
      pos++;
      if (!take('(')) throw new Error('(');
      const inner = expr();
      if (!take(')')) throw new Error(')');
      return { v: tok.v(inner.v), pct: false };
    }
    if (take('(')) {
      const inner = expr();
      if (!take(')')) throw new Error(')');
      return { v: inner.v, pct: false };
    }
    throw new Error('unexpected');
  }

  const result = expr();
  if (pos !== tokens.length) throw new Error('trailing');
  return result.v;
}

/** @returns {number|null} */
export function calculate(input) {
  const src = String(input || '').trim().replace(/=$/, '').trim();
  if (!src || !/\d/.test(src)) return null;
  const tokens = tokenize(src);
  if (!tokens || tokens.length < 2) return null;
  // A lone number is not a calculation.
  if (!tokens.some((t) => t.t !== 'num' && t.t !== '(' && t.t !== ')')) return null;
  try {
    const v = parse(tokens);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** 0.1+0.2 -> "0,3"; 1234567.891 -> "1 234 567,891" */
export function formatNumber(v) {
  const rounded = Number(v.toPrecision(12));
  if (Math.abs(rounded) >= 1e15 || (rounded !== 0 && Math.abs(rounded) < 1e-9)) return String(rounded).replace('.', ',');
  const [int, frac] = String(rounded).split('.');
  const sign = int.startsWith('-') ? '-' : '';
  const digits = sign ? int.slice(1) : int;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return sign + grouped + (frac ? ',' + frac : '');
}
