"""Readable pseudo-source dump of DDLC .rpyc files (for translator context)."""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
import rpyc

def q(s):
    return '"' + str(s).replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n') + '"'

def pycode_src(c):
    if c is None: return ""
    st = getattr(c, "_state", None)
    if st: return st[1]
    return getattr(c, "source", repr(c))

def imspec(im):
    name, expr, tag, at, layer, zorder, behind = im[:7]
    s = " ".join(name) if name else "expression " + str(expr)
    if tag: s += " as " + tag
    if at: s += " at " + ", ".join(at)
    if layer: s += " onlayer " + layer
    if zorder: s += " zorder " + str(zorder)
    if behind: s += " behind " + ", ".join(behind)
    return s

def say(n):
    parts = []
    if n.who: parts.append(n.who)
    if getattr(n, "attributes", None): parts.extend(n.attributes)
    parts.append(q(n.what))
    if not getattr(n, "interact", True): parts.append("nointeract")
    if getattr(n, "with_", None): parts.append("with " + n.with_)
    return " ".join(parts)

def sl(node, ind, out):
    nm = node._name
    p = "    " * ind
    if nm == "SLScreen":
        out.append(p + "screen %s(%s):" % (node.name, getattr(node, "parameters", "")))
        for c in node.children: sl(c, ind + 1, out)
    elif nm == "SLDisplayable":
        disp = getattr(node, "displayable", None)
        dname = getattr(disp, "_name", None) or str(disp)
        st = getattr(node, "style", None)
        args = " ".join(str(a) for a in (node.positional or []))
        kw = " ".join("%s %s" % (k, v) for k, v in (node.keyword or []))
        out.append(p + "%s[%s] %s %s" % (dname, st, args, kw))
        for c in node.children: sl(c, ind + 1, out)
    elif nm == "SLIf" or nm == "SLShowIf":
        for cond, blk in node.entries:
            out.append(p + ("if %s:" % cond if cond else "else:"))
            sl(blk, ind + 1, out)
    elif nm == "SLBlock":
        kw = " ".join("%s %s" % (k, v) for k, v in (node.keyword or []))
        if kw: out.append(p + kw)
        for c in node.children: sl(c, ind, out)
    elif nm == "SLFor":
        out.append(p + "for %s in %s:" % (node.variable, node.expression))
        for c in node.children: sl(c, ind + 1, out)
    elif nm == "SLPython":
        out.append(p + "$ " + pycode_src(node.code).strip())
    elif nm == "SLDefault":
        out.append(p + "default %s = %s" % (node.variable, node.expression))
    elif nm == "SLUse":
        a = getattr(node, "args", None)
        a = getattr(a, "arguments", a)
        out.append(p + "use %s %s" % (node.target, a))
        if getattr(node, "block", None): sl(node.block, ind + 1, out)
    else:
        out.append(p + "<%s %s>" % (nm, {k: v for k, v in node.__dict__.items() if k not in ("children",)}))
        for c in getattr(node, "children", []) or []: sl(c, ind + 1, out)

def walk(nodes, ind, out):
    for n in nodes:
        nm = n._name
        p = "    " * ind
        if nm == "Translate":
            out.append(p + "# tl " + n.identifier)
            walk(n.block, ind, out)
        elif nm == "EndTranslate":
            pass
        elif nm == "Say":
            out.append(p + say(n))
        elif nm == "Label":
            out.append(p + "label %s%s:" % (n.name, "(%s)" % n.parameters if n.parameters else ""))
            walk(n.block, ind + 1, out)
        elif nm == "Init":
            out.append(p + "init %s:" % n.priority)
            walk(n.block, ind + 1, out)
        elif nm in ("Python", "EarlyPython"):
            src = pycode_src(n.code)
            if "\n" in src.strip():
                out.append(p + "python:")
                for l in src.strip("\n").split("\n"): out.append(p + "    " + l)
            else:
                out.append(p + "$ " + src.strip())
        elif nm == "Show": out.append(p + "show " + imspec(n.imspec))
        elif nm == "Scene": out.append(p + "scene " + (imspec(n.imspec) if n.imspec else ""))
        elif nm == "Hide": out.append(p + "hide " + imspec(n.imspec))
        elif nm == "With": out.append(p + "with " + str(n.expr))
        elif nm == "Jump": out.append(p + "jump " + str(n.target))
        elif nm == "Call": out.append(p + "call " + str(n.label) + (" " + str(n.arguments._state if hasattr(n.arguments, '_state') else '') if n.arguments else ""))
        elif nm == "Return": out.append(p + "return" + (" " + n.expression if n.expression else ""))
        elif nm == "Pass": out.append(p + "pass")
        elif nm == "UserStatement": out.append(p + n.line)
        elif nm == "If":
            for i, (cond, blk) in enumerate(n.entries):
                kw = "if" if i == 0 else ("elif" if cond != "True" else "else")
                out.append(p + ("%s %s:" % (kw, cond) if kw != "else" else "else:"))
                walk(blk, ind + 1, out)
        elif nm == "While":
            out.append(p + "while %s:" % n.condition)
            walk(n.block, ind + 1, out)
        elif nm == "Menu":
            out.append(p + "menu:")
            for label, cond, blk in n.items:
                if blk is None:
                    out.append(p + "    " + q(label))
                else:
                    out.append(p + "    " + q(label) + ("" if cond == "True" else " if " + cond) + ":")
                    walk(blk, ind + 2, out)
        elif nm == "Define": out.append(p + "define %s = %s" % (n.varname, pycode_src(n.code).strip()))
        elif nm == "Default": out.append(p + "default %s = %s" % (n.varname, pycode_src(n.code).strip()))
        elif nm == "Image":
            out.append(p + "image %s = %s" % (" ".join(n.imgname), pycode_src(n.code).strip() if n.code else "<atl>"))
        elif nm == "Transform": out.append(p + "transform %s:" % n.varname + " <atl>")
        elif nm == "Screen":
            sl(n.screen, ind, out)
        elif nm == "Style":
            props = " ".join("%s %s" % (k, v) for k, v in (n.properties or {}).items())
            out.append(p + "style %s%s %s" % (n.style_name, (" is " + n.parent) if n.parent else "", props))
        else:
            out.append(p + "<%s>" % nm)
    return out

if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    os.makedirs(dst, exist_ok=True)
    for fn in sorted(os.listdir(src)):
        if not fn.endswith(".rpyc"): continue
        d, stmts = rpyc.load(os.path.join(src, fn))
        out = walk(stmts, 0, [])
        open(os.path.join(dst, fn[:-1].replace(".rpy", ".txt")), "w").write("\n".join(out) + "\n")
        print(fn, len(out))
