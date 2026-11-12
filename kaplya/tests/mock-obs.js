'use strict';
// A stand-in for OBS Studio's WebSocket server (obs-websocket 5.x), enough of it to
// test recording through OBS: the password handshake, GetVersion, GetRecordStatus,
// StartRecord, StopRecord and the RecordStateChanged event.
//
// It is a real WebSocket server, written by hand so the tests need no packages.

const http = require('node:http');
const crypto = require('node:crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const sha256b64 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('base64');

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

/** One frame from the start of `buf`, or null if it is not all there yet. */
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = Boolean(buf[1] & 0x80);
  let len = buf[1] & 0x7f;
  let at = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    at = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    at = 10;
  }
  const maskAt = at;
  if (masked) at += 4;
  if (buf.length < at + len) return null;
  const payload = Buffer.from(buf.subarray(at, at + len));
  if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[maskAt + (i % 4)];
  return { opcode, payload, size: at + len };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.password]  '' = no password asked
 * @returns {Promise<object>} { port, state, externalStart(), externalStop(), close() }
 */
function startMockObs(opts = {}) {
  const password = opts.password || '';
  const state = {
    recording: false,
    startedAt: 0,
    requests: [], // request types, in order
    authFailures: 0,
    connections: 0,
    file: opts.file || 'C:\\Users\\test\\Videos\\2026-11-12 14-00-00.mkv',
  };
  const clients = new Set();

  const send = (client, msg) => {
    if (!client.socket.destroyed) client.socket.write(encodeFrame(1, Buffer.from(JSON.stringify(msg), 'utf8')));
  };
  const closeWith = (client, code) => {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    if (!client.socket.destroyed) {
      client.socket.write(encodeFrame(8, payload));
      client.socket.end();
    }
  };
  const event = (outputState, outputPath = null) => {
    for (const c of clients) {
      if (c.identified && (c.subscriptions & (1 << 6))) {
        send(c, { op: 5, d: { eventType: 'RecordStateChanged', eventIntent: 1 << 6, eventData: { outputActive: state.recording, outputState, outputPath } } });
      }
    }
  };
  const setRecording = (on) => {
    if (on === state.recording) return;
    if (on) {
      event('OBS_WEBSOCKET_OUTPUT_STARTING');
      state.recording = true;
      state.startedAt = Date.now();
      event('OBS_WEBSOCKET_OUTPUT_STARTED');
    } else {
      event('OBS_WEBSOCKET_OUTPUT_STOPPING');
      state.recording = false;
      event('OBS_WEBSOCKET_OUTPUT_STOPPED', state.file);
    }
  };

  function onRequest(client, d) {
    state.requests.push(d.requestType);
    const reply = (ok, code, responseData, comment) => send(client, {
      op: 7,
      d: { requestType: d.requestType, requestId: d.requestId, requestStatus: { result: ok, code, comment }, responseData },
    });
    switch (d.requestType) {
      case 'GetVersion':
        return reply(true, 100, { obsVersion: '31.0.2', obsWebSocketVersion: '5.5.4', rpcVersion: 1, platform: 'windows' });
      case 'GetRecordStatus':
        return reply(true, 100, {
          outputActive: state.recording,
          outputPaused: false,
          outputTimecode: '00:00:00.000',
          outputDuration: state.recording ? Date.now() - state.startedAt : 0,
          outputBytes: 0,
        });
      case 'StartRecord':
        if (state.recording) return reply(false, 500, undefined, 'The output is already running.');
        reply(true, 100);
        return setRecording(true);
      case 'StopRecord':
        if (!state.recording) return reply(false, 501, undefined, 'The output is not running.');
        setRecording(false);
        return reply(true, 100, { outputPath: state.file });
      default:
        return reply(false, 204, undefined, 'Unknown request type');
    }
  }

  function onMessage(client, text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return closeWith(client, 4002);
    }
    const d = msg.d || {};
    if (msg.op === 1) {
      if (password) {
        const want = sha256b64(sha256b64(password + client.salt) + client.challenge);
        if (d.authentication !== want) {
          state.authFailures += 1;
          return closeWith(client, 4009);
        }
      }
      client.identified = true;
      client.subscriptions = typeof d.eventSubscriptions === 'number' ? d.eventSubscriptions : 0x7ff;
      return send(client, { op: 2, d: { negotiatedRpcVersion: 1 } });
    }
    if (!client.identified) return closeWith(client, 4007);
    if (msg.op === 6) return onRequest(client, d);
    return undefined;
  }

  const server = http.createServer((_req, res) => {
    res.statusCode = 426;
    res.end('WebSocket only');
  });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const client = {
      socket,
      identified: false,
      subscriptions: 0,
      salt: crypto.randomBytes(32).toString('base64'),
      challenge: crypto.randomBytes(32).toString('base64'),
    };
    clients.add(client);
    state.connections += 1;
    const hello = { obsStudioVersion: '31.0.2', obsWebSocketVersion: '5.5.4', rpcVersion: 1 };
    if (password) hello.authentication = { challenge: client.challenge, salt: client.salt };
    send(client, { op: 0, d: hello });

    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const frame = decodeFrame(buf);
        if (!frame) break;
        buf = buf.subarray(frame.size);
        if (frame.opcode === 1) onMessage(client, frame.payload.toString('utf8'));
        else if (frame.opcode === 8) socket.end(encodeFrame(8, frame.payload.subarray(0, 2)));
        else if (frame.opcode === 9) socket.write(encodeFrame(10, frame.payload));
      }
    });
    const gone = () => clients.delete(client);
    socket.on('close', gone);
    socket.on('error', gone);
  });

  return new Promise((resolve) => {
    server.listen(opts.port || 0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        state,
        /** As if "Start Recording" was pressed in OBS itself. */
        externalStart: () => setRecording(true),
        externalStop: () => setRecording(false),
        /** As if OBS was closed. */
        close: () => new Promise((done) => {
          for (const c of clients) c.socket.destroy();
          clients.clear();
          server.close(() => done());
        }),
      });
    });
  });
}

module.exports = { startMockObs };
