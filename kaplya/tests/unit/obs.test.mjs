// Recording through OBS: the client and the controller against a stand-in OBS server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ObsClient, ObsControl, authString } = require('../../src/main/obs.js');
const { startMockObs } = require('../mock-obs.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error('timed out waiting for ' + what);
};

function control(mock, { password = '', launch = false, extra = {} } = {}) {
  const client = new ObsClient();
  const ctl = new ObsControl({
    client,
    getConfig: () => ({ host: '127.0.0.1', port: mock.port, launch }),
    getPassword: async () => password,
    launchWaitMs: 4000,
    ...extra,
  });
  const states = [];
  const saved = [];
  ctl.on('state', (s) => states.push(s));
  ctl.on('saved', (f) => saved.push(f));
  return { client, ctl, states, saved };
}

test('the answer to the password challenge (checked against openssl)', () => {
  const salt = 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=';
  const challenge = '+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=';
  assert.equal(authString('supersecretpassword', salt, challenge), '1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=');
  assert.equal(authString('пароль с пробелом', salt, challenge), 'XAtp8mSYLz1H37IglR8+7nqzaybNnZ/2+aI2UlRX5Ic=');
});

test('connecting: no password, right password, wrong password, nobody there', async () => {
  const open = await startMockObs();
  const locked = await startMockObs({ password: 'obs-pass' });
  const client = new ObsClient();
  try {
    let info = await client.connect({ host: '127.0.0.1', port: open.port, password: '' });
    assert.deepEqual(info, { obsVersion: '31.0.2', needsPassword: false });
    assert.equal((await client.request('GetVersion')).obsVersion, '31.0.2');

    info = await client.connect({ host: '127.0.0.1', port: locked.port, password: 'obs-pass' });
    assert.equal(info.needsPassword, true);
    assert.equal(client.connected, true);

    await assert.rejects(client.connect({ host: '127.0.0.1', port: locked.port, password: 'wrong' }), { code: 'auth' });
    assert.equal(client.connected, false);
    assert.equal(locked.state.authFailures, 1);
    await assert.rejects(client.connect({ host: '127.0.0.1', port: locked.port, password: '' }), { code: 'auth' });
    await assert.rejects(client.request('GetVersion'), { code: 'closed' });

    await open.close();
    await assert.rejects(client.connect({ host: '127.0.0.1', port: open.port, password: '' }, 1500), { code: 'unreachable' });
  } finally {
    client.close();
    await locked.close();
    await open.close().catch(() => {});
  }
});

test('an unknown request is an error with the server\'s words, not a hang', async () => {
  const mock = await startMockObs();
  const client = new ObsClient();
  try {
    await client.connect({ host: '127.0.0.1', port: mock.port });
    await assert.rejects(client.request('NoSuchThing'), (err) => err.code === 'request' && err.status === 204 && /Unknown/.test(err.message));
    assert.equal((await client.request('GetRecordStatus')).outputActive, false);
  } finally {
    client.close();
    await mock.close();
  }
});

test('the record button: start, then stop, and the file OBS saved', async () => {
  const mock = await startMockObs({ password: 'obs-pass' });
  const { ctl, states, saved } = control(mock, { password: 'obs-pass' });
  try {
    await ctl.toggle();
    assert.equal(mock.state.recording, true);
    assert.equal(ctl.state.recording, true);
    assert.ok(Date.now() - ctl.state.startedAt < 3000);
    assert.equal(ctl.state.version, '31.0.2');

    const file = await ctl.toggle();
    assert.equal(file, mock.state.file);
    assert.equal(mock.state.recording, false);
    assert.equal(ctl.state.recording, false);
    assert.deepEqual(saved, [mock.state.file], 'exactly one "saved", although OBS also sent an event');
    assert.deepEqual(mock.state.requests.filter((r) => r === 'StartRecord' || r === 'StopRecord'), ['StartRecord', 'StopRecord']);
    assert.deepEqual(states.map((s) => s.recording).filter((v, i, a) => i === 0 || v !== a[i - 1]), [false, true, false]);
  } finally {
    ctl.setEnabled(false);
    await mock.close();
  }
});

