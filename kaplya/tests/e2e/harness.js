'use strict';
// Starts the real app under Playwright with a stand-in for the Windows helper and
// for the internet, and gives the tests a few handy moves.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let electronDriver;
try {
  electronDriver = require('playwright')._electron;
} catch {
  electronDriver = require('playwright-core')._electron;
}

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage(app, part, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    for (const page of app.windows()) {
      if (page.url().includes(part)) return page;
    }
    await sleep(100);
  }
  throw new Error('window not found: ' + part);
}

/**
 * @param {object} [opts]
 * @param {object} [opts.data]   contents of kaplya.json before the start
 * @param {object} [opts.env]    extra environment variables
 * @param {boolean} [opts.mock]  false = use the real helper (Windows only)
 * @param {string} [opts.exe]    start this built program instead of the sources
 * @param {string[]} [opts.args] extra command-line switches for the program
 */
async function launch(opts = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kaplya-test-'));
  if (opts.data) fs.writeFileSync(path.join(userData, 'kaplya.json'), JSON.stringify(opts.data));
  const env = {
    ...process.env,
    KAPLYA_TEST: '1',
    KAPLYA_USERDATA: userData,
    KAPLYA_TEST_FETCH: path.join(ROOT, 'tests', 'fake-fetch.js'),
    ...(opts.env || {}),
  };
  if (opts.mock !== false) env.KAPLYA_HELPER_CMD = JSON.stringify([process.execPath, path.join(ROOT, 'tests', 'mock-helper.js')]);
  delete env.NODE_OPTIONS;
  const args = opts.exe ? [] : [ROOT];
  if (process.platform === 'linux') args.push('--no-sandbox');
  args.push(...(opts.args || []));
  const app = await electronDriver.launch({ args, env, executablePath: opts.exe || require('electron') });
  const page = await findPage(app, 'island.html');
  await page.waitForSelector('html[data-ready="true"]', { timeout: 20000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  const main = (fn, arg) => app.evaluate(fn, arg);
  const api = {
    app,
    page,
    userData,
    errors,
    main,
    findPage: (part, t) => findPage(app, part, t),
    mode: () => page.getAttribute('#island', 'data-mode'),
    /** Puts the (pretend) mouse cursor on the island. */
    async hover() {
      await main(() => {
        const t = globalThis.__kaplyaTest;
        const b = t.islandBounds();
        t.setCursor({ x: Math.round(b.x + b.width / 2), y: b.y + Math.round(16 * t.zoom()) });
      });
    },
    /** Moves the cursor far away from the island. */
    async leave() {
      await main(() => {
        const t = globalThis.__kaplyaTest;
        const b = t.islandBounds();
        t.setCursor({ x: b.x + 4, y: b.y + b.height + 200 });
      });
    },
    async open(tab) {
      await api.hover();
      await page.waitForSelector('#island[data-mode="open"]');
      if (tab) {
        await page.click(`#rail button[data-tab="${tab}"]`);
        await page.waitForSelector(`.view-${tab}:not([hidden])`);
      }
      await api.settle();
    },
    /** Waits for the size animation to finish. */
    async settle(ms = 650) {
      await sleep(ms);
    },
    helper: (cmd, args) => main(async (_e, a) => globalThis.__kaplyaTest.system.helper.call(a.cmd, a.args || {}), { cmd, args }),
    /** A picture of the island on a wallpaper-like background. */
    async shot(name, { wallpaper = true } = {}) {
      fs.mkdirSync(OUT, { recursive: true });
      if (wallpaper) {
        await page.evaluate(() => {
          document.body.style.background = 'linear-gradient(160deg,#2c6fb7 0%,#58a6d8 38%,#8fd0d6 62%,#2fa7a0 100%)';
        });
      }
      const file = path.join(OUT, name + '.png');
      await page.screenshot({ path: file, omitBackground: !wallpaper });
      if (wallpaper) await page.evaluate(() => { document.body.style.background = ''; });
      return file;
    },
    async close() {
      try {
        await main(({ app: a }) => a.exit(0));
      } catch {}
      try {
        await app.close();
      } catch {}
      try {
        fs.rmSync(userData, { recursive: true, force: true });
      } catch {}
    },
  };
  return api;
}

module.exports = { launch, sleep, OUT, ROOT, findPage };
