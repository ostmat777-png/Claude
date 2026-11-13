// The settings window. Every control writes straight to the store; the island
// picks the change up at once, there is no "Save" button.

import { h, clear, icon, toggle, segment, paintRange, applyLook, debounce } from './ui.js';
import { HOME_TOOLS } from './tabs/home.js';

const api = window.kaplya;
const content = document.querySelector('#content');
const nav = document.querySelector('#sections');

let data = null;
let sys = { dark: true, helper: false };
let hotkeys = {};
let platform = 'win32';
let section = decodeURIComponent(location.hash.slice(1)) || 'general';

function getPath(key) {
  let node = data;
  for (const p of key.split('.')) node = node == null ? undefined : node[p];
  return node;
}

function setPath(key, value) {
  const parts = key.split('.');
  let node = data;
  for (const p of parts.slice(0, -1)) {
    if (!node[p] || typeof node[p] !== 'object') node[p] = {};
    node = node[p];
  }
  node[parts[parts.length - 1]] = value;
}

function save(key, value) {
  setPath(key, value);
  api.invoke('store:set', key, value);
  applyLook(data.settings, sys.dark);
}

// ------------------------------------------------------------------ building blocks

function row(label, hintText, ...controls) {
  return h('div', { class: 'row' },
    h('div', { class: 'row-text' }, h('div', { text: label }), hintText ? h('div', { class: 'row-hint', text: hintText }) : null),
    h('div', { class: 'row-control' }, controls));
}

const group = (...rows) => h('div', { class: 'group' }, rows);

function toggleRow(key, label, hintText) {
  return row(label, hintText, toggle(getPath(key) !== false && Boolean(getPath(key)), (v) => save(key, v), label));
}

function rangeRow(key, label, hintText, { min, max, step, format }) {
  const value = h('span', { class: 'row-value' });
  const input = h('input', { type: 'range', min, max, step, value: getPath(key), 'aria-label': label });
  const show = () => {
    value.textContent = format(Number(input.value));
    paintRange(input);
  };
  const commit = debounce(() => save(key, Number(input.value)), 120);
  input.addEventListener('input', () => {
    show();
    commit();
  });
  show();
  return row(label, hintText, input, value);
}

function segmentRow(key, label, hintText, options) {
  return row(label, hintText, segment(options, getPath(key), (v) => save(key, v)));
}

function folderRow(key, label, fallbackText, kind) {
  const pathEl = h('span', { class: 'path ellipsis' });
  const show = () => {
    pathEl.textContent = getPath(key) || fallbackText;
    pathEl.title = getPath(key) || '';
  };
  show();
  return row(label, null, pathEl,
    h('button', {
      class: 'btn small',
      text: 'Выбрать…',
      onclick: async () => {
        const dir = await api.invoke('dialog:folder', label);
        if (dir) {
          save(key, dir);
          show();
        }
      },
    }),
    getPath(key) ? h('button', {
      class: 'btn small',
      text: 'Сбросить',
      onclick: () => {
        save(key, '');
        render();
      },
    }) : null,
    h('button', { class: 'ghost', title: 'Открыть папку', onclick: () => api.invoke('open:folder', kind) }, icon('folder-open', 15)));
}

// ------------------------------------------------------------------ sections

const ACCENTS = ['#6cc6ff', '#7ef0c2', '#ffd166', '#ff9f6b', '#ff7eb6', '#c59bff', '#ffffff'];

function general() {
  const custom = h('input', { type: 'color', value: getPath('settings.accent'), title: 'Свой цвет' });
  const swatches = h('div', { class: 'swatches' });
  const paint = () => {
    for (const b of swatches.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.color === getPath('settings.accent')));
  };
  for (const c of ACCENTS) {
    swatches.append(h('button', {
      style: { background: c },
      title: c,
      data: { color: c },
      onclick: () => {
        save('settings.accent', c);
        custom.value = c;
        paint();
      },
    }));
  }
  swatches.append(custom);
  custom.addEventListener('input', debounce(() => {
    save('settings.accent', custom.value);
    paint();
  }, 80));
  paint();

  return [
    group(
      toggleRow('settings.autostart', 'Запускать вместе с Windows', 'Капля будет появляться сразу после входа в систему'),
      toggleRow('settings.expandOnHover', 'Раскрывать при наведении', 'Если выключить, остров раскрывается по щелчку'),
      rangeRow('settings.hoverDelay', 'Задержка перед раскрытием', 'Чтобы остров не выскакивал, когда курсор просто пролетает мимо', { min: 0, max: 600, step: 10, format: (v) => v + ' мс' }),
      toggleRow('settings.hideOnFullscreen', 'Прятать при полном экране', 'Фильм или игра на весь экран: остров уезжает. Подведите курсор к верхнему краю, и он выйдет'),
    ),
    group(
      rangeRow('settings.scale', 'Размер острова', null, { min: 0.8, max: 1.4, step: 0.05, format: (v) => Math.round(v * 100) + '%' }),
      segmentRow('settings.theme', 'Тема острова', null, [['dark', 'Тёмная'], ['light', 'Светлая'], ['system', 'Как в Windows']]),
      row('Цвет акцента', 'Ползунки, значки и выделение', swatches),
    ),
  ];
}

