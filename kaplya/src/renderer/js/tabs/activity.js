// Активность: how long each program was in front today, yesterday, this week.

import { h, clear, icon, segment } from '../ui.js';
import { colorFor } from '../common.js';

/** 5400000 -> "1 ч 30 мин", 45000 -> "1 мин", 20000 -> "< 1 мин" */
export function spent(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return '< 1 мин';
  if (m < 60) return `${m} мин`;
  const hrs = Math.floor(m / 60);
  return m % 60 ? `${hrs} ч ${m % 60} мин` : `${hrs} ч`;
}

const RANGES = [['today', 'Сегодня'], ['yesterday', 'Вчера'], ['week', 'Неделя']];

export default {
  id: 'activity',
  title: 'Активность',
  icon: 'chart-no-axes-column',
  width: 640,

  mount(root, app) {
    const { api } = app;
    let visible = false;
    let range = 'today';
    let timer = 0;
    let showAll = false;
    const icons = new Map();

    const seg = segment(RANGES, range, (v) => {
      range = v;
      showAll = false;
      load();
    });
    const summary = h('div', { class: 'act-summary' });
    const chartBox = h('div', { class: 'act-chart card' });
    const list = h('div', { class: 'act-list card' });
    root.append(h('div', { class: 'act-top' }, summary, seg), chartBox, list);

    function iconFor(a) {
      if (!a.path) return Promise.resolve(null);
      if (!icons.has(a.path)) icons.set(a.path, api.invoke('activity:icon', a.path).catch(() => null));
      return icons.get(a.path);
    }

    function paintChart(r) {
      // today and yesterday: by hour; the week: by day
      const values = range === 'week' ? r.perDay.map((d) => d.ms) : r.hours;
      const labels = range === 'week'
        ? r.perDay.map((d) => new Date(d.day + 'T12:00:00').toLocaleDateString('ru-RU', { weekday: 'short' }))
        : r.hours.map((_, i) => (i % 3 === 0 ? String(i) : ''));
      const max = Math.max(1, ...values);
      const nowHour = new Date().getHours();
      clear(chartBox, h('div', { class: 'act-bars' + (range === 'week' ? ' week' : '') }, values.map((v, i) => h('div', {
        class: 'act-col' + (range === 'today' && i === nowHour ? ' now' : ''),
        title: (range === 'week' ? labels[i] : `${i}:00–${i + 1}:00`) + ' · ' + spent(v),
      },
      h('div', { class: 'act-bar-wrap' }, h('div', { class: 'act-bar', style: { height: Math.max(v ? 3 : 0, Math.round((v / max) * 100)) + '%' } })),
      h('span', { class: 'act-label', text: labels[i] })))));
    }

    function paintList(r) {
      clear(list);
      if (!r.apps.length) {
        list.append(h('div', { class: 'empty' }, icon('chart-no-axes-column', 28),
          app.settings.activity === false ? 'Подсчёт выключен в настройках.'
            : range === 'today' ? 'Пока пусто. Время появится, как только вы поработаете в какой-нибудь программе.'
              : 'За это время ничего не записано.'));
        return;
      }
      const top = r.apps[0].ms;
      const shown = showAll ? r.apps : r.apps.slice(0, 7);
      for (const a of shown) {
        const pct = r.total ? Math.round((a.ms / r.total) * 100) : 0;
        const letter = h('span', { class: 'act-letter', style: { background: colorFor(a.name) }, text: (a.name || '?').charAt(0).toUpperCase() });
        const row = h('div', { class: 'act-row' + (r.now && r.now.key === a.key && range === 'today' ? ' live' : ''), title: a.path || a.exe },
          letter,
          h('div', { class: 'act-body' },
            h('div', { class: 'act-line' }, h('span', { class: 'ellipsis', text: a.name }), h('span', { class: 'grow' }),
              h('b', { text: spent(a.ms) }), h('span', { class: 'faint act-pct', text: pct + '%' })),
            h('div', { class: 'act-track' }, h('div', { class: 'act-fill', style: { width: Math.max(2, (a.ms / top) * 100) + '%', background: colorFor(a.name) } }))));
        iconFor(a).then((url) => {
          if (url && letter.isConnected) letter.replaceWith(h('img', { class: 'act-icon', src: url, alt: '' }));
        });
        list.append(row);
      }
      if (r.apps.length > 7) {
        list.append(h('button', {
          class: 'btn small act-more',
          text: showAll ? 'Свернуть' : `Ещё ${r.apps.length - 7}`,
          onclick: () => {
            showAll = !showAll;
            paintList(r);
            app.relayout();
          },
        }));
      }
    }

    async function load() {
      const r = await api.invoke('activity:report', range);
      if (!visible) return;
      const days = range === 'week' ? r.perDay.filter((d) => d.ms > 0).length : 1;
      clear(summary,
        h('div', { class: 'act-total', text: r.total ? spent(r.total) : '0 мин' }),
        h('div', { class: 'faint', text: range === 'week' && days > 1 ? `в среднем ${spent(r.total / days)} в день` : r.now && range === 'today' ? `сейчас: ${r.now.name}` : 'за компьютером' }));
      paintChart(r);
      paintList(r);
      app.setHeadNote(range === 'today' ? 'без простоя' : '');
      app.relayout();
    }

    const clearBtn = h('button', {
      class: 'ghost',
      title: 'Стереть историю активности',
      onclick: async () => {
        if (clearBtn.dataset.armed !== '1') {
          clearBtn.dataset.armed = '1';
          clearBtn.title = 'Нажмите ещё раз, чтобы стереть всё';
          clearBtn.classList.add('armed');
          setTimeout(() => {
            clearBtn.dataset.armed = '';
            clearBtn.title = 'Стереть историю активности';
            clearBtn.classList.remove('armed');
          }, 3000);
          return;
        }
        await api.invoke('activity:clear');
        clearBtn.dataset.armed = '';
        clearBtn.classList.remove('armed');
        load();
      },
    }, icon('trash-2', 15));

    return {
      actions: [clearBtn],
      show() {
        visible = true;
        load();
        clearInterval(timer);
        timer = setInterval(load, 15000);
      },
      hide() {
        visible = false;
        clearInterval(timer);
      },
    };
  },
};
