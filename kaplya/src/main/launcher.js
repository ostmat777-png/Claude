'use strict';
// The command line (Alt+Space): programs from the Start menu, a calculator,
// the island's own actions, and a web search as the last line.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SKIP = /uninstall|удал(ить|ение)|readme|license|лиценз|changelog|release notes|документац|справка|^help$|website|веб-сайт/i;

const SEARCH = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=' },
  yandex: { name: 'Яндекс', url: 'https://yandex.ru/search/?text=' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
};

// Actions the island can do itself. `run` is interpreted in main.js.
const ACTIONS = [
  { id: 'region', title: 'Скриншот области', keys: 'скриншот область снимок screenshot region', icon: 'crop' },
  { id: 'screen', title: 'Скриншот всего экрана', keys: 'скриншот экран весь снимок screenshot full', icon: 'monitor' },
  { id: 'ocr', title: 'Текст с экрана', keys: 'текст распознать ocr text', icon: 'scan-text' },
  { id: 'qr', title: 'Прочитать QR-код', keys: 'qr код куар', icon: 'qr-code' },
  { id: 'color', title: 'Пипетка: цвет с экрана', keys: 'пипетка цвет color picker', icon: 'pipette' },
  { id: 'record', title: 'Запись экрана', keys: 'запись видео record video', icon: 'video' },
  { id: 'plain', title: 'Очистить форматирование в буфере', keys: 'чистый текст формат plain', icon: 'eraser' },
  { id: 'theme', title: 'Переключить тёмную / светлую тему', keys: 'тема темная светлая dark light theme', icon: 'sun-moon' },
  { id: 'lock', title: 'Заблокировать компьютер', keys: 'блокировка заблокировать lock', icon: 'lock' },
  { id: 'sleep', title: 'Спящий режим', keys: 'сон спать sleep', icon: 'moon-star' },
  { id: 'restart', title: 'Перезагрузить компьютер', keys: 'перезагрузка перезагрузить restart reboot', icon: 'rotate-cw', confirm: true },
  { id: 'shutdown', title: 'Выключить компьютер', keys: 'выключить выключение shutdown', icon: 'power', confirm: true },
  { id: 'settings', title: 'Настройки Капли', keys: 'настройки параметры settings', icon: 'settings' },
  { id: 'quit', title: 'Закрыть Каплю', keys: 'выход закрыть quit exit', icon: 'log-out' },
];

class Launcher {
  constructor({ helper, shared, getFileIcon }) {
    this.helper = helper;
    this.shared = shared; // { fuzzy, calc, remind }
    this.getFileIcon = getFileIcon;
    this.apps = [];
    this.icons = new Map();
    this.loadedAt = 0;
    this.loading = null;
  }

