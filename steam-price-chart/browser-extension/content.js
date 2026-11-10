// Адаптер для браузера: сеть через background.js, настройки в chrome.storage.local.
(function () {
  const adapter = {
    platform: 'browser',
    fetchText: (url) => chrome.runtime.sendMessage({ type: 'spc-fetch', url }),
    getSetting: async (key) => (await chrome.storage.local.get(key))[key],
    setSetting: (key, value) => chrome.storage.local.set({ [key]: String(value) }),
  };
  if (globalThis.SteamPriceChart) {
    globalThis.SteamPriceChart.mount(adapter).catch((e) => console.error('[Steam Price Chart]', e));
  }
})();
