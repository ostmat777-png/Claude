'use strict';
// Draws the app icon and the tray icon and writes them to assets/.
// Needs Playwright with Chromium (a development tool, not part of the app):
//
//   node tools/make-icons.js

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const OUT = path.join(__dirname, '..', 'assets');

const DROP = 'M128 34C128 34 58 116 58 164a70 70 0 0 0 140 0C198 116 128 34 128 34Z';

const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b2550"/><stop offset="1" stop-color="#090b16"/></linearGradient>
    <linearGradient id="drop" x1="0.2" y1="0" x2="0.8" y2="1"><stop offset="0" stop-color="#c9f1ff"/><stop offset="0.55" stop-color="#6cc6ff"/><stop offset="1" stop-color="#3a86f0"/></linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="58" fill="url(#bg)"/>
  <rect x="8.5" y="8.5" width="239" height="239" rx="57.5" fill="none" stroke="#ffffff" stroke-opacity=".12"/>
  <path d="${DROP}" fill="url(#drop)"/>
  <path d="M96 168c0 18 12 31 28 35" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="9" stroke-linecap="round"/>
</svg>`;

// The tray icon is tiny: just the drop, bright enough for a dark or a light taskbar.
const trayIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="40 22 176 220">
  <defs><linearGradient id="d" x1="0.2" y1="0" x2="0.8" y2="1"><stop offset="0" stop-color="#9bdcff"/><stop offset="1" stop-color="#3a86f0"/></linearGradient></defs>
  <path d="${DROP}" fill="url(#d)" stroke="#0b1530" stroke-opacity=".35" stroke-width="6"/>
</svg>`;

async function render(page, svg, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div></body>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

/** An .ico file that holds PNG pictures (Windows Vista and later read these). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = [];
  for (const size of sizes) images.push({ size, png: await render(page, appIcon, size) });
  fs.writeFileSync(path.join(OUT, 'icon.png'), images[images.length - 1].png);
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico(images));
  fs.writeFileSync(path.join(OUT, 'tray.png'), await render(page, trayIcon, 16));
  fs.writeFileSync(path.join(OUT, 'tray@2x.png'), await render(page, trayIcon, 32));
  fs.writeFileSync(path.join(OUT, 'tray@3x.png'), await render(page, trayIcon, 48));
  await browser.close();
  console.log('wrote', fs.readdirSync(OUT).join(', '));
})();
