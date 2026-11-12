// Чат: the web chats of AI assistants right in the island. No keys: you sign in
// to your own account, exactly as in a browser. The pages run in their own
// sandbox with their own cookies, apart from the rest of the app.

import { h, clear, icon } from '../ui.js';

const SERVICES = [
  { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/' },
  { id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/app' },
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { id: 'claude', name: 'Claude', url: 'https://claude.ai/new' },
];

export { SERVICES as CHAT_SERVICES };

export default {
  id: 'chat',
  title: 'Чат',
  icon: 'message-circle',
  width: 560,

  mount(root, app) {
    const { api } = app;
    const chips = h('div', { class: 'chat-chips' });
    const stage = h('div', { class: 'chat-stage card' });
    const frames = new Map(); // service id -> <webview>
    root.append(chips, stage);

    function services() {
      const list = [...SERVICES];
      const custom = String(app.settings.chat.custom || '').trim();
      if (/^https:\/\//i.test(custom)) {
        let name = 'Свой';
        try {
          name = new URL(custom).hostname.replace(/^www\./, '');
        } catch {}
        list.push({ id: 'custom', name, url: custom });
      }
      return list;
    }

    function currentService() {
      const list = services();
      return list.find((s) => s.id === app.settings.chat.service) || list[0];
    }

    function frameFor(service) {
      if (frames.has(service.id)) return frames.get(service.id);
      const view = document.createElement('webview');
      view.setAttribute('partition', 'persist:chat');
      view.setAttribute('allowpopups', '');
      view.setAttribute('src', service.url);
      view.className = 'chat-frame';
      view.dataset.service = service.id;
      frames.set(service.id, view);
      stage.append(view);
      return view;
    }

    function paint() {
      const cur = currentService();
      clear(chips, services().map((s) => h('button', {
        class: 'chip' + (s.id === cur.id ? ' on' : ''),
        text: s.name,
        onclick: () => {
          app.set('settings.chat', { ...app.settings.chat, service: s.id });
          paint();
        },
      })));
      // Only the chosen chat is loaded; the others load when first opened.
      const active = frameFor(cur);
      for (const view of frames.values()) view.hidden = view !== active;
      app.relayout();
    }

    const reload = h('button', {
      class: 'ghost',
      title: 'Обновить страницу',
      onclick: () => {
        const view = frames.get(currentService().id);
        try {
          view.reload();
        } catch {}
      },
    }, icon('refresh-cw', 14));
    const popout = h('button', {
      class: 'ghost',
      title: 'Открыть в отдельном окне',
      onclick: () => {
        const view = frames.get(currentService().id);
        let url = currentService().url;
        try {
          url = view.getURL() || url;
        } catch {}
        api.invoke('chat:popout', url);
        app.collapse();
      },
    }, icon('maximize-2', 14));

    return {
      actions: [reload, popout],
      show() {
        paint();
      },
    };
  },
};
