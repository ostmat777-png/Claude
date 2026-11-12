// Главная: what is playing, the last copied things, quick tools, volume, programs.

import { h, clear, icon, paintRange, throttle } from '../ui.js';
import { formatTime, lineAt } from '../../shared/lrc.mjs';

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
    let progressTimer = 0;
    let seeking = false;
    let lyrics = { key: null, lines: [] };
    const iconCache = new Map();

    // ---------------------------------------------------------------- player
    const cover = h('img', { class: 'player-cover', alt: '' });
    const coverBlank = h('div', { class: 'player-cover blank' }, icon('music', 26));
    const glow = h('div', { class: 'player-glow' });
    const title = h('div', { class: 'player-title ellipsis' });
    const artist = h('div', { class: 'player-artist ellipsis' });
    const bar = h('input', { type: 'range', class: 'player-bar', min: 0, max: 1000, value: 0, 'aria-label': 'Позиция в треке' });
    const timeNow = h('span', { text: '0:00' });
    const timeAll = h('span', { text: '' });
    const btnPrev = h('button', { class: 'ghost', title: 'Предыдущий', onclick: () => api.invoke('media:cmd', 'prev') }, icon('skip-back', 17));
    const btnPlay = h('button', { class: 'player-play', title: 'Пауза / играть', onclick: () => api.invoke('media:cmd', 'toggle') });
    const btnNext = h('button', { class: 'ghost', title: 'Следующий', onclick: () => api.invoke('media:cmd', 'next') }, icon('skip-forward', 17));
    const lineNow = h('div', { class: 'lyric now' });
    const lineNext = h('div', { class: 'lyric next' });
    const lyricBox = h('div', { class: 'player-lyrics', hidden: true }, lineNow, lineNext, h('span', { class: 'lyric-source', text: 'LRCLIB' }));
    const player = h('div', { class: 'player card', hidden: true },
      glow,
      h('div', { class: 'player-row' },
        h('div', { class: 'player-art' }, cover, coverBlank),
        h('div', { class: 'player-meta' },
          title, artist,
          h('div', { class: 'player-controls' }, btnPrev, btnPlay, btnNext),
          h('div', { class: 'player-progress' }, timeNow, bar, timeAll))),
      lyricBox);

    bar.addEventListener('input', () => {
      seeking = true;
      paintRange(bar);
      const m = app.sys.media;
      if (m && m.duration) timeNow.textContent = formatTime((bar.value / 1000) * m.duration);
    });
    bar.addEventListener('change', async () => {
      const m = app.sys.media;
      if (m && m.duration) await api.invoke('media:cmd', 'seek', (bar.value / 1000) * m.duration);
      setTimeout(() => {
        seeking = false;
      }, 600);
    });

    function position(m) {
      const p = m.position + (m.playing ? (Date.now() - m.at) / 1000 : 0);
      return m.duration ? Math.min(p, m.duration) : p;
    }

    function paintProgress() {
      const m = app.sys.media;
      if (!m) return;
      const pos = position(m);
      if (!seeking) {
        bar.value = m.duration ? Math.round((pos / m.duration) * 1000) : 0;
        paintRange(bar);
        timeNow.textContent = formatTime(pos);
      }
      if (lyrics.key === m.key && lyrics.lines.length) {
        const i = lineAt(lyrics.lines, pos + 0.25);
        const now = i >= 0 ? lyrics.lines[i].text : '';
        const next = lyrics.lines[i + 1] ? lyrics.lines[i + 1].text : '';
        if (lineNow.textContent !== (now || '♪')) lineNow.textContent = now || '♪';
        if (lineNext.textContent !== next) lineNext.textContent = next;
      }
    }

    async function loadLyrics(m) {
      lyrics = { key: m.key, lines: [] };
      lyricBox.hidden = true;
      if (app.settings.lyrics === false) return;
      const res = await api.invoke('lyrics:get', { title: m.title, artist: m.artist, album: m.album, duration: m.duration });
      if (!app.sys.media || app.sys.media.key !== m.key) return; // the track changed while we waited
      if (res && res.synced && res.synced.length) {
        lyrics = { key: m.key, lines: res.synced };
        lyricBox.hidden = false;
        paintProgress();
        app.relayout();
      }
    }

    function paintPlayer() {
      const m = app.sys.media;
      const had = !player.hidden;
      player.hidden = !m;
      if (!m) {
        if (had) {
          paintClips();
          app.relayout();
        }
        return;
      }
      title.textContent = m.title || 'Без названия';
      artist.textContent = m.artist || m.app.replace(/\.exe$/i, '').replace(/^.*[!.]/, '') || '';
      cover.hidden = !m.cover;
      coverBlank.hidden = Boolean(m.cover);
      if (m.cover && cover.src !== m.cover) cover.src = m.cover;
      glow.style.backgroundImage = m.cover ? `url("${m.cover}")` : 'none';
      clear(btnPlay, icon(m.playing ? 'pause' : 'play', 17, 2.4));
      btnPrev.disabled = !m.canPrev;
      btnNext.disabled = !m.canNext;
      bar.disabled = !m.canSeek || !m.duration;
      timeAll.textContent = m.duration ? formatTime(m.duration) : '';
      if (lyrics.key !== m.key) loadLyrics(m);
      paintProgress();
      if (!had) {
        paintClips();
        app.relayout();
      }
    }

    // ---------------------------------------------------------------- recent clipboard
    const clipList = h('div', { class: 'recent-list' });
    const recent = h('div', { class: 'recent card' },
      h('div', { class: 'recent-head' },
        h('span', { class: 'label', text: 'Недавно скопировано' }),
        h('span', { class: 'grow' }),
        h('button', { class: 'ghost', title: 'Вся история', onclick: () => app.openTab('clipboard') }, icon('chevron-right', 15))),
      clipList);

    function paintClips() {
      recent.hidden = app.settings.home.showClipboard === false;
      const max = app.sys.media ? 2 : 4;
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

    // ---------------------------------------------------------------- programs
    const apps = h('div', { class: 'apps card' });

    async function appIcon(file) {
      if (!iconCache.has(file)) iconCache.set(file, api.invoke('file:icon', file).catch(() => null));
      return iconCache.get(file);
    }

    function paintApps() {
      apps.hidden = app.settings.home.showApps === false;
      clear(apps);
      for (const a of app.data.apps || []) {
        const img = h('img', { alt: '' });
        const blank = icon('app-window', 20);
        const btn = h('button', {
          class: 'app',
          title: a.name,
          onclick: async () => {
            const ok = await api.invoke('apps:open', a.path);
            if (!ok) app.toast({ type: 'error', title: 'Не получилось открыть', text: a.name });
            else app.collapse();
          },
        }, blank, h('span', {
          class: 'app-remove',
          title: 'Убрать с острова',
          onclick: (e) => {
            e.stopPropagation();
            app.set('apps', (app.data.apps || []).filter((x) => x.path !== a.path));
          },
        }, icon('x', 9, 3)));
        appIcon(a.path).then((url) => {
          if (!url) return;
          img.src = url;
          blank.replaceWith(img);
        });
        apps.append(btn);
      }
      apps.append(h('button', {
        class: 'app add',
        title: 'Добавить программу',
        onclick: async () => {
          const list = await api.invoke('apps:pick');
          if (list) {
            app.data.apps = list;
            paintApps();
            app.relayout();
          }
        },
      }, icon('plus', 16)));
      if (!(app.data.apps || []).length) apps.append(h('span', { class: 'faint apps-hint', text: 'Добавьте сюда программы, которые открываете чаще всего' }));
    }

    const left = h('div', { class: 'home-left' }, player, recent);
    root.append(h('div', { class: 'home-top' }, left, tools), volume, apps);

    app.on('media', () => visible && paintPlayer());
    app.on('clips', () => visible && paintClips());
    app.on('volume', () => visible && paintVolume());
    app.on('recording', () => paintTools());
    app.on('store', (key) => {
      if (!visible) return;
      if (key.startsWith('settings.home')) {
        paintTools();
        paintClips();
        paintVolume();
        paintApps();
        app.relayout();
      }
      if (key === 'apps') {
        paintApps();
        app.relayout();
      }
    });

    return {
      show() {
        visible = true;
        paintPlayer();
        paintClips();
        paintTools();
        paintVolume();
        paintApps();
        clearInterval(progressTimer);
        progressTimer = setInterval(paintProgress, 400);
      },
      hide() {
        visible = false;
        clearInterval(progressTimer);
      },
    };
  },
};
