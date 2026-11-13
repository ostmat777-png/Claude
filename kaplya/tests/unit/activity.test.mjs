import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Activity } = require('../../src/main/activity.js');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kaplya-act-')), 'activity.json');
const chrome = { pid: 10, exe: 'chrome.exe', path: 'C:\\Program Files\\Google\\Chrome\\chrome.exe', name: 'Google Chrome', title: 'YouTube' };
const code = { pid: 11, exe: 'Code.exe', path: 'C:\\VS Code\\Code.exe', name: 'Visual Studio Code', title: 'main.js' };

function run(act, start, steps) {
  let t = start;
  for (const [app, seconds, extra = {}] of steps) {
    for (let i = 0; i < seconds; i += 2) {
      act.sample({ active: app, idleMs: 0, fullscreen: false, ...extra }, t);
      t += 2000;
    }
  }
  return t;
}

test('time goes to the program in front', () => {
  const act = new Activity({ file: tmp() });
  const start = new Date(2026, 10, 13, 10, 0, 0).getTime();
  const end = run(act, start, [[chrome, 60], [code, 30], [chrome, 20]]);
  const r = act.report('today', end);
  assert.deepEqual(r.apps.map((a) => [a.name, Math.round(a.ms / 1000)]), [['Google Chrome', 76], ['Visual Studio Code', 28]]);
  assert.equal(r.total, r.apps.reduce((n, a) => n + a.ms, 0));
  assert.equal(r.hours[10], r.total);
  assert.equal(r.now.name, 'Google Chrome');
});

test('nobody at the computer: the clock stops, except for a film', () => {
  const act = new Activity({ file: tmp() });
  const start = new Date(2026, 10, 13, 10, 0, 0).getTime();
  const end = run(act, start, [[chrome, 20], [chrome, 60, { idleMs: 10 * 60000 }], [chrome, 60, { idleMs: 10 * 60000, fullscreen: true }]]);
  const secs = Math.round(act.report('today', end).total / 1000);
  assert.ok(secs >= 74 && secs <= 80, 'idle minute not counted, the film is: ' + secs);
});

test('a long gap (the computer slept) is not counted', () => {
  const act = new Activity({ file: tmp() });
  const t = new Date(2026, 10, 13, 10, 0, 0).getTime();
  act.sample({ active: chrome, idleMs: 0 }, t);
  act.sample({ active: chrome, idleMs: 0 }, t + 2000);
  act.sample({ active: chrome, idleMs: 0 }, t + 3600000);
  assert.equal(act.report('today', t + 3600000).total, 2000);
});

test('midnight splits the time between two days; the week adds them up', () => {
  const act = new Activity({ file: tmp() });
  const start = new Date(2026, 10, 13, 23, 59, 30).getTime();
  const end = run(act, start, [[code, 62]]);
  const today = act.report('today', end);
  const yesterday = act.report('yesterday', end);
  assert.ok(today.total > 0 && yesterday.total > 0);
  assert.equal(act.report('week', end).total, today.total + yesterday.total);
  assert.equal(act.report('week', end).perDay.length, 7);
});

test('the desktop, the lock screen and the app itself do not count; switching off stops counting', () => {
  let on = true;
  const act = new Activity({ file: tmp(), ownExe: 'Kaplya.exe', enabled: () => on });
  const start = new Date(2026, 10, 13, 12, 0, 0).getTime();
  let t = run(act, start, [[{ pid: 1, exe: 'Kaplya.exe', name: 'Kaplya' }, 30], [{ pid: 2, exe: 'LockApp.exe', name: 'Lock' }, 30]]);
  assert.equal(act.report('today', t).total, 0);
  on = false;
  t = run(act, t, [[chrome, 30]]);
  assert.equal(act.report('today', t).total, 0);
});

test('kept on disk and read back; cleared on request', () => {
  const file = tmp();
  const act = new Activity({ file });
  const start = new Date(2026, 10, 13, 9, 0, 0).getTime();
  const end = run(act, start, [[chrome, 40]]);
  act.save();
  const again = new Activity({ file });
  assert.equal(again.report('today', end).total, act.report('today', end).total);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('YouTube'), 'window titles are not kept');
  again.clear();
  assert.equal(new Activity({ file }).report('today', end).total, 0);
});
