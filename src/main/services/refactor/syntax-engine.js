'use strict';
// Refactorings computed from the syntax tree (tree-sitter) and the project's code index, for C#,
// Python and JavaScript/TypeScript: Safe Delete, Change Signature, Pull Members Up and Introduce
// Constant, plus what C# needs when csharp-ls is not installed (Introduce Variable, Inline Variable,
// Move Type to File). Like the other engines nothing is written: every operation returns the new text
// of the files it changes: { files: [{ path, before, after, created }], warnings, ... }.
//
// Runs inside the code index worker, which supplies `deps`: langOf(file), parsers(), isIdent(type),
// read(file) (the editor's text for the file being refactored), exists(file), defs(name) and
// refs(name) from the index (absolute paths, 1-based line/col).
const path = require('path');

const FAMILY = { csharp: 'cs', python: 'py', javascript: 'js', typescript: 'js', tsx: 'js' };
const NULL = { cs: 'default', py: 'None', js: 'undefined' };

class RefactorError extends Error {}
function fail(message) {
  throw new RefactorError(message);
}

// ------------------------------------------------------------------ text

const lineStartAt = (text, off) => text.lastIndexOf('\n', off - 1) + 1;
function lineEndAt(text, off) {
  const i = text.indexOf('\n', off);
  return i < 0 ? text.length : i + 1;
}
const indentAt = (text, off) => /^[ \t]*/.exec(text.slice(lineStartAt(text, off)))[0];
const isBlankLine = (s) => /^[ \t]*\r?$/.test(s);

function offsetOf(text, line, col) {
  let off = 0;
  for (let l = 1; l < line; l++) {
    const i = text.indexOf('\n', off);
    if (i < 0) return text.length;
    off = i + 1;
  }
  return off + Math.max(0, col - 1);
}

function lineOf(text, off) {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < off; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

function applyEdits(text, edits) {
  const sorted = edits.map((e, i) => ({ e, i })).sort((a, b) => b.e.start - a.e.start || b.e.end - a.e.end || b.i - a.i);
  let out = text;
  let floor = Infinity;
  for (const { e } of sorted) {
    if (e.end > floor) fail('Internal error: overlapping edits.');
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    floor = e.start;
  }
  return out;
}

function reindent(block, from, to) {
  return block
    .split('\n')
    .map((line) => (line.startsWith(from) ? to + line.slice(from.length) : line))
    .join('\n');
}

/** One indentation step, guessed from the file (falls back to four spaces). */
function indentUnit(text) {
  const m = /\n([ \t]+)\S/.exec(text);
  if (m && m[1].startsWith('\t')) return '\t';
  const sizes = new Map();
  for (const x of text.matchAll(/\n( +)\S/g)) sizes.set(x[1].length, (sizes.get(x[1].length) || 0) + 1);
  const smallest = [...sizes.keys()].filter((n) => n >= 2).sort((a, b) => a - b)[0];
  return ' '.repeat(smallest && smallest <= 8 ? smallest : 4);
}

/**
 * Remove whole lines [start, end) and keep the blank lines around them tidy: a member removed from the
 * middle of a body leaves one gap, not two; one removed from the start or end of a body leaves none.
 */
function removalEdit(text, start, end) {
  let before = 0;
  let p = start;
  while (p > 0) {
    const ls = lineStartAt(text, p - 1);
    if (!isBlankLine(text.slice(ls, p - 1))) break;
    before++;
    p = ls;
  }
  const after = [];
  let q = end;
  while (q < text.length) {
    const le = lineEndAt(text, q);
    if (!isBlankLine(text.slice(q, le).replace(/\n$/, ''))) break;
    q = le;
    after.push(q);
  }
  const block = indentAt(text, start).length;
  const prevLine = p > 0 ? text.slice(lineStartAt(text, p - 1), p - 1) : '';
  const nextLine = q < text.length ? text.slice(q, lineEndAt(text, q)) : '';
  const prevIndent = /^[ \t]*/.exec(prevLine)[0].length;
  const nextIndent = /^[ \t]*/.exec(nextLine)[0].length;
  const first = p === 0 ? false : prevIndent < block || /[{([]\s*$/.test(prevLine);
  const last = q >= text.length || nextIndent < block || /^\s*[}\])]/.test(nextLine);
  if (first) return { start, end: after.length ? after[after.length - 1] : end, text: '' };
  if (last) return { start: p, end, text: '' };
  const n = Math.min(before, after.length);
  return { start, end: n ? after[n - 1] : end, text: '' };
}

// ----------------------------------------------------------------- nodes

const field = (n, f) => (n ? n.childForFieldName(f) : null);
const isNamed = (c) => (typeof c.isNamed === 'function' ? c.isNamed() : c.isNamed);
function named(n) {
  const out = [];
  if (!n) return out;
  for (let i = 0; i < n.namedChildCount; i++) out.push(n.namedChild(i));
  return out;
}
function children(n) {
  const out = [];
  for (let i = 0; i < n.childCount; i++) out.push(n.child(i));
  return out;
}
function* walk(node) {
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    yield n;
    for (let i = n.childCount - 1; i >= 0; i--) stack.push(n.child(i));
  }
}
function ancestor(n, test) {
  for (let a = n; a; a = a.parent) if (test(a)) return a;
  return null;
}
const sameNode = (a, b) => !!a && !!b && a.id === b.id;

const CS_TYPES = new Set(['class_declaration', 'interface_declaration', 'struct_declaration', 'record_declaration', 'record_struct_declaration', 'enum_declaration']);
const CS_NAMED_DECL = new Set([...CS_TYPES, 'delegate_declaration', 'method_declaration', 'local_function_statement', 'constructor_declaration', 'destructor_declaration', 'property_declaration', 'indexer_declaration', 'event_declaration', 'enum_member_declaration']);
const JS_CLASSES = new Set(['class_declaration', 'abstract_class_declaration', 'class']);
const JS_NAMED_DECL = new Set([...JS_CLASSES, 'interface_declaration', 'type_alias_declaration', 'enum_declaration', 'function_declaration', 'generator_function_declaration', 'method_definition', 'method_signature', 'abstract_method_signature', 'function_signature', 'public_field_definition', 'field_definition', 'property_signature']);
const CALLABLE = {
  cs: new Set(['method_declaration', 'local_function_statement', 'constructor_declaration', 'delegate_declaration']),
  py: new Set(['function_definition']),
  js: new Set(['function_declaration', 'generator_function_declaration', 'method_definition', 'method_signature', 'abstract_method_signature', 'function_signature', 'function_expression', 'arrow_function', 'function', 'generator_function']),
};
const CALL_TYPES = { cs: new Set(['invocation_expression']), py: new Set(['call']), js: new Set(['call_expression']) };
const NEW_TYPES = { cs: new Set(['object_creation_expression']), py: new Set(), js: new Set(['new_expression']) };

/** The declaration an identifier names (it is the declaration's name), or null for a reference. */
function declOf(fam, ident) {
  const p = ident.parent;
  if (!p) return null;
  const isName = (n, f = 'name') => sameNode(field(n, f), ident);
  if (fam === 'cs') {
    if (CS_NAMED_DECL.has(p.type) && isName(p)) return p;
    if ((p.type === 'variable_declarator' || p.type === 'parameter') && isName(p)) return p;
    if (p.type === 'parameter_list' && sameNode(field(p, 'name'), ident)) return ident;
    return null;
  }
  if (fam === 'py') {
    if ((p.type === 'function_definition' || p.type === 'class_definition') && isName(p)) return p;
    if (p.type === 'assignment' && isName(p, 'left') && p.parent && p.parent.type === 'expression_statement') return p.parent;
    if (p.type === 'parameters') return ident;
    if ((p.type === 'default_parameter' || p.type === 'typed_default_parameter') && isName(p)) return p;
    if (p.type === 'typed_parameter' && sameNode(named(p)[0], ident)) return p;
    if ((p.type === 'list_splat_pattern' || p.type === 'dictionary_splat_pattern') && p.parent && p.parent.type === 'parameters') return p;
    return null;
  }
  if (JS_NAMED_DECL.has(p.type) && (isName(p) || isName(p, 'property'))) return p;
  if (p.type === 'variable_declarator' && isName(p)) return p;
  if ((p.type === 'required_parameter' || p.type === 'optional_parameter') && isName(p, 'pattern')) return p;
  if (p.type === 'formal_parameters') return ident;
  if (p.type === 'assignment_pattern' && isName(p, 'left') && p.parent && p.parent.type === 'formal_parameters') return p;
  if (p.type === 'rest_pattern' && p.parent && (p.parent.type === 'formal_parameters' || p.parent.type === 'required_parameter')) return p.parent.type === 'required_parameter' ? p.parent : p;
  return null;
}

function nameNodeOf(fam, decl) {
  if (!decl) return null;
  if (fam === 'py' && decl.type === 'expression_statement') return field(named(decl)[0], 'left');
  if (fam === 'py' && decl.type === 'typed_parameter') return named(decl)[0];
  if (fam === 'py' && (decl.type === 'list_splat_pattern' || decl.type === 'dictionary_splat_pattern')) return named(decl)[0];
  if (fam === 'js' && (decl.type === 'required_parameter' || decl.type === 'optional_parameter')) {
    const pat = field(decl, 'pattern');
    return pat && pat.type === 'rest_pattern' ? named(pat)[0] : pat;
  }
  if (fam === 'js' && decl.type === 'assignment_pattern') return field(decl, 'left');
  if (fam === 'js' && decl.type === 'rest_pattern') return named(decl)[0];
  if (decl.type === 'identifier') return decl;
  return field(decl, 'name') || field(decl, 'property');
}

