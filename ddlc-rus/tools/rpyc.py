"""Safe .rpyc loader: every class referenced by the pickle is replaced by an
inert stub (no Ren'Py or game code runs). Returns stub AST objects."""
import pickle, zlib, struct, io, copyreg

class Stub:
    _module = None; _name = None
    def __init__(self, *a, **k):
        self._args = a
    def __setstate__(self, state):
        if isinstance(state, tuple) and len(state) == 2:
            d, slots = state
            if d: self.__dict__.update(d)
            if slots: self.__dict__.update(slots)
        elif isinstance(state, dict):
            self.__dict__.update(state)
        else:
            self._state = state
    def __repr__(self):
        return "<%s>" % self._name

class StrStub(str):
    _module = None; _name = None
    def __new__(cls, *a):
        s = a[0] if a else ""
        if isinstance(s, bytes): s = s.decode("utf-8")
        o = str.__new__(cls, s)
        o._args = a[1:]
        return o
    def __setstate__(self, state):
        if isinstance(state, dict): self.__dict__.update(state)

class ListStub(list):
    _module = None; _name = None
    def __setstate__(self, state):
        if isinstance(state, dict): self.__dict__.update(state)

class DictStub(dict):
    _module = None; _name = None
    def __setstate__(self, state):
        if isinstance(state, dict): self.__dict__.update(state)

_cache = {}
STR_TYPES = {("renpy.ast", "PyExpr")}
LIST_TYPES = {("renpy.python", "RevertableList"), ("renpy.revertable", "RevertableList")}
DICT_TYPES = {("renpy.python", "RevertableDict"), ("renpy.revertable", "RevertableDict")}

def stub_for(module, name):
    k = (module, name)
    if k not in _cache:
        base = StrStub if k in STR_TYPES else ListStub if k in LIST_TYPES else DictStub if k in DICT_TYPES else Stub
        _cache[k] = type(name, (base,), {"_module": module, "_name": name})
    return _cache[k]

def _reconstructor(cls, base, state):
    if issubclass(cls, str):
        return cls.__new__(cls, state if state is not None else "")
    return cls.__new__(cls)

SAFE_BUILTINS = {"set": set, "frozenset": frozenset, "unicode": str, "str": str,
                 "list": list, "dict": dict, "tuple": tuple, "object": object, "int": int, "long": int, "float": float, "bool": bool}

class SafeUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        if module in ("__builtin__", "builtins") and name in SAFE_BUILTINS:
            return SAFE_BUILTINS[name]
        if module in ("copy_reg", "copyreg") and name == "_reconstructor":
            return _reconstructor
        if module == "collections" and name == "OrderedDict":
            import collections; return collections.OrderedDict
        return stub_for(module, name)

def load(path, slot=2):
    data = open(path, "rb").read()
    assert data[:10] == b"RENPY RPC2", path
    pos = 10; chunks = {}
    while True:
        cslot, start, length = struct.unpack("III", data[pos:pos+12]); pos += 12
        if cslot == 0: break
        chunks[cslot] = data[start:start+length]
    raw = zlib.decompress(chunks[slot] if slot in chunks else chunks[1])
    return SafeUnpickler(io.BytesIO(raw), encoding="utf-8", errors="surrogateescape").load()
