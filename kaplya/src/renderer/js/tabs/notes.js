// Заметки: a few plain notes, a countdown timer and reminders.

import { h, clear, icon, debounce } from '../ui.js';
import { clock } from '../timer.js';
import { parseReminder, describeTime } from '../../shared/remind.mjs';

const PRESETS = [5, 10, 15, 25, 45];
const RING = 2 * Math.PI * 34;

export default {
  id: 'notes',
  title: 'Заметки',
  icon: 'notebook-pen',
  width: 700,

  mount(root, app) {
    let visible = false;

    // ---------------------------------------------------------------- notes
    const chips = h('div', { class: 'note-chips' });
    const area = h('textarea', { class: 'note-area', placeholder: 'Запишите мысль, список дел или что угодно. Сохраняется само.', spellcheck: false });

    const notesOf = () => (Array.isArray(app.data.notes) && app.data.notes.length ? app.data.notes : [{ id: 'n1', text: '' }]);
    const activeId = () => (notesOf().some((n) => n.id === app.data.activeNote) ? app.data.activeNote : notesOf()[0].id);
    const titleOf = (n, i) => (n.text.trim().split('\n')[0] || `Заметка ${i + 1}`).slice(0, 18);

    const save = debounce(() => {
      const list = notesOf().map((n) => (n.id === activeId() ? { ...n, text: area.value } : n));
      app.set('notes', list);
      paintChips();
    }, 350);
    area.addEventListener('input', save);

    function paintChips() {
      const list = notesOf();
      const cur = activeId();
      clear(chips);
      list.forEach((n, i) => {
        chips.append(h('button', {
          class: 'chip' + (n.id === cur ? ' on' : ''),
          onclick: () => {
            save.flush();
            app.set('activeNote', n.id);
            paintNotes();
          },
        },
        h('span', { class: 'ellipsis', text: titleOf(n, i) }),
        list.length > 1 && n.id === cur ? h('span', {
          class: 'chip-x',
          title: 'Удалить заметку',
          onclick: (e) => {
            e.stopPropagation();
            const rest = notesOf().filter((x) => x.id !== n.id);
            app.set('notes', rest);
            app.set('activeNote', rest[0].id);
            paintNotes();
          },
        }, icon('x', 10, 3)) : null));
      });
      if (list.length < 8) {
        chips.append(h('button', {
          class: 'chip add',
          title: 'Новая заметка',
          onclick: () => {
            save.flush();
            const id = 'n' + Date.now();
            app.set('notes', [...notesOf(), { id, text: '' }]);
            app.set('activeNote', id);
            paintNotes();
            area.focus();
          },
        }, icon('plus', 13)));
      }
    }

    function paintNotes() {
      const note = notesOf().find((n) => n.id === activeId());
      if (document.activeElement !== area || area.value !== note.text) area.value = note.text;
      paintChips();
    }

    // ---------------------------------------------------------------- timer
    const ringArc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ring.setAttribute('viewBox', '0 0 80 80');
    ring.classList.add('timer-ring');
    ring.innerHTML = '<circle cx="40" cy="40" r="34" class="ring-back"/>';
    for (const [k, v] of Object.entries({ cx: 40, cy: 40, r: 34, class: 'ring-front', 'stroke-dasharray': RING, transform: 'rotate(-90 40 40)' })) ringArc.setAttribute(k, v);
    ring.append(ringArc);
    const timeText = h('div', { class: 'timer-time' });
    const startBtn = h('button', { class: 'btn primary small timer-start' });
    const resetBtn = h('button', { class: 'ghost', title: 'Сбросить', onclick: () => app.timer.reset() }, icon('rotate-ccw', 14));
    const presets = h('div', { class: 'timer-presets' });
    const custom = h('input', { class: 'field timer-custom', type: 'number', min: 1, max: 600, placeholder: 'мин', title: 'Своё время в минутах, Enter' });
    custom.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const m = Number(custom.value);
      if (m > 0 && m <= 600) {
        app.timer.start(m * 60);
        custom.value = '';
      }
    });
    startBtn.addEventListener('click', () => (app.timer.running ? app.timer.pause() : app.timer.start()));

    function paintTimer() {
      const t = app.timer;
      const left = t.remaining();
      timeText.textContent = clock(left);
      ringArc.setAttribute('stroke-dashoffset', String(RING * (1 - Math.max(0, Math.min(1, left / t.total)))));
      clear(startBtn, icon(t.running ? 'pause' : 'play', 13, 2.4), t.running ? 'Пауза' : left < t.total ? 'Дальше' : 'Старт');
      resetBtn.disabled = !t.active;
      clear(presets, PRESETS.map((m) => h('button', {
        class: 'chip' + (!t.active && t.total === m * 60 ? ' on' : ''),
        text: String(m),
        title: `${m} минут`,
        onclick: () => app.timer.set(m * 60),
      })));
    }

    // ---------------------------------------------------------------- reminders
    const remindInput = h('input', { class: 'field', type: 'text', placeholder: 'через 20 минут позвонить Ане', spellcheck: false });
    const remindHint = h('div', { class: 'remind-hint faint' });
    const remindList = h('div', { class: 'remind-list' });

    function previewReminder() {
      const r = remindInput.value.trim() ? parseReminder(remindInput.value) : null;
      remindHint.textContent = !remindInput.value.trim()
        ? 'Примеры: «в 15:30 созвон», «завтра в 9 таблетки»'
        : r ? `Напомню ${describeTime(r.at)}: ${r.text}. Enter` : 'Не понял время. Напишите «через 10 минут …» или «в 18:00 …»';
      remindHint.classList.toggle('ok', Boolean(r));
    }
    remindInput.addEventListener('input', previewReminder);
    remindInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const r = parseReminder(remindInput.value);
      if (!r) return;
      app.addReminder(r.at, r.text);
      remindInput.value = '';
      previewReminder();
      paintReminders();
    });

    function paintReminders() {
      const list = (app.data.reminders || []).slice().sort((a, b) => Number(a.fired) - Number(b.fired) || a.at - b.at);
      clear(remindList);
      for (const r of list.slice(0, 6)) {
        remindList.append(h('div', { class: 'remind' + (r.fired ? ' fired' : '') },
          icon(r.fired ? 'check' : 'bell', 13),
          h('div', { class: 'remind-body' },
            h('div', { class: 'ellipsis', text: r.text }),
            h('div', { class: 'faint', text: describeTime(r.at) })),
          h('button', {
            class: 'ghost',
            title: 'Удалить',
            onclick: () => {
              app.set('reminders', (app.data.reminders || []).filter((x) => x.id !== r.id));
              paintReminders();
              app.relayout();
            },
          }, icon('x', 13))));
      }
      app.relayout();
    }

    root.append(
      h('div', { class: 'notes-left card' }, chips, area),
      h('div', { class: 'notes-right' },
        h('div', { class: 'timer card' },
          h('div', { class: 'timer-face' }, ring, timeText),
          h('div', { class: 'timer-side' },
            h('div', { class: 'timer-buttons' }, startBtn, resetBtn),
            h('div', { class: 'timer-row' }, presets),
            custom)),
        h('div', { class: 'reminders card' },
          h('div', { class: 'label', text: 'Напоминания' }),
          remindInput, remindHint, remindList)));

    app.on('timer', () => visible && paintTimer());
    app.on('store', (key) => {
      if (!visible) return;
      if (key === 'reminders') paintReminders();
      if (key === 'notes' && document.activeElement !== area) paintNotes();
    });

    return {
      show() {
        visible = true;
        paintNotes();
        paintTimer();
        previewReminder();
        paintReminders();
      },
      hide() {
        visible = false;
        save.flush();
      },
    };
  },
};
