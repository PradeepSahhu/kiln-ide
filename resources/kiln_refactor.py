"""Python refactorings for Kiln IDE, computed with rope.

Reads one JSON request on stdin and prints the result as JSON. The project's files are never
written: every change is returned as the file's new text. A module that Move needs as its
destination is created empty for rope to see, reported with "created": true, and removed again.

Request: {"op", "root", "file", "start", "end", "name"?, "dest"?}; start/end are UTF-16 offsets
(the editor's), like the "select" range in the reply.
"""
import json
import os
import re
import sys

IGNORED = ["*.pyc", "*~", ".ropeproject", ".hg", ".svn", "_svn", ".git", ".tox", ".venv", "venv", "env",
           ".mypy_cache", ".pytest_cache", "__pycache__", "node_modules", "build", "dist", ".eggs", "*.egg-info"]


def from_utf16(text, offset):
    """UTF-16 offset (JavaScript) -> index into a Python str."""
    units = 0
    for i, ch in enumerate(text):
        if units >= offset:
            return i
        units += 2 if ord(ch) > 0xFFFF else 1
    return len(text)


def to_utf16(text, index):
    return index + sum(1 for ch in text[:index] if ord(ch) > 0xFFFF)


IMPORT_THEN_CODE = re.compile(r"^((?:from|import) [^\n]+)\n(?=(?:def|class|async def|@)\b)", re.M)


def tidy(text):
    """rope can leave a new import glued to the next definition; PEP 8 wants two blank lines."""
    return IMPORT_THEN_CODE.sub(r"\1\n\n\n", text)


def walk(changes):
    yield changes
    for c in getattr(changes, "changes", None) or []:
        yield from walk(c)


def collect(changes, created):
    files = {}
    moves = []
    deletes = []
    for c in walk(changes):
        kind = type(c).__name__
        res = getattr(c, "resource", None)
        if res is None:
            continue
        path = res.real_path
        if kind == "ChangeContents":
            entry = files.get(path)
            if entry is None:
                before = "" if path in created else (open(path, encoding="utf-8").read() if os.path.exists(path) else "")
                entry = files[path] = {"path": path, "before": before, "after": before, "created": path in created}
            entry["after"] = tidy(c.new_contents) if c.new_contents is not None else entry["after"]
        elif kind == "MoveResource":
            moves.append({"from": path, "to": c.new_resource.real_path})
        elif kind in ("CreateFile", "CreateResource") and path not in files:
            files[path] = {"path": path, "before": "", "after": "", "created": True}
        elif kind == "RemoveResource":
            deletes.append(path)
    out = [f for f in files.values() if f["before"] != f["after"] or f["created"]]
    return {"files": out, "moves": moves, "deletes": deletes}


def select_name(result, file, text, start, name):
    """Range of the new name near where the refactoring happened, for the editor to select."""
    entry = next((f for f in result["files"] if f["path"] == file), None)
    if not entry or not name:
        return None
    after = entry["after"]
    line_start = text.rfind("\n", 0, start) + 1
    m = re.compile(r"(?<![\w])" + re.escape(name) + r"(?![\w])").search(after, line_start)
    if not m:
        return None
    return {"file": file, "start": to_utf16(after, m.start()), "end": to_utf16(after, m.end())}


def run(req):
    from rope.base import libutils
    from rope.base.project import Project

    root = req["root"]
    project = Project(root, ropefolder=None, prefer_module_from_imports=True, ignored_resources=IGNORED)
    created = []
    try:
        file = req["file"]
        resource = libutils.path_to_resource(project, file)
        text = resource.read()
        start = from_utf16(text, int(req.get("start", 0)))
        end = from_utf16(text, int(req.get("end", req.get("start", 0))))
        op = req["op"]
        name = req.get("name")
        if op == "extract_method":
            from rope.refactor.extract import ExtractMethod
            changes = ExtractMethod(project, resource, start, end).get_changes(name, similar=bool(req.get("similar")))
        elif op == "extract_variable":
            from rope.refactor.extract import ExtractVariable
            changes = ExtractVariable(project, resource, start, end).get_changes(name, similar=bool(req.get("similar")))
        elif op == "inline":
            from rope.refactor.inline import create_inline
            changes = create_inline(project, resource, start).get_changes()
        elif op == "introduce_field":
            from rope.refactor.localtofield import LocalToField
            changes = LocalToField(project, resource, start).get_changes()
        elif op == "introduce_parameter":
            from rope.refactor.introduce_parameter import IntroduceParameter
            changes = IntroduceParameter(project, resource, start).get_changes(name)
        elif op == "move":
            from rope.refactor.move import create_move
            dest = req["dest"]
            if not os.path.exists(dest):
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                open(dest, "w").close()
                created.append(dest)
                project.validate()
            changes = create_move(project, resource, start).get_changes(libutils.path_to_resource(project, dest))
        else:
            raise ValueError("Unknown refactoring: %s" % op)
        result = collect(changes, created)
        result["select"] = select_name(result, file, text, start, name) if op in ("extract_method", "extract_variable") else None
        return result
    finally:
        for path in created:
            try:
                if os.path.exists(path) and os.path.getsize(path) == 0:
                    os.remove(path)
            except OSError:
                pass
        project.close()


def main():
    req = json.loads(sys.stdin.read())
    try:
        result = run(req)
    except Exception as e:  # rope.base.exceptions.RefactoringError and friends
        result = {"error": str(e) or type(e).__name__, "type": type(e).__name__}
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
