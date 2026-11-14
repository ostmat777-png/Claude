// Текст: fix the keyboard layout, change case, tidy up, encode. One click, and the
// result is already on the clipboard.

import { h, clear, icon, picker } from '../ui.js';
import { TOOLS, stats } from '../../shared/texttools.mjs';
import { LANGUAGES, languageName, guessLanguage } from '../../shared/languages.mjs';

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
        data: { act: 'translate' },
        onclick: () => openTranslate(),
      }, icon('languages', 13), 'Перевести'),
      undoBtn,
      status,
      h('span', { class: 'grow' }),
      counter);

    // ---------------------------------------------------------------- translation, right here
    const tr = { from: 'auto', to: '', busy: false, seq: 0 };
    // the language lists open inside the island, under the bar
    const relayout = () => app.relayout();
    const fromSel = picker({ label: 'С какого языка', options: [['auto', 'Определить язык'], ...LANGUAGES], value: 'auto', onChange: () => runTranslate(), onToggle: (open) => { if (open) toSel.close(); relayout(); } });
    const toSel = picker({ label: 'На какой язык', options: LANGUAGES, value: 'en', onChange: () => runTranslate(), onToggle: (open) => { if (open) fromSel.close(); relayout(); } });
    const swap = h('button', { class: 'ghost', title: 'Поменять языки местами', onclick: () => swapLangs() }, icon('arrow-left-right', 15));
    const result = h('textarea', { class: 'text-area tr-result', readOnly: true, placeholder: 'Здесь появится перевод', spellcheck: false });
    const trNote = h('span', { class: 'faint tr-note' });
    const panel = h('div', { class: 'tr-panel', hidden: true },
      h('div', { class: 'tr-bar' },
        icon('languages', 15), fromSel.el, swap, toSel.el,
        h('span', { class: 'grow' }),
        h('button', { class: 'ghost', title: 'Закрыть перевод', onclick: () => closeTranslate() }, icon('x', 15))),
      fromSel.list, toSel.list,
      result,
      h('div', { class: 'tr-actions' },
        h('button', {
          class: 'btn small',
          data: { act: 'tr-copy' },
          onclick: async () => {
            if (!result.value) return;
            await api.invoke('clip:write', result.value);
            say('Перевод скопирован');
          },
        }, icon('copy', 13), 'Копировать'),
        h('button', {
          class: 'btn small',
          title: 'Поставить перевод на место исходного текста',
          data: { act: 'tr-replace' },
          onclick: () => {
            if (!result.value) return;
            setText(result.value);
            const was = fromSel.value === 'auto' ? guessLanguage(area.value) : fromSel.value;
            toSel.set(was && was !== toSel.value ? was : toSel.value);
            result.value = '';
            trNote.textContent = '';
          },
        }, icon('corner-down-left', 13), 'Заменить текст'),
        trNote));

    function defaultTarget(text) {
      const lang = guessLanguage(text);
      return lang === 'ru' ? 'en' : 'ru';
    }

    function openTranslate() {
      if (!area.value.trim()) return say('Сначала вставьте текст', 'error');
      if (panel.hidden) {
        const saved = app.settings.translate || {};
        fromSel.set('auto');
        // the last language chosen, unless the text is already in it
        const guess = guessLanguage(area.value);
        toSel.set(saved.to && saved.to !== guess ? saved.to : defaultTarget(area.value));
        panel.hidden = false;
        root.classList.add('translating');
      }
      runTranslate();
      app.relayout();
      return undefined;
    }

    function closeTranslate() {
      fromSel.close();
      toSel.close();
      panel.hidden = true;
      root.classList.remove('translating');
      app.relayout();
    }

    function swapLangs() {
      const from = fromSel.value === 'auto' ? guessLanguage(area.value) || 'en' : fromSel.value;
      fromSel.set(toSel.value);
      toSel.set(from);
      if (result.value) {
        setText(result.value);
        result.value = '';
      }
      runTranslate();
    }

    async function runTranslate() {
      const text = area.value;
      if (!text.trim() || panel.hidden) return;
      const mine = ++tr.seq;
      trNote.textContent = 'Перевожу…';
      result.classList.add('busy');
      const res = await api.invoke('translate', text, fromSel.value, toSel.value);
      if (mine !== tr.seq) return; // a newer request is on its way
      result.classList.remove('busy');
      if (!res || !res.ok) {
        trNote.textContent = 'Не получилось перевести: нет связи с сервисом перевода';
        trNote.classList.add('bad');
        return;
      }
      trNote.classList.remove('bad');
      result.value = res.text;
      const from = fromSel.value === 'auto' && res.from && res.from !== 'auto' ? `${languageName(res.from)} (определён)` : languageName(res.from);
      trNote.textContent = `${from} → ${languageName(res.to)} · ${res.service}`;
      app.set('settings.translate', { to: toSel.value });
    }

    // retranslate a moment after typing stops
    let typingTimer = 0;
    area.addEventListener('input', () => {
      if (panel.hidden) return;
      clearTimeout(typingTimer);
      typingTimer = setTimeout(runTranslate, 700);
    });

    root.append(h('div', { class: 'text-top' }, h('div', { class: 'text-left' }, area, panel), tools), bar);

    return {
      show(arg) {
        if (arg && arg.translate && typeof arg.text === 'string') {
          setText(arg.text);
          openTranslate();
          paintCounter();
          return;
        }
        if (arg && typeof arg.text === 'string') {
          setText(arg.text);
          say('Текст с экрана');
        }
        paintCounter();
      },
    };
  },
};
