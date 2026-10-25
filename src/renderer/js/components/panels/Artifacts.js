// Artifacts knowledge base: import Claude artifacts (paste a link) or documents, ask questions about
// them, and check the project's code against the requirements they contain.
import { html, useEffect, useState, useRef } from '../../lib/preact.js';
import { useStore, store } from '../../lib/store.js';
import { Icon } from '../../lib/icons.js';
import { invoke, on } from '../../lib/ipc.js';
import { cls, timeAgo } from '../../lib/util.js';
import { renderMarkdown } from '../../lib/markdown.js';
import { prompt, toast, errorToast, confirm } from '../../lib/ui.js';
import { ToolWindow, Spinner } from '../ui.js';
import * as ed from '../../services/editor.js';

export function ArtifactsPanel({ onHide }) {
  const hasProject = useStore((s) => !!s.project);
  const [docs, setDocs] = useState(null);
  const [tab, setTab] = useState('library');
  const [busy, setBusy] = useState(null);
  const [progress, setProgress] = useState('');
  const [selected, setSelected] = useState(null);
  const [preview, setPreview] = useState(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState(null);
  const [check, setCheck] = useState(null);
  const answerRef = useRef('');
  const load = async () => setDocs(await invoke('kb:list').catch(() => []));
  useEffect(() => {
    load();
    return on('kb:event', (e) => {
      if (e.type === 'progress') setProgress(e.phase === 'imported' ? `Imported ${e.title}` : e.phase === 'read' ? `Reading ${e.url || ''}` : e.phase === 'list' ? 'Listing your artifacts…' : '');
      if (e.type === 'answer' && e.text) {
        answerRef.current += e.text;
        setAnswer((a) => ({ ...(a || {}), streaming: true, text: answerRef.current }));
      }
      if (e.type === 'check' && e.name) setProgress(`Checking code: ${e.name} ${e.input && (e.input.file_path || e.input.pattern || '')}`);
    });
  }, []);
  useEffect(() => {
    if (!selected) return setPreview(null);
    invoke('kb:read', selected).then(setPreview).catch(() => setPreview(null));
  }, [selected]);
  const wrap = async (label, fn) => {
    setBusy(label);
    setProgress('');
    try {
      await fn();
    } catch (err) {
      errorToast(label, err);
    }
    setBusy(null);
    setProgress('');
    load();
  };
  const addLink = () =>
    wrap('Import artifact', async () => {
      const url = await prompt({ title: 'Add Claude Artifact', label: 'Paste the artifact link (https://claude.ai/…):', placeholder: 'https://claude.ai/artifact/…', ok: 'Import', testid: 'artifact-url' });
      if (!url) return;
      const doc = await invoke('kb:importUrl', typeof url === 'string' ? url : url.value);
      toast({ kind: 'success', title: `Stored "${doc.title}"`, message: `${doc.sections} sections · ${doc.requirements} requirements` });
    });
  const importAll = () =>
    wrap('Import from claude.ai', async () => {
      const r = await invoke('kb:importAll');
      toast({ kind: 'success', title: `Imported ${r.imported.length} artifact${r.imported.length === 1 ? '' : 's'}` });
    });
  const importFiles = () =>
    wrap('Import documents', async () => {
      const files = await invoke('kb:selectFiles');
      if (files.length) await invoke('kb:importFiles', files);
    });
  const importDocs = () => wrap('Import project docs', () => invoke('kb:importProjectDocs'));
  const ask = async () => {
    if (!question.trim()) return;
    answerRef.current = '';
    setAnswer({ streaming: true, text: '' });
    try {
      const r = await invoke('kb:ask', question);
      setAnswer({ text: r.answer, sources: r.sources });
    } catch (err) {
      setAnswer({ text: `Could not answer: ${err.message}`, sources: [] });
    }
  };
  const runCheck = () =>
    wrap('Check code', async () => {
      setCheck({ running: true });
      const r = await invoke('kb:check', { docIds: selected ? [selected] : [] });
      setCheck(r);
    });
  const root = useStore((s) => s.project && s.project.root);
  return html`<${ToolWindow} side="right" title="Artifacts" testid="artifacts-panel" onHide=${onHide}
      tabs=${html`${['library', 'ask', 'check'].map((t) => html`<button class=${cls('tw-tab', tab === t && 'active')} onClick=${() => setTab(t)}>${t === 'library' ? 'Library' : t === 'ask' ? 'Ask' : 'Check code'}</button>`)}`}
      actions=${html`<button class="icon-btn sm" title="Show knowledge graph" onClick=${() => import('../../lib/commands.js').then((c) => c.run('view.artifactGraph'))}><${Icon} name="graph" /></button>`}>
    ${busy ? html`<div class="claude-status"><${Spinner} size=${12} />${busy}… ${progress}</div>` : null}
    ${tab === 'library'
      ? html`<div class="col grow">
          <div class="tw-toolbar" style="gap:6px;height:auto;padding:6px 8px;flex-wrap:wrap">
            <button class="btn small primary" data-testid="artifact-add-link" disabled=${!!busy} onClick=${addLink}><${Icon} name="link" size=${13} />Paste link</button>
            <button class="btn small" disabled=${!!busy} onClick=${importAll} title="Read every artifact in your claude.ai gallery through Claude Code">From claude.ai</button>
            <button class="btn small" disabled=${!!busy} onClick=${importFiles}>Files…</button>
            ${hasProject ? html`<button class="btn small" disabled=${!!busy} onClick=${importDocs} title="CLAUDE.md, README, docs/*.md">Project docs</button>` : null}
          </div>
          <div class="list">
            ${!docs ? html`<div class="empty"><${Spinner} /></div>` : null}
            ${docs && !docs.length ? html`<div class="empty">The library is empty. Paste a link to a Claude artifact, or import documents. Everything is stored on this Mac and is available in every project.</div>` : null}
            ${(docs || []).map((d) => html`<div class=${cls('kb-doc', selected === d.id && 'selected')} data-testid="kb-doc" onClick=${() => setSelected(selected === d.id ? null : d.id)}>
                <div class="row"><${Icon} name=${d.source === 'claude' ? 'claude' : 'book'} size=${14} style=${d.source === 'claude' ? 'color:#D97757' : ''} /><b class="ellipsis grow">${d.title}</b><button class="icon-btn sm" title="Remove" onClick=${async (e) => { e.stopPropagation(); if (await confirm({ title: 'Remove artifact', message: `Remove "${d.title}" from the library?`, ok: 'Remove', danger: true })) { await invoke('kb:remove', d.id); load(); } }}><${Icon} name="trash" size=${13} /></button></div>
                <div class="muted" style="font-size:12px">${d.sections} sections · ${d.requirements} requirements · ${timeAgo(d.importedAt)}${d.url ? html` · <a onClick=${(e) => { e.stopPropagation(); invoke('app:openExternal', d.url); }}>open</a>` : ''}</div>
              </div>`)}
            ${preview ? html`<div class="kb-answer" style="border-top:1px solid var(--border-inner)">${preview.sections.slice(0, 40).map((s) => html`<div style="margin-bottom:10px"><div style="font-weight:600">${s.heading}</div><div class="muted" style="white-space:pre-wrap;font-size:12px">${s.text.slice(0, 600)}${s.text.length > 600 ? '…' : ''}</div>${s.requirements.length ? html`<div style="font-size:12px;margin-top:4px">${s.requirements.slice(0, 5).map((r) => html`<div>• ${r}</div>`)}</div>` : null}</div>`)}</div>` : null}
          </div>
        </div>`
      : tab === 'ask'
        ? html`<div class="col grow">
            <div class="list">${answer ? html`<div class="kb-answer"><div class="msg-assistant" dangerouslySetInnerHTML=${{ __html: renderMarkdown(answer.text || '') }}></div>${answer.streaming ? html`<${Spinner} />` : null}
                ${answer.sources && answer.sources.length ? html`<div class="section-title" style="padding-left:0">Sources</div>${answer.sources.map((s) => html`<div style="font-size:12px;margin-bottom:6px"><b>[${s.ref}]</b> ${s.doc} — ${s.section}<div class="muted">${s.preview}</div></div>`)}` : null}
              </div>` : html`<div class="empty">Ask anything about your stored artifacts. Answers are grounded in their text and cite the sections they come from.</div>`}</div>
            <div class="composer"><textarea data-testid="kb-question" placeholder="Ask about your artifacts…" value=${question} onInput=${(e) => setQuestion(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } }}></textarea><div class="bar"><span class="spacer"></span><button class="btn small primary" onClick=${ask} disabled=${!question.trim()}>Ask</button></div></div>
          </div>`
        : html`<div class="col grow">
            <div class="tw-toolbar" style="gap:6px"><button class="btn small primary" disabled=${!!busy || !hasProject} onClick=${runCheck}><${Icon} name="shield" size=${13} />Check ${selected ? 'against selected artifact' : 'against all artifacts'}</button></div>
            <div class="list">
              ${!check ? html`<div class="empty">Claude reads the project (read-only) and checks each requirement found in your artifacts (must / should / shall statements), with file:line evidence.</div>` : null}
              ${check && check.summary ? html`<div class="kb-answer">${check.summary}</div>` : null}
              ${check && check.findings ? check.findings.map((f) => html`<div class="finding"><div class=${cls('st', f.status)}>${f.status}</div><div>${f.requirement}</div>
                  ${(f.evidence || []).map((e) => html`<div style="font-size:12px"><a onClick=${() => e.abs && ed.openFile(e.abs, { line: e.line || 1 })}>${e.file}${e.line ? `:${e.line}` : ''}</a> <span class="muted">${e.note}</span></div>`)}
                  ${f.suggestion ? html`<div class="muted" style="font-size:12px;margin-top:4px">${f.suggestion}</div>` : null}</div>`) : null}
            </div>
          </div>`}
  <//>`;
}
