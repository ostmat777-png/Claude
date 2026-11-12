// Полка: drop files on the island, take them out later, wherever you need them.

import { h, clear, icon, fileSize } from '../ui.js';

const EXT_COLORS = { pdf: '#ff5a5a', png: '#4aa3ff', jpg: '#4aa3ff', jpeg: '#4aa3ff', gif: '#4aa3ff', webp: '#4aa3ff', zip: '#ffb84a', rar: '#ffb84a', '7z': '#ffb84a', doc: '#4a7dff', docx: '#4a7dff', xls: '#3fbf7f', xlsx: '#3fbf7f', csv: '#3fbf7f', mp4: '#c47dff', mov: '#c47dff', mp3: '#ff7db8', txt: '#9a9aa6' };

export default {
  id: 'shelf',
  title: 'Полка',
  icon: 'inbox',
  width: 620,

  mount(root, app) {
    const { api } = app;
    let visible = false;
    const icons = new Map();
    const grid = h('div', { class: 'shelf-grid' });
    const hint = h('div', { class: 'shelf-hint faint', text: 'Файлы остаются на своих местах: полка только помнит, где они лежат.' });
    root.append(grid, hint);

    const dragAll = h('button', {
      class: 'btn small',
      draggable: true,
      title: 'Потяните, чтобы перенести все файлы сразу',
      ondragstart: (e) => {
        e.preventDefault();
        api.send('file:drag', (app.data.shelf || []).map((f) => f.path));
      },
    }, icon('grip-vertical', 13), 'Перетащить все');
    const clearBtn = h('button', {
      class: 'ghost',
      title: 'Очистить полку',
      onclick: async () => {
        app.data.shelf = await api.invoke('shelf:clear');
        paint();
      },
    }, icon('trash-2', 15));

    function ext(name) {
      const m = /\.([a-z0-9]{1,5})$/i.exec(name);
      return m ? m[1].toLowerCase() : '';
    }

    function paint() {
      const files = app.data.shelf || [];
      clear(grid);
      dragAll.hidden = files.length < 2;
      clearBtn.hidden = !files.length;
      app.setHeadNote(files.length ? String(files.length) : '');
      if (!files.length) {
        grid.append(h('div', { class: 'empty shelf-empty' }, icon('inbox', 34),
          h('div', { text: 'Перетащите сюда файлы' }),
          h('div', { class: 'faint', text: 'Потом их можно вытащить в письмо, чат или другую папку, не открывая проводник.' })));
        app.relayout();
        return;
      }
      for (const f of files) {
        const e = ext(f.name);
        const badge = h('span', { class: 'file-badge', style: { background: f.dir ? '#ffcc5a' : EXT_COLORS[e] || '#7d7d8a' } },
          f.dir ? icon('folder-open', 20) : h('b', { text: (e || 'файл').slice(0, 4).toUpperCase() }));
        const tile = h('div', {
          class: 'file',
          draggable: true,
          title: f.path,
          ondragstart: (ev) => {
            ev.preventDefault();
            api.send('file:drag', [f.path]);
          },
          ondblclick: () => api.invoke('open:file', f.path),
        },
        badge,
        h('div', { class: 'file-name', text: f.name }),
        h('div', { class: 'file-size faint', text: f.dir ? 'папка' : fileSize(f.size) }),
        h('div', { class: 'file-actions' },
          h('button', { class: 'ghost', title: 'Показать в папке', onclick: () => api.invoke('open:reveal', f.path) }, icon('folder-open', 13)),
          h('button', {
            class: 'ghost',
            title: 'Убрать с полки',
            onclick: async () => {
              app.data.shelf = await api.invoke('shelf:remove', f.path);
              paint();
            },
          }, icon('x', 13))));
        // the real file icon, when Windows gives one
        if (!icons.has(f.path)) icons.set(f.path, api.invoke('file:icon', f.path).catch(() => null));
        icons.get(f.path).then((url) => {
          if (url && badge.isConnected) badge.replaceWith(h('img', { class: 'file-icon', src: url, alt: '' }));
        });
        grid.append(tile);
      }
      app.relayout();
    }

    app.on('store', (key) => {
      if (key === 'shelf' && visible) paint();
    });

    return {
      actions: [dragAll, clearBtn],
      show() {
        visible = true;
        paint();
      },
      hide() {
        visible = false;
      },
    };
  },
};
