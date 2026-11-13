#!/usr/bin/env python3
"""Сборка русификатора DDLC.

Использование:
    python3 build.py WORK_DIR SDK_COMMON_RPY FONTS_DIR OUT_DIR

WORK_DIR        — папка с извлечёнными данными (extracted/*.rpyc, blocks.json, units.json),
                  см. tools/README.md;
SDK_COMMON_RPY  — tutorial/game/tl/russian/common.rpy из Ren'Py SDK 6.99.12.4;
FONTS_DIR       — папка со скачанными шрифтами;
OUT_DIR         — куда собрать готовую папку game/.
"""
import json, os, re, sys, shutil, random, collections

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import rpyc  # noqa: E402

TR = os.path.join(os.path.dirname(HERE), "translation")
LANG = "russian"


# ---------------------------------------------------------------- helpers
def quote(s):
    """Ren'Py-совместимая строка в кавычках (как renpy.translation.quote_unicode)."""
    s = s.replace("\\", "\\\\")
    s = s.replace("\n", "\\n")
    s = s.replace("\"", "\\\"")
    s = re.sub(r"(?<= ) ", "\\ ", s)
    return "\"" + s + "\""


def pyquote(s):
    """Строка для python-кода: u"..."."""
    out = []
    for ch in s:
        if ch == "\\":
            out.append("\\\\")
        elif ch == "\"":
            out.append("\\\"")
        elif ch == "\n":
            out.append("\\n")
        else:
            out.append(ch)
    return "u\"" + "".join(out) + "\""


def unesc(s):
    return s.replace("\\n", "\n")


def load_ru_units():
    ru = {}
    d = os.path.join(TR, "ru")
    for fn in sorted(os.listdir(d)):
        for line in open(os.path.join(d, fn), encoding="utf-8"):
            m = re.match(r"^(u\d{5}) (.*)$", line.rstrip("\n"))
            if m:
                ru[m.group(1)] = unesc(m.group(2))
    return ru


def gender(who):
    if who in (None, "mc"):
        return "M"
    if who == "ny":
        return "P"
    return "F"


# ---------------------------------------------------------------- dialogue
def build_dialogue(work, out_tl):
    blocks = json.load(open(os.path.join(work, "blocks.json"), encoding="utf-8"))
    units = json.load(open(os.path.join(work, "units.json"), encoding="utf-8"))
    ru = load_ru_units()
    key2uid = {u["g"] + "\t" + u["en"]: u["uid"] for u in units}
    en2ru = {}
    for u in units:
        en2ru.setdefault(u["en"], ru[u["uid"]])
    files = collections.OrderedDict()
    for b in blocks:
        files.setdefault(b["file"], []).append(b)
    os.makedirs(out_tl, exist_ok=True)
    n = 0
    for fn, bl in files.items():
        lines = ["# Русский перевод: " + fn, ""]
        for b in bl:
            s = b["stmts"][0]
            uid = key2uid[gender(s["who"]) + "\t" + s["what"]]
            parts = []
            if s["who"]:
                parts.append(s["who"])
            if s["attrs"]:
                parts.extend(s["attrs"])
            parts.append(quote(ru[uid]))
            if not s["interact"]:
                parts.append("nointeract")
            if s["with"]:
                parts.extend(["with", s["with"]])
            lines.append("translate %s %s:" % (LANG, b["id"]))
            lines.append("    " + " ".join(parts))
            lines.append("")
            n += 1
        open(os.path.join(out_tl, fn + ".rpy"), "w", encoding="utf-8").write("\n".join(lines))
    print("dialogue blocks:", n)
    return en2ru


# ---------------------------------------------------------------- strings
def parse_pairs(path):
    pairs = collections.OrderedDict()
    old = None
    for line in open(path, encoding="utf-8"):
        line = line.rstrip("\n")
        if line.startswith("old: "):
            old = unesc(line[5:])
        elif line.startswith("new: "):
            assert old is not None, line
            assert old not in pairs, "duplicate: " + old
            pairs[old] = unesc(line[5:])
            old = None
    return pairs


def code_of(node):
    st = getattr(getattr(node, "code", None), "_state", None)
    return st[1] if st else ""


def walk(nodes):
    for n in nodes:
        yield n
        for attr in ("block",):
            b = getattr(n, attr, None)
            if isinstance(b, list):
                yield from walk(b)
        if n._name == "If":
            for c, b in n.entries:
                yield from walk(b)
        if n._name == "Menu":
            for l, c, b in n.items:
                if b:
                    yield from walk(b)


