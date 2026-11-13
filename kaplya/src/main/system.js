'use strict';
// What the computer is doing right now: music, volume, theme, full-screen apps.
// Everything comes from the Windows helper; this module polls it and tells the
// island only when something has changed.

const { EventEmitter } = require('node:events');

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

class SystemWatch extends EventEmitter {
  constructor(helper, opts = {}) {
    super();
    this.helper = helper;
    this.ownPids = opts.ownPids || [process.pid];
    this.media = null;
    this.cover = null; // { key, url, from: 'player' | 'web' | null, tries, asked, note }
    this.findCover = opts.findCover || null; // async (track) => data URL or null
    this.followApp = '';
    this.volume = { available: false, level: 0, muted: false };
    this.dark = false;
    this.fullscreen = false;
    this.timers = [];
    this.busy = { media: false, sys: false };
    this.volumeHold = 0;
    this.mediaSeen = false; // becomes true after the first look at the player
  }

  start() {
    if (!this.helper.supported) return;
    this.helper.start();
    this.timers.push(setInterval(() => this.pollMedia(), 1000));
    this.timers.push(setInterval(() => this.pollSys(), 1500));
    this.pollSys();
    this.pollMedia();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  snapshot() {
    return {
      media: this.media ? {
        ...this.media,
        cover: this.cover && this.cover.key === this.media.key ? this.cover.url : null,
        coverFrom: this.cover && this.cover.key === this.media.key ? this.cover.from : null,
      } : null,
      volume: this.volume,
      dark: this.dark,
      fullscreen: this.fullscreen,
      helper: this.helper.supported,
    };
  }

  async pollMedia() {
    if (this.busy.media) return;
    this.busy.media = true;
    try {
      // Ask for the picture only while we do not have the player's own one. Players
      // often publish it a moment after the title, and some much later, so keep
      // asking: every second at first, then now and then.
      const c = this.cover;
      const ask = !c || c.from !== 'player' ? (!c || c.tries < 10 || c.tries % 5 === 0) : false;
      const have = c && !ask ? c.key : '';
      const raw = await this.helper.call('media.get', { have, app: this.followApp || '' }, 8000);
      this.applyMedia(raw);
    } catch {
      this.applyMedia(null);
    } finally {
      this.busy.media = false;
    }
  }

  /** Follow this program's player instead of the one Windows calls current ('' = automatic). */
  follow(app) {
    this.followApp = String(app || '');
    this.pollMedia();
  }

  applyMedia(raw) {
    const first = !this.mediaSeen;
    this.mediaSeen = true;
    if (!raw || (!raw.title && !raw.artist)) {
      if (this.media) {
        this.media = null;
        this.emit('media', null);
      }
      return;
    }
    const playing = raw.status === 'Playing';
    let position = Number(raw.position) || 0;
    const duration = Number(raw.duration) || 0;
    // The player reports where it was at `updated`; bring that forward to now.
    if (playing && raw.updated > 0 && raw.now >= raw.updated) {
      const drift = (raw.now - raw.updated) / 1000;
      if (drift < 3600) position += drift;
    }
    if (duration > 0) position = Math.min(position, duration);
    const next = {
      key: raw.key,
      app: raw.app,
      title: raw.title || '',
      artist: raw.artist || '',
      album: raw.album || '',
      playing,
      position,
      duration,
      at: Date.now(),
      canPrev: raw.canPrev !== false,
      canNext: raw.canNext !== false,
      canSeek: Boolean(raw.canSeek),
    };

    let coverChanged = false;
    if (!this.cover || this.cover.key !== raw.key) {
      this.cover = { key: raw.key, url: null, from: null, tries: 0, asked: false, note: '' };
      coverChanged = true;
    }
    const c = this.cover;
    if (raw.thumb && raw.thumb.data) {
      c.url = `data:${raw.thumb.mime || 'image/png'};base64,${raw.thumb.data}`;
      c.from = 'player';
      c.note = '';
      coverChanged = true;
    } else if (c.from !== 'player') {
      if ('thumb' in raw || raw.thumbNote !== undefined) c.note = String(raw.thumbNote || '');
      c.tries += 1;
      // Three seconds without a picture from the player: look for one on the internet.
      if (c.tries >= 3 && !c.asked && this.findCover) {
        c.asked = true;
        const key = raw.key;
        Promise.resolve(this.findCover(next)).then((url) => {
          if (!url || !this.cover || this.cover.key !== key || this.cover.from === 'player') return;
          this.cover.url = url;
          this.cover.from = 'web';
          if (this.media && this.media.key === key) this.emit('media', { ...this.media, cover: url, coverFrom: 'web' }, { trackChanged: false });
        }).catch(() => {});
      }
    }

    const prev = this.media;
    const trackChanged = !prev || prev.key !== next.key;
    const stateChanged = trackChanged || prev.playing !== next.playing || prev.duration !== next.duration ||
      prev.canSeek !== next.canSeek || Math.abs((prev.position + (prev.playing ? (next.at - prev.at) / 1000 : 0)) - next.position) > 1.5;
    this.media = next;
    if (stateChanged || coverChanged) {
      // What was already playing when the app started is not news.
      this.emit('media', { ...next, cover: c.url, coverFrom: c.from }, { trackChanged: trackChanged && !first });
    }
  }

  async pollSys() {
    if (this.busy.sys) return;
    this.busy.sys = true;
    try {
      const r = await this.helper.call('sys.poll', { ownPids: this.ownPids }, 15000);
      this.emit('poll', r);
      if (r.volume && Date.now() > this.volumeHold && !sameJson(pickVolume(r.volume), this.volume)) {
        this.volume = pickVolume(r.volume);
        this.emit('volume', this.volume);
      }
      if (Boolean(r.dark) !== this.dark) {
        this.dark = Boolean(r.dark);
        this.emit('theme', this.dark);
      }
      if (Boolean(r.fullscreen) !== this.fullscreen) {
        this.fullscreen = Boolean(r.fullscreen);
        this.emit('fullscreen', this.fullscreen);
      }
    } catch {
      // The helper is restarting or missing; keep the last known state.
    } finally {
      this.busy.sys = false;
    }
  }

  async setVolume(change) {
    // While the slider is being dragged, do not let a poll put the knob back.
    this.volumeHold = Date.now() + 1200;
    const args = {};
    if (typeof change.level === 'number') args.level = Math.max(0, Math.min(1, change.level));
    if (typeof change.muted === 'boolean') args.muted = change.muted;
    const r = await this.helper.call('volume.set', args);
    this.volume = pickVolume(r);
    this.emit('volume', this.volume);
    return this.volume;
  }

  async mediaCommand(action, position) {
    const ok = await this.helper.tryCall('media.cmd', { action, position, app: this.followApp || '' }, false);
    setTimeout(() => this.pollMedia(), 250);
    return ok;
  }

  async setTheme(dark) {
    const r = await this.helper.call('theme.set', { dark: Boolean(dark) });
    this.dark = Boolean(r.dark);
    this.emit('theme', this.dark);
    return this.dark;
  }
}

function pickVolume(v) {
  return { available: Boolean(v.available), level: Number(v.level) || 0, muted: Boolean(v.muted) };
}

module.exports = { SystemWatch };