/** The node removed with a declaration: C# fields / locals, JS `export`, Python decorators, ... */
function removableOf(fam, decl) {
  let n = decl;
  if (fam === 'cs' && n.type === 'variable_declarator') {
    const vd = n.parent;
    if (vd && named(vd).filter((c) => c.type === 'variable_declarator').length === 1 && vd.parent && /field_declaration|local_declaration_statement|event_field_declaration/.test(vd.parent.type)) n = vd.parent;
  }
  if (fam === 'js' && n.type === 'variable_declarator') {
    const d = n.parent;
    if (d && /lexical_declaration|variable_declaration/.test(d.type) && named(d).filter((c) => c.type === 'variable_declarator').length === 1) n = d;
  }
  if (fam === 'py' && n.parent && n.parent.type === 'decorated_definition') n = n.parent;
  if (fam === 'js' && n.parent && n.parent.type === 'export_statement') n = n.parent;
  return n;
}

const isDocComment = (fam, t) => (fam === 'cs' ? /^\/\/\/|^\/\*\*/.test(t) : fam === 'js' ? /^\/\*\*/.test(t) : false);

/** Whole lines of a declaration with its doc comment, attributes or decorators. */
function declRange(fam, text, node) {
  let start = node.startIndex;
  const end = node.endIndex;
  for (let prev = node.previousNamedSibling; prev && prev.type === 'comment' && isDocComment(fam, prev.text) && /^[ \t]*\r?\n[ \t]*$/.test(text.slice(prev.endIndex, start)); prev = prev.previousNamedSibling) start = prev.startIndex;
  const ls = lineStartAt(text, start);
  if (/^[ \t]*$/.test(text.slice(ls, start))) start = ls;
  const le = lineEndAt(text, end);
  return { start, end: /^[ \t]*\r?\n?$/.test(text.slice(end, le)) ? le : end };
}

function classOf(fam, node) {
  return ancestor(node, (a) => (fam === 'cs' ? CS_TYPES.has(a.type) && a.type !== 'enum_declaration' : fam === 'py' ? a.type === 'class_definition' : JS_CLASSES.has(a.type) || a.type === 'interface_declaration'));
}
const isInterface = (node) => node.type === 'interface_declaration';
const bodyOf = (node) => field(node, 'body');

// ----------------------------------------------------------------- session

function session(deps, params) {
  const trees = [];
  const texts = new Map();
  if (params.file && params.text != null) texts.set(params.file, params.text);
  const s = {
    deps,
    text(file) {
      if (!texts.has(file)) texts.set(file, deps.read(file));
      return texts.get(file);
    },
    lang(file) {
      const lang = deps.langOf(file);
      if (!FAMILY[lang]) fail(`Refactoring is not available for ${path.extname(file) || 'this file type'}.`);
      return lang;
    },
    fam: (file) => FAMILY[s.lang(file)],
    parse(file, text) {
      const t = deps.parsers()[s.lang(file)].parse(text != null ? text : s.text(file));
      trees.push(t);
      return t;
    },
    done() {
      for (const t of trees) {
        try {
          t.delete();
        } catch {
          /* already freed */
        }
      }
    },
  };
  return s;
}

function identAt(s, tree, off) {
  for (const o of [off, off - 1]) {
    if (o < 0) continue;
    const n = tree.rootNode.descendantForIndex(o, o);
    if (n && s.deps.isIdent(n.type)) return n;
  }
  return null;
}

/** The declaration of the symbol at the caret (following a reference through the index). */
function targetAt(s, file, start, { want } = {}) {
  const fam = s.fam(file);
  const text = s.text(file);
  const tree = s.parse(file, text);
  const ident = identAt(s, tree, start);
  if (!ident) fail('Put the caret on a name.');
  const own = declOf(fam, ident);
  if (own && (!want || want(fam, own))) return { file, text, tree, fam, decl: own, name: ident.text };
  if (fam === 'cs' || fam === 'js') {
    // a local variable or parameter used in the same function
    const local = localDeclaration(fam, ident);
    if (local && (!want || want(fam, local))) return { file, text, tree, fam, decl: local, name: ident.text };
  }
  const defs = s.deps.defs(ident.text).slice().sort((a, b) => (b.file === file) - (a.file === file));
  for (const d of defs) {
    const dl = s.deps.langOf(d.file);
    if (!FAMILY[dl]) continue;
    const dtext = s.text(d.file);
    const dtree = d.file === file ? tree : s.parse(d.file, dtext);
    const id = identAt(s, dtree, offsetOf(dtext, d.line, d.col));
    const dd = id && declOf(FAMILY[dl], id);
    if (dd && (!want || want(FAMILY[dl], dd))) return { file: d.file, text: dtext, tree: dtree, fam: FAMILY[dl], decl: dd, name: ident.text };
  }
  if (fam === 'py') {
    const local = localDeclaration(fam, ident);
    if (local && (!want || want(fam, local))) return { file, text, tree, fam, decl: local, name: ident.text };
  }
  fail(`Cannot find the declaration of '${ident.text}'.`);
}

const FUNCTION_SCOPES = {
  cs: new Set(['method_declaration', 'local_function_statement', 'constructor_declaration', 'lambda_expression', 'anonymous_method_expression', 'accessor_declaration', 'operator_declaration']),
  py: new Set(['function_definition', 'lambda']),
  js: new Set(['function_declaration', 'generator_function_declaration', 'method_definition', 'function_expression', 'arrow_function', 'function', 'generator_function']),
};

/** For a name used inside a function: its local declaration or parameter there (nearest before it). */
function localDeclaration(fam, ident) {
  const fn = ancestor(ident.parent, (a) => FUNCTION_SCOPES[fam].has(a.type));
  if (!fn) return null;
  let best = null;
  let bestAt = -1;
  for (const n of walk(fn)) {
    if (n.startIndex > ident.startIndex) continue;
    if (n.type !== 'identifier' || n.text !== ident.text) continue;
    const d = declOf(fam, n);
    if (!d) continue;
    if (fam === 'py' && d.type === 'expression_statement' && !sameNode(ancestor(d, (a) => FUNCTION_SCOPES.py.has(a.type)), fn)) continue;
    if (n.startIndex > bestAt) {
      best = d;
      bestAt = n.startIndex;
    }
  }
  return best;
}

// ---------------------------------------------------------- Safe Delete

const lineText = (text, off) => text.slice(lineStartAt(text, off), lineEndAt(text, off)).trim();
function isMemberName(fam, n) {
  const p = n.parent;
  if (!p) return false;
  if (fam === 'cs') return p.type === 'member_access_expression' && sameNode(field(p, 'name'), n);
  if (fam === 'py') return p.type === 'attribute' && sameNode(field(p, 'attribute'), n);
  return false;
}
function isArgLabel(fam, n) {
  const p = n.parent;
  if (!p) return false;
  if (fam === 'cs') return p.type === 'argument' && sameNode(field(p, 'name'), n);
  if (fam === 'py') return p.type === 'keyword_argument' && sameNode(field(p, 'name'), n);
  return false;
}
function isParam(fam, decl) {
  if (fam === 'cs') return decl.type === 'parameter' || (decl.type === 'identifier' && !!decl.parent && decl.parent.type === 'parameter_list');
  if (fam === 'py') return !!(decl.parent && decl.parent.type === 'parameters') || /parameter|splat_pattern/.test(decl.type);
  return decl.type === 'required_parameter' || decl.type === 'optional_parameter' || decl.type === 'assignment_pattern' || decl.type === 'rest_pattern' || !!(decl.parent && decl.parent.type === 'formal_parameters');
}
function isLocalDecl(fam, decl) {
  if (isParam(fam, decl)) return true;
  if (fam === 'cs') return decl.type === 'variable_declarator' && !!ancestor(decl, (a) => a.type === 'local_declaration_statement');
  if (fam === 'js') return decl.type === 'variable_declarator' && !!ancestor(decl, (a) => FUNCTION_SCOPES.js.has(a.type));
  if (fam === 'py') return decl.type === 'expression_statement' && !!ancestor(decl, (a) => a.type === 'function_definition');
  return false;
}

/** Usages of a declaration: the function for locals and parameters, the whole project otherwise. */
function usagesOf(s, t) {
  const { fam, decl, text, file, name } = t;
  const nameNode = nameNodeOf(fam, decl);
  const range = declRange(fam, text, removableOf(fam, decl));
  const out = [];
  if (isLocalDecl(fam, decl)) {
    const scope = ancestor(decl.parent || decl, (a) => FUNCTION_SCOPES[fam].has(a.type)) || t.tree.rootNode;
    for (const n of walk(scope)) {
      if (n.type !== 'identifier' || n.text !== name || (nameNode && sameNode(n, nameNode))) continue;
      if (isMemberName(fam, n) || isArgLabel(fam, n)) continue;
      if (!isParam(fam, decl) && n.startIndex >= range.start && n.endIndex <= range.end) continue;
      out.push({ file, line: n.startPosition.row + 1, col: n.startPosition.column + 1, text: lineText(text, n.startIndex) });
    }
    return out;
  }
  for (const r of s.deps.refs(name)) {
    if (r.kind === 'declaration') continue;
    if (r.file === file) {
      const off = offsetOf(text, r.line, r.col);
      if (off >= range.start && off < range.end) continue;
    }
    out.push({ file: r.file, line: r.line, col: r.col, text: (r.text || '').trim() });
  }
  return out;
}

