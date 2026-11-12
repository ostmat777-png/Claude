// Буфер: everything copied since the island started. Click to copy it again.

import { h, clear, icon, timeAgo } from '../ui.js';

const ICONS = { link: 'link', color: 'pipette', mail: 'at-sign', image: 'image', text: 'type' };
const KINDS = { link: 'Ссылка', color: 'Цвет', mail: 'Почта', image: 'Картинка', text: 'Текст' };

export default {
  id: 'clipboard',
  title: 'Буфер',
  icon: 'clipboard-list',
  width: 620,

  mount(root, app) {
    const { api } = app;
    let visible = false;
    let query = '';

    const search = h('input', { class: 'field', type: 'text', placeholder: 'Поиск по истории', spellcheck: false });
    const list = h('div', { class: 'clip-list' });
    const foot = h('div', { class: 'clip-foot faint', text: 'Щелчок копирует запись снова. История хранится только в памяти и исчезает при выходе.' });
    root.append(h('div', { class: 'clip-search' }, icon('search', 15), search), list, foot);

    search.addEventListener('input', () => {
      query = search.value.trim().toLowerCase();
      paint();
    });

    const clearBtn = h('button', { class: 'ghost', title: 'Очистить историю (закреплённое останется)', onclick: () => api.invoke('clip:clear') }, icon('trash-2', 15));

    function paint() {
      const items = app.clips.filter((i) => !query || (i.text || '').toLowerCase().includes(query) || (i.kind === 'image' && 'картинка изображение image'.includes(query)));
      items.sort((a, b) => Number(b.pinned) - Number(a.pinned));
      clear(list);
      app.setHeadNote(app.clips.length ? String(app.clips.length) : '');
      if (!items.length) {
        list.append(h('div', { class: 'empty' }, icon('clipboard', 30),
          query ? 'Ничего не нашлось' : 'Пока пусто. Скопируйте текст, ссылку или картинку, и они появятся здесь.'));
        app.relayout();
        return;
      }
      for (const item of items) {
        const body = item.kind === 'image'
          ? h('img', { class: 'clip-image', src: item.thumb, alt: '' })
          : h('div', { class: 'clip-text', text: item.text.length > 400 ? item.text.slice(0, 400) + '…' : item.text });
        const swatch = item.kind === 'color' ? h('span', { class: 'clip-swatch', style: { background: item.text.trim().startsWith('#') || /^(rgb|hsl)/i.test(item.text.trim()) ? item.text.trim() : '#' + item.text.trim() } }) : null;
        const meta = [KINDS[item.kind] || 'Текст', item.kind === 'image' ? `${item.width}×${item.height}` : `${item.size} зн.`, timeAgo(item.time)].join(' · ');
        const row = h('div', {
          class: 'clip' + (item.pinned ? ' pinned' : ''),
          role: 'button',
          tabIndex: 0,
          onclick: async () => {
            await api.invoke('clip:copy', item.id);
            row.classList.add('done');
            setTimeout(() => row.classList.remove('done'), 1000);
          },
          onkeydown: (e) => {
            if (e.key === 'Enter') row.click();
          },
        },
        h('span', { class: 'clip-icon' }, swatch || icon(ICONS[item.kind] || 'type', 15)),
        h('div', { class: 'clip-body' }, body, h('div', { class: 'clip-meta faint', text: meta })),
        h('div', { class: 'clip-actions' },
          item.kind === 'link' ? h('button', {
            class: 'ghost',
            title: 'Открыть ссылку',
            onclick: (e) => {
              e.stopPropagation();
              const url = item.text.trim();
              api.invoke('open:external', /^https?:/i.test(url) ? url : 'https://' + url);
            },
          }, icon('external-link', 14)) : null,
          h('button', {
            class: 'ghost' + (item.pinned ? ' on' : ''),
            title: item.pinned ? 'Открепить' : 'Закрепить: не пропадёт при очистке',
            onclick: (e) => {
              e.stopPropagation();
              api.invoke('clip:pin', item.id);
            },
          }, icon('pin', 14)),
          h('button', {
            class: 'ghost',
            title: 'Удалить',
            onclick: (e) => {
              e.stopPropagation();
              api.invoke('clip:delete', item.id);
            },
          }, icon('x', 14))),
        h('span', { class: 'clip-done' }, icon('check', 15), 'Скопировано'));
        list.append(row);
      }
      app.relayout();
    }

    app.on('clips', () => visible && paint());

    return {
      actions: [clearBtn],
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
