// Languages offered for translation, and a quick guess at the language of a text.

export const LANGUAGES = [
  ['ru', 'Русский'],
  ['en', 'Английский'],
  ['uk', 'Украинский'],
  ['be', 'Белорусский'],
  ['kk', 'Казахский'],
  ['uz', 'Узбекский'],
  ['de', 'Немецкий'],
  ['fr', 'Французский'],
  ['es', 'Испанский'],
  ['it', 'Итальянский'],
  ['pt', 'Португальский'],
  ['pl', 'Польский'],
  ['cs', 'Чешский'],
  ['tr', 'Турецкий'],
  ['fi', 'Финский'],
  ['sv', 'Шведский'],
  ['et', 'Эстонский'],
  ['lv', 'Латышский'],
  ['lt', 'Литовский'],
  ['el', 'Греческий'],
  ['ka', 'Грузинский'],
  ['hy', 'Армянский'],
  ['az', 'Азербайджанский'],
  ['he', 'Иврит'],
  ['ar', 'Арабский'],
  ['hi', 'Хинди'],
  ['zh-CN', 'Китайский'],
  ['ja', 'Японский'],
  ['ko', 'Корейский'],
];

export const languageName = (code) => (LANGUAGES.find(([c]) => c === code) || [code, code])[1];

/** A rough guess from the letters used: good enough to choose "into which language". */
export function guessLanguage(text) {
  const t = String(text || '');
  const count = (re) => (t.match(re) || []).length;
  const cyr = count(/[а-яё]/gi);
  const lat = count(/[a-z]/gi);
  if (cyr > lat) {
    if (/[іїєґ]/i.test(t)) return 'uk';
    if (/[ў]/i.test(t)) return 'be';
    if (/[әғқңөұүһ]/i.test(t)) return 'kk';
    return 'ru';
  }
  if (count(/[぀-ヿ]/g)) return 'ja';
  if (count(/[가-힯]/g)) return 'ko';
  if (count(/[一-鿿]/g)) return 'zh-CN';
  if (count(/[؀-ۿ]/g)) return 'ar';
  if (count(/[֐-׿]/g)) return 'he';
  if (count(/[Ⴀ-ჿ]/g)) return 'ka';
  if (count(/[Ͱ-Ͽ]/g)) return 'el';
  return lat ? 'en' : '';
}
