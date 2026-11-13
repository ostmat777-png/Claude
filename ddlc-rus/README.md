# Русификатор Doki Doki Literature Club! (Steam)

Полный русский перевод оригинальной **Doki Doki Literature Club!** (версия 1.1.1 — Steam, ddlc.moe, itch.io).

**Скачать:** [`DDLC-Russian-v1.0.zip`](DDLC-Russian-v1.0.zip) → кнопка «Download raw file».
**Как установить:** [`УСТАНОВКА.txt`](УСТАНОВКА.txt) (то же самое лежит внутри архива).

Коротко: распакуйте архив и скопируйте папки `tl` и `ru` из его папки `game` в папку `game` игры
(Steam → ПКМ по игре → «Управление» → «Просмотреть локальные файлы»).

## Что переведено

| Что | Объём |
|---|---|
| Диалоги и повествование (все 4 акта, все ветки, разговоры Моники) | 10 821 реплика (8 478 уникальных) |
| Стихотворения | 20 стихотворений (одно зашифрованное base64 оставлено как в оригинале) |
| Интерфейс, меню, окна, подтверждения, титры, заставки | 129 строк + системные строки Ren'Py |
| Мини-игра со стихами | 228 слов |
| Шрифты с кириллицей | 11 шрифтов игры заменены похожими свободными шрифтами |

Не переведены только надписи, нарисованные на картинках (логотип и «секретные» стихи второго акта).

## Как это устроено

Используется штатная система переводов движка Ren'Py: файлы `game/tl/russian/*.rpy`
содержат блоки `translate russian <id>:` с теми же идентификаторами, что и в оригинальных скриптах,
поэтому оригинальные файлы игры не изменяются. Язык включается автоматически
(`config.language = "russian"`), шрифты подменяются через `config.font_replacement_map`.

## Структура репозитория

- `translation/STYLE.md` — правила перевода (имена, термины, голоса персонажей, типографика).
- `translation/ru/c001.txt … c071.txt` — перевод всех реплик.
- `translation/poems_ru.txt`, `strings_ru.txt`, `poemwords_ru.txt` — стихи, интерфейс, слова мини-игры.
- `tools/` — скрипты извлечения текста из `scripts.rpa`, сборки и проверки.
- `DDLC-Russian-v1.0.zip` — готовый русификатор.

## Сборка из исходников

Нужны: Python 3, Pillow, ваш собственный `scripts.rpa` из папки игры, Ren'Py SDK 6.99.12.4
(только файлы `tl/russian/common.rpy`) и шрифты (PT Sans, Nunito, Comfortaa, Pangolin, Shantell Sans,
Bad Script, Marck Script, Comforter, Caveat с Google Fonts и GNU FreeMono).

```
export DDLC_WORK=work
python3 tools/unrpa.py scripts.rpa work/extracted
python3 tools/extract.py work/extracted work/blocks.json
python3 tools/units.py
python3 tools/build.py work SDK/launcher/game/tl/russian/common.rpy,SDK/tutorial/game/tl/russian/common.rpy fonts out
python3 tools/check_build.py out/game/tl/russian
```

Doki Doki Literature Club! © Team Salvato. Это любительский перевод, не связанный с Team Salvato
и Serenity Forge; для работы нужна оригинальная игра.
