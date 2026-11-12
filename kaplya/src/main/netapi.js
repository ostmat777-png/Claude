'use strict';
// The few things the app asks the internet: weather (Open-Meteo), city search,
// an optional "where am I" by IP, and song lyrics (LRCLIB). No keys, no accounts.

const USER_AGENT = 'Kaplya/0.1 (desktop app)';

async function getJson(fetchFn, url, { timeoutMs = 10000, allow404 = false } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: ctl.signal, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if (allow404 && res.status === 404) return null;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

class NetApi {
  /** @param {typeof fetch} fetchFn */
  constructor(fetchFn, shared) {
    this.fetch = fetchFn;
    this.shared = shared; // { weather: module, lrc: module }
    this.weatherCache = null; // { key, data }
    this.lyricsCache = new Map();
  }

  async weather(place, force = false) {
    if (!place || typeof place.lat !== 'number' || typeof place.lon !== 'number') return null;
    const key = place.lat.toFixed(3) + ',' + place.lon.toFixed(3);
    const c = this.weatherCache;
    if (!force && c && c.key === key && Date.now() - c.data.fetchedAt < 10 * 60000) return c.data;
    const { forecastUrl, normalizeForecast } = this.shared.weather;
    try {
      const raw = await getJson(this.fetch, forecastUrl(place));
      const data = normalizeForecast(raw, place);
      this.weatherCache = { key, data };
      return data;
    } catch (err) {
      // An old forecast is better than none while the network is away.
      if (c && c.key === key) return { ...c.data, stale: true };
      throw err;
    }
  }

  async searchPlaces(query) {
    const q = String(query || '').trim();
    if (q.length < 2) return [];
    const raw = await getJson(this.fetch, this.shared.weather.geocodeUrl(q));
    return (raw.results || []).map((r) => ({
      name: r.name,
      region: [r.admin1, r.country].filter(Boolean).join(', '),
      lat: r.latitude,
      lon: r.longitude,
    }));
  }

  /** Rough location from the public IP address. Only called when the user asks for it. */
  async locate() {
    try {
      const r = await getJson(this.fetch, 'https://ipwho.is/?fields=success,city,region,country,latitude,longitude&lang=ru', { timeoutMs: 7000 });
      if (r && r.success && typeof r.latitude === 'number') {
        return { name: r.city || 'Моё место', region: [r.region, r.country].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude };
      }
    } catch {}
    const r = await getJson(this.fetch, 'https://ipapi.co/json/', { timeoutMs: 7000 });
    if (r && typeof r.latitude === 'number') {
      return { name: r.city || 'Моё место', region: [r.region, r.country_name].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude };
    }
    throw new Error('location unknown');
  }

  /** @returns {Promise<{ synced: {t:number,text:string}[], plain: string } | null>} */
  async lyrics(track) {
    const title = String(track.title || '').trim();
    const artist = String(track.artist || '').trim();
    if (!title) return null;
    const key = (artist + '|' + title).toLowerCase();
    if (this.lyricsCache.has(key)) return this.lyricsCache.get(key);
    const duration = Math.round(Number(track.duration) || 0);
    let hit = null;
    try {
      if (artist && duration > 0) {
        const q = new URLSearchParams({ track_name: title, artist_name: artist, duration: String(duration) });
        if (track.album) q.set('album_name', track.album);
        hit = await getJson(this.fetch, 'https://lrclib.net/api/get?' + q, { allow404: true, timeoutMs: 8000 });
      }
      if (!hit || (!hit.syncedLyrics && !hit.plainLyrics)) {
        const q = new URLSearchParams({ track_name: title });
        if (artist) q.set('artist_name', artist);
        const list = await getJson(this.fetch, 'https://lrclib.net/api/search?' + q, { timeoutMs: 8000 });
        const fits = (x) => !duration || !x.duration || Math.abs(x.duration - duration) <= 4;
        hit = (list || []).find((x) => x.syncedLyrics && fits(x)) || (list || []).find((x) => x.plainLyrics && fits(x)) || null;
      }
    } catch {
      return null; // offline: try again next time, do not cache
    }
    const result = hit && (hit.syncedLyrics || hit.plainLyrics)
      ? { synced: hit.syncedLyrics ? this.shared.lrc.parseLrc(hit.syncedLyrics) : [], plain: hit.plainLyrics || '' }
      : null;
    this.lyricsCache.set(key, result);
    if (this.lyricsCache.size > 60) this.lyricsCache.delete(this.lyricsCache.keys().next().value);
    return result;
  }
}

module.exports = { NetApi };