/** Python: a block that would become empty gets `pass`. */
function keepPythonBlock(text, node, edit) {
  const block = node.parent;
  if (!block || block.type !== 'block') return edit;
  const others = named(block).filter((c) => c.type !== 'comment' && !sameNode(c, node));
  if (others.length) return edit;
  return { ...edit, text: `${indentAt(text, node.startIndex)}pass\n` };
}

function safeDelete(s, p) {
  const t = targetAt(s, p.file, p.start);
  if (isParam(t.fam, t.decl)) return safeDeleteParameter(s, p, t);
  const usages = usagesOf(s, t);
  const node = removableOf(t.fam, t.decl);
  const range = declRange(t.fam, t.text, node);
  let edit = removalEdit(t.text, range.start, range.end);
  if (t.fam === 'py') edit = keepPythonBlock(t.text, node, edit);
  const after = applyEdits(t.text, [edit]);
  return { files: [{ path: t.file, before: t.text, after }], usages, blocked: usages.length > 0 && !p.force, symbol: t.name };
}

function safeDeleteParameter(s, p, t) {
  const fn = callableAncestor(t.fam, t.decl);
  if (!fn) fail('Cannot find the function of this parameter.');
  const info = signatureOf(t.fam, t.text, fn);
  const nameNode = nameNodeOf(t.fam, t.decl);
  const index = info.params.findIndex((x) => x.name === nameNode.text);
  if (index < 0) fail('Cannot find this parameter in the signature.');
  if (info.params[index].kind === 'self') fail(`'${nameNode.text}' cannot be removed.`);
  const usages = usagesOf(s, t);
  const params = info.params.map((x, i) => ({ old: i, name: x.name })).filter((x) => x.old !== index);
  const res = changeSignature(s, { ...p, file: t.file, start: info.nameStart, params });
  return { ...res, usages, blocked: usages.length > 0 && !p.force, symbol: nameNode.text };
}

// ------------------------------------------------------ Change Signature

function callableAncestor(fam, node) {
  return ancestor(node, (a) => CALLABLE[fam].has(a.type) || (fam === 'js' && a.type === 'variable_declarator' && field(a, 'value') && CALLABLE.js.has(field(a, 'value').type)));
}
const isCallableDecl = (fam, d) => CALLABLE[fam].has(d.type) || (fam === 'js' && d.type === 'variable_declarator' && !!field(d, 'value') && CALLABLE.js.has(field(d, 'value').type));

function paramListOf(fam, fn) {
  if (fam === 'js' && fn.type === 'variable_declarator') fn = field(fn, 'value');
  return field(fn, 'parameters') || field(fn, 'parameter');
}

function isPyMethod(fn) {
  const holder = fn.parent && fn.parent.type === 'decorated_definition' ? fn.parent : fn;
  if (!(holder.parent && holder.parent.type === 'block' && holder.parent.parent && holder.parent.parent.type === 'class_definition')) return false;
  if (holder.type === 'decorated_definition' && named(holder).some((d) => d.type === 'decorator' && /^@staticmethod\b/.test(d.text))) return false;
  return true;
}

/** Parameters of a function: [{ name, type, default, kind, text, mods, optional }]. */
function signatureOf(fam, text, fn) {
  const list = paramListOf(fam, fn);
  const params = [];
  const typeText = (n) => (n ? n.text.replace(/^:\s*/, '') : '');
  if (fam === 'cs' && list) {
    const kids = children(list);
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.type === 'parameter') {
        const parts = children(c);
        const mods = parts.filter((m) => m.type === 'modifier').map((m) => m.text);
        const eq = parts.findIndex((x) => x.type === '=');
        const def = eq >= 0 ? parts.slice(eq + 1).find(isNamed) : null;
        params.push({ name: field(c, 'name').text, type: typeText(field(c, 'type')), default: def ? def.text : '', kind: mods.includes('params') ? 'params' : mods.includes('this') ? 'this' : 'normal', mods: mods.join(' '), text: c.text });
      } else if (c.type === 'params') {
        const rest = kids.slice(i + 1);
        const nameNode = rest.find((x) => x.type === 'identifier');
        const typeNode = rest.find((x) => isNamed(x) && x.type !== 'identifier');
        if (nameNode) params.push({ name: nameNode.text, type: typeNode ? typeNode.text : '', default: '', kind: 'params', mods: 'params', text: text.slice(c.startIndex, nameNode.endIndex) });
        break;
      }
    }
  } else if (fam === 'py' && list) {
    const method = isPyMethod(fn);
    for (const c of named(list)) {
      if (c.type === 'comment') continue;
      const p = { text: c.text, type: '', default: '', kind: 'normal' };
      if (c.type === 'identifier') p.name = c.text;
      else if (c.type === 'default_parameter') Object.assign(p, { name: field(c, 'name').text, default: field(c, 'value').text });
      else if (c.type === 'typed_parameter') {
        const inner = named(c)[0];
        Object.assign(p, { name: inner.type === 'identifier' ? inner.text : named(inner)[0].text, type: typeText(field(c, 'type')), kind: inner.type === 'list_splat_pattern' ? 'rest' : inner.type === 'dictionary_splat_pattern' ? 'kwrest' : 'normal' });
      } else if (c.type === 'typed_default_parameter') Object.assign(p, { name: field(c, 'name').text, type: typeText(field(c, 'type')), default: field(c, 'value').text });
      else if (c.type === 'list_splat_pattern') Object.assign(p, { name: named(c)[0].text, kind: 'rest' });
      else if (c.type === 'dictionary_splat_pattern') Object.assign(p, { name: named(c)[0].text, kind: 'kwrest' });
      else if (c.type === 'keyword_separator') Object.assign(p, { name: '*', kind: 'kwsep' });
      else if (c.type === 'positional_separator') Object.assign(p, { name: '/', kind: 'possep' });
      else Object.assign(p, { name: c.text, kind: 'pattern' });
      if (method && !params.length && p.kind === 'normal') p.kind = 'self';
      params.push(p);
    }
  } else if (list) {
    const items = list.type === 'identifier' ? [list] : named(list);
    for (const c of items) {
      if (c.type === 'comment') continue;
      const p = { text: c.text, type: '', default: '', kind: 'normal', optional: false };
      if (c.type === 'identifier') p.name = c.text;
      else if (c.type === 'assignment_pattern') Object.assign(p, { name: field(c, 'left').text, default: field(c, 'right').text });
      else if (c.type === 'rest_pattern') Object.assign(p, { name: named(c)[0].text, kind: 'rest' });
      else if (c.type === 'required_parameter' || c.type === 'optional_parameter') {
        const pat = field(c, 'pattern');
        const value = field(c, 'value');
        Object.assign(p, { name: pat.type === 'rest_pattern' ? named(pat)[0].text : pat.text, type: typeText(field(c, 'type')), default: value ? value.text : '', kind: pat.type === 'rest_pattern' ? 'rest' : pat.type === 'this' ? 'this' : /pattern$/.test(pat.type) ? 'pattern' : 'normal', optional: c.type === 'optional_parameter' });
      } else Object.assign(p, { name: c.text, kind: 'pattern' });
      params.push(p);
    }
  }
  const fnNode = fam === 'js' && fn.type === 'variable_declarator' ? field(fn, 'value') : fn;
  const nameNode = field(fn, 'name');
  const ret = fam === 'cs' ? field(fn, 'returns') || field(fn, 'type') : field(fnNode, 'return_type');
  return { params, list, nameNode, nameStart: nameNode ? nameNode.startIndex : fn.startIndex, returnType: ret ? typeText(ret).replace(/^->\s*/, '') : '', returnNode: ret, fnNode };
}

/** The call whose callee name is `ident` (f(...), obj.f(...), new F(...)), or null. */
function callOfName(fam, ident) {
  let callee = ident;
  const p = ident.parent;
  if (!p) return null;
  if ((fam === 'cs' && p.type === 'member_access_expression' && sameNode(field(p, 'name'), ident)) || (fam === 'py' && p.type === 'attribute' && sameNode(field(p, 'attribute'), ident)) || (fam === 'js' && p.type === 'member_expression' && sameNode(field(p, 'property'), ident)) || (fam === 'cs' && p.type === 'generic_name')) callee = p;
  if (fam === 'cs' && callee.parent && callee.parent.type === 'member_access_expression' && sameNode(field(callee.parent, 'name'), callee)) callee = callee.parent;
  const c = callee.parent;
  if (!c) return null;
  if (CALL_TYPES[fam].has(c.type) && sameNode(field(c, 'function'), callee)) return c;
  if (NEW_TYPES[fam].has(c.type) && sameNode(field(c, fam === 'cs' ? 'type' : 'constructor'), callee)) return c;
  return null;
}

