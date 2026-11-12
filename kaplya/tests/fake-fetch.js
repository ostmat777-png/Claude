'use strict';
// Canned answers for the internet services the app uses, so tests and screenshots
// do not depend on the network. Loaded by the app when KAPLYA_TEST_FETCH points here.

function forecast() {
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const day = (offset) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const hours = [];
  for (let d = 0; d < 3; d++) for (let h = 0; h < 24; h++) hours.push(`${day(d)}T${pad(h)}:00`);
  const temps = hours.map((_, i) => Math.round(14 + 6 * Math.sin(((i % 24) - 9) / 24 * Math.PI * 2)));
  const codes = [0, 1, 2, 3, 61, 2, 0];
  return {
    utc_offset_seconds: 10800,
    current: {
      time: `${day(0)}T14:43`, temperature_2m: 18.2, apparent_temperature: 17.4, is_day: 1, weather_code: 1,
      relative_humidity_2m: 54, surface_pressure: 1012, wind_speed_10m: 3.4, wind_direction_10m: 225, wind_gusts_10m: 7.2,
      precipitation: 0, cloud_cover: 20, dew_point_2m: 8.6, uv_index: 3.2,
    },
    hourly: {
      time: hours,
      temperature_2m: temps,
      weather_code: hours.map((_, i) => codes[Math.floor(i / 5) % codes.length]),
      precipitation_probability: hours.map((_, i) => (Math.floor(i / 5) % codes.length === 4 ? 60 : 5)),
      is_day: hours.map((_, i) => (i % 24 >= 7 && i % 24 < 19 ? 1 : 0)),
    },
    daily: {
      time: [0, 1, 2, 3, 4, 5, 6].map(day),
      weather_code: codes,
      temperature_2m_max: [19, 21, 20, 17, 14, 16, 18],
      temperature_2m_min: [9, 11, 12, 10, 8, 7, 9],
      sunrise: [0, 1, 2, 3, 4, 5, 6].map((d) => `${day(d)}T06:19`),
      sunset: [0, 1, 2, 3, 4, 5, 6].map((d) => `${day(d)}T18:53`),
      uv_index_max: [4.1, 4.5, 3.9, 2.2, 1.8, 3.0, 3.6],
      precipitation_sum: [0, 0, 0.2, 1.4, 6.3, 0.1, 0],
      precipitation_probability_max: [5, 5, 15, 40, 80, 20, 5],
    },
  };
}

const LRC = `[00:05.00]Над тихой водой поднимается свет
[00:20.00]И волны несут нам вчерашний рассвет
[00:38.00]Мы снова идём вдоль тёплого берега
[00:55.00]Где время течёт, никуда не торопится
[01:15.00]И всё, что хотелось, уже исполняется
[02:00.00]Тёплый берег, тёплый берег
[03:00.00]Останься со мной`;

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

module.exports = async function fakeFetch(url) {
  const u = new URL(String(url));
  if (process.env.KAPLYA_TEST_OFFLINE === '1') throw new Error('offline');
  if (u.hostname === 'api.open-meteo.com') return json(forecast());
  if (u.hostname === 'geocoding-api.open-meteo.com') {
    const name = u.searchParams.get('name') || '';
    if (/^zzz/i.test(name)) return json({});
    return json({ results: [
      { name: 'Казань', admin1: 'Татарстан', country: 'Россия', latitude: 55.79, longitude: 49.12 },
      { name: 'Казанка', admin1: 'Николаевская область', country: 'Украина', latitude: 47.84, longitude: 32.83 },
    ] });
  }
  if (u.hostname === 'ipwho.is') return json({ success: true, city: 'Москва', region: 'Москва', country: 'Россия', latitude: 55.75, longitude: 37.62 });
  if (u.hostname === 'lrclib.net') {
    const title = u.searchParams.get('track_name') || '';
    if (/берег/i.test(title)) {
      const hit = { syncedLyrics: LRC, plainLyrics: LRC.replace(/\[[^\]]+\]/g, ''), duration: 214 };
      return json(u.pathname.endsWith('/search') ? [hit] : hit);
    }
    return u.pathname.endsWith('/search') ? json([]) : json({}, 404);
  }
  return json({}, 404);
};
