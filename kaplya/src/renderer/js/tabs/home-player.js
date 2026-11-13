// The player on the home tab: what is playing (a program or a site in a browser),
// its cover, controls, the song's words, and the "liked" list.

import { h, clear, icon, paintRange } from '../ui.js';
import { appLabel, musicSearchUrl } from '../common.js';
import { formatTime, lineAt } from '../../shared/lrc.mjs';

const likeKey = (m) => `${m.artist || ''}|${m.title || ''}`.toLowerCase();

/**
 * @param {object} app      the island's shared state
 * @param {object} hooks
 * @param {() => void} hooks.resized   the player changed height
 * @returns {{ el: HTMLElement, show(): void, hide(): void, visible(): boolean, expanded(): boolean }}
 */
export function createPlayer(app, hooks) {
  const { api } = app;
  let shown = false;
  let timer = 0;
  let sessionsTimer = 0;
  let seeking = false;
  let stage = 'none'; // none | lyrics | likes
  let lyrics = { key: null, lines: [], plain: '' };
  let lineIndex = -2;
  let sessions = [];

  // ---------------------------------------------------------------- the top row
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
  const btnLike = h('button', { class: 'ghost player-like', onclick: () => toggleLike() }, icon('heart', 16));
  const likeCount = h('span', { class: 'like-count' });
  const btnLikes = h('button', { class: 'ghost player-likes', title: 'Что мне понравилось', onclick: () => setStage(stage === 'likes' ? 'none' : 'likes') }, icon('list-music', 16), likeCount);
  const sources = h('div', { class: 'player-sources', hidden: true });

  // ---------------------------------------------------------------- words of the song, two lines
  const lineNow = h('div', { class: 'lyric now' });
  const lineNext = h('div', { class: 'lyric next' });
  const teaser = h('button', { class: 'player-lyrics', hidden: true, title: 'Показать весь текст', onclick: () => setStage('lyrics') },
    lineNow, lineNext, h('span', { class: 'lyric-source', text: 'LRCLIB' }));

  // ---------------------------------------------------------------- the part that opens: all the words, or the liked list
  const stageEl = h('div', { class: 'player-stage', hidden: true });

  const el = h('div', { class: 'player card', hidden: true },
    glow,
    h('div', { class: 'player-row' },
      h('div', { class: 'player-art' }, cover, coverBlank),
      h('div', { class: 'player-meta' },
        title, artist,
        h('div', { class: 'player-controls' }, btnPrev, btnPlay, btnNext, h('span', { class: 'grow' }), btnLike, btnLikes),
        h('div', { class: 'player-progress' }, timeNow, bar, timeAll))),
    sources, teaser, stageEl);

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

  // ---------------------------------------------------------------- liked tracks
  const likes = () => (Array.isArray(app.data.likes) ? app.data.likes : []);
  const isLiked = (m) => Boolean(m) && likes().some((x) => x.key === likeKey(m));

  function toggleLike() {
    const m = app.sys.media;
    if (!m) return;
    const key = likeKey(m);
    const list = likes();
    if (list.some((x) => x.key === key)) app.set('likes', list.filter((x) => x.key !== key));
    else app.set('likes', [{ key, title: m.title, artist: m.artist, album: m.album, app: m.app, at: Date.now() }, ...list].slice(0, 500));
    paintLike();
    if (stage === 'likes') paintStage();
  }

  function paintLike() {
    const liked = isLiked(app.sys.media);
    btnLike.classList.toggle('on', liked);
    btnLike.title = liked ? 'Убрать из понравившихся' : 'Нравится: запомнить этот трек';
    btnLike.setAttribute('aria-pressed', String(liked));
    likeCount.textContent = likes().length ? String(likes().length) : '';
  }

  // ---------------------------------------------------------------- stage
  function setStage(next) {
    if (next === 'lyrics' && !lyrics.lines.length && !lyrics.plain) next = 'none';
    stage = next;
    lineIndex = -2;
    paintStage();
    hooks.resized();
  }

  function stageHead(label, note) {
    return h('div', { class: 'stage-head' },
      h('span', { class: 'label', text: label }),
      note ? h('span', { class: 'faint stage-note', text: note }) : null,
      h('span', { class: 'grow' }),
      h('button', { class: 'ghost', title: 'Свернуть', onclick: () => setStage('none') }, icon('chevron-up', 15)));
  }

  function paintStage() {
    stageEl.hidden = stage === 'none';
    teaser.hidden = stage !== 'none' || !(lyrics.lines.length || lyrics.plain) || lyrics.key !== (app.sys.media && app.sys.media.key);
    btnLikes.classList.toggle('on', stage === 'likes');
    el.classList.toggle('open', stage !== 'none');
    if (stage === 'none') {
      clear(stageEl);
      return;
    }
    if (stage === 'lyrics') {
      const m = app.sys.media;
      const synced = lyrics.lines.length > 0;
      const box = h('div', { class: 'lyrics-full' + (synced ? '' : ' plain') });
      if (synced) {
        lyrics.lines.forEach((line, i) => {
          box.append(h('div', {
            class: 'lline',
            data: { i: String(i) },
            text: line.text || '♪',
            title: m && m.canSeek ? 'Перейти к этой строке' : '',
            onclick: () => {
              if (m && m.canSeek) api.invoke('media:cmd', 'seek', line.t);
            },
          }));
        });
      } else {
        box.textContent = lyrics.plain;
      }
      clear(stageEl, stageHead('Текст песни', synced ? 'щёлкните строку, чтобы перейти к ней' : 'без привязки ко времени'), box,
        h('span', { class: 'lyric-source', text: 'LRCLIB' }));
      paintProgress();
      return;
    }
    // liked list
    const list = likes();
    const box = h('div', { class: 'likes-list' });
    if (!list.length) {
      box.append(h('div', { class: 'likes-empty faint' },
        'Нажмите на сердечко у трека, и он появится здесь. ',
        'Лайк хранится в Капле: поставить его в самом сервисе Windows программам не позволяет.'));
    }
    for (const item of list) {
      box.append(h('div', { class: 'like' },
        icon('heart', 13),
        h('div', { class: 'like-body' },
          h('div', { class: 'ellipsis', text: item.title || 'Без названия' }),
          h('div', { class: 'faint ellipsis', text: [item.artist, appLabel(item.app)].filter(Boolean).join(' · ') })),
        h('button', {
          class: 'ghost',
          title: 'Найти в музыкальном сервисе',
          onclick: () => api.invoke('open:external', musicSearchUrl(app.settings.musicSearch, `${item.artist} ${item.title}`.trim())),
        }, icon('search', 14)),
        h('button', {
          class: 'ghost',
          title: 'Скопировать «исполнитель — название»',
          onclick: () => api.invoke('clip:write', [item.artist, item.title].filter(Boolean).join(' — ')),
        }, icon('copy', 14)),
        h('button', {
          class: 'ghost',
          title: 'Убрать',
          onclick: () => {
            app.set('likes', likes().filter((x) => x.key !== item.key));
            paintLike();
            paintStage();
            hooks.resized();
          },
        }, icon('x', 14))));
    }
    clear(stageEl, stageHead('Нравится', list.length ? String(list.length) : ''), box);
  }

  // ---------------------------------------------------------------- progress and the current line
  function paintProgress() {
    const m = app.sys.media;
    if (!m) return;
    const pos = position(m);
    if (!seeking) {
      bar.value = m.duration ? Math.round((pos / m.duration) * 1000) : 0;
      paintRange(bar);
      timeNow.textContent = formatTime(pos);
    }
    if (lyrics.key !== m.key || !lyrics.lines.length) return;
    const i = lineAt(lyrics.lines, pos + 0.25);
    if (stage === 'none') {
      const now = i >= 0 ? lyrics.lines[i].text : '';
      const next = lyrics.lines[i + 1] ? lyrics.lines[i + 1].text : '';
      if (lineNow.textContent !== (now || '♪')) lineNow.textContent = now || '♪';
      if (lineNext.textContent !== next) lineNext.textContent = next;
    } else if (stage === 'lyrics' && i !== lineIndex) {
      lineIndex = i;
      const box = stageEl.querySelector('.lyrics-full');
      if (!box) return;
      for (const node of box.children) node.classList.toggle('now', Number(node.dataset.i) === i);
      const cur = box.children[Math.max(0, i)];
      // keep the line being sung in the middle of the box
      if (cur) box.scrollTo({ top: cur.offsetTop - box.clientHeight / 2 + cur.offsetHeight / 2, behavior: 'smooth' });
    }
  }

  async function loadLyrics(m) {
    lyrics = { key: m.key, lines: [], plain: '' };
    lineNow.textContent = '';
    lineNext.textContent = '';
    if (stage === 'lyrics') stage = 'none';
    paintStage();
    if (app.settings.lyrics === false) return;
    const res = await api.invoke('lyrics:get', { title: m.title, artist: m.artist, album: m.album, duration: m.duration });
    if (!app.sys.media || app.sys.media.key !== m.key) return; // the track changed while we waited
    if (res && ((res.synced && res.synced.length) || res.plain)) {
      lyrics = { key: m.key, lines: res.synced || [], plain: res.plain || '' };
      if (!lyrics.lines.length) {
        lineNow.textContent = 'Текст песни';
        lineNext.textContent = 'без привязки ко времени: нажмите, чтобы прочитать';
      }
      paintStage();
      paintProgress();
      hooks.resized();
    }
  }

  // ---------------------------------------------------------------- which player to follow
  async function loadSessions() {
    let list = [];
    try {
      const r = await api.invoke('media:sessions');
      list = (r && r.sessions) || [];
    } catch {
      list = [];
    }
    const sig = JSON.stringify(list.map((s) => [s.app, s.status]));
    if (sig === JSON.stringify(sessions.map((s) => [s.app, s.status]))) return;
    sessions = list;
    paintSources();
    hooks.resized();
  }

  function paintSources() {
    const m = app.sys.media;
    sources.hidden = sessions.length < 2;
    clear(sources);
    if (sources.hidden) return;
    for (const s of sessions) {
      sources.append(h('button', {
        class: 'chip' + (m && s.app === m.app ? ' on' : ''),
        title: [s.title, s.artist].filter(Boolean).join(' — '),
        onclick: () => api.invoke('media:follow', s.app),
      }, s.status === 'Playing' ? icon('play', 9, 3) : null, h('span', { class: 'ellipsis', text: appLabel(s.app) })));
    }
  }

  // ---------------------------------------------------------------- the whole card
  function paint() {
    const m = app.sys.media;
    const was = !el.hidden;
    el.hidden = !m;
    if (!m) {
      if (was) hooks.resized();
      return;
    }
    title.textContent = m.title || 'Без названия';
    artist.textContent = [m.artist, appLabel(m.app)].filter(Boolean).join(' · ');
    artist.title = artist.textContent;
    cover.hidden = !m.cover;
    coverBlank.hidden = Boolean(m.cover);
    if (m.cover && cover.src !== m.cover) cover.src = m.cover;
    glow.style.backgroundImage = m.cover ? `url("${m.cover}")` : 'none';
    clear(btnPlay, icon(m.playing ? 'pause' : 'play', 17, 2.4));
    btnPrev.disabled = !m.canPrev;
    btnNext.disabled = !m.canNext;
    bar.disabled = !m.canSeek || !m.duration;
    timeAll.textContent = m.duration ? formatTime(m.duration) : '';
    paintLike();
    paintSources();
    if (lyrics.key !== m.key) loadLyrics(m);
    paintProgress();
    if (!was) hooks.resized();
  }

  app.on('media', () => shown && paint());
  app.on('store', (key) => {
    if (shown && key === 'likes') {
      paintLike();
      if (stage === 'likes') paintStage();
    }
  });

  return {
    el,
    visible: () => !el.hidden,
    expanded: () => stage !== 'none',
    show() {
      shown = true;
      paint();
      paintStage();
      clearInterval(timer);
      timer = setInterval(paintProgress, 400);
      clearInterval(sessionsTimer);
      sessionsTimer = setInterval(loadSessions, 4000);
      loadSessions();
    },
    hide() {
      shown = false;
      clearInterval(timer);
      clearInterval(sessionsTimer);
    },
  };
}
