'use strict';
// JavaScript / TypeScript refactorings from the TypeScript language service, over every script in the
// project (tsconfig.json / jsconfig.json when there is one). Nothing is written: each refactoring
// returns the new text of the files it changes, so the IDE can preview it and apply it to the editors
// (undoable). Unsaved editor text is used for the file being refactored.
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const SCRIPT = /\.(?:[cm]?[jt]sx?)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.venv', 'venv', 'bin', 'obj', '__pycache__', '.turbo', '.cache', '.idea', '.vscode']);
const MAX_FILES = 5000;

const DEFAULT_OPTIONS = {
  allowJs: true,
  checkJs: false,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  esModuleInterop: true,
  resolveJsonModule: true,
  skipLibCheck: true,
  noEmit: true,
};

const PREFS = {
  quotePreference: 'auto',
  importModuleSpecifierEnding: 'auto',
  importModuleSpecifierPreference: 'shortest',
  allowTextChangesInNewFiles: true,
  provideRefactorNotApplicableReason: true,
  providePrefixAndSuffixTextForRename: true,
  allowRenameOfImportPath: false,
  includePackageJsonAutoImports: 'off',
};

function scan(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name));
      } else if (SCRIPT.test(e.name) && !e.name.endsWith('.min.js')) out.push(path.join(dir, e.name));
    }
  };
  walk(root);
  return out;
}

function projectConfig(root) {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const cfg = ts.readConfigFile(file, ts.sys.readFile);
    if (cfg.error) continue;
    const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root, undefined, file);
    const options = { ...parsed.options, noEmit: true };
    if (name === 'jsconfig.json' && options.allowJs === undefined) options.allowJs = true;
    return { options, files: parsed.fileNames };
  }
  return { options: DEFAULT_OPTIONS, files: null };
}

/** Indentation used by a file: { size, tabs } (null when it has no indented lines). */
function detectIndent(text) {
  let tabs = 0;
  const counts = new Map();
  let prev = 0;
  for (const line of text.split('\n')) {
    if (!line.trim() || /^\s*\*/.test(line)) continue;
    const m = /^[ \t]*/.exec(line)[0];
    if (m.includes('\t')) {
      tabs++;
      continue;
    }
    const d = Math.abs(m.length - prev);
    if (d >= 2 && d <= 8) counts.set(d, (counts.get(d) || 0) + 1);
    prev = m.length;
  }
  let best = null;
  for (const [size, n] of counts) if (!best || n > best.n) best = { size, n };
  if (tabs > (best ? best.n : 0)) return { size: 4, tabs: true };
  return best ? { size: best.size, tabs: false } : null;
}

/**
 * Import style of the code around a refactoring, so new files and imports look like the rest of the
 * project: quote character, and whether relative imports spell out the extension ("./shop.js").
 */
