import test from 'node:test';
import assert from 'node:assert/strict';

import * as tt from '../../src/shared/texttools.mjs';
import { calculate, formatNumber } from '../../src/shared/calc.mjs';
import { parseLrc, lineAt, formatTime } from '../../src/shared/lrc.mjs';
import { parseReminder, describeTime } from '../../src/shared/remind.mjs';
import { describeCode, windName, uvLevel, normalizeForecast, sunProgress, formatTemp, forecastUrl } from '../../src/shared/weather.mjs';
import { parseNetworks, parseConnectedSsid, profileXml } from '../../src/shared/netsh.mjs';
import { score, rank } from '../../src/shared/fuzzy.mjs';

test('layout switch: wrong-layout text both ways', () => {
  assert.equal(tt.switchLayout('ghbdtn'), 'привет');
  assert.equal(tt.switchLayout('Ghbdtn? vbh!'), 'Привет, мир!');
  assert.equal(tt.switchLayout('руддщ цщкдв'), 'hello world');
  assert.equal(tt.switchLayout('Цштвщцы'), 'Windows');
  // and back again
  assert.equal(tt.switchLayout(tt.switchLayout('Какой-то текст, с запятой.')), 'Какой-то текст, с запятой.');
});

test('translit', () => {
  assert.equal(tt.translit('Привет, мир'), 'Privet, mir');
  assert.equal(tt.translit('Щука и ёж'), 'Shchuka i yozh');
  assert.equal(tt.translit('ЩУКА'), 'SHCHUKA');
  assert.equal(tt.translit('объём'), 'obyom');
});

test('case tools', () => {
  assert.equal(tt.titleCase('привет, БОЛЬШОЙ мир'), 'Привет, Большой Мир');
  assert.equal(tt.titleCase("it's fine"), "It's Fine");
  assert.equal(tt.sentenceCase('ПЕРВОЕ. второе! третье'), 'Первое. Второе! Третье');
  assert.equal(tt.invertCase('аБв'), 'АбВ');
});

test('line breaks and spaces', () => {
  assert.equal(tt.removeLineBreaks('строка раз-\nорвана\nпосередине\n\nвторой\nабзац'), 'строка разорвана посередине\n\nвторой абзац');
  assert.equal(tt.cleanSpaces('  много   пробелов ,и  так \n\n\n\nдалее  '), 'много пробелов,и так\n\nдалее');
  assert.equal(tt.uniqueLines('a\nb\na\nc\nb'), 'a\nb\nc');
  assert.equal(tt.sortLines('б\nа\n10\n9'), '9\n10\nа\nб');
});

test('json, base64, url', () => {
  assert.equal(tt.jsonPretty('{"a":[1,2]}'), '{\n  "a": [\n    1,\n    2\n  ]\n}');
  assert.equal(tt.jsonMinify('{ "a" : [ 1, 2 ] }'), '{"a":[1,2]}');
  assert.throws(() => tt.jsonPretty('не json'));
  const text = 'Привет 🙂 world';
  assert.equal(tt.base64Decode(tt.base64Encode(text)), text);
  assert.equal(tt.base64Encode('hello'), 'aGVsbG8=');
  assert.throws(() => tt.base64Decode('%%%'));
  assert.equal(tt.urlDecode(tt.urlEncode('а б&в')), 'а б&в');
});

test('stats', () => {
  assert.deepEqual(tt.stats('Привет, мир!\nВторая строка'), { chars: 26, noSpaces: 23, words: 4, lines: 2 });
  assert.deepEqual(tt.stats(''), { chars: 0, noSpaces: 0, words: 0, lines: 0 });
});

test('every text tool has a label and survives empty input', () => {
  for (const tool of tt.TOOLS) {
    assert.ok(tool.id && tool.label);
    if (!tool.error) assert.equal(typeof tool.fn(''), 'string');
  }
});

