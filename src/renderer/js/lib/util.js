// Small shared helpers.
export const cls = (...parts) => parts.filter(Boolean).join(' ');

export function debounce(fn, ms) {
  let t;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function throttle(fn, ms) {
  let last = 0;
  let t = null;
  let pending = null;
  return (...a) => {
    const now = Date.now();
    pending = a;
    if (now - last >= ms) {
      last = now;
      fn(...a);
    } else if (!t) {
      t = setTimeout(() => {
        t = null;
        last = Date.now();
        fn(...pending);
      }, ms - (now - last));
    }
  };
}

export const sep = '/';
export const basename = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || p || '';
export const dirname = (p) => {
  const parts = (p || '').split(/[\\/]/);
  parts.pop();
  return parts.join('/') || '/';
};
export const join = (...parts) => parts.filter(Boolean).join('/').replace(/\/+/g, '/');
export const relative = (root, p) => (p && root && p.startsWith(root + '/') ? p.slice(root.length + 1) : p);
export const extname = (p) => {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i).toLowerCase() : '';
};

export function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleDateString();
}

export function formatDuration(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

export function formatDate(ts) {
  return ts ? new Date(ts).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

/** Fuzzy match with scoring: prefers consecutive characters, word starts and file-name hits. */
export function fuzzy(query, text) {
  if (!query) return { score: 1, positions: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const nameStart = t.lastIndexOf('/') + 1;
  const direct = t.indexOf(q, nameStart);
  if (direct >= 0) {
    const positions = [];
    for (let i = 0; i < q.length; i++) positions.push(direct + i);
    return { score: 1000 - (direct - nameStart) * 2 - (t.length - nameStart) + (direct === nameStart ? 200 : 0), positions };
  }
  let ti = 0;
  let score = 0;
  let prev = -2;
  const positions = [];
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === c) {
        found = ti++;
        break;
      }
      ti++;
    }
    if (found < 0) return null;
    positions.push(found);
    const boundary = found === 0 || '/_-. '.includes(t[found - 1]) || (text[found] >= 'A' && text[found] <= 'Z');
    score += found === prev + 1 ? 15 : boundary ? 10 : 1;
    if (found >= nameStart) score += 4;
    prev = found;
  }
  return { score: score - t.length * 0.2, positions };
}

export function highlight(text, positions) {
  if (!positions || !positions.length) return [text];
  const set = new Set(positions);
  const out = [];
  let buf = '';
  let mark = false;
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m !== mark) {
      if (buf) out.push(mark ? { mark: buf } : buf);
      buf = '';
      mark = m;
    }
    buf += text[i];
  }
  if (buf) out.push(mark ? { mark: buf } : buf);
  return out;
}

export function uid(prefix = 'id') {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const LANG_BY_EXT = {
  '.cs': 'csharp', '.csx': 'csharp', '.cshtml': 'razor', '.razor': 'razor', '.fs': 'fsharp', '.fsx': 'fsharp', '.vb': 'vb',
  '.py': 'python', '.pyi': 'python', '.pyw': 'python', '.ipynb': 'json',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.json': 'json', '.jsonc': 'json', '.csproj': 'xml', '.fsproj': 'xml', '.vbproj': 'xml', '.props': 'xml', '.targets': 'xml', '.xml': 'xml', '.config': 'xml', '.resx': 'xml', '.slnx': 'xml', '.xaml': 'xml', '.nuspec': 'xml', '.svg': 'xml',
  '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'scss', '.less': 'less', '.md': 'markdown', '.markdown': 'markdown',
  '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'ini', '.ini': 'ini', '.cfg': 'ini', '.env': 'ini', '.editorconfig': 'ini', '.sln': 'ini',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.ps1': 'powershell', '.psm1': 'powershell', '.bat': 'bat', '.cmd': 'bat',
  '.sql': 'sql', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.swift': 'swift', '.c': 'c', '.h': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hh': 'cpp', '.hxx': 'cpp', '.rb': 'ruby', '.php': 'php', '.r': 'r', '.lua': 'lua', '.dart': 'dart', '.graphql': 'graphql', '.proto': 'protobuf', '.http': 'http', '.dockerfile': 'dockerfile',
};

export function languageOf(file) {
  const b = basename(file).toLowerCase();
  if (b === 'dockerfile' || b.endsWith('.dockerfile')) return 'dockerfile';
  if (b === 'makefile') return 'shell';
  if (b.startsWith('.env')) return 'ini';
  if (b === '.gitignore' || b === '.dockerignore') return 'plaintext';
  return LANG_BY_EXT[extname(file)] || 'plaintext';
}

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg']);
