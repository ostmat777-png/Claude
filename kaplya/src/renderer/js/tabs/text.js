// Текст: fix the keyboard layout, change case, tidy up, encode. One click, and the
// result is already on the clipboard.

import { h, clear, icon } from '../ui.js';
import { TOOLS, stats } from '../../shared/texttools.mjs';

export default {
  id: 'text',
  title: 'Текст',
  icon: 'type',
  width: 700,

  mount(root, app) {
    const { api } = app;
    const history = [];
    let statusTimer = 0;

    const area = h('textarea', { class: 'text-area', placeholder: 'Вставьте или напишите текст, затем выберите действие справа', spellcheck: false });
    const status = h('span', { class: 'text-status' });
    const counter = h('span', { class: 'faint text-counter' });
    const undoBtn = h('button', { class: 'ghost', title: 'Вернуть как было', disabled: true, onclick: undo }, icon('undo-2', 15));

    function paintCounter() {
      const s = stats(area.value);
      counter.textContent = area.value ? `${s.chars} зн. · ${s.words} сл. · ${s.lines} стр.` : '';
      counter.title = area.value ? `Знаков: ${s.chars}, без пробелов: ${s.noSpaces}, слов: ${s.words}, строк: ${s.lines}` : '';
    }

    function say(textValue, kind) {
      clearTimeout(statusTimer);
      clear(status, textValue ? icon(kind === 'error' ? 'triangle-alert' : 'check', 13) : null, textValue || '');
      status.className = 'text-status ' + (kind || '');
      if (textValue) statusTimer = setTimeout(() => clear(status), 3200);
    }

    function setText(value) {
      history.push(area.value);
      if (history.length > 30) history.shift();
      undoBtn.disabled = false;
      area.value = value;
      paintCounter();
    }

    function undo() {
      if (!history.length) return;
      area.value = history.pop();
      undoBtn.disabled = !history.length;
      paintCounter();
      say('');
    }

    async function apply(tool) {
      let source = area.value;
      if (!source.trim()) {
        // nothing typed: work on what is in the clipboard
        source = (await api.invoke('clip:read')) || '';
        if (!source.trim()) return say('Сначала вставьте текст', 'error');
      }
      // only the selected part, if something is selected
      const a = area.selectionStart;
      const b = area.selectionEnd;
      const partial = area.value && b > a;
      try {
        const piece = partial ? source.slice(a, b) : source;
        const out = tool.fn(piece);
        const result = partial ? source.slice(0, a) + out + source.slice(b) : out;
        setText(result);
        if (partial) area.setSelectionRange(a, a + out.length);
        await api.invoke('clip:write', result);
        say('Готово, уже в буфере');
      } catch {
        say(tool.error || 'Не получилось', 'error');
      }
    }

    const tools = h('div', { class: 'text-tools' }, TOOLS.map((tool) => h('button', {
      class: 'btn small',
      title: tool.hint ? `${tool.label}: ${tool.hint}` : tool.label,
      data: { tool: tool.id },
      text: tool.short || tool.label,
      onclick: () => apply(tool),
    })));

    area.addEventListener('input', paintCounter);

    const bar = h('div', { class: 'text-bar' },
      h('button', {
        class: 'btn small',
        title: 'Вставить из буфера обмена',
        onclick: async () => {
          const t = await api.invoke('clip:read');
          if (t) setText(t);
          else say('В буфере нет текста', 'error');
        },
      }, icon('clipboard-paste', 13), 'Вставить'),
      h('button', {
        class: 'btn small',
        title: 'Скопировать текст',
        onclick: async () => {
          if (!area.value) return;
          await api.invoke('clip:write', area.value);
          say('Скопировано');
        },
      }, icon('copy', 13), 'Копировать'),
      h('button', {
        class: 'btn small',
        title: 'Открыть перевод в браузере',
        onclick: () => area.value.trim() && app.translate(area.value),
      }, icon('languages', 13), 'Перевести'),
      undoBtn,
      status,
      h('span', { class: 'grow' }),
      counter);

    root.append(h('div', { class: 'text-top' }, area, tools), bar);

    return {
      show(arg) {
        if (arg && typeof arg.text === 'string') {
          setText(arg.text);
          say('Текст с экрана');
        }
        paintCounter();
      },
    };
  },
};
