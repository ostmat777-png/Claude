'use strict';
// Clipboard history. Lives in memory only: it often holds things that should not
// be written to disk, and Windows' own history behaves the same way.

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

// Password managers put these markers on what they copy; such content is skipped.
const PRIVATE_FORMATS = ['ExcludeClipboardContentFromMonitorProcessing', 'Clipboard Viewer Ignore'];
const MAX_IMAGES = 12;
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

function hash(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function classify(text) {
  const t = text.trim();
  if (/^(https?:\/\/|www\.)\S+$/i.test(t)) return 'link';
  if (/^#?[0-9a-f]{6}([0-9a-f]{2})?$/i.test(t) || /^(rgb|hsl)a?\([^)]*\)$/i.test(t)) return 'color';
  if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(t)) return 'mail';
  return 'text';
}

class ClipWatch extends EventEmitter {
  /**
   * @param {object} deps
   * @param {object} deps.io  readText, writeText, types, readImagePng, writeImagePng, hasNative (see clipio.js)
   * @param {() => Promise<number|null>} [deps.seq]  clipboard change counter, or null when unknown
   * @param {(png: Buffer) => {width:number,height:number,thumb:string}|null} [deps.describeImage]
   */
  constructor(deps, opts = {}) {
    super();
    this.io = deps.io;
    this.seq = deps.seq || (async () => null);
    this.describeImage = deps.describeImage || (() => null);
    this.limit = opts.limit || 60;
    this.keepImages = opts.images !== false;
    this.items = [];
    this.images = new Map(); // id -> PNG bytes
    this.nextId = 1;
    this.lastSeq = undefined;
    this.lastSig = null;
    this.own = null; // { image, until }: the next change of this kind is our own doing
    this.timer = null;
    this.busy = false;
    this.imageCheckAt = 0;
  }

  start(intervalMs = 450) {
    // Whatever is on the clipboard at start is not "just copied": remember it quietly.
    this.check(true).finally(() => {
      this.timer = setInterval(() => this.check(false), intervalMs);
    });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  list() {
    return this.items.map((i) => ({ ...i }));
  }

  async isPrivate() {
    for (const f of PRIVATE_FORMATS) {
      if (await this.io.hasNative(f)) return true;
    }
    return false;
  }

  async check(silent) {
    if (this.busy) return;
    this.busy = true;
    try {
      let seq = null;
      try {
        seq = await this.seq();
      } catch {
        seq = null;
      }
      if (seq !== null && seq !== undefined) {
        if (seq === this.lastSeq) return;
        this.lastSeq = seq;
        await this.read(silent, true);
      } else {
        await this.read(silent, false);
      }
    } catch {
      // a clipboard that cannot be read right now (another program holds it): next time
    } finally {
      this.busy = false;
    }
  }

  /** @param {boolean} changed  true when we know for sure the clipboard has new content */
  async read(silent, changed) {
    const text = await this.io.readText();
    if (text.trim()) {
      const sig = 't:' + hash(Buffer.from(text, 'utf8'));
      if (sig === this.lastSig) return;
      this.lastSig = sig;
      if (await this.isPrivate()) return;
      this.push({ kind: classify(text), sig, text: text.length > 20000 ? text.slice(0, 20000) : text, size: text.length }, silent);
      return;
    }

    const formats = await this.io.types();
    const hasImage = formats.some((f) => f.startsWith('image/'));
    if (hasImage && this.keepImages) {
      // Without a change counter, fetching a big picture twice a second would burn
      // CPU for nothing, so look at pictures less often.
      if (!changed) {
        const now = Date.now();
        if (now - this.imageCheckAt < 1500) return;
        this.imageCheckAt = now;
      }
      const png = await this.io.readImagePng();
      if (!png || png.length > MAX_IMAGE_BYTES) return;
      const sig = 'i:' + hash(png);
      if (sig === this.lastSig) return;
      this.lastSig = sig;
      if (await this.isPrivate()) return;
      const info = this.describeImage(png);
      if (!info) return;
      const item = this.push({ kind: 'image', sig, text: '', width: info.width, height: info.height, thumb: info.thumb }, silent);
      if (item) this.images.set(item.id, png);
      this.trimImages();
      return;
    }

    if (!hasImage) this.lastSig = null;
  }

  push(entry, silent) {
    const own = Boolean(this.own && Date.now() < this.own.until && this.own.image === (entry.kind === 'image'));
    this.own = null;
    const existing = this.items.findIndex((i) => i.sig === entry.sig);
    let item;
    if (existing >= 0) {
      item = this.items.splice(existing, 1)[0];
      item.time = Date.now();
    } else {
      item = { id: this.nextId++, time: Date.now(), pinned: false, ...entry };
    }
    this.items.unshift(item);
    this.trim();
    this.emit('change', this.list());
    if (!silent && !own) this.emit('copied', { ...item });
    return item;
  }

  trim() {
    let extra = this.items.length - this.limit;
    for (let i = this.items.length - 1; i >= 0 && extra > 0; i--) {
      if (this.items[i].pinned) continue;
      this.images.delete(this.items[i].id);
      this.items.splice(i, 1);
      extra--;
    }
  }

  /** Pictures are heavy: only the most recent few are kept. */
  trimImages() {
    const pics = this.items.filter((i) => i.kind === 'image');
    for (const old of pics.slice(MAX_IMAGES)) {
      if (old.pinned) continue;
      this.images.delete(old.id);
      this.items.splice(this.items.indexOf(old), 1);
    }
  }

  /** Puts a history entry back on the clipboard. */
  async copy(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return false;
    this.markOwn(item.kind === 'image');
    if (item.kind === 'image') {
      const png = this.images.get(id);
      if (!png) return false;
      await this.io.writeImagePng(png);
    } else {
      await this.io.writeText(item.text);
    }
    return true;
  }

  // What the app itself puts on the clipboard must not come back as a "copied" toast.
  // The content can return slightly changed (line ends, re-encoded picture), so the
  // mark is "the next text / picture within a couple of seconds", not an exact match.
  markOwn(image) {
    this.own = { image: Boolean(image), until: Date.now() + 2500 };
  }

  async writeOwn(text) {
    this.markOwn(false);
    await this.io.writeText(String(text));
  }

  async writeOwnImage(png) {
    this.markOwn(true);
    await this.io.writeImagePng(png);
  }

  remove(id) {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return;
    this.images.delete(id);
    this.items.splice(i, 1);
    this.emit('change', this.list());
  }

  togglePin(id) {
    const item = this.items.find((x) => x.id === id);
    if (!item) return;
    item.pinned = !item.pinned;
    this.emit('change', this.list());
  }

  clear() {
    this.items = this.items.filter((i) => i.pinned);
    for (const id of [...this.images.keys()]) if (!this.items.some((i) => i.id === id)) this.images.delete(id);
    this.emit('change', this.list());
  }
}

module.exports = { ClipWatch, classify };
