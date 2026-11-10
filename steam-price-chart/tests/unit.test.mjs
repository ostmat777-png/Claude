// Юнит-тесты расчётов графика. Запуск: node --test tests/unit.test.mjs  (из папки steam-price-chart)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(here, '..', 'core', 'steam-price-chart.js'), 'utf8');
const sandbox = { Intl, Date, Math, JSON, Number, Object, Array, String, Promise, setTimeout, clearTimeout };
sandbox.globalThis = sandbox;
vm.runInNewContext(code, sandbox);
const { toSegments, salePeriods, clipToPeriod, rebaseHistory, fmtMoney, niceStep } = sandbox.SteamPriceChart._internal;

// массивы из vm-контекста имеют другой прототип: сравниваем «чистые» копии
const plain = (v) => JSON.parse(JSON.stringify(v));
const DAY = 864e5;
const t = (d) => Date.UTC(2024, 0, 1) + d * DAY;
const pt = (d, price, regular, cut) => ({ t: t(d), price, regular, cut, currency: 'USD' });

test('toSegments: каждая цена держится до следующего изменения, последняя до сейчас', () => {
  const segs = toSegments([pt(0, 10, 10, 0), pt(5, 5, 10, 50), pt(10, 10, 10, 0)], t(20));
  assert.equal(segs.length, 3);
  assert.deepEqual(plain(segs.map((s) => [s.t1, s.t2, s.price])), [[t(0), t(5), 10], [t(5), t(10), 5], [t(10), t(20), 10]]);
});

test('salePeriods: подряд идущие скидки сливаются в одну распродажу', () => {
  const segs = toSegments([pt(0, 10, 10, 0), pt(5, 7, 10, 30), pt(7, 5, 10, 50), pt(10, 10, 10, 0), pt(20, 2.5, 10, 75), pt(25, 10, 10, 0)], t(30));
  const p = salePeriods(segs);
  assert.equal(p.length, 2);
  assert.deepEqual(plain([p[0].t1, p[0].t2, p[0].maxCut, p[0].minPrice, p[0].regular]), [t(5), t(10), 50, 5, 10]);
  assert.deepEqual(plain([p[1].maxCut, p[1].minPrice]), [75, 2.5]);
});

test('clipToPeriod: начало периода получает цену, действовавшую в тот момент', () => {
  const now = t(800);
  const pts = [pt(0, 10, 10, 0), pt(300, 5, 10, 50), pt(310, 10, 10, 0), pt(600, 3, 10, 70)];
  const clipped = clipToPeriod(pts, 1, now);
  const start = now - 365.25 * DAY;
  assert.equal(clipped[0].t, start);
  assert.equal(clipped[0].price, 10); // с 310-го дня действовала обычная цена
  assert.equal(clipped.length, 2);
  assert.equal(clipped[1].price, 3);
  assert.equal(clipToPeriod(pts, 0, now), pts); // «всё время» без изменений
});

test('fmtMoney: валюты регионов', () => {
  const clean = (s) => s.replace(/[  ]/g, ' ');
  assert.equal(clean(fmtMoney(17999, 'KZT')), '17 999 ₸');
  assert.equal(clean(fmtMoney(1399, 'UAH')), '1 399 ₴');
  assert.equal(clean(fmtMoney(1234, 'RUB', 0)), '1 234 ₽');
  assert.equal(fmtMoney(59.99, 'USD'), '$59.99');
  assert.equal(fmtMoney(6, 'USD'), '$6.00');
  assert.equal(fmtMoney(null, 'USD'), '—');
});

test('niceStep: круглые деления шкалы', () => {
  assert.equal(niceStep(2400, 3), 1000);
  assert.equal(niceStep(60, 3), 20);
  assert.equal(niceStep(14.99, 3), 5);
});

test('rebaseHistory: скидки из истории в долларах, цены в тенге от нынешней цены в Казахстане', () => {
  const us = [pt(0, 19.99, 19.99, 0), pt(10, 9.99, 19.99, 50), pt(20, 19.99, 19.99, 0), pt(30, 14.99, 29.99, 50), pt(40, 29.99, 29.99, 0)];
  const kz = rebaseHistory(us, { currency: 'KZT', initial: 7999, final: 7999, discount: 0 });
  assert.deepEqual(plain(kz.map((p) => [p.regular, p.price, p.cut, p.currency])), [
    [5332, 5332, 0, 'KZT'], // обычная цена была ниже в той же пропорции: 7999 * 19.99 / 29.99
    [5332, 2666, 50, 'KZT'],
    [5332, 5332, 0, 'KZT'],
    [7999, 3999, 50, 'KZT'], // Steam округляет цену со скидкой вниз
    [7999, 7999, 0, 'KZT'],
  ]);
  assert.deepEqual(plain(kz.map((p) => p.t)), plain(us.map((p) => p.t)));
});

test('rebaseHistory: текущая цена берётся ровно из Steam, если скидка совпадает', () => {
  const us = [pt(0, 59.99, 59.99, 0), pt(10, 23.99, 59.99, 60)];
  const ua = rebaseHistory(us, { currency: 'UAH', initial: 1399, final: 559, discount: 60 });
  assert.deepEqual(plain(ua.map((p) => [p.regular, p.price, p.cut])), [[1399, 1399, 0], [1399, 559, 60]]);
  const eur = rebaseHistory(us, { currency: 'EUR', initial: 59.99, final: 59.99, discount: 0 });
  assert.equal(eur[1].price, 23.99);
  assert.deepEqual(plain(rebaseHistory([], { currency: 'KZT', initial: 100 })), []);
});
