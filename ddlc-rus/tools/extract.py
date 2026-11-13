"""Extract all translate blocks: [{id, file, label, stmts:[{who, attrs, what, ...}]}] -> JSON."""
import sys, os, json
sys.path.insert(0, os.path.dirname(__file__))
import rpyc

def collect(nodes, fn, label, out):
    for n in nodes:
        nm = n._name
        if nm == "Label":
            if not n.hide: label = n.name
            collect(n.block, fn, label, out)
        elif nm == "Translate":
            stmts = []
            for s in n.block:
                if s._name == "Say":
                    stmts.append({"type": "say", "who": s.who, "attrs": list(s.attributes) if s.attributes else None,
                                  "what": s.what, "interact": s.interact, "with": s.with_,
                                  "temp": list(getattr(s, "temporary_attributes", None) or []) or None})
                elif s._name == "UserStatement":
                    stmts.append({"type": "user", "line": s.line})
                else:
                    stmts.append({"type": s._name})
            out.append({"id": n.identifier, "file": fn, "label": label, "stmts": stmts})
        else:
            for attr in ("block",):
                b = getattr(n, attr, None)
                if isinstance(b, list): collect(b, fn, label, out)
            if nm in ("If", "While") and nm == "If":
                for cond, blk in n.entries: collect(blk, fn, label, out)
            if nm == "Menu":
                for l, c, blk in n.items:
                    if blk: collect(blk, fn, label, out)
    return out

src = sys.argv[1]
allb = []
for fn in sorted(os.listdir(src)):
    if fn.endswith(".rpyc"):
        d, stmts = rpyc.load(os.path.join(src, fn))
        collect(stmts, fn[:-5], None, allb)
json.dump(allb, open(sys.argv[2], "w"), ensure_ascii=False, indent=0)
print(len(allb))
