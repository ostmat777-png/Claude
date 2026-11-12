'use strict';
// Recording through OBS Studio.
//
// OBS has a built-in remote control: a WebSocket server (Tools -> WebSocket Server
// Settings, port 4455). The island connects to it and says "start recording" and
// "stop recording"; OBS does the recording itself, with its own scenes, sound and
// quality settings. Protocol: obs-websocket 5.x,
// https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const OP = { HELLO: 0, IDENTIFY: 1, IDENTIFIED: 2, EVENT: 5, REQUEST: 6, RESPONSE: 7 };
const EVENTS_OUTPUTS = 1 << 6; // we only want to hear about recording starting and stopping
const CLOSE_AUTH_FAILED = 4009;
const STATUS_OUTPUT_RUNNING = 500;
const STATUS_OUTPUT_NOT_RUNNING = 501;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The answer to OBS's password challenge: base64(sha256(base64(sha256(password + salt)) + challenge)). */
function authString(password, salt, challenge) {
  const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('base64');
  return sha(sha(String(password) + String(salt)) + String(challenge));
}

/**
 * What went wrong, as a short code:
 *   unreachable    nothing answers at that address (OBS is closed, or its server is off)
 *   auth           OBS wants a password and ours is missing or wrong
 *   closed         the connection went away in the middle
 *   timeout        OBS did not answer a request in time
 *   request        OBS answered "no" (status and comment say why)
 *   not-installed  OBS could not be found to start it
 *   no-websocket   OBS is running but its WebSocket server does not answer
 */
class ObsError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

class ObsClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.WebSocket = opts.WebSocket || globalThis.WebSocket;
    this.ws = null;
    this.identified = false;
    this.hello = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  get connected() {
    return this.identified;
  }

  /** @returns {Promise<{ obsVersion: string, needsPassword: boolean }>} */
  connect({ host, port, password }, timeoutMs = 3000) {
    this.close();
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = 0;
      const done = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(value);
      };
      let ws;
      try {
        ws = new this.WebSocket(`ws://${host}:${port}`);
      } catch (err) {
        done(new ObsError('unreachable', String(err && err.message)));
        return;
      }
      this.ws = ws;
      timer = setTimeout(() => {
        done(new ObsError('unreachable', 'no answer'));
        if (this.ws === ws) this.close();
        else try { ws.close(); } catch {}
      }, timeoutMs);

      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        const d = msg.d || {};
        if (msg.op === OP.HELLO) {
          this.hello = d;
          const identify = { rpcVersion: 1, eventSubscriptions: EVENTS_OUTPUTS };
          if (d.authentication) {
            if (!password) {
              done(new ObsError('auth', 'password required'));
              try { ws.close(); } catch {}
              return;
            }
            identify.authentication = authString(password, d.authentication.salt, d.authentication.challenge);
          }
          ws.send(JSON.stringify({ op: OP.IDENTIFY, d: identify }));
        } else if (msg.op === OP.IDENTIFIED) {
          if (this.ws !== ws) return;
          this.identified = true;
          done(null, { obsVersion: String((this.hello && this.hello.obsStudioVersion) || ''), needsPassword: Boolean(this.hello && this.hello.authentication) });
        } else if (msg.op === OP.EVENT) {
          this.emit('event', String(d.eventType || ''), d.eventData || {});
        } else if (msg.op === OP.RESPONSE) {
          const waiter = this.pending.get(d.requestId);
          if (!waiter) return;
          this.pending.delete(d.requestId);
          clearTimeout(waiter.timer);
          const status = d.requestStatus || {};
          if (status.result) {
            waiter.resolve(d.responseData || {});
          } else {
            const err = new ObsError('request', status.comment || `OBS answered ${status.code}`);
            err.status = status.code;
            waiter.reject(err);
          }
        }
      });
      ws.addEventListener('error', () => done(new ObsError('unreachable')));
      ws.addEventListener('close', (ev) => {
        const wasLive = this.ws === ws && this.identified;
        if (this.ws === ws) {
          this.ws = null;
          this.identified = false;
          this.failPending();
        }
        done(new ObsError(ev.code === CLOSE_AUTH_FAILED ? 'auth' : 'unreachable', String(ev.reason || ev.code || '')));
        if (wasLive) this.emit('close');
      });
    });
  }

  failPending() {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new ObsError('closed'));
    }
    this.pending.clear();
  }

  request(requestType, requestData, timeoutMs = 6000) {
    if (!this.identified || !this.ws) return Promise.reject(new ObsError('closed'));
    const requestId = 'k' + this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ObsError('timeout', requestType));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      const d = { requestType, requestId };
      if (requestData) d.requestData = requestData;
      try {
        this.ws.send(JSON.stringify({ op: OP.REQUEST, d }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new ObsError('closed', String(err && err.message)));
      }
    });
  }

  /** Ends the connection on purpose (no "close" event for that). */
  close() {
    const ws = this.ws;
    this.ws = null;
    this.identified = false;
    this.failPending();
    if (ws) {
      try { ws.close(); } catch {}
    }
  }
}

