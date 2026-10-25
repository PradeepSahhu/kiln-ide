'use strict';
// Tree-sitter analysis of one source file (C#, Python, JavaScript/TypeScript): definitions, call
// sites, inheritance, imports, identifier counts, semantic tokens, and variable usage (which
// functions read and write which module variables, fields and properties, plus their locals).
// Shared by the index worker and the knowledge-graph tools for agents.
const path = require('path');
const crypto = require('crypto');

const LANG_BY_EXT = { '.cs': 'csharp', '.py': 'python', '.pyi': 'python', '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript', '.go': 'go', '.java': 'java', '.rs': 'rust', '.c': 'cpp', '.h': 'cpp', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp', '.rb': 'ruby', '.php': 'php', '.sh': 'bash', '.bash': 'bash' };
const GRAMMAR = { csharp: 'tree-sitter-c-sharp.wasm', python: 'tree-sitter-python.wasm', typescript: 'tree-sitter-typescript.wasm', tsx: 'tree-sitter-tsx.wasm', javascript: 'tree-sitter-javascript.wasm', go: 'tree-sitter-go.wasm', java: 'tree-sitter-java.wasm', rust: 'tree-sitter-rust.wasm', cpp: 'tree-sitter-cpp.wasm', ruby: 'tree-sitter-ruby.wasm', php: 'tree-sitter-php.wasm', bash: 'tree-sitter-bash.wasm' };

// Semantic token legend shared with the renderer.
const TOKEN_TYPES = ['namespace', 'class', 'interface', 'struct', 'enum', 'typeParameter', 'parameter', 'local', 'field', 'property', 'enumMember', 'event', 'function', 'method', 'decorator', 'constant', 'builtin', 'selfKeyword', 'module', 'record', 'delegate', 'attribute'];
const TOKEN_MODIFIERS = ['declaration', 'static', 'readonly'];
const T = Object.fromEntries(TOKEN_TYPES.map((t, i) => [t, i]));

const TYPE_KINDS = new Set(['class', 'interface', 'struct', 'record', 'enum', 'delegate']);
const CALLABLE_KINDS = new Set(['method', 'function', 'constructor', 'delegate']);
const LENS_KINDS = new Set(['class', 'interface', 'struct', 'record', 'enum', 'method', 'function', 'property', 'delegate', 'event']);

const PY_BUILTINS = new Set('abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip __import__ Exception BaseException ValueError TypeError KeyError IndexError RuntimeError AttributeError ImportError ModuleNotFoundError NotImplementedError StopIteration StopAsyncIteration OSError IOError FileNotFoundError PermissionError TimeoutError ZeroDivisionError AssertionError LookupError ArithmeticError KeyboardInterrupt SystemExit GeneratorExit UnicodeError UnicodeDecodeError UnicodeEncodeError ConnectionError RecursionError MemoryError NameError SyntaxError Warning DeprecationWarning UserWarning NotADirectoryError IsADirectoryError'.split(' '));

// C# syntax node types that declare something, mapped to the kind of their `name` child.
const CS_DECL = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  struct_declaration: 'struct',
  record_declaration: 'record',
  record_struct_declaration: 'record',
  enum_declaration: 'enum',
  delegate_declaration: 'delegate',
  method_declaration: 'method',
  local_function_statement: 'function',
  constructor_declaration: 'constructor',
  destructor_declaration: 'method',
  property_declaration: 'property',
  indexer_declaration: 'property',
  event_declaration: 'event',
  enum_member_declaration: 'enumMember',
  namespace_declaration: 'namespace',
  file_scoped_namespace_declaration: 'namespace',
};
const CS_SCOPES = new Set(['method_declaration', 'local_function_statement', 'constructor_declaration', 'destructor_declaration', 'accessor_declaration', 'lambda_expression', 'anonymous_method_expression', 'operator_declaration', 'conversion_operator_declaration']);
const CS_CALLABLE_DECL = new Set(['method_declaration', 'local_function_statement', 'constructor_declaration', 'destructor_declaration', 'property_declaration', 'indexer_declaration', 'operator_declaration', 'conversion_operator_declaration', 'event_declaration']);
const CS_CONTAINERS = new Set(['class_declaration', 'interface_declaration', 'struct_declaration', 'record_declaration', 'record_struct_declaration', 'namespace_declaration', 'file_scoped_namespace_declaration', 'enum_declaration']);
const CS_TYPE_CONTEXT = new Set(['object_creation_expression', 'variable_declaration', 'parameter', 'property_declaration', 'base_list', 'type_argument_list', 'array_type', 'nullable_type', 'pointer_type', 'ref_type', 'cast_expression', 'typeof_expression', 'type_parameter_constraint', 'type_constraint', 'declaration_pattern', 'catch_declaration', 'tuple_element', 'default_expression', 'sizeof_expression', 'as_expression', 'is_expression', 'type_pattern', 'recursive_pattern', 'array_creation_expression', 'implicit_object_creation_expression', 'indexer_declaration', 'delegate_declaration', 'event_field_declaration', 'local_declaration_statement', 'explicit_interface_specifier', 'foreach_statement', 'primary_constructor_base_type']);

