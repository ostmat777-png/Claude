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
