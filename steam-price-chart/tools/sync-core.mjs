// Копирует общий модуль core/steam-price-chart.js в плагин Millennium и в расширение браузера.
// Запуск: node tools/sync-core.mjs        (из папки steam-price-chart)
//         node tools/sync-core.mjs --check (только проверить, что копии совпадают)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'core', 'steam-price-chart.js');
const targets = [
  join(root, 'millennium', 'webview', 'steam-price-chart.js'),
  join(root, 'browser-extension', 'steam-price-chart.js'),
];

const check = process.argv.includes('--check');
const code = readFileSync(source, 'utf8');
let stale = 0;
for (const t of targets) {
  const same = existsSync(t) && readFileSync(t, 'utf8') === code;
  if (same) continue;
  if (check) {
    console.error('Устарела копия: ' + t);
    stale++;
  } else {
    writeFileSync(t, code);
    console.log('Обновлено: ' + t);
  }
}
if (check && stale) process.exit(1);
if (check) console.log('Копии ядра совпадают с core/steam-price-chart.js');