const TS_IDENT = new Set(['identifier', 'property_identifier', 'type_identifier', 'shorthand_property_identifier', 'shorthand_property_identifier_pattern', 'private_property_identifier']);
const TS_DECL = { class_declaration: 'class', abstract_class_declaration: 'class', interface_declaration: 'interface', type_alias_declaration: 'class', enum_declaration: 'enum', function_declaration: 'function', generator_function_declaration: 'function', method_definition: 'method', method_signature: 'method', abstract_method_signature: 'method', public_field_definition: 'property', field_definition: 'property' };

// Variable-use flags.
const SELF = 1; // self.x / this.x
const MEMBER = 2; // obj.x
const LOCAL = 4;
const PARAM = 8;
const TS_FN = new Set(['function_declaration', 'function_expression', 'arrow_function', 'method_definition', 'generator_function_declaration', 'generator_function', 'function']);

const { analyzeGeneric, GENERIC_LANGS } = require('./generic');

const GENERIC = new Set(GENERIC_LANGS);
const genericHelpers = {
  traverse: (...a) => traverse(...a),
  signature: (node) => {
    const text = node.text.slice(0, 600);
    return squash(/^\s*(def |function |[A-Za-z_][\w-]*\s*\(\)\s*\{)/.test(text) && !/[{;]\s*$/.test(text.split('\n')[0]) ? text.split('\n')[0] : text.split(/\{|=>|;/)[0]).slice(0, 240);
  },
  hash: (s) => hash(s),
  squash: (s) => squash(s),
  attributeOwners: (...a) => attributeOwners(...a),
  attributeUses: (...a) => attributeUses(...a),
  compactUses: (u) => compactUses(u),
  summarizeLocals: (...a) => summarizeLocals(...a),
};

/** Node types that are names (for Go to Definition and Find Usages across languages). */
const isIdentType = (type) => /identifier|^name$|^constant$|^word$|^variable_name$|^instance_variable$|^type_identifier$|^field_identifier$/.test(type);

let parsers = {};
let langs = {};
let kindResolver = () => ({ type: null, member: null });

/** Load the tree-sitter grammars from the @vscode/tree-sitter-wasm folder. */
async function loadLanguages(wasmDir) {
  const { Parser, Language } = require(path.join(wasmDir, 'tree-sitter.js'));
  await Parser.init({ locateFile: (f) => path.join(wasmDir, f) });
  for (const [lang, file] of Object.entries(GRAMMAR)) {
    langs[lang] = await Language.load(path.join(wasmDir, file));
    const p = new Parser();
    p.setLanguage(langs[lang]);
    parsers[lang] = p;
  }
  return parsers;
}

/** Semantic-token kinds of known names come from the index (types vs members). */
function setKindResolver(fn) {
  kindResolver = fn || (() => ({ type: null, member: null }));
}

const getParsers = () => parsers;
const langOf = (file) => LANG_BY_EXT[path.extname(file).toLowerCase()] || null;
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const squash = (s) => s.replace(/\s+/g, ' ').trim();

function knownKinds(name) {
  return kindResolver(name);
}

const isNamedNode = (c) => (typeof c.isNamed === 'function' ? c.isNamed() : c.isNamed);

/** C#: 'w' for x = ..., 'rw' for x += ... / x++, else 'r'. `target` is the identifier or member access. */
function csMode(target) {
  const p = target.parent;
  if (!p) return 'r';
  if (p.type === 'assignment_expression') {
    const left = p.childForFieldName('left');
    if (left && left.id === target.id) {
      for (let i = 0; i < p.childCount; i++) {
        const c = p.child(i);
        if (c.type === 'assignment_operator') return c.text === '=' ? 'w' : 'rw';
        if (!isNamedNode(c) && /=$/.test(c.type) && c.type !== '==') return c.type === '=' ? 'w' : 'rw';
      }
      return 'w';
    }
  }
  if ((p.type === 'postfix_unary_expression' || p.type === 'prefix_unary_expression') && /\+\+|--/.test(p.text)) return 'rw';
  return 'r';
}

/** Python: { mode } when the identifier is an assignment or loop target (possibly inside a pattern). */
function pyTarget(f, stack) {
  let child = f;
  let i = stack.length - 1;
  while (i >= 0 && /^(pattern_list|tuple_pattern|list_pattern|list_splat_pattern|parenthesized_expression)$/.test(stack[i].type)) {
    child = stack[i];
    i--;
  }
  const holder = stack[i];
  if (!holder || child.field !== 'left') return null;
  if (holder.type === 'assignment' || holder.type === 'for_statement' || holder.type === 'for_in_clause') return { mode: 'w' };
  if (holder.type === 'augmented_assignment') return { mode: 'rw' };
  return null;
}

/** Python: mode of an attribute access node (self.x) by its assignment context. */
function pyMode(node) {
  const p = node.parent;
  if (!p) return 'r';
  if ((p.type === 'assignment' || p.type === 'augmented_assignment') && p.childForFieldName('left') && p.childForFieldName('left').id === node.id) return p.type === 'augmented_assignment' ? 'rw' : 'w';
  if (p.type === 'pattern_list' || p.type === 'tuple_pattern') return pyMode(p) === 'r' ? 'r' : 'w';
  return 'r';
}

/** JavaScript/TypeScript: mode by assignment / update context. */
function jsMode(node) {
  const p = node.parent;
  if (!p) return 'r';
  if (p.type === 'assignment_expression' && p.childForFieldName('left') && p.childForFieldName('left').id === node.id) return 'w';
  if (p.type === 'augmented_assignment_expression' && p.childForFieldName('left') && p.childForFieldName('left').id === node.id) return 'rw';
  if (p.type === 'update_expression') return 'rw';
  return 'r';
}

function innermostCallable(defs) {
  const ranges = defs.map((d, i) => ({ i, start: d.start, end: d.end, callable: CALLABLE_KINDS.has(d.kind) || d.kind === 'property' || d.kind === 'event' }));
  return (line) => {
    let best = -1;
    let span = Infinity;
    for (const r of ranges) if (r.callable && line >= r.start && line <= r.end && r.end - r.start < span) {
      best = r.i;
      span = r.end - r.start;
    }
    return best;
  };
}

/** Attribute variable uses and local declarations to the innermost function/method by line. */
function attributeUses(defs, uses, locals) {
  const at = innermostCallable(defs);
  for (const u of uses) u[0] = at(u[2]);
  for (const l of locals) l[0] = at(l[2]);
}

/** Merge repeated uses (same owner, name, mode, flags): [owner, name, line, col, mode, flags, count]. */
function compactUses(uses) {
  const map = new Map();
  for (const u of uses) {
    const key = `${u[0]}|${u[1]}|${u[4]}|${u[5]}`;
    const prev = map.get(key);
    if (prev) prev[6]++;
    else map.set(key, [...u, 1]);
  }
  return [...map.values()];
}

/** Locals per function with read/write counts: [owner, name, line, kind, reads, writes]. */
function summarizeLocals(locals, localUses, defs) {
  const at = innermostCallable(defs);
  const out = new Map();
  for (const [owner, name, line, kind] of locals) {
    const key = `${owner}|${name}`;
    if (!out.has(key)) out.set(key, [owner, name, line, kind, 0, 0]);
  }
  for (const [line, name, mode] of localUses) {
    const owner = at(line);
    const e = out.get(`${owner}|${name}`);
    if (!e) continue;
    if (mode !== 'w') e[4]++;
    if (mode !== 'r') e[5]++;
  }
  return [...out.values()];
}

function traverse(tree, enter, leave) {
  const cursor = tree.walk();
  const stack = [];
  let done = false;
  while (!done) {
    const node = cursor.currentNode;
    const frame = { node, type: node.type, field: cursor.currentFieldName };
    const descend = enter(frame, stack) !== false;
    stack.push(frame);
    if (descend && cursor.gotoFirstChild()) continue;
    leave(stack.pop(), stack);
    for (;;) {
      if (cursor.gotoNextSibling()) break;
      if (!cursor.gotoParent()) {
        done = true;
        break;
      }
      leave(stack.pop(), stack);
    }
  }
  cursor.delete();
}

function signatureOf(lang, src, node) {
  const text = src.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 600));
  if (lang === 'python') return squash(text.split(/:\s*(\n|$)/)[0]).slice(0, 240);
  return squash(text.split(/\{|=>|;/)[0]).slice(0, 240);
}

function analyze(lang, src, withTokens) {
  if (GENERIC.has(lang)) return analyzeGeneric(lang, src, parsers[lang], genericHelpers);
  const tree = parsers[lang].parse(src);
  const defs = [];
  const counts = new Map();
  const calls = [];
  const bases = [];
  const imports = [];
  const tokens = withTokens ? [] : null;
  const declIds = new Set();
  const scopes = []; // { names: Map<name, 'parameter'|'local'|'selfKeyword'> }
  const owners = []; // def index stack for call attribution
  const containers = []; // { name }
  const pending = new Map(); // decl node id -> { kind, frame }
  // Variable usage: non-local uses [owner, name, line, col, mode, flags] and local declarations
  // [owner, name, line, kind]; owners are assigned by line afterwards (attributeOwners).
  const uses = [];
  const locals = [];
  const localUses = []; // [line, name, mode]
  const classFields = new Map(); // class container -> Set(field names)
  const use = (n, mode, flags) => {
    if (flags & (LOCAL | PARAM)) localUses.push([n.startPosition.row + 1, n.text, mode]);
    else uses.push([-1, n.text, n.startPosition.row + 1, n.startPosition.column + 1, mode, flags]);
  };
  const declareLocal = (n, kind) => locals.push([-1, n.text, n.startPosition.row + 1, kind]);
  const containerPath = () => containers.map((c) => c.name).filter(Boolean).join('.');
  const fieldSeen = (name) => {
    const key = containerPath();
    if (!classFields.has(key)) classFields.set(key, new Set());
    const set = classFields.get(key);
    if (set.has(name)) return true;
    set.add(name);
    return false;
  };

  const token = (n, type, mods = 0) => {
    if (tokens && n.startPosition.row === n.endPosition.row) tokens.push(n.startPosition.row, n.startPosition.column, n.endIndex - n.startIndex, type, mods);
  };
  const scopeLookup = (name) => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const v = scopes[i].names.get(name);
      if (v) return v;
    }
    return null;
  };
  const addDef = (nameNode, kind, declNode) => {
    const name = nameNode.text;
    if (!name) return -1;
    const containerName = containers.map((c) => c.name).filter(Boolean).join('.');
    const d = {
      name,
      kind,
      line: nameNode.startPosition.row + 1,
      col: nameNode.startPosition.column + 1,
      endCol: nameNode.endPosition.column + 1,
      start: declNode.startPosition.row + 1,
      end: declNode.endPosition.row + 1,
      container: containerName,
      sig: CALLABLE_KINDS.has(kind) || TYPE_KINDS.has(kind) || kind === 'property' ? signatureOf(lang, src, declNode) : '',
      h: hash(squash(src.slice(declNode.startIndex, declNode.endIndex))),
    };
    defs.push(d);
    declIds.add(nameNode.id);
    return defs.length - 1;
  };
  const count = (name) => counts.set(name, (counts.get(name) || 0) + 1);
  const owner = () => (owners.length ? owners[owners.length - 1] : -1);
  const call = (n, kind) => calls.push([owner(), n.text, n.startPosition.row + 1, n.startPosition.column + 1, kind]);

  if (lang === 'csharp') {
    traverse(
      tree,
      (f, stack) => {
        const t = f.type;
        if (t === 'comment' || t === 'string_literal' || t === 'verbatim_string_literal' || t === 'raw_string_literal' || t === 'character_literal' || t === 'preprocessor_call') return false;
        if (CS_DECL[t]) pending.set(f.node.id, { kind: CS_DECL[t], frame: f });
        // A file-scoped namespace (`namespace X;`) covers the rest of the file, but tree-sitter makes
        // the following declarations its siblings, so it stays on the container stack.
        if (CS_CONTAINERS.has(t)) containers.push({ type: t, name: null, fileScoped: t === 'file_scoped_namespace_declaration' });
        if (CS_SCOPES.has(t)) scopes.push({ names: new Map() });
        if (t === 'field_declaration' || t === 'event_field_declaration') f.fieldDecl = t === 'event_field_declaration' ? 'event' : 'field';
        if (t !== 'identifier') return true;

        const n = f.node;
        const name = n.text;
        const parent = stack[stack.length - 1];
        const gp = stack[stack.length - 2];
        const pt = parent ? parent.type : '';
        // Declarations
        const decl = parent && pending.get(parent.node.id);
        if (decl && f.field === 'name') {
          const idx = addDef(n, decl.kind, parent.node);
          if (CS_CONTAINERS.has(pt)) containers[containers.length - 1].name = name;
          if (CS_CALLABLE_DECL.has(pt)) parent.ownerIdx = idx;
          const tt = { class: T.class, interface: T.interface, struct: T.struct, record: T.record, enum: T.enum, delegate: T.delegate, method: T.method, function: T.function, constructor: T.class, property: T.property, event: T.event, enumMember: T.enumMember, namespace: T.namespace }[decl.kind];
          if (tt !== undefined) token(n, tt, 1);
          return true;
        }
        if (pt === 'variable_declarator' && f.field !== 'value' && (!parent.node.firstNamedChild || parent.node.firstNamedChild.id === n.id)) {
          const fd = stack.find((s) => s.fieldDecl);
          const inScope = scopes.length > 0;
          if (fd && !inScope) {
            const idx = addDef(n, fd.fieldDecl, stack[stack.length - 3] ? stack[stack.length - 3].node : parent.node);
            if (idx >= 0) token(n, fd.fieldDecl === 'event' ? T.event : T.field, 1);
          } else {
            if (scopes.length) {
              scopes[scopes.length - 1].names.set(name, 'local');
              declareLocal(n, 'local');
              if (/=/.test(parent.node.text.slice(name.length))) use(n, 'w', LOCAL);
            }
            declIds.add(n.id);
            token(n, T.local, 1);
          }
          return true;
        }
        if (pt === 'parameter' && f.field === 'name') {
          if (scopes.length) {
            scopes[scopes.length - 1].names.set(name, 'parameter');
            declareLocal(n, 'parameter');
          }
          declIds.add(n.id);
          token(n, T.parameter, 1);
          return true;
        }
        if ((pt === 'foreach_statement' && f.field === 'left') || (pt === 'catch_declaration' && f.field === 'name') || pt === 'single_variable_designation' || (pt === 'declaration_expression' && f.field === 'name')) {
          if (scopes.length) {
            scopes[scopes.length - 1].names.set(name, 'local');
            declareLocal(n, 'local');
            use(n, 'w', LOCAL);
          }
          declIds.add(n.id);
          token(n, T.local, 1);
          return true;
        }
        if (pt === 'type_parameter') {
          declIds.add(n.id);
          token(n, T.typeParameter, 1);
          return true;
        }
        // References
        count(name);
        if (pt === 'base_list' || (gp && gp.type === 'base_list' && (pt === 'generic_name' || pt === 'qualified_name'))) {
          bases.push([owner() >= 0 ? owner() : currentTypeDef(defs, containers), name]);
        }
        const local = scopeLookup(name);
        const invokedDirect = pt === 'invocation_expression' && f.field === 'function';
        const memberName = pt === 'member_access_expression' && f.field === 'name';
        const invokedMember = memberName && gp && gp.type === 'invocation_expression' && parent.field === 'function';
        const genericCall = pt === 'generic_name' && gp && ((gp.type === 'invocation_expression' && parent.field === 'function') || (gp.type === 'member_access_expression' && gp.field === 'function' && parent.field === 'name'));
        if (local && !memberName) {
          token(n, local === 'parameter' ? T.parameter : T.local);
          use(n, csMode(n), local === 'parameter' ? PARAM : LOCAL);
        } else if (invokedDirect || invokedMember || genericCall) {
          call(n, 'call');
          token(n, T.method);
        } else if (pt === 'object_creation_expression' || (pt === 'generic_name' && gp && gp.type === 'object_creation_expression')) {
          call(n, 'new');
          token(n, typeToken(name));
        } else if (pt === 'attribute') {
          token(n, T.attribute);
        } else if (pt === 'qualified_name' || pt === 'using_directive' || pt === 'namespace_declaration' || pt === 'file_scoped_namespace_declaration') {
          const k = knownKinds(name);
          token(n, k.type ? typeToken(name) : T.namespace);
        } else if (memberName) {
          const k = knownKinds(name);
          token(n, k.member === 'field' ? T.field : k.member === 'enumMember' ? T.enumMember : k.member === 'method' ? T.method : k.member === 'event' ? T.event : k.type ? typeToken(name) : T.property);
          const obj = parent.node.childForFieldName('expression');
          use(n, csMode(parent.node), obj && (obj.type === 'this_expression' || obj.text === 'this') ? SELF : MEMBER);
        } else if (CS_TYPE_CONTEXT.has(pt) || pt === 'generic_name' || pt === 'type_argument_list') {
          if (pt !== 'variable_declaration' || f.field === 'type') {
            call(n, 'type');
            token(n, typeToken(name));
          }
        } else {
          const k = knownKinds(name);
          if (!(k.type && /^[A-Z]/.test(name))) use(n, csMode(n), 0);
          if (k.type && /^[A-Z]/.test(name)) token(n, typeToken(name));
          else if (k.member === 'field') token(n, T.field);
          else if (k.member === 'property') token(n, T.property);
          else if (k.member === 'enumMember') token(n, T.enumMember);
          else if (k.member === 'method') token(n, T.method);
          else if (/^[A-Z][A-Z0-9_]+$/.test(name)) token(n, T.constant);
        }
        return true;
      },
      (f) => {
        const t = f.type;
        if (CS_CONTAINERS.has(t) && t !== 'file_scoped_namespace_declaration') containers.pop();
        if (CS_SCOPES.has(t)) scopes.pop();
        if (f.ownerPushed) owners.pop();
        pending.delete(f.node.id);
      },
    );
    // Owners: attribute call sites to the innermost callable declaration (second pass is cheaper than tracking during the walk).
    attributeOwners(defs, calls, bases);
  } else if (lang === 'python') {
    traverse(
      tree,
      (f, stack) => {
        const t = f.type;
        if (t === 'comment') return false;
        // Strings are skipped, except the expressions inside f-string interpolations.
        if (t === 'string') return f.node.namedChildren.some((c) => c && c.type === 'interpolation');
        if (t === 'class_definition' || t === 'function_definition') pending.set(f.node.id, { kind: t === 'class_definition' ? 'class' : 'function', frame: f });
        if (t === 'class_definition') containers.push({ type: t, name: null });
        if (t === 'function_definition' || t === 'lambda') scopes.push({ names: new Map(), fn: t === 'function_definition' });
        if ((t === 'global_statement' || t === 'nonlocal_statement') && scopes.length) {
          for (const c of f.node.namedChildren) if (c && c.type === 'identifier') scopes[scopes.length - 1].names.set(c.text, t === 'global_statement' ? 'global' : 'nonlocal');
          return false;
        }
        if (t !== 'identifier') return true;
        const n = f.node;
        const name = n.text;
        const parent = stack[stack.length - 1];
        const gp = stack[stack.length - 2];
        const pt = parent ? parent.type : '';
        const decl = parent && pending.get(parent.node.id);
        if (decl && f.field === 'name') {
          const inClass = containers.length > 0 && stack.some((s) => s.type === 'class_definition' && s.node.id !== parent.node.id) && nearestDefParent(stack) === 'class_definition';
          const kind = decl.kind === 'function' ? (inClass ? 'method' : 'function') : 'class';
          addDef(n, kind, parent.node);
          if (decl.kind === 'class') containers[containers.length - 1].name = name;
          token(n, kind === 'class' ? T.class : kind === 'method' ? T.method : T.function, 1);
          return true;
        }
        // Parameters
        if (pt === 'parameters' || pt === 'lambda_parameters' || ((pt === 'default_parameter' || pt === 'typed_default_parameter') && f.field === 'name') || (pt === 'typed_parameter' && !f.field) || pt === 'list_splat_pattern' || pt === 'dictionary_splat_pattern') {
          const role = name === 'self' || name === 'cls' ? 'selfKeyword' : 'parameter';
          if (scopes.length) scopes[scopes.length - 1].names.set(name, role);
          if (role === 'parameter' && scopes.length) declareLocal(n, 'parameter');
          declIds.add(n.id);
          token(n, role === 'selfKeyword' ? T.selfKeyword : T.parameter, 1);
          return true;
        }
        // Module-level assignments are definitions (constants, globals).
        if (pt === 'assignment' && f.field === 'left' && gp && gp.type === 'expression_statement' && stack[stack.length - 3] && stack[stack.length - 3].type === 'module') {
          addDef(n, /^[A-Z][A-Z0-9_]+$/.test(name) ? 'constant' : 'variable', parent.node);
          token(n, /^[A-Z][A-Z0-9_]+$/.test(name) ? T.constant : T.local, 1);
          return true;
        }
        // Class attributes (assignments directly in a class body) are fields.
        if (pt === 'assignment' && f.field === 'left' && !scopes.length && gp && gp.type === 'expression_statement' && stack[stack.length - 3] && stack[stack.length - 3].type === 'block' && stack[stack.length - 4] && stack[stack.length - 4].type === 'class_definition') {
          if (!fieldSeen(name)) addDef(n, /^[A-Z][A-Z0-9_]+$/.test(name) ? 'constant' : 'field', parent.node);
          token(n, T.property, 1);
          return true;
        }
        const target = pyTarget(f, stack);
        if (target && scopes.length) {
          const role = scopeLookup(name);
          if (role === 'global' || role === 'nonlocal') {
            count(name);
            use(n, target.mode, role === 'global' ? 0 : LOCAL);
            token(n, T.local);
            return true;
          }
          if (target.mode === 'w' && !scopes[scopes.length - 1].names.has(name)) {
            scopes[scopes.length - 1].names.set(name, 'local');
            declareLocal(n, 'local');
          }
          use(n, target.mode, LOCAL);
        }
        // Imports
        if (pt === 'dotted_name' && gp && (gp.type === 'import_statement' || gp.type === 'import_from_statement' || gp.type === 'aliased_import')) {
          if (parent.node.firstNamedChild && parent.node.firstNamedChild.id === n.id && (gp.type === 'import_statement' || (gp.type === 'import_from_statement' && parent.field === 'module_name') || gp.type === 'aliased_import')) {
            const dotted = parent.node.text;
            const stmt = gp.type === 'aliased_import' ? stack[stack.length - 3] : gp;
            if (stmt && (stmt.type === 'import_statement' || (stmt.type === 'import_from_statement' && parent.field === 'module_name'))) imports.push([dotted, 0, n.startPosition.row + 1]);
          }
          declIds.add(n.id);
          token(n, T.module);
          return true;
        }
        if (pt === 'aliased_import' && f.field === 'alias') {
          declIds.add(n.id);
          token(n, T.module, 1);
          return true;
        }
        if (pt === 'relative_import' || (pt === 'dotted_name' && gp && gp.type === 'relative_import')) {
          declIds.add(n.id);
          token(n, T.module);
          return true;
        }
        // References
        count(name);
        if (pt === 'argument_list' && gp && gp.type === 'class_definition' && gp.field !== 'body') bases.push([-2, name]);
        const local = scopeLookup(name);
        if (pt === 'decorator' || (gp && gp.type === 'decorator')) {
          token(n, T.decorator);
          if (pt === 'call' || (gp && gp.type === 'call')) call(n, 'call');
        } else if (pt === 'call' && f.field === 'function') {
          call(n, 'call');
          const k = knownKinds(name);
          token(n, local ? (local === 'selfKeyword' ? T.selfKeyword : T.parameter) : k.type ? T.class : PY_BUILTINS.has(name) ? T.builtin : T.function);
        } else if (pt === 'attribute' && f.field === 'attribute') {
          const invoked = gp && gp.type === 'call' && parent.field === 'function';
          if (invoked) {
            call(n, 'call');
            token(n, T.method);
          } else {
            token(n, /^[A-Z][A-Z0-9_]+$/.test(name) ? T.constant : T.property);
            const obj = parent.node.childForFieldName('object');
            const self = obj && obj.type === 'identifier' && (obj.text === 'self' || obj.text === 'cls');
            const mode = pyMode(parent.node);
            // self.x = ... inside a method defines an instance field of the class.
            if (self && mode !== 'r' && containers.length && !fieldSeen(name)) addDef(n, 'field', gp ? gp.node : parent.node);
            use(n, mode, self ? SELF : MEMBER);
          }
        } else if (local) {
          token(n, local === 'selfKeyword' ? T.selfKeyword : local === 'parameter' ? T.parameter : T.local);
          if (local !== 'selfKeyword' && !(target && scopes.length)) use(n, 'r', local === 'parameter' ? PARAM : local === 'global' ? 0 : LOCAL);
        } else if (pt === 'type' || (gp && gp.type === 'type') || pt === 'generic_type') {
          call(n, 'type');
          token(n, PY_BUILTINS.has(name) ? T.builtin : T.class);
        } else if (PY_BUILTINS.has(name)) {
          token(n, T.builtin);
        } else if (/^[A-Z][A-Z0-9_]+$/.test(name)) {
          token(n, T.constant);
          if (!target) use(n, 'r', 0);
        } else {
          const k = knownKinds(name);
          if (k.type) token(n, T.class);
          else if (k.member === 'function' || k.member === 'method') token(n, T.function);
          else if (!target) use(n, 'r', 0);
        }
        return true;
      },
      (f) => {
        if (f.type === 'class_definition') containers.pop();
        if (f.type === 'function_definition' || f.type === 'lambda') scopes.pop();
        pending.delete(f.node.id);
      },
    );
    attributeOwners(defs, calls, bases);
  } else {
    traverse(
      tree,
      (f, stack) => {
        const t = f.type;
        if (t === 'comment' || t === 'string') return false;
        if (t === 'template_string') return f.node.namedChildren.some((c) => c && c.type === 'template_substitution');
        if (TS_DECL[t]) pending.set(f.node.id, { kind: TS_DECL[t], frame: f });
        if (t === 'class_declaration' || t === 'abstract_class_declaration' || t === 'interface_declaration') containers.push({ type: t, name: null });
        if (TS_FN.has(t)) scopes.push({ names: new Map() });
        if (!TS_IDENT.has(t)) return true;
        const n = f.node;
        const name = n.text;
        const parent = stack[stack.length - 1];
        const gp = stack[stack.length - 2];
        const pt = parent ? parent.type : '';
        const decl = parent && pending.get(parent.node.id);
        if (decl && f.field === 'name') {
          addDef(n, decl.kind, parent.node);
          if (containers.length && (pt === 'class_declaration' || pt === 'abstract_class_declaration' || pt === 'interface_declaration')) containers[containers.length - 1].name = name;
          if (decl.kind === 'property') fieldSeen(name);
          return true;
        }
        if (pt === 'variable_declarator' && f.field === 'name' && gp && stack[stack.length - 3] && (stack[stack.length - 3].type === 'program' || stack[stack.length - 3].type === 'export_statement')) {
          const value = parent.node.childForFieldName('value');
          addDef(n, value && /function|arrow_function/.test(value.type) ? 'function' : /^[A-Z][A-Z0-9_]+$/.test(name) ? 'constant' : 'variable', parent.node);
          return true;
        }
        // Parameters and locals of functions.
        if (scopes.length && (pt === 'formal_parameters' || ((pt === 'required_parameter' || pt === 'optional_parameter') && f.field === 'pattern') || (pt === 'assignment_pattern' && f.field === 'left' && gp && gp.type === 'formal_parameters'))) {
          scopes[scopes.length - 1].names.set(name, 'parameter');
          declareLocal(n, 'parameter');
          return true;
        }
        if (scopes.length && pt === 'variable_declarator' && f.field === 'name') {
          scopes[scopes.length - 1].names.set(name, 'local');
          declareLocal(n, 'local');
          if (parent.node.childForFieldName('value')) use(n, 'w', LOCAL);
          return true;
        }
        count(name);
        if (pt === 'call_expression' && f.field === 'function') call(n, 'call');
        else if (pt === 'member_expression' && f.field === 'property' && gp && gp.type === 'call_expression' && parent.field === 'function') call(n, 'call');
        else if (pt === 'new_expression') call(n, 'new');
        else if (pt === 'member_expression' && f.field === 'property') {
          const obj = parent.node.childForFieldName('object');
          const self = obj && obj.type === 'this';
          const mode = jsMode(parent.node);
          // this.x = ... in a class defines a field.
          if (self && mode !== 'r' && containers.length && !fieldSeen(name)) addDef(n, 'field', gp ? gp.node : parent.node);
          use(n, mode, self ? SELF : MEMBER);
        } else if (t === 'identifier' && pt !== 'member_expression' && !/^(import|export)/.test(pt) && pt !== 'pair' && !/type/.test(pt)) {
          const local = scopeLookup(name);
          use(n, jsMode(n), local === 'parameter' ? PARAM : local ? LOCAL : 0);
        }
        return true;
      },
      (f) => {
        if (f.type === 'class_declaration' || f.type === 'abstract_class_declaration' || f.type === 'interface_declaration') containers.pop();
        if (TS_FN.has(f.type)) scopes.pop();
        pending.delete(f.node.id);
      },
    );
    attributeOwners(defs, calls, bases);
  }
  tree.delete();
  attributeUses(defs, uses, locals, localUses);
  return { defs, counts, calls, bases, imports, tokens, uses: compactUses(uses), locals: summarizeLocals(locals, localUses, defs) };
}