function callableTarget(s, file, start) {
  const fam = s.fam(file);
  const text = s.text(file);
  const tree = s.parse(file, text);
  const at = tree.rootNode.descendantForIndex(start, start);
  const ident = identAt(s, tree, start);
  const direct = ident && declOf(fam, ident);
  if (direct && isCallableDecl(fam, direct)) return { file, text, tree, fam, fn: direct };
  const list = ancestor(at, (a) => a.type === 'parameter_list' || a.type === 'parameters' || a.type === 'formal_parameters');
  if (list && (!ident || !callOfName(fam, ident))) {
    const fn = callableAncestor(fam, list);
    if (fn) return { file, text, tree, fam, fn };
  }
  const t = targetAt(s, file, start, { want: isCallableDecl });
  return { file: t.file, text: t.text, tree: t.tree, fam: t.fam, fn: t.decl };
}

function className(fam, fn) {
  const cls = classOf(fam, fn);
  return cls && field(cls, 'name') ? field(cls, 'name').text : null;
}

function isConstructor(fam, fn, info) {
  if (fam === 'cs') return fn.type === 'constructor_declaration';
  if (fam === 'py') return !!info.nameNode && info.nameNode.text === '__init__';
  return fn.type === 'method_definition' && !!info.nameNode && info.nameNode.text === 'constructor';
}

function argsOf(fam, call) {
  const list = field(call, 'arguments');
  if (!list || (fam === 'py' && list.type !== 'argument_list')) return null;
  const positional = [];
  const byName = new Map();
  let order = 0;
  for (const a of named(list)) {
    if (a.type === 'comment') continue;
    if (fam === 'cs') {
      const nm = field(a, 'name');
      if (nm) {
        const colon = a.text.indexOf(':', nm.endIndex - a.startIndex);
        byName.set(nm.text, { value: a.text.slice(colon + 1).trim(), order: order++ });
      } else positional.push(a.text);
    } else if (fam === 'py') {
      if (a.type === 'keyword_argument') byName.set(field(a, 'name').text, { value: field(a, 'value').text, order: order++ });
      else if (a.type === 'list_splat' || a.type === 'dictionary_splat') return { splat: true };
      else positional.push(a.text);
    } else if (a.type === 'spread_element') return { splat: true };
    else positional.push(a.text);
  }
  return { list, positional, named: byName };
}

/** New argument texts for a call, or null when the call does not fit the old signature. */
function newArguments(fam, oldParams, newParams, args, selfShift, warnings, where) {
  const restIndex = oldParams.findIndex((p) => p.kind === 'rest' || p.kind === 'params');
  const positionalCapacity = oldParams.filter((p) => p.kind === 'normal' || p.kind === 'self' || p.kind === 'this' || p.kind === 'pattern').length - selfShift;
  if (restIndex < 0 && args.positional.length > positionalCapacity) return null;
  const kwrest = oldParams.some((p) => p.kind === 'kwrest');
  for (const n of args.named.keys()) if (!kwrest && !oldParams.some((p) => p.name === n)) return null;
  const argFor = (i) => {
    const p = oldParams[i];
    const pos = i - selfShift;
    if (p.kind === 'rest' || p.kind === 'params') return { rest: args.positional.slice(pos) };
    if (pos >= 0 && pos < args.positional.length) return { value: args.positional[pos], named: false };
    if (args.named.has(p.name)) return { ...args.named.get(p.name), named: true };
    return null;
  };
  const slots = [];
  for (const np of newParams) {
    const kind = np.old != null ? oldParams[np.old].kind : np.kind || 'normal';
    if ((kind === 'self' && selfShift) || kind === 'kwsep' || kind === 'possep' || kind === 'kwrest') continue;
    if (np.old != null) {
      const a = argFor(np.old);
      if (a && a.rest) slots.push({ np, rest: a.rest });
      else if (a) slots.push({ np, value: a.value, named: a.named, order: a.order });
      else slots.push({ np, value: null });
      continue;
    }
    let value = np.value != null && String(np.value).trim() !== '' ? String(np.value).trim() : null;
    if (value == null && !(np.default != null && String(np.default).trim() !== '')) {
      value = NULL[fam];
      warnings.push(`No value was given for the new parameter '${np.name}': ${where} passes ${value}.`);
    }
    slots.push({ np, value });
  }
  const extras = kwrest ? [...args.named.entries()].filter(([n]) => !oldParams.some((p) => p.name === n)) : [];
  if (fam === 'js') {
    let last = slots.length - 1;
    while (last >= 0 && slots[last].value == null && !slots[last].rest) last--;
    const out = [];
    for (let i = 0; i <= last; i++) {
      if (slots[i].rest) out.push(...slots[i].rest);
      else out.push(slots[i].value == null ? 'undefined' : slots[i].value);
    }
    return out;
  }
  const positional = [];
  const byName = [];
  let mustName = false;
  for (const sl of slots) {
    if (sl.rest) {
      if (!mustName) positional.push(...sl.rest);
      continue;
    }
    if (sl.value == null) {
      mustName = true;
      continue;
    }
    if (mustName || sl.named) {
      mustName = true;
      byName.push(sl);
    } else positional.push(sl.value);
  }
  byName.sort((a, b) => (a.named ? 0 : 1) - (b.named ? 0 : 1) || (a.named && b.named ? a.order - b.order : 0));
  const sep = fam === 'cs' ? ': ' : '=';
  return [...positional, ...byName.map((sl) => `${sl.np.name}${sep}${sl.value}`), ...extras.map(([n, v]) => `${n}${sep}${v.value}`)];
}

function paramText(fam, lang, np, oldP) {
  const type = np.type != null ? String(np.type).trim() : oldP ? oldP.type : '';
  const def = np.default != null ? String(np.default).trim() : oldP ? oldP.default : '';
  if (oldP && np.name === oldP.name && type === oldP.type && def === oldP.default) return oldP.text;
  const kind = oldP ? oldP.kind : np.kind || 'normal';
  if (fam === 'cs') {
    const mods = oldP && oldP.mods ? `${oldP.mods} ` : '';
    return `${mods}${type || 'object'} ${np.name}${def ? ` = ${def}` : ''}`;
  }
  if (fam === 'py') {
    if (kind === 'self') return np.name;
    if (kind === 'kwsep') return '*';
    if (kind === 'possep') return '/';
    const star = kind === 'rest' ? '*' : kind === 'kwrest' ? '**' : '';
    if (type) return `${star}${np.name}: ${type}${def ? ` = ${def}` : ''}`;
    return `${star}${np.name}${def ? `=${def}` : ''}`;
  }
  const dots = kind === 'rest' ? '...' : '';
  const opt = oldP && oldP.optional && !def ? '?' : '';
  return `${dots}${np.name}${opt}${type && lang !== 'javascript' ? `: ${type}` : ''}${def ? ` = ${def}` : ''}`;
}

function joinLike(oldInner, items) {
  if (!oldInner.includes('\n')) return items.join(', ');
  const lead = /^\s*/.exec(oldInner)[0];
  const trail = /\s*$/.exec(oldInner)[0];
  const indent = lead.slice(lead.lastIndexOf('\n') + 1);
  return items.length ? lead + items.join(`,\n${indent}`) + trail : '';
}

function signatureInfo(s, p) {
  const t = callableTarget(s, p.file, p.start);
  const info = signatureOf(t.fam, t.text, t.fn);
  return {
    name: info.nameNode ? info.nameNode.text : '',
    file: t.file,
    lang: s.lang(t.file),
    line: lineOf(t.text, info.nameStart),
    returnType: info.returnType,
    params: info.params.map((x) => ({ name: x.name, type: x.type, default: x.default, kind: x.kind, optional: !!x.optional })),
  };
}

/** Body edits for renamed parameters (not the parameter list itself, member names or argument labels). */
function renameEdits(fam, fn, list, renames) {
  const edits = [];
  if (!renames.size) return edits;
  for (const n of walk(fn)) {
    if (list && n.startIndex >= list.startIndex && n.endIndex <= list.endIndex) continue;
    if (n.type === 'shorthand_property_identifier' && renames.has(n.text)) {
      edits.push({ start: n.startIndex, end: n.endIndex, text: `${n.text}: ${renames.get(n.text)}` });
      continue;
    }
    if (n.type !== 'identifier' || !renames.has(n.text)) continue;
    if (isMemberName(fam, n) || isArgLabel(fam, n)) continue;
    const p = n.parent;
    if (p && CALLABLE[fam].has(p.type) && sameNode(field(p, 'name'), n)) continue;
    edits.push({ start: n.startIndex, end: n.endIndex, text: renames.get(n.text) });
  }
  return edits;
}

