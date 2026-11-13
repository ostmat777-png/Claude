#!/usr/bin/env python3
"""Статическая проверка собранных файлов tl/russian: синтаксис translate-блоков,
кавычки, уникальность ID и строк, баланс текстовых тегов, синтаксис python-блоков."""
import os, re, sys, ast, textwrap, collections

def lex_string(s, i):
    """Разбор строки Ren'Py в кавычках начиная с s[i]=='\"'. Возвращает (значение, позиция после)."""
    assert s[i] == '"'
    i += 1
    out = []
    while i < len(s):
        c = s[i]
        if c == "\\":
            n = s[i + 1]
            out.append({"n": "\n", '"': '"', "\\": "\\", " ": " "}.get(n, "\\" + n))
            i += 2
            continue
        if c == '"':
            return "".join(out), i + 1
        out.append(c)
        i += 1
    raise ValueError("unterminated string")

TAGS_PAIRED = {"i", "b", "u", "s", "cps", "color", "size", "font", "a", "alpha", "plain"}

def check_tags(text, where, errs):
    stack = []
    for m in re.finditer(r"\{(/?)([a-z_#]+)[^{}]*\}", text):
        close, name = m.group(1), m.group(2)
        if name not in TAGS_PAIRED:
            continue
        if close:
            if not stack or stack[-1] != name:
                errs.append("%s: unbalanced {/%s} in %r" % (where, name, text[:60]))
                return
            stack.pop()
        else:
            stack.append(name)
    if stack:
        errs.append("%s: unclosed {%s} in %r" % (where, stack[-1], text[:60]))

def main(tl):
    errs = []
    ids = collections.Counter()
    olds = collections.Counter()
    for fn in sorted(os.listdir(tl)):
        if not fn.endswith(".rpy"):
            continue
        lines = open(os.path.join(tl, fn), encoding="utf-8").read().split("\n")
        if "\t" in "".join(lines):
            errs.append(fn + ": tab character")
        i = 0
        while i < len(lines):
            line = lines[i]
            m = re.match(r"^translate russian (\w+):$", line)
            if m and m.group(1) != "strings":
                ids[m.group(1)] += 1
                say = lines[i + 1]
                if not say.startswith("    "):
                    errs.append("%s:%d no say line" % (fn, i + 2))
                body = say.strip()
                q = body.find('"')
                head = body[:q].split()
                if not all(re.match(r"^[\w]+$", t) for t in head):
                    errs.append("%s:%d bad head %r" % (fn, i + 2, head))
                try:
                    val, pos = lex_string(body, q)
                except Exception as e:
                    errs.append("%s:%d %s" % (fn, i + 2, e))
                    i += 2
                    continue
                tail = body[pos:].split()
                if tail and not (tail == ["nointeract"] or tail[:1] == ["with"] or tail[:2] == ["nointeract", "with"]):
                    errs.append("%s:%d bad tail %r" % (fn, i + 2, tail))
                check_tags(val, "%s:%d" % (fn, i + 2), errs)
                i += 2
                continue
            if line.startswith("    old ") or line.startswith("    new "):
                val, pos = lex_string(line, 8)
                if line[pos:].strip():
                    errs.append("%s:%d trailing text after string" % (fn, i + 1))
                if line.startswith("    old "):
                    olds[val] += 1
                else:
                    check_tags(val, "%s:%d" % (fn, i + 1), errs)
            if line.startswith("init") and "python" in line:
                # собрать python-блок
                j = i + 1
                block = []
                while j < len(lines) and (lines[j].startswith("    ") or not lines[j].strip()):
                    block.append(lines[j])
                    j += 1
                try:
                    ast.parse(textwrap.dedent("\n".join(block)))
                except SyntaxError as e:
                    errs.append("%s:%d python syntax: %s" % (fn, i + 1, e))
            i += 1
    for k, v in ids.items():
        if v > 1:
            errs.append("duplicate id " + k)
    for k, v in olds.items():
        if v > 1:
            errs.append("duplicate old string %r" % k[:60])
    print("translate ids:", len(ids), "strings:", len(olds))
    for e in errs[:50]:
        print("ERR", e)
    print("errors:", len(errs))
    return 1 if errs else 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