function typeToken(name) {
  const k = knownKinds(name);
  if (k.type) return T[k.type] !== undefined ? T[k.type] : T.class;
  return /^I[A-Z]/.test(name) ? T.interface : T.class;
}

function nearestDefParent(stack) {
  for (let i = stack.length - 2; i >= 0; i--) {
    const t = stack[i].type;
    if (t === 'class_definition' || t === 'function_definition') return t;
  }
  return null;
}

function currentTypeDef(defs, containers) {
  for (let i = defs.length - 1; i >= 0; i--) if (TYPE_KINDS.has(defs[i].kind)) return i;
  return -1;
}

function attributeOwners(defs, calls, bases) {
  const ranges = defs.map((d, i) => ({ i, start: d.start, end: d.end, callable: CALLABLE_KINDS.has(d.kind) || d.kind === 'property' || d.kind === 'event', type: TYPE_KINDS.has(d.kind) }));
  const innermost = (line, pred) => {
    let best = -1;
    let span = Infinity;
    for (const r of ranges) if (pred(r) && line >= r.start && line <= r.end && r.end - r.start < span) {
      best = r.i;
      span = r.end - r.start;
    }
    return best;
  };
  for (const c of calls) {
    let o = innermost(c[2], (r) => r.callable);
    if (o < 0) o = innermost(c[2], (r) => r.type);
    c[0] = o;
  }
  for (const b of bases) {
    const line = b[2] || 0;
    if (b[0] < 0) {
      // Python: the class whose header is on/above this line.
      let best = -1;
      for (const r of ranges) if (r.type && (best < 0 || r.start > ranges[best].start)) best = r.i;
      b[0] = best;
    }
    void line;
  }
}

module.exports = {
  VERSION: 4,
  LANG_BY_EXT,
  TOKEN_TYPES,
  TOKEN_MODIFIERS,
  TYPE_KINDS,
  CALLABLE_KINDS,
  LENS_KINDS,
  CS_DECL,
  CS_CONTAINERS,
  CS_TYPE_CONTEXT,
  TS_DECL,
  SELF,
  MEMBER,
  LOCAL,
  PARAM,
  loadLanguages,
  setKindResolver,
  getParsers,
  langOf,
  analyze,
  isIdentType,
  signatureOf,
  hash,
  squash,
};
