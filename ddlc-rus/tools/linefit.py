#!/usr/bin/env python3
"""Проверка, помещаются ли реплики в текстовое окно (PT Sans 24px, ширина 744px)."""
import json, os, re, sys
from PIL import ImageFont
sys.path.insert(0, os.path.dirname(__file__))
from chunk import load_ru  # noqa

def wrap_count(text, font, width):
    lines = 0
    for para in text.split("\n"):
        words = para.split(" ")
        cur = ""
        n = 1
        for w in words:
            t = (cur + " " + w) if cur else w
            if font.getlength(t) <= width:
                cur = t
            else:
                n += 1
                cur = w
        lines += n
    return lines

def clean(t):
    t = t.replace("\\n", "\n")
    t = re.sub(r"\{[^{}]*\}", "", t)
    t = t.replace("[player]", "Александр")
    t = re.sub(r"\[[^\]]*\]", "Нацуки", t)
    return t

def main(units_path, font_path, limit=3):
    units = json.load(open(units_path, encoding="utf-8"))
    ru = load_ru()
    font = ImageFont.truetype(font_path, 24)
    bad = []
    for u in units:
        t = clean(ru[u["uid"]])
        if u["who"] is not None:
            t = "«" + t + "»"
        n = wrap_count(t, font, 744)
        if n > limit:
            bad.append((n, u["uid"], u["who"], t))
    bad.sort(reverse=True)
    for n, uid, who, t in bad:
        print(n, uid, who, t)
    print("over limit:", len(bad))

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 3)