def filter_common(text, exclude):
    """Убирает из файла common.rpy записи, чьи old уже есть в exclude."""
    out_lines, kept = [], set()
    src_lines = text.split("\n")
    i = 0
    while i < len(src_lines):
        line = src_lines[i]
        m = re.match(r'^    old "((?:[^"\\]|\\.)*)"$', line)
        if m and i + 1 < len(src_lines) and src_lines[i + 1].startswith("    new "):
            old = re.sub(r'\\(.)', lambda mm: {"n": "\n", '"': '"', "\\": "\\"}.get(mm.group(1), mm.group(1)), m.group(1))
            if old in exclude or old in kept:
                if out_lines and out_lines[-1].startswith("    #"):
                    out_lines.pop()
                i += 2
                continue
            kept.add(old)
        out_lines.append(line)
        i += 1
    # Убираем опустевшие блоки «translate ... strings:» (Ren'Py не допускает пустых блоков).
    res, block = [], None
    for line in out_lines + ["translate END:"]:
        if line.startswith("translate "):
            if block is not None and any(l.startswith("    old ") for l in block):
                res.extend(block)
            block = [line]
        elif block is None:
            res.append(line)
        else:
            block.append(line)
    return "\n".join(res).rstrip() + "\n", kept


def find_history_text(work):
    d, st = rpyc.load(os.path.join(work, "extracted", "script-ch23.rpyc"))
    for n in walk(st):
        if n._name == "Python" and "add_history" in code_of(n):
            src = code_of(n)
            m = re.search(r'add_history\(None, "", """(.*?)"""\)', src, re.S)
            return m.group(1)
    raise RuntimeError("add_history not found")


MONIKA_HISTORY_EN_UNIT = (
    "Welcome to the Literature Club! It's always been a dream of mine to make something special out of the things I love. "
    "Now that you're a club member, you can help me make that dream come true in this cute game!"
    "Every day is full of chit-chat and fun activities with all of my adorable and unique club members:"
    "Sayori, the youthful bundle of sunshine who values happiness the most;"
    "Natsuki, the deceivingly cute girl who packs an assertive punch;"
    "Yuri, the timid and mysterious one who finds comfort in the world of books;"
    "...And, of course, Monika, the leader of the club! That's me!"
    "I'm super excited for you to make friends with everyone and help the Literature Club become a more intimate place for all my members. "
    "But I can tell already that you're a sweetheart\u2014will you promise to spend the most time with me?")
MONIKA_HISTORY_RU_UNIT = (
    "Добро пожаловать в Литературный клуб! Я всегда мечтала создать что-то особенное из того, что люблю. "
    "Теперь, когда ты в клубе, ты можешь помочь мне осуществить эту мечту в этой милой игре!"
    "Каждый день полон болтовни и весёлых занятий со всеми моими очаровательными и неповторимыми участницами клуба:"
    "Сайори — юный сгусток солнечного света, для которого счастье важнее всего;"
    "Нацуки — обманчиво милая девушка с весьма напористым характером;"
    "Юри — робкая и загадочная, находящая утешение в мире книг;"
    "...И, конечно же, Моника — президент клуба! Это я!"
    "Мне ужасно хочется, чтобы ты со всеми подружился и помог Литературному клубу стать для всех участниц по-настоящему родным местом. "
    "Но я уже вижу, что ты душка, — пообещаешь проводить больше всего времени со мной?")


