// The command line (Alt+Space): type, pick with the arrows, Enter.

import { h, clear, icon, debounce } from './ui.js';

export function setupCommand(app, hooks) {
  const { api } = app;
  const input = document.querySelector('#command-input');
  const list = document.querySelector('#command-list');
  let rows = [];
  let selected = 0;
  let seq = 0;
  let armed = -1; // row waiting for a second Enter (restart, shut down)

  function render() {
    clear(list);
    rows.forEach((row, i) => {
      const art = row.image
        ? h('span', { class: 'cmd-art' }, h('img', { src: row.image, alt: '' }))
        : h('span', { class: 'cmd-art' }, icon(row.icon || 'circle', 18));
      const sub = armed === i ? 'Нажмите Enter ещё раз, чтобы подтвердить' : row.subtitle;
      list.append(h('div', {
        class: 'cmd' + (row.type === 'calc' ? ' calc' : ''),
        role: 'option',
        'aria-selected': String(i === selected),
        onmousemove: () => {
          if (selected !== i) {
            selected = i;
            paintSelection();
          }
        },
        onclick: () => run(i),
      },
      art,
      h('span', { class: 'cmd-title ellipsis', text: row.title }),
      sub ? h('span', { class: 'cmd-sub ellipsis', text: sub }) : null,
      h('span', { class: 'grow' }),
      h('kbd', { text: 'Enter' })));
    });
    hooks.relayout();
  }

  function paintSelection() {
    [...list.children].forEach((node, i) => node.setAttribute('aria-selected', String(i === selected)));
  }

  async function query() {
    const mine = ++seq;
    let result = [];
    try {
      result = await api.invoke('palette:query', input.value);
    } catch {
      result = [];
    }
    if (mine !== seq) return; // a newer keystroke is already being answered
    rows = result || [];
    selected = 0;
    armed = -1;
    render();
  }

  async function run(i) {
    const row = rows[i];
    if (!row) return;
    if (row.confirm && armed !== i) {
      armed = i;
      selected = i;
      render();
      return;
    }
    hooks.close();
    switch (row.type) {
      case 'action':
        await api.invoke('action', row.id);
        break;
      case 'calc':
        await api.invoke('clip:write', row.copy);
        app.toast({ type: 'info', icon: 'calculator', title: row.title, text: 'Результат скопирован', quiet: true });
        break;
      case 'timer':
        app.timer.start(row.minutes * 60);
        app.toast({ type: 'info', icon: 'timer', title: row.title, text: 'Отсчёт пошёл', quiet: true });
        break;
      case 'remind':
        app.addReminder(row.at, row.text);
        app.toast({ type: 'info', icon: 'bell', title: 'Напомню ' + row.subtitle, text: row.text, quiet: true });
        break;
      case 'url':
        await api.invoke('open:external', row.url);
        break;
      case 'app': {
        const ok = await api.invoke('palette:app', row.kind, row.target);
        if (!ok) app.toast({ type: 'error', title: 'Не получилось запустить', text: row.title });
        break;
      }
      default:
    }
  }

  input.addEventListener('input', debounce(query, 70));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      if (rows.length) selected = (selected + 1) % rows.length;
      armed = -1;
      render();
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      if (rows.length) selected = (selected - 1 + rows.length) % rows.length;
      armed = -1;
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(selected);
    }
  });

  return {
    open() {
      input.value = '';
      rows = [];
      armed = -1;
      render();
      query();
      api.send('island:focusme');
      requestAnimationFrame(() => input.focus());
    },
    close() {
      seq++;
      input.blur();
    },
  };
}
