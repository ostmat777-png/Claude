/**
 * Этот модуль Millennium подгружает в веб-страницы Steam внутри клиента (магазин, сообщество и т. д.).
 * Здесь только «адаптер»: как скачивать данные и где хранить настройки.
 * Вся логика (график, таблица) в steam-price-chart.js, том же файле, что и в расширении браузера.
 */
import './steam-price-chart.js';

type FetchResult = { status: number; body?: string; error?: string };

function asObject(value: unknown): FetchResult {
	if (typeof value === 'string') {
		try {
			return JSON.parse(value) as FetchResult;
		} catch {
			return { status: 0, error: value };
		}
	}
	if (value && typeof value === 'object') return value as FetchResult;
	return { status: 0, error: 'empty backend response' };
}

const adapter = {
	platform: 'millennium',

	async fetchText(url: string): Promise<FetchResult> {
		// Запросы к самому магазину Steam разрешены странице: делаем их напрямую.
		if (new URL(url, location.href).origin === location.origin) {
			const res = await fetch(url, { credentials: 'include' });
			return { status: res.status, body: await res.text() };
		}
		// Остальное (IsThereAnyDeal, курсы валют) через Lua-бэкенд плагина.
		return asObject(await backend.spcFetch(url));
	},

	async getSetting(key: string): Promise<string | undefined> {
		// бэкенд отвечает таблицей {value}; на всякий случай принимаем и голое значение
		const r: unknown = await backend.spcGetSetting(key);
		const value = r && typeof r === 'object' ? (r as { value?: unknown }).value : r;
		if (typeof value === 'number') return String(value);
		return typeof value === 'string' && value !== '' ? value : undefined;
	},

	async setSetting(key: string, value: string): Promise<void> {
		await backend.spcSetSetting(key, String(value));
	},
};

export default async function main() {
	if (location.hostname !== 'store.steampowered.com' || !/^\/app\/\d+/.test(location.pathname)) return;

	const start = () => {
		const spc = (globalThis as any).SteamPriceChart;
		if (!spc) {
			console.error('[Steam Price Chart] core not loaded');
			return;
		}
		spc.mount(adapter).catch((e: unknown) => console.error('[Steam Price Chart]', e));
	};

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
	else start();
}