function importStyle(texts) {
  let single = 0;
  let double = 0;
  let withExt = 0;
  let without = 0;
  for (const text of texts) {
    for (const m of text.matchAll(/(?:\bfrom\s+|\bimport\s+|\brequire\()(['"])(\.{1,2}\/[^'"]*)\1/g)) {
      if (m[1] === "'") single++;
      else double++;
      if (/\.[cm]?[jt]sx?$/.test(m[2])) withExt++;
      else without++;
    }
  }
  return { quotePreference: single > double ? 'single' : double > single ? 'double' : 'auto', importModuleSpecifierEnding: withExt > without ? 'js' : without > withExt ? 'minimal' : 'auto' };
}

/** Apply TypeScript text changes (non-overlapping, in document order) to a string. */
function applyTextChanges(text, changes) {
  const sorted = changes.map((c, i) => ({ c, i })).sort((a, b) => b.c.span.start - a.c.span.start || b.i - a.i);
  let out = text;
  for (const { c } of sorted) out = out.slice(0, c.span.start) + c.newText + out.slice(c.span.start + c.span.length);
  return out;
}

/** Rider's names for what the TypeScript service offers. */
function classify(refactor, action) {
  const d = action.description || '';
  switch (refactor.name) {
    case 'Extract Symbol':
      if (/^function_scope_/.test(action.name)) return { kind: 'extractMethod', needs: 'name', defaultName: /method in class/i.test(d) ? 'newMethod' : 'newFunction' };
      if (/^constant_scope_/.test(action.name)) {
        if (/readonly field|property/i.test(d)) return { kind: 'introduceField', needs: 'name', defaultName: 'newProperty' };
        if (/module scope|global scope/i.test(d)) return { kind: 'introduceConstant', needs: 'name', defaultName: 'NEW_CONSTANT' };
        return { kind: 'introduceVariable', needs: 'name', defaultName: 'newLocal' };
      }
      return null;
    case 'Inline variable':
      return { kind: 'inline', title: 'Inline Variable' };
    case 'Move to a new file':
      return { kind: 'move', title: 'Move to a New File' };
    case 'Move to file':
      return { kind: 'move', needs: 'targetFile', title: 'Move to File…' };
    case 'Extract type':
      return { kind: 'extractType', needs: 'name', defaultName: 'NewType' };
    default:
      return { kind: 'other' };
  }
}

class TsProject {
  constructor(root, opts = {}) {
    this.root = root;
    this.format = opts.format || {};
    const cfg = projectConfig(root);
    this.options = cfg.options;
    this.files = new Set(cfg.files || scan(root));
    this.overrides = new Map();
    this.overrideVersion = 0;
    const host = {
      getScriptFileNames: () => [...this.files],
      getScriptVersion: (f) => {
        if (this.overrides.has(f)) return `o${this.overrides.get(f).v}`;
        try {
          return String(fs.statSync(f).mtimeMs);
        } catch {
          return '0';
        }
      },
      getScriptSnapshot: (f) => {
        const text = this.read(f);
        return text == null ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => root,
      getCompilationSettings: () => this.options,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: (f) => this.overrides.has(f) || ts.sys.fileExists(f),
      readFile: (f) => this.read(f),
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    };
    this.ls = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  read(file) {
    if (this.overrides.has(file)) return this.overrides.get(file).text;
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  }

  /** Use this text for a file during one request (unsaved editor content, or a refactoring's result). */
  setText(file, text) {
    if (text == null) return;
    this.overrides.set(file, { text, v: ++this.overrideVersion });
    if (SCRIPT.test(file)) this.files.add(file);
  }

  /** Files created or deleted on disk since the project was opened. */
  refresh() {
    const cfg = projectConfig(this.root);
    this.options = cfg.options;
    this.files = new Set(cfg.files || scan(this.root));
  }

  /** Preferences for a request on `file`: its own import style, else that of a sample of the project. */
  prefsFor(file) {
    let style = importStyle([this.read(file) || '']);
    if (style.quotePreference === 'auto' || style.importModuleSpecifierEnding === 'auto') {
      const sample = [...this.files].filter((f) => f !== file && !f.endsWith('.d.ts')).slice(0, 40).map((f) => this.read(f) || '');
      const wide = importStyle(sample);
      style = { quotePreference: style.quotePreference === 'auto' ? wide.quotePreference : style.quotePreference, importModuleSpecifierEnding: style.importModuleSpecifierEnding === 'auto' ? wide.importModuleSpecifierEnding : style.importModuleSpecifierEnding };
    }
    return { ...PREFS, ...style };
  }

  formatSettings(file) {
    const text = this.read(file) || '';
    const detected = detectIndent(text);
    const size = (detected && detected.size) || this.format.tabSize || 4;
    const tabs = detected ? detected.tabs : this.format.insertSpaces === false;
    return { ...ts.getDefaultFormatCodeSettings(/\r\n/.test(text) ? '\r\n' : '\n'), indentSize: size, tabSize: size, convertTabsToSpaces: !tabs };
  }

  /** Refactorings that apply at a caret (start === end) or selection; offsets are UTF-16 indexes. */
  refactors({ file, text, start, end }) {
    this.setText(file, text);
    try {
      const range = start === end ? start : { pos: start, end };
      let list;
      try {
        list = this.ls.getApplicableRefactors(file, range, PREFS, 'invoked', undefined, true) || [];
      } catch {
        return [];
      }
      const items = [];
      for (const r of list) {
        for (const a of r.actions) {
          if (a.notApplicableReason) continue;
          const c = classify(r, a);
          if (!c) continue;
          items.push({ id: `ts|${r.name}|${a.name}`, engine: 'typescript', title: c.title || a.description, kind: c.kind, needs: c.needs, defaultName: c.defaultName, group: r.description });
        }
      }
      return items;
    } finally {
      this.overrides.clear();
    }
  }

  /**
   * The changes a refactoring makes: { files: [{ path, before, after, created }], select }. `name`
   * replaces the name the service generates (newFunction, newLocal, ...), `targetFile` is the
   * destination for Move to File.
   */
  edits({ file, text, start, end, id, name, targetFile }) {
    const [, refactorName, actionName] = String(id).split('|');
    this.setText(file, text);
    try {
      const range = start === end ? start : { pos: start, end };
      const prefs = this.prefsFor(file);
      const info = this.ls.getEditsForRefactor(file, this.formatSettings(file), range, refactorName, actionName, prefs, targetFile ? { targetFile } : undefined);
      if (!info || !info.edits.length) throw new Error('This refactoring does not change anything here.');
      const out = new Map();
      for (const fc of info.edits) {
        const prev = out.get(fc.fileName);
        const exists = !!prev || this.overrides.has(fc.fileName) || fs.existsSync(fc.fileName);
        const before = prev ? prev.before : exists ? this.read(fc.fileName) || '' : '';
        const base = prev ? prev.after : before;
        out.set(fc.fileName, { path: fc.fileName, before, after: applyTextChanges(base, fc.textChanges), created: prev ? prev.created : !exists });
      }
      let select = null;
      if (info.renameFilename && info.renameLocation != null) select = this.renameGenerated(out, info.renameFilename, info.renameLocation, name, prefs);
      return { files: [...out.values()].filter((f) => f.before !== f.after || f.created), select };
    } finally {
      this.overrides.clear();
    }
  }

  /** Rename the identifier the refactoring generated (at `loc` in the changed text) to `name`. */
  renameGenerated(out, file, loc, name, prefs = PREFS) {
    for (const f of out.values()) this.setText(f.path, f.after);
    const current = out.get(file) ? out.get(file).after : this.read(file) || '';
    const word = /^[\p{L}\p{N}_$]+/u.exec(current.slice(loc));
    const generated = word ? word[0] : '';
    if (!name || name === generated) return { file, start: loc, end: loc + generated.length };
    let locs;
    try {
      locs = this.ls.findRenameLocations(file, loc, false, false, prefs) || [];
    } catch {
      locs = [];
    }
    if (!locs.length) return { file, start: loc, end: loc + generated.length };
    const byFile = new Map();
    for (const l of locs) {
      if (!byFile.has(l.fileName)) byFile.set(l.fileName, []);
      byFile.get(l.fileName).push(l);
    }
    let select = null;
    for (const [f, list] of byFile) {
      list.sort((a, b) => a.textSpan.start - b.textSpan.start);
      const entry = out.get(f) || { path: f, before: this.read(f) || '', after: this.read(f) || '', created: false };
      let text = entry.after;
      let shift = 0;
      for (const l of list) {
        const replacement = `${l.prefixText || ''}${name}${l.suffixText || ''}`;
        const s = l.textSpan.start + shift;
        text = text.slice(0, s) + replacement + text.slice(s + l.textSpan.length);
        if (f === file && l.textSpan.start <= loc && loc <= l.textSpan.start + l.textSpan.length) {
          const at = s + (l.prefixText || '').length;
          select = { file, start: at, end: at + name.length };
        }
        shift += replacement.length - l.textSpan.length;
      }
      out.set(f, { ...entry, after: text });
    }
    return select;
  }

  /** References to the symbol at `pos` (for Safe Delete): [{ file, start, end, isDefinition }]. */
  references({ file, text, pos }) {
    this.setText(file, text);
    try {
      const refs = this.ls.findReferences(file, pos) || [];
      const out = [];
      for (const r of refs) for (const e of r.references) out.push({ file: e.fileName, start: e.textSpan.start, end: e.textSpan.start + e.textSpan.length, isDefinition: !!e.isDefinition });
      return out;
    } catch {
      return [];
    } finally {
      this.overrides.clear();
    }
  }
}

module.exports = { TsProject, applyTextChanges, detectIndent, classify, importStyle };
