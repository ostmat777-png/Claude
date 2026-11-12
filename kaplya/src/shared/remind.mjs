// Understands when to remind from plain Russian (and a little English):
//   "через 20 минут позвонить Ане", "в 15:30 созвон", "завтра в 9 таблетки",
//   "позвонить маме через 2 часа", "в пятницу в 18 кино"

const UNITS = [
  [/^(секунд[уы]?|сек|с|seconds?|sec|s)$/i, 1000],
  [/^(минут[уы]?|мин|м|minutes?|min|m)$/i, 60000],
  [/^(час(а|ов)?|ч|hours?|h)$/i, 3600000],
  [/^(день|дня|дней|д|days?|d)$/i, 86400000],
];

const WEEKDAYS = [
  [/^(воскресенье|вс)$/i, 0],
  [/^(понедельник|пн)$/i, 1],
  [/^(вторник|вт)$/i, 2],
  [/^(сред[ау]|ср)$/i, 3],
  [/^(четверг|чт)$/i, 4],
  [/^(пятниц[ау]|пт)$/i, 5],
  [/^(суббот[ау]|сб)$/i, 6],
];

function unitMs(word) {
  for (const [re, ms] of UNITS) if (re.test(word)) return ms;
  return 0;
}

/**
 * @param {string} input
 * @param {Date} [now]
 * @returns {{ at: number, text: string } | null} time in ms and what is left of the text
 */
export function parseReminder(input, now = new Date()) {
  let text = ' ' + String(input || '').replace(/\s+/g, ' ').trim() + ' ';
  if (!text.trim()) return null;
  let at = null;

  // через 20 минут / через полчаса / через час / in 10 min
  let m = /\s(?:через|in)\s+(полчаса|полтора часа|\d+(?:[.,]\d+)?\s*[a-zа-яё]+|[a-zа-яё]+)(?=\s)/i.exec(text);
  if (m) {
    let ms = 0;
    const body = m[1].toLowerCase();
    if (body === 'полчаса') ms = 30 * 60000;
    else if (body === 'полтора часа') ms = 90 * 60000;
    else {
      const parts = /^(\d+(?:[.,]\d+)?)?\s*([a-zа-яё]+)$/i.exec(body);
      if (parts) ms = (parts[1] ? parseFloat(parts[1].replace(',', '.')) : 1) * unitMs(parts[2]);
    }
    if (ms > 0) {
      at = now.getTime() + ms;
      text = text.replace(m[0], ' ');
    }
  }

  if (at === null) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let dayGiven = false;

    m = /\s(сегодня|завтра|послезавтра|today|tomorrow)(?=\s)/i.exec(text);
    if (m) {
      const w = m[1].toLowerCase();
      const add = w === 'завтра' || w === 'tomorrow' ? 1 : w === 'послезавтра' ? 2 : 0;
      day.setDate(day.getDate() + add);
      dayGiven = true;
      text = text.replace(m[0], ' ');
    } else {
      m = /\s(?:в|во)\s+([а-яё]+)(?=\s)/i.exec(text);
      if (m) {
        const wd = WEEKDAYS.find(([re]) => re.test(m[1]));
        if (wd) {
          let add = (wd[1] - day.getDay() + 7) % 7;
          if (add === 0) add = 7;
          day.setDate(day.getDate() + add);
          dayGiven = true;
          text = text.replace(m[0], ' ');
        }
      }
    }

    // в 15:30 / в 9 / at 7pm / 15:30
    let hours = null;
    let minutes = 0;
    m = /\s(?:в|at)\s+(\d{1,2})(?:[:.](\d{2}))?\s*(утра|вечера|дня|ночи|am|pm)?(?=\s)/i.exec(text) ||
      /\s(\d{1,2}):(\d{2})()(?=\s)/.exec(text);
    if (m) {
      hours = Number(m[1]);
      minutes = m[2] ? Number(m[2]) : 0;
      const part = (m[3] || '').toLowerCase();
      if ((part === 'вечера' || part === 'pm' || part === 'дня') && hours < 12) hours += 12;
      if ((part === 'утра' || part === 'am' || part === 'ночи') && hours === 12) hours = 0;
      if (hours > 23 || minutes > 59) return null;
      text = text.replace(m[0], ' ');
    }

    if (hours === null && !dayGiven) return null;
    if (hours === null) hours = 9; // "завтра купить хлеб" -> tomorrow morning
    const when = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, 0, 0);
    // "в 9" said at 15:00 means tomorrow morning
    if (!dayGiven && when.getTime() <= now.getTime()) when.setDate(when.getDate() + 1);
    at = when.getTime();
  }

  text = text.replace(/\s(напомни(ть)?( мне)?|remind me( to)?)(?=\s)/i, ' ').replace(/\s+/g, ' ').trim();
  return { at, text: text || 'Напоминание' };
}

/** "сегодня в 15:30", "завтра в 9:00", "пт, 14 ноября в 18:00" */
export function describeTime(at, now = new Date()) {
  const d = new Date(at);
  const hm = d.toLocaleTimeString('ru-RU', { hour: 'numeric', minute: '2-digit' });
  const dayStart = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((dayStart(d) - dayStart(now)) / 86400000);
  if (diff === 0) return 'сегодня в ' + hm;
  if (diff === 1) return 'завтра в ' + hm;
  return d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' }) + ' в ' + hm;
}