test('calculator', () => {
  assert.equal(calculate('2+2*2'), 6);
  assert.equal(calculate('(2+2)*2'), 8);
  assert.equal(calculate('2^10'), 1024);
  assert.equal(calculate('-3 + 5'), 2);
  assert.equal(calculate('1,5 * 2'), 3);
  assert.equal(calculate('1 000 000 / 4'), 250000);
  assert.equal(calculate('10 / 4'), 2.5);
  assert.equal(calculate('200 + 10%'), 220);
  assert.equal(calculate('200 - 10%'), 180);
  assert.equal(calculate('15% от 2400'), 360);
  assert.equal(calculate('sqrt(16) + 1'), 5);
  assert.equal(calculate('2 × 3 ÷ 4'), 1.5);
  assert.ok(Math.abs(calculate('0.1 + 0.2') - 0.3) < 1e-12);
});

test('calculator refuses what is not arithmetic', () => {
  for (const q of ['', '42', 'привет', 'chrome', '2 +', 'alert(1)', '1/0', 'process.exit(1)', '2 ** 3 **', 'a+1', '(1+2']) {
    assert.equal(calculate(q), null, q);
  }
});

test('number formatting', () => {
  assert.equal(formatNumber(0.1 + 0.2), '0,3');
  assert.equal(formatNumber(1234567.891), '1 234 567,891');
  assert.equal(formatNumber(-1500), '-1 500');
  assert.equal(formatNumber(6), '6');
});

test('lrc', () => {
  const lines = parseLrc('[ar:Someone]\n[00:12.50]first\n[00:20.00][01:00.00]again\n\n[00:15]second\nno stamp');
  assert.deepEqual(lines.map((l) => [l.t, l.text]), [[12.5, 'first'], [15, 'second'], [20, 'again'], [60, 'again']]);
  assert.equal(lineAt(lines, 0), -1);
  assert.equal(lineAt(lines, 12.5), 0);
  assert.equal(lineAt(lines, 19.9), 1);
  assert.equal(lineAt(lines, 999), 3);
  assert.equal(formatTime(187), '3:07');
  assert.equal(formatTime(3725), '1:02:05');
});

test('reminders: relative time', () => {
  const now = new Date(2026, 10, 11, 15, 0, 0);
  let r = parseReminder('через 20 минут позвонить Ане', now);
  assert.equal(r.at - now.getTime(), 20 * 60000);
  assert.equal(r.text, 'позвонить Ане');
  r = parseReminder('позвонить маме через 2 часа', now);
  assert.equal(r.at - now.getTime(), 2 * 3600000);
  assert.equal(r.text, 'позвонить маме');
  r = parseReminder('через полчаса чай', now);
  assert.equal(r.at - now.getTime(), 30 * 60000);
  r = parseReminder('напомни через час выключить духовку', now);
  assert.equal(r.at - now.getTime(), 3600000);
  assert.equal(r.text, 'выключить духовку');
});

test('reminders: clock time and days', () => {
  const now = new Date(2026, 10, 11, 15, 0, 0); // Wednesday
  let r = parseReminder('в 15:30 созвон', now);
  assert.deepEqual([new Date(r.at).getDate(), new Date(r.at).getHours(), new Date(r.at).getMinutes()], [11, 15, 30]);
  assert.equal(r.text, 'созвон');
  r = parseReminder('в 9 таблетки', now); // already past today
  assert.deepEqual([new Date(r.at).getDate(), new Date(r.at).getHours()], [12, 9]);
  r = parseReminder('завтра в 9 таблетки', now);
  assert.deepEqual([new Date(r.at).getDate(), new Date(r.at).getHours()], [12, 9]);
  r = parseReminder('завтра купить хлеб', now);
  assert.deepEqual([new Date(r.at).getDate(), new Date(r.at).getHours()], [12, 9]);
  assert.equal(r.text, 'купить хлеб');
  r = parseReminder('в пятницу в 18 кино', now);
  assert.deepEqual([new Date(r.at).getDate(), new Date(r.at).getHours()], [13, 18]);
  assert.equal(r.text, 'кино');
  r = parseReminder('в 7 вечера ужин', now);
  assert.equal(new Date(r.at).getHours(), 19);
  assert.equal(parseReminder('просто заметка', now), null);
  assert.equal(parseReminder('в 25:00 ошибка', now), null);
});

