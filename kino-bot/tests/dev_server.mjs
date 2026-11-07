// Локальный запуск воркера для отладки мини-приложения в браузере (без Telegram):
//   node kino-bot/tests/dev_server.mjs            → http://127.0.0.1:8787/
// Переменные окружения те же, что и в Cloudflare (BOT_TOKEN, ALLOWED_USERS, JELLYFIN_*).
import http from 'node:http';
import worker from '../worker.js';

const port = Number(process.env.PORT || 8787);

http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request('http://' + req.headers.host + req.url, {
      method: req.method,
      headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    const waits = [];
    const response = await worker.fetch(request, process.env, { waitUntil: (p) => waits.push(p) });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
    await Promise.allSettled(waits);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(String(e && e.stack || e));
  }
}).listen(port, '127.0.0.1', () => console.log('Мини-приложение: http://127.0.0.1:' + port + '/'));