def build_strings(work, en2ru, common_src, out_tl):
    pairs = parse_pairs(os.path.join(TR, "strings_ru.txt"))
    # Строки, которые игра подставляет в историю диалогов вместо реплик.
    for en in ["Freaking Monika...",
               "Consider this a lesson straight from the Literature Club: Don't judge a book by its cover!",
               "I don't even know what my dad would do if he found this."]:
        pairs[en] = en2ru[en]
    # Длинная «рекламная» запись Моники в истории.
    hist = find_history_text(work)
    phrase_en = "will you promise to spend the most time with me?"
    phrase_ru = "пообещаешь проводить больше всего времени со мной?"
    rest, ru_hist = hist, ""
    while rest.startswith(MONIKA_HISTORY_EN_UNIT):
        rest = rest[len(MONIKA_HISTORY_EN_UNIT):]
        ru_hist += MONIKA_HISTORY_RU_UNIT
    while rest.startswith(phrase_en):
        rest = rest[len(phrase_en):]
        ru_hist += phrase_ru
    if rest:
        if phrase_en.startswith(rest):
            ru_hist += phrase_ru[:max(1, int(len(phrase_ru) * len(rest) / len(phrase_en)))]
        else:
            print("WARNING: unexpected history tail:", repr(rest[:60]))
            ru_hist += rest
    pairs[hist] = ru_hist

    # Проверка покрытия: все пункты меню и все _() из экранов.
    needed = set()
    for fn in os.listdir(os.path.join(work, "extracted")):
        if not fn.endswith(".rpyc"):
            continue
        d, st = rpyc.load(os.path.join(work, "extracted", fn))
        for n in walk(st):
            if n._name == "Menu":
                for l, c, b in n.items:
                    if l != "[gtext]":
                        needed.add(l)
    missing = sorted(x for x in needed if x not in pairs)
    if missing:
        print("MISSING strings:", missing)

    # common.rpy из SDK (лаунчер + туториал), без дублей и без строк, которые переопределяем мы.
    exclude = set(pairs)
    for idx, src in enumerate(common_src.split(",")):
        text, kept = filter_common(open(src, encoding="utf-8").read(), exclude)
        exclude |= kept
        name = "common.rpy" if idx == 0 else "common%d.rpy" % (idx + 1)
        open(os.path.join(out_tl, name), "w", encoding="utf-8").write(text)
        print(name, "entries:", len(kept))

    lines = ["# Русский перевод: интерфейс, меню и прочие строки", "", "translate %s strings:" % LANG, ""]
    for old, new in pairs.items():
        lines.append("    old " + quote(old))
        lines.append("    new " + quote(new))
        lines.append("")
    open(os.path.join(out_tl, "strings.rpy"), "w", encoding="utf-8").write("\n".join(lines))
    print("strings:", len(pairs))


# ---------------------------------------------------------------- poems
SALAD_WORDS = """
пиразолон шагреневый ресницедробь мантикора вспять лёгочник обоюдоострый калейдоскопичный
кровоток уховёртка кружевница рассвирепеть небосвод прозекторская чернокнижие бархатистость
гравюра медуница отпечаток виноградарь рукоять поволока смятение шелкопряд колокольня
изморозь сукровица шорох кадило безвременье полынь кочерга отзвук мерцание дактилоскопия
гербарий надрез беспамятство пергамент летаргия ворох шиповник клубящийся анемия перламутр
пульсация безучастный скарабей вожделение порфира тлен аритмия пленительный ланцет
кристаллический полумрак шрам клинопись вереск анатомический зеркальце гранат мотылёк
бессонница ладан пустошь заклинание акварель багрянец разрез лезвие дрожь омут
тетива корпускула ксилограф ниспадающий истома гравитация обсидиан сонм осколок
алебастр рапсодия смолистый навзничь хризолит безмолвие лихорадка серп плеть
""".split()


def make_salad(n_chars, seed=7):
    rnd = random.Random(seed)
    out = []
    total = 0
    while total < n_chars:
        k = rnd.choice([1, 1, 2, 2, 3, 4])
        chunk = " ".join(rnd.choice(SALAD_WORDS) for _ in range(k))
        out.append(chunk)
        total += len(chunk) + 2
    s = ",,".join(out)
    return s[:n_chars]


def parse_poems():
    poems = collections.OrderedDict()
    cur = None
    for raw in open(os.path.join(TR, "poems_ru.txt"), encoding="utf-8"):
        line = raw.rstrip("\n")
        if line.startswith("=== "):
            cur = line[4:].strip()
            poems[cur] = {"title": None, "lines": [], "body": False}
        elif not poems[cur]["body"] and line.startswith("title:"):
            poems[cur]["title"] = line[6:].strip()
        elif not poems[cur]["body"] and line == "---":
            poems[cur]["body"] = True
        elif poems[cur]["body"]:
            poems[cur]["lines"].append(line)
    out = collections.OrderedDict()
    for k, p in poems.items():
        lines = p["lines"]
        while lines and lines[-1].strip() == "":
            lines.pop()
        text = "\n".join(lines)
        if "@SALAD@" in text:
            text = text.replace("@SALAD@", make_salad(3800))
        if "@GETOUT@" in text:
            text = text.replace("@GETOUT@", " ".join(["Уйди из моей головы."] * 39))
        out[k] = (p["title"], text)
    return out


