// Управление: Wi-Fi and its networks, Bluetooth, the dark theme, power.

import { h, clear, icon } from '../ui.js';

const POWER = [
  { id: 'lock', label: 'Блокировка', icon: 'lock' },
  { id: 'sleep', label: 'Сон', icon: 'moon-star' },
  { id: 'restart', label: 'Перезагрузка', icon: 'rotate-cw', confirm: true },
  { id: 'shutdown', label: 'Выключение', icon: 'power', confirm: true },
];

const WIFI_ERRORS = {
  InvalidCredential: 'Пароль не подошёл',
  Timeout: 'Сеть не ответила',
  timeout: 'Сеть не ответила',
  NetworkNotAvailable: 'Сеть недоступна',
  UnsupportedAuthenticationProtocol: 'Эта защита сети не поддерживается',
  'connect-failed': 'Не удалось подключиться',
};

export default {
  id: 'control',
  title: 'Управление',
  icon: 'sliders-horizontal',
  width: 640,

  mount(root, app) {
    const { api } = app;
    let visible = false;
    let radios = { wifi: null, bluetooth: null };
    let showNetworks = false;
    let wifi = null; // { available, reason, connected, networks }
    let wifiBusy = false;
    let askPassword = null; // ssid waiting for a password
    let wifiMessage = '';
    let armed = null; // power button waiting for the second click
    let armedTimer = 0;

    const tiles = h('div', { class: 'ctl-tiles' });
    const networks = h('div', { class: 'ctl-networks card', hidden: true });
    const power = h('div', { class: 'ctl-power' });
    const note = h('div', { class: 'ctl-note faint' });
    root.append(tiles, networks, power, note);

    const supported = () => app.sys.helper;

    function tile({ name, label, state, on, known, onToggle, extra }) {
      return h('div', { class: 'ctl-tile card' + (on ? ' on' : '') + (known ? '' : ' unknown'), data: { tile: name } },
        h('button', { class: 'ctl-toggle', disabled: !known, title: known ? (on ? 'Выключить' : 'Включить') : 'Недоступно на этом компьютере', onclick: onToggle },
          h('span', { class: 'ctl-icon' }, icon(label.icon, 18))),
        extra || null,
        h('div', { class: 'ctl-name', text: label.text }),
        h('div', { class: 'ctl-state faint', text: state }));
    }

    function paintTiles() {
      const wifiOn = radios.wifi === true;
      const btOn = radios.bluetooth === true;
      const connected = wifi && wifi.connected;
      clear(tiles,
        tile({
          name: 'wifi',
          label: { icon: wifiOn ? 'wifi' : 'wifi-off', text: 'Wi-Fi' },
          state: radios.wifi === null ? 'нет адаптера' : wifiOn ? (connected || 'включён') : 'выключен',
          on: wifiOn,
          known: radios.wifi !== null,
          onToggle: () => setRadio('wifi', !wifiOn),
          extra: h('button', {
            class: 'ghost ctl-more' + (showNetworks ? ' on' : ''),
            title: 'Сети Wi-Fi',
            onclick: () => {
              showNetworks = !showNetworks;
              if (showNetworks) loadWifi(false);
              paintNetworks();
            },
          }, icon('list', 14)),
        }),
        tile({
          name: 'bluetooth',
          label: { icon: btOn ? 'bluetooth' : 'bluetooth-off', text: 'Bluetooth' },
          state: radios.bluetooth === null ? 'нет адаптера' : btOn ? 'включён' : 'выключен',
          on: btOn,
          known: radios.bluetooth !== null,
          onToggle: () => setRadio('bluetooth', !btOn),
          extra: h('button', { class: 'ghost ctl-more', title: 'Устройства Bluetooth в параметрах Windows', onclick: () => api.invoke('open:external', 'ms-settings:bluetooth') }, icon('external-link', 14)),
        }),
        tile({
          name: 'theme',
          label: { icon: app.sys.dark ? 'moon' : 'sun', text: 'Тёмная тема' },
          state: app.sys.dark ? 'включена' : 'выключена',
          on: app.sys.dark,
          known: supported(),
          onToggle: async () => {
            try {
              await api.invoke('theme:set', !app.sys.dark);
            } catch {
              say('Тему переключить не удалось');
            }
          },
        }));
    }

    function say(textValue) {
      note.textContent = textValue || (supported() ? '' : 'Переключатели работают только в Windows.');
    }

    async function setRadio(kind, on) {
      try {
        radios = await api.invoke('radio:set', kind, on);
        say('');
      } catch (err) {
        say(/access/i.test(String(err && err.message)) ? 'Windows не разрешила переключить. Откройте параметры Windows.' : 'Не получилось переключить.');
      }
      paintTiles();
      if (kind === 'wifi' && on && showNetworks) setTimeout(() => loadWifi(true), 1500);
    }

    async function loadWifi(scan) {
      wifiBusy = true;
      paintNetworks();
      try {
        wifi = await api.invoke('wifi:list', scan);
      } catch {
        wifi = { available: false, reason: 'error', networks: [] };
      }
      wifiBusy = false;
      paintTiles();
      paintNetworks();
    }

    function bars(n) {
      const el = h('span', { class: 'bars4', title: `Сигнал ${n} из 4` });
      for (let i = 1; i <= 4; i++) el.append(h('i', { class: i <= n ? 'on' : '', style: { height: 3 + i * 3 + 'px' } }));
      return el;
    }

    async function connect(net, password) {
      wifiMessage = `Подключаюсь к «${net.ssid}»…`;
      askPassword = null;
      wifiBusy = true;
      paintNetworks();
      const res = await api.invoke('wifi:connect', net.ssid, password || '').catch(() => ({ ok: false, error: 'error' }));
      wifiBusy = false;
      if (res.ok) {
        wifiMessage = '';
        await loadWifi(false);
        return;
      }
      if (res.needPassword) {
        askPassword = net.ssid;
        wifiMessage = password ? 'Пароль не подошёл, попробуйте ещё раз' : '';
      } else {
        wifiMessage = WIFI_ERRORS[res.error] || 'Не удалось подключиться';
      }
      paintNetworks();
    }

    function paintNetworks() {
      networks.hidden = !showNetworks;
      if (!showNetworks) {
        app.relayout();
        return;
      }
      const head = h('div', { class: 'net-head' },
        h('span', { class: 'label', text: 'Сети Wi-Fi' }),
        h('span', { class: 'faint net-msg ellipsis', text: wifiBusy && !wifiMessage ? 'Ищу сети…' : wifiMessage }),
        h('span', { class: 'grow' }),
        h('button', { class: 'ghost', title: 'Обновить список', disabled: wifiBusy, onclick: () => loadWifi(true) }, icon('refresh-cw', 14)),
        h('button', { class: 'ghost', title: 'Параметры Wi-Fi в Windows', onclick: () => api.invoke('open:external', 'ms-settings:network-wifi') }, icon('external-link', 14)));
      const list = h('div', { class: 'net-list' });
      if (wifi && !wifi.available) {
        // "Denied" from a computer that has no Wi-Fi at all is not about permissions.
        const denied = wifi.reason === 'denied' && radios.wifi !== null;
        list.append(h('div', { class: 'empty' }, icon('wifi-off', 26),
          denied ? 'Windows не показывает программам сети Wi-Fi, пока выключен доступ к местоположению.'
            : wifi.reason === 'not-windows' ? 'Сети Wi-Fi доступны только в Windows.'
              : 'Адаптер Wi-Fi не найден или выключен.',
          denied ? h('button', { class: 'btn small', onclick: () => api.invoke('open:external', 'ms-settings:privacy-location') }, 'Открыть параметры местоположения') : null));
      } else if (wifi) {
        if (!wifi.networks.length && !wifiBusy) list.append(h('div', { class: 'empty', text: 'Сетей не видно. Нажмите «Обновить».' }));
        for (const net of wifi.networks.slice(0, 12)) {
          const row = h('div', { class: 'net' + (net.connected ? ' connected' : '') },
            bars(net.bars || 1),
            h('div', { class: 'net-name' },
              h('span', { class: 'ellipsis', text: net.ssid }),
              net.secure ? icon('lock', 11) : null),
            h('span', { class: 'faint net-kind', text: net.connected ? 'подключено' : net.secure ? 'защищённая' : 'открытая' }),
            h('span', { class: 'grow' }),
            net.connected
              ? h('button', {
                class: 'btn small',
                text: 'Отключить',
                disabled: wifiBusy,
                onclick: async () => {
                  await api.invoke('wifi:disconnect');
                  setTimeout(() => loadWifi(false), 800);
                },
              })
              : h('button', { class: 'btn small primary', text: 'Подключить', disabled: wifiBusy, onclick: () => connect(net, '') }));
          list.append(row);
          if (askPassword === net.ssid) {
            const input = h('input', { class: 'field', type: 'password', placeholder: 'Пароль сети', autocomplete: 'off' });
            const go = () => input.value && connect(net, input.value);
            input.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') go();
              if (e.key === 'Escape') {
                e.stopPropagation();
                askPassword = null;
                paintNetworks();
              }
            });
            list.append(h('div', { class: 'net-pass' }, input, h('button', { class: 'btn small primary', text: 'Войти', onclick: go })));
            setTimeout(() => input.focus(), 30);
          }
        }
      }
      clear(networks, head, list);
      app.relayout();
    }

    function paintPower() {
      clear(power, POWER.map((p) => h('button', {
        class: 'ctl-power-btn card' + (armed === p.id ? ' armed' : ''),
        disabled: !supported(),
        data: { power: p.id },
        onclick: async () => {
          if (p.confirm && armed !== p.id) {
            armed = p.id;
            clearTimeout(armedTimer);
            armedTimer = setTimeout(() => {
              armed = null;
              paintPower();
            }, 3500);
            paintPower();
            return;
          }
          armed = null;
          paintPower();
          await api.invoke('action', p.id);
        },
      }, icon(p.icon, 18), h('span', { text: armed === p.id ? 'Точно? Нажмите ещё раз' : p.label }))));
    }

    app.on('theme', () => visible && paintTiles());

    return {
      async show() {
        visible = true;
        say('');
        paintTiles();
        paintNetworks();
        paintPower();
        radios = await api.invoke('radio:get').catch(() => ({ wifi: null, bluetooth: null }));
        if (!visible) return;
        paintTiles();
        if (showNetworks) loadWifi(false);
        else if (radios.wifi) {
          // just the name of the current network for the tile; no scan
          api.invoke('wifi:list', false).then((r) => {
            wifi = r;
            if (visible) paintTiles();
          }).catch(() => {});
        }
      },
      hide() {
        visible = false;
        armed = null;
        askPassword = null;
      },
    };
  },
};
