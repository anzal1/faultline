# Independent oracle: Python's own parser (ast) and import machinery (PathFinder), no code executed.
import ast, os, sys, json
from importlib.machinery import PathFinder
root, srcroot = sys.argv[1], sys.argv[2]
def find(modname):
    parts = modname.split("."); path = [os.path.join(root, srcroot)]; spec = None
    for i in range(len(parts)):
        spec = PathFinder.find_spec(parts[i], path)
        if spec is None: return None
        path = spec.submodule_search_locations or []
    return spec.origin if spec and spec.origin and spec.origin.endswith(".py") else None
edges = set()
base = os.path.join(root, srcroot)
for dp, dn, fn in os.walk(base):
    dn[:] = [d for d in dn if d not in ("__pycache__", "tests", "test")]
    for f in fn:
        if not f.endswith(".py"): continue
        full = os.path.join(dp, f); rel = os.path.relpath(full, root)
        pkg = os.path.relpath(dp, base).replace(os.sep, ".")
        if f != "__init__.py": modpkg = pkg
        else: modpkg = pkg
        tree = ast.parse(open(full, encoding="utf8").read())
        for node in ast.walk(tree):
            targets = []
            if isinstance(node, ast.Import):
                for a in node.names: targets.append((a.name, []))
            elif isinstance(node, ast.ImportFrom):
                if node.level:
                    pp = modpkg.split(".")
                    pp = pp[: len(pp) - (node.level - 1)] if node.level > 1 else pp
                    mod = ".".join([p for p in pp if p != "."] + ([node.module] if node.module else []))
                else: mod = node.module
                targets.append((mod, [a.name for a in node.names]))
            for mod, names in targets:
                hits = []
                for n in names:
                    if n != "*":
                        s = find(f"{mod}.{n}")
                        if s: hits.append(s)
                if len(hits) < len([n for n in names if n != "*"]) or not names:
                    parts = mod.split(".")
                    for k in range(len(parts), 0, -1):
                        s = find(".".join(parts[:k]))
                        if s: hits.append(s); break
                for h in hits:
                    t = os.path.relpath(h, root)
                    if t != rel: edges.add((rel, t))
print(json.dumps(sorted(edges)))