test('reminder time in words', () => {
  const now = new Date(2026, 10, 11, 15, 0, 0);
  assert.equal(describeTime(new Date(2026, 10, 11, 15, 30).getTime(), now), 'сегодня в 15:30');
  assert.equal(describeTime(new Date(2026, 10, 12, 9, 0).getTime(), now), 'завтра в 9:00');
  assert.match(describeTime(new Date(2026, 10, 13, 18, 0).getTime(), now), /13 ноября в 18:00/);
});

test('weather codes and wind', () => {
  assert.deepEqual(describeCode(0, true), { text: 'Ясно', icon: 'sun' });
  assert.deepEqual(describeCode(0, false), { text: 'Ясно', icon: 'moon' });
  assert.equal(describeCode(95).icon, 'cloud-lightning');
  assert.equal(describeCode(12345).text, 'Погода');
  assert.equal(windName(0), 'северный');
  assert.equal(windName(225), 'юго-западный');
  assert.equal(windName(359), 'северный');
  assert.equal(uvLevel(0), 'низкий');
  assert.equal(uvLevel(7), 'высокий');
  assert.equal(formatTemp(-3.4), '−3°');
  assert.equal(formatTemp(-0.2), '0°');
  assert.equal(formatTemp(17.6), '18°');
});

test('forecast is normalised from the Open-Meteo answer', () => {
  const hours = [];
  for (let d = 11; d <= 12; d++) for (let h = 0; h < 24; h++) hours.push(`2026-11-${d}T${String(h).padStart(2, '0')}:00`);
  const raw = {
    utc_offset_seconds: 10800,
    current: {
      time: '2026-11-11T21:15', temperature_2m: 3.2, apparent_temperature: -0.5, is_day: 0, weather_code: 61,
      relative_humidity_2m: 87, surface_pressure: 1000, wind_speed_10m: 4.1, wind_direction_10m: 230, wind_gusts_10m: 9,
      precipitation: 0.4, cloud_cover: 100, dew_point_2m: 1.1, uv_index: 0,
    },
    hourly: {
      time: hours,
      temperature_2m: hours.map((_, i) => i),
      weather_code: hours.map(() => 3),
      precipitation_probability: hours.map(() => 40),
      is_day: hours.map((_, i) => (i % 24 > 8 && i % 24 < 17 ? 1 : 0)),
    },
    daily: {
      time: ['2026-11-11', '2026-11-12'], weather_code: [61, 3], temperature_2m_max: [5, 4], temperature_2m_min: [1, 0],
      sunrise: ['2026-11-11T08:02', '2026-11-12T08:04'], sunset: ['2026-11-11T16:31', '2026-11-12T16:29'],
      uv_index_max: [0.6, 0.5], precipitation_sum: [2.1, 0], precipitation_probability_max: [80, 20],
    },
  };
  const place = { name: 'Москва', lat: 55.75, lon: 37.62 };
  const w = normalizeForecast(raw, place, 123);
  assert.equal(w.current.pressure, 750);
  assert.equal(w.current.isDay, false);
  assert.equal(w.hourly.length, 24);
  assert.equal(w.hourly[0].hour, '21:00'); // starts from the current hour
  assert.equal(w.hourly[0].temp, 21);
  assert.equal(w.daily.length, 2);
  assert.equal(w.daily[0].sunset, '2026-11-11T16:31');
  assert.ok(sunProgress(w.localTime, w.daily[0].sunrise, w.daily[0].sunset) > 1); // night
  assert.ok(Math.abs(sunProgress('2026-11-11T12:16', '2026-11-11T08:02', '2026-11-11T16:31') - 0.5) < 0.01);
  assert.match(forecastUrl(place), /latitude=55\.75&longitude=37\.62/);
  // a broken answer must not throw
  assert.equal(normalizeForecast({}, place).hourly.length, 0);
});

