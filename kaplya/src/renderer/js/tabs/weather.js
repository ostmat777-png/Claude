// Погода: now, the coming hours or the week, and six small tiles.

import { h, clear, icon, segment, debounce } from '../ui.js';
import { weatherTint } from '../common.js';
import { describeCode, windName, uvLevel, formatTemp, sunProgress } from '../../shared/weather.mjs';

const SVG = 'http://www.w3.org/2000/svg';

function svg(markup, viewBox, cls) {
  const el = document.createElementNS(SVG, 'svg');
  el.setAttribute('viewBox', viewBox);
  if (cls) el.setAttribute('class', cls);
  el.innerHTML = markup;
  return el;
}

function weatherIcon(code, isDay, size) {
  const d = describeCode(code, isDay);
  const ic = icon(d.icon, size);
  ic.style.color = weatherTint(d.icon);
  return ic;
}

const hm = (iso) => String(iso || '').slice(11, 16);

export default {
  id: 'weather',
  title: 'Погода',
  icon: 'cloud-sun',
  width: 720,

  mount(root, app) {
    const { api } = app;
    let visible = false;
    let range = 'hours';
    let picking = false;

    const refreshBtn = h('button', { class: 'ghost', title: 'Обновить', onclick: () => app.refreshWeather(true) }, icon('refresh-cw', 14));
    const placeBtn = h('button', {
      class: 'ghost',
      title: 'Выбрать другой город',
      onclick: () => {
        picking = !picking;
        paint();
      },
    }, icon('map-pin', 14));

    // ---------------------------------------------------------------- choosing a place
    function placePicker() {
      const input = h('input', { class: 'field', type: 'text', placeholder: 'Город, например: Казань', spellcheck: false });
      const results = h('div', { class: 'place-results' });
      const status = h('div', { class: 'faint place-status' });

      const choose = (p) => {
        picking = false;
        app.set('settings.weather', { place: p, askedOnce: true });
      };
      const search = debounce(async () => {
        const q = input.value.trim();
        if (q.length < 2) return clear(results);
        status.textContent = 'Ищу…';
        const list = await api.invoke('weather:search', q);
        status.textContent = list.length ? '' : 'Ничего не нашлось. Проверьте название и интернет.';
        clear(results, list.map((p) => h('button', { class: 'place', onclick: () => choose(p) },
          icon('map-pin', 14), h('b', { text: p.name }), h('span', { class: 'faint ellipsis', text: p.region }))));
        app.relayout();
      }, 300);
      input.addEventListener('input', search);

      const auto = h('button', {
        class: 'btn small',
        title: 'Примерное место по вашему IP-адресу. Запрос уйдёт на сайт ipwho.is',
        onclick: async () => {
          status.textContent = 'Определяю…';
          const p = await api.invoke('weather:locate');
          if (p) choose(p);
          else status.textContent = 'Не получилось определить. Введите город вручную.';
        },
      }, icon('navigation', 13), 'Определить по IP');

      setTimeout(() => visible && input.focus(), 60);
      return h('div', { class: 'place-picker card' },
        h('div', { class: 'place-title' }, icon('cloud-sun', 22), h('div', {},
          h('b', { text: 'Где показывать погоду?' }),
          h('div', { class: 'faint', text: 'Прогноз берётся с открытого сервиса Open-Meteo, без регистрации.' }))),
        h('div', { class: 'place-row' }, input, auto),
        status, results);
    }

    // ---------------------------------------------------------------- tiles
    function tile(label, body) {
      return h('div', { class: 'wtile card' }, h('div', { class: 'label', text: label }), body);
    }

    function windTile(c) {
      // the arrow points where the wind is going
      const compass = svg(
        `<circle cx="24" cy="24" r="20" class="dial"/>
         <path d="M24 2.5v5M24 40.5v5M2.5 24h5M40.5 24h5" class="ticks"/>
         <g transform="rotate(${(c.windDir + 180) % 360} 24 24)"><path d="M24 9l6 15h-4.4v11h-3.2V24H18z" class="needle"/></g>`,
        '0 0 48 48', 'compass');
      return tile('Ветер', h('div', { class: 'wtile-row' }, compass, h('div', {},
        h('div', { class: 'wvalue' }, String(Math.round(c.wind)), h('small', { text: ' м/с' })),
        h('div', { class: 'faint', text: windName(c.windDir) }),
        h('div', { class: 'faint', text: `порывы до ${Math.round(c.gusts)}` }))));
    }

    function humidityTile(c) {
      return tile('Влажность', h('div', {},
        h('div', { class: 'wvalue', text: Math.round(c.humidity) + '%' }),
        h('div', { class: 'meter' }, h('i', { style: { width: Math.max(2, Math.min(100, c.humidity)) + '%' } })),
        h('div', { class: 'faint', text: `Точка росы ${formatTemp(c.dew)}` })));
    }

    function pressureTile(c) {
      // 720..780 mm Hg across a half circle
      const k = Math.max(0, Math.min(1, (c.pressure - 720) / 60));
      const a = Math.PI * (1 - k);
      const x = 24 + Math.cos(a) * 17;
      const y = 26 - Math.sin(a) * 17;
      const gauge = svg(
        `<path d="M5 26a19 19 0 0 1 38 0" class="dial"/>
         <path d="M24 26L${x.toFixed(1)} ${y.toFixed(1)}" class="hand"/><circle cx="24" cy="26" r="2.4" class="hub"/>`,
        '0 0 48 32', 'gauge');
      return tile('Давление', h('div', { class: 'wtile-row' }, gauge, h('div', {},
        h('div', { class: 'wvalue', text: String(c.pressure) }),
        h('div', { class: 'faint', text: 'мм рт. ст.' }))));
    }

    function sunTile(w) {
      const today = w.daily[0];
      if (!today) return tile('Солнце', h('div', { class: 'faint', text: 'нет данных' }));
      const p = sunProgress(w.localTime, today.sunrise, today.sunset);
      const up = p >= 0 && p <= 1;
      const a = Math.PI * (1 - Math.max(0, Math.min(1, p)));
      const x = 40 + Math.cos(a) * 32;
      const y = 34 - Math.sin(a) * 26;
      const arc = svg(
        `<path d="M8 34a32 26 0 0 1 64 0" class="sun-path"/><path d="M2 34h76" class="horizon"/>
         <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" class="sun-dot${up ? '' : ' down'}"/>`,
        '0 0 80 40', 'sunarc');
      return tile('Солнце', h('div', {}, arc, h('div', { class: 'sun-times faint' },
        h('span', { title: 'Восход' }, icon('sunrise', 12), hm(today.sunrise)),
        h('span', { title: 'Закат' }, icon('sunset', 12), hm(today.sunset)))));
    }

    function precipTile(w) {
      const today = w.daily[0] || { precip: 0, pop: 0 };
      return tile('Осадки', h('div', {},
        h('div', { class: 'wvalue' }, String(Math.round(today.precip * 10) / 10).replace('.', ','), h('small', { text: ' мм за сутки' })),
        h('div', { class: 'meter rain' }, h('i', { style: { width: Math.max(2, Math.min(100, today.pop)) + '%' } })),
        h('div', { class: 'faint', text: `Вероятность ${Math.round(today.pop)}%` })));
    }

    function uvTile(w) {
      const uv = Math.max(w.current.uv, 0);
      const max = w.daily[0] ? w.daily[0].uvMax : uv;
      return tile('УФ-индекс', h('div', {},
        h('div', { class: 'wvalue' }, String(Math.round(uv)), h('small', { text: ' ' + uvLevel(uv) })),
        h('div', { class: 'uv-scale' }, h('i', { style: { left: Math.min(100, (uv / 11) * 100) + '%' } })),
        h('div', { class: 'faint', text: `Сегодня до ${Math.round(max)}` })));
    }

    // ---------------------------------------------------------------- the whole view
    function strip(w) {
      const box = h('div', { class: 'wstrip' });
      if (range === 'hours') {
        for (const [i, hr] of w.hourly.slice(0, 9).entries()) {
          box.append(h('div', { class: 'wcell' },
            h('span', { class: 'faint', text: i === 0 ? 'Сейчас' : hr.hour }),
            weatherIcon(hr.code, hr.isDay, 18),
            h('b', { text: formatTemp(hr.temp) }),
            h('span', { class: 'pop' + (hr.pop >= 30 ? ' wet' : ''), text: hr.pop >= 30 ? Math.round(hr.pop) + '%' : '' })));
        }
      } else {
        for (const [i, d] of w.daily.slice(0, 7).entries()) {
          const date = new Date(d.date + 'T12:00:00');
          box.append(h('div', { class: 'wcell' },
            h('span', { class: 'faint', text: i === 0 ? 'Сегодня' : date.toLocaleDateString('ru-RU', { weekday: 'short' }) }),
            weatherIcon(d.code, true, 18),
            h('b', { text: formatTemp(d.tmax) }),
            h('span', { class: 'faint', text: formatTemp(d.tmin) })));
        }
      }
      return box;
    }

    function paint() {
      const w = app.weather;
      clear(root);
      refreshBtn.hidden = !app.settings.weather.place;
      placeBtn.hidden = !app.settings.weather.place;
      if (!app.settings.weather.place || picking) {
        root.append(placePicker());
        app.setHeadNote('');
        app.relayout();
        return;
      }
      if (!w || w.error || !w.current) {
        root.append(h('div', { class: 'empty' }, icon('cloud', 30),
          w && w.error ? 'Не удалось получить прогноз. Проверьте интернет.' : 'Загружаю прогноз…',
          w && w.error ? h('button', { class: 'btn small', onclick: () => app.refreshWeather(true) }, 'Повторить') : null));
        app.relayout();
        return;
      }
      const c = w.current;
      const d = describeCode(c.code, c.isDay);
      const today = w.daily[0];
      const maxPop = Math.max(0, ...w.hourly.slice(0, 24).map((x) => x.pop));
      const mins = Math.round((Date.now() - w.fetchedAt) / 60000);
      app.setHeadNote(w.stale ? 'нет связи, данные старые' : mins < 2 ? 'обновлено только что' : `обновлено ${mins} мин назад`);

      const now = h('div', { class: 'wnow card' + (c.isDay ? ' day' : ' night') },
        h('div', { class: 'wnow-place' }, icon('map-pin', 13), h('span', { class: 'ellipsis', text: w.place.name })),
        weatherIcon(c.code, c.isDay, 44),
        h('div', { class: 'wnow-temp', text: formatTemp(c.temp) }),
        h('div', { class: 'wnow-text', text: d.text }),
        h('div', { class: 'wnow-sub', text: `Ощущается как ${formatTemp(c.feels)}` }),
        today ? h('div', { class: 'wnow-sub', text: `Сегодня ${formatTemp(today.tmin)} … ${formatTemp(today.tmax)}` }) : null,
        h('div', { class: 'wnow-note', text: maxPop < 30 ? 'В ближайшие сутки без осадков' : `Вероятность осадков до ${Math.round(maxPop)}%` }));

      const seg = segment([['hours', 'Часы'], ['week', 'Неделя']], range, (v) => {
        range = v;
        paint();
      });

      root.append(h('div', { class: 'wgrid' },
        now,
        h('div', { class: 'wright' },
          h('div', { class: 'wstrip-wrap card' }, strip(w), seg),
          h('div', { class: 'wtiles' }, windTile(c), humidityTile(c), pressureTile(c), sunTile(w), precipTile(w), uvTile(w)))),
      h('div', { class: 'wsource faint', text: 'Данные: Open-Meteo' }));
      app.relayout();
    }

    app.on('weather', () => visible && paint());

    return {
      actions: [placeBtn, refreshBtn],
      show() {
        visible = true;
        picking = false;
        paint();
        // numbers older than ten minutes are refreshed when the tab opens
        if (app.weather && app.weather.fetchedAt && Date.now() - app.weather.fetchedAt > 10 * 60000) app.refreshWeather(false);
      },
      hide() {
        visible = false;
      },
    };
  },
};
