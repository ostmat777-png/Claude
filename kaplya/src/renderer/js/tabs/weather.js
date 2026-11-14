// Погода: now, the coming hours or the week, and six small tiles.

import { h, clear, icon, segment, debounce } from '../ui.js';
import { weatherTint } from '../common.js';
import { describeCode, windName, uvLevel, formatTemp, sunProgress, pressureTrend, humidityWords, hoursMinutes, uvAdvice } from '../../shared/weather.mjs';

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
const dec = (v, n = 1) => String(Math.round(v * 10 ** n) / 10 ** n).replace('.', ',');
const dayName = (iso, i) => (i === 0 ? 'Сегодня' : i === 1 ? 'Завтра'
  : new Date(iso + 'T12:00:00').toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }));

// Yandex Weather map layers (an addition, switched on in the settings)
const MAP_LAYERS = [
  ['nowcast', 'Осадки', 'cloud-rain'],
  ['temperature', 'Температура', 'thermometer'],
  ['wind', 'Ветер', 'wind'],
  ['pressure', 'Давление', 'gauge'],
  ['snow', 'Снег', 'snowflake'],
];

/**
 * A small chart of the next hours. `bars` draws columns (rain), otherwise a line
 * with the area under it. Labels every three hours.
 */
function chart(hours, valueOf, { bars = false, unit = '', min, max, color = 'var(--accent)', label = (v) => String(Math.round(v)) } = {}) {
  const list = hours.slice(0, 24);
  const values = list.map(valueOf);
  const W = 470;
  const H = 120;
  const top = 18;
  const bottom = 22;
  let lo = min ?? Math.min(...values);
  let hi = max ?? Math.max(...values);
  if (hi - lo < 1e-6) {
    hi += 1;
    lo -= bars ? 0 : 1;
  }
  const x = (i) => 10 + (i * (W - 20)) / Math.max(1, list.length - 1);
  const y = (v) => top + (1 - (v - lo) / (hi - lo)) * (H - top - bottom);
  let body = '';
  if (bars) {
    const bw = Math.max(3, (W - 20) / list.length - 3);
    values.forEach((v, i) => {
      const yy = y(Math.max(lo, v));
      body += `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, H - bottom - yy).toFixed(1)}" rx="2" class="bar"/>`;
    });
  } else {
    const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    body += `<path d="M${pts[0]} L${pts.join(' L')} L${x(values.length - 1).toFixed(1)},${H - bottom} L${x(0).toFixed(1)},${H - bottom} Z" class="area"/>`;
    body += `<path d="M${pts.join(' L')}" class="line"/>`;
  }
  // value labels at a few points, hour labels under them
  for (let i = 0; i < list.length; i += 3) {
    body += `<text x="${x(i).toFixed(1)}" y="${H - 6}" class="hour">${i === 0 ? 'сейчас' : list[i].hour}</text>`;
    const yy = bars ? y(Math.max(lo, values[i])) : y(values[i]);
    body += `<text x="${x(i).toFixed(1)}" y="${Math.max(11, yy - 6).toFixed(1)}" class="val">${label(values[i])}</text>`;
    if (!bars) body += `<circle cx="${x(i).toFixed(1)}" cy="${y(values[i]).toFixed(1)}" r="2.6" class="dot"/>`;
  }
  const el = svg(body, `0 0 ${W} ${H}`, 'wchart');
  el.style.setProperty('--c', color);
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', unit);
  return el;
}

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
    let detail = null; // a tile key, or { day: n }
    let showMap = false;
    const mapBtn = h('button', {
      class: 'ghost',
      title: 'Карта осадков, температуры и ветра',
      data: { act: 'map' },
      onclick: () => {
        showMap = !showMap;
        paint();
      },
    }, icon('map', 15));
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
        app.set('settings.weather', { ...app.settings.weather, place: p, askedOnce: true });
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
    function tile(label, body, key) {
      return h('button', {
        class: 'wtile card',
        data: { tile: key },
        title: 'Подробнее',
        onclick: () => {
          detail = key;
          paint();
        },
      }, h('div', { class: 'label' }, label, icon('chevron-right', 12)), body);
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
        h('div', { class: 'faint', text: `порывы до ${Math.round(c.gusts)}` }))), 'wind');
    }

    function humidityTile(c) {
      return tile('Влажность', h('div', {},
        h('div', { class: 'wvalue', text: Math.round(c.humidity) + '%' }),
        h('div', { class: 'meter' }, h('i', { style: { width: Math.max(2, Math.min(100, c.humidity)) + '%' } })),
        h('div', { class: 'faint', text: `Точка росы ${formatTemp(c.dew)}` })), 'humidity');
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
        h('div', { class: 'faint', text: 'мм рт. ст.' }))), 'pressure');
    }

    function sunTile(w) {
      const today = w.daily[0];
      if (!today) return tile('Солнце', h('div', { class: 'faint', text: 'нет данных' }), 'sun');
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
        h('span', { title: 'Закат' }, icon('sunset', 12), hm(today.sunset)))), 'sun');
    }

    function precipTile(w) {
      const today = w.daily[0] || { precip: 0, pop: 0 };
      return tile('Осадки', h('div', {},
        h('div', { class: 'wvalue' }, String(Math.round(today.precip * 10) / 10).replace('.', ','), h('small', { text: ' мм за сутки' })),
        h('div', { class: 'meter rain' }, h('i', { style: { width: Math.max(2, Math.min(100, today.pop)) + '%' } })),
        h('div', { class: 'faint', text: `Вероятность ${Math.round(today.pop)}%` })), 'precip');
    }

    function uvTile(w) {
      const uv = Math.max(w.current.uv, 0);
      const max = w.daily[0] ? w.daily[0].uvMax : uv;
      return tile('УФ-индекс', h('div', {},
        h('div', { class: 'wvalue' }, String(Math.round(uv)), h('small', { text: ' ' + uvLevel(uv) })),
        h('div', { class: 'uv-scale' }, h('i', { style: { left: Math.min(100, (uv / 11) * 100) + '%' } })),
        h('div', { class: 'faint', text: `Сегодня до ${Math.round(max)}` })), 'uv');
    }

    // ---------------------------------------------------------------- the whole view
    function strip(w) {
      const box = h('div', { class: 'wstrip' });
      if (range === 'hours') {
        for (const [i, hr] of w.hourly.slice(0, 9).entries()) {
          const words = describeCode(hr.code, hr.isDay).text + (hr.pop >= 10 ? `, осадки ${Math.round(hr.pop)}%` : '') +
            `\nОщущается как ${formatTemp(hr.feels)} · ветер ${Math.round(hr.wind)} м/с`;
          box.append(h('div', { class: 'wcell', data: { tip: words } },
            h('span', { class: 'faint', text: i === 0 ? 'Сейчас' : hr.hour }),
            weatherIcon(hr.code, hr.isDay, 18),
            h('b', { text: formatTemp(hr.temp) }),
            h('span', { class: 'pop' + (hr.pop >= 30 ? ' wet' : ''), text: hr.pop >= 30 ? Math.round(hr.pop) + '%' : '' })));
        }
      } else {
        for (const [i, d] of w.daily.slice(0, 7).entries()) {
          const date = new Date(d.date + 'T12:00:00');
          const words = describeCode(d.code, true).text + (d.pop >= 10 ? `, осадки ${Math.round(d.pop)}%` : '');
          box.append(h('button', {
            class: 'wcell day' + (detail && detail.day === i ? ' on' : ''),
            data: { tip: words + '\nНажмите, чтобы открыть день', day: String(i) },
            onclick: () => {
              detail = detail && detail.day === i ? null : { day: i };
              paint();
            },
          },
            h('span', { class: 'faint', text: i === 0 ? 'Сегодня' : date.toLocaleDateString('ru-RU', { weekday: 'short' }) }),
            weatherIcon(d.code, true, 18),
            h('b', { text: formatTemp(d.tmax) }),
            h('span', { class: 'faint', text: formatTemp(d.tmin) })));
        }
      }
      return box;
    }

    // ---------------------------------------------------------------- details of one tile or one day
    function factRow(...items) {
      return h('div', { class: 'wfacts' }, items.filter(Boolean).map(([k, v]) => h('div', { class: 'wfact' }, h('span', { class: 'faint', text: k }), h('b', { text: v }))));
    }

    function detailView(w) {
      const c = w.current;
      const hr = w.hourly;
      const today = w.daily[0] || {};
      let title = '';
      let body = [];
      if (detail && typeof detail === 'object') {
        const d = w.daily[detail.day];
        if (!d) return null;
        const words = describeCode(d.code, true);
        title = dayName(d.date, detail.day);
        const dayHours = hr.filter((x) => x.time.startsWith(d.date));
        body = [
          h('div', { class: 'wday' }, weatherIcon(d.code, true, 40),
            h('div', {}, h('div', { class: 'wday-temp', text: `${formatTemp(d.tmax)} / ${formatTemp(d.tmin)}` }), h('div', { text: words.text }))),
          factRow(['Осадки', `${dec(d.precip)} мм, ${Math.round(d.pop)}%`], ['Ветер', `до ${Math.round(d.windMax)} м/с, ${windName(d.windDir)}`],
            ['Восход', hm(d.sunrise)], ['Закат', hm(d.sunset)], ['Световой день', hoursMinutes(d.daylight)], ['УФ-индекс', `до ${Math.round(d.uvMax)}, ${uvLevel(d.uvMax)}`]),
          dayHours.length >= 6 ? chart(dayHours, (x) => x.temp, { unit: 'Температура по часам', label: (v) => formatTemp(v), color: '#ffb84a' }) : null,
        ];
      } else if (detail === 'temp') {
        title = 'Температура';
        const next = hr.slice(0, 24);
        const warm = next.reduce((a, b) => (b.temp > a.temp ? b : a), next[0] || { temp: 0, hour: '' });
        const cold = next.reduce((a, b) => (b.temp < a.temp ? b : a), next[0] || { temp: 0, hour: '' });
        body = [
          factRow(['Сейчас', `${formatTemp(c.temp)}, ощущается ${formatTemp(c.feels)}`], ['Теплее всего', `${formatTemp(warm.temp)} в ${warm.hour}`], ['Холоднее всего', `${formatTemp(cold.temp)} в ${cold.hour}`]),
          chart(hr, (x) => x.temp, { unit: 'Температура по часам', label: (v) => formatTemp(v), color: '#ffb84a' }),
          h('div', { class: 'wnote faint', text: 'Ощущаемая температура учитывает ветер и влажность: в ветер холоднее, в духоту жарче.' }),
        ];
      } else if (detail === 'wind') {
        title = 'Ветер';
        body = [
          factRow(['Сейчас', `${Math.round(c.wind)} м/с, ${windName(c.windDir)}`], ['Порывы', `до ${Math.round(c.gusts)} м/с`],
            ['Сильнее всего', `${Math.round(Math.max(...hr.slice(0, 24).map((x) => x.gusts)))} м/с в ближайшие сутки`]),
          chart(hr, (x) => x.wind, { unit: 'Скорость ветра по часам, м/с', min: 0, color: '#7fd1ff' }),
          h('div', { class: 'wnote faint', text: 'Направление указывает, откуда дует ветер: «юго-западный» дует с юго-запада.' }),
        ];
      } else if (detail === 'humidity') {
        title = 'Влажность';
        body = [
          factRow(['Сейчас', `${Math.round(c.humidity)}%`], ['Точка росы', formatTemp(c.dew)], ['Ощущение', humidityWords(c.humidity, c.dew)]),
          chart(hr, (x) => x.humidity, { unit: 'Влажность по часам, %', min: 0, max: 100, color: '#5fd0c4', label: (v) => Math.round(v) + '%' }),
          h('div', { class: 'wnote faint', text: 'Точка росы — температура, до которой должен остыть воздух, чтобы выпала роса. Выше 16° воздух кажется тяжёлым.' }),
        ];
      } else if (detail === 'pressure') {
        title = 'Давление';
        const trend = pressureTrend(hr);
        body = [
          factRow(['Сейчас', `${c.pressure} мм рт. ст.`], ['За 6 часов', trend], ['Норма', '≈ 760 мм на уровне моря']),
          chart(hr, (x) => x.pressure, { unit: 'Давление по часам, мм рт. ст.', color: '#b9a2ff' }),
          h('div', { class: 'wnote faint', text: trend === 'падает' ? 'Давление падает: часто к ухудшению погоды.' : trend === 'растёт' ? 'Давление растёт: часто к прояснению.' : 'Резких перемен не ожидается.' }),
        ];
      } else if (detail === 'sun') {
        title = 'Солнце';
        body = [
          factRow(['Восход', hm(today.sunrise)], ['Закат', hm(today.sunset)], ['Световой день', hoursMinutes(today.daylight)]),
          h('div', { class: 'wsun-week' }, w.daily.slice(0, 7).map((d, i) => h('div', { class: 'wsun-day' },
            h('span', { class: 'faint', text: i === 0 ? 'Сегодня' : new Date(d.date + 'T12:00:00').toLocaleDateString('ru-RU', { weekday: 'short' }) }),
            h('span', {}, icon('sunrise', 12), hm(d.sunrise)), h('span', {}, icon('sunset', 12), hm(d.sunset)),
            h('span', { class: 'faint', text: hoursMinutes(d.daylight).replace(' мин', 'м').replace(' ч ', 'ч ') })))),
        ];
      } else if (detail === 'precip') {
        title = 'Осадки';
        const wet = hr.slice(0, 24).find((x) => x.pop >= 40);
        body = [
          factRow(['За сутки', `${dec(today.precip || 0)} мм`], ['Вероятность', `до ${Math.round(today.pop || 0)}%`],
            ['Ближайшие', wet ? `около ${wet.hour}` : 'не ожидаются']),
          chart(hr, (x) => x.pop, { bars: true, min: 0, max: 100, unit: 'Вероятность осадков по часам, %', color: '#7fb8ff', label: (v) => (v >= 10 ? Math.round(v) + '%' : '') }),
        ];
      } else if (detail === 'uv') {
        title = 'УФ-индекс';
        const uv = Math.max(0, c.uv);
        body = [
          factRow(['Сейчас', `${Math.round(uv)}, ${uvLevel(uv)}`], ['Сегодня до', `${Math.round(today.uvMax || 0)}`]),
          chart(hr, (x) => x.uv, { min: 0, unit: 'УФ-индекс по часам', color: '#ffd84a', label: (v) => dec(v, 0) }),
          h('div', { class: 'wnote faint', text: uvAdvice(Math.max(uv, today.uvMax || 0)) }),
        ];
      } else {
        return null;
      }
      return h('div', { class: 'wdetail card' },
        h('div', { class: 'wdetail-head' },
          h('button', { class: 'ghost', title: 'Назад', onclick: () => { detail = null; paint(); } }, icon('arrow-left', 15)),
          h('b', { text: title })),
        body);
    }

    // ---------------------------------------------------------------- the map (Yandex Weather), when switched on
    let mapView = null;
    function mapUrl(layer) {
      const p = app.settings.weather.place;
      if (app.test) return 'data:text/html,<title>' + layer + '</title>'; // no internet in tests
      return `https://yandex.ru/pogoda/ru/maps/${layer}?lat=${p.lat.toFixed(4)}&lon=${p.lon.toFixed(4)}&z=7`;
    }

    function paintMap() {
      const layer = app.settings.weather.mapLayer || 'nowcast';
      const chips = h('div', { class: 'wmap-layers' }, MAP_LAYERS.map(([id, name, ic]) => h('button', {
        class: 'chip' + (id === layer ? ' on' : ''),
        data: { layer: id },
        onclick: () => {
          // only the page changes; the rest stays as it is
          app.set('settings.weather.mapLayer', id);
          for (const c of chips.children) c.classList.toggle('on', c.dataset.layer === id);
          if (mapView) mapView.setAttribute('src', mapUrl(id));
        },
      }, icon(ic, 12), name)));
      if (!mapView) {
        mapView = document.createElement('webview');
        mapView.setAttribute('partition', 'persist:web');
        mapView.className = 'wmap-frame';
      }
      const want = mapUrl(layer);
      if (mapView.getAttribute('src') !== want) mapView.setAttribute('src', want);
      root.append(h('div', { class: 'wmap' },
        h('div', { class: 'wmap-bar' }, chips, h('span', { class: 'grow' }),
          h('button', { class: 'ghost', title: 'Открыть в браузере', onclick: () => api.invoke('open:external', mapUrl(layer)) }, icon('external-link', 14))),
        h('div', { class: 'wmap-stage card' }, mapView),
        h('div', { class: 'wsource faint', text: 'Карта: Яндекс Погода. Слои, масштаб и время меняются прямо на карте.' })));
    }

    function paint() {
      const w = app.weather;
      // keep the map page alive between repaints: only detach it
      if (mapView && mapView.parentNode) mapView.remove();
      clear(root);
      mapBtn.hidden = !(app.settings.weather.map && app.settings.weather.place);
      mapBtn.classList.toggle('on', showMap);
      if (showMap && (!app.settings.weather.map || !app.settings.weather.place)) showMap = false;
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

      const now = h('button', {
        class: 'wnow card' + (c.isDay ? ' day' : ' night') + (detail === 'temp' ? ' on' : ''),
        title: 'Температура по часам',
        data: { tile: 'temp' },
        onclick: () => {
          detail = detail === 'temp' ? null : 'temp';
          paint();
        },
      },
        h('div', { class: 'wnow-place' }, icon('map-pin', 13), h('span', { class: 'ellipsis', text: w.place.name })),
        weatherIcon(c.code, c.isDay, 44),
        h('div', { class: 'wnow-temp', text: formatTemp(c.temp) }),
        h('div', { class: 'wnow-text', text: d.text }),
        h('div', { class: 'wnow-sub', text: `Ощущается как ${formatTemp(c.feels)}` }),
        today ? h('div', { class: 'wnow-sub', text: `Сегодня ${formatTemp(today.tmin)} … ${formatTemp(today.tmax)}` }) : null,
        h('div', { class: 'wnow-note', text: maxPop < 30 ? 'В ближайшие сутки без осадков' : `Вероятность осадков до ${Math.round(maxPop)}%` }));

      const seg = segment([['hours', 'Часы'], ['week', 'Неделя']], range, (v) => {
        range = v;
        if (v === 'hours' && detail && typeof detail === 'object') detail = null;
        paint();
      });

      if (showMap) {
        paintMap();
        app.relayout();
        return;
      }
      if (detail && typeof detail === 'object') range = 'week';
      const more = detailView(w);
      if (!more) detail = null;
      root.append(h('div', { class: 'wgrid' },
        now,
        h('div', { class: 'wright' },
          h('div', { class: 'wstrip-wrap card' }, strip(w), seg),
          more || h('div', { class: 'wtiles' }, windTile(c), humidityTile(c), pressureTile(c), sunTile(w), precipTile(w), uvTile(w)))),
      h('div', { class: 'wsource faint', text: 'Данные: Open-Meteo. Нажмите на плитку или на день недели, чтобы узнать больше.' }));
      app.relayout();
    }

    app.on('weather', () => visible && paint());

    return {
      actions: [mapBtn, placeBtn, refreshBtn],
      show() {
        visible = true;
        picking = false;
        detail = null;
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
