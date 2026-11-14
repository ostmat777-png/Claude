// The player on the home tab: what is playing (a program or a site in a browser),
// its cover, controls, the song's words, and the "liked" list.

import { h, clear, icon, paintRange } from '../ui.js';
import { appLabel, musicSearchUrl } from '../common.js';
import { formatTime, lineAt } from '../../shared/lrc.mjs';

const likeKey = (m) => `${m.artist || ''}|${m.title || ''}`.toLowerCase();

/**
 * The colour of a cover: the average of its lively pixels (grey, black and white
 * count for little), made dark enough for white text on top of it.
 * @returns {Promise<[number, number, number] | null>}
 */
export async function coverColor(url) {
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const n = 24;
  const canvas = document.createElement('canvas');
  canvas.width = n;
  canvas.height = n;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, n, n);
  let data;
  try {
    data = g.getImageData(0, 0, n, n).data;
  } catch {
    return null;
  }
  let r = 0;
  let gr = 0;
  let b = 0;
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const R = data[i];
    const G = data[i + 1];
    const B = data[i + 2];
    const max = Math.max(R, G, B);
    const min = Math.min(R, G, B);
    const sat = max ? (max - min) / max : 0;
    const light = (max + min) / 510;
    // colourful, not too dark, not blown out
    const w = 0.04 + sat * sat * (light > 0.08 && light < 0.95 ? 1 : 0.2);
    r += R * w;
    gr += G * w;
    b += B * w;
    total += w;
  }
  if (!total) return null;
  let c = [r / total, gr / total, b / total];
  // keep the hue, cap the brightness so the card stays dark and readable
  const lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  const k = lum > 0.42 ? 0.42 / lum : 1;
  c = c.map((v) => Math.round(Math.min(255, v * k)));
  return c;
}

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
  let pageTimer = 0;
  let seeking = false;
  let stage = 'none'; // none | lyrics | likes
  let lyrics = { key: null, lines: [], plain: '' };
  let lineIndex = -2;
  let sessions = [];

  // ---------------------------------------------------------------- the YouTube video, here
  // When a browser plays a YouTube video, the same video is shown here in place of
  // the cover: silent and in step with the browser. A click opens it big, still
  // inside the island, with YouTube's own controls: a pause or a rewind made there
  // is passed on to the browser. "Звук в острове" moves the video here entirely:
  // the browser falls silent and the island plays it, with sound.
  const BROWSERS = /chrome|msedge|firefox|opera|yandex|browser|brave|vivaldi|308046B0AF4A39CB/i;
  const video = { key: null, id: null, ids: [], view: null, timer: 0, own: false, track: null, hold: 0, state: null };
  // YouTube shows embedded videos only to players that say where they are
  const EMBED_REFERRER = 'https://kaplya.github.io/';
  const videoBox = h('div', { class: 'player-video', hidden: true, title: 'Открыть видео', onclick: () => stage !== 'video' && setStage('video') });
  const isTitle = (m) => Boolean(m) && String(m.app).startsWith('title:');
  const homeView = () => el.closest('.view');

  // Run inside the video's page, once a second: keeps it in step with the browser,
  // and notices what the person did there themselves.
  const WATCH = (o) => `(() => {
    const text = document.body ? document.body.innerText : '';
    if (document.querySelector('.ytp-error') || /Error 15\\d|Video unavailable|isn.t available|недоступн|Ошибка/i.test(text)) return { broken: true };
    const v = document.querySelector('video');
    if (!v) return { loading: true };
    const k = window.__kaplya || (window.__kaplya = { prog: 0, user: null, since: Date.now(), hooked: false });
    if (!k.hooked) {
      k.hooked = true;
      for (const t of ['seeked', 'pause', 'play']) {
        v.addEventListener(t, () => {
          // not ours (we have just touched it), and not the page's own start
          if (Date.now() - k.prog > 900 && Date.now() - k.since > 3000) k.user = { type: t, time: v.currentTime };
        });
      }
    }
    const o = ${JSON.stringify(o)};
    const user = k.user;
    k.user = null;
    if (!o.own && !user) {
      if (!v.muted) v.muted = true;
      if (o.sync) {
        if (Math.abs(v.currentTime - o.at) > 2.5) { k.prog = Date.now(); v.currentTime = o.at; }
        if (o.playing && v.paused) { k.prog = Date.now(); v.play().catch(() => {}); }
        if (!o.playing && !v.paused) { k.prog = Date.now(); v.pause(); }
      }
    }
    return { user, time: v.currentTime, duration: isFinite(v.duration) ? v.duration : 0, paused: v.paused, muted: v.muted, ended: v.ended };
  })()`;

  // Something done to the video from outside its page (the island's buttons).
  const ACT = (action, value) => `(() => {
    const v = document.querySelector('video');
    if (!v) return false;
    const p = document.getElementById('movie_player');
    const k = window.__kaplya || (window.__kaplya = { prog: 0, user: null, since: Date.now(), hooked: false });
    k.prog = Date.now();
    const act = ${JSON.stringify(action)};
    if (act === 'sound') {
      if (p && p.unMute) { p.unMute(); if (p.setVolume) p.setVolume(100); }
      v.muted = false;
      v.volume = 1;
      v.play().catch(() => {});
    } else if (act === 'silence') {
      v.pause();
      if (p && p.mute) p.mute();
      v.muted = true;
    } else if (act === 'pause') v.pause();
    else if (act === 'play') v.play().catch(() => {});
    else if (act === 'toggle') { if (v.paused) v.play().catch(() => {}); else v.pause(); }
    else if (act === 'seek') v.currentTime = ${Number(value) || 0};
    return true;
  })()`;

  function wantVideo(m) {
    return Boolean(app.settings.youtubeMini && m && BROWSERS.test(m.app || '') && !String(m.app).startsWith('kaplya:'));
  }

  function embedUrl(id, at) {
    return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&controls=1&fs=0&playsinline=1&rel=0&iv_load_policy=3&origin=${encodeURIComponent(EMBED_REFERRER.slice(0, -1))}&start=${Math.max(0, Math.floor(at))}`;
  }

  function dropVideo() {
    if (video.own) releaseOwn();
    clearInterval(video.timer);
    if (video.view) video.view.remove();
    Object.assign(video, { key: null, id: null, ids: [], view: null, timer: 0, own: false, track: null, hold: 0, state: null });
    videoBox.hidden = true;
    el.classList.remove('has-video');
    if (stage === 'video') setStage('none');
  }

  async function paintVideo(m) {
    if (video.own) {
      // the island plays it itself now; only switching the setting off ends that
      if (!app.settings.youtubeMini) dropVideo();
      return;
    }
    // (just handed back to the browser: Windows needs a moment to show it again)
    if (Date.now() < video.hold) return;
    if (!wantVideo(m)) {
      if (video.key) dropVideo();
      return;
    }
    if (video.key === m.key) return;
    dropVideo();
    video.key = m.key;
    const ids = await api.invoke('youtube:find', m.title, isTitle(m) ? '' : m.artist).catch(() => []);
    if (!Array.isArray(ids) || !ids.length || video.key !== m.key) return;
    video.ids = ids.slice();
    showVideo(m, video.ids.shift());
  }

  function showVideo(m, id) {
    if (video.view) video.view.remove();
    video.id = id;
    video.state = null;
    const view = document.createElement('webview');
    view.setAttribute('partition', 'persist:web');
    view.setAttribute('httpreferrer', EMBED_REFERRER);
    view.setAttribute('webpreferences', 'autoplayPolicy=no-user-gesture-required');
    view.setAttribute('src', app.test ? (window.__videoTestUrl || 'about:blank') : embedUrl(id, m ? position(m) : 0));
    view.dataset.videoId = id;
    video.view = view;
    videoBox.append(view);
    videoBox.hidden = false;
    el.classList.add('has-video');
    clearInterval(video.timer);
    video.timer = setInterval(() => tickVideo(), 1000);
    hooks.resized();
  }

  const act = (action, value) => (video.view ? video.view.executeJavaScript(ACT(action, value), true).catch(() => false) : Promise.resolve(false));

  async function tickVideo() {
    const view = video.view;
    if (!view) return;
    const m = app.sys.media;
    const own = video.own;
    // in step with the browser, when the browser says where it is
    const sync = !own && Boolean(m) && m.key === video.key && (m.duration > 0 || !isTitle(m)) && Date.now() > video.hold;
    let r;
    try {
      r = await view.executeJavaScript(WATCH({ own, sync, at: sync ? position(m) : 0, playing: sync ? m.playing : false }));
    } catch {
      return; // still loading
    }
    if (view !== video.view || !r || r.loading) return;
    if (r.broken) {
      // the owner does not allow the video to be shown elsewhere: the next match, or back to the cover
      if (video.ids.length) showVideo(m, video.ids.shift());
      else {
        if (own) app.toast({ type: 'error', title: 'Это видео нельзя показать вне YouTube', text: 'Так решил его автор' });
        dropVideo();
      }
      return;
    }
    video.state = r;
    if (own) {
      reportOwn();
      return;
    }
    if (!r.user || !m || m.key !== video.key) return;
    // Done by hand in the island's video: the browser follows where it can.
    video.hold = Date.now() + 2500;
    if (r.user.type === 'seeked') {
      if (m.canSeek && !isTitle(m)) api.invoke('media:cmd', 'seek', r.user.time);
      else takeOver('Этот браузер нельзя перемотать снаружи, поэтому видео теперь играет в острове');
    } else if (isTitle(m)) {
      api.invoke('media:cmd', 'toggle');
    } else {
      api.invoke('media:cmd', r.user.type === 'pause' ? 'pause' : 'play');
    }
  }

  function reportOwn() {
    const r = video.state;
    if (!video.own || !r || !video.track) return;
    api.send('webmedia:state', {
      service: 'youtube',
      title: video.track.title,
      artist: video.track.artist,
      album: '',
      art: `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`,
      playing: !r.paused,
      position: r.time,
      duration: r.duration,
    });
  }

  /** The video moves here: the browser falls silent, the island plays it with sound. */
  async function takeOver(why) {
    const m = app.sys.media;
    if (!video.view || video.own || !m) return;
    video.track = { title: m.title, artist: isTitle(m) ? 'YouTube' : m.artist, browser: m.app, fromTitle: isTitle(m) };
    video.own = true;
    app.videoOwn = true;
    homeView()?.classList.add('keep-alive');
    if (isTitle(m)) {
      if (m.playing || !m.duration) await api.invoke('media:cmd', 'toggle');
    } else if (m.playing) {
      await api.invoke('media:cmd', 'pause');
    }
    await act('sound');
    await api.invoke('media:follow', 'kaplya:web:youtube');
    await tickVideo();
    paintStage();
    if (why) app.toast({ type: 'info', icon: 'monitor-play', title: 'Видео играет в острове', text: why, hold: 7000 });
  }

  function releaseOwn() {
    video.own = false;
    app.videoOwn = false;
    homeView()?.classList.remove('keep-alive');
    api.send('webmedia:state', null);
    api.invoke('media:follow', '');
  }

  /** Back to the browser, from the moment the island reached. */
  async function giveBack() {
    if (!video.own) return;
    const t = video.track;
    const at = video.state ? video.state.time : 0;
    video.hold = Date.now() + 3500;
    await act('silence');
    releaseOwn();
    // the browser is the player again
    if (!t.fromTitle) await api.invoke('media:follow', t.browser);
    video.hold = Date.now() + 3500;
    setTimeout(() => paintVideo(app.sys.media), 3700);
    if (t.fromTitle) {
      await api.invoke('media:cmd', 'toggle', 0, t.browser);
    } else {
      await api.invoke('media:cmd', 'seek', at, t.browser);
      await api.invoke('media:cmd', 'play', 0, t.browser);
    }
    paintStage();
  }

  // the island's buttons, while the island plays the video itself
  api.on('webmedia:cmd', async (action, pos) => {
    if (!video.own) return;
    if (action === 'next' || action === 'prev') return;
    await act(action, pos);
    tickVideo();
  });

  const cover = h('img', { class: 'player-cover', alt: '' });
  const coverBlank = h('div', { class: 'player-cover blank' }, icon('music', 26));
  const glow = h('div', { class: 'player-glow' });
  const title = h('div', { class: 'player-title ellipsis' });
  const artist = h('div', { class: 'player-artist ellipsis' });
  const bar = h('input', { type: 'range', class: 'player-bar', min: 0, max: 1000, value: 0, 'aria-label': 'Позиция в треке' });
  const timeNow = h('span', { text: '0:00' });
  const timeAll = h('span', { text: '' });
  const btnPrev = h('button', { class: 'ghost', title: 'Предыдущий', onclick: () => api.invoke('media:cmd', 'prev') }, icon('skip-back', 17));
  // The button answers at once; the player itself confirms a moment later.
  let playShown = null;
  let playHold = 0;
  function paintPlay(playing) {
    if (playShown === playing) return;
    playShown = playing;
    clear(btnPlay, icon(playing ? 'pause' : 'play', 17, 2.4));
  }
  const btnPlay = h('button', {
    class: 'player-play',
    title: 'Пауза / играть',
    onclick: () => {
      const m = app.sys.media;
      // (a browser known only by its window title does not say whether it plays)
      if (m && !String(m.app).startsWith('title:')) {
        playHold = Date.now() + 1500;
        paintPlay(!playShown);
      }
      api.invoke('media:cmd', 'toggle');
    },
  });
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

  let tintFor = '';
  async function paintTint(url) {
    if (url === tintFor) return;
    tintFor = url || '';
    const c = url ? await coverColor(url) : null;
    if (tintFor !== (url || '')) return; // another cover came meanwhile
    if (c) {
      el.style.setProperty('--tint', `rgb(${c[0]}, ${c[1]}, ${c[2]})`);
      el.classList.add('tinted');
    } else {
      el.style.removeProperty('--tint');
      el.classList.remove('tinted');
    }
  }

  const el = h('div', { class: 'player card', hidden: true },
    glow,
    h('div', { class: 'player-row' },
      h('div', { class: 'player-art' }, cover, coverBlank, videoBox),
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

  // the service says whether the track is liked there (music inside the island)
  // just pressed: shown as pressed until the service's page has caught up
  let likePending = null;
  const shownLiked = (m) => {
    if (m && likePending && likePending.key === likeKey(m) && Date.now() < likePending.until) {
      if (m.liked === likePending.want) likePending = null;
      else return likePending.want;
    }
    return m && typeof m.liked === 'boolean' ? m.liked : isLiked(m);
  };

  /** Keeps Kaplya's own list in step: `want` true adds the track, false takes it away. */
  function rememberLike(m, want) {
    const key = likeKey(m);
    const list = likes().filter((x) => x.key !== key);
    app.set('likes', want ? [{ key, title: m.title, artist: m.artist, album: m.album, app: m.app, at: Date.now() }, ...list].slice(0, 500) : list);
  }

  let likeExplained = false;
  async function toggleLike() {
    const m = app.sys.media;
    if (!m) return;
    const want = !shownLiked(m);
    const name = appLabel(m.app) || 'плеере';
    likePending = { key: likeKey(m), want, until: Date.now() + 2500 };
    rememberLike(m, want);
    paintLike(want);
    if (stage === 'likes') paintStage();
    const web = String(m.app).startsWith('kaplya:web');
    if (web && m.app !== 'kaplya:web:youtube' && app.musicLike) {
      // music inside the island: press the service's own "like", into your account
      const r = await app.musicLike();
      if (r && r.how !== 'none') {
        app.toast({ type: 'info', icon: 'heart', title: want ? `Лайк поставлен в ${r.service}` : `Лайк снят в ${r.service}`, text: m.title });
      } else {
        app.toast({ type: 'error', title: 'Не нашёл кнопку «Нравится» на странице сервиса', text: 'Трек сохранён в списке Капли', hold: 6000 });
      }
      return;
    }
    if (web || !app.sys.helper) return;
    // A program or a browser tab: Windows has no "like" command, so the island
    // presses the "like" button in the player's own window.
    const r = await api.invoke('media:like', m.app, want).catch(() => null);
    if (app.sys.media && likeKey(app.sys.media) !== likeKey(m)) return;
    if (r && r.found) {
      if (typeof r.liked === 'boolean' && r.liked !== want) rememberLike(m, r.liked);
      app.toast({
        type: 'info',
        icon: 'heart',
        title: r.pressed ? (want ? `Лайк поставлен в ${name}` : `Лайк снят в ${name}`) : `В ${name} уже так и стоит`,
        text: m.title,
      });
    } else if (want && !likeExplained) {
      likeExplained = true;
      app.toast({
        type: 'info',
        icon: 'heart',
        title: 'Лайк сохранён в Капле',
        text: `Не нашёл кнопку «Нравится» в окне ${name}. Она находится, когда окно плеера не свёрнуто и в нём открыт этот трек (в браузере — его вкладка).`,
        hold: 9000,
      });
    }
    paintLike();
  }

  function paintLike(override) {
    const liked = typeof override === 'boolean' ? override : shownLiked(app.sys.media);
    btnLike.classList.toggle('on', liked);
    btnLike.title = liked ? 'Убрать из понравившихся' : 'Нравится: запомнить этот трек';
    btnLike.setAttribute('aria-pressed', String(liked));
    likeCount.textContent = likes().length ? String(likes().length) : '';
  }

  // ---------------------------------------------------------------- stage
  function setStage(next) {
    if (next === 'lyrics' && !lyrics.lines.length && !lyrics.plain) next = 'none';
    if (next === 'video' && !video.view) next = 'none';
    el.classList.toggle('video-big', next === 'video');
    videoBox.title = next === 'video' ? '' : 'Открыть видео';
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
      stageEl.hidden = true;
      return;
    }
    if (stage === 'video') {
      const m = app.sys.media;
      const canFollow = m && !isTitle(m) && m.canSeek;
      clear(stageEl, h('div', { class: 'video-bar' },
        video.own
          ? h('button', { class: 'btn small', data: { act: 'video-back' }, title: 'Продолжить в браузере с этого же места', onclick: () => giveBack() }, icon('monitor', 13), 'Вернуть в браузер')
          : h('button', { class: 'btn small primary', data: { act: 'video-own' }, title: 'Браузер замолчит, видео со звуком пойдёт здесь', onclick: () => takeOver() }, icon('volume-2', 13), 'Звук в острове'),
        h('span', {
          class: 'faint video-note ellipsis',
          text: video.own ? 'Видео играет в острове: пауза, перемотка и звук прямо на нём'
            : canFollow ? 'Пауза и перемотка здесь управляют видео в браузере'
              : 'Чтобы перематывать и слушать здесь, нажмите «Звук в острове»',
        }),
        h('span', { class: 'grow' }),
        h('button', { class: 'ghost', title: 'Свернуть видео', onclick: () => setStage('none') }, icon('chevron-up', 15))));
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
        'Капля также нажимает «Нравится» в самом плеере, когда его окно открыто.'));
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
      if (video.key) dropVideo();
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
    paintTint(m.cover || '');
    if (Date.now() > playHold || m.playing === playShown) {
      playHold = 0;
      paintPlay(m.playing);
    }
    btnPrev.disabled = !m.canPrev;
    btnNext.disabled = !m.canNext;
    bar.disabled = !m.canSeek || !m.duration;
    timeAll.textContent = m.duration ? formatTime(m.duration) : '';
    paintLike();
    paintSources();
    paintVideo(m);
    if (lyrics.key !== m.key) loadLyrics(m);
    paintProgress();
    if (!was) hooks.resized();
  }

  app.on('media', () => shown && paint());
  app.on('store', (key) => {
    if (key === 'settings.youtubeMini') paintVideo(app.sys.media);
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
      sessionsTimer = setInterval(loadSessions, 5000);
      loadSessions();
      // A browser known only by its window title: its window says where the video is.
      clearInterval(pageTimer);
      const readPage = () => {
        const m = app.sys.media;
        if (m && isTitle(m) && !video.own) api.invoke('media:page', m.app, m.key).catch(() => {});
      };
      pageTimer = setInterval(readPage, 4000);
      readPage();
    },
    hide() {
      shown = false;
      clearInterval(timer);
      clearInterval(sessionsTimer);
      clearInterval(pageTimer);
    },
  };
}
