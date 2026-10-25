// 16px icons in the style of the JetBrains New UI, plus file-type icons.
import { html } from './preact.js';

const S = (d, extra = '') => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;
const F = (d, extra = '') => `<path d="${d}" fill="currentColor" ${extra}/>`;

export const ICONS = {
  chevronRight: S('M6 4l4 4-4 4'),
  chevronDown: S('M4 6l4 4 4-4'),
  chevronUp: S('M4 10l4-4 4 4'),
  close: S('M4.5 4.5l7 7M11.5 4.5l-7 7'),
  plus: S('M8 3v10M3 8h10'),
  minus: S('M3 8h10'),
  check: S('M3.5 8.5l3 3 6-7'),
  refresh: S('M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5'),
  search: S('M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM10.6 10.6L14 14'),
  settings: S('M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z') + S('M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1'),
  play: F('M5 3.2v9.6a.5.5 0 0 0 .77.42l7.2-4.8a.5.5 0 0 0 0-.84l-7.2-4.8A.5.5 0 0 0 5 3.2z'),
  stop: F('M4 4h8v8H4z', 'rx="1"'),
  debug: S('M5 6.5a3 3 0 0 1 6 0V10a3 3 0 0 1-6 0zM8 6.5V13M2.5 8.5H5M11 8.5h2.5M3 4.5l2 1.5M13 4.5l-2 1.5M3 12.5l2-1.5M13 12.5l-2-1.5M6.2 3.6L5 2.5M9.8 3.6L11 2.5'),
  resume: S('M3.5 3.5v9') + F('M6.2 3.4v9.2a.5.5 0 0 0 .78.41l6.5-4.6a.5.5 0 0 0 0-.82L6.98 2.99a.5.5 0 0 0-.78.41z'),
  pause: F('M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z'),
  stepOver: S('M2.5 9a5.5 5.5 0 0 1 10.6-2M13.5 3.8V7.3H10') + F('M8 14.3a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8z'),
  stepInto: S('M8 2v7M5 6.2l3 3 3-3') + F('M8 14.3a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8z'),
  stepOut: S('M8 9.5V2.5M5 5.3l3-3 3 3') + F('M8 14.3a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8z'),
  runToCursor: S('M2.5 4.5h7.5M8 2.2l2.3 2.3L8 6.8M2.5 9h11M2.5 12.5h7'),
  breakpoint: F('M8 12.6a4.6 4.6 0 1 0 0-9.2 4.6 4.6 0 0 0 0 9.2z'),
  muteBreakpoints: S('M8 12.6a4.6 4.6 0 1 0 0-9.2 4.6 4.6 0 0 0 0 9.2zM3 13l10-10'),
  evaluate: S('M3.5 2.5h9v11h-9zM5.5 5h5M5.5 8h1M8 8h1M10.5 8h.1M5.5 10.8h1M8 10.8h1M10.5 10.8h.1'),
  exceptionBreak: S('M9.2 1.8L4 9h4l-1.2 5.2L12 7H8z'),
  frames: S('M3 3.5h10M3 6.5h10M3 9.5h10M3 12.5h6'),
  hammer: S('M9.5 2.5l4 4-2 2-4-4zM7.5 4.5L2.5 9.5a1.4 1.4 0 0 0 2 2l5-5'),
  rebuild: S('M9.5 2.5l4 4-2 2-4-4zM7.5 4.5L2.5 9.5a1.4 1.4 0 0 0 2 2l5-5') + S('M12.5 11.5v2h-2'),
  branch: S('M5 3.5v9M5 12.5a1.5 1.5 0 1 0 0 .01M5 3.5a1.5 1.5 0 1 0 0 .01M11 4.5a1.5 1.5 0 1 0 0 .01M11 6c0 3-6 2.5-6 5'),
  commit: S('M8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM1.5 8h4M10.5 8h4'),
  git: S('M5 3.5v9M11 6c0 3-6 2.5-6 5M11 4.5a1.5 1.5 0 1 0 0 .01M5 13a1.5 1.5 0 1 0 0 .01M5 4a1.5 1.5 0 1 0 0 .01'),
  terminal: S('M2.5 3.5h11v9h-11zM5 6.5l2 1.5-2 1.5M8.5 10h2.5'),
  problems: S('M8 2.5l6 10.5H2zM8 6.5v3M8 11.3v.1'),
  project: S('M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5H3a1 1 0 0 0-1 1z'),
  structure: S('M3 3.5h4M3 7.5h7M3 11.5h5M2 3.5h.1M2 7.5h.1M2 11.5h.1'),
  bell: S('M4 11V7.5a4 4 0 0 1 8 0V11l1 1H3zM6.5 13.5a1.5 1.5 0 0 0 3 0'),
  more: F('M8 4.2a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM8 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM8 13.8a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'),
  hide: S('M3.5 8h9'),
  collapseAll: S('M4 6l4-3 4 3M4 13l4-3 4 3'),
  expandAll: S('M4 3l4 3 4-3M4 10l4 3 4-3'),
  locate: S('M8 12.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15') + F('M8 9.3a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6z'),
  filter: S('M2.5 3.5h11L9.5 8.5v4l-3 1.5V8.5z'),
  error: F('M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z', 'opacity=".95"') + `<path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="var(--bg-editor)" stroke-width="1.4" stroke-linecap="round"/>`,
  warning: F('M7.13 2.5a1 1 0 0 1 1.74 0l5.7 10a1 1 0 0 1-.87 1.5H2.3a1 1 0 0 1-.87-1.5z') + `<path d="M8 6v3.5M8 11.4v.2" stroke="var(--bg-editor)" stroke-width="1.4" stroke-linecap="round"/>`,
  info: F('M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z') + `<path d="M8 7.2v4M8 4.9v.2" stroke="var(--bg-editor)" stroke-width="1.4" stroke-linecap="round"/>`,
  success: F('M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z') + `<path d="M5.2 8.2l1.9 1.9 3.7-4" fill="none" stroke="var(--bg-editor)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  arrowUp: S('M8 13V3M4 7l4-4 4 4'),
  arrowDown: S('M8 3v10M4 9l4 4 4-4'),
  arrowLeft: S('M13 8H3M7 4L3 8l4 4'),
  arrowRight: S('M3 8h10M9 4l4 4-4 4'),
  pull: S('M8 2.5v8M4.5 7l3.5 3.5L11.5 7M3 13.5h10'),
  push: S('M8 13.5v-8M4.5 9L8 5.5 11.5 9M3 2.5h10'),
  fetch: S('M3 9.5a5 5 0 0 0 10 0M8 2.5v8M5.5 8l2.5 2.5L10.5 8'),
  stash: S('M2.5 5.5h11v7a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1zM1.5 3h13v2.5h-13zM6.5 8h3'),
  diff: S('M5 2.5v6M2 5.5h6M8.5 11h5M3.5 13.5h9'),
  file: S('M4 1.5h5l3.5 3.5v8.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1zM9 1.5V5h3.5'),
  folder: S('M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5H3a1 1 0 0 0-1 1z'),
  history: S('M8 14a6 6 0 1 0-6-6M2 8l-1-1.5M2 8l1.5-1M8 4.5V8l2.5 1.5'),
  send: F('M2.4 2.6a.6.6 0 0 1 .82-.7l10.6 5.5a.7.7 0 0 1 0 1.2L3.2 14.1a.6.6 0 0 1-.82-.7L3.6 9 9 8 3.6 7z'),
  sparkle: F('M8 1l1.1 3.6a3 3 0 0 0 2.3 2.3L15 8l-3.6 1.1a3 3 0 0 0-2.3 2.3L8 15l-1.1-3.6a3 3 0 0 0-2.3-2.3L1 8l3.6-1.1a3 3 0 0 0 2.3-2.3z'),
  claude: F('M8 .8l.9 4.3 3.4-2.8-2 3.9 4.4.4-4.1 1.6 3.4 2.9-4.3-1L10 14.6 8 10.7 6 14.6l.3-4.5-4.3 1 3.4-2.9L1.3 6.6l4.4-.4-2-3.9 3.4 2.8z'),
  skill: F('M9.2 1.2L3.5 9h4l-1 5.8L12.5 7h-4z'),
  agent: S('M4 6.5h8a1.5 1.5 0 0 1 1.5 1.5v3.5A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5V8A1.5 1.5 0 0 1 4 6.5zM8 6.5V4M8 3.2v.1M6 9.5v.5M10 9.5v.5M1.5 9v2M14.5 9v2'),
  copy: S('M5.5 5.5h7v8h-7zM3.5 10.5v-8h7'),
  insert: S('M3 8h7M7 5l3 3-3 3M13 3v10'),
  trash: S('M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9M7 7v4M9 7v4'),
  edit: S('M10.5 2.5l3 3-8 8H2.5v-3z'),
  external: S('M9 2.5h4.5V7M13.5 2.5L7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3'),
  eye: S('M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'),
  graph: S('M4 4.5a1.5 1.5 0 1 0 0-.01M12 4a1.5 1.5 0 1 0 0-.01M8 12.5a1.5 1.5 0 1 0 0-.01M5.3 4.3l5.3-.3M4.6 5.7l2.6 5.4M11.4 5.5l-2.6 5.6'),
  flow: S('M1.5 4.5h3v3h-3zM11.5 2.5h3v3h-3zM11.5 10.5h3v3h-3zM4.5 6h2.5a1.5 1.5 0 0 0 1.5-1.5v0A1.5 1.5 0 0 1 10 3h1.5M4.5 6h2.5a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 0 10 12h1.5'),
  database: S('M8 5.5c3 0 5-.9 5-2s-2-2-5-2-5 .9-5 2 2 2 5 2zM3 3.5v9c0 1.1 2 2 5 2s5-.9 5-2v-9M3 8c0 1.1 2 2 5 2s5-.9 5-2'),
  topic: S('M2.5 5h11M2.5 8h11M2.5 11h11M5 3l-1 10M12 3l-1 10'),
  service: S('M2.5 3.5h11v4h-11zM2.5 8.5h11v4h-11zM5 5.5h.1M5 10.5h.1'),
  test: S('M6 2.5h4M7 2.5v4L3.5 12.5a1 1 0 0 0 .9 1.5h7.2a1 1 0 0 0 .9-1.5L9 6.5v-4M5.2 9.5h5.6'),
  todo: S('M3 4l1.2 1.2L6.5 3M8.5 4.5h5M3 9l1.2 1.2L6.5 8M8.5 9.5h5M3 13.5h.1M8.5 13.5h5'),
  package: S('M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8zM2.5 4.8L8 7.8l5.5-3M8 7.8v6.4M5.2 3.3l5.5 3'),
  book: S('M3 2.5h7.5a2 2 0 0 1 2 2v9H5a2 2 0 0 1-2-2zM3 11.5a2 2 0 0 1 2-2h7.5'),
  bookmark: S('M4 2.5h8v11l-4-3-4 3z'),
  usages: S('M2.5 4h7M2.5 8h11M2.5 12h7') + F('M12.5 2.5l2 1.5-2 1.5zM12.5 10.5l2 1.5-2 1.5z'),
  lightbulb: S('M6 12h4M6.5 14h3M5.2 9.5A4 4 0 1 1 10.8 9.5c-.6.6-.8 1.1-.8 2.5H6c0-1.4-.2-1.9-.8-2.5z'),
  layout: S('M2.5 2.5h11v11h-11zM6.5 2.5v11M6.5 9h7'),
  maximize: S('M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3'),
  pin: S('M9.5 2l4.5 4.5-1.5.5-2.5 2.5.5 3-1 1-3-3L3 14.5M5.5 7.5l3 3'),
  globe: S('M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM1.5 8h13M8 1.5c2 2 2 11 0 13M8 1.5c-2 2-2 11 0 13'),
  link: S('M6.5 9.5l3-3M5.5 7.5L4 9a2.1 2.1 0 0 0 3 3l1.5-1.5M10.5 8.5L12 7a2.1 2.1 0 0 0-3-3L7.5 5.5'),
  key: S('M10 9a3.5 3.5 0 1 0-3.4-2.7L2 11v2.5h2.5V12H6v-1.5h1.5L8.7 9.3A3.5 3.5 0 0 0 10 9zM11 5.2v.1'),
  question: S('M6 6a2 2 0 1 1 3 1.7c-.7.4-1 .9-1 1.8M8 11.5v.1') + S('M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z'),
  web: S('M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM1.5 8h13M8 1.5c2 2 2 11 0 13M8 1.5c-2 2-2 11 0 13'),
  run: F('M5 3.2v9.6a.5.5 0 0 0 .77.42l7.2-4.8a.5.5 0 0 0 0-.84l-7.2-4.8A.5.5 0 0 0 5 3.2z'),
  node: S('M8 1.6l5.6 3.2v6.4L8 14.4l-5.6-3.2V4.8z'),
  upload: S('M8 11V2.5M4.5 6L8 2.5 11.5 6M2.5 10v3h11v-3'),
  download: S('M8 2.5V11M4.5 7.5L8 11l3.5-3.5M2.5 13.5h11'),
  zoomIn: S('M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM10.6 10.6L14 14M7 5v4M5 7h4'),
  zoomOut: S('M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM10.6 10.6L14 14M5 7h4'),
  fit: S('M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3M5.5 5.5h5v5h-5z'),
  spinner: `<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="1.6"/><path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`,
  dot: F('M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'),
  palette: S('M8 14.5A6.5 6.5 0 1 1 14.5 8c0 1.5-1.2 2.3-2.5 2.3h-1.4a1.2 1.2 0 0 0-.9 2 1.2 1.2 0 0 1-.9 2.2zM4.8 8h.1M6.3 5h.1M9.7 5h.1M11.2 7.5h.1'),
  keyboard: S('M1.5 4.5h13v7h-13zM4 7h.1M6.5 7h.1M9 7h.1M11.5 7h.1M5 9.5h6'),
  image: S('M2.5 3h11v10h-11zM2.5 11l3.5-3.5 3 3 2-2 2.5 2.5M10.5 6h.1'),
  shield: S('M8 1.5l5.5 2v4c0 3.3-2.3 6-5.5 7-3.2-1-5.5-3.7-5.5-7v-4z'),
  zen: S('M2.5 2.5h11v11h-11zM5 5h6v6H5z'),
  blame: S('M5.5 6a2 2 0 1 0 0-.01M2.5 13c0-2 1.3-3.5 3-3.5s3 1.5 3 3.5M10 5h4M10 8h4M10 11h3'),
  wand: S('M2.5 13.5l8-8M9 2v2M12 5h2M12.5 2.5l-1 1M7 4l1 1M11 8l1 1'),
  attach: S('M10.5 4.5l-5 5a1.5 1.5 0 0 0 2 2l5.5-5.5a2.6 2.6 0 0 0-3.7-3.7L3.8 7.8a3.6 3.6 0 0 0 5.1 5.1l4.1-4.1'),
};

export function Icon({ name, size = 16, className = '', title, style }) {
  const body = ICONS[name] || ICONS.file;
  return html`<svg class=${`icon ${className}`} width=${size} height=${size} viewBox="0 0 16 16" aria-hidden=${title ? undefined : 'true'} style=${style} dangerouslySetInnerHTML=${{ __html: (title ? `<title>${title}</title>` : '') + body }}></svg>`;
}

// ------------------------------------------------------------ file icons

const badge = (text, bg, fg = '#FFFFFF', size = text.length > 2 ? 5.2 : 6.4) =>
  `<rect x="1.5" y="2.5" width="13" height="11" rx="2.5" fill="${bg}"/><text x="8" y="10.7" text-anchor="middle" font-family="Inter, -apple-system, sans-serif" font-weight="700" font-size="${size}" fill="${fg}">${text}</text>`;
const doc = (color, inner = '') => `<path d="M4 1.5h5l3.5 3.5v8.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1z" fill="none" stroke="${color}" stroke-width="1.2"/><path d="M9 1.5V5h3.5" fill="none" stroke="${color}" stroke-width="1.2"/>${inner}`;

const FILE_ICONS = {
  '.cs': badge('C#', '#8E5BD8'),
  '.csx': badge('C#', '#8E5BD8'),
  '.fs': badge('F#', '#378BBA'),
  '.vb': badge('VB', '#00519A'),
  '.py': `<path d="M7.9 1.5c-3.4 0-3.2 1.5-3.2 1.5v1.6h3.3v.5H3.4S1.3 4.9 1.3 8.2s1.9 3.3 1.9 3.3h1.1V9.9s-.1-1.9 1.9-1.9h3.2s1.8 0 1.8-1.8V3.4s.3-1.9-3.3-1.9zM6.1 2.6a.6.6 0 1 1 0 1.2.6.6 0 0 1 0-1.2z" fill="#4B8BBE"/><path d="M8.1 14.5c3.4 0 3.2-1.5 3.2-1.5v-1.6H8v-.5h4.6s2.1.2 2.1-3.1-1.9-3.3-1.9-3.3h-1.1v1.6s.1 1.9-1.9 1.9H6.6s-1.8 0-1.8 1.8v2.8s-.3 1.9 3.3 1.9zm1.8-1.1a.6.6 0 1 1 0-1.2.6.6 0 0 1 0 1.2z" fill="#FFD43B"/>`,
  '.pyi': badge('Py', '#4B8BBE'),
  '.ipynb': badge('Nb', '#E46E2E'),
  '.js': badge('JS', '#E8C547', '#1E1F22'),
  '.mjs': badge('JS', '#E8C547', '#1E1F22'),
  '.cjs': badge('JS', '#E8C547', '#1E1F22'),
  '.jsx': badge('JSX', '#5BC0DE', '#1E1F22'),
  '.ts': badge('TS', '#3178C6'),
  '.tsx': badge('TSX', '#3178C6'),
  '.json': `<text x="8" y="12" text-anchor="middle" font-family="JetBrains Mono, monospace" font-weight="700" font-size="10" fill="#E8A33E">{}</text>`,
  '.md': badge('M↓', '#5A8DCC'),
  '.yml': badge('Y', '#D46A6A'),
  '.yaml': badge('Y', '#D46A6A'),
  '.toml': badge('T', '#9C7A5B'),
  '.html': `<text x="8" y="11.5" text-anchor="middle" font-family="JetBrains Mono, monospace" font-weight="700" font-size="8" fill="#E8743B">&lt;/&gt;</text>`,
  '.css': badge('#', '#3D8FD1'),
  '.scss': badge('S', '#C6538C'),
  '.xml': `<text x="8" y="11.5" text-anchor="middle" font-family="JetBrains Mono, monospace" font-weight="700" font-size="8" fill="#E07D3C">&lt;&gt;</text>`,
  '.csproj': `<rect x="2" y="3" width="12" height="10" rx="2" fill="none" stroke="#5B8DEF" stroke-width="1.3"/><path d="M5 6.5h6M5 9.5h4" stroke="#5B8DEF" stroke-width="1.3" stroke-linecap="round"/>`,
  '.fsproj': `<rect x="2" y="3" width="12" height="10" rx="2" fill="none" stroke="#378BBA" stroke-width="1.3"/><path d="M5 6.5h6M5 9.5h4" stroke="#378BBA" stroke-width="1.3" stroke-linecap="round"/>`,
  '.sln': `<path d="M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z" fill="#8E5BD8" fill-opacity=".22" stroke="#A47CE6" stroke-width="1.2"/><path d="M2.5 4.8L8 7.8l5.5-3M8 7.8v6.4" fill="none" stroke="#A47CE6" stroke-width="1.2"/>`,
  '.slnx': `<path d="M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z" fill="#8E5BD8" fill-opacity=".22" stroke="#A47CE6" stroke-width="1.2"/><path d="M2.5 4.8L8 7.8l5.5-3M8 7.8v6.4" fill="none" stroke="#A47CE6" stroke-width="1.2"/>`,
  '.sh': badge('>_', '#4E9A4E', '#FFFFFF', 5.6),
  '.zsh': badge('>_', '#4E9A4E', '#FFFFFF', 5.6),
  '.ps1': badge('PS', '#2C5591'),
  '.sql': `<path d="M8 5c2.8 0 4.5-.8 4.5-1.7S10.8 1.6 8 1.6 3.5 2.4 3.5 3.3 5.2 5 8 5zM3.5 3.3v9.4c0 .9 1.7 1.7 4.5 1.7s4.5-.8 4.5-1.7V3.3" fill="none" stroke="#D99A2B" stroke-width="1.2"/>`,
  '.go': badge('Go', '#00ADD8'),
  '.rs': badge('Rs', '#B7410E'),
  '.java': badge('J', '#E76F00'),
  '.razor': badge('@', '#7A4FC9'),
  '.cshtml': badge('@', '#7A4FC9'),
  '.http': badge('API', '#3E9D6D', '#FFFFFF', 5),
  '.txt': doc('#8C8F94', '<path d="M5.5 8h5M5.5 10.5h5" stroke="#8C8F94" stroke-width="1.1" stroke-linecap="round"/>'),
  '.lock': `<rect x="3.5" y="7" width="9" height="6.5" rx="1.5" fill="none" stroke="#8C8F94" stroke-width="1.2"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="#8C8F94" stroke-width="1.2"/>`,
  image: `<rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="#5FB865" stroke-width="1.2"/><path d="M2.5 11.5l3.5-3.5 3 3 2-2 2.5 2.5" fill="none" stroke="#5FB865" stroke-width="1.2"/><circle cx="10.5" cy="6" r="1" fill="#5FB865"/>`,
  git: `<path d="M8 1.6l6.4 6.4L8 14.4 1.6 8z" fill="#F05033"/><circle cx="8" cy="5.6" r="1" fill="#fff"/><circle cx="8" cy="10.4" r="1" fill="#fff"/><path d="M8 5.6v4.8" stroke="#fff" stroke-width="1"/>`,
  env: `<rect x="2" y="3" width="12" height="10" rx="2" fill="none" stroke="#C4A747" stroke-width="1.2"/><path d="M5 8h1.5M8 6v4M10 6.5h1.5M10 9.5h1.5" stroke="#C4A747" stroke-width="1.2" stroke-linecap="round"/>`,
  docker: badge('D', '#2396ED'),
  claude: `<path d="M8 .8l.9 4.3 3.4-2.8-2 3.9 4.4.4-4.1 1.6 3.4 2.9-4.3-1L10 14.6 8 10.7 6 14.6l.3-4.5-4.3 1 3.4-2.9L1.3 6.6l4.4-.4-2-3.9 3.4 2.8z" fill="#D97757"/>`,
  default: doc('#8C8F94'),
};

const FOLDER = (color, fill) => `<path d="M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5H3a1 1 0 0 0-1 1z" fill="${fill}" stroke="${color}" stroke-width="1.2" stroke-linejoin="round"/>`;
const FOLDER_OPEN = (color, fill) => `<path d="M2 12V4.5a1 1 0 0 1 1-1h3.5L8 5h4.5a1 1 0 0 1 1 1v1" fill="none" stroke="${color}" stroke-width="1.2" stroke-linejoin="round"/><path d="M2 12l1.6-4.3a1 1 0 0 1 .9-.7H14l-1.8 5.3a1 1 0 0 1-.9.7H3a1 1 0 0 1-1-1z" fill="${fill}" stroke="${color}" stroke-width="1.2" stroke-linejoin="round"/>`;

export function fileIconSvg(name, { dir = false, open = false, excluded = false, special = null } = {}) {
  if (dir) {
    const color = excluded ? '#B8763E' : special === 'source' ? '#5B8DEF' : special === 'test' ? '#5FB865' : '#9DA0A8';
    const fill = excluded ? 'rgba(184,118,62,.18)' : special === 'source' ? 'rgba(91,141,239,.2)' : special === 'test' ? 'rgba(95,184,101,.2)' : 'rgba(157,160,168,.16)';
    return open ? FOLDER_OPEN(color, fill) : FOLDER(color, fill);
  }
  const lower = name.toLowerCase();
  if (lower === '.gitignore' || lower === '.gitattributes' || lower === '.gitmodules') return FILE_ICONS.git;
  if (lower.startsWith('.env')) return FILE_ICONS.env;
  if (lower === 'dockerfile' || lower.endsWith('.dockerfile') || lower.startsWith('docker-compose')) return FILE_ICONS.docker;
  if (lower === 'claude.md' || lower === 'agents.md' || lower === 'skill.md') return FILE_ICONS.claude;
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : '';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg'].includes(ext)) return FILE_ICONS.image;
  if (ext === '.lock' || lower.endsWith('-lock.json') || lower === 'uv.lock' || lower === 'poetry.lock') return FILE_ICONS['.lock'];
  return FILE_ICONS[ext] || FILE_ICONS.default;
}

export function FileIcon({ name, dir, open, excluded, special, size = 16 }) {
  return html`<svg class="icon file-icon" width=${size} height=${size} viewBox="0 0 16 16" aria-hidden="true" dangerouslySetInnerHTML=${{ __html: fileIconSvg(name, { dir, open, excluded, special }) }}></svg>`;
}

export const KIND_ICON = {
  class: badge('C', '#8E5BD8'),
  interface: badge('I', '#5B8DEF'),
  struct: badge('S', '#A47CE6'),
  record: badge('R', '#A47CE6'),
  enum: badge('E', '#C69026'),
  delegate: badge('D', '#8E5BD8'),
  method: badge('m', '#C0526A'),
  function: badge('f', '#C0526A'),
  constructor: badge('c', '#C0526A'),
  property: badge('p', '#2E9E8F'),
  field: badge('f', '#3E8CB8'),
  event: badge('e', '#D46A9A'),
  namespace: badge('N', '#8C8F94'),
  variable: badge('v', '#3E8CB8'),
  constant: badge('K', '#3E8CB8'),
  enumMember: badge('e', '#C69026'),
  file: FILE_ICONS.default,
};

export function KindIcon({ kind, size = 16 }) {
  return html`<svg class="icon kind-icon" width=${size} height=${size} viewBox="0 0 16 16" aria-hidden="true" dangerouslySetInnerHTML=${{ __html: KIND_ICON[kind] || KIND_ICON.file }}></svg>`;
}
