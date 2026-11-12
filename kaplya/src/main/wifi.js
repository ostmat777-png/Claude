'use strict';
// Wi-Fi networks: list, connect, disconnect.
//
// Two ways to ask Windows. First the modern one (through the helper); if Windows
// refuses it or it fails, the classic "netsh wlan". Whichever answered the list is
// then used to connect.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function run(file, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, out: String(stdout || '') });
    });
  });
}

// chcp 65001 makes netsh print UTF-8, whatever the language of Windows.
const netshUtf8 = (command) => run('cmd.exe', ['/d', '/c', 'chcp 65001>nul & netsh ' + command]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Wifi {
  constructor(helper, shared) {
    this.helper = helper;
    this.netsh = shared.netsh;
    this.backend = null;
    this.lastList = [];
  }

  async list(scan = false) {
    if (process.platform !== 'win32' && !this.helper.supported) return { available: false, reason: 'not-windows', networks: [] };
    let reason = '';
    try {
      const r = await this.helper.call('wifi.list', { scan }, 25000);
      if (r.available) {
        this.backend = 'winrt';
        this.lastList = r.networks || [];
        return { available: true, connected: r.connected || null, networks: this.lastList };
      }
      reason = r.reason || '';
    } catch (err) {
      reason = String(err && err.message || err);
    }
    if (process.platform === 'win32') {
      const nets = await netshUtf8('wlan show networks mode=bssid');
      const parsed = this.netsh.parseNetworks(nets.out);
      if (nets.ok && (parsed.length || /SSID/.test(nets.out) || /\b0\b/.test(nets.out))) {
        const iface = await netshUtf8('wlan show interfaces');
        const connected = this.netsh.parseConnectedSsid(iface.out);
        this.backend = 'netsh';
        this.lastList = parsed.map((n) => ({ ...n, connected: n.ssid === connected }))
          .sort((a, b) => Number(b.connected) - Number(a.connected) || b.signal - a.signal);
        return { available: true, connected, networks: this.lastList };
      }
    }
    this.backend = null;
    // "Denied...": Windows hides Wi-Fi networks from programs until location access is on.
    return { available: false, reason: /denied/i.test(reason) ? 'denied' : reason === 'Allowed' ? 'no-adapter' : reason || 'unknown', networks: [] };
  }

  /** @returns {Promise<{ ok: boolean, needPassword?: boolean, error?: string }>} */
  async connect(ssid, password) {
    const net = this.lastList.find((n) => n.ssid === ssid);
    if (this.backend === 'winrt') {
      try {
        const r = await this.helper.call('wifi.connect', { ssid, password: password || '' }, 40000);
        if (r.status === 'Success') return { ok: true };
        if (r.status === 'InvalidCredential' || (!password && net && net.secure)) return { ok: false, needPassword: true, error: r.status };
        return { ok: false, error: r.status };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    }
    if (this.backend === 'netsh') return this.connectNetsh(ssid, password, net);
    return { ok: false, error: 'no-backend' };
  }

  async connectNetsh(ssid, password, net) {
    const secure = net ? net.secure : true;
    if (password || !secure) {
      const file = path.join(os.tmpdir(), `kaplya-wifi-${process.pid}-${Date.now()}.xml`);
      try {
        fs.writeFileSync(file, this.netsh.profileXml(ssid, password || '', net ? net.auth : ''), { mode: 0o600 });
        await run('netsh.exe', ['wlan', 'add', 'profile', 'filename=' + file, 'user=current']);
      } finally {
        // The file holds the password in the clear: never leave it behind.
        try { fs.unlinkSync(file); } catch {}
      }
    }
    const res = await run('netsh.exe', ['wlan', 'connect', 'name=' + ssid]);
    if (!res.ok) return { ok: false, needPassword: secure && !password, error: 'connect-failed' };
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      const iface = await netshUtf8('wlan show interfaces');
      if (this.netsh.parseConnectedSsid(iface.out) === ssid) return { ok: true };
    }
    return { ok: false, needPassword: secure, error: 'timeout' };
  }

  async disconnect() {
    if (this.backend === 'winrt') {
      const ok = await this.helper.tryCall('wifi.disconnect', {}, false);
      if (ok) return true;
    }
    if (process.platform === 'win32') return (await run('netsh.exe', ['wlan', 'disconnect'])).ok;
    return false;
  }
}

module.exports = { Wifi };
