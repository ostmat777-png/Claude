// Плеер: a music service (Yandex Music, VK, YouTube Music, Spotify, SoundCloud)
// open right in the island. Its page keeps running when you go to another tab or
// the island folds away, so the music goes on; the player on the home tab shows
// it and drives it. "Stop" closes the page and the music with it.

import { h, clear, icon } from '../ui.js';
import { MUSIC_SERVICES } from '../common.js';

// The service's own "like" button: on the player bar (lowest on the page), named
// "Нравится", "Like", "Сохранить в медиатеку"..., but not "Не нравится".
const LIKE_FIND = `
  const likeVisible = (b) => b && b.offsetParent !== null;
  const likeLabel = (b) => [b.getAttribute('aria-label'), b.title, b.dataset && b.dataset.testid].join(' ');
  // ("Мне нравится" has "не нравится" inside it: the "не" must be a word of its own)
  const likeBad = /(?:^|[^а-яёa-z])не (?:нравится|рекомендовать)|dislike|thumbs.?down/i;
  const likeGood = /нравится|like|лайк|избранн|любим|save to your library|add to liked|медиатек/i;
  const likeButton = () => [...document.querySelectorAll('button, [role="button"]')]
    .filter((b) => likeVisible(b) && likeGood.test(likeLabel(b)) && !likeBad.test(likeLabel(b)))
    .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0] || null;
  const likeState = (b) => {
    if (!b) return null;
    const p = b.getAttribute('aria-pressed') || b.getAttribute('aria-checked');
    if (p === 'true') return true;
    if (p === 'false') return false;
    return /\\b(active|liked|is-liked|checked|selected)\\b/i.test(String(b.className)) ? true : null;
  };
`;

// Read inside the service's page: what is playing, from the page's media session
// (the same data Windows shows) and its audio or video element.
const READ = `(() => {
  ${LIKE_FIND}
  const els = [...document.querySelectorAll('audio, video')];
  const el = els.find((e) => !e.paused) || els.find((e) => e.currentTime > 0) || els[0] || null;
  const ms = navigator.mediaSession;
  const md = ms && ms.metadata;
  const art = md && md.artwork && md.artwork.length ? md.artwork[md.artwork.length - 1].src : '';
  return {
    title: md ? md.title : '',
    artist: md ? md.artist : '',
    album: md ? md.album : '',
    art,
    playing: el ? !el.paused : Boolean(ms && ms.playbackState === 'playing'),
    position: el ? el.currentTime : 0,
    duration: el && isFinite(el.duration) ? el.duration : 0,
    liked: window.externalAPI && externalAPI.getCurrentTrack && externalAPI.getCurrentTrack()
      ? Boolean(externalAPI.getCurrentTrack().liked) : likeState(likeButton()),
  };
})()`;

// Press the page's own "like": the like goes to your account in that service.
const LIKE = `(() => {
  ${LIKE_FIND}
  // Yandex Music's interface for players and extensions, where the page has it
  if (window.externalAPI && typeof externalAPI.toggleLike === 'function') {
    externalAPI.toggleLike();
    return { how: 'api' };
  }
  const b = likeButton();
  if (!b) return { how: 'none' };
  b.click();
  return { how: 'button' };
})()`;

// Pressing the page's own buttons where possible, so its interface stays in step.
const COMMAND = (action, position) => `(() => {
  const els = [...document.querySelectorAll('audio, video')];
  const el = els.find((e) => !e.paused) || els.find((e) => e.currentTime > 0) || els[0] || null;
  const visible = (b) => b && b.offsetParent !== null;
  const find = (re) => [...document.querySelectorAll('button, [role="button"], a')]
    .find((b) => visible(b) && re.test([b.getAttribute('aria-label'), b.title, b.dataset && b.dataset.testid, b.className].join(' ')));
  const act = ${JSON.stringify(action)};
  if (act === 'toggle' || act === 'play' || act === 'pause') {
    const btn = find(act === 'pause' ? /пауза|pause/i : act === 'play' ? /воспроизв|играть|play(?!list)/i : /пауза|pause|воспроизв|play(?!list)/i);
    if (btn) { btn.click(); return 'button'; }
    if (!el) return 'none';
    if (act === 'pause' || (act === 'toggle' && !el.paused)) el.pause(); else el.play();
    return 'element';
  }
  if (act === 'next' || act === 'prev') {
    const btn = find(act === 'next' ? /следующ|далее|next|skip.?forward/i : /предыдущ|назад|previous|prev|skip.?back/i);
    if (btn) { btn.click(); return 'button'; }
    return 'none';
  }
  if (act === 'seek' && el) { el.currentTime = ${Number(position) || 0}; return 'element'; }
  return 'none';
})()`;

