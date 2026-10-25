#!/usr/bin/env python3
"""Kiln IDE Python checker.

Compiles Python sources in memory (no .pyc files are written) and prints one JSON object per line:
  * syntax errors, plus SyntaxWarnings such as invalid escape sequences,
  * top-level imports the selected interpreter cannot resolve (usually a missing dependency),
  * pyflakes diagnostics when pyflakes is installed in that interpreter.
The last line is a {"type": "summary", ...} record.

Usage: pycheck.py --root DIR [--no-imports] [--no-lint] [PATH ...]
"""
import argparse
import ast
import importlib.util
import json
import os
import sys
import warnings

EXCLUDE_DIRS = {
    ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "env", "__pycache__", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", ".tox", ".nox", "build", "dist", "site-packages", ".idea",
    ".vscode", ".eggs", "bin", "obj", "migrations_backup",
}
MAX_FILES = 8000
IMPORT_EXCEPTIONS = {"ImportError", "ModuleNotFoundError", "Exception", "BaseException"}
# Style-level pyflakes findings, shown greyed out like PyCharm's weak warnings.
WEAK_PYFLAKES = {"UnusedImport", "UnusedVariable", "UnusedAnnotation", "RedefinedWhileUnused", "ImportShadowedByLoopVar", "UnusedIndirectAssignment"}
STDLIB = set(getattr(sys, "stdlib_module_names", ())) | set(sys.builtin_module_names) | {"__future__", "__main__"}


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")


def iter_files(paths):
    for p in paths:
        if os.path.isfile(p):
            if p.endswith((".py", ".pyi")):
                yield os.path.abspath(p)
            continue
        for dirpath, dirnames, filenames in os.walk(p):
            dirnames[:] = sorted(
                d for d in dirnames
                if d not in EXCLUDE_DIRS
                and not d.startswith(".")
                and not d.endswith(".egg-info")
                and not os.path.exists(os.path.join(dirpath, d, "pyvenv.cfg"))
            )
            for f in sorted(filenames):
                if f.endswith(".py"):
                    yield os.path.join(dirpath, f)


def catches_import_error(handler):
    t = handler.type
    if t is None:
        return True
    names = t.elts if isinstance(t, ast.Tuple) else [t]
    for n in names:
        if isinstance(n, ast.Name) and n.id in IMPORT_EXCEPTIONS:
            return True
        if isinstance(n, ast.Attribute) and n.attr in IMPORT_EXCEPTIONS:
            return True
    return False


def is_guard_condition(test):
    """`if TYPE_CHECKING:`, `if sys.version_info >= ...:`, `if sys.platform == ...:` and friends."""
    for node in ast.walk(test):
        if isinstance(node, ast.Name) and node.id == "TYPE_CHECKING":
            return True
        if isinstance(node, ast.Attribute) and node.attr in ("TYPE_CHECKING", "version_info", "platform", "implementation", "name"):
            return True
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ("system", "python_version"):
            return True
    return False


def collect_imports(tree):
    found = []

    def visit(node, guarded):
        try_types = (ast.Try,) + ((ast.TryStar,) if hasattr(ast, "TryStar") else ())
        if isinstance(node, try_types):
            protected = guarded or any(catches_import_error(h) for h in node.handlers)
            for child in node.body:
                visit(child, protected)
            # A fallback import in `except ImportError:` only runs when the first one is missing.
            for h in node.handlers:
                for child in h.body:
                    visit(child, guarded or catches_import_error(h))
            for child in node.orelse + node.finalbody:
                visit(child, guarded)
            return
        if isinstance(node, ast.If) and is_guard_condition(node.test):
            for child in node.body + node.orelse:
                visit(child, True)
            return
        if isinstance(node, ast.Import) and not guarded:
            for alias in node.names:
                found.append((alias.name.split(".")[0], node))
        elif isinstance(node, ast.ImportFrom) and not guarded and node.level == 0 and node.module:
            found.append((node.module.split(".")[0], node))
        for child in ast.iter_child_nodes(node):
            visit(child, guarded)

    visit(tree, False)
    return found