/**
 * Keeps in step with OBS and starts and stops its recording.
 * Emits: "state" ({ recording, startedAt, connected, version }), "saved" (file path),
 *        "launching" (OBS is being started).
 */
class ObsControl extends EventEmitter {
  /**
   * @param {object} deps
   * @param {ObsClient} deps.client
   * @param {() => { host: string, port: number, launch: boolean }} deps.getConfig
   * @param {() => Promise<string>} deps.getPassword
   * @param {() => Promise<boolean>} [deps.isRunning]  is the OBS program open?
   * @param {() => Promise<boolean>} [deps.launch]     start OBS; false if it could not be found
   */
  constructor(deps) {
    super();
    this.client = deps.client;
    this.getConfig = deps.getConfig;
    this.getPassword = deps.getPassword;
    this.isRunning = deps.isRunning || (async () => false);
    this.launch = deps.launch || (async () => false);
    this.launchWaitMs = deps.launchWaitMs || 40000;
    this.state = { recording: false, startedAt: 0, connected: false, version: '' };
    this.enabled = false;
    this.timer = null;
    this.connecting = null;
    this.generation = 0; // grows whenever the connection is dropped on purpose
    this.stopping = false;
    this.client.on('event', (type, data) => this.onEvent(type, data));
    this.client.on('close', () => {
      // OBS was closed. Whatever it was recording has ended with it.
      this.set({ connected: false, recording: false, startedAt: 0 });
    });
  }

  set(change) {
    const next = { ...this.state, ...change };
    const same = Object.keys(next).every((k) => next[k] === this.state[k]);
    this.state = next;
    if (!same) this.emit('state', { ...next });
  }

  /** Turns the background watch on or off. While on, the island follows what OBS is doing. */
  setEnabled(on) {
    this.enabled = Boolean(on);
    clearInterval(this.timer);
    this.timer = null;
    if (!this.enabled) {
      this.drop();
      return;
    }
    const look = () => {
      if (!this.client.connected) this.ensure(1500).catch(() => {});
    };
    this.timer = setInterval(look, 4000);
    if (this.timer.unref) this.timer.unref();
    look();
  }

  /** Ends the connection, and forgets an attempt that is still under way. */
  drop() {
    this.generation += 1;
    this.connecting = null;
    this.client.close();
    this.set({ connected: false, recording: false, startedAt: 0, version: '' });
  }

  /** Drops the connection so the next one uses the new address or password. */
  reconnect() {
    this.drop();
    if (this.enabled) this.ensure(1500).catch(() => {});
  }

