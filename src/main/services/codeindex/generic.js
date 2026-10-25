'use strict';
// Knowledge-graph analysis for Go, Java, Rust, C/C++, Ruby, PHP and Bash: definitions with their
// containers, call sites, type references, imports, inheritance, variable reads/writes and each
// function's locals, in the same shape as the C#/Python/JavaScript analysis (see analyzer.js).

const SELF = 1;
const MEMBER = 2;
const LOCAL = 4;
const PARAM = 8;

/** Children of `node` with the given field name (all of them, unlike childForFieldName). */
function fieldChildren(node, field) {
  const out = [];
  const c = node.walk();
  if (c.gotoFirstChild()) {
    do {
      if (c.currentFieldName === field) out.push(c.currentNode);
    } while (c.gotoNextSibling());
  }
  c.delete();
  return out;
}

const named = (node, type) => node.namedChildren.filter((c) => c && (!type || c.type === type));
const isNamedNode = (c) => (typeof c.isNamed === 'function' ? c.isNamed() : c.isNamed);

/** The operator token of an assignment node ('=', '+=', ...). */
function operatorOf(node) {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!isNamedNode(c) && /=$/.test(c.type) && c.type !== '==' && c.type !== '!=' && c.type !== '<=' && c.type !== '>=') return c.type;
  }
  const op = node.childForFieldName('operator');
  return op ? op.text : '=';
}

/** Collects analysis results while one file is walked. */
function collector(src, helpers) {
  const C = {
    defs: [],
    calls: [],
    bases: [],
    imports: [],
    uses: [],
    locals: [],
    localUses: [],
    counts: new Map(),
    scopes: [],
    containers: [],
    skipped: new Set(),
    fields: new Map(),
  };
  C.skip = (n) => n && C.skipped.add(n.id);
  C.isSkipped = (n) => C.skipped.has(n.id);
  C.count = (name) => C.counts.set(name, (C.counts.get(name) || 0) + 1);
  C.containerPath = () => C.containers.map((c) => c.name).filter(Boolean).join('.');
  C.pushContainer = (name, node) => C.containers.push({ name, id: node.id });
  C.pushScope = (node, extra = {}) => C.scopes.push({ id: node.id, names: new Map(), ...extra });
  C.leave = (node) => {
    if (C.containers.length && C.containers[C.containers.length - 1].id === node.id) C.containers.pop();
    if (C.scopes.length && C.scopes[C.scopes.length - 1].id === node.id) C.scopes.pop();
  };
  C.inScope = () => C.scopes.length > 0;
  C.self = () => {
    for (let i = C.scopes.length - 1; i >= 0; i--) if (C.scopes[i].self) return C.scopes[i].self;
    return null;
  };
  C.lookup = (name) => {
    for (let i = C.scopes.length - 1; i >= 0; i--) {
      const v = C.scopes[i].names.get(name);
      if (v) return v;
    }
    return null;
  };
  C.addDef = (nameNode, kind, declNode, opts = {}) => {
    const name = opts.name || nameNode.text;
    if (!name) return -1;
    C.defs.push({
      name,
      kind,
      line: nameNode.startPosition.row + 1,
      col: nameNode.startPosition.column + 1,
      endCol: nameNode.endPosition.column + 1,
      start: declNode.startPosition.row + 1,
      end: declNode.endPosition.row + 1,
      container: opts.container != null ? opts.container : C.containerPath(),
      sig: ['function', 'method', 'constructor', 'class', 'struct', 'interface', 'enum', 'record'].includes(kind) ? helpers.signature(declNode) : '',
      h: helpers.hash(helpers.squash(src.slice(declNode.startIndex, declNode.endIndex))),
    });
    C.skip(nameNode);
    return C.defs.length - 1;
  };
  /** Declare a local or parameter in the innermost scope (once). */
  C.declare = (nameNode, kind = 'local', name = nameNode.text) => {
    if (!C.scopes.length) return false;
    const s = C.scopes[C.scopes.length - 1];
    if (s.names.has(name)) return false;
    s.names.set(name, kind);
    C.locals.push([-1, name, nameNode.startPosition.row + 1, kind]);
    return true;
  };
  C.use = (node, mode, flags, name = node.text) => {
    if (flags & (LOCAL | PARAM)) C.localUses.push([node.startPosition.row + 1, name, mode]);
    else C.uses.push([-1, name, node.startPosition.row + 1, node.startPosition.column + 1, mode, flags]);
    C.skip(node);
  };
  /** A plain name: a local/parameter use, or a use of a module variable / implicit member. */
  C.ref = (node, mode, name = node.text) => {
    const role = C.lookup(name);
    if (role === 'self') return C.skip(node);
    if (role === 'local' || role === 'parameter') return C.use(node, mode, role === 'parameter' ? PARAM : LOCAL, name);
    return C.use(node, mode, 0, name);
  };
  C.call = (nameNode, kind = 'call', name = nameNode.text) => {
    if (!nameNode || !name) return;
    C.calls.push([-1, name, nameNode.startPosition.row + 1, nameNode.startPosition.column + 1, kind]);
    C.skip(nameNode);
  };
  C.base = (ownerIdx, nameNode) => nameNode && C.bases.push([ownerIdx, nameNode.text.replace(/<.*$/, '')]);
  C.fieldSeen = (name) => {
    const key = C.containerPath();
    if (!C.fields.has(key)) C.fields.set(key, new Set());
    const set = C.fields.get(key);
    if (set.has(name)) return true;
    set.add(name);
    return false;
  };
  return C;
}

