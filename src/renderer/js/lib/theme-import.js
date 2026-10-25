// Theme files: Kiln theme exports and VS Code color themes (JSON with comments) become Kiln custom
// themes. VS Code workbench colors and TextMate token scopes are mapped onto Kiln's color slots.
import { completeTheme, normalizeColor, DEFAULT_ANSI } from './themes.js';

const ANSI_KEYS = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White', 'BrightBlack', 'BrightRed', 'BrightGreen', 'BrightYellow', 'BrightBlue', 'BrightMagenta', 'BrightCyan', 'BrightWhite'];

export function newThemeId(name = 'theme') {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'theme';
  return `custom-${slug}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function luminance(hex) {
  const v = normalizeColor(hex);
  if (!v) return 0;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** JSON with comments and trailing commas (VS Code theme files) -> object. */
function parseJsonc(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === '\\') out += text[++i] || '';
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** Last color assigned to an exact scope in tokenColors (later rules win, as in TextMate). */
function scopeColors(tokenColors) {
  const map = new Map();
  let fallback = null;
  for (const rule of Array.isArray(tokenColors) ? tokenColors : []) {
    const fg = rule && rule.settings && normalizeColor(rule.settings.foreground);
    if (!fg) continue;
    if (!rule.scope) {
      fallback = fg;
      continue;
    }
    const scopes = Array.isArray(rule.scope) ? rule.scope : String(rule.scope).split(',');
    for (const s of scopes) map.set(s.trim(), fg);
  }
  return { map, fallback };
}

export function fromVsCodeTheme(vs, { name } = {}) {
  const c = (vs && vs.colors) || {};
  const col = (...keys) => {
    for (const k of keys) {
      const v = normalizeColor(c[k]);
      if (v) return v;
    }
    return null;
  };
  const { map, fallback } = scopeColors(vs && vs.tokenColors);
  const tok = (...scopes) => {
    for (const s of scopes) if (map.has(s)) return map.get(s);
    return null;
  };
  const bg = col('editor.background');
  const type = /light/.test(vs.type || '') ? 'light' : /dark|black/.test(vs.type || '') ? 'dark' : bg && luminance(bg) > 0.4 ? 'light' : 'dark';
  const typeColor = tok('entity.name.type', 'entity.name.class', 'support.class', 'support.type', 'entity.name.type.class', 'storage.type.class');
  const ansiCustom = ANSI_KEYS.map((k) => col(`terminal.ansi${k}`));
  const defaults = DEFAULT_ANSI[type];
  const title = name || vs.name || vs.displayName || 'Imported Theme';
  return completeTheme({
    id: newThemeId(title),
    name: title,
    type,
    basedOn: type === 'light' ? 'rider-light' : 'rider-dark',
    base: {
      editor: bg,
      panel: col('sideBar.background', 'activityBar.background', 'panel.background', 'editorGroupHeader.tabsBackground', 'titleBar.activeBackground') || bg,
      text: col('foreground', 'sideBar.foreground', 'editor.foreground'),
      accent: col('focusBorder', 'button.background', 'activityBarBadge.background', 'textLink.foreground', 'progressBar.background'),
      selection: col('list.activeSelectionBackground', 'list.inactiveSelectionBackground', 'editor.selectionBackground'),
      border: col('panel.border', 'sideBar.border', 'activityBar.border', 'contrastBorder', 'editorGroup.border'),
      inner: col('editorGroup.border', 'tab.border', 'sideBarSectionHeader.border', 'input.border', 'panel.border'),
    },
    editor: {
      lineHighlight: col('editor.lineHighlightBackground', 'editor.lineHighlightBorder'),
      selection: col('editor.selectionBackground'),
      lineNumber: col('editorLineNumber.foreground'),
      lineNumberActive: col('editorLineNumber.activeForeground', 'editor.foreground'),
      cursor: col('editorCursor.foreground'),
    },
    syntax: {
      fg: col('editor.foreground') || fallback,
      comment: tok('comment', 'comment.line', 'comment.block', 'punctuation.definition.comment'),
      keyword: tok('keyword', 'keyword.control', 'storage.type', 'storage', 'storage.modifier', 'keyword.other'),
      string: tok('string', 'string.quoted', 'string.quoted.double', 'string.quoted.single'),
      number: tok('constant.numeric', 'constant.numeric.integer', 'constant.numeric.decimal', 'number'),
      type: typeColor,
      iface: tok('entity.name.type.interface', 'entity.name.interface') || typeColor,
      struct: tok('entity.name.type.struct', 'storage.type.struct') || typeColor,
      enum: tok('entity.name.type.enum', 'entity.name.enum') || typeColor,
      method: tok('entity.name.function', 'support.function', 'meta.function-call', 'entity.name.method', 'meta.function-call.generic'),
      field: tok('variable.other.property', 'variable.other.member', 'support.variable.property', 'variable.other.object.property', 'meta.object-literal.key'),
      local: tok('variable', 'variable.other', 'variable.other.readwrite'),
      param: tok('variable.parameter', 'variable.parameter.function', 'meta.parameter'),
      namespace: tok('entity.name.namespace', 'entity.name.type.namespace', 'entity.name.type.module', 'entity.name.module'),
      constant: tok('constant.language', 'variable.other.constant', 'support.constant', 'constant'),
      decorator: tok('meta.decorator', 'entity.name.function.decorator', 'storage.type.annotation', 'punctuation.decorator', 'meta.attribute'),
      builtin: tok('support.function.builtin', 'support.type.builtin', 'variable.language', 'support.function'),
      escape: tok('constant.character.escape', 'constant.character'),
      tag: tok('entity.name.tag'),
      attr: tok('entity.other.attribute-name'),
      event: tok('variable.other.event', 'entity.name.event'),
      self: tok('variable.language.this', 'variable.language.self', 'variable.language'),
    },
    terminal: ansiCustom.some(Boolean) ? { ansi: ansiCustom.map((v, i) => v || defaults[i]) } : undefined,
  });
}

/** Kiln theme file contents (JSON). */
export function exportTheme(theme) {
  const { id, custom, ...rest } = theme;
  return JSON.stringify({ $schema: 'kiln-theme', version: 1, ...rest }, null, 2);
}

/** Parse a Kiln theme export or a VS Code color theme into a new custom theme. */
export function importTheme(text) {
  let obj;
  try {
    obj = parseJsonc(String(text));
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  if (obj && (obj.$schema === 'kiln-theme' || (obj.base && obj.syntax))) return completeTheme({ ...obj, id: newThemeId(obj.name) });
  if (obj && (obj.colors || obj.tokenColors)) return fromVsCodeTheme(obj);
  throw new Error('This file is not a color theme (expected a Kiln theme export or a VS Code color theme).');
}