export default {
  id: 'music',
  title: 'Плеер',
  icon: 'radio',
  width: 640,

  mount(root, app) {
    const { api } = app;
    const pages = new Map(); // service id -> <webview>
    let reading = 0;

    const chips = h('div', { class: 'music-chips' });
    const stage = h('div', { class: 'music-stage card' });
    const intro = h('div', { class: 'music-intro' },
      icon('radio', 34),
      h('b', { text: 'Музыка прямо в острове' }),
      h('div', { class: 'faint', text: 'Выберите сервис и войдите в свой аккаунт, как в браузере. Музыка будет играть, даже когда вы уйдёте с этой вкладки или остров свернётся. Управлять можно с «Главной».' }));
    stage.append(intro);
    root.append(chips, stage);

    const serviceUrl = (svc) => (app.test && window.__musicTestUrl ? window.__musicTestUrl : svc.url);
    const current = () => MUSIC_SERVICES.find((x) => x.id === app.settings.music.service) || null;

    function open(svc) {
      app.set('settings.music', { ...app.settings.music, service: svc.id });
      if (!pages.has(svc.id)) {
        const view = document.createElement('webview');
        view.setAttribute('partition', 'persist:music');
        view.setAttribute('allowpopups', '');
        view.setAttribute('src', serviceUrl(svc));
        view.className = 'music-frame';
        view.dataset.service = svc.id;
        pages.set(svc.id, view);
        stage.append(view);
      }
      paint();
    }

    /** Closes a service's page: its music stops. */
    function stop(id) {
      const view = pages.get(id);
      if (!view) return;
      pages.delete(id);
      view.remove();
      api.send('webmedia:state', null);
      if (app.settings.music.service === id) app.set('settings.music', { ...app.settings.music, service: '' });
      paint();
    }

    function paint() {
      const cur = current();
      clear(chips, MUSIC_SERVICES.map((svc) => h('button', {
        class: 'chip' + (cur && cur.id === svc.id ? ' on' : '') + (pages.has(svc.id) ? ' open' : ''),
        data: { service: svc.id },
        title: pages.has(svc.id) ? `${svc.name}: открыт` : svc.name,
        onclick: () => open(svc),
      }, pages.has(svc.id) ? h('span', { class: 'music-dot' }) : null, svc.name)));
      intro.hidden = Boolean(cur && pages.has(cur.id));
      for (const [id, view] of pages) view.classList.toggle('shown', Boolean(cur && cur.id === id));
      stopBtn.hidden = !(cur && pages.has(cur.id));
      reloadBtn.hidden = stopBtn.hidden;
      app.setHeadNote(cur && pages.has(cur.id) ? cur.name : '');
      app.relayout();
    }

    // What plays, once a second, for the player on the home tab.
    async function read() {
      const cur = current();
      const view = cur && pages.get(cur.id);
      if (!view) return;
      try {
        const state = await view.executeJavaScript(READ);
        if (app.videoOwn) return; // the island's own YouTube video is the player now
        api.send('webmedia:state', { ...state, service: cur.id });
      } catch {
        // the page is still loading
      }
    }

    // the heart on the home tab presses the service's own "like"
    app.musicLike = async () => {
      const cur = current();
      const view = cur && pages.get(cur.id);
      if (!view) return { how: 'none' };
      let res = { how: 'none' };
      try {
        res = await view.executeJavaScript(LIKE);
      } catch {}
      setTimeout(read, 400);
      return { ...res, service: cur.name };
    };

    api.on('webmedia:cmd', async (action, position) => {
      const cur = current();
      const view = cur && pages.get(cur.id);
      if (!view || app.videoOwn) return;
      try {
        await view.executeJavaScript(COMMAND(action, position));
      } catch {}
      setTimeout(read, 300);
    });

    const stopBtn = h('button', { class: 'ghost', title: 'Остановить музыку и закрыть сервис', onclick: () => current() && stop(current().id) }, icon('circle-stop', 15));
    const reloadBtn = h('button', {
      class: 'ghost',
      title: 'Обновить страницу',
      onclick: () => {
        const cur = current();
        const view = cur && pages.get(cur.id);
        try {
          view.reload();
        } catch {}
      },
    }, icon('refresh-cw', 14));
    const browserBtn = h('button', {
      class: 'ghost',
      title: 'Открыть в браузере',
      onclick: () => api.invoke('open:external', (current() || MUSIC_SERVICES[0]).url),
    }, icon('external-link', 14));

    // The page goes on in the background; reading goes on too.
    reading = setInterval(read, 1000);
    // Opened last time: open again, so the music is a click away. (Not playing:
    // services do not start music by themselves.)
    if (current() && app.settings.music.reopen !== false) open(current());
    else paint();

    return {
      actions: [reloadBtn, stopBtn, browserBtn],
      show() {
        paint();
      },
      // nothing to do on hide: the page keeps playing
      destroy() {
        clearInterval(reading);
      },
    };
  },
};
