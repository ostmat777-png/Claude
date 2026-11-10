/*
 * Steam Price Chart: общий модуль.
 *
 * Под ценой игры в магазине Steam рисует:
 *   1) мини-график истории цены за всё время (когда и на сколько процентов была скидка);
 *   2) таблицу цен по регионам: Казахстан, Украина, Россия, США
 *      (страна | цена в местной валюте | цена в рублях; самая дешёвая строка обведена зелёным, самая дорогая красным).
 *
 * Один и тот же файл работает в клиенте Steam (плагин Millennium) и в браузере (расширение).
 * Платформу задаёт «адаптер», который передаётся в SteamPriceChart.mount(adapter):
 *   adapter.fetchText(url)      -> Promise<{ status: number, body?: string, error?: string }>  (GET, в том числе на чужие сайты)
 *   adapter.getSetting(key)     -> Promise<string | undefined>
 *   adapter.setSetting(key, v)  -> Promise<void>
 *
 * Правьте только core/steam-price-chart.js; копии в millennium/webview и browser-extension
 * обновляет команда `node tools/sync-core.mjs`.
 */
(function () {
  'use strict';
  if (globalThis.SteamPriceChart) return;

  const VERSION = '1.0.1';

  const REGIONS = [
    { cc: 'KZ', name: 'Казахстан' },
    { cc: 'UA', name: 'Украина' },
    { cc: 'RU', name: 'Россия' },
    { cc: 'US', name: 'США' },
  ];
  const REGION_NAME = Object.fromEntries(REGIONS.map((r) => [r.cc, r.name]));

  // «auto»: регион берётся из аккаунта Steam (см. detectStoreCountry)
  const AUTO = 'auto';
  const DEFAULTS = { itadKey: '', homeRegion: AUTO, historyRegion: AUTO };
  const SETTING_KEYS = Object.keys(DEFAULTS);

  const HOUR = 3600e3;
  const DAY = 24 * HOUR;
  const TTL = { price: 0.5 * HOUR, rates: 6 * HOUR, history: 6 * HOUR, itadId: 30 * DAY };

  const ITAD_API = 'https://api.isthereanydeal.com';
  const ITAD_STEAM_SHOP = 61;
  const ITAD_KEY_PAGE = 'https://isthereanydeal.com/apps/my/';

  const MONTHS_GEN = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const MONTHS_NOM = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

  const PERIODS = [
    { id: 'all', label: 'Всё время', years: 0 },
    { id: '3y', label: '3 года', years: 3 },
    { id: '1y', label: '1 год', years: 1 },
  ];

  // ---------------------------------------------------------------- утилиты

  class HttpError extends Error {
    constructor(status, message, body) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }

  async function getJson(adapter, url) {
    let r;
    try {
      r = await adapter.fetchText(url);
    } catch (e) {
      throw new HttpError(0, 'нет связи: ' + ((e && e.message) || e));
    }
    if (!r || !r.status) throw new HttpError(0, 'нет связи' + (r && r.error ? ': ' + r.error : ''));
    if (r.status < 200 || r.status >= 300) {
      let reason = '';
      try {
        const j = JSON.parse(r.body || '');
        reason = j.reason_phrase || j.error || j.message || '';
      } catch (e) { /* тело не JSON */ }
      throw new HttpError(r.status, 'HTTP ' + r.status + (reason ? ' (' + reason + ')' : ''), r.body);
    }
    try {
      return JSON.parse(r.body);
    } catch (e) {
      throw new HttpError(r.status, 'ответ не JSON');
    }
  }

  // Кэш в localStorage страницы магазина. Может быть недоступен: тогда просто работаем без кэша.
  const cache = {
    get(key, maxAge) {
      try {
        const raw = localStorage.getItem('spc:' + key);
        if (!raw) return null;
        const o = JSON.parse(raw);
        if (!o || Date.now() - o.t > maxAge) return null;
        return o.v;
      } catch (e) {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem('spc:' + key, JSON.stringify({ t: Date.now(), v: value }));
      } catch (e) { /* переполнен или запрещён */ }
    },
    drop(prefix) {
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k && k.startsWith('spc:' + prefix)) localStorage.removeItem(k);
        }
      } catch (e) { /* ignore */ }
    },
  };

  async function cached(key, maxAge, loader) {
    const hit = cache.get(key, maxAge);
    if (hit != null) return hit;
    const v = await loader();
    if (v != null) cache.set(key, v);
    return v;
  }

  // Валюты, в которых Steam показывает цены без копеек
  const NO_CENTS = new Set(['KZT', 'RUB', 'UAH', 'JPY', 'KRW', 'VND', 'IDR', 'CLP', 'COP', 'TWD', 'INR', 'HUF']);

  function fmtMoney(amount, currency, forceDigits) {
    if (amount == null || !isFinite(amount)) return '—';
    const whole = Math.abs(amount - Math.round(amount)) < 0.005;
    const digits = forceDigits != null ? forceDigits : whole && NO_CENTS.has(currency) ? 0 : 2;
    try {
      return new Intl.NumberFormat(currency === 'USD' ? 'en-US' : 'ru-RU', {
        style: 'currency',
        currency,
        currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(amount);
    } catch (e) {
      return amount.toFixed(digits) + ' ' + currency;
    }
  }

  function currencySymbol(currency) {
    try {
      const part = new Intl.NumberFormat('ru-RU', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
        .formatToParts(1)
        .find((p) => p.type === 'currency');
      return part ? part.value : currency;
    } catch (e) {
      return currency;
    }
  }

  function fmtDate(t) {
    const d = new Date(t);
    return d.getDate() + ' ' + MONTHS_GEN[d.getMonth()] + ' ' + d.getFullYear();
  }

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, text) {
    const el = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, String(attrs[k]));
    if (text != null) el.textContent = text;
    return el;
  }

  function waitFor(fn, timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      (function tick() {
        let r = null;
        try {
          r = fn();
        } catch (e) { /* DOM ещё не готов */ }
        if (r) return resolve(r);
        if (Date.now() - t0 > timeout) return resolve(null);
        setTimeout(tick, 200);
      })();
    });
  }

  function regionName(cc) {
    if (REGION_NAME[cc]) return REGION_NAME[cc];
    try {
      return new Intl.DisplayNames(['ru'], { type: 'region' }).of(cc) || cc;
    } catch (e) {
      return cc;
    }
  }

  /** Страна магазина того, кто открыл страницу: Steam сам пишет её в разметку (#application_config). */
  function detectStoreCountry() {
    try {
      const el = document.getElementById('application_config');
      const info = JSON.parse((el && el.getAttribute('data-userinfo')) || '{}');
      const cc = info && typeof info.country_code === 'string' ? info.country_code.toUpperCase() : '';
      return /^[A-Z]{2}$/.test(cc) ? cc : '';
    } catch (e) {
      return '';
    }
  }

  // ---------------------------------------------------------------- данные

  async function loadSettings(adapter) {
    const out = Object.assign({}, DEFAULTS);
    await Promise.all(
      SETTING_KEYS.map(async (k) => {
        try {
          const v = await adapter.getSetting(k);
          if (typeof v === 'string' && v !== '') out[k] = v;
        } catch (e) { /* остаётся значение по умолчанию */ }
      })
    );
    out.itadKey = (out.itadKey || '').trim();
    if (out.homeRegion !== AUTO && !REGION_NAME[out.homeRegion]) out.homeRegion = AUTO;
    if (out.historyRegion !== AUTO && !REGION_NAME[out.historyRegion]) out.historyRegion = AUTO;
    return out;
  }

  /** Цена игры в регионе по данным самого Steam. */
  async function fetchRegionPrice(adapter, appid, cc) {
    return cached('price:' + appid + ':' + cc, TTL.price, async () => {
      const url =
        'https://store.steampowered.com/api/appdetails?appids=' + appid + '&cc=' + cc.toLowerCase() + '&filters=price_overview';
      const j = await getJson(adapter, url);
      const e = j && j[appid];
      if (!e || !e.success) return { status: 'unavailable' };
      const p = e.data && e.data.price_overview;
      if (!p) return { status: 'noprice' };
      return {
        status: 'ok',
        currency: p.currency,
        initial: p.initial / 100,
        final: p.final / 100,
        discount: p.discount_percent || 0,
        finalFormatted: p.final_formatted || '',
        initialFormatted: p.initial_formatted || '',
      };
    });
  }

  /** Курсы «сколько рублей стоит 1 единица валюты». Основной источник: ЦБ РФ, запасной: fawazahmed0/currency-api. */
  async function fetchRubRates(adapter) {
    return cached('rates', TTL.rates, async () => {
      try {
        const j = await getJson(adapter, 'https://www.cbr-xml-daily.ru/daily_json.js');
        const rates = { RUB: 1 };
        for (const code of Object.keys(j.Valute || {})) {
          const v = j.Valute[code];
          if (v && v.Value > 0 && v.Nominal > 0) rates[code] = v.Value / v.Nominal;
        }
        return { rates, date: Date.parse(j.Date) || Date.now(), source: 'ЦБ РФ' };
      } catch (e) {
        const urls = [
          'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/rub.json',
          'https://latest.currency-api.pages.dev/v1/currencies/rub.json',
        ];
        for (const url of urls) {
          try {
            const j = await getJson(adapter, url);
            const rates = { RUB: 1 };
            for (const code of Object.keys(j.rub || {})) {
              const perRub = j.rub[code];
              if (perRub > 0) rates[code.toUpperCase()] = 1 / perRub;
            }
            return { rates, date: Date.parse(j.date) || Date.now(), source: 'currency-api' };
          } catch (e2) { /* следующий источник */ }
        }
        throw e;
      }
    });
  }

  async function itadGameId(adapter, key, appid) {
    return cached('itadid:' + appid, TTL.itadId, async () => {
      const j = await getJson(
        adapter,
        ITAD_API + '/games/lookup/v1?key=' + encodeURIComponent(key) + '&appid=' + appid
      );
      return j && j.found && j.game ? j.game.id : '';
    });
  }

  /** Полная история цены в Steam (по возрастанию времени). */
  async function itadHistory(adapter, key, gameId, cc) {
    return cached('hist:' + gameId + ':' + cc, TTL.history, async () => {
      const url =
        ITAD_API +
        '/games/history/v2?key=' + encodeURIComponent(key) +
        '&id=' + encodeURIComponent(gameId) +
        '&country=' + cc +
        '&shops=' + ITAD_STEAM_SHOP +
        // без since ITAD отдаёт только последние 3 месяца
        '&since=' + encodeURIComponent('2000-01-01T00:00:00Z');
      const arr = await getJson(adapter, url);
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((x) => x && x.deal && x.deal.price && (!x.shop || x.shop.id === ITAD_STEAM_SHOP))
        .map((x) => ({
          t: Date.parse(x.timestamp),
          price: Number(x.deal.price.amount),
          regular: Number((x.deal.regular && x.deal.regular.amount) || x.deal.price.amount),
          cut: Math.round(Number(x.deal.cut) || 0),
          currency: x.deal.price.currency,
        }))
        .filter((x) => isFinite(x.t) && isFinite(x.price))
        .sort((a, b) => a.t - b.t);
    });
  }

  // ---------------------------------------------------------------- анализ истории

  /** Отрезки «цена держалась с t1 до t2». Последний отрезок тянется до сейчас. */
  function toSegments(points, now) {
    const segs = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const t2 = i + 1 < points.length ? points[i + 1].t : now;
      if (t2 <= p.t && i + 1 < points.length) continue; // дубль по времени
      segs.push({ t1: p.t, t2: Math.max(t2, p.t), price: p.price, regular: p.regular, cut: p.cut });
    }
    return segs;
  }

  /** Скидочные периоды: подряд идущие отрезки со скидкой. */
  function salePeriods(segs) {
    const out = [];
    let cur = null;
    for (const s of segs) {
      if (s.cut > 0) {
        if (!cur) {
          cur = { t1: s.t1, t2: s.t2, maxCut: s.cut, minPrice: s.price, regular: s.regular };
          out.push(cur);
        } else {
          cur.t2 = s.t2;
          cur.maxCut = Math.max(cur.maxCut, s.cut);
          cur.minPrice = Math.min(cur.minPrice, s.price);
          cur.regular = Math.max(cur.regular, s.regular);
        }
      } else {
        cur = null;
      }
    }
    return out;
  }

  function clipToPeriod(points, years, now) {
    if (!years || !points.length) return points;
    const start = now - years * 365.25 * DAY;
    if (points[0].t >= start) return points;
    let i = 0;
    while (i + 1 < points.length && points[i + 1].t <= start) i++;
    return [Object.assign({}, points[i], { t: start })].concat(points.slice(i + 1));
  }

  function niceStep(maxValue, targetTicks) {
    const raw = maxValue / Math.max(1, targetTicks);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return nice * mag;
  }

  function compactMoney(v, currency) {
    if (v >= 10000) {
      const k = v / 1000;
      return (Math.round(k * 10) / 10).toString().replace('.', ',') + 'k' + (currency === 'USD' ? '$' : ' ' + currencySymbol(currency));
    }
    return fmtMoney(v, currency, v >= 100 || Number.isInteger(v) ? 0 : 2);
  }

  // ---------------------------------------------------------------- стили

  const CSS = `
#spc-root{margin:0 0 26px;padding:12px 14px 10px;background:linear-gradient(rgba(0,0,0,.25),rgba(0,0,0,.25)),#1b2838;border-radius:3px;color:#c6d4df;font-size:13px;line-height:1.35;position:relative;font-family:inherit}
#spc-root *{box-sizing:border-box}
#spc-root .spc-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}
#spc-root .spc-title{color:#fff;font-size:14px;text-transform:uppercase;letter-spacing:.03em}
#spc-root .spc-muted{color:#8f98a0;font-size:12px}
#spc-root .spc-grow{flex:1 1 auto}
#spc-root .spc-btn{background:rgba(103,193,245,.18);color:#67c1f5;border:0;border-radius:2px;padding:3px 8px;font:inherit;font-size:12px;cursor:pointer}
#spc-root .spc-btn:hover{background:#67c1f5;color:#fff}
#spc-root .spc-btn.spc-on{background:#67c1f5;color:#0e1a24}
#spc-root .spc-chart{position:relative;min-height:60px}
#spc-root .spc-chart svg{display:block;width:100%;overflow:visible}
#spc-root .spc-msg{padding:14px 4px;color:#8f98a0}
#spc-root .spc-err{color:#e28a8a}
#spc-root .spc-tip{position:absolute;pointer-events:none;background:#c6d4df;color:#171a21;font-size:12px;padding:4px 7px;border-radius:2px;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.5);z-index:5;display:none}
#spc-root .spc-stats{display:flex;flex-wrap:wrap;gap:4px 14px;margin:4px 0 10px;font-size:12px}
#spc-root .spc-stats b{color:#fff;font-weight:normal}
#spc-root .spc-green{color:#beee11}
#spc-root .spc-sub{color:#fff;font-size:13px;margin:6px 0 4px}
#spc-root table.spc-table{width:100%;border-collapse:separate;border-spacing:0 3px;font-size:13px}
#spc-root .spc-table th{color:#8f98a0;font-weight:normal;text-align:left;font-size:12px;padding:0 10px 2px}
#spc-root .spc-table td{background:rgba(255,255,255,.04);padding:6px 10px;border-top:2px solid transparent;border-bottom:2px solid transparent;vertical-align:middle}
#spc-root .spc-table td:first-child{border-left:2px solid transparent;border-radius:3px 0 0 3px}
#spc-root .spc-table td:last-child{border-right:2px solid transparent;border-radius:0 3px 3px 0;white-space:nowrap}
#spc-root .spc-table tr.spc-cheap td{border-color:#6fbf2e;background:rgba(111,191,46,.10)}
#spc-root .spc-table tr.spc-dear td{border-color:#d94a4a;background:rgba(217,74,74,.10)}
#spc-root .spc-table tr.spc-cheap td:not(:first-child),#spc-root .spc-table tr.spc-dear td:not(:first-child){border-left-color:transparent}
#spc-root .spc-table tr.spc-cheap td:not(:last-child),#spc-root .spc-table tr.spc-dear td:not(:last-child){border-right-color:transparent}
#spc-root .spc-table .spc-rub{color:#fff}
#spc-root .spc-old{color:#738895;text-decoration:line-through;margin-right:6px;font-size:12px}
#spc-root .spc-cut{background:#4c6b22;color:#beee11;padding:0 4px;border-radius:2px;margin-left:6px;font-size:12px}
#spc-root .spc-tag{font-size:11px;margin-left:6px}
#spc-root .spc-tag.spc-cheap{color:#8fdc4e}
#spc-root .spc-tag.spc-dear{color:#ef7a7a}
#spc-root .spc-home{color:#67c1f5;font-size:11px;margin-left:6px}
#spc-root .spc-foot{margin-top:6px;font-size:11px;color:#6b7a87}
#spc-root .spc-foot a,#spc-root .spc-settings a,#spc-root .spc-msg a{color:#67c1f5}
#spc-root .spc-settings{background:rgba(0,0,0,.25);border-radius:3px;padding:10px;margin:4px 0 10px;font-size:12px}
#spc-root .spc-settings label{display:block;margin:0 0 8px}
#spc-root input,#spc-root select{background:#1b2838;color:#fff;border:1px solid #3d4c5d;border-radius:2px;padding:4px 6px;font:inherit;font-size:12px}
#spc-root input[type=password],#spc-root input[type=text]{width:100%;max-width:340px;margin-top:3px}
#spc-root .spc-msg .spc-row input{margin-top:0}
#spc-root .spc-table td:nth-child(2){white-space:nowrap}
#spc-root .spc-row{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end}
`;

  function injectCss() {
    if (document.getElementById('spc-style')) return;
    const st = document.createElement('style');
    st.id = 'spc-style';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  // ---------------------------------------------------------------- график

  function renderChart(box, history, currency, periodYears) {
    box.replaceChildren();
    const now = Date.now();
    const pts = clipToPeriod(history, periodYears, now);
    const segs = toSegments(pts, now);
    if (!segs.length) {
      box.append(h('div', { class: 'spc-msg', text: 'Нет данных об истории цены.' }));
      return;
    }

    const W = Math.max(280, Math.round(box.clientWidth || 584));
    const H = 132;
    const padL = 50, padR = 8, padT = 16, padB = 20;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const t0 = segs[0].t1, t1 = Math.max(now, t0 + DAY);
    const maxP = Math.max(...segs.map((s) => Math.max(s.price, s.regular))) || 1;
    const step = niceStep(maxP, 3);
    const top = Math.ceil((maxP * 1.04) / step) * step;
    const x = (t) => padL + ((t - t0) / (t1 - t0)) * plotW;
    const y = (p) => padT + (1 - p / top) * plotH;
    const bottom = padT + plotH;

    const root = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, preserveAspectRatio: 'none', role: 'img' });

    // сетка и подписи по вертикали
    for (let v = 0; v <= top + 1e-9; v += step) {
      const yy = y(v);
      root.append(svg('line', { x1: padL, x2: W - padR, y1: yy, y2: yy, stroke: 'rgba(255,255,255,.07)', 'stroke-width': 1 }));
      root.append(svg('text', { x: padL - 5, y: yy + 3.5, 'text-anchor': 'end', fill: '#8f98a0', 'font-size': 10 }, compactMoney(v, currency)));
    }

    // подписи по горизонтали: годы или месяцы
    const spanDays = (t1 - t0) / DAY;
    const ticks = [];
    const d0 = new Date(t0);
    if (spanDays > 540) {
      const years = new Date(t1).getFullYear() - d0.getFullYear() + 1;
      const every = Math.max(1, Math.ceil(years / Math.max(1, Math.floor(plotW / 44))));
      for (let yv = d0.getFullYear() + 1; yv <= new Date(t1).getFullYear(); yv++) {
        if ((yv - d0.getFullYear() - 1) % every === 0) ticks.push({ t: new Date(yv, 0, 1).getTime(), label: String(yv) });
      }
    } else {
      const months = Math.ceil(spanDays / 30);
      const every = Math.max(1, Math.ceil(months / Math.max(1, Math.floor(plotW / 52))));
      const d = new Date(d0.getFullYear(), d0.getMonth() + 1, 1);
      let i = 0;
      while (d.getTime() < t1) {
        if (i % every === 0) {
          ticks.push({ t: d.getTime(), label: MONTHS_NOM[d.getMonth()] + ' ' + String(d.getFullYear()).slice(2) });
        }
        d.setMonth(d.getMonth() + 1);
        i++;
      }
    }
    for (const tk of ticks) {
      const xx = x(tk.t);
      if (xx < padL + 4 || xx > W - padR - 4) continue;
      root.append(svg('line', { x1: xx, x2: xx, y1: padT, y2: bottom, stroke: 'rgba(255,255,255,.05)', 'stroke-width': 1 }));
      root.append(svg('text', { x: xx, y: H - 5, 'text-anchor': 'middle', fill: '#8f98a0', 'font-size': 10 }, tk.label));
    }

    // скидочные периоды: заливка
    for (const s of segs) {
      if (s.cut <= 0) continue;
      const xa = x(s.t1), xb = x(s.t2);
      root.append(svg('rect', { x: xa, y: y(s.price), width: Math.max(1.2, xb - xa), height: Math.max(0, bottom - y(s.price)), fill: 'rgba(164,208,7,.28)' }));
    }

    // обычная цена: пунктир
    const stepPath = (key) => {
      let d = '';
      segs.forEach((s, i) => {
        const yy = y(s[key]).toFixed(1);
        d += (i === 0 ? 'M' + x(s.t1).toFixed(1) + ' ' + yy : 'V' + yy) + 'H' + x(s.t2).toFixed(1);
      });
      return d;
    };
    root.append(svg('path', { d: stepPath('regular'), fill: 'none', stroke: '#8f98a0', 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.7 }));
    root.append(svg('path', { d: stepPath('price'), fill: 'none', stroke: '#66c0f4', 'stroke-width': 1.6, 'stroke-linejoin': 'round' }));

    // подписи процентов над скидками, над линией обычной цены (самые большие скидки в приоритете, без наложений)
    const periods = salePeriods(segs);
    const placed = [];
    const minGap = 34;
    const maxLabels = Math.max(1, Math.floor(plotW / minGap));
    periods
      .slice()
      .sort((a, b) => b.maxCut - a.maxCut || b.t1 - a.t1)
      .forEach((p) => {
        if (placed.length >= maxLabels) return;
        const cx = Math.min(W - padR - 12, Math.max(padL + 12, (x(p.t1) + x(p.t2)) / 2));
        if (placed.some((q) => Math.abs(q - cx) < minGap)) return;
        placed.push(cx);
        const yy = Math.max(10, y(p.regular) - 5);
        root.append(svg('text', { x: cx, y: yy, 'text-anchor': 'middle', fill: '#beee11', 'font-size': 10 }, '−' + p.maxCut + '%'));
      });

    // наведение: вертикальная линия и подсказка
    const cursor = svg('line', { x1: 0, x2: 0, y1: padT, y2: bottom, stroke: 'rgba(255,255,255,.45)', 'stroke-width': 1, visibility: 'hidden' });
    const dot = svg('circle', { r: 3, fill: '#fff', visibility: 'hidden' });
    const hit = svg('rect', { x: padL, y: 0, width: plotW, height: H, fill: 'transparent' });
    root.append(cursor, dot, hit);
    box.append(root);

    const tip = h('div', { class: 'spc-tip' });
    box.append(tip);
    const move = (ev) => {
      const rect = root.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * W;
      const t = t0 + ((px - padL) / plotW) * (t1 - t0);
      const s = segs.find((g) => t >= g.t1 && t <= g.t2) || (t < t0 ? segs[0] : segs[segs.length - 1]);
      const cx = Math.min(W - padR, Math.max(padL, px));
      cursor.setAttribute('x1', cx);
      cursor.setAttribute('x2', cx);
      cursor.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', cx);
      dot.setAttribute('cy', y(s.price));
      dot.setAttribute('visibility', 'visible');
      const till = s.t2 >= now - HOUR ? 'по сей день' : 'по ' + fmtDate(s.t2);
      tip.replaceChildren(
        h('b', { text: fmtMoney(s.price, currency) }),
        s.cut > 0 ? '  −' + s.cut + '% (обычная ' + fmtMoney(s.regular, currency) + ')' : '  без скидки',
        h('br'),
        'с ' + fmtDate(s.t1) + ' ' + till
      );
      tip.style.display = 'block';
      const boxRect = box.getBoundingClientRect();
      const tipW = tip.offsetWidth;
      let left = ev.clientX - boxRect.left + 12;
      if (left + tipW > boxRect.width) left = ev.clientX - boxRect.left - tipW - 12;
      tip.style.left = Math.max(0, left) + 'px';
      tip.style.top = '2px';
    };
    hit.addEventListener('mousemove', move);
    hit.addEventListener('mouseleave', () => {
      tip.style.display = 'none';
      cursor.setAttribute('visibility', 'hidden');
      dot.setAttribute('visibility', 'hidden');
    });
  }

  function renderStats(box, history, currency) {
    box.replaceChildren();
    const now = Date.now();
    const segs = toSegments(history, now);
    if (!segs.length) return;
    const periods = salePeriods(segs);
    const minPrice = Math.min(...segs.map((s) => s.price));
    const minSeg = segs.filter((s) => Math.abs(s.price - minPrice) < 0.005).pop();
    const maxCut = periods.length ? Math.max(...periods.map((p) => p.maxCut)) : 0;
    const last = segs[segs.length - 1];
    const lastSale = periods[periods.length - 1];

    const items = [];
    items.push(['Минимум: ', h('b', { text: fmtMoney(minPrice, currency) }), minSeg.cut > 0 ? ' (−' + minSeg.cut + '%)' : '', ', ' + fmtDate(minSeg.t1)]);
    items.push(['Скидок: ', h('b', { text: String(periods.length) }), maxCut ? ', макс. −' + maxCut + '%' : '']);
    if (last.cut > 0) {
      items.push([h('span', { class: 'spc-green', text: 'Сейчас скидка −' + last.cut + '%' }), ' с ' + fmtDate(lastSale.t1)]);
    } else if (lastSale) {
      items.push(['Последняя скидка: ', h('b', { text: '−' + lastSale.maxCut + '%' }), ', ' + fmtDate(lastSale.t1) + ' – ' + fmtDate(lastSale.t2)]);
    }
    items.push([h('span', { class: 'spc-muted', text: 'данные с ' + fmtDate(history[0].t) })]);
    for (const it of items) box.append(h('span', null, it));
  }

  // ---------------------------------------------------------------- таблица

  function renderTable(box, regions, prices, ratesInfo, homeCc) {
    box.replaceChildren();
    const rates = ratesInfo ? ratesInfo.rates : null;
    const rows = regions.map((r, i) => {
      const p = prices[i];
      let rub = null;
      if (p.status === 'ok' && rates && rates[p.currency]) rub = p.final * rates[p.currency];
      return { r, p, rub };
    });
    const withRub = rows.filter((x) => x.rub != null && x.rub > 0);
    let cheapest = null, dearest = null;
    if (withRub.length >= 2) {
      const min = Math.min(...withRub.map((x) => x.rub));
      const max = Math.max(...withRub.map((x) => x.rub));
      if (max - min > 0.5) {
        cheapest = withRub.find((x) => x.rub === min);
        dearest = withRub.find((x) => x.rub === max);
      }
    }

    const table = h('table', { class: 'spc-table' },
      h('thead', null, h('tr', null, h('th', { text: 'Страна' }), h('th', { text: 'Цена в регионе' }), h('th', { text: 'В рублях' }))));
    const tbody = h('tbody');
    for (const row of rows) {
      const { r, p, rub } = row;
      const cls = row === cheapest ? 'spc-cheap' : row === dearest ? 'spc-dear' : '';
      const nameCell = h('td', null, r.name, r.cc === homeCc ? h('span', { class: 'spc-home', text: 'ваш регион' }) : null);
      let priceCell, rubCell;
      if (p.status === 'ok') {
        priceCell = h('td', null,
          p.discount > 0 ? h('span', { class: 'spc-old', text: p.initialFormatted || fmtMoney(p.initial, p.currency) }) : null,
          p.finalFormatted || fmtMoney(p.final, p.currency),
          p.discount > 0 ? h('span', { class: 'spc-cut', text: '−' + p.discount + '%' }) : null);
        if (rub != null) {
          const diff = cheapest && row !== cheapest ? Math.round((rub / cheapest.rub - 1) * 100) : null;
          rubCell = h('td', null,
            h('span', { class: 'spc-rub', text: '≈ ' + fmtMoney(Math.round(rub), 'RUB', 0) }),
            row === cheapest ? h('span', { class: 'spc-tag spc-cheap', text: 'дешевле всего' }) : null,
            row === dearest ? h('span', { class: 'spc-tag spc-dear', text: 'дороже всего' }) : null,
            diff > 0 ? h('span', { class: 'spc-tag spc-muted', text: '+' + diff + '%' }) : null);
        } else {
          rubCell = h('td', { class: 'spc-muted', text: rates ? 'нет курса ' + p.currency : 'нет курса' });
        }
      } else {
        const text =
          p.status === 'unavailable' ? 'не продаётся в регионе'
            : p.status === 'noprice' ? 'бесплатно или без цены'
              : 'ошибка: ' + (p.error || '?');
        priceCell = h('td', { class: p.status === 'error' ? 'spc-err' : 'spc-muted', text });
        rubCell = h('td', { class: 'spc-muted', text: '—' });
      }
      tbody.append(h('tr', { class: cls }, nameCell, priceCell, rubCell));
    }
    table.append(tbody);
    box.append(table);

    const foot = h('div', { class: 'spc-foot' });
    if (ratesInfo) {
      const d = new Date(ratesInfo.date);
      foot.append('Курс ' + ratesInfo.source + ' на ' + String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + d.getFullYear() + '. ');
    } else {
      foot.append('Курс валют загрузить не удалось. ');
    }
    foot.append('Цены по данным Steam; это основное издание игры (первый вариант покупки).');
    box.append(foot);
  }

  // ---------------------------------------------------------------- виджет

  function regionSelect(name, value, autoLabel) {
    return h('select', { name },
      h('option', { value: AUTO, selected: value === AUTO, text: autoLabel }),
      REGIONS.map((r) => h('option', { value: r.cc, selected: r.cc === value, text: r.name })));
  }

  function keyHelp() {
    return h('div', { class: 'spc-muted' },
      'Ключ бесплатный: войдите на ',
      h('a', { href: ITAD_KEY_PAGE, target: '_blank', rel: 'noopener noreferrer', text: 'isthereanydeal.com/apps/my' }),
      ', нажмите «Register app», откройте своё приложение и скопируйте «API key» ' +
        '(не Client ID и не Client Secret из раздела OAuth).');
  }

  function findAnchor() {
    const area = document.getElementById('game_area_purchase');
    if (area) {
      const wrappers = Array.from(area.querySelectorAll('.game_area_purchase_game_wrapper, .game_area_purchase_game'))
        .filter((w) => !w.closest('#spc-root') && !w.closest('#gameAreaDLCSection'));
      const priced = wrappers.find((w) => w.querySelector('.game_purchase_price, .discount_final_price'));
      const target = priced || wrappers[0];
      if (target) return { el: target.closest('.game_area_purchase_game_wrapper') || target, where: 'after' };
      return { el: area, where: 'prepend' };
    }
    const desc = document.getElementById('game_area_description');
    if (desc) return { el: desc, where: 'before' };
    return null;
  }

  async function mount(adapter) {
    const m = location.hostname === 'store.steampowered.com' && location.pathname.match(/^\/app\/(\d+)/);
    if (!m) return;
    const appid = m[1];
    if (document.getElementById('spc-root')) return;

    const anchor = await waitFor(() => document.body && findAnchor(), 20000);
    if (!anchor || document.getElementById('spc-root')) return;

    injectCss();
    const ui = {
      root: h('div', { id: 'spc-root', 'data-version': VERSION }),
      regionLabel: h('span', { class: 'spc-muted' }),
      periods: h('span'),
      settings: h('div', { class: 'spc-settings', hidden: true }),
      chart: h('div', { class: 'spc-chart' }, h('div', { class: 'spc-msg', text: 'Загрузка истории цены…' })),
      stats: h('div', { class: 'spc-stats' }),
      table: h('div', null, h('div', { class: 'spc-msg', text: 'Загрузка цен по регионам…' })),
    };
    const gear = h('button', { class: 'spc-btn', type: 'button', title: 'Ключ IsThereAnyDeal и регионы', text: 'Настройки' });
    ui.root.append(
      h('div', { class: 'spc-head' }, h('span', { class: 'spc-title', text: 'История цены' }), ui.regionLabel, h('span', { class: 'spc-grow' }), ui.periods, gear),
      ui.settings,
      ui.chart,
      ui.stats,
      h('div', { class: 'spc-sub', text: 'Цены по регионам' }),
      ui.table
    );
    if (anchor.where === 'after') anchor.el.after(ui.root);
    else if (anchor.where === 'before') anchor.el.before(ui.root);
    else anchor.el.prepend(ui.root);

    const state = {
      adapter,
      appid,
      settings: await loadSettings(adapter),
      detected: detectStoreCountry(),
      period: 'all',
      hist: null,
      histCc: '',
      histCurrency: '',
    };
    // ваш регион: из настроек или из аккаунта Steam
    const homeCc = () => (state.settings.homeRegion === AUTO ? state.detected : state.settings.homeRegion);
    const historyCc = () => (state.settings.historyRegion === AUTO ? homeCc() : state.settings.historyRegion) || 'US';
    // четыре региона и, если ваш регион не из них, он пятой строкой
    const tableRegions = () => {
      const home = homeCc();
      return home && !REGION_NAME[home] ? REGIONS.concat([{ cc: home, name: regionName(home) }]) : REGIONS;
    };

    const drawChart = () => {
      if (!state.hist) return;
      const p = PERIODS.find((x) => x.id === state.period) || PERIODS[0];
      renderChart(ui.chart, state.hist, state.histCurrency, p.years);
    };

    const renderPeriods = () => {
      ui.periods.replaceChildren(
        ...PERIODS.map((p) =>
          h('button', {
            type: 'button',
            class: 'spc-btn' + (p.id === state.period ? ' spc-on' : ''),
            text: p.label,
            onclick: () => {
              state.period = p.id;
              renderPeriods();
              drawChart();
            },
          })
        )
      );
      ui.periods.style.gap = '4px';
      ui.periods.style.display = state.hist && state.hist.length ? 'inline-flex' : 'none';
    };

    const keyForm = (message) => {
      const input = h('input', { type: 'password', placeholder: 'API key IsThereAnyDeal', autocomplete: 'off', spellcheck: 'false' });
      const save = h('button', { class: 'spc-btn', type: 'button', text: 'Сохранить' });
      const doSave = async () => {
        const v = input.value.trim();
        if (!v) return;
        await saveSettings({ itadKey: v });
      };
      save.addEventListener('click', doSave);
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') doSave();
      });
      return h('div', { class: 'spc-msg' },
        h('div', { class: message.err ? 'spc-err' : '', text: message.text }),
        h('div', { class: 'spc-row', style: 'margin:6px 0 4px' }, input, save),
        keyHelp());
    };

    async function loadChart() {
      ui.stats.replaceChildren();
      state.hist = null;
      renderPeriods();
      const key = state.settings.itadKey;
      if (!key) {
        ui.regionLabel.textContent = '';
        ui.chart.replaceChildren(keyForm({ text: 'Для графика истории цены нужен бесплатный ключ API сайта IsThereAnyDeal (таблица ниже работает и без него).' }));
        return;
      }
      ui.chart.replaceChildren(h('div', { class: 'spc-msg', text: 'Загрузка истории цены…' }));
      try {
        const id = await itadGameId(adapter, key, appid);
        if (!id) {
          ui.chart.replaceChildren(h('div', { class: 'spc-msg', text: 'Этой игры нет в базе IsThereAnyDeal, истории цены нет.' }));
          return;
        }
        const wanted = historyCc();
        const order = [wanted].concat(wanted === 'US' ? [] : ['US']);
        let hist = [], cc = order[0], lastErr = null;
        for (const c of order) {
          try {
            hist = await itadHistory(adapter, key, id, c);
            cc = c;
            if (hist.length) break;
          } catch (e) {
            if (e.status === 401 || e.status === 403) throw e;
            lastErr = e;
          }
        }
        if (!hist.length) {
          if (lastErr) throw lastErr;
          ui.chart.replaceChildren(h('div', { class: 'spc-msg', text: 'IsThereAnyDeal ещё не записал ни одного изменения цены этой игры в Steam.' }));
          return;
        }
        state.hist = hist;
        state.histCc = cc;
        state.histCurrency = hist[hist.length - 1].currency || 'USD';
        const fallback = cc !== wanted;
        ui.regionLabel.textContent =
          regionName(cc) + ', ' + currencySymbol(state.histCurrency) + (fallback ? ' (по региону «' + regionName(wanted) + '» данных нет)' : '');
        renderPeriods();
        drawChart();
        renderStats(ui.stats, hist, state.histCurrency);
      } catch (e) {
        if (e.status === 401 || e.status === 403) {
          ui.chart.replaceChildren(keyForm({ err: true, text: 'IsThereAnyDeal не принял ключ: ' + e.message + '. Нужен именно «API key» вашего приложения, а не Client ID или Client Secret из раздела OAuth.' }));
        } else {
          ui.chart.replaceChildren(
            h('div', { class: 'spc-msg' },
              h('span', { class: 'spc-err', text: 'Не удалось загрузить историю цены: ' + e.message + '. ' }),
              h('button', { class: 'spc-btn', type: 'button', text: 'Повторить', onclick: () => loadChart() }))
          );
        }
      }
    }

    async function loadTable() {
      const regions = tableRegions();
      const [prices, rates] = await Promise.all([
        Promise.all(regions.map((r) => fetchRegionPrice(adapter, appid, r.cc).catch((e) => ({ status: 'error', error: e.message })))),
        fetchRubRates(adapter).catch(() => null),
      ]);
      renderTable(ui.table, regions, prices, rates, homeCc());
    }

    async function saveSettings(patch) {
      for (const k of Object.keys(patch)) {
        state.settings[k] = patch[k];
        try {
          await adapter.setSetting(k, patch[k]);
        } catch (e) { /* хотя бы до перезагрузки страницы */ }
      }
      ui.settings.hidden = true;
      await Promise.all([loadChart(), loadTable()]);
    }

    function openSettings() {
      if (!ui.settings.hidden) {
        ui.settings.hidden = true;
        return;
      }
      const key = h('input', { type: 'password', value: state.settings.itadKey, placeholder: 'API key IsThereAnyDeal', autocomplete: 'off', spellcheck: 'false' });
      key.addEventListener('keydown', (e) => e.stopPropagation());
      const show = h('input', { type: 'checkbox' });
      show.addEventListener('change', () => { key.type = show.checked ? 'text' : 'password'; });
      const histSel = regionSelect('historyRegion', state.settings.historyRegion, 'Авто: ваш регион');
      const homeSel = regionSelect('homeRegion', state.settings.homeRegion, 'Авто: ' + (state.detected ? regionName(state.detected) : 'не определён'));
      ui.settings.replaceChildren(
        h('label', null, 'Ключ API IsThereAnyDeal (нужен только для графика)',
          h('div', { class: 'spc-row', style: 'gap:8px;align-items:center' }, key, h('span', { class: 'spc-muted' }, show, ' показать'))),
        keyHelp(),
        h('div', { class: 'spc-row', style: 'margin-top:10px' },
          h('label', null, 'Регион для графика', h('br'), histSel),
          h('label', null, 'Ваш регион', h('br'), homeSel),
          h('label', null,
            h('button', { class: 'spc-btn', type: 'button', text: 'Сохранить', onclick: () => saveSettings({ itadKey: key.value.trim(), historyRegion: histSel.value, homeRegion: homeSel.value }) }),
            ' ',
            h('button', { class: 'spc-btn', type: 'button', text: 'Сбросить кэш', title: 'Заново скачать цены и историю', onclick: () => { cache.drop(''); saveSettings({}); } }))),
        h('div', { class: 'spc-muted', text: 'Steam Price Chart ' + VERSION + '. Ключ хранится только у вас и отправляется только на api.isthereanydeal.com.' })
      );
      ui.settings.hidden = false;
    }
    gear.addEventListener('click', openSettings);

    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(drawChart, 150);
    });

    await Promise.all([loadChart(), loadTable()]);
  }

  globalThis.SteamPriceChart = {
    VERSION,
    mount,
    // для тестов
    _internal: { toSegments, salePeriods, clipToPeriod, fmtMoney, niceStep, findAnchor, detectStoreCountry, regionName },
  };
})();
