// Скачивает данные для страницы магазина: странице Steam (CSP) запрещено ходить на чужие сайты.
// Только GET и только на сайты из списка.
const ALLOWED_HOSTS = new Set([
  'store.steampowered.com',
  'api.isthereanydeal.com',
  'www.cbr-xml-daily.ru',
  'cdn.jsdelivr.net',
  'latest.currency-api.pages.dev',
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'spc-fetch') return false;
  (async () => {
    let url;
    try {
      url = new URL(msg.url);
    } catch (e) {
      return { status: 0, error: 'bad url' };
    }
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) return { status: 0, error: 'host not allowed' };
    try {
      const res = await fetch(url.href, { headers: { Accept: 'application/json' }, credentials: 'omit' });
      return { status: res.status, body: await res.text() };
    } catch (e) {
      return { status: 0, error: String((e && e.message) || e) };
    }
  })().then(sendResponse);
  return true; // ответ придёт асинхронно
});