function notifications() {
  return [group(
    toggleRow('settings.showSeconds', 'Секунды на часах', null),
    toggleRow('settings.showWeather', 'Погода в свёрнутом острове', null),
    toggleRow('settings.copyToast', 'Показывать «Скопировано»', 'Остров на секунду показывает, что попало в буфер обмена'),
    toggleRow('settings.trackToast', 'Показывать новый трек', 'Название и обложка, когда начинается следующая песня'),
    toggleRow('settings.lyrics', 'Слова песен', 'Синхронный текст берётся с открытого сервиса LRCLIB. На сервис уходят название и исполнитель трека'),
  )];
}

function weather() {
  const place = getPath('settings.weather.place');
  const input = h('input', { class: 'field', type: 'text', placeholder: 'Название города', spellcheck: false });
  const results = h('div', { class: 'places' });
  const status = h('div', { class: 'row-hint' });
  const choose = (p) => {
    save('settings.weather', { ...getPath('settings.weather'), place: p, askedOnce: true });
    render();
  };
  input.addEventListener('input', debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) return clear(results);
    status.textContent = 'Ищу…';
    const list = await api.invoke('weather:search', q);
    status.textContent = list.length ? '' : 'Ничего не нашлось';
    return clear(results, list.map((p) => h('button', { onclick: () => choose(p) }, icon('map-pin', 14), h('b', { text: p.name }), h('span', { class: 'row-hint ellipsis', text: p.region }))));
  }, 300));

  return [
    group(toggleRow('settings.weather.map', 'Карта погоды', 'Кнопка с картой на вкладке «Погода»: осадки, температура, ветер, давление и снег с Яндекс Погоды. Карта открывается внутри острова')),
    group(row('Сейчас показывается', place ? `${place.lat.toFixed(2)}, ${place.lon.toFixed(2)}` : 'Город не выбран, погода выключена',
      h('b', { text: place ? place.name : '—' }),
      place ? h('button', {
        class: 'btn small',
        text: 'Убрать',
        onclick: () => {
          save('settings.weather', { ...getPath('settings.weather'), place: null, askedOnce: true });
          render();
        },
      }) : null)),
    group(h('div', { class: 'row tall' },
      h('div', { class: 'row-text' }, h('div', { text: 'Выбрать город' }), h('div', { class: 'row-hint', text: 'Прогноз даёт открытый сервис Open-Meteo. Ему уходят только координаты города.' })),
      h('div', { class: 'row-control' }, input, h('button', {
        class: 'btn small',
        title: 'Запрос уйдёт на сайт ipwho.is: он по IP-адресу подскажет ближайший город',
        onclick: async () => {
          status.textContent = 'Определяю…';
          const p = await api.invoke('weather:locate');
          if (p) choose(p);
          else status.textContent = 'Не получилось. Введите город вручную.';
        },
      }, icon('navigation', 13), 'Определить по IP')),
      status, results)),
  ];
}

function capture() {
  const langs = h('select', { class: 'field' }, h('option', { value: '', text: 'Как в Windows' }));
  api.invoke('ocr:langs').then((r) => {
    for (const l of (r && r.langs) || []) langs.append(h('option', { value: l.tag, text: l.name }));
    langs.value = getPath('settings.ocrLang') || '';
  });
  langs.addEventListener('change', () => save('settings.ocrLang', langs.value));

  const engine = getPath('settings.record.engine') === 'obs' ? 'obs' : 'builtin';
  const builtin = group(
    segmentRow('settings.record.format', 'Формат видео', 'MP4 открывается везде', [['mp4', 'MP4'], ['webm', 'WebM']]),
    segmentRow('settings.record.audio', 'Звук в записи', 'Звук компьютера: то, что вы слышите в колонках', [['none', 'Без звука'], ['system', 'Компьютер'], ['mic', 'Микрофон'], ['both', 'Оба']]),
    segmentRow('settings.record.fps', 'Кадров в секунду', null, [[30, '30'], [60, '60']]),
    folderRow('settings.record.dir', 'Папка записей', 'Видео\\Kaplya', 'video'),
  );

  return [
    group(
      toggleRow('settings.screenshots.save', 'Сохранять скриншоты в папку', 'В буфер обмена снимок попадает всегда'),
      folderRow('settings.screenshots.dir', 'Папка скриншотов', 'Изображения\\Kaplya', 'picture'),
    ),
    group(row('Чем записывать экран',
      'Встроенная запись ничего не требует. OBS Studio записывает сама, со своими сценами, звуком и качеством, а остров ею управляет',
      segment([['builtin', 'Встроенная'], ['obs', 'OBS Studio']], engine, (v) => {
        save('settings.record.engine', v);
        render();
      }))),
    engine === 'obs' ? obsGroup() : builtin,
    group(row('Язык распознавания текста', 'Список берётся из языковых пакетов Windows. Чтобы добавить язык: Параметры → Время и язык → Язык', langs)),
  ];
}