  /** Makes sure we are connected to OBS; throws ObsError otherwise. */
  ensure(timeoutMs = 2500) {
    if (this.client.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const generation = this.generation;
    const attempt = (async () => {
      const cfg = this.getConfig();
      const password = await this.getPassword();
      if (generation !== this.generation) throw new ObsError('closed');
      const info = await this.client.connect({ host: cfg.host, port: cfg.port, password }, timeoutMs);
      if (generation !== this.generation) throw new ObsError('closed'); // dropped while connecting
      this.set({ connected: true, version: info.obsVersion });
      await this.sync().catch(() => {});
    })();
    this.connecting = attempt;
    const forget = () => {
      if (this.connecting === attempt) this.connecting = null;
    };
    attempt.then(forget, forget);
    return attempt;
  }

  /** Connects; if OBS is simply not open and we are allowed to, starts it and waits. */
  async ensureWithLaunch() {
    try {
      await this.ensure(2000);
      return;
    } catch (err) {
      if (err.code !== 'unreachable') throw err;
    }
    // Open but silent: its WebSocket server is switched off. Starting a second
    // copy would only bring up "OBS is already running".
    if (await this.isRunning()) throw new ObsError('no-websocket');
    if (!this.getConfig().launch) throw new ObsError('unreachable');
    if (!(await this.launch())) throw new ObsError('not-installed');
    this.emit('launching');
    const until = Date.now() + this.launchWaitMs;
    for (;;) {
      await sleep(1000);
      try {
        await this.ensure(2000);
        return;
      } catch (err) {
        if (err.code !== 'unreachable') throw err;
        if (Date.now() > until) throw new ObsError('no-websocket');
      }
    }
  }

  /** Asks OBS whether it is recording and for how long. */
  async sync() {
    const st = await this.client.request('GetRecordStatus');
    const recording = Boolean(st.outputActive);
    this.set({
      recording,
      startedAt: recording ? (this.state.recording && this.state.startedAt) || Date.now() - (Number(st.outputDuration) || 0) : 0,
    });
    return recording;
  }

  async waitFor(recording, timeoutMs) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      let now;
      try {
        now = Boolean((await this.client.request('GetRecordStatus')).outputActive);
      } catch (err) {
        if (err.code === 'closed') throw err;
        now = !recording;
      }
      if (now === recording) return true;
      if (Date.now() > until) return false;
      await sleep(200);
    }
  }

  async start() {
    await this.ensureWithLaunch();
    try {
      await this.client.request('StartRecord');
    } catch (err) {
      if (err.status !== STATUS_OUTPUT_RUNNING) throw err; // already recording is fine
    }
    if (!(await this.waitFor(true, 10000))) throw new ObsError('request', 'recording did not start');
    if (!this.state.recording) this.set({ recording: true, startedAt: Date.now() });
  }

  /** @returns {Promise<string>} path of the saved file ('' if OBS did not say) */
  async stop() {
    await this.ensure(2500);
    this.stopping = true;
    let file = '';
    try {
      try {
        const res = await this.client.request('StopRecord', null, 20000);
        file = String(res.outputPath || '');
      } catch (err) {
        if (err.status !== STATUS_OUTPUT_NOT_RUNNING) throw err;
        this.set({ recording: false, startedAt: 0 });
        return '';
      }
      // OBS needs a moment to finish the file.
      await this.waitFor(false, 20000);
      this.set({ recording: false, startedAt: 0 });
      this.emit('saved', file);
      return file;
    } finally {
      this.stopping = false;
    }
  }

  /** The record button: start if idle, stop if recording. */
  async toggle() {
    await this.ensureWithLaunch();
    const recording = await this.sync();
    if (recording) return this.stop();
    return this.start();
  }

  // Recording started or stopped from OBS itself (its own button or hotkey).
  onEvent(type, data) {
    if (type !== 'RecordStateChanged') return;
    const s = String(data.outputState || '');
    if (s === 'OBS_WEBSOCKET_OUTPUT_STARTED') {
      if (!this.state.recording) this.set({ recording: true, startedAt: Date.now() });
    } else if (s === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
      if (this.stopping) return; // our own stop() reports this one
      const was = this.state.recording;
      this.set({ recording: false, startedAt: 0 });
      if (was) this.emit('saved', String(data.outputPath || ''));
    }
  }

  /** One fresh attempt to connect, for the "check" button in settings. */
  async test() {
    this.drop();
    try {
      await this.ensure(2500);
      return { ok: true, version: this.state.version };
    } catch (err) {
      return { ok: false, error: err.code || 'unreachable' };
    }
  }
}

module.exports = { ObsClient, ObsControl, ObsError, authString };
