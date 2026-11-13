'use strict';
// How long each program was in front, day by day. Counts only while someone is
// at the computer: after a few minutes without mouse or keyboard the clock
// stops (unless something is playing full screen, like a film). Kept on this
// computer only, in activity.json; window titles are not kept, only programs.

const fs = require('node:fs');
const path = require('node:path');

const KEEP_DAYS = 35;
const IDLE_MS = 3 * 60 * 1000;
const MAX_STEP_MS = 10 * 1000; // a longer gap (sleep, a hang) is not counted

function dayKey(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The app's own windows and the desktop itself are not "a program you used". */
function ignored(app, ownExe) {
  if (!app || !app.exe) return true;
  const exe = String(app.exe).toLowerCase();
  if (ownExe && exe === ownExe) return true;
  return ['lockapp.exe', 'logonui.exe', 'searchhost.exe', 'searchapp.exe', 'shellexperiencehost.exe', 'startmenuexperiencehost.exe'].includes(exe);
}

class Activity {
  /**
   * @param {object} opts
   * @param {string} opts.file
   * @param {() => boolean} [opts.enabled]
   * @param {string} [opts.ownExe]   our own program name, lower case
   */
  constructor(opts) {
    this.file = opts.file;
    this.enabled = opts.enabled || (() => true);
    this.ownExe = String(opts.ownExe || '').toLowerCase();
    this.days = {};
    this.last = 0; // time of the last sample
    this.current = null; // { key, name, path } of the program in front
    this.dirty = false;
    this.saveTimer = null;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw.days === 'object') this.days = raw.days;
    } catch {
      this.days = {};
    }
  }

  save() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, days: this.days }));
      fs.renameSync(tmp, this.file);
    } catch {}
  }

  scheduleSave() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 30000);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  /**
   * One look at the computer, every second or two.
   * @param {{ active: object|null, idleMs: number, fullscreen: boolean }} poll
   * @param {number} [now]
   */
  sample(poll, now = Date.now()) {
    const prev = this.last;
    this.last = now;
    const app = poll && poll.active;
    const away = !poll || ((Number(poll.idleMs) || 0) > IDLE_MS && !poll.fullscreen);
    if (!this.enabled() || away || ignored(app, this.ownExe)) {
      this.current = null;
      return;
    }
    const key = String(app.path || app.exe).toLowerCase();
    const was = this.current;
    this.current = { key, name: String(app.name || app.exe), path: String(app.path || ''), exe: String(app.exe) };
    // time is given to the program that was in front during the step
    if (!prev || !was || was.key !== key) return;
    const step = now - prev;
    if (step <= 0 || step > MAX_STEP_MS) return;
    this.add(was, prev, now);
  }

  /** Adds the time from `from` to `to`, split at midnight and between hours. */
  add(app, from, to) {
    let t = from;
    while (t < to) {
      const d = new Date(t);
      const nextHour = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
      const end = Math.min(to, nextHour);
      const day = (this.days[dayKey(t)] ||= { apps: {}, hours: new Array(24).fill(0) });
      const rec = (day.apps[app.key] ||= { name: app.name, path: app.path, exe: app.exe, ms: 0 });
      rec.ms += end - t;
      rec.name = app.name;
      if (app.path) rec.path = app.path;
      day.hours[d.getHours()] += end - t;
      t = end;
    }
    this.prune();
    this.scheduleSave();
  }

  prune() {
    const keys = Object.keys(this.days).sort();
    while (keys.length > KEEP_DAYS) delete this.days[keys.shift()];
  }

  /**
   * Totals for a range of days.
   * @param {'today'|'yesterday'|'week'} range
   */
  report(range, now = Date.now()) {
    const today = new Date(now);
    const days = [];
    if (range === 'yesterday') days.push(dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)));
    else if (range === 'week') for (let i = 6; i >= 0; i--) days.push(dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)));
    else days.push(dayKey(now));
    const apps = new Map();
    const hours = new Array(24).fill(0);
    const perDay = [];
    for (const key of days) {
      const day = this.days[key];
      let total = 0;
      if (day) {
        for (const [k, rec] of Object.entries(day.apps)) {
          const a = apps.get(k) || { key: k, name: rec.name, path: rec.path, exe: rec.exe, ms: 0 };
          a.ms += rec.ms;
          a.name = rec.name || a.name;
          apps.set(k, a);
          total += rec.ms;
        }
        day.hours.forEach((ms, i) => {
          hours[i] += ms;
        });
      }
      perDay.push({ day: key, ms: total });
    }
    const list = [...apps.values()].sort((a, b) => b.ms - a.ms);
    return {
      range,
      days,
      total: list.reduce((n, a) => n + a.ms, 0),
      apps: list,
      hours,
      perDay,
      now: this.current ? { key: this.current.key, name: this.current.name } : null,
    };
  }

  clear() {
    this.days = {};
    this.dirty = true;
    this.save();
  }
}

module.exports = { Activity, dayKey };