const OBS_PROBLEMS = {
  unreachable: 'OBS не отвечает: она закрыта или сервер WebSocket в ней выключен',
  auth: 'Пароль не подошёл',
  timeout: 'OBS не ответила вовремя',
  closed: 'Связь оборвалась',
};

// Everything needed to let the island drive OBS Studio: where it listens, its
// password, and whether the connection works right now.
function obsGroup() {
  const status = h('span', { class: 'status obs-status', text: '…' });
  const say = (res) => {
    status.className = 'status obs-status ' + (res.ok ? 'ok' : 'busy');
    status.textContent = res.ok ? `OBS ${res.version || ''} отвечает`.replace('  ', ' ')
      : res.error === 'auth' && res.hasPassword === false ? 'OBS просит пароль: введите его ниже'
        : OBS_PROBLEMS[res.error] || 'Не получилось связаться с OBS';
  };
  const check = async () => {
    status.className = 'status obs-status';
    status.textContent = 'Проверяю…';
    say(await api.invoke('obs:test'));
  };

  const cfg = () => ({ host: '127.0.0.1', port: 4455, launch: true, ...(getPath('settings.record.obs') || {}) });
  const host = h('input', { class: 'field', type: 'text', value: cfg().host, spellcheck: false, style: { width: '130px' }, 'aria-label': 'Адрес OBS' });
  const port = h('input', { class: 'field', type: 'number', min: 1, max: 65535, value: cfg().port, style: { width: '84px' }, 'aria-label': 'Порт OBS' });
  const saveAddress = () => {
    const p = Math.round(Number(port.value));
    save('settings.record.obs', { ...cfg(), host: host.value.trim() || '127.0.0.1', port: p >= 1 && p <= 65535 ? p : 4455 });
    setTimeout(check, 300);
  };
  host.addEventListener('change', saveAddress);
  port.addEventListener('change', saveAddress);

  const password = h('input', { class: 'field', type: 'password', autocomplete: 'off', placeholder: 'пароль не задан', style: { width: '190px' }, 'aria-label': 'Пароль сервера WebSocket' });
  const savePassword = async () => {
    status.className = 'status obs-status';
    status.textContent = 'Проверяю…';
    say(await api.invoke('obs:setPassword', password.value));
    password.value = '';
    password.placeholder = 'пароль сохранён';
  };
  password.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') savePassword();
  });
  api.invoke('obs:info').then((info) => {
    if (info.hasPassword) password.placeholder = 'пароль сохранён';
    if (info.connected) say({ ok: true, version: info.version });
    else check();
  });

  return group(
    row('Связь с OBS', null, status, h('button', { class: 'btn small', text: 'Проверить', data: { act: 'obs-test' }, onclick: check })),
    row('Пароль сервера WebSocket', 'Хранится на этом компьютере в зашифрованном виде. Если в OBS проверка пароля выключена, оставьте пустым',
      password, h('button', { class: 'btn small', text: 'Сохранить', data: { act: 'obs-password' }, onclick: savePassword })),
    row('Адрес и порт', 'Если OBS на этом же компьютере, менять не нужно', host, port),
    row('Запускать OBS, если она не открыта', 'OBS запустится свёрнутой в трей, запись начнётся, как только она ответит',
      toggle(cfg().launch !== false, (v) => save('settings.record.obs', { ...cfg(), launch: v }), 'Запускать OBS')),
    h('div', { class: 'row tall' }, h('div', { class: 'row-hint obs-help' },
      h('b', { text: 'Как включить в OBS (один раз): ' }),
      'меню «Сервис» (Tools) → «Настройки сервера WebSocket» (WebSocket Server Settings) → поставить галочку «Включить сервер WebSocket» → ',
      '«Показать сведения о подключении» → скопировать пароль в поле выше. ',
      'Что записывать, в каком качестве, с каким звуком и в какую папку, решает OBS: её сцены и её настройки вывода.')),
  );
}

