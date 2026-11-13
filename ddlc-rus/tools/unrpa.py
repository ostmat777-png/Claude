"""Safe RPA-3.0 extractor: the index pickle is loaded with a restricted
unpickler that refuses every class, so no code from the archive can run."""
import sys, os, zlib, pickle, io

class NoClasses(pickle.Unpickler):
    def find_class(self, module, name):
        raise pickle.UnpicklingError("refusing class %s.%s" % (module, name))

def main(rpa, out):
    with open(rpa, "rb") as f:
        header = f.readline().decode("ascii").split()
        assert header[0] == "RPA-3.0", header
        offset = int(header[1], 16); key = int(header[2], 16)
        f.seek(offset)
        index = NoClasses(io.BytesIO(zlib.decompress(f.read())), encoding="bytes").load()
        for name, entries in index.items():
            name = name.decode("utf-8") if isinstance(name, bytes) else name
            data = b""
            for e in entries:
                off, ln = e[0] ^ key, e[1] ^ key
                prefix = e[2] if len(e) > 2 else b""
                if isinstance(prefix, str): prefix = prefix.encode("latin1")
                f.seek(off)
                data += prefix + f.read(ln - len(prefix))
            dest = os.path.normpath(os.path.join(out, name))
            assert dest.startswith(os.path.abspath(out)), dest
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            open(dest, "wb").write(data)
            print(name, len(data))

main(sys.argv[1], os.path.abspath(sys.argv[2]))