const NETSH_EN = `
Interface name : Wi-Fi
There are 3 networks currently visible.

SSID 1 : Home-5G
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP
    BSSID 1                 : aa:bb:cc:dd:ee:01
         Signal             : 92%
         Radio type         : 802.11ac
         Channel            : 36
    BSSID 2                 : aa:bb:cc:dd:ee:02
         Signal             : 61%
         Radio type         : 802.11n
         Channel            : 6

SSID 2 : Cafe Wi-Fi
    Network type            : Infrastructure
    Authentication          : Open
    Encryption              : None
    BSSID 1                 : 11:22:33:44:55:66
         Signal             : 48%
         Radio type         : 802.11n
         Channel            : 1

SSID 3 :
    Network type            : Infrastructure
    Authentication          : WPA3-Personal
    Encryption              : CCMP
    BSSID 1                 : 77:22:33:44:55:66
         Signal             : 99%
`;

const NETSH_RU = `
Имя интерфейса : Беспроводная сеть
В настоящее время видны сети: 2.

SSID 1 : Сосед: дома
    Тип сети                : Инфраструктура
    Проверка подлинности    : WPA2-Personal
    Шифрование              : CCMP
    BSSID 1                 : aa:bb:cc:dd:ee:01
         Сигнал             : 30%
         Тип радио          : 802.11n
         Канал              : 11

SSID 2 : Open Net
    Тип сети                : Инфраструктура
    Проверка подлинности    : Открыть
    Шифрование              : Нет
    BSSID 1                 : 11:22:33:44:55:66
         Сигнал             : 75%
`;

test('netsh network list, English and Russian Windows', () => {
  const en = parseNetworks(NETSH_EN);
  assert.deepEqual(en.map((n) => [n.ssid, n.signal, n.bars, n.secure]), [['Home-5G', 92, 4, true], ['Cafe Wi-Fi', 48, 2, false]]);
  const ru = parseNetworks(NETSH_RU);
  assert.deepEqual(ru.map((n) => [n.ssid, n.signal, n.secure]), [['Open Net', 75, false], ['Сосед: дома', 30, true]]);
  assert.deepEqual(parseNetworks(''), []);
});

test('netsh connected network', () => {
  const out = `
    Name                   : Wi-Fi
    State                  : connected
    SSID                   : Home-5G
    BSSID                  : aa:bb:cc:dd:ee:01
`;
  assert.equal(parseConnectedSsid(out), 'Home-5G');
  assert.equal(parseConnectedSsid('    Name : Wi-Fi\n    State : disconnected\n'), null);
});

test('wifi profile xml', () => {
  const xml = profileXml('Кафе & <друзья>', 'p@ss"word<1>', 'WPA2-Personal');
  assert.match(xml, /<name>Кафе &amp; &lt;друзья&gt;<\/name>/);
  assert.match(xml, /<authentication>WPA2PSK<\/authentication>/);
  assert.match(xml, /<keyMaterial>p@ss&quot;word&lt;1&gt;<\/keyMaterial>/);
  assert.match(profileXml('x', 'secret12', 'WPA3-Personal'), /WPA3SAE/);
  const open = profileXml('Free', '', 'Open');
  assert.match(open, /<authentication>open<\/authentication>/);
  assert.doesNotMatch(open, /sharedKey/);
  assert.match(profileXml('AB', '', ''), /<hex>4142<\/hex>/);
});

test('fuzzy ranking', () => {
  const apps = ['Visual Studio Code', 'Google Chrome', 'Блокнот', 'Калькулятор', 'Photoshop', 'Steam', 'Telegram'];
  const top = (q) => rank(apps, q, (x) => x)[0];
  assert.equal(top('chr'), 'Google Chrome');
  assert.equal(top('code'), 'Visual Studio Code');
  assert.equal(top('vsc'), 'Visual Studio Code');
  assert.equal(top('блок'), 'Блокнот');
  assert.equal(top('кальк'), 'Калькулятор');
  assert.equal(top('ыеуфь'), 'Steam'); // typed in the Russian layout
  assert.equal(top('pshop'), 'Photoshop');
  assert.deepEqual(rank(apps, 'zzzz', (x) => x), []);
  assert.ok(score('Steam', 'steam') > score('Steam Link', 'steam'));
});
