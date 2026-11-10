// Проверка виджета в настоящем Chromium (Playwright) на мини-странице с разметкой блока покупки Steam
// и с той же политикой CSP, что у магазина. Сеть подменяется, интернет не нужен.
// Запуск: node tests/e2e.cjs   (из папки steam-price-chart; нужен установленный playwright)
const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert/strict');

const CORE = path.join(__dirname, '..', 'core', 'steam-price-chart.js');
const CSP = "default-src blob: data: https: 'unsafe-inline' 'unsafe-eval'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; object-src 'none'; connect-src 'self' https://store.steampowered.com https://api.steampowered.com";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Test</title>
<style>body{background:#1b2838;color:#c6d4df;font-family:Arial,sans-serif}.leftcol{width:616px;margin:20px}</style></head>
<body><div id="application_config" data-userinfo='{"logged_in":true,"country_code":"DE"}'></div>
<div class="leftcol game_description_column"><div id="game_area_purchase" class="game_area_purchase">
  <div class="game_area_purchase_game_wrapper demo"><div class="game_area_purchase_game"><h2>Скачать демо</h2></div></div>
  <div class="game_area_purchase_game_wrapper main"><div class="game_area_purchase_game"><h2 class="title">Купить Test Game</h2>
    <div class="game_purchase_action"><div class="game_purchase_price price">17 999₸</div></div></div></div>
  <div id="gameAreaDLCSection" class="game_area_dlc_section"><div class="game_area_purchase_game_wrapper"><div class="game_purchase_price">1₸</div></div></div>
</div><div id="game_area_description">Описание</div></div></body></html>`;

const PRICES = {
  kz: { currency: 'KZT', initial: 1799900, final: 1799900, discount_percent: 0, initial_formatted: '', final_formatted: '17 999₸' },
  ua: { currency: 'UAH', initial: 139900, final: 139900, discount_percent: 0, initial_formatted: '', final_formatted: '1 399₴' },
  us: { currency: 'USD', initial: 5999, final: 2999, discount_percent: 50, initial_formatted: '$59.99', final_formatted: '$29.99' },
  de: { currency: 'EUR', initial: 5999, final: 5999, discount_percent: 0, initial_formatted: '', final_formatted: '59,99€' },
};
const CBR = { Date: '2026-11-11T11:30:00+03:00', Valute: { USD: { Nominal: 1, Value: 82.5 }, KZT: { Nominal: 100, Value: 18 }, UAH: { Nominal: 10, Value: 18.2 }, EUR: { Nominal: 1, Value: 92 } } };
const GAME_ID = '018d937f-2997-7131-b8b9-7c8af4825fa8';
const hist = (iso, price, regular, cut, currency = 'USD') => ({ timestamp: iso, shop: { id: 61, name: 'Steam' }, deal: { price: { amount: price, amountInt: price * 100, currency }, regular: { amount: regular, amountInt: regular * 100, currency }, cut } });
const HISTORY_US = [
  hist('2023-11-28T19:00:00+01:00', 59.99, 59.99, 0),
  hist('2023-11-21T19:00:00+01:00', 23.99, 59.99, 60),
  hist('2021-07-08T19:00:00+01:00', 59.99, 59.99, 0),
  hist('2021-06-24T19:00:00+01:00', 29.99, 59.99, 50),
  hist('2020-12-10T00:00:00+01:00', 59.99, 59.99, 0),
];
// для Украины у «IsThereAnyDeal» есть своя история в гривнах: её надо показать как есть
const HISTORY_UA = [
  hist('2023-11-28T19:00:00+01:00', 1399, 1399, 0, 'UAH'),
  hist('2023-11-21T19:00:00+01:00', 489, 1399, 65, 'UAH'),
  hist('2020-12-10T00:00:00+01:00', 1399, 1399, 0, 'UAH'),
];
const HISTORY = { US: HISTORY_US, UA: HISTORY_UA };

function backend(url) {
  const u = new URL(url);
  if (u.hostname === 'www.cbr-xml-daily.ru') return { status: 200, body: JSON.stringify(CBR) };
  if (u.hostname === 'api.isthereanydeal.com') {
    if (u.searchParams.get('key') !== 'K') return { status: 403, body: '{"reason_phrase":"Invalid api key"}' };
    if (u.pathname === '/games/lookup/v1') return { status: 200, body: JSON.stringify({ found: true, game: { id: GAME_ID } }) };
    if (u.pathname === '/games/history/v2') {
      assert.ok(u.searchParams.get('since'), 'история запрашивается с параметром since (иначе только 3 месяца)');
      assert.equal(u.searchParams.get('shops'), '61');
      return { status: 200, body: JSON.stringify(HISTORY[u.searchParams.get('country')] || []) };
    }
  }
  return { status: 0, error: 'unexpected ' + url };
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 } });
  const direct = [];
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'store.steampowered.com' && u.pathname.startsWith('/app/')) {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'content-security-policy': CSP }, body: PAGE });
    }
    if (u.hostname === 'store.steampowered.com' && u.pathname === '/api/appdetails') {
      const cc = u.searchParams.get('cc');
      const id = u.searchParams.get('appids');
      const body = PRICES[cc] ? { [id]: { success: true, data: { price_overview: PRICES[cc] } } } : { [id]: { success: false } };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    }
    direct.push(u.href);
    return route.abort();
  });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.exposeFunction('__backend', (url) => JSON.stringify(backend(url)));
  await page.goto('https://store.steampowered.com/app/1091500/Test/');
  await page.addScriptTag({ path: CORE });
  await page.evaluate(() => {
    window.__store = { itadKey: 'K' };
    return window.SteamPriceChart.mount({
      async fetchText(url) {
        if (new URL(url, location.href).origin === location.origin) {
          const r = await fetch(url);
          return { status: r.status, body: await r.text() };
        }
        return JSON.parse(await window.__backend(url));
      },
      getSetting: async (k) => window.__store[k],
      setSetting: async (k, v) => { window.__store[k] = v; },
    });
  });

  const r = await page.evaluate(() => {
    const root = document.getElementById('spc-root');
    return {
      afterMain: root.previousElementSibling.classList.contains('main'),
      rows: Array.from(root.querySelectorAll('tbody tr')).map((tr) => ({ cls: tr.className, text: tr.innerText.replace(/\s+/g, ' ').trim() })),
      label: root.querySelector('.spc-head > .spc-muted').textContent,
      pick: root.querySelector('.spc-head select[name=chartRegion]').value,
      paths: root.querySelectorAll('.spc-chart path').length,
      svgText: Array.from(root.querySelectorAll('.spc-chart text')).map((t) => t.textContent),
      stats: root.querySelector('.spc-stats').innerText.replace(/\s+/g, ' '),
    };
  });

  assert.ok(r.afterMain, 'виджет стоит сразу под блоком с ценой (не под демо)');
  // регион аккаунта (DE) не из четырёх: добавлен пятой строкой
  assert.equal(r.rows.length, 5);
  assert.deepEqual(r.rows.map((x) => x.text.split(' ')[0]), ['Казахстан', 'Украина', 'Россия', 'США', 'Германияваш']);
  assert.doesNotMatch(r.rows[0].text, /ваш регион/);
  assert.match(r.rows[2].text, /не продаётся в регионе/);
  // KZ 17999*0.18=3240 ₽, UA 1399*1.82=2546 ₽, US 29.99*82.5=2474 ₽ (скидка −50%), DE 59.99*92=5519 ₽
  assert.equal(r.rows[3].cls, 'spc-cheap', 'США со скидкой дешевле всех: зелёная рамка');
  assert.equal(r.rows[4].cls, 'spc-dear', 'Германия дороже всех: красная рамка');
  assert.equal(r.rows[0].cls, '');
  assert.equal(r.rows[1].cls, '');
  assert.match(r.rows[3].text, /\$59\.99\s*\$29\.99\s*−50%/);
  assert.match(r.rows[3].text, /≈ 2\s474 ₽/);
  // график в валюте региона аккаунта: своей истории в евро нет, пересчитано по скидкам в США
  assert.equal(r.pick, 'DE');
  assert.equal(r.label, '€ · пересчёт по скидкам в США (?)');
  assert.equal(r.paths, 2, 'линия цены и линия обычной цены');
  assert.ok(r.svgText.includes('−60%') && r.svgText.includes('−50%'), 'подписи скидок на графике: ' + r.svgText.join(','));
  assert.match(r.stats, /Минимум: 23,99\s€ \(−60%\)/);
  assert.match(r.stats, /Скидок: 2/);

  const styles = await page.evaluate(() => {
    const cs = (sel) => getComputedStyle(document.querySelector(sel)).borderTopColor;
    return { cheap: cs('#spc-root tr.spc-cheap td'), dear: cs('#spc-root tr.spc-dear td') };
  });
  assert.equal(styles.cheap, 'rgb(111, 191, 46)', 'зелёная обводка');
  assert.equal(styles.dear, 'rgb(217, 74, 74)', 'красная обводка');

  // настройки: ручной выбор региона сохраняется через адаптер и меняет таблицу
  await page.click('#spc-root .spc-head .spc-btn:text("Настройки")');
  await page.selectOption('#spc-root .spc-settings select[name=homeRegion]', 'KZ');
  await page.click('#spc-root .spc-settings .spc-btn:text("Сохранить")');
  await page.waitForFunction(() => document.querySelector('#spc-root .spc-settings').hidden);
  await page.waitForFunction(() => document.querySelectorAll('#spc-root tbody tr').length === 4);
  assert.equal(await page.evaluate(() => window.__store.homeRegion), 'KZ');
  assert.equal(await page.evaluate(() => window.__store.historyRegion), 'auto');
  assert.match(await page.locator('#spc-root tbody tr').first().innerText(), /ваш регион/);
  const chartState = () => page.evaluate(() => ({
    pick: document.querySelector('#spc-root select[name=chartRegion]').value,
    label: document.querySelector('#spc-root .spc-head > .spc-muted').textContent,
    stats: document.querySelector('#spc-root .spc-stats').innerText.replace(/\s+/g, ' '),
  }));
  await page.waitForFunction(() => document.querySelector('#spc-root select[name=chartRegion]').value === 'KZ');
  await page.waitForSelector('#spc-root .spc-chart svg');
  let c = await chartState();
  // тенге: обычная 17 999 ₸, −60% → 7 199 ₸ (вниз, как в Steam)
  assert.equal(c.label, '₸ · пересчёт по скидкам в США (?)');
  assert.match(c.stats, /Минимум: 7\s199\s₸ \(−60%\)/);

  // быстрый выбор региона над графиком: у Украины своя история в гривнах
  await page.selectOption('#spc-root select[name=chartRegion]', 'UA');
  await page.waitForFunction(() => /₴/.test(document.querySelector('#spc-root .spc-head > .spc-muted').textContent));
  c = await chartState();
  assert.equal(c.label, '₴', 'настоящая история в гривнах, без пересчёта');
  assert.match(c.stats, /Минимум: 489\s₴ \(−65%\)/);
  assert.equal(await page.evaluate(() => window.__store.historyRegion), 'UA');

  // в России игра не продаётся: пересчитать не во что, показана история США в долларах
  await page.selectOption('#spc-root select[name=chartRegion]', 'RU');
  await page.waitForFunction(() => /Россия/.test(document.querySelector('#spc-root .spc-head > .spc-muted').textContent));
  c = await chartState();
  assert.equal(c.label, '$ · Россия: не продаётся, показаны цены США');
  assert.match(c.stats, /Минимум: \$23\.99 \(−60%\)/);

  // наведение на график показывает подсказку
  const box = await page.locator('#spc-root .spc-chart svg').boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  assert.match(await page.locator('#spc-root .spc-tip').innerText(), /\$/);

  assert.deepEqual(direct, [], 'страница не ходит на чужие сайты напрямую');
  assert.deepEqual(pageErrors, []);
  await browser.close();
  console.log('e2e: OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
