// The countdown timer shown in the pill, the notes tab and the command line.

export class Timer extends EventTarget {
  constructor() {
    super();
    this.total = 5 * 60; // seconds
    this.left = this.total; // seconds left while paused
    this.endsAt = 0; // ms timestamp while running
    this.running = false;
    this.interval = 0;
  }

  remaining() {
    if (!this.running) return this.left;
    return Math.max(0, (this.endsAt - Date.now()) / 1000);
  }

  /** True when there is something to show outside the notes tab. */
  get active() {
    return this.running || (this.left > 0 && this.left < this.total);
  }

  set(seconds) {
    this.stopTicking();
    this.running = false;
    this.total = Math.max(1, Math.round(seconds));
    this.left = this.total;
    this.changed();
  }

  start(seconds) {
    if (typeof seconds === 'number') {
      this.total = Math.max(1, Math.round(seconds));
      this.left = this.total;
    }
    if (this.left <= 0) this.left = this.total;
    this.endsAt = Date.now() + this.left * 1000;
    this.running = true;
    this.stopTicking();
    this.interval = setInterval(() => this.tick(), 250);
    this.changed();
  }

  pause() {
    if (!this.running) return;
    this.left = this.remaining();
    this.running = false;
    this.stopTicking();
    this.changed();
  }

  reset() {
    this.stopTicking();
    this.running = false;
    this.left = this.total;
    this.changed();
  }

  tick() {
    if (!this.running) return;
    if (this.remaining() <= 0) {
      this.stopTicking();
      this.running = false;
      this.left = this.total;
      this.changed();
      this.dispatchEvent(new CustomEvent('done', { detail: { total: this.total } }));
      return;
    }
    this.changed();
  }

  stopTicking() {
    clearInterval(this.interval);
    this.interval = 0;
  }

  changed() {
    this.dispatchEvent(new Event('change'));
  }
}

/** "4:59", "1:05:00" */
export function clock(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  const hrs = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return hrs ? `${hrs}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** "5 мин", "1 ч 30 мин", "45 с" */
export function spell(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s} с`;
  const hrs = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (!hrs) return `${m} мин`;
  return m ? `${hrs} ч ${m} мин` : `${hrs} ч`;
}
