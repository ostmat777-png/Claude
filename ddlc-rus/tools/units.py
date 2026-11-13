"""Build ordered unique translation units from blocks.json.
unit key = (gender, english text); gender: 'M' (mc/narrator), 'F' (single girl), 'P' (ny = plural)."""
import json, sys, os, collections
SP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.environ.get("DDLC_WORK", os.path.join(SP, "src"))
ORDER = ["splash", "script", "script-ch0", "script-ch1", "script-poemresponses", "script-exclusives-sayori",
         "script-exclusives-natsuki", "script-exclusives-yuri", "script-ch2", "script-ch3", "script-ch4", "script-ch5",
         "script-ch10", "script-ch20", "script-ch21", "script-ch22", "script-ch23", "script-poemresponses2",
         "script-exclusives2-natsuki", "script-exclusives2-yuri", "script-ch30", "script-ch40"]

def gender(who):
    if who in (None, "mc"): return "M"
    if who == "ny": return "P"
    return "F"

def main():
    blocks = json.load(open(os.path.join(WORK, "blocks.json")))
    files = collections.OrderedDict()
    for b in blocks: files.setdefault(b["file"], []).append(b)
    assert set(files) <= set(ORDER), set(files) - set(ORDER)
    units = collections.OrderedDict()   # key -> unit
    seq = []
    for fn in ORDER:
        for b in files.get(fn, []):
            assert len(b["stmts"]) == 1
            s = b["stmts"][0]
            key = gender(s["who"]) + "\t" + s["what"]
            if key not in units:
                uid = "u%05d" % (len(units) + 1)
                units[key] = {"uid": uid, "g": key[0], "en": s["what"], "who": s["who"], "file": fn, "label": b["label"], "ids": []}
            units[key]["ids"].append(b["id"])
    out = list(units.values())
    json.dump(out, open(os.path.join(WORK, "units.json"), "w"), ensure_ascii=False, indent=0)
    words = sum(len(u["en"].split()) for u in out)
    print("units", len(out), "words", words)

main()