function homeSection() {
  const chosen = new Set(getPath('settings.home.tools') || []);
  const checks = h('div', { class: 'checks' }, Object.entries(HOME_TOOLS).map(([id, t]) => {
    const box = h('input', { type: 'checkbox', checked: chosen.has(id) });
    box.addEventListener('change', () => {
      if (box.checked) chosen.add(id);
      else chosen.delete(id);
      // keep the order the tools are listed in
      save('settings.home.tools', Object.keys(HOME_TOOLS).filter((x) => chosen.has(x)));
    });
    return h('label', { class: 'check', title: t.hint }, box, icon(t.icon, 15), h('span', { text: t.label }));
  }));
  return [
    group(h('div', { class: 'row tall' },
      h('div', { class: 'row-text' }, h('div', { text: 'Кнопки на «Главной»' }), h('div', { class: 'row-hint', text: 'Оставьте только то, чем пользуетесь: остров подстроится по размеру' })),
      checks)),
    group(
      toggleRow('settings.home.showClipboard', 'Недавно скопированное', null),
      toggleRow('settings.home.showVolume', 'Громкость', null),
      toggleRow('settings.home.showApps', 'Строка программ', null),
    ),
  ];
}

const HOTKEYS = [
  ['palette', 'Командная строка', 'Запуск программ, калькулятор, поиск'],
  ['region', 'Скриншот области', null],
  ['ocr', 'Текст с экрана', null],
  ['color', 'Пипетка', null],
  ['record', 'Запись экрана: начать и остановить', null],
];
const STATUS_TEXT = { ok: 'работает', busy: 'занято другой программой', invalid: 'не распознано', off: 'выключено' };

/** A keyboard event as an accelerator string such as "Ctrl+Alt+S", or '' while only modifiers are down. */
function accelerator(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  let key = '';
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) key = c.slice(3);
  else if (/^Digit\d$/.test(c)) key = c.slice(5);
  else if (/^F\d{1,2}$/.test(c)) key = c;
  else if (/^Numpad\d$/.test(c)) key = 'num' + c.slice(6);
  else {
    key = {
      Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
      Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', PrintScreen: 'PrintScreen', Insert: 'Insert',
      Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    }[c] || '';
  }
  if (!key) return '';
  // a bare letter would eat ordinary typing; function keys may stand alone
  if (!mods.length && !/^F\d{1,2}$|^PrintScreen$/.test(key)) return '';
  return [...mods, key].join('+');
}

function hotkeySection() {
  const rows = HOTKEYS.map(([name, label, hintText]) => {
    const key = 'settings.hotkeys.' + name;
    const st = hotkeys[name] || 'off';
    const input = h('input', { class: 'field hotkey', readOnly: true, value: getPath(key) || 'нет', title: 'Щёлкните и нажмите сочетание. Backspace: убрать' });
    input.addEventListener('focus', () => {
      input.classList.add('capturing');
      input.value = 'нажмите сочетание…';
    });
    input.addEventListener('blur', () => {
      input.classList.remove('capturing');
      input.value = getPath(key) || 'нет';
    });
    input.addEventListener('keydown', (e) => {
      e.preventDefault();
      if (e.key === 'Escape') return input.blur();
      if (e.key === 'Backspace' || e.key === 'Delete') {
        save(key, '');
        return input.blur();
      }
      const acc = accelerator(e);
      if (!acc) return undefined;
      save(key, acc);
      return input.blur();
    });
    return row(label, hintText, h('span', { class: 'status ' + st, data: { hotkey: name }, text: STATUS_TEXT[st] || '' }), input);
  });
  return [
    group(rows),
    h('p', { class: 'row-hint', text: 'Если сочетание занято другой программой (например, Alt+Space у PowerToys), выберите другое.' }),
  ];
}

function misc() {
  const custom = h('input', { class: 'field', type: 'text', placeholder: 'https://…', value: getPath('settings.chat.custom') || '', spellcheck: false, style: { width: '260px' } });
  custom.addEventListener('change', () => save('settings.chat', { ...getPath('settings.chat'), custom: custom.value.trim() }));
  return [
    group(
      rangeRow('settings.clipboard.limit', 'Сколько записей помнить', 'История живёт только в памяти и пропадает при выходе из Капли', { min: 20, max: 200, step: 10, format: (v) => String(v) }),
      toggleRow('settings.clipboard.images', 'Запоминать картинки', null),
    ),
    group(
      segmentRow('settings.search', 'Поиск и перевод', 'Куда отправлять запрос из командной строки и кнопку «Перевести»', [['google', 'Google'], ['yandex', 'Яндекс'], ['duckduckgo', 'DuckDuckGo']]),
      row('Свой чат', 'Адрес сайта, который появится во вкладке «Чат» рядом с остальными', custom),
    ),
  ];
}

