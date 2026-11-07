// Поиск в фоновом потоке: интерфейс телефона не подвисает, пока считается область.
import * as core from './core.js';
import { cacheGet, cachePut } from './store.js';

let ctl = null;
self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === 'cancel') { ctl?.abort(); return; }
  if (m.type !== 'search') return;
  ctl = new AbortController();
  try {
    const res = await core.search(m.area, {
      signal: ctl.signal, cacheGet, cachePut, parallel: 2,
      progress: (done, total, msg) => self.postMessage({ type: 'progress', done, total, msg }),
      log: (msg) => self.postMessage({ type: 'log', msg }),
    });
    self.postMessage({ type: 'done', stats: res.stats, cands: res.cands.map(core.toPlain) });
  } catch (e) {
    self.postMessage({ type: 'error', msg: String(e && e.message || e) });
  }
};