// ------------------------------------------------------------------- Go

function goTypeName(t) {
  if (!t) return '';
  if (t.type === 'pointer_type') return goTypeName(named(t)[0]);
  if (t.type === 'generic_type') return goTypeName(t.childForFieldName('type'));
  return t.type === 'type_identifier' ? t.text : '';
}

function goMode(target) {
  let p = target.parent;
  let child = target;
  if (p && p.type === 'expression_list') {
    child = p;
    p = p.parent;
  }
  if (p && p.type === 'assignment_statement' && p.childForFieldName('left') && p.childForFieldName('left').id === child.id) return operatorOf(p) === '=' ? 'w' : 'rw';
  if (p && (p.type === 'inc_statement' || p.type === 'dec_statement')) return 'rw';
  return 'r';
}

const GO = {
  enter(f, stack, C) {
    const t = f.type;
    const n = f.node;
    if (t === 'comment' || t === 'interpreted_string_literal' || t === 'raw_string_literal' || t === 'rune_literal' || t === 'package_clause') return false;
    if (t === 'import_spec') {
      const p = n.childForFieldName('path');
      if (p) C.imports.push([p.text.replace(/^["`]|["`]$/g, ''), 0, n.startPosition.row + 1]);
      return false;
    }
    if (t === 'function_declaration' || t === 'method_declaration' || t === 'func_literal') {
      let container = '';
      let self = null;
      if (t === 'method_declaration') {
        const recv = n.childForFieldName('receiver');
        const pd = recv && named(recv, 'parameter_declaration')[0];
        if (pd) {
          const nm = pd.childForFieldName('name');
          self = nm ? nm.text : null;
          container = goTypeName(pd.childForFieldName('type'));
          if (nm) C.skip(nm);
        }
      }
      if (t !== 'func_literal') {
        const nm = n.childForFieldName('name');
        if (nm) C.addDef(nm, t === 'method_declaration' ? 'method' : 'function', n, { container });
      }
      C.pushScope(n, self ? { self } : {});
      if (self) C.scopes[C.scopes.length - 1].names.set(self, 'self');
      return true;
    }
    if (t === 'type_spec') {
      const nm = n.childForFieldName('name');
      const ty = n.childForFieldName('type');
      if (nm) {
        C.addDef(nm, ty && ty.type === 'struct_type' ? 'struct' : ty && ty.type === 'interface_type' ? 'interface' : 'class', n);
        C.pushContainer(nm.text, n);
      }
      return true;
    }
    if (t === 'field_declaration' && C.containers.length) {
      for (const nm of fieldChildren(n, 'name')) C.addDef(nm, 'field', n);
      return true;
    }
    if (t === 'method_elem' || t === 'method_spec') {
      const nm = n.childForFieldName('name');
      if (nm) C.addDef(nm, 'method', n);
      return false;
    }
    if (t === 'var_spec' || t === 'const_spec') {
      const names = fieldChildren(n, 'name');
      if (!C.inScope()) for (const nm of names) C.addDef(nm, t === 'const_spec' ? 'constant' : 'variable', n, { container: '' });
      else for (const nm of names) {
        C.declare(nm, 'local');
        if (n.childForFieldName('value')) C.use(nm, 'w', LOCAL);
        else C.skip(nm);
      }
      return true;
    }
    if (t === 'short_var_declaration' || (t === 'range_clause' && C.inScope())) {
      const left = n.childForFieldName('left');
      for (const nm of left ? named(left, 'identifier') : []) {
        if (nm.text === '_') {
          C.skip(nm);
          continue;
        }
        C.declare(nm, 'local');
        C.use(nm, 'w', LOCAL);
      }
      return true;
    }
    if (t === 'parameter_declaration' || t === 'variadic_parameter_declaration') {
      for (const nm of fieldChildren(n, 'name')) {
        if (C.isSkipped(nm)) continue;
        C.declare(nm, 'parameter');
        C.skip(nm);
      }
      return true;
    }
    if (t === 'call_expression') {
      const fn = n.childForFieldName('function');
      if (fn && fn.type === 'identifier') C.call(fn);
      else if (fn && fn.type === 'selector_expression') C.call(fn.childForFieldName('field'));
      return true;
    }
    if (t === 'selector_expression') {
      const field = n.childForFieldName('field');
      const op = n.childForFieldName('operand');
      if (field && !C.isSkipped(field)) {
        C.count(field.text);
        C.use(field, goMode(n), op && op.type === 'identifier' && op.text === C.self() ? SELF : MEMBER);
      }
      return true;
    }
    if (t === 'type_identifier' && !C.isSkipped(n)) {
      C.call(n, 'type');
      return false;
    }
    if (t === 'identifier' && !C.isSkipped(n)) {
      if (n.text === '_') return false;
      C.count(n.text);
      C.ref(n, goMode(n));
      return false;
    }
    if (t === 'field_identifier' && !C.isSkipped(n)) {
      C.count(n.text);
      return false;
    }
    return true;
  },
};

// ----------------------------------------------------------------- Java

function javaMode(target) {
  const p = target.parent;
  if (!p) return 'r';
  if (p.type === 'assignment_expression' && p.childForFieldName('left') && p.childForFieldName('left').id === target.id) return operatorOf(p) === '=' ? 'w' : 'rw';
  if (p.type === 'update_expression') return 'rw';
  return 'r';
}

const JAVA_TYPES = { class_declaration: 'class', interface_declaration: 'interface', enum_declaration: 'enum', record_declaration: 'record', annotation_type_declaration: 'interface' };

const JAVA = {
  enter(f, stack, C) {
    const t = f.type;
    const n = f.node;
    if (t === 'line_comment' || t === 'block_comment' || t === 'string_literal' || t === 'character_literal' || t === 'text_block' || t === 'package_declaration') return false;
    if (t === 'import_declaration') {
      const id = named(n).find((c) => /identifier/.test(c.type));
      if (id) C.imports.push([id.text, 0, n.startPosition.row + 1]);
      return false;
    }
    if (JAVA_TYPES[t]) {
      const nm = n.childForFieldName('name');
      if (!nm) return true;
      const idx = C.addDef(nm, JAVA_TYPES[t], n);
      const sup = n.childForFieldName('superclass');
      if (sup) for (const ty of named(sup).filter((c) => /type_identifier|generic_type/.test(c.type))) C.base(idx, ty.type === 'generic_type' ? named(ty)[0] : ty);
      const ifs = n.childForFieldName('interfaces');
      const list = ifs && named(ifs, 'type_list')[0];
      if (list) for (const ty of named(list)) C.base(idx, ty.type === 'generic_type' ? named(ty)[0] : ty);
      C.pushContainer(nm.text, n);
      return true;
    }
    if (t === 'method_declaration' || t === 'constructor_declaration' || t === 'compact_constructor_declaration') {
      const nm = n.childForFieldName('name');
      if (nm) C.addDef(nm, t === 'method_declaration' ? 'method' : 'constructor', n);
      C.pushScope(n, { self: 'this' });
      return true;
    }
    if (t === 'lambda_expression') {
      C.pushScope(n);
      const ps = n.childForFieldName('parameters');
      if (ps && ps.type === 'identifier') {
        C.declare(ps, 'parameter');
        C.skip(ps);
      } else if (ps) for (const id of named(ps, 'identifier')) {
        C.declare(id, 'parameter');
        C.skip(id);
      }
      return true;
    }
    if (t === 'field_declaration' || t === 'constant_declaration') {
      const mods = named(n, 'modifiers')[0];
      const isConst = t === 'constant_declaration' || (mods && /\bstatic\b/.test(mods.text) && /\bfinal\b/.test(mods.text));
      for (const d of fieldChildren(n, 'declarator')) {
        const nm = d.childForFieldName('name');
        if (nm) C.addDef(nm, isConst || /^[A-Z][A-Z0-9_]+$/.test(nm.text) ? 'constant' : 'field', n);
      }
      return true;
    }
    if (t === 'formal_parameter' || t === 'spread_parameter' || t === 'catch_formal_parameter' || t === 'receiver_parameter') {
      const nm = n.childForFieldName('name') || named(n, 'variable_declarator').map((v) => v.childForFieldName('name'))[0] || named(n, 'identifier').pop();
      if (nm) {
        C.declare(nm, 'parameter');
        C.skip(nm);
      }
      return true;
    }
    if (t === 'local_variable_declaration' || t === 'resource') {
      for (const d of t === 'resource' ? [n] : fieldChildren(n, 'declarator')) {
        const nm = d.childForFieldName('name');
        if (!nm) continue;
        C.declare(nm, 'local');
        if (d.childForFieldName('value')) C.use(nm, 'w', LOCAL);
        else C.skip(nm);
      }
      return true;
    }
    if (t === 'enhanced_for_statement') {
      const nm = n.childForFieldName('name');
      if (nm) {
        C.declare(nm, 'local');
        C.use(nm, 'w', LOCAL);
      }
      return true;
    }
    if (t === 'method_invocation') {
      C.call(n.childForFieldName('name'));
      return true;
    }
    if (t === 'object_creation_expression') {
      const ty = n.childForFieldName('type');
      C.call(ty && ty.type === 'generic_type' ? named(ty)[0] : ty, 'new');
      return true;
    }
    if (t === 'field_access') {
      const field = n.childForFieldName('field');
      const obj = n.childForFieldName('object');
      if (field && !C.isSkipped(field)) {
        C.count(field.text);
        C.use(field, javaMode(n), obj && obj.type === 'this' ? SELF : MEMBER);
      }
      return true;
    }
    if (t === 'type_identifier' && !C.isSkipped(n)) {
      C.call(n, 'type');
      return false;
    }
    if (t === 'identifier' && !C.isSkipped(n)) {
      C.count(n.text);
      const p = n.parent;
      if (p && (p.type === 'scoped_identifier' || p.type === 'marker_annotation' || p.type === 'annotation')) return false;
      C.ref(n, javaMode(n));
      return false;
    }
    return true;
  },
};

// ----------------------------------------------------------------- Rust

function rustMode(target) {
  const p = target.parent;
  if (!p) return 'r';
  const left = p.childForFieldName('left');
  if (p.type === 'assignment_expression' && left && left.id === target.id) return 'w';
  if (p.type === 'compound_assignment_expr' && left && left.id === target.id) return 'rw';
  return 'r';
}

function rustTypeName(t) {
  if (!t) return '';
  if (t.type === 'generic_type') return rustTypeName(t.childForFieldName('type'));
  if (t.type === 'scoped_type_identifier') return (t.childForFieldName('name') || t).text;
  return t.type === 'type_identifier' ? t.text : '';
}

function rustPatternNames(p) {
  if (!p) return [];
  if (p.type === 'identifier') return [p];
  if (p.type === 'mut_pattern' || p.type === 'ref_pattern') return rustPatternNames(named(p)[0]);
  if (/tuple_pattern|slice_pattern|tuple_struct_pattern|struct_pattern|or_pattern/.test(p.type)) return named(p).flatMap(rustPatternNames);
  return [];
}

const RUST = {
  enter(f, stack, C) {
    const t = f.type;
    const n = f.node;
    if (t === 'line_comment' || t === 'block_comment' || t === 'string_literal' || t === 'raw_string_literal' || t === 'char_literal' || t === 'attribute_item' || t === 'inner_attribute_item') return false;
    if (t === 'use_declaration') {
      const a = n.childForFieldName('argument');
      if (a) C.imports.push([a.text, 0, n.startPosition.row + 1]);
      return false;
    }
    if (t === 'mod_item') {
      const nm = n.childForFieldName('name');
      if (nm && n.childForFieldName('body')) {
        C.addDef(nm, 'namespace', n);
        C.pushContainer(nm.text, n);
      }
      return true;
    }
    if (t === 'struct_item' || t === 'enum_item' || t === 'trait_item' || t === 'union_item' || t === 'type_item') {
      const nm = n.childForFieldName('name');
      if (nm) {
        C.addDef(nm, t === 'struct_item' || t === 'union_item' ? 'struct' : t === 'enum_item' ? 'enum' : t === 'trait_item' ? 'interface' : 'class', n);
        C.pushContainer(nm.text, n);
      }
      return true;
    }
    if (t === 'impl_item') {
      C.pushContainer(rustTypeName(n.childForFieldName('type')), n);
      return true;
    }
    if (t === 'function_item' || t === 'function_signature_item') {
      const nm = n.childForFieldName('name');
      if (nm) C.addDef(nm, C.containers.length ? 'method' : 'function', n);
      if (t === 'function_item') C.pushScope(n, { self: 'self' });
      return t === 'function_item';
    }
    if (t === 'closure_expression') {
      C.pushScope(n);
      const ps = n.childForFieldName('parameters');
      if (ps) for (const p of named(ps)) for (const id of rustPatternNames(p.type === 'parameter' ? p.childForFieldName('pattern') : p)) {
        C.declare(id, 'parameter');
        C.skip(id);
      }
      return true;
    }
    if (t === 'static_item' || t === 'const_item') {
      const nm = n.childForFieldName('name');
      if (nm) C.addDef(nm, t === 'const_item' ? 'constant' : 'variable', n);
      return true;
    }
    if (t === 'field_declaration' && C.containers.length) {
      const nm = n.childForFieldName('name');
      if (nm) C.addDef(nm, 'field', n);
      return true;
    }
    if (t === 'parameter') {
      for (const id of rustPatternNames(n.childForFieldName('pattern'))) {
        C.declare(id, 'parameter');
        C.skip(id);
      }
      return true;
    }
    if (t === 'self_parameter') return false;
    if (t === 'let_declaration') {
      for (const id of rustPatternNames(n.childForFieldName('pattern'))) {
        C.declare(id, 'local');
        if (n.childForFieldName('value')) C.use(id, 'w', LOCAL);
        else C.skip(id);
      }
      return true;
    }
    if (t === 'for_expression') {
      for (const id of rustPatternNames(n.childForFieldName('pattern'))) {
        C.declare(id, 'local');
        C.use(id, 'w', LOCAL);
      }
      return true;
    }
    if (t === 'call_expression') {
      const fn = n.childForFieldName('function');
      if (fn && fn.type === 'identifier') C.call(fn);
      else if (fn && fn.type === 'field_expression') C.call(fn.childForFieldName('field'));
      else if (fn && fn.type === 'scoped_identifier') C.call(fn.childForFieldName('name'));
      else if (fn && fn.type === 'generic_function') {
        const inner = fn.childForFieldName('function');
        C.call(inner && inner.type === 'scoped_identifier' ? inner.childForFieldName('name') : inner);
      }
      return true;
    }
    if (t === 'field_expression') {
      const field = n.childForFieldName('field');
      const val = n.childForFieldName('value');
      if (field && !C.isSkipped(field)) {
        C.count(field.text);
        if (field.type !== 'integer_literal') C.use(field, rustMode(n), val && val.type === 'self' ? SELF : MEMBER);
      }
      return true;
    }
    if (t === 'type_identifier' && !C.isSkipped(n)) {
      C.call(n, 'type');
      return false;
    }
    if (t === 'identifier' && !C.isSkipped(n)) {
      C.count(n.text);
      const p = n.parent;
      if (p && (p.type === 'scoped_identifier' || p.type === 'macro_invocation')) return false;
      C.ref(n, rustMode(n));
      return false;
    }
    return true;
  },
};

// ---------------------------------------------------------------- C/C++

function cMode(target) {
  const p = target.parent;
  if (!p) return 'r';
  if (p.type === 'assignment_expression' && p.childForFieldName('left') && p.childForFieldName('left').id === target.id) return operatorOf(p) === '=' ? 'w' : 'rw';
  if (p.type === 'update_expression') return 'rw';
  return 'r';
}

/** The name node a declarator declares (through pointer / reference / array / init declarators). */
function cDeclName(d) {
  while (d && /pointer_declarator|reference_declarator|array_declarator|init_declarator|parenthesized_declarator|attributed_declarator/.test(d.type)) d = d.childForFieldName('declarator') || named(d)[0];
  return d;
}

function cFunctionDeclarator(d) {
  while (d && d.type !== 'function_declarator') d = d.childForFieldName('declarator');
  return d;
}

const CPP_TYPES = { class_specifier: 'class', struct_specifier: 'struct', union_specifier: 'struct', enum_specifier: 'enum' };

const CPP = {
  enter(f, stack, C) {
    const t = f.type;
    const n = f.node;
    if (t === 'comment' || t === 'string_literal' || t === 'raw_string_literal' || t === 'char_literal' || t === 'concatenated_string') return false;
    if (t === 'preproc_include') {
      const p = n.childForFieldName('path');
      if (p) C.imports.push([p.text.replace(/^[<"]|[>"]$/g, ''), 0, n.startPosition.row + 1]);
      return false;
    }
    if (t === 'namespace_definition') {
      const nm = n.childForFieldName('name');
      if (nm) {
        C.addDef(nm, 'namespace', n);
        C.pushContainer(nm.text, n);
      }
      return true;
    }
    if (CPP_TYPES[t]) {
      const nm = n.childForFieldName('name');
      const body = n.childForFieldName('body');
      if (nm && body) {
        const idx = C.addDef(nm, CPP_TYPES[t], n);
        for (const bc of named(n, 'base_class_clause')) for (const ty of named(bc).filter((c) => /type_identifier|qualified_identifier|template_type/.test(c.type))) C.base(idx, ty.type === 'template_type' ? ty.childForFieldName('name') : ty);
        C.pushContainer(nm.text, n);
      } else if (nm) C.call(nm, 'type');
      return true;
    }
    if (t === 'function_definition') {
      const fd = cFunctionDeclarator(n.childForFieldName('declarator'));
      const d = fd && fd.childForFieldName('declarator');
      let nameNode = d;
      let container;
      if (d && d.type === 'qualified_identifier') {
        nameNode = d.childForFieldName('name');
        const scope = d.childForFieldName('scope');
        container = [C.containerPath(), scope ? scope.text.replace(/<.*$/, '') : ''].filter(Boolean).join('.');
      }
      if (nameNode && /identifier|destructor_name|operator_name/.test(nameNode.type)) C.addDef(nameNode, container != null || C.containers.some((c) => c.kind !== 'ns') ? 'method' : 'function', n, container != null ? { container } : {});
      C.pushScope(n, { self: 'this' });
      return true;
    }
    if (t === 'lambda_expression') {
      C.pushScope(n);
      return true;
    }
    if (t === 'field_declaration') {
      for (const d of fieldChildren(n, 'declarator')) {
        if (cFunctionDeclarator(d)) continue; // method prototype
        const nm = cDeclName(d);
        if (nm && nm.type === 'field_identifier') C.addDef(nm, 'field', n);
      }
      return true;
    }
    if (t === 'parameter_declaration' || t === 'optional_parameter_declaration') {
      const nm = cDeclName(n.childForFieldName('declarator'));
      if (nm && nm.type === 'identifier') {
        C.declare(nm, 'parameter');
        C.skip(nm);
      }
      return true;
    }
    if (t === 'declaration') {
      const isConst = named(n, 'type_qualifier').some((q) => q.text === 'const' || q.text === 'constexpr');
      for (const d of fieldChildren(n, 'declarator')) {
        if (cFunctionDeclarator(d)) continue;
        const nm = cDeclName(d);
        if (!nm || nm.type !== 'identifier') continue;
        if (!C.inScope()) C.addDef(nm, isConst ? 'constant' : 'variable', n);
        else {
          C.declare(nm, 'local');
          if (d.type === 'init_declarator') C.use(nm, 'w', LOCAL);
          else C.skip(nm);
        }
      }
      return true;
    }
    if (t === 'call_expression') {
      const fn = n.childForFieldName('function');
      if (fn && fn.type === 'identifier') C.call(fn);
      else if (fn && fn.type === 'field_expression') C.call(fn.childForFieldName('field'));
      else if (fn && fn.type === 'qualified_identifier') C.call(fn.childForFieldName('name'));
      else if (fn && fn.type === 'template_function') C.call(fn.childForFieldName('name'));
      return true;
    }
    if (t === 'field_expression') {
      const field = n.childForFieldName('field');
      const arg = n.childForFieldName('argument');
      if (field && !C.isSkipped(field)) {
        C.count(field.text);
        C.use(field, cMode(n), arg && arg.type === 'this' ? SELF : MEMBER);
      }
      return true;
    }
    if (t === 'type_identifier' && !C.isSkipped(n)) {
      C.call(n, 'type');
      return false;
    }
    if (t === 'identifier' && !C.isSkipped(n)) {
      C.count(n.text);
      C.ref(n, cMode(n));
      return false;
    }
    return true;
  },
};

// ----------------------------------------------------------------- Ruby

function rubyMode(target) {
  const p = target.parent;
  if (!p) return 'r';
  const left = p.childForFieldName('left');
  if (left && left.id === target.id) return p.type === 'operator_assignment' ? 'rw' : p.type === 'assignment' ? 'w' : 'r';
  return 'r';
}

const RUBY = {
  enter(f, stack, C) {
    const t = f.type;
    const n = f.node;
    if (t === 'comment') return false;
    if (t === 'string' || t === 'heredoc_body') return named(n).some((c) => c.type === 'interpolation');
    if (t === 'class' || t === 'module') {
      const nm = n.childForFieldName('name');
      if (nm) {
        const idx = C.addDef(nm, t === 'class' ? 'class' : 'namespace', n, { name: nm.text.split('::').pop() });
        const sup = n.childForFieldName('superclass');
        if (sup) C.base(idx, named(sup)[0]);
        C.pushContainer(nm.text.split('::').pop(), n);
      }
      return true;
    }
    if (t === 'method' || t === 'singleton_method') {
      const nm = n.childForFieldName('name');
      if (nm) C.addDef(nm, C.containers.length || t === 'singleton_method' ? 'method' : 'function', n);
      C.pushScope(n, { self: 'self' });
      const ps = n.childForFieldName('parameters');
      if (ps) for (const p of named(ps)) {
        const id = p.type === 'identifier' ? p : p.childForFieldName('name');
        if (id) {
          C.declare(id, 'parameter');
          C.skip(id);
        }
      }
      return true;
    }
    if (t === 'block' || t === 'do_block' || t === 'lambda') {
      C.pushScope(n);
      const ps = n.childForFieldName('parameters');
      if (ps) for (const id of named(ps, 'identifier')) {
        C.declare(id, 'parameter');
        C.skip(id);
      }
      return true;
    }
    if (t === 'assignment' || t === 'operator_assignment') {
      const left = n.childForFieldName('left');
      if (left && left.type === 'constant' && t === 'assignment') C.addDef(left, 'constant', n);
      else if (left && (left.type === 'instance_variable' || left.type === 'class_variable')) {
        if (C.containers.length && !C.fieldSeen(left.text)) {
          const scopeNode = n;
          C.defs.push({ name: left.text, kind: 'field', line: left.startPosition.row + 1, col: left.startPosition.column + 1, endCol: left.endPosition.column + 1, start: scopeNode.startPosition.row + 1, end: scopeNode.endPosition.row + 1, container: C.containerPath(), sig: '', h: '' });
        }
        C.use(left, rubyMode(left), SELF);
      } else if (left && left.type === 'identifier') {
        if (C.inScope()) {
          if (t === 'assignment') C.declare(left, 'local');
          C.use(left, rubyMode(left), C.lookup(left.text) === 'parameter' ? PARAM : LOCAL);
        } else if (t === 'assignment') C.addDef(left, 'variable', n);
      }
      return true;
    }
    if (t === 'call') {
      const m = n.childForFieldName('method');
      const recv = n.childForFieldName('receiver');
      if (m && !recv && /^require(_relative)?$/.test(m.text)) {
        const arg = n.childForFieldName('arguments');
        const s = arg && named(arg).find((c) => c.type === 'string');
        if (s) C.imports.push([s.text.replace(/^["']|["']$/g, ''), 0, n.startPosition.row + 1]);
        C.skip(m);
        return false;
      }
      if (m) C.call(m);
      return true;
    }
    if (t === 'instance_variable' || t === 'class_variable') {
      if (!C.isSkipped(n)) {
        C.count(n.text);
        C.use(n, rubyMode(n), SELF);
      }
      return false;
    }
    if (t === 'constant' && !C.isSkipped(n)) {
      C.count(n.text);
      const p = n.parent;
      if (p && p.type === 'scope_resolution') return false;
      if (/^[A-Z][A-Z0-9_]+$/.test(n.text)) C.use(n, 'r', 0);
      else C.call(n, 'type');
      return false;
    }
    if (t === 'identifier' && !C.isSkipped(n)) {
      C.count(n.text);
      const role = C.lookup(n.text);
      if (role === 'local' || role === 'parameter') C.use(n, rubyMode(n), role === 'parameter' ? PARAM : LOCAL);
      else C.call(n); // a bare name that is not a local is a method call
      return false;
    }
    return true;
  },
};

// ------------------------------------------------------------------ PHP

function phpMode(target) {
  const p = target.parent;
  if (!p) return 'r';
  const left = p.childForFieldName('left');
  if (left && left.id === target.id) return p.type === 'augmented_assignment_expression' ? 'rw' : p.type === 'assignment_expression' ? 'w' : 'r';
  if (p.type === 'update_expression') return 'rw';
  return 'r';
}

const varName = (v) => {
  const nm = v && named(v, 'name')[0];
  return nm ? nm.text : v ? v.text.replace(/^\$/, '') : '';
};

const PHP_TYPES = { class_declaration: 'class', interface_declaration: 'interface', trait_declaration: 'class', enum_declaration: 'enum' };

const PHP = {
  enter(f, stack, C) {
    const t = f.type;
    const n = f.node;
    if (t === 'comment' || t === 'text' || t === 'php_tag' || t === 'string' || t === 'nowdoc') return false;
    if (t === 'encapsed_string' || t === 'heredoc') return named(n).some((c) => c.type === 'variable_name' || c.type === 'member_access_expression');
    if (t === 'namespace_definition') {
      const nm = n.childForFieldName('name');
      if (nm) C.skip(nm);
      return true;
    }
    if (t === 'namespace_use_clause') {
      C.imports.push([n.text, 0, n.startPosition.row + 1]);
      return false;
    }
    if (PHP_TYPES[t]) {
      const nm = n.childForFieldName('name');
      if (!nm) return true;
      const idx = C.addDef(nm, PHP_TYPES[t], n);
      for (const clause of [...named(n, 'base_clause'), ...named(n, 'class_interface_clause')]) for (const b of named(clause)) C.base(idx, b.type === 'qualified_name' ? named(b, 'name').pop() : b);
      C.pushContainer(nm.text, n);
      return true;
    }
    if (t === 'function_definition' || t === 'method_declaration') {
      const nm = n.childForFieldName('name');
      if (nm) C.addDef(nm, t === 'method_declaration' ? 'method' : 'function', n);
      C.pushScope(n, { self: 'this' });
      return true;
    }
    if (t === 'anonymous_function' || t === 'arrow_function' || t === 'anonymous_function_creation_expression') {
      C.pushScope(n);
      return true;
    }
    if (t === 'property_element') {
      const v = n.childForFieldName('name') || named(n, 'variable_name')[0];
      if (v) {
        C.addDef(v, 'field', n.parent || n, { name: varName(v) });
        for (const c of named(v)) C.skip(c);
      }
      return true;
    }
    if (t === 'const_element') {
      const nm = named(n, 'name')[0];
      if (nm) C.addDef(nm, 'constant', n);
      return true;
    }
    if (t === 'simple_parameter' || t === 'variadic_parameter' || t === 'property_promotion_parameter') {
      const v = n.childForFieldName('name');
      if (v) {
        if (t === 'property_promotion_parameter' && C.containers.length && !C.fieldSeen(varName(v))) C.addDef(v, 'field', n, { name: varName(v) });
        C.declare(v, 'parameter', varName(v));
        C.skip(v);
        for (const c of named(v)) C.skip(c);
      }
      return true;
    }
    if (t === 'function_call_expression') {
      const fn = n.childForFieldName('function');
      if (fn && fn.type === 'name') C.call(fn);
      else if (fn && fn.type === 'qualified_name') C.call(named(fn, 'name').pop());
      return true;
    }
    if (t === 'member_call_expression' || t === 'nullsafe_member_call_expression' || t === 'scoped_call_expression') {
      const nm = n.childForFieldName('name');
      if (nm && nm.type === 'name') C.call(nm);
      return true;
    }
    if (t === 'object_creation_expression') {
      const nm = named(n).find((c) => c.type === 'name' || c.type === 'qualified_name');
      if (nm) C.call(nm.type === 'qualified_name' ? named(nm, 'name').pop() : nm, 'new');
      return true;
    }
    if (t === 'member_access_expression' || t === 'nullsafe_member_access_expression') {
      const nm = n.childForFieldName('name');
      const obj = n.childForFieldName('object');
      if (nm && nm.type === 'name' && !C.isSkipped(nm)) {
        C.count(nm.text);
        C.use(nm, phpMode(n), obj && obj.type === 'variable_name' && varName(obj) === 'this' ? SELF : MEMBER);
      }
      return true;
    }
    if (t === 'variable_name' && !C.isSkipped(n)) {
      const name = varName(n);
      for (const c of named(n)) C.skip(c);
      if (name === 'this') return false;
      C.count(name);
      const p = n.parent;
      const isTarget = p && p.type === 'assignment_expression' && p.childForFieldName('left') && p.childForFieldName('left').id === n.id;
      if (isTarget && C.inScope()) C.declare(n, 'local', name);
      const role = C.lookup(name);
      C.use(n, phpMode(n), role === 'parameter' ? PARAM : role === 'local' ? LOCAL : 0, name);
      return false;
    }
    if (t === 'name' && !C.isSkipped(n)) {
      C.count(n.text);
      const p = n.parent;
      if (p && (p.type === 'qualified_name' || p.type === 'namespace_name')) return false;
      if (/^[A-Z][A-Z0-9_]+$/.test(n.text)) C.use(n, 'r', 0);
      else C.call(n, 'type');
      return false;
    }
    return true;
  },
};

// ----------------------------------------------------------------- Bash

const BASH = {
  enter(f, stack, C) {
    const t = f.type;
    const n = f.node;
    if (t === 'comment' || t === 'raw_string' || t === 'heredoc_body') return false;
    if (t === 'function_definition') {
      const nm = n.childForFieldName('name');
      if (nm) C.addDef(nm, 'function', n);
      C.pushScope(n);
      return true;
    }
    if (t === 'declaration_command') {
      const kw = n.child(0);
      const isLocal = kw && /^(local|declare|typeset|readonly)$/.test(kw.text) && C.inScope();
      for (const a of named(n, 'variable_assignment')) {
        const nm = a.childForFieldName('name');
        if (!nm) continue;
        if (isLocal) {
          C.declare(nm, 'local');
          C.use(nm, 'w', LOCAL);
        } else if (!C.inScope()) C.addDef(nm, 'variable', a, { container: '' });
        else C.use(nm, 'w', 0);
      }
      for (const v of named(n, 'variable_name')) {
        if (isLocal) {
          C.declare(v, 'local');
          C.skip(v);
        }
      }
      return true;
    }
    if (t === 'variable_assignment') {
      const nm = n.childForFieldName('name');
      if (nm && !C.isSkipped(nm)) {
        const role = C.lookup(nm.text);
        if (role === 'local' || role === 'parameter') C.use(nm, 'w', LOCAL);
        else if (!C.inScope()) {
          if (!C.defs.some((d) => d.name === nm.text && d.kind === 'variable')) C.addDef(nm, 'variable', n, { container: '' });
          else C.skip(nm);
        } else C.use(nm, 'w', 0);
      }
      return true;
    }
    if (t === 'command') {
      const cn = n.childForFieldName('name');
      const w = cn && named(cn)[0];
      if (w && (w.text === 'source' || w.text === '.')) {
        const arg = named(n).find((c) => c !== cn);
        if (arg) C.imports.push([arg.text.replace(/^["']|["']$/g, ''), 0, n.startPosition.row + 1]);
      } else if (w && w.type === 'word') C.call(w);
      return true;
    }
    if (t === 'variable_name' && !C.isSkipped(n)) {
      C.count(n.text);
      if (/^[0-9#@?*!$-]$/.test(n.text)) return false;
      const role = C.lookup(n.text);
      C.use(n, 'r', role === 'local' ? LOCAL : role === 'parameter' ? PARAM : 0);
      return false;
    }
    return true;
  },
};

const HANDLERS = { go: GO, java: JAVA, rust: RUST, cpp: CPP, ruby: RUBY, php: PHP, bash: BASH };

/**
 * Analyze a file of one of the languages above. `helpers` provides traverse, signature(node), hash,
 * squash, attributeOwners, attributeUses, compactUses and summarizeLocals from analyzer.js.
 */
function analyzeGeneric(lang, src, parser, helpers) {
  const h = HANDLERS[lang];
  const tree = parser.parse(src);
  const C = collector(src, helpers);
  helpers.traverse(
    tree,
    (f, stack) => h.enter(f, stack, C) !== false,
    (f) => C.leave(f.node),
  );
  tree.delete();
  helpers.attributeOwners(C.defs, C.calls, C.bases);
  helpers.attributeUses(C.defs, C.uses, C.locals);
  return { defs: C.defs, counts: C.counts, calls: C.calls, bases: C.bases, imports: C.imports, tokens: null, uses: helpers.compactUses(C.uses), locals: helpers.summarizeLocals(C.locals, C.localUses, C.defs) };
}

module.exports = { analyzeGeneric, GENERIC_LANGS: Object.keys(HANDLERS) };
