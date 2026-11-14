'use strict';
// Makes the pictures for README.md (docs/*.jpg). Development tool:
//
//   xvfb-run -a -s "-screen 0 1920x1080x24" node tests/e2e/screens.js
//
// Needs ImageMagick ("convert") to crop and compress.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { launch, sleep, OUT, ROOT } = require('./harness.js');

const DOCS = path.join(ROOT, 'docs');
const MOSCOW = { name: 'Москва', region: 'Россия', lat: 55.75, lon: 37.62 };

function jpg(src, name, crop) {
  const args = [src];
  if (crop) args.push('-crop', crop, '+repage');
  args.push('-quality', '88', path.join(DOCS, name + '.jpg'));
  const r = spawnSync('convert', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('convert failed: ' + r.stderr);
}

const closing = (p) => p.catch(() => {});

(async () => {
  fs.mkdirSync(DOCS, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  const k = await launch({ data: { settings: { weather: { place: MOSCOW, askedOnce: true } }, notes: [{ id: 'n1', text: 'Выпуск в пятницу\n— дописать инструкцию\n— записать ролик\n— проверить обновление' }] } });
  try {
    await sleep(1500);
    await k.main(() => globalThis.__kaplyaTest.clipio.writeText('Адрес: ул. Лесная, 12, кв. 48'));
    await sleep(900);
    await k.main(() => globalThis.__kaplyaTest.clipio.writeText('https://example.com/maket'));
    await sleep(2800);

    // the pill and the toasts, one under another
    const strips = [];
    const strip = async (name) => {
      await k.settle(500);
      const f = await k.shot('doc-' + name);
      const out = path.join(OUT, 'strip-' + name + '.png');
      spawnSync('convert', [f, '-crop', '620x84+160+0', '+repage', out]);
      strips.push(out);
    };
    await k.leave();
    await k.page.waitForSelector('#island[data-mode="pill"]', { timeout: 8000 });
    await strip('pill');
    await k.main(() => globalThis.__kaplyaTest.clipio.writeText('Созвон перенесли на 15:00'));
    await k.page.waitForSelector('#island[data-mode="toast"]');
    await strip('copied');
    await k.page.waitForSelector('#island[data-mode="pill"]', { timeout: 8000 });
    await k.main(() => globalThis.__kaplyaTest.toast({ type: 'timer', title: 'Время вышло', text: 'Таймер · 5 мин', sticky: true }));
    await k.page.waitForSelector('#island[data-mode="toast"]');
    await strip('timer');
    await k.page.click('.toast-actions .round.primary');
    spawnSync('convert', [...strips, '-append', '-quality', '88', path.join(DOCS, 'pill.jpg')]);

    // tabs
    await k.open('home');
    await k.helper('media.cmd', { action: 'seek', position: 40 });
    await sleep(1500);
    await k.page.click('.player-lyrics');
    await k.page.waitForSelector('.lyrics-full .lline.now');
    await k.page.click('.player-like');
    await sleep(900);
    jpg(await k.shot('doc-home'), 'home', '940x450+0+0');
    await k.page.click('.stage-head button[title="Свернуть"]');
    await k.open('weather');
    jpg(await k.shot('doc-weather'), 'weather', '940x430+0+0');
    await k.open('control');
    await k.page.click('.ctl-tile[data-tile="wifi"] .ctl-more');
    await k.page.waitForSelector('.net');
    await k.settle();
    jpg(await k.shot('doc-control'), 'control', '940x420+0+0');
    await k.open('notes');
    await k.page.locator('.timer-presets .chip', { hasText: '25' }).click();
    await k.page.click('.timer-start');
    await k.page.fill('.reminders input', 'завтра в 9 позвонить Ане');
    await sleep(1200);
    jpg(await k.shot('doc-notes'), 'notes', '940x340+0+0');
    await k.app.evaluate(() => {});
    await k.page.evaluate(async () => {
      const { app } = await import('./js/island.js');
      app.timer.reset();
    });
    await k.open('text');
    await k.page.fill('.text-area', 'ghbdtn! \'nj ntrcn? yf,hfyysq yt d njq hfcrkflrt');
    await k.page.click('.text-tools button[data-tool="layout"]');
    await sleep(300);
    jpg(await k.shot('doc-text'), 'text', '940x350+0+0');
    await k.page.keyboard.press('Escape');
    await k.leave();

    // command line
    await k.main(() => globalThis.__kaplyaTest.openPalette());
    await k.page.waitForSelector('#island[data-mode="command"]');
    await k.page.fill('#command-input', '15% от 2400');
    await sleep(500);
    await k.settle();
    jpg(await k.shot('doc-command'), 'command', '940x190+0+0');
    await k.page.keyboard.press('Escape');
    await k.leave();

    // capture: a "letter" on a wallpaper, selected and drawn on
    await k.main(async ({ BrowserWindow, screen }) => {
      const d = screen.getPrimaryDisplay().bounds;
      const win = new BrowserWindow({ x: d.x, y: d.y, width: d.width, height: d.height, frame: false, show: false, backgroundColor: '#3b8fd0' });
      const html = `<body style="margin:0;height:100vh;background:linear-gradient(160deg,#2c6fb7 0%,#58a6d8 38%,#8fd0d6 62%,#2fa7a0 100%);font:15px 'Segoe UI',system-ui,sans-serif">
        <div style="position:absolute;left:230px;top:210px;width:560px;border-radius:10px;background:#fff;box-shadow:0 18px 50px rgba(0,0,0,.3);overflow:hidden">
          <div style="padding:9px 14px;background:#eef0f4;color:#555;font-size:13px">Сообщение — Анна Смирнова</div>
          <div style="padding:18px 22px 22px;color:#1c1c1c;line-height:1.7">
            <b>Всем привет!</b><br>Встречу перенесли на пятницу, 15:00.<br>Принесите, пожалуйста, слайды и отчёт по бюджету.<br><span style="color:#888">Ответить: anna@example.com</span>
          </div></div></body>`;
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      win.show();
      globalThis.__probe = win;
    });
    await sleep(1000);
    await k.main(() => { globalThis.__kaplyaTest.runAction('region'); });
    const ov = await k.findPage('overlay.html');
    await ov.waitForSelector('html[data-ready="true"]');
    await ov.mouse.move(214, 196);
    await ov.mouse.down();
    await ov.mouse.move(500, 300, { steps: 4 });
    await ov.mouse.move(806, 420, { steps: 4 });
    await ov.mouse.up();
    await ov.waitForSelector('#toolbar:not([hidden])');
    await ov.mouse.move(700, 250);
    await ov.mouse.down();
    await ov.mouse.move(560, 296, { steps: 5 });
    await ov.mouse.up();
    await ov.click('#toolbar button[data-tool="rect"]');
    await ov.mouse.move(246, 282);
    await ov.mouse.down();
    await ov.mouse.move(540, 312, { steps: 5 });
    await ov.mouse.up();
    await ov.click('#toolbar button[data-tool="text"]');
    await ov.click('#toolbar .dot[data-size="1"]');
    await ov.mouse.click(640, 214);
    await ov.keyboard.type('Важно!');
    await ov.keyboard.press('Enter');
    await ov.click('#toolbar button[data-tool="blur"]');
    await ov.mouse.move(326, 340);
    await ov.mouse.down();
    await ov.mouse.move(476, 364, { steps: 4 });
    await ov.mouse.up();
    await ov.mouse.move(900, 560);
    const f = path.join(OUT, 'doc-capture.png');
    await ov.screenshot({ path: f });
    jpg(f, 'capture', '940x500+40+110');
    await closing(ov.keyboard.press('Escape'));
    await sleep(800); // let the overlay window go before talking to the app again
    await k.main(() => { globalThis.__probe.destroy(); });

    // settings
    await k.main(() => globalThis.__kaplyaTest.openSettings());
    const s = await k.findPage('settings.html');
    await s.waitForSelector('html[data-ready="true"]');
    await sleep(400);
    const sf = path.join(OUT, 'doc-settings.png');
    await s.screenshot({ path: sf });
    jpg(sf, 'settings', null);
    console.log('wrote', fs.readdirSync(DOCS).join(', '));
  } catch (err) {
    console.log('FAILED', err && err.stack || err);
    process.exitCode = 1;
  } finally {
    await k.close();
  }
})();
