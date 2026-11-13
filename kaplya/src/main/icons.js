'use strict';
// Pictures for things: a program's own icon (also when all we have is a shortcut to
// it, and then without the little arrow), a web site's icon, a file's thumbnail the
// way Explorer shows it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

/** "%SystemRoot%\\system32\\shell32.dll" -> "C:\\Windows\\system32\\shell32.dll" */
function expandEnv(s) {
  return String(s || '').replace(/%([^%]+)%/g, (whole, name) => {
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? process.env[key] : whole;
  });
}

/** Text of a small Windows text file whatever its encoding (UTF-16, UTF-8 or the old Cyrillic code page). */
function readTextLoose(file) {
  const buf = fs.readFileSync(file);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').slice(1);
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\ufffd')) return utf8.replace(/^\ufeff/, '');
  try {
    return new TextDecoder('windows-1251').decode(buf);
  } catch {
    return utf8;
  }
}

/** An internet shortcut (.url file): where it leads and which icon it names. */
function parseUrlFile(text) {
  const get = (key) => {
    const m = new RegExp('^\\s*' + key + '\\s*=\\s*(.*?)\\s*$', 'im').exec(text);
    return m ? m[1] : '';
  };
  return { url: get('URL'), iconFile: get('IconFile'), iconIndex: Number(get('IconIndex')) || 0 };
}

/**
 * The icons a page offers, best first. Looks at <link rel="icon" ...> and friends.
 * @returns {string[]} absolute URLs
 */
