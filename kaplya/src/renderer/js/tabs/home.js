// Главная: what is playing, the last copied things, quick tools, volume, programs.

import { h, clear, icon, paintRange, throttle } from '../ui.js';
import { createPlayer } from './home-player.js';
import { createApps } from './home-apps.js';

export const HOME_TOOLS = {
  region: { label: 'Область', icon: 'crop', hint: 'Скриншот области: можно рисовать стрелки, рамки и текст' },
  screen: { label: 'Весь экран', icon: 'monitor', hint: 'Скриншот всего экрана сразу в буфер' },
  ocr: { label: 'Текст с экрана', icon: 'scan-text', hint: 'Выделите область, текст из неё попадёт в буфер' },
  qr: { label: 'QR-код', icon: 'qr-code', hint: 'Прочитать QR-код с экрана' },
  color: { label: 'Пипетка', icon: 'pipette', hint: 'Взять цвет любой точки экрана' },
  plain: { label: 'Чистый текст', icon: 'eraser', hint: 'Убрать форматирование из скопированного' },
  record: { label: 'Запись экрана', icon: 'video', hint: 'Записать экран или его часть в видео' },
  command: { label: 'Команда', icon: 'search', hint: 'Запуск программ, калькулятор, поиск' },
};

const CLIP_ICONS = { link: 'link', color: 'pipette', mail: 'at-sign', image: 'image', text: 'type' };

export default {
  id: 'home',
  title: 'Главная',
  icon: 'house',
  width: 700,

  mount(root, app) {
    const { api } = app;
    let visible = false;
    const resized = () => {
      if (!visible) return;
      paintClips();
      app.relayout();
    };
    const player = createPlayer(app, { resized });
    const apps = createApps(app, { resized });

    // ---------------------------------------------------------------- recent clipboard
    const clipList = h('div', { class: 'recent-list' });
    const recent = h('div', { class: 'recent card' },
      h('div', { class: 'recent-head' },
        h('span', { class: 'label', text: 'Недавно скопировано' }),
        h('span', { class: 'grow' }),
        h('button', { class: 'ghost', title: 'Вся история', onclick: () => app.openTab('clipboard') }, icon('chevron-right', 15))),
      clipList);

    function paintClips() {
      // while the player is opened up (all the words, the liked list) it needs the room
      recent.hidden = app.settings.home.showClipboard === false || player.expanded();
      const max = player.visible() ? 2 : 4;
      const items = app.clips.slice(0, max);
      clear(clipList);
      if (!items.length) {
        clipList.append(h('div', { class: 'recent-empty faint', text: 'Скопируйте что-нибудь: текст, ссылку или картинку появятся здесь.' }));
        return;
      }
      for (const item of items) {
        const row = h('button', {
          class: 'recent-row',
          title: 'Скопировать снова',
          onclick: async () => {
            await api.invoke('clip:copy', item.id);
            row.classList.add('done');
            setTimeout(() => row.classList.remove('done'), 900);
          },
        },
        item.kind === 'image'
          ? h('img', { class: 'recent-thumb', src: item.thumb, alt: '' })
          : h('span', { class: 'recent-icon' }, icon(CLIP_ICONS[item.kind] || 'type', 14)),
        h('span', { class: 'ellipsis', text: item.kind === 'image' ? `Изображение ${item.width}×${item.height}` : item.text.replace(/\s+/g, ' ').trim() }),
        h('span', { class: 'grow' }),
        h('span', { class: 'recent-check' }, icon('check', 14)));
        clipList.append(row);
      }
    }

    // ---------------------------------------------------------------- tools
    const tools = h('div', { class: 'tools' });

    function paintTools() {
      clear(tools);
      const ids = (app.settings.home.tools || []).filter((id) => HOME_TOOLS[id]);
      for (const id of ids) {
        const t = HOME_TOOLS[id];
        const recording = id === 'record' && app.recording;
        tools.append(h('button', {
          class: 'tool' + (recording ? ' live' : ''),
          title: t.hint,
          data: { tool: id },
          onclick: () => api.invoke('action', id),
        }, icon(recording ? 'circle-stop' : t.icon, 17), h('span', { text: recording ? 'Остановить запись' : t.label })));
      }
      tools.hidden = !ids.length;
    }

    // ---------------------------------------------------------------- volume
    const volIcon = h('button', { class: 'ghost', title: 'Выключить / включить звук' });
    const volRange = h('input', { type: 'range', min: 0, max: 100, value: 0, 'aria-label': 'Громкость' });
    const volValue = h('span', { class: 'vol-value' });
    const volume = h('div', { class: 'volume card' }, volIcon, volRange, volValue);
    let volDragging = false;
    const sendVolume = throttle((level) => api.invoke('volume:set', { level }), 60);

    function paintVolume() {
      const v = app.sys.volume;
      volume.hidden = !v.available || app.settings.home.showVolume === false;
      if (volume.hidden) return;
      if (!volDragging) volRange.value = Math.round(v.level * 100);
      paintRange(volRange);
      const pct = Number(volRange.value);
      volValue.textContent = v.muted ? 'выкл' : pct + '%';
      clear(volIcon, icon(v.muted || pct === 0 ? 'volume-x' : pct < 50 ? 'volume-1' : 'volume-2', 16));
    }
    volIcon.addEventListener('click', () => api.invoke('volume:set', { muted: !app.sys.volume.muted }));
    volRange.addEventListener('input', () => {
      volDragging = true;
      paintRange(volRange);
      volValue.textContent = volRange.value + '%';
      sendVolume(Number(volRange.value) / 100);
    });
    volRange.addEventListener('change', () => {
      setTimeout(() => {
        volDragging = false;
      }, 400);
    });

    const left = h('div', { class: 'home-left' }, player.el, recent);
    root.append(h('div', { class: 'home-top' }, left, tools), volume, apps.el);

    app.on('media', () => visible && paintClips());
    app.on('clips', () => visible && paintClips());
    app.on('volume', () => visible && paintVolume());
    app.on('recording', () => paintTools());
    app.on('store', (key) => {
      if (!visible) return;
      if (key.startsWith('settings.home')) {
        paintTools();
        paintClips();
        paintVolume();
        app.relayout();
      }
    });

    return {
      show() {
        visible = true;
        player.show();
        apps.show();
        paintClips();
        paintTools();
        paintVolume();
      },
      hide() {
        visible = false;
        player.hide();
      },
    };
  },
};
