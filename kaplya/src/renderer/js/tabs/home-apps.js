// The row of things to open with one click: programs, shortcuts, folders, File
// Explorer, and links to web sites. Each shows its own icon.

import { h, clear, icon } from '../ui.js';
import { colorFor } from '../common.js';

const BLANK = { file: 'app-window', folder: 'folder', explorer: 'folder-open', url: 'globe' };

export function createApps(app, hooks) {
  const { api } = app;
  let items = [];
  let adding = false;
  let dragId = null;
  const iconCache = new Map(); // id -> Promise<data URL | null>

  const row = h('div', { class: 'apps-row' });
  const addBar = h('div', { class: 'apps-add', hidden: true });
  const el = h('div', { class: 'apps card' }, row, addBar);

  function iconFor(item) {
    if (!iconCache.has(item.id)) iconCache.set(item.id, api.invoke('apps:icon', item.id).catch(() => null));
    return iconCache.get(item.id);
  }

  /** What stands in for an icon until the real one arrives (or if there is none). */
  function placeholder(item) {
    if (item.kind === 'url') {
      const letter = (item.name || '?').trim().charAt(0).toUpperCase() || '?';
      return h('span', { class: 'app-letter', style: { background: colorFor(item.name) }, text: letter });
    }
    return icon(BLANK[item.kind] || 'app-window', 20);
  }

  async function reload() {
    try {
      items = await api.invoke('apps:list');
    } catch {
      items = [];
    }
    paint();
    hooks.resized();
  }

  function paint() {
    el.hidden = app.settings.home.showApps === false;
    clear(row);
    items.forEach((item, index) => {
      const holder = placeholder(item);
      const btn = h('button', {
        class: 'app',
        title: item.kind === 'url' ? `${item.name}\n${item.url}` : item.name,
        draggable: true,
        data: { id: item.id, kind: item.kind },
        onclick: async () => {
          const ok = await api.invoke('apps:open', item.id);
          if (!ok) app.toast({ type: 'error', title: 'Не получилось открыть', text: item.name });
          else app.collapse();
        },
        // drag one icon onto another to change the order
        ondragstart: (e) => {
          dragId = item.id;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', item.name);
        },
        ondragover: (e) => {
          if (dragId && dragId !== item.id) e.preventDefault();
        },
        ondrop: async (e) => {
          if (!dragId || dragId === item.id) return;
          e.preventDefault();
          e.stopPropagation();
          const moved = dragId;
          dragId = null;
          items = await api.invoke('apps:move', moved, index);
          paint();
        },
        ondragend: () => {
          dragId = null;
        },
      }, holder, h('span', {
        class: 'app-remove',
        title: 'Убрать с острова',
        onclick: async (e) => {
          e.stopPropagation();
          iconCache.delete(item.id);
          items = await api.invoke('apps:remove', item.id);
          paint();
          hooks.resized();
        },
      }, icon('x', 9, 3)));
      iconFor(item).then((url) => {
        if (url && holder.isConnected) holder.replaceWith(h('img', { src: url, alt: '', draggable: false }));
      });
      row.append(btn);
    });
    row.append(h('button', {
      class: 'app add' + (adding ? ' on' : ''),
      title: 'Добавить программу, папку или сайт',
      'aria-expanded': String(adding),
      onclick: () => {
        adding = !adding;
        paint();
        hooks.resized();
      },
    }, icon(adding ? 'x' : 'plus', 16)));
    if (!items.length && !adding) row.append(h('span', { class: 'faint apps-hint', text: 'Добавьте сюда программы, папки и сайты, которые открываете чаще всего' }));
    paintAddBar();
  }

  function paintAddBar() {
    addBar.hidden = !adding;
    if (!adding) {
      clear(addBar);
      return;
    }
    const note = h('span', { class: 'apps-note faint', text: 'Ярлык, программу или папку можно и просто перетащить сюда' });
    const url = h('input', { class: 'field', type: 'text', placeholder: 'Адрес сайта, например music.yandex.ru', spellcheck: false, 'aria-label': 'Адрес сайта' });
    const name = h('input', { class: 'field apps-name', type: 'text', placeholder: 'Название', spellcheck: false, 'aria-label': 'Название' });
    const addLink = async () => {
      if (!url.value.trim()) return url.focus();
      try {
        items = await api.invoke('apps:addUrl', url.value, name.value);
        adding = false;
        paint();
        hooks.resized();
      } catch {
        note.textContent = 'Не похоже на адрес сайта. Пример: youtube.com';
        note.classList.add('bad');
      }
      return undefined;
    };
    for (const input of [url, name]) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addLink();
      });
    }
    const pick = (channel) => async () => {
      items = await api.invoke(channel);
      adding = false;
      paint();
      hooks.resized();
    };
    clear(addBar,
      h('div', { class: 'apps-add-row' },
        h('button', { class: 'btn small', data: { add: 'file' }, onclick: pick('apps:pickFile') }, icon('app-window', 13), 'Программа или файл…'),
        h('button', { class: 'btn small', data: { add: 'folder' }, onclick: pick('apps:pickFolder') }, icon('folder', 13), 'Папка…'),
        h('button', { class: 'btn small', data: { add: 'explorer' }, onclick: pick('apps:addExplorer') }, icon('folder-open', 13), 'Проводник')),
      h('div', { class: 'apps-add-row' }, url, name,
        h('button', { class: 'btn small primary', data: { add: 'url' }, onclick: addLink }, icon('link-2', 13), 'Добавить сайт')),
      note);
  }

  // A shortcut, program or folder dropped on the row is added to the row (not to the shelf).
  el.addEventListener('dragover', (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'link';
    }
  });
  el.addEventListener('drop', async (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    for (const f of e.dataTransfer.files) {
      const p = api.pathForFile(f);
      if (p) items = await api.invoke('apps:addPath', p);
    }
    paint();
    hooks.resized();
  });

  app.on('store', (key) => {
    if (key === 'apps') reload();
    if (key.startsWith('settings.home')) paint();
  });

  return {
    el,
    show() {
      reload();
    },
  };
}