test('recording started and stopped in OBS itself is followed', async () => {
  const mock = await startMockObs();
  const { ctl, saved } = control(mock);
  try {
    ctl.setEnabled(true);
    await until(() => ctl.state.connected, 'connection');
    mock.externalStart();
    await until(() => ctl.state.recording, 'recording seen');
    // the island's button now stops what OBS started
    await ctl.toggle();
    assert.equal(mock.state.recording, false);
    assert.equal(saved.length, 1);

    mock.externalStart();
    await until(() => ctl.state.recording, 'recording seen again');
    mock.externalStop();
    await until(() => !ctl.state.recording, 'stop seen');
    assert.deepEqual(saved, [mock.state.file, mock.state.file]);
  } finally {
    ctl.setEnabled(false);
    await mock.close();
  }
});

test('OBS already recording when we connect: the timer starts from its time', async () => {
  const mock = await startMockObs();
  mock.externalStart();
  mock.state.startedAt = Date.now() - 65000;
  const { ctl } = control(mock);
  try {
    await ctl.ensure();
    assert.equal(ctl.state.recording, true);
    assert.ok(Math.abs(Date.now() - ctl.state.startedAt - 65000) < 1500, 'started about 65 s ago');
  } finally {
    ctl.setEnabled(false);
    await mock.close();
  }
});

test('OBS is closed while recording: the island stops showing a recording', async () => {
  const mock = await startMockObs();
  const { ctl } = control(mock);
  await ctl.toggle();
  assert.equal(ctl.state.recording, true);
  await mock.close();
  await until(() => !ctl.state.connected && !ctl.state.recording, 'state after OBS went away');
  ctl.setEnabled(false);
});

test('OBS not answering: each cause has its own code', async () => {
  const mock = await startMockObs();
  const port = mock.port;
  await mock.close();
  const fake = { port };

  // closed, and we are not allowed to start it
  let c = control(fake, { launch: false });
  await assert.rejects(c.ctl.toggle(), { code: 'unreachable' });

  // open, but its server is switched off: never start a second copy
  let launched = 0;
  c = control(fake, { launch: true, extra: { isRunning: async () => true, launch: async () => { launched += 1; return true; } } });
  await assert.rejects(c.ctl.toggle(), { code: 'no-websocket' });
  assert.equal(launched, 0);

  // not installed
  c = control(fake, { launch: true, extra: { isRunning: async () => false, launch: async () => false } });
  await assert.rejects(c.ctl.toggle(), { code: 'not-installed' });

  // wrong password is not confused with "not running"
  const locked = await startMockObs({ password: 'x' });
  c = control(locked, { password: 'y', launch: true, extra: { launch: async () => { launched += 1; return true; } } });
  await assert.rejects(c.ctl.toggle(), { code: 'auth' });
  assert.equal(launched, 0);
  await locked.close();
});

test('OBS is started on demand and recording begins when it answers', async () => {
  // find a free port, then let "launching OBS" bring the server up a moment later
  const probe = await startMockObs();
  const port = probe.port;
  await probe.close();
  let mock = null;
  let announced = 0;
  const { ctl } = control({ port }, {
    launch: true,
    extra: {
      isRunning: async () => false,
      launch: async () => {
        setTimeout(async () => { mock = await startMockObs({ port }); }, 700);
        return true;
      },
    },
  });
  ctl.on('launching', () => { announced += 1; });
  try {
    await ctl.toggle();
    assert.equal(announced, 1);
    assert.equal(mock.state.recording, true);
    assert.equal(ctl.state.recording, true);
  } finally {
    ctl.setEnabled(false);
    if (mock) await mock.close();
  }
});
