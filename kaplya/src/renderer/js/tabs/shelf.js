// Полка: drop files on the island, take them out later, wherever you need them.
// Pictures and videos show what is in them, like in Explorer. Several files can
// be selected (click, Ctrl, Shift, Ctrl+A, or a frame drawn with the mouse) and
// dragged out, opened or removed together.

import { h, clear, icon, fileSize } from '../ui.js';

const EXT_COLORS = { pdf: '#ff5a5a', png: '#4aa3ff', jpg: '#4aa3ff', jpeg: '#4aa3ff', gif: '#4aa3ff', webp: '#4aa3ff', zip: '#ffb84a', rar: '#ffb84a', '7z': '#ffb84a', doc: '#4a7dff', docx: '#4a7dff', xls: '#3fbf7f', xlsx: '#3fbf7f', csv: '#3fbf7f', mp4: '#c47dff', mov: '#c47dff', mp3: '#ff7db8', txt: '#9a9aa6' };

export default {
  id: 'shelf',
  title: 'Полка',
  icon: 'inbox',
  width: 640,

  mount(root, app) {
    const { api } = app;
    let visible = false;
    const thumbs = new Map(); // path -> Promise<{ url, preview }>
    const selected = new Set();
    let anchor = null; // where a Shift-click range starts

    const grid = h('div', { class: 'shelf-grid', tabIndex: 0 });
    const band = h('div', { class: 'shelf-band', hidden: true });
    const wrap = h('div', { class: 'shelf-wrap' }, grid, band);
    const status = h('div', { class: 'shelf-hint faint' });
    root.append(wrap, status);

    const files = () => app.data.shelf || [];
    const pathsOf = (list) => list.map((f) => f.path);
    /** What a drag or a button acts on: the selection, or everything if nothing is selected. */
    const chosen = () => (selected.size ? files().filter((f) => selected.has(f.path)) : files());

    const dragBtn = h('button', {
      class: 'btn small',
      draggable: true,
      ondragstart: (e) => {
        e.preventDefault();
        api.send('file:drag', pathsOf(chosen()));
      },
    }, icon('grip-vertical', 13), h('span'));
    const addBtn = h('button', {
      class: 'ghost',
      title: 'Положить файлы на полку',
      onclick: async () => {
        app.data.shelf = await api.invoke('shelf:pick');
        paint();
      },
    }, icon('plus', 15));
    const removeBtn = h('button', {
      class: 'ghost',
      onclick: async () => {
        if (selected.size) {
          app.data.shelf = await api.invoke('shelf:removeMany', [...selected]);
          selected.clear();
        } else {
          app.data.shelf = await api.invoke('shelf:clear');
        }
        paint();
      },
    }, icon('trash-2', 15));

    function ext(name) {
      const m = /\.([a-z0-9]{1,5})$/i.exec(name);
      return m ? m[1].toLowerCase() : '';
    }

    function thumbFor(file) {
      if (!thumbs.has(file.path)) thumbs.set(file.path, api.invoke('file:thumb', file.path).catch(() => null));
      return thumbs.get(file.path);
    }

    // ---------------------------------------------------------------- selection

    function select(path, e) {
      const list = pathsOf(files());
      if (e.shiftKey && anchor && list.includes(anchor)) {
        const a = list.indexOf(anchor);
        const b = list.indexOf(path);
        if (!(e.ctrlKey || e.metaKey)) selected.clear();
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(list[i]);
      } else if (e.ctrlKey || e.metaKey) {
        if (selected.has(path)) selected.delete(path);
        else selected.add(path);
        anchor = path;
      } else {
        selected.clear();
        selected.add(path);
        anchor = path;
      }
      paintSelection();
    }

    function paintSelection() {
      for (const tile of grid.querySelectorAll('.file')) tile.classList.toggle('selected', selected.has(tile.dataset.path));
      const n = selected.size;
      const all = files().length;
      dragBtn.hidden = !all;
      dragBtn.title = n ? 'Потяните, чтобы перенести выбранные файлы' : 'Потяните, чтобы перенести все файлы сразу';
      dragBtn.lastChild.textContent = n ? `Перетащить ${n}` : 'Перетащить все';
      removeBtn.hidden = !all;
      removeBtn.title = n ? 'Убрать выбранные с полки' : 'Очистить полку';
      status.textContent = !all ? ''
        : n ? `Выбрано: ${n} из ${all}. Потяните любой из них, чтобы перенести все выбранные. Esc — снять выбор.`
          : 'Щелчок выбирает файл, Ctrl и Shift — несколько, можно обвести рамкой. Файлы остаются на своих местах.';
      app.setHeadNote(all ? String(all) : '');
    }

    // a frame drawn on the empty space selects what it touches
    let bandFrom = null;
    grid.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.file')) return;
      const r = wrap.getBoundingClientRect();
      bandFrom = { x: e.clientX - r.left, y: e.clientY - r.top + grid.scrollTop, add: e.ctrlKey || e.metaKey, base: new Set(selected) };
      if (!bandFrom.add) selected.clear();
      grid.setPointerCapture(e.pointerId);
      paintSelection();
    });
    grid.addEventListener('pointermove', (e) => {
      if (!bandFrom) return;
      const r = wrap.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top + grid.scrollTop;
      const box = { x: Math.min(x, bandFrom.x), y: Math.min(y, bandFrom.y), w: Math.abs(x - bandFrom.x), h: Math.abs(y - bandFrom.y) };
      if (box.w + box.h < 6) return;
      band.hidden = false;
      Object.assign(band.style, { left: box.x + 'px', top: box.y - grid.scrollTop + 'px', width: box.w + 'px', height: box.h + 'px' });
      selected.clear();
      if (bandFrom.add) for (const p of bandFrom.base) selected.add(p);
      for (const tile of grid.querySelectorAll('.file')) {
        const t = tile.getBoundingClientRect();
        const tx = t.left - r.left;
        const ty = t.top - r.top + grid.scrollTop;
        if (tx < box.x + box.w && tx + t.width > box.x && ty < box.y + box.h && ty + t.height > box.y) selected.add(tile.dataset.path);
      }
      paintSelection();
    });
    const endBand = () => {
      bandFrom = null;
      band.hidden = true;
    };
    grid.addEventListener('pointerup', endBand);
    grid.addEventListener('pointercancel', endBand);

    grid.addEventListener('keydown', async (e) => {
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyA') {
        e.preventDefault();
        for (const f of files()) selected.add(f.path);
        paintSelection();
      } else if (e.key === 'Escape' && selected.size) {
        e.preventDefault();
        e.stopPropagation();
        selected.clear();
        paintSelection();
      } else if (e.key === 'Delete' && selected.size) {
        e.preventDefault();
        app.data.shelf = await api.invoke('shelf:removeMany', [...selected]);
        selected.clear();
        paint();
      } else if (e.key === 'Enter' && selected.size) {
        e.preventDefault();
        for (const p of selected) api.invoke('open:file', p);
      }
    });

    // ---------------------------------------------------------------- tiles

    function paint() {
      const list = files();
      for (const p of [...selected]) if (!list.some((f) => f.path === p)) selected.delete(p);
      clear(grid);
      if (!list.length) {
        grid.append(h('div', { class: 'empty shelf-empty' }, icon('inbox', 34),
          h('div', { text: 'Перетащите сюда файлы' }),
          h('div', { class: 'faint', text: 'Потом их можно вытащить в письмо, чат или другую папку, не открывая проводник.' }),
          h('button', {
            class: 'btn small',
            onclick: async () => {
              app.data.shelf = await api.invoke('shelf:pick');
              paint();
            },
          }, icon('plus', 13), 'Выбрать файлы…')));
        paintSelection();
        app.relayout();
        return;
      }
      for (const f of list) {
        const e = ext(f.name);
        const badge = h('span', { class: 'file-badge', style: { background: f.dir ? '#ffcc5a' : EXT_COLORS[e] || '#7d7d8a' } },
          f.dir ? icon('folder-open', 20) : h('b', { text: (e || 'файл').slice(0, 4).toUpperCase() }));
        const art = h('div', { class: 'file-art' }, badge);
        const tile = h('div', {
          class: 'file',
          draggable: true,
          title: f.path,
          data: { path: f.path },
          onclick: (ev) => select(f.path, ev),
          ondragstart: (ev) => {
            ev.preventDefault();
            // dragging one of the selected takes all of them along
            if (!selected.has(f.path)) {
              selected.clear();
              selected.add(f.path);
              anchor = f.path;
              paintSelection();
            }
            api.send('file:drag', pathsOf(files().filter((x) => selected.has(x.path))));
          },
          ondblclick: () => api.invoke('open:file', f.path),
        },
        art,
        h('div', { class: 'file-name', text: f.name }),
        h('div', { class: 'file-size faint', text: f.dir ? 'папка' : fileSize(f.size) }),
        h('div', { class: 'file-actions' },
          h('button', {
            class: 'ghost',
            title: 'Показать в папке',
            onclick: (ev) => {
              ev.stopPropagation();
              api.invoke('open:reveal', f.path);
            },
          }, icon('folder-open', 13)),
          h('button', {
            class: 'ghost',
            title: 'Убрать с полки',
            onclick: async (ev) => {
              ev.stopPropagation();
              selected.delete(f.path);
              app.data.shelf = await api.invoke('shelf:remove', f.path);
              paint();
            },
          }, icon('x', 13))));
        thumbFor(f).then((t) => {
          if (!t || !t.url || !art.isConnected) return;
          clear(art, h('img', { class: t.preview ? 'file-preview' : 'file-icon', src: t.url, alt: '', draggable: false }));
          art.classList.toggle('preview', Boolean(t.preview));
        });
        grid.append(tile);
      }
      paintSelection();
      app.relayout();
    }

    app.on('store', (key) => {
      if (key === 'shelf' && visible) paint();
    });

    return {
      actions: [addBtn, dragBtn, removeBtn],
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