function declarationEdits(fam, lang, text, fn, info, newParams, returnType) {
  const old = info.params;
  const edits = [];
  const list = info.list;
  if (!list) fail('This function has no parameter list to change.');
  const texts = newParams.map((np) => paramText(fam, lang, np, np.old != null ? old[np.old] : null));
  if (list.type === 'identifier') {
    edits.push({ start: list.startIndex, end: list.endIndex, text: `(${texts.join(', ')})` });
  } else {
    const open = list.startIndex + 1;
    const close = list.endIndex - 1;
    const inner = text.slice(open, close);
    const next = joinLike(inner, texts);
    if (next !== inner) edits.push({ start: open, end: close, text: next });
  }
  const renames = new Map();
  for (const np of newParams) if (np.old != null && old[np.old].name !== np.name && old[np.old].kind !== 'kwsep' && old[np.old].kind !== 'possep') renames.set(old[np.old].name, np.name);
  edits.push(...renameEdits(fam, info.fnNode || fn, list, renames));
  if (returnType != null && String(returnType).trim() !== info.returnType) {
    const rt = String(returnType).trim();
    if (info.returnNode) edits.push({ start: info.returnNode.startIndex, end: info.returnNode.endIndex, text: fam === 'js' ? `: ${rt}` : rt });
    else if (rt && fam !== 'cs') edits.push({ start: list.endIndex, end: list.endIndex, text: fam === 'py' ? ` -> ${rt}` : `: ${rt}` });
  }
  return edits;
}

function changeSignature(s, p) {
  const t = callableTarget(s, p.file, p.start);
  const lang = s.lang(t.file);
  const info = signatureOf(t.fam, t.text, t.fn);
  const name = info.nameNode ? info.nameNode.text : '';
  const old = info.params;
  const newParams = (p.params || []).map((x) => ({ ...x, old: x.old == null ? null : Number(x.old), name: String(x.name || '').trim() }));
  const seen = new Set();
  for (const np of newParams) {
    if (np.old != null && !(np.old >= 0 && np.old < old.length)) fail('Unknown parameter.');
    const kind = np.old != null ? old[np.old].kind : 'normal';
    if (kind === 'kwsep' || kind === 'possep') continue;
    if (!validName(np.name)) fail(`'${np.name}' is not a valid parameter name.`);
    if (seen.has(np.name)) fail(`There are two parameters named '${np.name}'.`);
    seen.add(np.name);
  }
  const warnings = [];
  if (t.fam === 'py') {
    let defaulted = false;
    for (const np of newParams) {
      const kind = np.old != null ? old[np.old].kind : 'normal';
      if (kind !== 'normal') continue;
      const def = np.default != null ? String(np.default).trim() : np.old != null ? old[np.old].default : '';
      if (def) defaulted = true;
      else if (defaulted) warnings.push(`'${np.name}' has no default value but follows a parameter that has one, which Python does not allow.`);
    }
  }
  const body = field(info.fnNode || t.fn, 'body');
  for (const [i, op] of old.entries()) {
    if (newParams.some((np) => np.old === i)) continue;
    if (op.kind === 'self') fail(`'${op.name}' cannot be removed.`);
    if (body && [...walk(body)].some((n) => n.type === 'identifier' && n.text === op.name && !isMemberName(t.fam, n) && !isArgLabel(t.fam, n))) warnings.push(`The removed parameter '${op.name}' is still used in the body of ${name}.`);
  }

  // 1. the declaration, and declarations with the same signature (overrides, interface members)
  const phase1 = new Map();
  const add = (file, text, edits) => {
    const e = phase1.get(file) || { text, edits: [] };
    e.edits.push(...edits);
    phase1.set(file, e);
  };
  add(t.file, t.text, declarationEdits(t.fam, lang, t.text, t.fn, info, newParams, p.returnType));
  const shape = old.map((x) => `${x.type}`).join(',');
  for (const d of s.deps.defs(name)) {
    if (s.deps.langOf(d.file) !== lang) continue;
    const dtext = s.text(d.file);
    const dtree = d.file === t.file ? t.tree : s.parse(d.file, dtext);
    const id = identAt(s, dtree, offsetOf(dtext, d.line, d.col));
    const dfn = id && declOf(t.fam, id);
    if (!dfn || !CALLABLE[t.fam].has(dfn.type)) continue;
    if (d.file === t.file && dfn.startIndex === t.fn.startIndex) continue;
    const dinfo = signatureOf(t.fam, dtext, dfn);
    if (dinfo.params.length !== old.length || dinfo.params.map((x) => `${x.type}`).join(',') !== shape) continue;
    if (t.fam !== 'cs' && dinfo.params.map((x) => x.name).join(',') !== old.map((x) => x.name).join(',')) continue;
    add(d.file, dtext, declarationEdits(t.fam, lang, dtext, dfn, dinfo, newParams, p.returnType));
  }
  const texts = new Map();
  for (const [file, e] of phase1) texts.set(file, applyEdits(e.text, e.edits));

  // 2. the calls
  const ctor = isConstructor(t.fam, t.fn, info);
  const calleeName = ctor ? className(t.fam, t.fn) : name;
  const files = new Set([t.file, ...phase1.keys()]);
  for (const r of s.deps.refs(calleeName)) if (FAMILY[s.deps.langOf(r.file)] === t.fam) files.add(r.file);
  let calls = 0;
  let skipped = 0;
  for (const file of files) {
    const text = texts.has(file) ? texts.get(file) : s.text(file);
    const tree = s.parse(file, text);
    const edits = [];
    for (const n of walk(tree.rootNode)) {
      if (!s.deps.isIdent(n.type) || n.text !== calleeName) continue;
      const call = callOfName(t.fam, n);
      if (!call) continue;
      if (ctor && t.fam !== 'py' && !NEW_TYPES[t.fam].has(call.type)) continue;
      const args = argsOf(t.fam, call);
      if (!args) continue;
      const where = `${path.basename(file)}:${lineOf(text, call.startIndex)}`;
      if (args.splat) {
        warnings.push(`The call at ${where} passes *args / **kwargs or a spread and was left unchanged.`);
        continue;
      }
      let selfShift = 0;
      if (t.fam === 'py' && old[0] && old[0].kind === 'self') {
        const callee = field(call, 'function');
        const explicitSelf = !ctor && callee.type === 'attribute' && field(callee, 'object') && field(callee, 'object').text === className('py', t.fn);
        selfShift = explicitSelf ? 0 : 1;
      }
      const next = newArguments(t.fam, old, newParams, args, selfShift, warnings, where);
      if (!next) {
        skipped++;
        continue;
      }
      calls++;
      const list = args.list;
      const inner = text.slice(list.startIndex + 1, list.endIndex - 1);
      const value = joinLike(inner, next);
      if (value !== inner) edits.push({ start: list.startIndex + 1, end: list.endIndex - 1, text: value });
    }
    if (edits.length) texts.set(file, applyEdits(text, edits));
  }
  if (skipped) warnings.push(`${skipped} call${skipped === 1 ? '' : 's'} of '${calleeName}' did not match this signature (another overload or an unrelated '${calleeName}') and ${skipped === 1 ? 'was' : 'were'} left unchanged.`);
  const out = [];
  for (const [file, after] of texts) {
    const before = s.text(file);
    if (after !== before) out.push({ path: file, before, after });
  }
  return { files: out, warnings: [...new Set(warnings)], calls };
}

// ----------------------------------------------------- Pull Members Up

function membersOf(fam, cls) {
  const body = bodyOf(cls);
  const out = [];
  for (const c of named(body)) {
    if (fam === 'cs') {
      if (c.type === 'field_declaration' || c.type === 'event_field_declaration') {
        const vd = named(c).find((x) => x.type === 'variable_declaration') || c;
        for (const d of named(vd).filter((x) => x.type === 'variable_declarator')) out.push({ name: field(d, 'name').text, kind: 'field', node: c });
      } else if (['method_declaration', 'property_declaration', 'event_declaration', 'indexer_declaration'].includes(c.type) && field(c, 'name')) out.push({ name: field(c, 'name').text, kind: c.type.replace('_declaration', ''), node: c });
    } else if (fam === 'py') {
      const def = c.type === 'decorated_definition' ? field(c, 'definition') : c;
      if (def && def.type === 'function_definition') out.push({ name: field(def, 'name').text, kind: 'method', node: def });
      else if (c.type === 'expression_statement' && named(c)[0] && named(c)[0].type === 'assignment' && field(named(c)[0], 'left').type === 'identifier') out.push({ name: field(named(c)[0], 'left').text, kind: 'field', node: c });
    } else {
      const nm = field(c, 'name') || field(c, 'property');
      if (!nm) continue;
      if (c.type === 'method_definition' && nm.text === 'constructor') continue;
      if (/method_definition|method_signature/.test(c.type)) out.push({ name: nm.text, kind: 'method', node: c });
      else if (/field_definition|property_signature/.test(c.type)) out.push({ name: nm.text, kind: 'field', node: c });
    }
  }
  return out;
}

