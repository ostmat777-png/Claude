// Bits used by more than one part of the island page.

/** A colour for a weather icon, so the sun is warm and the rain is blue. */
export function weatherTint(name) {
  if (name === 'sun') return '#ffc83d';
  if (name === 'moon') return '#c9d3ff';
  if (name === 'cloud-sun') return '#ffd76a';
  if (name === 'cloud-moon') return '#c9d3ff';
  if (name === 'cloud-lightning') return '#ffb14a';
  if (name === 'cloud-rain' || name === 'cloud-drizzle') return '#7fb8ff';
  if (name === 'cloud-snow') return '#d6ecff';
  return 'var(--muted)';
}

/** The page of an online translator with the text already in it. */
export function translateUrl(search, text) {
  const q = encodeURIComponent(String(text || '').slice(0, 4000));
  return search === 'yandex'
    ? `https://translate.yandex.ru/?source_lang=auto&target_lang=ru&text=${q}`
    : `https://translate.google.com/?sl=auto&tl=ru&op=translate&text=${q}`;
}

// Program identifiers as Windows reports them -> names a person recognises.
const APP_NAMES = [
  [/^title:browser\.exe/i, 'Яндекс Браузер'],
  [/spotify/i, 'Spotify'],
  [/yandex.*music|music.*yandex/i, 'Яндекс Музыка'],
  [/yandex/i, 'Яндекс Браузер'],
  [/chrome/i, 'Google Chrome'],
  [/msedge|microsoftedge/i, 'Microsoft Edge'],
  [/^browser(\.exe)?$|yandex.*browser|^yandex\./i, 'Яндекс Браузер'],
  [/firefox|308046B0AF4A39CB/i, 'Firefox'],
  [/opera/i, 'Opera'],
  [/brave/i, 'Brave'],
  [/vivaldi/i, 'Vivaldi'],
  [/vk/i, 'VK'],
  [/aimp/i, 'AIMP'],
  [/winamp/i, 'Winamp'],
  [/vlc/i, 'VLC'],
  [/foobar/i, 'foobar2000'],
  [/zunemusic|mediaplayer|wmplayer/i, 'Проигрыватель Windows'],
  [/telegram/i, 'Telegram'],
  [/discord/i, 'Discord'],
  [/steam/i, 'Steam'],
];

/** "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify" -> "Spotify". */
export const MUSIC_SERVICES = [
  { id: 'yandex', name: 'Яндекс Музыка', url: 'https://music.yandex.ru/' },
  { id: 'vk', name: 'VK Музыка', url: 'https://vk.com/audio' },
  { id: 'ytmusic', name: 'YouTube Music', url: 'https://music.youtube.com/' },
  { id: 'spotify', name: 'Spotify', url: 'https://open.spotify.com/' },
  { id: 'soundcloud', name: 'SoundCloud', url: 'https://soundcloud.com/discover' },
];

export function appLabel(id) {
  const s = String(id || '');
  if (!s) return '';
  if (s.startsWith('title:')) return appLabel(s.slice(6)); // a browser known by its window title
  if (s.startsWith('kaplya:web')) {
    const id = s.slice('kaplya:web:'.length);
    const svc = MUSIC_SERVICES.find((x) => x.id === id);
    return 'Капля · ' + (svc ? svc.name : id === 'youtube' ? 'YouTube' : 'Плеер');
  }
  for (const [re, name] of APP_NAMES) if (re.test(s)) return name;
  const tail = s.split(/[!\\/]/).pop().replace(/\.exe$/i, '');
  const last = tail.includes('.') && !/\s/.test(tail) ? tail.split('.').pop() : tail;
  return last.length > 28 ? last.slice(0, 28) : last;
}

const MUSIC_SEARCH = {
  yandex: 'https://music.yandex.ru/search?text=',
  vk: 'https://vk.com/audio?q=',
  youtube: 'https://www.youtube.com/results?search_query=',
  ytmusic: 'https://music.youtube.com/search?q=',
  spotify: 'https://open.spotify.com/search/',
};

/** Where to look a track up, in the service chosen in the settings. */
export function musicSearchUrl(service, query) {
  return (MUSIC_SEARCH[service] || MUSIC_SEARCH.yandex) + encodeURIComponent(String(query || ''));
}

/** A colour for a letter icon, the same every time for the same name. */
export function colorFor(name) {
  let n = 0;
  for (const ch of String(name)) n = (n * 31 + ch.codePointAt(0)) % 360;
  return `hsl(${n} 55% 46%)`;
}
