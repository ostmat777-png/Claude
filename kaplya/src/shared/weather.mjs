// Weather: what the numbers from Open-Meteo mean, and the shape the app keeps them in.

/** WMO weather code -> Russian description and an icon name (day / night). */
export function describeCode(code, isDay = true) {
  const sunny = isDay ? 'sun' : 'moon';
  const partly = isDay ? 'cloud-sun' : 'cloud-moon';
  switch (code) {
    case 0: return { text: 'Ясно', icon: sunny };
    case 1: return { text: 'Преимущественно ясно', icon: sunny };
    case 2: return { text: 'Переменная облачность', icon: partly };
    case 3: return { text: 'Пасмурно', icon: 'cloud' };
    case 45: case 48: return { text: 'Туман', icon: 'cloud-fog' };
    case 51: case 53: case 55: return { text: 'Морось', icon: 'cloud-drizzle' };
    case 56: case 57: return { text: 'Ледяная морось', icon: 'cloud-drizzle' };
    case 61: return { text: 'Небольшой дождь', icon: 'cloud-rain' };
    case 63: return { text: 'Дождь', icon: 'cloud-rain' };
    case 65: return { text: 'Сильный дождь', icon: 'cloud-rain' };
    case 66: case 67: return { text: 'Ледяной дождь', icon: 'cloud-rain' };
    case 71: return { text: 'Небольшой снег', icon: 'cloud-snow' };
    case 73: return { text: 'Снег', icon: 'cloud-snow' };
    case 75: return { text: 'Сильный снег', icon: 'cloud-snow' };
    case 77: return { text: 'Снежная крупа', icon: 'cloud-snow' };
    case 80: case 81: return { text: 'Ливень', icon: 'cloud-rain' };
    case 82: return { text: 'Сильный ливень', icon: 'cloud-rain' };
    case 85: case 86: return { text: 'Снегопад', icon: 'cloud-snow' };
    case 95: return { text: 'Гроза', icon: 'cloud-lightning' };
    case 96: case 99: return { text: 'Гроза с градом', icon: 'cloud-lightning' };
    default: return { text: 'Погода', icon: 'cloud' };
  }
}

const WINDS = ['северный', 'северо-восточный', 'восточный', 'юго-восточный', 'южный', 'юго-западный', 'западный', 'северо-западный'];

/** Wind direction in degrees (where it blows FROM) -> "юго-западный". */
export function windName(deg) {
  const i = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return WINDS[i];
}

export function uvLevel(uv) {
  if (uv < 3) return 'низкий';
  if (uv < 6) return 'умеренный';
  if (uv < 8) return 'высокий';
  if (uv < 11) return 'очень высокий';
  return 'экстремальный';
}

export const hpaToMmHg = (hpa) => hpa * 0.750062;

export function forecastUrl(place) {
  const q = new URLSearchParams({
    latitude: String(place.lat),
    longitude: String(place.lon),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m,dew_point_2m,uv_index',
    hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_sum,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: '7',
    wind_speed_unit: 'ms',
  });
  return 'https://api.open-meteo.com/v1/forecast?' + q.toString();
}

export function geocodeUrl(name) {
  const q = new URLSearchParams({ name, count: '6', language: 'ru', format: 'json' });
  return 'https://geocoding-api.open-meteo.com/v1/search?' + q.toString();
}

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Turns the Open-Meteo answer into what the island shows. */
export function normalizeForecast(raw, place, fetchedAt = Date.now()) {
  const c = raw.current || {};
  const h = raw.hourly || {};
  const d = raw.daily || {};
  const nowLocal = String(c.time || '');
  const hourStamp = nowLocal.slice(0, 13); // "2026-11-11T21"

  const times = h.time || [];
  let start = times.findIndex((t) => String(t).slice(0, 13) >= hourStamp);
  if (start < 0) start = 0;
  const hourly = [];
  for (let i = start; i < times.length && hourly.length < 24; i++) {
    hourly.push({
      time: times[i],
      hour: String(times[i]).slice(11, 16),
      temp: num(h.temperature_2m && h.temperature_2m[i]),
      code: num(h.weather_code && h.weather_code[i]),
      isDay: num(h.is_day && h.is_day[i], 1) === 1,
      pop: num(h.precipitation_probability && h.precipitation_probability[i]),
    });
  }

  const daily = [];
  const days = d.time || [];
  for (let i = 0; i < days.length; i++) {
    daily.push({
      date: days[i],
      code: num(d.weather_code && d.weather_code[i]),
      tmax: num(d.temperature_2m_max && d.temperature_2m_max[i]),
      tmin: num(d.temperature_2m_min && d.temperature_2m_min[i]),
      sunrise: String((d.sunrise && d.sunrise[i]) || ''),
      sunset: String((d.sunset && d.sunset[i]) || ''),
      uvMax: num(d.uv_index_max && d.uv_index_max[i]),
      precip: num(d.precipitation_sum && d.precipitation_sum[i]),
      pop: num(d.precipitation_probability_max && d.precipitation_probability_max[i]),
    });
  }

  return {
    place,
    fetchedAt,
    localTime: nowLocal,
    utcOffset: num(raw.utc_offset_seconds),
    current: {
      temp: num(c.temperature_2m),
      feels: num(c.apparent_temperature),
      code: num(c.weather_code),
      isDay: num(c.is_day, 1) === 1,
      humidity: num(c.relative_humidity_2m),
      dew: num(c.dew_point_2m),
      pressure: Math.round(hpaToMmHg(num(c.surface_pressure))),
      wind: num(c.wind_speed_10m),
      windDir: num(c.wind_direction_10m),
      gusts: num(c.wind_gusts_10m),
      precip: num(c.precipitation),
      cloud: num(c.cloud_cover),
      uv: num(c.uv_index),
    },
    hourly,
    daily,
  };
}

/** Where the sun is on its arc today: 0 at sunrise, 1 at sunset, <0 or >1 at night. */
export function sunProgress(localTime, sunrise, sunset) {
  const t = Date.parse(localTime + ':00Z');
  const a = Date.parse(sunrise + ':00Z');
  const b = Date.parse(sunset + ':00Z');
  if (![t, a, b].every(Number.isFinite) || b <= a) return 0.5;
  return (t - a) / (b - a);
}

export const formatTemp = (t) => (Math.round(t) === 0 ? '0' : String(Math.round(t)).replace('-', '−')) + '°';
