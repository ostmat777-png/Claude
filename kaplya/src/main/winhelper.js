'use strict';
// Bridge to the Windows helper (src/helper/helper.ps1): one long-lived PowerShell
// process, JSON lines in both directions. On other systems, or when the helper
// cannot start, every call rejects and the app simply shows less.

const { spawn } = require('node:child_process');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const ASCII_ONLY = /[^\x00-\x7f]/g;

function toAsciiJson(value) {
  return JSON.stringify(value).replace(ASCII_ONLY, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

class WinHelper extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.script   path to helper.ps1
   * @param {string[]} [opts.command]  full command line override (tests): [exe, ...args]
   */
  constructor(opts) {
    super();
    this.script = opts.script;
    this.command = opts.command || null;
    this.proc = null;
    this.ready = false;
    this.stopped = false;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.restarts = 0;
    this.lastError = null;
  }

  get supported() {
    return Boolean(this.command) || process.platform === 'win32';
  }

  commandLine() {
    if (this.command) return this.command;
    const root = process.env.SystemRoot || 'C:\\Windows';
    const exe = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return [exe, '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script];
  }

  start() {
    if (!this.supported || this.proc || this.stopped) return;
    const [exe, ...args] = this.commandLine();
    let proc;
    try {
      proc = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this.lastError = String(err && err.message || err);
      return;
    }
    this.proc = proc;
    this.buffer = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this.onData(chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => { this.lastError = String(chunk).trim().slice(0, 500); });
    proc.on('error', (err) => {
      this.lastError = String(err && err.message || err);
      this.onExit(proc);
    });
    proc.on('exit', () => this.onExit(proc));
    proc.stdin.on('error', () => {});
  }

  onData(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // stray console output
      }
      if (msg.ready) {
        this.ready = true;
        this.restarts = 0;
        this.emit('ready');
        continue;
      }
      const waiter = this.pending.get(msg.id);
      if (!waiter) continue;
      this.pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.ok) waiter.resolve(msg.result === undefined ? null : msg.result);
      else waiter.reject(new Error(msg.error || 'helper error'));
    }
  }

  onExit(proc) {
    if (this.proc !== proc) return;
    this.proc = null;
    this.ready = false;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('helper stopped'));
    }
    this.pending.clear();
    this.emit('exit');
    if (this.stopped) return;
    // Come back after a crash, but give up if it keeps dying.
    this.restarts += 1;
    if (this.restarts > 5) return;
    setTimeout(() => this.start(), 1000 * this.restarts).unref?.();
  }

  /** Runs one helper command. Rejects when there is no helper. */
  call(cmd, args = {}, timeoutMs = 10000) {
    if (!this.supported) return Promise.reject(new Error('not-windows'));
    if (!this.proc) this.start();
    if (!this.proc) return Promise.reject(new Error(this.lastError || 'helper unavailable'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('helper timeout: ' + cmd));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(toAsciiJson({ id, cmd, args }) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** Like call(), but resolves to `fallback` instead of rejecting. */
  async tryCall(cmd, args, fallback = null, timeoutMs) {
    try {
      return await this.call(cmd, args, timeoutMs);
    } catch {
      return fallback;
    }
  }

  stop() {
    this.stopped = true;
    const proc = this.proc;
    if (!proc) return;
    try { proc.stdin.end(); } catch {}
    setTimeout(() => { try { proc.kill(); } catch {} }, 500).unref?.();
  }
}

module.exports = { WinHelper, toAsciiJson };