def load_poemwords():
    words = collections.OrderedDict()
    for line in open(os.path.join(TR, "poemwords_ru.txt"), encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        en, ru = line.split("=", 1)
        words[en] = ru
    return words


# ---------------------------------------------------------------- setup .rpy
CYR = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя"
LAT = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

FONTS = [
    # (оригинал, обычный, жирный, курсив, жирный курсив)
    ("gui/font/Aller_Rg.ttf", "PTSans-Regular.ttf", "PTSans-Bold.ttf", "PTSans-Italic.ttf", "PTSans-BoldItalic.ttf"),
    ("gui/font/Aller_Bd.ttf", "PTSans-Bold.ttf", "PTSans-Bold.ttf", "PTSans-BoldItalic.ttf", "PTSans-BoldItalic.ttf"),
    ("gui/font/RifficFree-Bold.ttf", "Nunito-Black.ttf", "Nunito-Black.ttf", "Nunito-BlackItalic.ttf", "Nunito-BlackItalic.ttf"),
    ("gui/font/Halogen.ttf", "Comfortaa-Bold.ttf", "Comfortaa-Bold.ttf", "Comfortaa-Bold.ttf", "Comfortaa-Bold.ttf"),
    ("gui/font/VerilySerifMono.otf", "FreeMono.ttf", "FreeMonoBold.ttf", "FreeMonoOblique.ttf", "FreeMonoBoldOblique.ttf"),
    ("gui/font/s1.ttf", "Pangolin-Regular.ttf", "Pangolin-Regular.ttf", "Pangolin-Regular.ttf", "Pangolin-Regular.ttf"),
    ("gui/font/n1.ttf", "ShantellSans-Regular.ttf", "ShantellSans-Bold.ttf", "ShantellSans-Italic.ttf", "ShantellSans-BoldItalic.ttf"),
    ("gui/font/y1.ttf", "BadScript-Regular.ttf", "BadScript-Regular.ttf", "BadScript-Regular.ttf", "BadScript-Regular.ttf"),
    ("gui/font/y2.ttf", "MarckScript-Regular.ttf", "MarckScript-Regular.ttf", "MarckScript-Regular.ttf", "MarckScript-Regular.ttf"),
    ("gui/font/y3.ttf", "Comforter-Regular.ttf", "Comforter-Regular.ttf", "Comforter-Regular.ttf", "Comforter-Regular.ttf"),
    ("gui/font/m1.ttf", "Caveat-Regular.ttf", "Caveat-Bold.ttf", "Caveat-Regular.ttf", "Caveat-Bold.ttf"),
]

REPORT_EXCEPTION_EN = ("Oh jeez...I didn't break anything, did I? Hold on a sec, I can probably fix this...I think...\n"
                       "Actually, you know what? This would probably be a lot easier if I just deleted her. "
                       "She's the one who's making this so difficult. Ahaha! Well, here goes nothing.")
REPORT_EXCEPTION_RU = ("Ой, божечки... Я ведь ничего не сломала, правда? Секундочку, я, наверное, смогу это починить... кажется...\n"
                       "А знаешь что? Наверное, будет куда проще, если я просто её удалю. "
                       "Это ведь из-за неё всё так сложно. А-ха-ха! Ну, была не была.")


def build_setup(out_tl):
    poems = parse_poems()
    words = load_poemwords()
    L = []
    L.append("# Русификатор Doki Doki Literature Club! — настройки языка, шрифты, стихи.")
    L.append("")
    L.append("define config.language = \"%s\"" % LANG)
    L.append("")
    L.append("init -100 python:")
    L.append("    # Шрифты с кириллицей вместо оригинальных.")
    for orig, r, b, i, bi in FONTS:
        for (bold, ital), f in (((False, False), r), ((True, False), b), ((False, True), i), ((True, True), bi)):
            L.append("    config.font_replacement_map[(%r, %s, %s)] = (\"ru/fonts/%s\", False, False)" % (orig, bold, ital, f))
    L.append("")
    L.append("init 1 python:")
    L.append("    # Реплики в «ёлочках» вместо английских кавычек.")
    L.append("    for _ru_c in (mc, s, m, n, y, ny):")
    L.append("        _ru_c.what_prefix = u\"\\u00ab\"")
    L.append("        _ru_c.what_suffix = u\"\\u00bb\"")
    L.append("")
    L.append("    # Стихотворения.")
    for k, (title, text) in poems.items():
        L.append("    %s.title = %s" % (k, pyquote(title or "")))
        L.append("    %s.text = %s" % (k, pyquote(text)))
    L.append("")
    L.append("    # Слова мини-игры со стихами.")
    L.append("    _ru_poemwords = {")
    for en, ru in words.items():
        L.append("        %r: %s," % (en, pyquote(ru)))
    L.append("    }")
    L.append("    for _ru_w in full_wordlist:")
    L.append("        _ru_w.word = _ru_poemwords.get(_ru_w.word, _ru_w.word)")
    L.append("")
    L.append("    # Сообщение, которое Моника «пишет» в traceback.txt в конце первого акта.")
    L.append("    import sys as _ru_sys")
    L.append("    _ru_err = _ru_sys.modules['renpy.error']")
    L.append("    if not hasattr(_ru_err, '_ru_original_report_exception'):")
    L.append("        _ru_err._ru_original_report_exception = _ru_err.report_exception")
    L.append("        _RU_EXC = {%s: %s}" % (pyquote(REPORT_EXCEPTION_EN), pyquote(REPORT_EXCEPTION_RU)))
    L.append("        def _ru_report_exception(e, editor=True):")
    L.append("            try:")
    L.append("                if isinstance(e, basestring) and e in _RU_EXC:")
    L.append("                    e = _RU_EXC[e]")
    L.append("            except Exception:")
    L.append("                pass")
    L.append("            return _ru_err._ru_original_report_exception(e, editor)")
    L.append("        _ru_err.report_exception = _ru_report_exception")
    L.append("")
    open(os.path.join(out_tl, "zz_russian_setup.rpy"), "w", encoding="utf-8").write("\n".join(L))

    S = []
    S.append("# Экран ввода имени: разрешены русские и латинские буквы.")
    S.append("")
    S.append("init offset = 1")
    S.append("")
    S.append("screen name_input(message, ok_action):")
    S.append("    modal True")
    S.append("    zorder 200")
    S.append("    style_prefix \"confirm\"")
    S.append("    add \"gui/overlay/confirm.png\"")
    S.append("    key \"K_RETURN\" action [Play(\"sound\", gui.activate_sound), ok_action]")
    S.append("    frame:")
    S.append("        vbox:")
    S.append("            xalign .5")
    S.append("            yalign .5")
    S.append("            spacing 30")
    S.append("            label _(message):")
    S.append("                style \"confirm_prompt\"")
    S.append("                xalign 0.5")
    S.append("            input default \"\" value VariableInputValue(\"player\") length 12 allow \"%s%s\"" % (LAT, CYR))
    S.append("            hbox:")
    S.append("                xalign 0.5")
    S.append("                spacing 100")
    S.append("                textbutton _(\"OK\") action ok_action")
    S.append("")
    open(os.path.join(out_tl, "zz_russian_screens.rpy"), "w", encoding="utf-8").write("\n".join(S))


def copy_fonts(fonts_dir, out_game):
    dst = os.path.join(out_game, "ru", "fonts")
    os.makedirs(os.path.join(dst, "licenses"), exist_ok=True)
    need = set()
    for row in FONTS:
        need.update(row[1:])
    found = {}
    for root, dirs, files in os.walk(fonts_dir):
        for f in files:
            if f in need:
                found[f] = os.path.join(root, f)
            if f in ("OFL.txt", "UFL.txt", "LICENSE", "COPYING"):
                fam = os.path.basename(root)
                if any(x in need for x in os.listdir(root)):
                    shutil.copy(os.path.join(root, f), os.path.join(dst, "licenses", fam + "-" + f))
    for f in sorted(need):
        if f not in found:
            raise SystemExit("font not found: " + f)
        shutil.copy(found[f], os.path.join(dst, f))
    print("fonts:", len(need))


def main():
    work, common_src, fonts_dir, out = sys.argv[1:5]
    game = os.path.join(out, "game")
    out_tl = os.path.join(game, "tl", LANG)
    if os.path.isdir(game):
        shutil.rmtree(game)
    os.makedirs(out_tl)
    en2ru = build_dialogue(work, out_tl)
    build_strings(work, en2ru, common_src, out_tl)
    build_setup(out_tl)
    copy_fonts(fonts_dir, game)


if __name__ == "__main__":
    main()