  startMenuDirs() {
    const dirs = [];
    if (process.env.ProgramData) dirs.push(path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
    return dirs;
  }

  async scanShortcuts(dir, depth = 0, out = []) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 4) await this.scanShortcuts(full, depth + 1, out);
      } else if (/\.(lnk|appref-ms)$/i.test(e.name)) {
        const name = e.name.replace(/\.(lnk|appref-ms)$/i, '');
        if (!SKIP.test(name)) out.push({ name, kind: 'file', target: full });
      }
    }
    return out;
  }

  /** Builds the list of programs; cheap to call often, rescans every few minutes. */
  refresh(force = false) {
    if (this.loading) return this.loading;
    if (!force && this.loadedAt && Date.now() - this.loadedAt < 5 * 60000) return Promise.resolve();
    this.loading = (async () => {
      const byName = new Map();
      for (const dir of this.startMenuDirs()) {
        for (const app of await this.scanShortcuts(dir)) {
          const key = app.name.toLowerCase();
          if (!byName.has(key)) byName.set(key, app);
        }
      }
      // Store apps (Settings, Calculator, Photos...) have no shortcut files.
      const extra = await this.helper.tryCall('apps.list', {}, null, 20000);
      for (const a of (extra && extra.apps) || []) {
        if (!a.name || !a.id || SKIP.test(a.name)) continue;
        const key = a.name.toLowerCase();
        if (!byName.has(key)) byName.set(key, { name: a.name, kind: 'appid', target: a.id });
      }
      this.apps = [...byName.values()];
      this.loadedAt = Date.now();
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  async iconFor(app) {
    if (app.kind !== 'file' || !this.getFileIcon) return null;
    if (this.icons.has(app.target)) return this.icons.get(app.target);
    let url = null;
    try {
      const img = await this.getFileIcon(app.target);
      if (img && !img.isEmpty()) url = img.toDataURL();
    } catch {}
    this.icons.set(app.target, url);
    return url;
  }

  /** @returns {Promise<object[]>} rows for the command line */
  async query(text, opts = {}) {
    const q = String(text || '').trim();
    const { rank } = this.shared.fuzzy;
    const rows = [];
    if (!q) {
      return ACTIONS.slice(0, 7).map((a) => ({ type: 'action', id: a.id, title: a.title, icon: a.icon, confirm: Boolean(a.confirm) }));
    }

    const value = this.shared.calc.calculate(q);
    if (value !== null) {
      const shown = this.shared.calc.formatNumber(value);
      rows.push({ type: 'calc', title: shown, subtitle: 'Enter: скопировать результат', icon: 'calculator', copy: String(Number(value.toPrecision(12))) });
    }

    // "таймер 5", "timer 10"
    const timer = /^(?:таймер|timer|т)\s+(\d{1,3})(?:\s*(?:м|мин|минут[аы]?|m|min))?$/i.exec(q);
    if (timer) rows.push({ type: 'timer', minutes: Number(timer[1]), title: `Таймер на ${timer[1]} мин`, icon: 'timer' });

    const remind = this.shared.remind.parseReminder(q);
    if (remind && remind.text !== 'Напоминание' && /напомни|remind|через|завтра|сегодня|\bв\s+\d/i.test(q)) {
      rows.push({ type: 'remind', at: remind.at, text: remind.text, title: 'Напомнить: ' + remind.text, subtitle: this.shared.remind.describeTime(remind.at), icon: 'bell' });
    }

    if (/^(https?:\/\/|www\.)\S+$/i.test(q) || /^[\w-]+(\.[\w-]+)*\.(ru|com|org|net|io|dev|рф|app|me|tv|su)(\/\S*)?$/i.test(q)) {
      rows.push({ type: 'url', url: /^https?:/i.test(q) ? q : 'https://' + q, title: 'Открыть ' + q, icon: 'globe' });
    }

    await this.refresh();
    const apps = rank(this.apps, q, (a) => a.name, 6);
    for (const app of apps) {
      rows.push({ type: 'app', title: app.name, subtitle: 'Программа', icon: 'app-window', kind: app.kind, target: app.target, image: await this.iconFor(app) });
    }

    const acts = rank(ACTIONS, q, (a) => a.title + ' ' + a.keys, 4);
    for (const a of acts) rows.push({ type: 'action', id: a.id, title: a.title, icon: a.icon, confirm: Boolean(a.confirm) });

    const engine = SEARCH[opts.search] || SEARCH.google;
    rows.push({ type: 'url', url: engine.url + encodeURIComponent(q), title: `Искать «${q}»`, subtitle: engine.name, icon: 'search' });
    return rows.slice(0, 9);
  }

  /** Starts a program found by query(). Only things from our own list can be started. */
  openApp(kind, target) {
    const app = this.apps.find((a) => a.kind === kind && a.target === target);
    if (!app) return false;
    if (app.kind === 'file') return { path: app.target };
    try {
      spawn('explorer.exe', ['shell:AppsFolder\\' + app.target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { Launcher, ACTIONS, SEARCH };
