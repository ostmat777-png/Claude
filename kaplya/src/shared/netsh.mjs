// Reading the output of "netsh wlan ..." without depending on the language of
// Windows: the labels are translated ("Signal" / "Сигнал"), the shape is not.

/**
 * "netsh wlan show networks mode=bssid"
 * @returns {{ ssid: string, bars: number, signal: number, secure: boolean, auth: string }[]}
 */
export function parseNetworks(output) {
  const lines = String(output || '').split(/\r?\n/);
  const nets = [];
  let cur = null;
  let fieldIndex = 0;
  for (const line of lines) {
    const head = /^SSID\s+\d+\s*:\s?(.*)$/.exec(line);
    if (head) {
      cur = { ssid: head[1].trim(), signal: 0, auth: '', secure: true };
      fieldIndex = 0;
      nets.push(cur);
      continue;
    }
    if (!cur) continue;
    const kv = /^\s+(.+?)\s*:\s?(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2].trim();
    if (/^BSSID\s+\d+/i.test(kv[1].trim())) {
      fieldIndex = 100; // inside the access-point list now
      continue;
    }
    if (fieldIndex < 100) {
      // The lines right after "SSID n" are always: network type, authentication, encryption.
      if (fieldIndex === 1) {
        cur.auth = value;
        cur.secure = /WPA|WEP|802\.1|SAE|OWE|Personal|Enterprise/i.test(value);
      }
      fieldIndex += 1;
      continue;
    }
    const pct = /^(\d{1,3})\s*%$/.exec(value);
    if (pct) cur.signal = Math.max(cur.signal, Number(pct[1]));
  }
  const best = new Map();
  for (const n of nets) {
    if (!n.ssid) continue; // hidden network
    const old = best.get(n.ssid);
    if (!old || old.signal < n.signal) best.set(n.ssid, n);
  }
  return [...best.values()]
    .map((n) => ({ ...n, bars: Math.max(1, Math.min(4, Math.ceil(n.signal / 25))) }))
    .sort((a, b) => b.signal - a.signal);
}

/** "netsh wlan show interfaces" -> the network we are connected to, or null. */
export function parseConnectedSsid(output) {
  for (const line of String(output || '').split(/\r?\n/)) {
    const m = /^\s+SSID\s*:\s?(.*)$/.exec(line);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** A Wi-Fi profile for "netsh wlan add profile". `auth` is the text netsh printed for the network. */
export function profileXml(ssid, password, auth = 'WPA2-Personal') {
  const hex = [...new TextEncoder().encode(ssid)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  let security;
  if (!password) {
    security = '<authEncryption><authentication>open</authentication><encryption>none</encryption><useOneX>false</useOneX></authEncryption>';
  } else {
    const kind = /WPA3|SAE/i.test(auth) ? 'WPA3SAE' : /WPA2/i.test(auth) ? 'WPA2PSK' : /WPA/i.test(auth) ? 'WPAPSK' : 'WPA2PSK';
    security =
      `<authEncryption><authentication>${kind}</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption>` +
      `<sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>${xmlEscape(password)}</keyMaterial></sharedKey>`;
  }
  return `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>${xmlEscape(ssid)}</name>
  <SSIDConfig><SSID><hex>${hex}</hex><name>${xmlEscape(ssid)}</name></SSID></SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>auto</connectionMode>
  <MSM><security>${security}</security></MSM>
</WLANProfile>
`;
}