function basesOf(fam, cls) {
  const names = [];
  const clean = (t) => t.replace(/<[\s\S]*>$/, '').replace(/\(.*$/s, '').split('.').pop().trim();
  if (fam === 'cs') {
    const list = named(cls).find((c) => c.type === 'base_list');
    for (const b of named(list)) names.push(clean(b.text));
  } else if (fam === 'py') {
    for (const b of named(field(cls, 'superclasses'))) if (b.type === 'identifier' || b.type === 'attribute') names.push(clean(b.text));
  } else {
    const heritage = named(cls).find((c) => c.type === 'class_heritage' || c.type === 'extends_type_clause');
    for (const c of named(heritage)) {
      if (c.type === 'extends_clause' || c.type === 'implements_clause') for (const x of named(c)) names.push(clean(x.text));
      else if (c.type !== 'comment') names.push(clean(c.text));
    }
  }
  return names.filter((n) => n && n !== 'object');
}

function pullUpContext(s, p) {
  const fam = s.fam(p.file);
  const text = s.text(p.file);
  const tree = s.parse(p.file, text);
  const at = tree.rootNode.descendantForIndex(p.start, p.start);
  const cls = ancestor(at, (a) => (fam === 'cs' ? CS_TYPES.has(a.type) && a.type !== 'interface_declaration' && a.type !== 'enum_declaration' : fam === 'py' ? a.type === 'class_definition' : JS_CLASSES.has(a.type)));
  if (!cls || !field(cls, 'name')) fail('Put the caret on a member of a class.');
  const members = membersOf(fam, cls);
  const caret = members.find((m) => {
    const r = declRange(fam, text, removableOf(fam, m.node));
    return p.start >= r.start && p.start <= r.end;
  });
  const targets = [];
  for (const b of basesOf(fam, cls)) {
    const d = s.deps.defs(b).find((x) => ['class', 'interface', 'struct', 'record'].includes(x.kind));
    if (d) targets.push({ name: b, kind: d.kind === 'interface' ? 'interface' : 'class', file: d.file, line: d.line, col: d.col });
  }
  return { fam, text, tree, cls, className: field(cls, 'name').text, members, caret, targets };
}

function pullUpInfo(s, p) {
  const c = pullUpContext(s, p);
  return { className: c.className, members: c.members.map((m) => ({ name: m.name, kind: m.kind, selected: !!c.caret && m === c.caret })), targets: c.targets.map(({ name, kind, file, line }) => ({ name, kind, file, line })) };
}

/** An interface member for a class member: signature without modifiers or body. */
function interfaceSignature(fam, node) {
  if (fam === 'cs') {
    if (node.type === 'method_declaration') {
      const tp = named(node).find((c) => c.type === 'type_parameter_list');
      const constraints = named(node).filter((c) => c.type === 'type_parameter_constraints_clause').map((c) => ` ${c.text}`).join('');
      return `${field(node, 'returns').text} ${field(node, 'name').text}${tp ? tp.text : ''}${field(node, 'parameters').text}${constraints};`;
    }
    if (node.type === 'property_declaration') {
      const acc = field(node, 'accessors');
      const names = acc ? named(acc).map((a) => (/^\s*(?:\w+\s+)*?(get|set|init)\b/.exec(a.text) || [])[1]).filter(Boolean) : ['get'];
      return `${field(node, 'type').text} ${field(node, 'name').text} { ${names.map((x) => `${x};`).join(' ')} }`;
    }
    fail('Only methods and properties can be added to an interface.');
  }
  if (node.type === 'method_definition') {
    const ret = field(node, 'return_type');
    return `${field(node, 'name').text}${field(node, 'parameters').text}${ret ? ret.text : ''};`;
  }
  const nm = field(node, 'name') || field(node, 'property');
  const type = field(node, 'type');
  return `${nm.text}${type ? type.text : ''};`;
}

function pullMembersUp(s, p) {
  const c = pullUpContext(s, p);
  const target = c.targets.find((x) => x.name === p.target);
  if (!target) fail(`'${p.target}' is not a base type of ${c.className} declared in this project.`);
  const wanted = new Set(Array.isArray(p.members) ? p.members : [p.members].filter(Boolean));
  const chosen = c.members.filter((m) => wanted.has(m.name));
  if (!chosen.length) fail('Choose at least one member to pull up.');
  const sameFile = target.file === p.file;
  const ttext = sameFile ? c.text : s.text(target.file);
  const ttree = sameFile ? c.tree : s.parse(target.file, ttext);
  const tid = identAt(s, ttree, offsetOf(ttext, target.line, target.col));
  const tcls = tid && tid.parent;
  if (!tcls || !bodyOf(tcls)) fail(`Cannot find the body of ${target.name}.`);
  const toInterface = isInterface(tcls);
  if (toInterface && c.fam === 'py') fail('Python has no interfaces.');
  const warnings = [];
  const targetNames = new Set(membersOf(c.fam, tcls).map((m) => m.name));
  for (const m of chosen) if (targetNames.has(m.name)) fail(`${target.name} already has a member named ${m.name}.`);
  if (!toInterface) {
    const staying = new Set(c.members.filter((m) => !wanted.has(m.name)).map((m) => m.name));
    for (const m of chosen) {
      const used = new Set();
      for (const n of walk(m.node)) if (s.deps.isIdent(n.type) && staying.has(n.text) && !targetNames.has(n.text)) used.add(n.text);
      for (const u of used) warnings.push(`${m.name} uses ${u}, which stays in ${c.className}.`);
    }
  }
  const unit = indentUnit(c.text);
  const tbody = bodyOf(tcls);
  const firstMember = named(tbody).find((x) => x.type !== 'comment');
  const destIndent = firstMember ? indentAt(ttext, firstMember.startIndex) : indentAt(ttext, tcls.startIndex) + unit;
  const blocks = [];
  for (const m of chosen) {
    const node = removableOf(c.fam, m.node);
    const r = declRange(c.fam, c.text, node);
    if (toInterface) blocks.push(`${destIndent}${interfaceSignature(c.fam, m.node)}\n`);
    else blocks.push(reindent(c.text.slice(r.start, r.end).replace(/\n?$/, '\n'), indentAt(c.text, node.startIndex), destIndent));
  }
  const targetEdits = [];
  if (c.fam === 'py') {
    const stmts = named(tbody).filter((x) => x.type !== 'comment');
    if (stmts.length === 1 && stmts[0].type === 'pass_statement') targetEdits.push({ start: lineStartAt(ttext, stmts[0].startIndex), end: lineEndAt(ttext, stmts[0].endIndex), text: blocks.join('\n') });
    else {
      const at = lineEndAt(ttext, tbody.endIndex - 1);
      targetEdits.push({ start: at, end: at, text: (ttext[at - 1] === '\n' ? '' : '\n') + '\n' + blocks.join('\n') });
    }
  } else {
    const close = tbody.endIndex - 1;
    const ls = lineStartAt(ttext, close);
    const gap = toInterface || !firstMember ? '' : '\n';
    const insert = gap + blocks.join(toInterface ? '' : '\n');
    if (/^[ \t]*$/.test(ttext.slice(ls, close))) targetEdits.push({ start: ls, end: ls, text: insert });
    else targetEdits.push({ start: close, end: close, text: `\n${insert}${indentAt(ttext, tcls.startIndex)}` });
  }
  const sourceEdits = [];
  if (!toInterface) {
    for (const m of chosen) {
      const node = removableOf(c.fam, m.node);
      const r = declRange(c.fam, c.text, node);
      let e = removalEdit(c.text, r.start, r.end);
      if (c.fam === 'py' && chosen.length === c.members.length) e = keepPythonBlock(c.text, node, e);
      sourceEdits.push(e);
    }
  }
  const files = [];
  if (sameFile) files.push({ path: p.file, before: c.text, after: applyEdits(c.text, [...sourceEdits, ...targetEdits]) });
  else {
    if (sourceEdits.length) files.push({ path: p.file, before: c.text, after: applyEdits(c.text, sourceEdits) });
    files.push({ path: target.file, before: ttext, after: applyEdits(ttext, targetEdits) });
  }
  return { files, warnings };
}

// ------------------------------------------- Introduce Variable / Constant

const PY_EXPR = new Set(['binary_operator', 'boolean_operator', 'comparison_operator', 'unary_operator', 'not_operator', 'call', 'attribute', 'subscript', 'identifier', 'integer', 'float', 'string', 'concatenated_string', 'list', 'dictionary', 'tuple', 'set', 'parenthesized_expression', 'conditional_expression', 'lambda', 'list_comprehension', 'dictionary_comprehension', 'set_comprehension', 'generator_expression', 'true', 'false', 'none', 'await']);
function isExpression(fam, n) {
  if (!n || !isNamed(n)) return false;
  if (fam === 'cs') return (/(_expression|_literal)$/.test(n.type) && !/^(assignment_expression|declaration_expression|lambda_expression)$/.test(n.type)) || n.type === 'identifier' || n.type === 'generic_name';
  if (fam === 'py') return PY_EXPR.has(n.type);
  return (/expression$/.test(n.type) && !/^(assignment_expression|augmented_assignment_expression|sequence_expression)$/.test(n.type)) || /^(identifier|number|string|template_string|true|false|null|undefined|this|array|object|regex)$/.test(n.type);
}

/** The expression a selection covers (or the smallest one around a caret). */
function expressionAt(fam, tree, text, start, end) {
  let a = start;
  let b = end;
  while (a < b && /\s/.test(text[a])) a++;
  while (b > a && /\s/.test(text[b - 1])) b--;
  if (a === b) {
    let n = tree.rootNode.descendantForIndex(a, a);
    while (n && !isExpression(fam, n)) n = n.parent;
    return n;
  }
  const exact = (n) => n.startIndex === a && n.endIndex === b;
  const stack = [tree.rootNode];
  let found = null;
  while (stack.length) {
    const x = stack.pop();
    if (exact(x) && isExpression(fam, x)) found = x;
    for (const ch of named(x)) if (ch.startIndex <= a && ch.endIndex >= b) stack.push(ch);
  }
  return found;
}

const STATEMENT_HOLDERS = { cs: new Set(['block', 'switch_section', 'compilation_unit']), py: new Set(['block', 'module']), js: new Set(['statement_block', 'program', 'switch_case', 'switch_default', 'class_static_block']) };

function statementOf(fam, n) {
  let cur = n;
  while (cur.parent && !STATEMENT_HOLDERS[fam].has(cur.parent.type)) {
    const p = cur.parent;
    if ((fam === 'cs' && p.type === 'lambda_expression') || (fam === 'js' && p.type === 'arrow_function') || (fam === 'py' && p.type === 'lambda')) {
      const body = field(p, 'body');
      if (body && cur.startIndex >= body.startIndex && cur.endIndex <= body.endIndex && body.type !== 'block' && body.type !== 'statement_block') fail('Cannot introduce a variable inside an expression-bodied lambda.');
    }
    if (fam === 'cs' && /^(field_declaration|property_declaration|parameter)$/.test(p.type)) fail('There is no statement to put the variable before here; use Introduce Field or Constant.');
    cur = p;
  }
  if (!cur.parent) fail('Select an expression inside a function.');
  return cur;
}

function sameExpressions(fam, scope, model) {
  const out = [];
  for (const n of walk(scope)) if (n.type === model.type && n.text === model.text && isExpression(fam, n)) out.push(n);
  return out;
}

function validName(name) {
  return /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(String(name || ''));
}

function introduceVariable(s, p) {
  const fam = s.fam(p.file);
  const text = s.text(p.file);
  const tree = s.parse(p.file, text);
  const expr = expressionAt(fam, tree, text, p.start, p.end);
  if (!expr) fail('Select an expression.');
  const name = String(p.name || '').trim();
  if (!validName(name)) fail(`'${name}' is not a valid name.`);
  const scope = ancestor(expr, (a) => FUNCTION_SCOPES[fam].has(a.type)) || tree.rootNode;
  const occurrences = p.all ? sameExpressions(fam, scope, expr) : [expr];
  const first = occurrences.reduce((m, n) => (n.startIndex < m.startIndex ? n : m), occurrences[0]);
  const anchor = statementOf(fam, first);
  const ind = indentAt(text, anchor.startIndex);
  const semi = fam === 'js' && !/;\s*$/.test(text.slice(anchor.startIndex, anchor.endIndex)) ? '' : ';';
  const declText = fam === 'cs' ? `var ${name} = ${expr.text};` : fam === 'py' ? `${name} = ${expr.text}` : `const ${name} = ${expr.text}${semi}`;
  const ls = lineStartAt(text, anchor.startIndex);
  const edits = [{ start: ls, end: ls, text: `${ind}${declText}\n` }, ...occurrences.map((n) => ({ start: n.startIndex, end: n.endIndex, text: name }))];
  const after = applyEdits(text, edits);
  const at = ls + ind.length + (fam === 'cs' ? 4 : fam === 'js' ? 6 : 0);
  return { files: [{ path: p.file, before: text, after }], select: { file: p.file, start: at, end: at + name.length } };
}

function csLiteralType(n) {
  let x = n;
  while (x && (x.type === 'parenthesized_expression' || x.type === 'prefix_unary_expression')) x = named(x)[0];
  if (!x) return null;
  const t = x.text;
  if (x.type === 'integer_literal') return /[lL]$/.test(t) ? (/[uU]/.test(t) ? 'ulong' : 'long') : /[uU]$/.test(t) ? 'uint' : 'int';
  if (x.type === 'real_literal') return /[mM]$/.test(t) ? 'decimal' : /[fF]$/.test(t) ? 'float' : 'double';
  if (/string_literal/.test(x.type)) return 'string';
  if (x.type === 'character_literal') return 'char';
  if (x.type === 'boolean_literal') return 'bool';
  if (x.type === 'binary_expression') {
    const l = csLiteralType(field(x, 'left'));
    const r = csLiteralType(field(x, 'right'));
    return l && l === r ? l : null;
  }
  return null;
}

/** Names local to the functions around a node (parameters, assignment and loop targets). */
function pythonLocals(node) {
  const locals = new Set();
  for (let fn = ancestor(node, (a) => a.type === 'function_definition' || a.type === 'lambda'); fn; fn = ancestor(fn.parent, (a) => a.type === 'function_definition' || a.type === 'lambda')) {
    const params = field(fn, 'parameters');
    if (params) for (const n of walk(params)) if (n.type === 'identifier' && !(n.parent && /default_parameter/.test(n.parent.type) && sameNode(field(n.parent, 'value'), n)) && !(n.parent && /typed/.test(n.parent.type) && sameNode(field(n.parent, 'type'), n))) locals.add(n.text);
    for (const n of walk(fn)) {
      if ((n.type === 'assignment' || n.type === 'augmented_assignment' || n.type === 'for_statement' || n.type === 'for_in_clause') && field(n, 'left')) for (const id of walk(field(n, 'left'))) if (id.type === 'identifier') locals.add(id.text);
    }
  }
  return locals;
}

function introduceConstant(s, p) {
  const fam = s.fam(p.file);
  const text = s.text(p.file);
  const tree = s.parse(p.file, text);
  const expr = expressionAt(fam, tree, text, p.start, p.end);
  if (!expr) fail('Select an expression.');
  const name = String(p.name || '').trim();
  if (!validName(name)) fail(`'${name}' is not a valid name.`);
  const occurrences = p.all ? sameExpressions(fam, tree.rootNode, expr) : [expr];
  const replaceEdits = occurrences.map((n) => ({ start: n.startIndex, end: n.endIndex, text: name }));
  let insert;
  if (fam === 'cs') {
    const type = csLiteralType(expr);
    if (!type) fail('Only literal values can become a constant without the C# language server.');
    const cls = classOf('cs', expr);
    if (!cls || !bodyOf(cls)) fail('The expression is not inside a class.');
    const body = bodyOf(cls);
    const firstMember = named(body).find((x) => x.type !== 'comment');
    const ind = firstMember ? indentAt(text, firstMember.startIndex) : indentAt(text, cls.startIndex) + indentUnit(text);
    const line = `${ind}private const ${type} ${name} = ${expr.text};\n`;
    const at = firstMember ? declRange('cs', text, firstMember).start : lineStartAt(text, body.endIndex - 1);
    insert = { start: at, end: at, text: firstMember ? `${line}\n` : line };
  } else {
    if (fam === 'py') {
      const locals = pythonLocals(expr);
      for (const n of walk(expr)) if (n.type === 'identifier' && locals.has(n.text) && !isMemberName('py', n) && !isArgLabel('py', n)) fail(`The expression uses the local variable '${n.text}', so it cannot become a module constant.`);
    } else {
      for (const n of walk(expr)) if (n.type === 'identifier' && localDeclaration('js', n)) fail(`The expression uses the local variable '${n.text}', so it cannot become a module constant.`);
    }
    const top = named(tree.rootNode).filter((c) => c.type !== 'comment');
    const isImport = (c) => (fam === 'py' ? /^(import_statement|import_from_statement|future_import_statement)$/.test(c.type) : c.type === 'import_statement');
    let lastImport = -1;
    top.forEach((c, i) => {
      if (isImport(c)) lastImport = i;
    });
    const isConst = (c) => (fam === 'py' ? c.type === 'expression_statement' && /^[A-Z][A-Z0-9_]*\s*(?::[^=\n]+)?=/.test(c.text) : /^(?:export\s+)?const\s+[A-Z][A-Z0-9_]*\s*=/.test(c.text));
    const decl = fam === 'py' ? `${name} = ${expr.text}` : `const ${name} = ${expr.text};`;
    const next = top[lastImport + 1];
    if (next && isConst(next)) insert = { start: lineStartAt(text, next.startIndex), text: `${decl}\n` };
    else if (lastImport >= 0) insert = { start: lineEndAt(text, top[lastImport].endIndex), text: `\n${decl}\n` };
    else {
      const doc = fam === 'py' && top[0] && top[0].type === 'expression_statement' && named(top[0])[0] && named(top[0])[0].type === 'string' ? top[0] : null;
      if (doc) insert = { start: lineEndAt(text, doc.endIndex), text: `\n${decl}\n` };
      else {
        const def = top[0] && /function_definition|class_definition|decorated_definition|function_declaration|class_declaration|export_statement/.test(top[0].type);
        insert = { start: 0, text: `${decl}\n${def && fam === 'py' ? '\n\n' : '\n'}` };
      }
    }
    insert.end = insert.start;
  }
  const after = applyEdits(text, [...replaceEdits, insert]);
  let shift = 0;
  for (const e of replaceEdits) if (e.end <= insert.start) shift += e.text.length - (e.end - e.start);
  const at = insert.start + shift + insert.text.indexOf(name);
  return { files: [{ path: p.file, before: text, after }], select: { file: p.file, start: at, end: at + name.length } };
}

// --------------------------------------------------------- Inline Variable

const PRIMARY = /^(identifier|generic_name|.*_literal|integer|float|string|number|true|false|none|null|this|this_expression|base_expression|invocation_expression|call|call_expression|member_access_expression|attribute|member_expression|element_access_expression|subscript|subscript_expression|parenthesized_expression|object_creation_expression|new_expression|array|list|dictionary|object|template_string|interpolated_string_expression|typeof_expression|default_expression)$/;
const NO_PARENS_CONTEXT = /^(argument|arguments|argument_list|return_statement|equals_value_clause|variable_declarator|expression_statement|arrow_expression_clause|parenthesized_expression|keyword_argument|assignment|interpolation)$/;

function inlineVariable(s, p) {
  const fam = s.fam(p.file);
  const text = s.text(p.file);
  const tree = s.parse(p.file, text);
  const ident = identAt(s, tree, p.start);
  if (!ident) fail('Put the caret on a variable.');
  const isVar = (d) => !!d && (fam === 'py' ? d.type === 'expression_statement' : d.type === 'variable_declarator');
  let decl = declOf(fam, ident);
  if (!isVar(decl)) decl = localDeclaration(fam, ident);
  if (!isVar(decl)) fail(`'${ident.text}' is not a local variable.`);
  const name = ident.text;
  let init;
  if (fam === 'cs') {
    const kids = named(decl);
    init = kids.length > 1 ? kids[kids.length - 1] : null;
    if (init && init.type === 'equals_value_clause') init = named(init)[0];
  } else if (fam === 'js') init = field(decl, 'value');
  else init = field(named(decl)[0], 'right');
  if (!init) fail(`'${name}' has no initializer to inline.`);
  const holder = removableOf(fam, decl);
  if (fam === 'cs' && holder.type !== 'local_declaration_statement') fail(`'${name}' is declared together with other variables; split the declaration first.`);
  const scope = ancestor(decl, (a) => FUNCTION_SCOPES[fam].has(a.type)) || tree.rootNode;
  const nameNode = nameNodeOf(fam, decl);
  const usages = [];
  for (const n of walk(scope)) {
    if (n.startIndex < holder.endIndex) continue;
    const shorthand = n.type === 'shorthand_property_identifier' && n.text === name;
    if (!shorthand && (n.type !== 'identifier' || n.text !== name)) continue;
    if (sameNode(n, nameNode) || isMemberName(fam, n) || isArgLabel(fam, n)) continue;
    const pp = n.parent;
    const written =
      (pp && /^(assignment_expression|augmented_assignment_expression|assignment|augmented_assignment)$/.test(pp.type) && sameNode(field(pp, 'left'), n)) ||
      (pp && /postfix_unary_expression|prefix_unary_expression|update_expression/.test(pp.type) && /\+\+|--/.test(pp.text)) ||
      (fam === 'cs' && pp && pp.type === 'argument' && /^\s*(out|ref)\b/.test(pp.text)) ||
      (fam === 'py' && pp && /for_statement|for_in_clause/.test(pp.type) && sameNode(field(pp, 'left'), n));
    if (written) fail(`'${name}' is assigned more than once, so it cannot be inlined.`);
    usages.push(n);
  }
  const primary = PRIMARY.test(init.type);
  const edits = usages.map((n) => {
    if (n.type === 'shorthand_property_identifier') return { start: n.startIndex, end: n.endIndex, text: `${name}: ${init.text}` };
    const wrap = !primary && !NO_PARENS_CONTEXT.test(n.parent ? n.parent.type : '');
    return { start: n.startIndex, end: n.endIndex, text: wrap ? `(${init.text})` : init.text };
  });
  const r = declRange(fam, text, holder);
  edits.push(removalEdit(text, r.start, r.end));
  return { files: [{ path: p.file, before: text, after: applyEdits(text, edits) }], usages: usages.length };
}

// ------------------------------------------------------ Move Type to File

function moveTypeToFile(s, p) {
  const fam = s.fam(p.file);
  if (fam !== 'cs') fail('Move Type to File is for C#; use Move for other languages.');
  const text = s.text(p.file);
  const tree = s.parse(p.file, text);
  const at = tree.rootNode.descendantForIndex(p.start, p.start);
  const type = ancestor(at, (a) => CS_TYPES.has(a.type) || a.type === 'delegate_declaration');
  if (!type || !field(type, 'name')) fail('Put the caret on a type declaration.');
  const holder = type.parent;
  if (!holder || !/^(compilation_unit|declaration_list)$/.test(holder.type) || (holder.type === 'declaration_list' && holder.parent && holder.parent.type !== 'namespace_declaration')) fail('Only top-level types can be moved to their own file.');
  const siblings = named(holder).filter((c) => CS_TYPES.has(c.type) || c.type === 'delegate_declaration');
  const name = field(type, 'name').text;
  if (siblings.length < 2) fail(`${name} is the only type in ${path.basename(p.file)}.`);
  const target = path.join(path.dirname(p.file), `${name}.cs`);
  if (target === p.file || s.deps.exists(target)) fail(`${path.basename(target)} already exists.`);
  const r = declRange('cs', text, type);
  const usings = named(tree.rootNode).filter((c) => c.type === 'using_directive' || c.type === 'extern_alias_directive').map((c) => c.text);
  const fileNs = named(tree.rootNode).find((c) => c.type === 'file_scoped_namespace_declaration');
  const blockNs = holder.type === 'declaration_list' ? holder.parent : null;
  const typeText = text.slice(r.start, r.end).replace(/\n?$/, '\n');
  const ind = indentAt(text, type.startIndex);
  let body;
  if (fileNs) body = `${fileNs.text.replace(/\s*$/, '')}\n\n${reindent(typeText, ind, '')}`;
  else if (blockNs) body = `namespace ${field(blockNs, 'name').text}\n{\n${reindent(typeText, ind, indentUnit(text))}}\n`;
  else body = reindent(typeText, ind, '');
  const content = `${usings.length ? `${usings.join('\n')}\n\n` : ''}${body}`;
  const after = applyEdits(text, [removalEdit(text, r.start, r.end)]);
  return { files: [{ path: p.file, before: text, after }, { path: target, before: '', after: content, created: true }] };
}

// ------------------------------------------------------------- context

/** What the caret / selection is on, so Refactor This can offer the refactorings that apply. */
function context(s, p) {
  const fam = s.fam(p.file);
  const text = s.text(p.file);
  const tree = s.parse(p.file, text);
  const ident = identAt(s, tree, p.start);
  const at = tree.rootNode.descendantForIndex(p.start, p.start);
  const out = { lang: s.lang(p.file), fam, selection: p.end > p.start, expression: false, constantExpression: false, statements: false, symbol: null, declaration: false, callable: false, parameter: false, local: false, member: false, typeDecl: false, topLevel: false };
  const e = expressionAt(fam, tree, text, p.start, p.end > p.start ? p.end : p.start);
  if (p.end > p.start) {
    out.expression = !!e;
    out.statements = !e;
  } else out.expression = !!e && e.type !== 'identifier' && !(ident && sameNode(e, ident));
  if (e) out.constantExpression = fam === 'cs' ? !!csLiteralType(e) : true;
  if (ident) {
    out.symbol = ident.text;
    const own = declOf(fam, ident);
    const local = own || localDeclaration(fam, ident);
    out.declaration = !!own;
    out.callable = (!!own && isCallableDecl(fam, own)) || !!callOfName(fam, ident);
    out.parameter = !!local && isParam(fam, local);
    out.local = !!local && !out.parameter && isLocalDecl(fam, local);
    out.typeDecl = !!own && (fam === 'cs' ? CS_TYPES.has(own.type) : fam === 'py' ? own.type === 'class_definition' : JS_CLASSES.has(own.type));
    out.topLevel = !!own && !!own.parent && /^(compilation_unit|module|program|export_statement|decorated_definition|declaration_list)$/.test((own.parent.type === 'decorated_definition' ? own.parent.parent : own.parent).type);
  }
  const cls = ancestor(at, (a) => (fam === 'cs' ? CS_TYPES.has(a.type) && a.type !== 'interface_declaration' && a.type !== 'enum_declaration' : fam === 'py' ? a.type === 'class_definition' : JS_CLASSES.has(a.type)));
  if (cls && field(cls, 'name') && basesOf(fam, cls).length) out.member = membersOf(fam, cls).some((m) => p.start >= m.node.startIndex && p.start <= m.node.endIndex && !(m.node.type === 'function_definition' || m.node.type === 'method_declaration' || m.node.type === 'method_definition' ? field(m.node, 'body') && p.start > field(m.node, 'body').startIndex : false));
  out.inFunction = !!callableAncestor(fam, at);
  // anywhere in a parameter list counts as being on the function (Change Signature)
  const list = ancestor(at, (a) => a.type === 'parameter_list' || a.type === 'parameters' || a.type === 'formal_parameters');
  if (list && callableAncestor(fam, list) && !(ident && callOfName(fam, ident))) out.callable = true;
  return out;
}

// ------------------------------------------------------------------ run

const OPS = { context, safeDelete, signatureInfo, changeSignature, pullUpInfo, pullMembersUp, introduceVariable, introduceConstant, inlineVariable, moveTypeToFile };

function run(op, deps, params) {
  const fn = OPS[op];
  if (!fn) throw new Error(`Unknown refactoring: ${op}`);
  const s = session(deps, params);
  try {
    return fn(s, params);
  } finally {
    s.done();
  }
}

module.exports = { run, RefactorError, applyEdits, removalEdit, offsetOf };
