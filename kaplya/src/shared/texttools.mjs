// Text transformations for the "Текст" tab. Pure functions, no DOM.

const EN = "`qwertyuiop[]asdfghjkl;'zxcvbnm,./~QWERTYUIOP{}ASDFGHJKL:\"ZXCVBNM<>?@#$^&";
const RU = 'ёйцукенгшщзхъфывапролджэячсмитьбю.ЁЙЦУКЕНГШЩЗХЪФЫВАПРОЛДЖЭЯЧСМИТЬБЮ,"№;:?';

const EN_TO_RU = new Map();
const RU_TO_EN = new Map();
for (let i = 0; i < EN.length; i++) {
  EN_TO_RU.set(EN[i], RU[i]);
  if (!RU_TO_EN.has(RU[i])) RU_TO_EN.set(RU[i], EN[i]);
}

/** Text typed in the wrong keyboard layout: "ghbdtn" <-> "привет". The direction is guessed from the letters. */
export function switchLayout(text, direction = 'auto') {
  let dir = direction;
  if (dir === 'auto') {
    const ru = (text.match(/[а-яё]/gi) || []).length;
    const en = (text.match(/[a-z]/gi) || []).length;
    dir = ru > en ? 'ru-en' : 'en-ru';
  }
  const map = dir === 'ru-en' ? RU_TO_EN : EN_TO_RU;
  let out = '';
  for (const ch of text) out += map.has(ch) ? map.get(ch) : ch;
  return out;
}

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Russian letters written with Latin ones: "Привет" -> "Privet". */
export function translit(text) {
  let out = '';
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const lower = ch.toLowerCase();
    if (!(lower in TRANSLIT)) {
      out += ch;
      continue;
    }
    const t = TRANSLIT[lower];
    if (ch === lower || !t) {
      out += t;
      continue;
    }
    // "Щука" -> "Shchuka", but "ЩУКА" -> "SHCHUKA"
    const next = chars[i + 1];
    const allCaps = next && next !== next.toLowerCase() && next === next.toUpperCase();
    out += allCaps ? t.toUpperCase() : t[0].toUpperCase() + t.slice(1);
  }
  return out;
}

export const upper = (t) => t.toUpperCase();
export const lower = (t) => t.toLowerCase();

/** Каждое Слово С Заглавной */
export function titleCase(text) {
  return text.toLowerCase().replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_m, pre, ch) => pre + ch.toUpperCase());
}

/** Как в предложении: первая буква после точки заглавная, остальные строчные. */
export function sentenceCase(text) {
  return text.toLowerCase().replace(/(^\s*|[.!?…]\s+|\n\s*)(\p{L})/gu, (_m, pre, ch) => pre + ch.toUpperCase());
}

export function invertCase(text) {
  let out = '';
  for (const ch of text) out += ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
  return out;
}

/** Joins lines broken by copying from a PDF or a narrow column; blank lines still separate paragraphs. */
export function removeLineBreaks(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.replace(/-\n(?=\p{Ll})/gu, '').replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

/** Double spaces, spaces before punctuation, spaces at line ends, more than one blank line. */
export function cleanSpaces(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ +([,.;:!?])/g, '$1')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sortLines(text) {
  return text.replace(/\r\n?/g, '\n').split('\n').sort((a, b) => a.localeCompare(b, ['ru', 'en'], { numeric: true, sensitivity: 'base' })).join('\n');
}

export function uniqueLines(text) {
  const seen = new Set();
  return text.replace(/\r\n?/g, '\n').split('\n').filter((l) => (seen.has(l) ? false : (seen.add(l), true))).join('\n');
}

export function jsonPretty(text) {
  return JSON.stringify(JSON.parse(text), null, 2);
}

export function jsonMinify(text) {
  return JSON.stringify(JSON.parse(text));
}

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64Encode(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

export function base64Decode(text) {
  const clean = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(clean);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export const urlEncode = (t) => encodeURIComponent(t);
export const urlDecode = (t) => decodeURIComponent(t.replace(/\+/g, ' '));

export function stats(text) {
  const chars = [...text].length;
  const noSpaces = [...text.replace(/\s/g, '')].length;
  const words = (text.match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) || []).length;
  const lines = text ? text.split(/\r\n|\r|\n/).length : 0;
  return { chars, noSpaces, words, lines };
}

/**
 * The buttons of the "Текст" tab. `fn` may throw: the tab shows `error` instead.
 */
export const TOOLS = [
  { id: 'layout', label: 'Раскладка', hint: 'ghbdtn → привет', fn: (t) => switchLayout(t) },
  { id: 'upper', label: 'ВЕРХНИЙ', fn: upper },
  { id: 'lower', label: 'нижний', fn: lower },
  { id: 'title', label: 'Каждое Слово', fn: titleCase },
  { id: 'sentence', label: 'Как в предложении', short: 'Предложение', fn: sentenceCase },
  { id: 'translit', label: 'Транслит', hint: 'Привет → Privet', fn: translit },
  { id: 'breaks', label: 'Убрать переносы', fn: removeLineBreaks },
  { id: 'spaces', label: 'Лишние пробелы', fn: cleanSpaces },
  { id: 'sort', label: 'Сортировать строки', short: 'Сортировка', fn: sortLines },
  { id: 'unique', label: 'Без повторов', fn: uniqueLines },
  { id: 'json', label: 'JSON красиво', fn: jsonPretty, error: 'Это не JSON' },
  { id: 'jsonmin', label: 'JSON в строку', fn: jsonMinify, error: 'Это не JSON' },
  { id: 'b64', label: '→ Base64', fn: base64Encode },
  { id: 'unb64', label: 'Base64 →', fn: base64Decode, error: 'Это не Base64' },
  { id: 'url', label: '→ URL', fn: urlEncode },
  { id: 'unurl', label: 'URL →', fn: urlDecode, error: 'Не получилось раскодировать' },
];
