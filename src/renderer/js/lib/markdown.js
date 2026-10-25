// Markdown rendering for chat and previews: marked + DOMPurify, code blocks colorized by Monaco.
import { marked } from '../../../../node_modules/marked/lib/marked.esm.js';
import DOMPurify from '../../../../node_modules/dompurify/dist/purify.es.mjs';

marked.setOptions({ gfm: true, breaks: false });

const LANG_ALIAS = { cs: 'csharp', 'c#': 'csharp', csharp: 'csharp', py: 'python', python: 'python', js: 'javascript', javascript: 'javascript', ts: 'typescript', typescript: 'typescript', tsx: 'typescript', jsx: 'javascript', sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', console: 'shell', json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml', html: 'html', css: 'css', sql: 'sql', md: 'markdown', markdown: 'markdown', toml: 'ini', ini: 'ini', ps1: 'powershell', powershell: 'powershell', go: 'go', rust: 'rust', java: 'java', diff: 'plaintext' };

export function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(String(text || '')), { USE_PROFILES: { html: true } });
}

/** Colorize <pre><code> blocks and add copy / insert buttons. */
export function enhanceCodeBlocks(root, { onInsert } = {}) {
  const monaco = window.monaco;
  for (const code of root.querySelectorAll('pre > code')) {
    if (code.dataset.kiln) continue;
    code.dataset.kiln = '1';
    const raw = code.textContent;
    const m = /language-([\w#+-]+)/.exec(code.className || '');
    const lang = m ? LANG_ALIAS[m[1].toLowerCase()] || m[1].toLowerCase() : null;
    if (monaco && lang) {
      monaco.editor
        .colorize(raw, lang, { tabSize: 4 })
        .then((htmlText) => {
          code.innerHTML = htmlText;
        })
        .catch(() => {});
    }
    const pre = code.parentElement;
    const bar = document.createElement('div');
    bar.className = 'code-actions';
    const mk = (label, fn) => {
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = label;
      b.onclick = (e) => {
        e.stopPropagation();
        fn();
      };
      bar.appendChild(b);
    };
    mk('Copy', () => navigator.clipboard.writeText(raw));
    if (onInsert) mk('Insert', () => onInsert(raw));
    pre.appendChild(bar);
  }
}
