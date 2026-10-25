'use strict';
// C# refactorings from Roslyn, through csharp-ls code actions: which titles are refactorings and what
// Rider calls them, LSP edits applied to text, and the name Roslyn generates replaced by the user's.

// Roslyn titles -> Rider refactoring kinds. Actions ending in "..." / "…" open Visual Studio dialogs
// csharp-ls cannot show, so they are not offered.
const RULES = [
  [/^Extract method\b/i, { kind: 'extractMethod', needs: 'name', defaultName: 'NewMethod' }],
  [/^Extract local function\b/i, { kind: 'extractMethod', needs: 'name', defaultName: 'NewMethod', title: 'Extract Local Function…' }],
  [/^Introduce local for all occurrences/i, { kind: 'introduceVariable', needs: 'name', defaultName: 'value', all: true }],
  [/^Introduce local\b/i, { kind: 'introduceVariable', needs: 'name', defaultName: 'value' }],
  [/^Introduce constant\b/i, { kind: 'introduceConstant', needs: 'name', defaultName: 'Value', all: undefined }],
  [/^Introduce (?:readonly )?field\b/i, { kind: 'introduceField', needs: 'name', defaultName: '_value' }],
  [/^Introduce parameter\b|^into extracted method to invoke at call sites$|^into new overload$|^and update call sites directly$/i, { kind: 'introduceParameter', needs: 'name', defaultName: 'value' }],
  [/^Inline temporary variable\b|^Inline '/i, { kind: 'inline' }],
  [/^Move type to\b|^Move to namespace\b/i, { kind: 'move' }],
  [/^Pull '.*' up\b|^Pull .* up to\b/i, { kind: 'pullMembersUp' }],
  [/^(Encapsulate field|Convert |Use |Generate (?:constructor|Equals|GetHashCode)|Add 'DebuggerDisplay'|Wrap |Unwrap |Indent |Align |Invert |Split |Merge |Make |Introduce 'using'|Reverse )/i, { kind: 'other' }],
];

function classifyRoslyn(title) {
  const t = String(title || '').trim();
  if (!t || /(\.\.\.|…)$/.test(t)) return null;
  for (const [re, info] of RULES) if (re.test(t)) return { ...info, title: info.title || t };
  return null;
}

function offsetOf(text, line, col) {
  let off = 0;
  for (let l = 1; l < line; l++) {
    const i = text.indexOf('\n', off);
    if (i < 0) return text.length;
    off = i + 1;
  }
  return Math.min(text.length, off + Math.max(0, col - 1));
}

/** Apply LSP-style edits ({ line, col, endLine, endCol, text }, 1-based) in the document's line endings. */
function applyLspEdits(text, edits) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const list = edits
    .map((e, i) => ({ start: offsetOf(text, e.line, e.col), end: offsetOf(text, e.endLine, e.endCol), text: e.text.replace(/\r\n/g, '\n').replace(/\n/g, eol), i }))
    .sort((a, b) => b.start - a.start || b.end - a.end || b.i - a.i);
  let out = text;
  for (const e of list) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

const KEYWORDS = new Set('abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while var dynamic async await nameof when where yield get set init value record global partial'.split(' '));

/**
 * Roslyn names what it creates itself (NewMethod, v, ...): the one identifier that is in `after` but
 * nowhere in `before`. Replace it with `name`; returns { text, start, end } (the first occurrence).
 */
function renameGenerated(before, after, name) {
  const words = (t) => new Set(t.match(/[\p{L}_][\p{L}\p{N}_]*/gu) || []);
  const had = words(before);
  const fresh = [...words(after)].filter((w) => !had.has(w) && !KEYWORDS.has(w));
  if (fresh.length !== 1) return { text: after, start: -1, end: -1, generated: null };
  const generated = fresh[0];
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${generated}(?![\\p{L}\\p{N}_])`, 'gu');
  const text = name ? after.replace(re, name) : after;
  const used = name || generated;
  const m = new RegExp(`(?<![\\p{L}\\p{N}_])${used}(?![\\p{L}\\p{N}_])`, 'u').exec(text);
  return { text, start: m ? m.index : -1, end: m ? m.index + used.length : -1, generated };
}

module.exports = { classifyRoslyn, applyLspEdits, renameGenerated };