function about() {
  return [h('div', { class: 'group about' },
    h('p', {}, h('b', { text: 'Капля ' + (data.version || '') }), ' — островок в верхней части экрана: музыка, буфер обмена, скриншоты, погода и быстрые переключатели.'),
    h('p', { text: 'Что уходит в интернет: координаты города на Open-Meteo (погода); название и исполнитель трека на LRCLIB (слова песен, можно выключить); запрос на ipwho.is, только если нажать «Определить по IP». Вкладка «Чат» открывает сайты ассистентов как обычный браузер. Больше ничего: ни статистики, ни учётных записей.' }),
    h('p', { text: 'Буфер обмена никуда не отправляется и не пишется на диск.' }),
    h('p', { text: 'Использованы: Electron (MIT), значки Lucide (ISC), jsQR (Apache-2.0).' }),
    h('div', { class: 'row-control' },
      h('button', { class: 'btn', onclick: () => api.invoke('open:folder', 'picture') }, icon('folder-open', 14), 'Папка скриншотов'),
      h('button', { class: 'btn danger', onclick: () => api.invoke('app:quit') }, icon('log-out', 14), 'Закрыть Каплю')))];
}

const SECTIONS = [
  { id: 'general', title: 'Общие', icon: 'settings', lead: 'Как остров ведёт себя и выглядит.', build: general },
  { id: 'notifications', title: 'Уведомления', icon: 'bell', lead: 'Что показывает свёрнутый остров.', build: notifications },
  { id: 'weather', title: 'Погода', icon: 'cloud-sun', lead: 'Город для прогноза.', build: weather },
  { id: 'capture', title: 'Скриншоты и запись', icon: 'crop', lead: 'Куда сохранять и как записывать.', build: capture },
  { id: 'home', title: 'Главная', icon: 'house', lead: 'Соберите первую вкладку под себя.', build: homeSection },
  { id: 'hotkeys', title: 'Горячие клавиши', icon: 'keyboard', lead: 'Работают в любой программе.', build: hotkeySection },
  { id: 'misc', title: 'Буфер, поиск, чат', icon: 'clipboard-list', lead: null, build: misc },
  { id: 'about', title: 'О программе', icon: 'info', lead: null, build: about },
];

function render() {
  const cur = SECTIONS.find((s) => s.id === section) || SECTIONS[0];
  clear(nav, SECTIONS.map((s) => h('button', {
    'aria-current': String(s.id === cur.id),
    data: { section: s.id },
    onclick: () => {
      section = s.id;
      render();
      content.scrollTop = 0;
    },
  }, icon(s.icon, 16), s.title)));
  clear(content, h('h1', { text: cur.title }), cur.lead ? h('p', { class: 'lead', text: cur.lead }) : null, cur.build());
}

async function boot() {
  const init = await api.invoke('app:init');
  data = init.data;
  data.version = init.version;
  sys = init.system;
  hotkeys = init.hotkeys || {};
  platform = init.platform;
  document.querySelector('#version').textContent = 'версия ' + init.version + (platform === 'win32' ? '' : ' · не Windows');
  applyLook(data.settings, sys.dark);
  render();

  api.on('hotkeys:status', (s) => {
    hotkeys = s;
    if (section === 'hotkeys') render();
  });
  api.on('sys:theme', (dark) => {
    sys.dark = dark;
    applyLook(data.settings, dark);
  });
  api.on('store:changed', (key, value) => {
    if (JSON.stringify(getPath(key)) === JSON.stringify(value)) return;
    setPath(key, value);
    applyLook(data.settings, sys.dark);
    // a change made elsewhere (the tray menu, the island): show it
    if (!document.activeElement || document.activeElement === document.body) render();
  });
  api.on('obs:state', (s) => {
    const el = document.querySelector('.obs-status');
    if (!el || !s.connected) return;
    el.className = 'status obs-status ok';
    el.textContent = `OBS ${s.version || ''} отвечает`.replace('  ', ' ') + (s.recording ? ' · идёт запись' : '');
  });
  api.on('settings:section', (id) => {
    section = id;
    render();
  });
  document.documentElement.dataset.ready = 'true';
}

boot();
