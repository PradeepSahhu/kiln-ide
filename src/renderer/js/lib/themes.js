// Themes: each defines a base palette and syntax colors; UI tokens (CSS variables), the Monaco editor
// theme and the terminal colors are all derived from it.

function hex(c) {
  const v = c.replace('#', '');
  const n = v.length === 3 ? v.split('').map((x) => x + x).join('') : v.slice(0, 6);
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}
function toHex([r, g, b]) {
  return '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
}
/** Mix color a toward b by t (0..1). */
export function mix(a, b, t) {
  const A = hex(a);
  const B = hex(b);
  return toHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}
const alpha = (c, a) => {
  const [r, g, b] = hex(c);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

const DARK_ANSI = ['#1E1F22', '#F0524F', '#5C962C', '#C59A1C', '#3993D4', '#A771BF', '#00A3A3', '#9DA0A8', '#595959', '#FF5F5F', '#4FC414', '#E5BF00', '#1FB0FF', '#ED7EED', '#00E5E5', '#FFFFFF'];
const LIGHT_ANSI = ['#000000', '#C4282B', '#2B7A0B', '#966600', '#0E5FB8', '#8C3A9E', '#00797A', '#6C707E', '#5E5E5E', '#E33E3E', '#3E9A1F', '#B38F00', '#1F7BE0', '#A855C0', '#0A9A9A', '#1E1F22'];

const THEMES = [
  {
    id: 'rider-dark', name: 'Rider Dark', type: 'dark',
    base: { panel: '#2B2D30', editor: '#1E1F22', text: '#DFE1E5', accent: '#3574F0', selection: '#2E436E', border: '#1E1F22', inner: '#393B40' },
    editor: { lineHighlight: '#26282E', selection: '#214283', lineNumber: '#4B5059', lineNumberActive: '#A1A3AB', cursor: '#CED0D6' },
    syntax: { fg: '#BDBDBD', comment: '#85C46C', keyword: '#6C95EB', string: '#C9A26D', number: '#ED94C0', type: '#C191FF', iface: '#C191FF', struct: '#E1BFFF', enum: '#E1BFFF', method: '#39CC9B', field: '#66C3CC', local: '#BDBDBD', param: '#BDBDBD', namespace: '#B5B5B5', constant: '#66C3CC', decorator: '#C191FF', builtin: '#39CC9B', escape: '#D688D4', tag: '#6C95EB', attr: '#66C3CC', event: '#ED94C0' },
  },
  {
    id: 'rider-light', name: 'Rider Light', type: 'light',
    base: { panel: '#F7F8FA', editor: '#FFFFFF', text: '#1E1F22', accent: '#3574F0', selection: '#D4E2FF', border: '#EBECF0', inner: '#EBECF0' },
    editor: { lineHighlight: '#F5F8FE', selection: '#A6D2FF', lineNumber: '#AEB3C2', lineNumberActive: '#767A8A', cursor: '#000000' },
    syntax: { fg: '#080808', comment: '#8C8C8C', keyword: '#0033B3', string: '#067D17', number: '#1750EB', type: '#7E3BB8', iface: '#7E3BB8', struct: '#9A56CF', enum: '#9A56CF', method: '#00627A', field: '#871094', local: '#080808', param: '#080808', namespace: '#5A5A5A', constant: '#871094', decorator: '#9E880D', builtin: '#00627A', escape: '#0037A6', tag: '#0033B3', attr: '#174AD4', event: '#B92A93' },
  },
  {
    id: 'darcula', name: 'Darcula', type: 'dark',
    base: { panel: '#3C3F41', editor: '#2B2B2B', text: '#BBBBBB', accent: '#4A88C7', selection: '#4B6EAF', border: '#323232', inner: '#4B4D4F' },
    editor: { lineHighlight: '#323232', selection: '#214283', lineNumber: '#606366', lineNumberActive: '#A4A3A3', cursor: '#BBBBBB' },
    syntax: { fg: '#A9B7C6', comment: '#808080', keyword: '#CC7832', string: '#6A8759', number: '#6897BB', type: '#A9B7C6', iface: '#A9B7C6', struct: '#A9B7C6', enum: '#A9B7C6', method: '#FFC66D', field: '#9876AA', local: '#A9B7C6', param: '#A9B7C6', namespace: '#A9B7C6', constant: '#9876AA', decorator: '#BBB529', builtin: '#8888C6', escape: '#CC7832', tag: '#E8BF6A', attr: '#BABABA', event: '#9876AA', self: '#94558D' },
  },
  {
    id: 'intellij-light', name: 'IntelliJ Light', type: 'light',
    base: { panel: '#F2F2F2', editor: '#FFFFFF', text: '#000000', accent: '#2675BF', selection: '#D5E1FF', border: '#D1D1D1', inner: '#E4E4E4' },
    editor: { lineHighlight: '#FCFAED', selection: '#A6D2FF', lineNumber: '#ADADAD', lineNumberActive: '#707070', cursor: '#000000' },
    syntax: { fg: '#080808', comment: '#8C8C8C', keyword: '#0033B3', string: '#067D17', number: '#1750EB', type: '#000000', iface: '#000000', struct: '#000000', enum: '#000000', method: '#00627A', field: '#871094', local: '#000000', param: '#000000', namespace: '#000000', constant: '#871094', decorator: '#9E880D', builtin: '#000080', escape: '#0037A6', tag: '#0033B3', attr: '#174AD4', event: '#871094' },
  },
  {
    id: 'high-contrast', name: 'High Contrast', type: 'dark',
    base: { panel: '#000000', editor: '#000000', text: '#FFFFFF', accent: '#1AEBFF', selection: '#0F4C75', border: '#6F6F6F', inner: '#4F4F4F' },
    editor: { lineHighlight: '#1A1A1A', selection: '#264F78', lineNumber: '#8A8A8A', lineNumberActive: '#FFFFFF', cursor: '#FFFFFF' },
    syntax: { fg: '#FFFFFF', comment: '#7CA668', keyword: '#00CCFF', string: '#FFD866', number: '#FF8CFF', type: '#4EC9B0', iface: '#B8D7A3', struct: '#86C691', enum: '#B8D7A3', method: '#DCDCAA', field: '#9CDCFE', local: '#FFFFFF', param: '#9CDCFE', namespace: '#FFFFFF', constant: '#FF8CFF', decorator: '#FFD700', builtin: '#4EC9B0', escape: '#FFD700', tag: '#00CCFF', attr: '#9CDCFE', event: '#FF8CFF' },
  },
  {
    id: 'dracula', name: 'Dracula', type: 'dark',
    base: { panel: '#21222C', editor: '#282A36', text: '#F8F8F2', accent: '#BD93F9', selection: '#44475A', border: '#191A21', inner: '#343746' },
    editor: { lineHighlight: '#2E303E', selection: '#44475A', lineNumber: '#6272A4', lineNumberActive: '#F8F8F2', cursor: '#F8F8F2' },
    syntax: { fg: '#F8F8F2', comment: '#6272A4', keyword: '#FF79C6', string: '#F1FA8C', number: '#BD93F9', type: '#8BE9FD', iface: '#8BE9FD', struct: '#8BE9FD', enum: '#8BE9FD', method: '#50FA7B', field: '#F8F8F2', local: '#F8F8F2', param: '#FFB86C', namespace: '#F8F8F2', constant: '#BD93F9', decorator: '#50FA7B', builtin: '#8BE9FD', escape: '#FF79C6', tag: '#FF79C6', attr: '#50FA7B', event: '#FFB86C' },
  },
  {
    id: 'monokai', name: 'Monokai', type: 'dark',
    base: { panel: '#1E1F1C', editor: '#272822', text: '#F8F8F2', accent: '#A6E22E', selection: '#49483E', border: '#171814', inner: '#3B3C35' },
    editor: { lineHighlight: '#3E3D32', selection: '#49483E', lineNumber: '#75715E', lineNumberActive: '#F8F8F2', cursor: '#F8F8F0' },
    syntax: { fg: '#F8F8F2', comment: '#75715E', keyword: '#F92672', string: '#E6DB74', number: '#AE81FF', type: '#66D9EF', iface: '#66D9EF', struct: '#66D9EF', enum: '#66D9EF', method: '#A6E22E', field: '#F8F8F2', local: '#F8F8F2', param: '#FD971F', namespace: '#F8F8F2', constant: '#AE81FF', decorator: '#A6E22E', builtin: '#66D9EF', escape: '#AE81FF', tag: '#F92672', attr: '#A6E22E', event: '#FD971F' },
  },
  {
    id: 'one-dark', name: 'One Dark', type: 'dark',
    base: { panel: '#21252B', editor: '#282C34', text: '#ABB2BF', accent: '#528BFF', selection: '#2C313A', border: '#181A1F', inner: '#323842' },
    editor: { lineHighlight: '#2C313C', selection: '#3E4451', lineNumber: '#495162', lineNumberActive: '#ABB2BF', cursor: '#528BFF' },
    syntax: { fg: '#ABB2BF', comment: '#5C6370', keyword: '#C678DD', string: '#98C379', number: '#D19A66', type: '#E5C07B', iface: '#E5C07B', struct: '#E5C07B', enum: '#E5C07B', method: '#61AFEF', field: '#E06C75', local: '#E06C75', param: '#D19A66', namespace: '#E5C07B', constant: '#D19A66', decorator: '#E5C07B', builtin: '#56B6C2', escape: '#56B6C2', tag: '#E06C75', attr: '#D19A66', event: '#C678DD' },
  },
  {
    id: 'nord', name: 'Nord', type: 'dark',
    base: { panel: '#2E3440', editor: '#2E3440', text: '#D8DEE9', accent: '#88C0D0', selection: '#434C5E', border: '#262A33', inner: '#3B4252' },
    editor: { lineHighlight: '#3B4252', selection: '#434C5E', lineNumber: '#4C566A', lineNumberActive: '#D8DEE9', cursor: '#D8DEE9' },
    syntax: { fg: '#D8DEE9', comment: '#616E88', keyword: '#81A1C1', string: '#A3BE8C', number: '#B48EAD', type: '#8FBCBB', iface: '#8FBCBB', struct: '#8FBCBB', enum: '#8FBCBB', method: '#88C0D0', field: '#D8DEE9', local: '#D8DEE9', param: '#D8DEE9', namespace: '#8FBCBB', constant: '#B48EAD', decorator: '#D08770', builtin: '#88C0D0', escape: '#EBCB8B', tag: '#81A1C1', attr: '#8FBCBB', event: '#B48EAD' },
  },
  {
    id: 'solarized-dark', name: 'Solarized Dark', type: 'dark',
    base: { panel: '#073642', editor: '#002B36', text: '#93A1A1', accent: '#268BD2', selection: '#0E5A6E', border: '#00212B', inner: '#0A4352' },
    editor: { lineHighlight: '#073642', selection: '#274642', lineNumber: '#586E75', lineNumberActive: '#93A1A1', cursor: '#D30102' },
    syntax: { fg: '#839496', comment: '#586E75', keyword: '#859900', string: '#2AA198', number: '#D33682', type: '#B58900', iface: '#B58900', struct: '#B58900', enum: '#B58900', method: '#268BD2', field: '#268BD2', local: '#839496', param: '#839496', namespace: '#B58900', constant: '#CB4B16', decorator: '#6C71C4', builtin: '#268BD2', escape: '#DC322F', tag: '#268BD2', attr: '#93A1A1', event: '#CB4B16' },
  },
  {
    id: 'solarized-light', name: 'Solarized Light', type: 'light',
    base: { panel: '#EEE8D5', editor: '#FDF6E3', text: '#586E75', accent: '#268BD2', selection: '#DDD6C1', border: '#DDD6C1', inner: '#E4DDC8' },
    editor: { lineHighlight: '#EEE8D5', selection: '#EEE8D5', lineNumber: '#93A1A1', lineNumberActive: '#586E75', cursor: '#657B83' },
    syntax: { fg: '#657B83', comment: '#93A1A1', keyword: '#859900', string: '#2AA198', number: '#D33682', type: '#B58900', iface: '#B58900', struct: '#B58900', enum: '#B58900', method: '#268BD2', field: '#268BD2', local: '#657B83', param: '#657B83', namespace: '#B58900', constant: '#CB4B16', decorator: '#6C71C4', builtin: '#268BD2', escape: '#DC322F', tag: '#268BD2', attr: '#93A1A1', event: '#CB4B16' },
  },
  {
    id: 'github-dark', name: 'GitHub Dark', type: 'dark',
    base: { panel: '#161B22', editor: '#0D1117', text: '#E6EDF3', accent: '#2F81F7', selection: '#1F3A5F', border: '#30363D', inner: '#21262D' },
    editor: { lineHighlight: '#161B22', selection: '#264F78', lineNumber: '#6E7681', lineNumberActive: '#E6EDF3', cursor: '#E6EDF3' },
    syntax: { fg: '#E6EDF3', comment: '#8B949E', keyword: '#FF7B72', string: '#A5D6FF', number: '#79C0FF', type: '#FFA657', iface: '#FFA657', struct: '#FFA657', enum: '#FFA657', method: '#D2A8FF', field: '#79C0FF', local: '#E6EDF3', param: '#FFA657', namespace: '#FFA657', constant: '#79C0FF', decorator: '#D2A8FF', builtin: '#79C0FF', escape: '#79C0FF', tag: '#7EE787', attr: '#79C0FF', event: '#FF7B72' },
  },
  {
    id: 'github-light', name: 'GitHub Light', type: 'light',
    base: { panel: '#F6F8FA', editor: '#FFFFFF', text: '#1F2328', accent: '#0969DA', selection: '#DDF4FF', border: '#D0D7DE', inner: '#E1E4E8' },
    editor: { lineHighlight: '#F6F8FA', selection: '#B6E3FF', lineNumber: '#8C959F', lineNumberActive: '#1F2328', cursor: '#1F2328' },
    syntax: { fg: '#1F2328', comment: '#6E7781', keyword: '#CF222E', string: '#0A3069', number: '#0550AE', type: '#953800', iface: '#953800', struct: '#953800', enum: '#953800', method: '#8250DF', field: '#0550AE', local: '#1F2328', param: '#953800', namespace: '#953800', constant: '#0550AE', decorator: '#8250DF', builtin: '#0550AE', escape: '#0550AE', tag: '#116329', attr: '#0550AE', event: '#CF222E' },
  },
  {
    id: 'catppuccin-mocha', name: 'Catppuccin Mocha', type: 'dark',
    base: { panel: '#181825', editor: '#1E1E2E', text: '#CDD6F4', accent: '#CBA6F7', selection: '#313244', border: '#11111B', inner: '#313244' },
    editor: { lineHighlight: '#2A2B3C', selection: '#45475A', lineNumber: '#585B70', lineNumberActive: '#B4BEFE', cursor: '#F5E0DC' },
    syntax: { fg: '#CDD6F4', comment: '#7F849C', keyword: '#CBA6F7', string: '#A6E3A1', number: '#FAB387', type: '#F9E2AF', iface: '#F9E2AF', struct: '#F9E2AF', enum: '#F9E2AF', method: '#89B4FA', field: '#B4BEFE', local: '#CDD6F4', param: '#EBA0AC', namespace: '#F9E2AF', constant: '#FAB387', decorator: '#F5C2E7', builtin: '#89DCEB', escape: '#F5C2E7', tag: '#CBA6F7', attr: '#F9E2AF', event: '#F38BA8' },
  },
  {
    id: 'catppuccin-latte', name: 'Catppuccin Latte', type: 'light',
    base: { panel: '#E6E9EF', editor: '#EFF1F5', text: '#4C4F69', accent: '#8839EF', selection: '#CCD0DA', border: '#DCE0E8', inner: '#DCE0E8' },
    editor: { lineHighlight: '#E6E9EF', selection: '#ACB0BE', lineNumber: '#9CA0B0', lineNumberActive: '#4C4F69', cursor: '#DC8A78' },
    syntax: { fg: '#4C4F69', comment: '#9CA0B0', keyword: '#8839EF', string: '#40A02B', number: '#FE640B', type: '#DF8E1D', iface: '#DF8E1D', struct: '#DF8E1D', enum: '#DF8E1D', method: '#1E66F5', field: '#7287FD', local: '#4C4F69', param: '#E64553', namespace: '#DF8E1D', constant: '#FE640B', decorator: '#EA76CB', builtin: '#04A5E5', escape: '#EA76CB', tag: '#8839EF', attr: '#DF8E1D', event: '#D20F39' },
  },
  {
    id: 'tokyo-night', name: 'Tokyo Night', type: 'dark',
    base: { panel: '#16161E', editor: '#1A1B26', text: '#C0CAF5', accent: '#7AA2F7', selection: '#283457', border: '#101014', inner: '#232433' },
    editor: { lineHighlight: '#1F2335', selection: '#283457', lineNumber: '#3B4261', lineNumberActive: '#737AA2', cursor: '#C0CAF5' },
    syntax: { fg: '#C0CAF5', comment: '#565F89', keyword: '#BB9AF7', string: '#9ECE6A', number: '#FF9E64', type: '#2AC3DE', iface: '#2AC3DE', struct: '#2AC3DE', enum: '#2AC3DE', method: '#7AA2F7', field: '#73DACA', local: '#C0CAF5', param: '#E0AF68', namespace: '#2AC3DE', constant: '#FF9E64', decorator: '#BB9AF7', builtin: '#2AC3DE', escape: '#89DDFF', tag: '#F7768E', attr: '#73DACA', event: '#F7768E' },
  },
  {
    id: 'gruvbox-dark', name: 'Gruvbox Dark', type: 'dark',
    base: { panel: '#1D2021', editor: '#282828', text: '#EBDBB2', accent: '#83A598', selection: '#3C3836', border: '#141617', inner: '#32302F' },
    editor: { lineHighlight: '#32302F', selection: '#504945', lineNumber: '#665C54', lineNumberActive: '#EBDBB2', cursor: '#EBDBB2' },
    syntax: { fg: '#EBDBB2', comment: '#928374', keyword: '#FB4934', string: '#B8BB26', number: '#D3869B', type: '#FABD2F', iface: '#FABD2F', struct: '#FABD2F', enum: '#FABD2F', method: '#8EC07C', field: '#83A598', local: '#EBDBB2', param: '#EBDBB2', namespace: '#FABD2F', constant: '#D3869B', decorator: '#FE8019', builtin: '#FE8019', escape: '#FE8019', tag: '#FB4934', attr: '#FABD2F', event: '#D3869B' },
  },
  {
    id: 'night-owl', name: 'Night Owl', type: 'dark',
    base: { panel: '#01111D', editor: '#011627', text: '#D6DEEB', accent: '#82AAFF', selection: '#1D3B53', border: '#010D16', inner: '#0B2942' },
    editor: { lineHighlight: '#01121F', selection: '#1D3B53', lineNumber: '#4B6479', lineNumberActive: '#C5E4FD', cursor: '#80A4C2' },
    syntax: { fg: '#D6DEEB', comment: '#637777', keyword: '#C792EA', string: '#ECC48D', number: '#F78C6C', type: '#FFCB8B', iface: '#FFCB8B', struct: '#FFCB8B', enum: '#FFCB8B', method: '#82AAFF', field: '#7FDBCA', local: '#D6DEEB', param: '#D7DBE0', namespace: '#FFCB8B', constant: '#F78C6C', decorator: '#C5E478', builtin: '#ADDB67', escape: '#F78C6C', tag: '#CAECE6', attr: '#ADDB67', event: '#FF5874' },
  },
];

// One spelling for every color (#rrggbb) so built-in and custom themes compare and export alike.
for (const t of THEMES) for (const g of ['base', 'editor', 'syntax']) for (const k of Object.keys(t[g])) t[g][k] = t[g][k].toLowerCase();

/** Theme list for pickers: built-ins first, then the user's custom themes (kept in place). */
export const themes = THEMES.map(({ id, name, type }) => ({ id, name, type }));
const BUILTIN_COUNT = themes.length;
let CUSTOM = [];

let PREVIEW = null; // theme being edited (applied live before it is saved)

export const themeById = (id) => (PREVIEW && PREVIEW.id === id ? PREVIEW : null) || CUSTOM.find((t) => t.id === id) || THEMES.find((t) => t.id === id) || THEMES[0];

/** Theme editor: show unsaved edits of a custom theme everywhere it is used (null to stop). */
export function setPreviewTheme(theme) {
  PREVIEW = theme ? completeTheme(theme) : null;
}
export const builtinThemes = () => THEMES.slice();
export const isCustomTheme = (id) => CUSTOM.some((t) => t.id === id);

/** Color groups a theme defines (also the fields of the theme editor). */
export const THEME_FIELDS = {
  base: ['panel', 'editor', 'text', 'accent', 'selection', 'border', 'inner'],
  editor: ['lineHighlight', 'selection', 'lineNumber', 'lineNumberActive', 'cursor'],
  syntax: ['fg', 'comment', 'keyword', 'string', 'number', 'type', 'iface', 'struct', 'enum', 'method', 'field', 'local', 'param', 'namespace', 'constant', 'decorator', 'builtin', 'escape', 'tag', 'attr', 'event', 'self'],
};

const COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** #RGB / #RRGGBB / #RRGGBBAA -> #rrggbb (alpha dropped: colors are mixed and derived). */
export function normalizeColor(c) {
  if (typeof c !== 'string' || !COLOR.test(c.trim())) return null;
  const v = c.trim().slice(1);
  const six = v.length === 3 ? v.split('').map((x) => x + x).join('') : v.slice(0, 6);
  return `#${six.toLowerCase()}`;
}

/** A complete theme from a partial definition: missing or invalid colors come from `basedOn`. */
export function completeTheme(def) {
  const base = THEMES.find((t) => t.id === def.basedOn) || CUSTOM.find((t) => t.id === def.basedOn && t.id !== def.id) || (def.type === 'light' ? THEMES[1] : THEMES[0]);
  const out = { id: def.id, name: String(def.name || 'Custom Theme'), type: def.type === 'light' ? 'light' : 'dark', basedOn: base.id, custom: true };
  for (const [group, keys] of Object.entries(THEME_FIELDS)) {
    out[group] = {};
    for (const k of keys) {
      const own = normalizeColor(def[group] && def[group][k]);
      const inherited = base[group] && base[group][k];
      if (own) out[group][k] = own;
      else if (inherited) out[group][k] = inherited;
    }
  }
  const ansi = def.terminal && Array.isArray(def.terminal.ansi) ? def.terminal.ansi.map(normalizeColor) : null;
  if (ansi && ansi.length === 16 && ansi.every(Boolean)) out.terminal = { ansi };
  else if (base.terminal) out.terminal = base.terminal;
  return out;
}

/** Register the user's custom themes (settings.customThemes). */
export function setCustomThemes(list) {
  CUSTOM = [];
  for (const def of Array.isArray(list) ? list : []) {
    if (!def || typeof def.id !== 'string' || !def.id.startsWith('custom-')) continue;
    CUSTOM.push(completeTheme(def));
  }
  themes.length = BUILTIN_COUNT;
  for (const t of CUSTOM) themes.push({ id: t.id, name: t.name, type: t.type, custom: true });
  return CUSTOM;
}

/** CSS variables for the UI. */
export function cssVars(t) {
  const b = t.base;
  const dark = t.type === 'dark';
  const text = b.text;
  return {
    '--bg': b.panel,
    '--bg-editor': b.editor,
    '--bg-toolbar': b.panel,
    '--bg-elevated': dark ? mix(b.panel, '#FFFFFF', 0.02) : '#FFFFFF',
    '--bg-input': dark ? mix(b.editor, b.panel, 0.35) : '#FFFFFF',
    '--bg-hover': alpha(text, dark ? 0.07 : 0.06),
    '--bg-active': alpha(text, dark ? 0.12 : 0.1),
    '--bg-selection': b.selection,
    '--bg-selection-inactive': alpha(text, dark ? 0.1 : 0.08),
    '--bg-badge': alpha(text, 0.12),
    '--border': b.border,
    '--border-inner': b.inner,
    '--border-strong': mix(b.inner, text, 0.15),
    '--text': text,
    '--text-secondary': mix(text, b.panel, 0.42),
    '--text-disabled': mix(text, b.panel, 0.6),
    '--accent': b.accent,
    '--accent-hover': mix(b.accent, dark ? '#FFFFFF' : '#000000', 0.12),
    '--accent-soft': alpha(b.accent, 0.18),
    '--on-accent': '#FFFFFF',
    '--link': dark ? mix(b.accent, '#FFFFFF', 0.2) : b.accent,
    '--error': dark ? '#E5675F' : '#D23B3B',
    '--warning': dark ? '#E6B450' : '#B57D00',
    '--info': b.accent,
    '--success': dark ? '#5FB865' : '#208A3C',
    '--git-added': dark ? '#73BD79' : '#368746',
    '--git-modified': dark ? '#6C9FE8' : '#2B6BC4',
    '--git-deleted': dark ? '#868A91' : '#7C7F87',
    '--git-untracked': dark ? '#D9706B' : '#C44B44',
    '--git-ignored': dark ? '#8C8C5A' : '#8A8A4A',
    '--git-conflict': dark ? '#E06C75' : '#C2185B',
    '--scrollbar': alpha(text, dark ? 0.16 : 0.2),
    '--scrollbar-hover': alpha(text, dark ? 0.28 : 0.32),
    '--shadow': dark ? '0 8px 28px rgba(0,0,0,0.45)' : '0 8px 28px rgba(0,0,0,0.16)',
    '--focus': alpha(b.accent, 0.55),
    '--code-fg': t.syntax.fg,
    '--syn-keyword': t.syntax.keyword,
    '--syn-string': t.syntax.string,
    '--syn-type': t.syntax.type,
    '--syn-method': t.syntax.method,
    '--syn-comment': t.syntax.comment,
    '--syn-number': t.syntax.number,
    '--syn-field': t.syntax.field,
    '--graph-file': dark ? '#6C9FE8' : '#2B6BC4',
    '--graph-class': t.syntax.type,
    '--graph-method': t.syntax.method,
    '--graph-function': t.syntax.method,
    '--graph-interface': t.syntax.iface,
    '--graph-edge': alpha(text, 0.22),
  };
}

const strip = (c) => c.replace('#', '').toUpperCase();

/** Monaco theme definition. */
export function monacoTheme(t) {
  const s = t.syntax;
  const e = t.editor;
  const b = t.base;
  const dark = t.type === 'dark';
  const r = (token, color, fontStyle) => ({ token, foreground: strip(color), ...(fontStyle ? { fontStyle } : {}) });
  const rules = [
    r('', s.fg),
    r('comment', s.comment, t.id === 'one-dark' || t.id === 'night-owl' ? 'italic' : undefined),
    r('comment.doc', s.comment),
    r('keyword', s.keyword),
    r('keyword.flow', s.keyword),
    r('keyword.json', s.keyword),
    r('string', s.string),
    r('string.escape', s.escape || s.keyword),
    r('string.key.json', s.field),
    r('string.value.json', s.string),
    r('number', s.number),
    r('number.float', s.number),
    r('number.hex', s.number),
    r('regexp', s.escape || s.string),
    r('type', s.type),
    r('type.identifier', s.type),
    r('identifier', s.fg),
    r('delimiter', s.fg),
    r('operator', s.fg),
    r('tag', s.tag || s.keyword),
    r('metatag', s.tag || s.keyword),
    r('attribute.name', s.attr || s.field),
    r('attribute.value', s.string),
    r('annotation', s.decorator),
    r('predefined', s.builtin),
    r('variable', s.local),
    r('constant', s.constant),
    // Semantic token types (from the code index / language servers).
    r('namespace', s.namespace),
    r('module', s.namespace),
    r('class', s.type),
    r('record', s.struct),
    r('struct', s.struct),
    r('interface', s.iface),
    r('enum', s.enum),
    r('delegate', s.type),
    r('typeParameter', s.type),
    r('parameter', s.param),
    r('local', s.local),
    r('field', s.field),
    r('property', s.field),
    r('enumMember', s.constant),
    r('event', s.event || s.field),
    r('function', s.method),
    r('method', s.method),
    r('decorator', s.decorator),
    r('attribute', s.decorator),
    r('constant', s.constant),
    r('builtin', s.builtin),
    r('selfKeyword', s.self || s.keyword),
  ];
  const colors = {
    'editor.background': b.editor,
    'editor.foreground': s.fg,
    'editorLineNumber.foreground': e.lineNumber,
    'editorLineNumber.activeForeground': e.lineNumberActive,
    'editor.lineHighlightBackground': e.lineHighlight,
    'editor.lineHighlightBorder': e.lineHighlight,
    'editor.selectionBackground': e.selection,
    'editor.inactiveSelectionBackground': mix(e.selection, b.editor, 0.4),
    'editorCursor.foreground': e.cursor,
    'editorIndentGuide.background1': mix(b.editor, s.fg, 0.12),
    'editorIndentGuide.activeBackground1': mix(b.editor, s.fg, 0.3),
    'editorWhitespace.foreground': mix(b.editor, s.fg, 0.2),
    'editorGutter.background': b.editor,
    'minimap.background': b.editor,
    'editorWidget.background': dark ? mix(b.panel, '#FFFFFF', 0.02) : '#FFFFFF',
    'editorWidget.border': b.inner,
    'editorSuggestWidget.background': dark ? mix(b.panel, '#FFFFFF', 0.02) : '#FFFFFF',
    'editorSuggestWidget.border': b.inner,
    'editorSuggestWidget.selectedBackground': b.selection,
    'editorHoverWidget.background': dark ? mix(b.panel, '#FFFFFF', 0.02) : '#FFFFFF',
    'editorHoverWidget.border': b.inner,
    'editorCodeLens.foreground': mix(s.fg, b.editor, 0.45),
    'editorBracketMatch.background': mix(b.editor, b.accent, 0.25),
    'editorBracketMatch.border': mix(b.editor, b.accent, 0.5),
    'editor.findMatchBackground': dark ? '#32593D' : '#F6E3A1',
    'editor.findMatchHighlightBackground': dark ? '#2B4A36' : '#FFF3C4',
    'editor.wordHighlightBackground': mix(b.editor, s.fg, 0.12),
    'editor.wordHighlightStrongBackground': mix(b.editor, b.accent, 0.25),
    'diffEditor.insertedTextBackground': dark ? '#3D6D4466' : '#BEE6BE99',
    'diffEditor.removedTextBackground': dark ? '#7A3B3B66' : '#F5C0C099',
    'diffEditor.insertedLineBackground': dark ? '#29442F55' : '#E6F6E699',
    'diffEditor.removedLineBackground': dark ? '#48272755' : '#FBE7E799',
    'editorError.foreground': dark ? '#E5675F' : '#D23B3B',
    'editorWarning.foreground': dark ? '#E6B450' : '#B57D00',
    'editorInfo.foreground': b.accent,
    'editorOverviewRuler.border': b.editor,
    'scrollbarSlider.background': dark ? '#FFFFFF22' : '#00000022',
    'scrollbarSlider.hoverBackground': dark ? '#FFFFFF38' : '#00000038',
    'scrollbarSlider.activeBackground': dark ? '#FFFFFF48' : '#00000048',
    focusBorder: b.accent,
    'list.activeSelectionBackground': b.selection,
    'list.hoverBackground': mix(b.panel, b.text, 0.07),
    'input.background': dark ? mix(b.editor, b.panel, 0.35) : '#FFFFFF',
    'editorStickyScroll.background': b.editor,
    'editorStickyScrollHover.background': e.lineHighlight,
  };
  return { base: dark ? 'vs-dark' : 'vs', inherit: true, rules, colors };
}

/** xterm.js theme. */
export const DEFAULT_ANSI = { dark: DARK_ANSI, light: LIGHT_ANSI };

export function terminalTheme(t) {
  const ansi = t.terminal && t.terminal.ansi && t.terminal.ansi.length === 16 ? t.terminal.ansi : t.type === 'dark' ? DARK_ANSI : LIGHT_ANSI;
  const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
  const out = { background: t.base.panel, foreground: t.base.text, cursor: t.editor.cursor, cursorAccent: t.base.panel, selectionBackground: t.editor.selection };
  names.forEach((n, i) => (out[n] = ansi[i]));
  if (!t.terminal) out.black = t.type === 'dark' ? mix(t.base.panel, '#000000', 0.3) : '#000000';
  return out;
}

export function applyThemeVars(id) {
  const t = themeById(id);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(cssVars(t))) root.style.setProperty(k, v);
  root.dataset.theme = t.id;
  root.dataset.themeType = t.type;
  return t;
}