class Resolver:
    def __init__(self, roots):
        self.roots = [r for r in roots if os.path.isdir(r)]
        self.cache = {}
        for r in self.roots:
            if r not in sys.path:
                sys.path.insert(0, r)

    def local(self, name, base):
        return os.path.exists(os.path.join(base, name + ".py")) or os.path.isdir(os.path.join(base, name))

    def resolvable(self, name, file_dir):
        if name in STDLIB:
            return True
        # The file's own folder and the folder above its top-level package act as import roots.
        top = file_dir
        while os.path.exists(os.path.join(top, "__init__.py")):
            parent = os.path.dirname(top)
            if parent == top:
                break
            top = parent
        if self.local(name, file_dir) or self.local(name, top):
            return True
        if name not in self.cache:
            ok = any(self.local(name, r) for r in self.roots)
            if not ok:
                try:
                    with warnings.catch_warnings():
                        warnings.simplefilter("ignore")
                        ok = importlib.util.find_spec(name) is not None
                except Exception:
                    ok = False
            self.cache[name] = ok
        return self.cache[name]


def load_pyflakes():
    try:
        from pyflakes import checker  # noqa: WPS433
        return checker
    except Exception:
        return None


def check_file(path, resolver, pyflakes, counts):
    try:
        with open(path, "rb") as fh:
            source = fh.read()
    except OSError as exc:
        emit({"type": "problem", "file": path, "line": 1, "col": 1, "severity": "error", "code": "IOError", "message": str(exc), "source": "python"})
        counts["errors"] += 1
        return
    seen = set()
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        try:
            tree = ast.parse(source, filename=path)
            compile(tree, path, "exec", dont_inherit=True)
        except SyntaxError as exc:
            emit({
                "type": "problem", "file": path,
                "line": exc.lineno or 1, "col": exc.offset or 1,
                "endLine": getattr(exc, "end_lineno", None), "endCol": getattr(exc, "end_offset", None),
                "severity": "error", "code": type(exc).__name__, "message": exc.msg, "source": "python",
            })
            counts["errors"] += 1
            return
        except ValueError as exc:
            emit({"type": "problem", "file": path, "line": 1, "col": 1, "severity": "error", "code": "ValueError", "message": str(exc), "source": "python"})
            counts["errors"] += 1
            return
    for w in caught:
        if not issubclass(w.category, (SyntaxWarning, DeprecationWarning)):
            continue
        key = (w.lineno, str(w.message))
        if key in seen:
            continue
        seen.add(key)
        emit({"type": "problem", "file": path, "line": w.lineno or 1, "col": 1, "severity": "warning", "code": w.category.__name__, "message": str(w.message), "source": "python"})
        counts["warnings"] += 1

    if resolver is not None:
        file_dir = os.path.dirname(path)
        reported = set()
        for name, node in collect_imports(tree):
            if name in reported or resolver.resolvable(name, file_dir):
                continue
            reported.add(name)
            emit({
                "type": "problem", "file": path, "line": node.lineno, "col": node.col_offset + 1,
                "endLine": getattr(node, "end_lineno", None), "endCol": (getattr(node, "end_col_offset", None) or 0) + 1,
                "severity": "warning", "code": "unresolved-import",
                "message": "Module '%s' is not installed in %s" % (name, sys.executable),
                "module": name, "source": "imports",
            })
            counts["warnings"] += 1

    if pyflakes is not None:
        try:
            w = pyflakes.Checker(tree, filename=path)
            for m in sorted(w.messages, key=lambda m: (m.lineno, getattr(m, "col", 0))):
                kind = type(m).__name__
                if kind == "ImportStarUsage":
                    continue
                severity = "info" if kind in WEAK_PYFLAKES else "warning"
                emit({
                    "type": "problem", "file": path, "line": m.lineno, "col": getattr(m, "col", 0) + 1,
                    "severity": severity, "code": kind, "message": m.message % m.message_args, "source": "pyflakes",
                })
                counts["warnings" if severity == "warning" else "infos"] += 1
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.getcwd())
    ap.add_argument("--no-imports", action="store_true")
    ap.add_argument("--no-lint", action="store_true")
    ap.add_argument("paths", nargs="*")
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    paths = [os.path.abspath(p) for p in (args.paths or [root])]
    resolver = None if args.no_imports else Resolver([root, os.path.join(root, "src")])
    pyflakes = None if args.no_lint else load_pyflakes()
    counts = {"files": 0, "errors": 0, "warnings": 0, "infos": 0}
    for f in iter_files(paths):
        if counts["files"] >= MAX_FILES:
            break
        counts["files"] += 1
        check_file(f, resolver, pyflakes, counts)
    emit({
        "type": "summary", "files": counts["files"], "errors": counts["errors"], "warnings": counts["warnings"], "infos": counts["infos"],
        "python": sys.version.split()[0], "executable": sys.executable, "pyflakes": pyflakes is not None,
        "truncated": counts["files"] >= MAX_FILES,
    })


if __name__ == "__main__":
    main()
