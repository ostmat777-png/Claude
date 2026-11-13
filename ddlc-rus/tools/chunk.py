"""Chunk tool: plan | show N | check N | status | ru UID"""
import json, sys, os, re, difflib
SP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.environ.get("DDLC_WORK", os.path.join(SP, "src"))
RU = os.path.join(SP, "translation", "ru")
WORDS_PER_CHUNK = 950
SPK = {None: "—", "mc": "mc", "s": "s", "n": "n", "y": "y", "m": "m", "ny": "ny"}

def units(): return json.load(open(os.path.join(WORK, "units.json")))

def plan():
    u = units(); chunks = []; cur = []; w = 0
    for x in u:
        cur.append(x["uid"]); w += len(x["en"].split())
        if w >= WORDS_PER_CHUNK:
            chunks.append(cur); cur = []; w = 0
    if cur: chunks.append(cur)
    json.dump(chunks, open(os.path.join(WORK, "chunks.json"), "w"))
    print(len(chunks), "chunks")

def chunks(): return json.load(open(os.path.join(WORK, "chunks.json")))

def esc(s): return s.replace("\n", "\\n")

def load_ru():
    ru = {}
    if not os.path.isdir(RU): return ru
    for fn in sorted(os.listdir(RU)):
        if not fn.endswith(".txt"): continue
        for line in open(os.path.join(RU, fn), encoding="utf-8"):
            line = line.rstrip("\n")
            m = re.match(r"^(u\d{5}) (.*)$", line)
            if m: ru[m.group(1)] = m.group(2)
    return ru

def show(n):
    u = units(); byid = {x["uid"]: x for x in u}; ch = chunks()[n - 1]
    ru = load_ru()
    first = byid[ch[0]]["uid"]
    prev = [x for x in u if x["uid"] < first and x["uid"] in ru]
    last = None
    for uid in ch:
        x = byid[uid]
        hdr = "## %s / %s" % (x["file"], x["label"])
        if hdr != last: print(hdr); last = hdr
        print("%s %s: %s" % (uid, SPK.get(x["who"], x["who"]), esc(x["en"])))
        if x["file"] in ("script-ch20", "script-ch21", "script-ch22", "script-ch23", "script-poemresponses2", "script-exclusives2-natsuki", "script-exclusives2-yuri", "script-ch40") and len(x["en"]) > 20:
            best = None; br = 0.0
            for p in prev:
                sm = difflib.SequenceMatcher(None, x["en"], p["en"])
                if sm.real_quick_ratio() < 0.72 or sm.quick_ratio() < 0.72: continue
                r = sm.ratio()
                if r > br: br, best = r, p
            if best and br >= 0.78:
                print("      ≈%s (%.2f) en: %s\n      ru: %s" % (best["uid"], br, esc(best["en"]) if br < 0.999 else "(same text)", ru[best["uid"]]))

TAG = re.compile(r"\{[^{}]*\}")
VAR = re.compile(r"\[[^\[\]]*\]")
def norm_var(v): return re.sub(r"!t\]$", "]", v)

def check(n, quiet=False):
    u = units(); byid = {x["uid"]: x for x in u}; ch = chunks()[n - 1]
    path = os.path.join(RU, "c%03d.txt" % n)
    if not os.path.exists(path): print("missing file", path); return False
    seen = {}; ok = True
    for i, line in enumerate(open(path, encoding="utf-8"), 1):
        line = line.rstrip("\n")
        if not line.strip() or line.startswith("#"): continue
        m = re.match(r"^(u\d{5}) (.+)$", line)
        if not m: print("bad line %d: %r" % (i, line[:80])); ok = False; continue
        uid, t = m.groups()
        if uid in seen: print("dup", uid); ok = False
        seen[uid] = t
    for uid in ch:
        if uid not in seen: print("MISSING", uid, byid[uid]["en"][:70]); ok = False
    for uid in seen:
        if uid not in ch: print("EXTRA", uid); ok = False
    for uid, t in seen.items():
        if uid not in byid: continue
        en = esc(byid[uid]["en"])
        a = sorted(TAG.findall(en)); b = sorted(TAG.findall(t))
        if a != b: print("TAGS", uid, a, b); ok = False
        a = sorted(VAR.findall(en)); b = sorted(norm_var(v) for v in VAR.findall(t))
        if a != b: print("VARS", uid, a, b); ok = False
        if en.count("\\n") != t.count("\\n"): print("NEWLINES", uid)
        lat = re.findall(r"(?<![\[{\w])[A-Za-z]{2,}(?![\]\w])", TAG.sub("", VAR.sub("", t)))
        lat = [w for w in lat if w not in ("OK", "Doki", "DDLC", "Ren", "Py", "html", "http", "ddlc", "moe", "www", "warning")]
        if lat and not quiet: print("latin?", uid, lat[:5], t[:60])
        if '"' in t and not quiet: print("straight quote", uid, t[:80])
        if "--" in t and not quiet: print("double hyphen", uid, t[:80])
    if ok and not quiet: print("chunk %d OK (%d lines)" % (n, len(seen)))
    return ok

def status():
    ru = load_ru(); u = units(); ch = chunks()
    done = sum(1 for x in u if x["uid"] in ru)
    print("translated %d / %d units (%.1f%%)" % (done, len(u), 100.0 * done / len(u)))
    for i, c in enumerate(ch, 1):
        k = sum(1 for x in c if x in ru)
        if 0 < k < len(c) or k == 0:
            print("next chunk:", i, "(%d/%d)" % (k, len(c))); break

if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "plan": plan()
    elif cmd == "show": show(int(sys.argv[2]))
    elif cmd == "check": sys.exit(0 if check(int(sys.argv[2])) else 1)
    elif cmd == "status": status()