function iconLinks(html, pageUrl) {
  const found = [];
  const tags = String(html).slice(0, 400000).match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attr = (name) => {
      const m = new RegExp('\\b' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tag);
      return m ? (m[2] ?? m[3] ?? m[4] ?? '') : '';
    };
    const rel = attr('rel').toLowerCase();
    if (!/\bicon\b/.test(rel)) continue;
    const href = attr('href');
    if (!href || /^data:/i.test(href)) continue;
    const type = attr('type').toLowerCase();
    if (type.includes('svg') || /\.svg(\?|#|$)/i.test(href)) continue; // cannot be turned into a bitmap here
    let abs;
    try {
      abs = new URL(href.replace(/&amp;/g, '&'), pageUrl).href;
    } catch {
      continue;
    }
    if (!/^https?:/i.test(abs)) continue;
    const size = Math.max(0, ...(attr('sizes').match(/\d+/g) || []).map(Number));
    // a touch icon is big and made to be shown on its own; a tiny favicon is the last resort
    const score = (rel.includes('apple-touch') ? 150 : 0) + (size || (rel.includes('apple-touch') ? 180 : 16));
    found.push({ abs, score });
  }
  found.sort((a, b) => b.score - a.score);
  return [...new Set(found.map((f) => f.abs))];
}

/** The biggest picture inside an .ico file, if it is stored as PNG (big ones are). */
function pngFromIco(buf) {
  if (buf.length < 22 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null;
  const count = buf.readUInt16LE(4);
  let best = null;
  for (let i = 0; i < count && 6 + (i + 1) * 16 <= buf.length; i++) {
    const at = 6 + i * 16;
    const width = buf[at] || 256;
    const size = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    if (offset + size > buf.length || size < 8) continue;
    const isPng = buf[offset] === 0x89 && buf[offset + 1] === 0x50;
    if (isPng && (!best || width > best.width)) best = { width, data: buf.subarray(offset, offset + size) };
  }
  return best ? Buffer.from(best.data) : null;
}

class Icons {
  /**
   * @param {object} deps
   * @param {Electron.App} deps.app
   * @param {Electron.Shell} deps.shell
   * @param {typeof Electron.nativeImage} deps.nativeImage
   * @param {typeof fetch} deps.fetch
   * @param {string} deps.dir        where site icons are kept
   * @param {(cmd: string, args: object) => Promise<any>} [deps.helper]  the Windows helper
   */
  constructor(deps) {
    this.app = deps.app;
    this.shell = deps.shell;
    this.nativeImage = deps.nativeImage;
    this.fetch = deps.fetch;
    this.dir = deps.dir;
    this.helper = deps.helper || null;
    this.memo = new Map();
  }

  /** What to take the picture from: for a shortcut, the thing it points to. */
  resolve(file) {
    const ext = path.extname(file).toLowerCase();
    const out = { source: file, index: 0, url: '' };
    if (process.platform !== 'win32') return out;
    if (ext === '.lnk') {
      try {
        const link = this.shell.readShortcutLink(file);
        const icon = expandEnv(link.icon || '');
        const target = expandEnv(link.target || '');
        if (icon && fs.existsSync(icon)) {
          out.source = icon;
          out.index = Number(link.iconIndex) || 0;
        } else if (target && fs.existsSync(target)) {
          out.source = target;
        }
      } catch {
        // an unusual shortcut: its own picture will have to do
      }
    } else if (ext === '.url') {
      try {
        const info = parseUrlFile(readTextLoose(file));
        const icon = expandEnv(info.iconFile);
        if (icon && fs.existsSync(icon)) {
          out.source = icon;
          out.index = info.iconIndex;
        } else if (/^https?:\/\//i.test(info.url)) {
          out.url = info.url;
        }
      } catch {}
    }
    return out;
  }

  /** A program's or file's icon as a data: URL (PNG), or null. */
  async forFile(file) {
    const key = 'f:' + file;
    if (this.memo.has(key)) return this.memo.get(key);
    const job = this.fileIcon(file).catch(() => null);
    this.memo.set(key, job);
    return job;
  }

  async fileIcon(file) {
    const r = this.resolve(file);
    if (r.url) {
      const site = await this.forSite(r.url);
      if (site) return site;
    }
    const ext = path.extname(r.source).toLowerCase();
    // An icon picked by number out of a library of icons: only Windows can cut it out.
    if (this.helper && (r.index !== 0 || ext === '.dll' || ext === '.icl' || ext === '.cpl')) {
      try {
        const res = await this.helper('icon.extract', { path: r.source, index: r.index, size: 64 });
        if (res && res.data) return 'data:image/png;base64,' + res.data;
      } catch {}
    }
    for (const source of r.source === file ? [file] : [r.source, file]) {
      const big = await this.thumbnail(source, 96);
      if (big) return big;
      try {
        const img = await this.app.getFileIcon(source, { size: 'large' });
        if (img && !img.isEmpty()) return img.toDataURL();
      } catch {}
    }
    return null;
  }

  /**
   * The picture Explorer would show for a file: a preview for images and videos,
   * the icon for the rest. @returns data: URL or null
   */
  async thumbnail(file, size = 256) {
    const ext = path.extname(file).toLowerCase();
    const make = this.nativeImage.createThumbnailFromPath;
    if (typeof make === 'function' && (process.platform === 'win32' || process.platform === 'darwin')) {
      try {
        const img = await make.call(this.nativeImage, file, { width: size, height: size });
        if (img && !img.isEmpty()) return img.toDataURL();
      } catch {}
    }
    if (IMAGE_EXT.has(ext)) {
      try {
        const img = this.nativeImage.createFromPath(file);
        if (!img.isEmpty()) {
          const s = img.getSize();
          const k = Math.min(1, size / Math.max(s.width, s.height));
          return img.resize({ width: Math.max(1, Math.round(s.width * k)), quality: 'good' }).toDataURL();
        }
      } catch {}
    }
    return null;
  }

  /** For the shelf: { url, preview } where preview says "this is the file's own picture, not a generic icon". */
  async forShelf(file) {
    const key = 's:' + file;
    if (this.memo.has(key)) return this.memo.get(key);
    const job = (async () => {
      const ext = path.extname(file).toLowerCase();
      if (ext === '.lnk' || ext === '.url' || ext === '.exe') return { url: await this.forFile(file), preview: false };
      const thumb = await this.thumbnail(file, 256);
      if (thumb) return { url: thumb, preview: IMAGE_EXT.has(ext) || /^\.(mp4|mov|mkv|avi|webm|pdf|psd|heic|tif|tiff|svg)$/i.test(ext) };
      return { url: await this.forFile(file), preview: false };
    })().catch(() => ({ url: null, preview: false }));
    this.memo.set(key, job);
    return job;
  }

  forget(file) {
    this.memo.delete('f:' + file);
    this.memo.delete('s:' + file);
  }

  // ---------------------------------------------------------------- web sites

  siteFile(url) {
    let host = '';
    try {
      host = new URL(url).host;
    } catch {}
    return path.join(this.dir, crypto.createHash('sha1').update(host || String(url)).digest('hex').slice(0, 16) + '.png');
  }

  /** A site's icon as a data: URL, fetched from the site itself and kept on disk. */
  async forSite(url) {
    const file = this.siteFile(url);
    try {
      return 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
    } catch {}
    const key = 'u:' + file;
    if (this.memo.has(key)) return this.memo.get(key);
    const job = (async () => {
      const png = await this.fetchSiteIcon(url);
      if (!png) return null;
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(file, png);
      } catch {}
      return 'data:image/png;base64,' + png.toString('base64');
    })().catch(() => null);
    this.memo.set(key, job);
    const result = await job;
    if (!result) this.memo.delete(key); // offline now: try again next time
    return result;
  }

  async get(url, { text = false, maxBytes = 1500000, timeoutMs = 7000 } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await this.fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': BROWSER_UA, Accept: text ? 'text/html,*/*' : 'image/*,*/*' } });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > maxBytes) return null;
      return { buf, url: res.url || url };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** @returns {Promise<Buffer|null>} PNG bytes, about 64 pixels */
  async fetchSiteIcon(pageUrl) {
    let origin;
    try {
      origin = new URL(pageUrl).origin;
    } catch {
      return null;
    }
    const candidates = [];
    const page = await this.get(pageUrl, { text: true });
    if (page) candidates.push(...iconLinks(page.buf.toString('utf8'), page.url));
    candidates.push(origin + '/apple-touch-icon.png', origin + '/favicon.ico');
    for (const candidate of [...new Set(candidates)].slice(0, 6)) {
      const got = await this.get(candidate);
      if (!got) continue;
      const img = await this.decode(got.buf);
      if (!img) continue;
      const size = img.getSize();
      if (size.width < 16) continue;
      const out = size.width > 96 ? img.resize({ width: 96, quality: 'best' }) : img;
      return out.toPNG();
    }
    return null;
  }

  async decode(buf) {
    try {
      let img = this.nativeImage.createFromBuffer(buf);
      if (!img.isEmpty()) return img;
      const inner = pngFromIco(buf);
      if (inner) {
        img = this.nativeImage.createFromBuffer(inner);
        if (!img.isEmpty()) return img;
      }
      // an old-style .ico: Windows can read it from a file
      if (process.platform === 'win32' && buf.length > 6 && buf.readUInt16LE(2) === 1) {
        const tmp = path.join(os.tmpdir(), `kaplya-ico-${process.pid}-${Date.now()}.ico`);
        try {
          fs.writeFileSync(tmp, buf);
          img = await this.nativeImage.createThumbnailFromPath(tmp, { width: 64, height: 64 });
          if (img && !img.isEmpty()) return img;
        } catch {} finally {
          try { fs.unlinkSync(tmp); } catch {}
        }
      }
    } catch {}
    return null;
  }
}

module.exports = { Icons, expandEnv, parseUrlFile, iconLinks, pngFromIco };
