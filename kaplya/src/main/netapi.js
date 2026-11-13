'use strict';
// The few things the app asks the internet: weather (Open-Meteo), city search,
// an optional "where am I" by IP, song lyrics (LRCLIB), and a cover picture for a
// track whose player did not provide one (iTunes Search, then Deezer).
// No keys, no accounts.

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

/** "Song (Official Video) [HD] feat. X" -> "song": what is left to compare two titles by. */
function plainTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\(\[][^\)\]]*[\)\]]/g, ' ')
    .replace(/\b(feat|ft|featuring)\.?\s.*$/i, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const words = (s) => new Set(plainTitle(s).split(' ').filter((w) => w.length > 1));

/** Is this search result the track we asked about? Better no cover than a wrong one. */
function sameTrack(want, got) {
  const a = plainTitle(want.title);
  const b = plainTitle(got.title);
  if (!a || !b) return false;
  if (!(a === b || a.includes(b) || b.includes(a))) return false;
  const wa = words(want.artist);
  if (!wa.size) return true;
  const wb = words(got.artist);
  for (const w of wa) if (wb.has(w)) return true;
  // "Artist - Song" as the whole title (YouTube): the artist is inside the title
  const wt = words(want.title);
  for (const w of wb) if (wt.has(w)) return true;
  return false;
}

class NetApi {
  /** @param {typeof fetch} fetchFn */
  constructor(fetchFn, shared) {
    this.fetch = fetchFn;
    this.shared = shared; // { weather: module, lrc: module }
    this.weatherCache = null; // { key, data }
    this.lyricsCache = new Map();
    this.coverCache = new Map();
  }

  /**
   * A cover for a track, as a data: URL, or null. Asked only when the player gave none.
   * @param {{ title: string, artist?: string, album?: string }} track
   */
  async cover(track) {
    let title = String(track.title || '').trim();
    let artist = String(track.artist || '').trim();
    if (!title) return null;
    // A video called "Artist - Song": the uploader's name is not the artist.
    const split = /^(.{2,60}?)\s[-–—]\s(.{2,})$/.exec(title);
    if (split) {
      artist = split[1];
      title = split[2];
    }
    const key = (artist + '|' + title).toLowerCase();
    if (this.coverCache.has(key)) return this.coverCache.get(key);
    const want = { title, artist };
    let imageUrl = null;
    let failed = false;
    try {
      const q = new URLSearchParams({ term: `${artist} ${plainTitle(title) || title}`.trim(), entity: 'song', limit: '8' });
      const r = await getJson(this.fetch, 'https://itunes.apple.com/search?' + q, { timeoutMs: 7000 });
      const hit = (r.results || []).find((x) => x.artworkUrl100 && sameTrack(want, { title: x.trackName, artist: x.artistName }));
      if (hit) imageUrl = String(hit.artworkUrl100).replace(/\/\d+x\d+(bb)?\./, '/600x600bb.');
    } catch {
      failed = true;
    }
    if (!imageUrl) {
      try {
        const q = new URLSearchParams({ q: `${artist} ${plainTitle(title) || title}`.trim(), limit: '8' });
        const r = await getJson(this.fetch, 'https://api.deezer.com/search?' + q, { timeoutMs: 7000 });
        const hit = (r.data || []).find((x) => x.album && (x.album.cover_big || x.album.cover_medium) &&
          sameTrack(want, { title: x.title_short || x.title, artist: x.artist && x.artist.name }));
        if (hit) imageUrl = hit.album.cover_big || hit.album.cover_medium;
      } catch {
        failed = true;
      }
    }
    let result = null;
    if (imageUrl) {
      try {
        result = await this.imageDataUrl(imageUrl);
      } catch {
        failed = true;
      }
    }
    // "nothing found" is remembered; "the network failed" is not, so it is tried again
    if (result || !failed) {
      this.coverCache.set(key, result);
      if (this.coverCache.size > 80) this.coverCache.delete(this.coverCache.keys().next().value);
    }
    return result;
  }

  /** Downloads a picture and returns it as a data: URL. */
  async imageDataUrl(url, maxBytes = 2 * 1024 * 1024) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 9000);
    try {
      const res = await this.fetch(url, { signal: ctl.signal, headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > maxBytes) throw new Error('bad size');
      let type = String((res.headers && res.headers.get && res.headers.get('content-type')) || '').split(';')[0].trim();
      if (!/^image\//.test(type)) type = buf[0] === 0x89 ? 'image/png' : 'image/jpeg';
      return `data:${type};base64,${buf.toString('base64')}`;
    } finally {
      clearTimeout(timer);
    }
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

module.exports = { NetApi, plainTitle, sameTrack };
