// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* ------------------------------------------------------------------ */
/* Section 3: files and lines                                          */
/* ------------------------------------------------------------------ */

function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/* ------------------------------------------------------------------ */
/* Section 5: matching lines at three tiers                            */
/* ------------------------------------------------------------------ */

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** 0-based positions where oLines occur in fileLines at the given tier. */
function occurrences(fileLines: string[], oLines: string[], tier: number): number[] {
  const res: number[] = [];
  const n = oLines.length;
  if (n === 0 || n > fileLines.length) return res;
  const oN = oLines.map((l) => normLine(l, tier));
  for (let i = 0; i + n <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (normLine(fileLines[i + j]!, tier) !== oN[j]) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** First tier (0, 1, 2) at which oLines occur at least once, or -1. With strict, only tier 0. */
function findTier(fileLines: string[], oLines: string[], strict: boolean): number {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    if (occurrences(fileLines, oLines, t).length > 0) return t;
  }
  return -1;
}

/**
 * Build the replacement lines for a match at position `pos`.
 * `body` holds the context and new lines of N in order; context lines are written as the
 * file's own matched line, other new lines are re-indented at tier 2.
 */
function buildReplacement(
  fileLines: string[],
  body: { type: 'context' | 'new'; text: string; oIndex: number }[],
  oLines: string[],
  tier: number,
  pos: number,
): string[] {
  const out: string[] = [];
  if (tier === 2) {
    const F = leadingWS(fileLines[pos] ?? '');
    const P = leadingWS(oLines[0] ?? '');
    for (const item of body) {
      if (item.type === 'context') {
        out.push(fileLines[pos + item.oIndex]!);
      } else {
        const t = item.text;
        out.push(t !== '' && t.trim() !== '' && t.startsWith(P) ? F + t.slice(P.length) : t);
      }
    }
  } else {
    for (const item of body) {
      out.push(item.type === 'context' ? fileLines[pos + item.oIndex]! : item.text);
    }
  }
  return out;
}

/** Re-indent plain new lines (no context) at tier 2, as for SEARCH/REPLACE. */
function reindentNew(newLines: string[], oldLines: string[], fileLines: string[], pos: number, tier: number): string[] {
  if (tier !== 2) return [...newLines];
  const F = leadingWS(fileLines[pos] ?? '');
  const P = leadingWS(oldLines[0] ?? '');
  return newLines.map((t) => (t !== '' && t.trim() !== '' && t.startsWith(P) ? F + t.slice(P.length) : t));
}

/* ------------------------------------------------------------------ */
/* Section 4: format detection                                         */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Section 9: JSON edits (as the starter had them)                     */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs                                            */
/* ------------------------------------------------------------------ */

interface BodyItem {
  type: 'context' | 'old' | 'new' | 'backslash';
  text: string;
  oIndex: number;
  nIndex: number;
}

interface Hunk {
  a: number;
  body: BodyItem[];
}

interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

/** Path after `--- ` / `+++ `: text after four chars, up to first tab, spaces removed, a/ or b/ stripped. */
function unifiedPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseBody(raw: string[]): BodyItem[] {
  const items: BodyItem[] = [];
  let oIdx = 0;
  let nIdx = 0;
  for (const l of raw) {
    if (l.startsWith(' ')) items.push({ type: 'context', text: l.slice(1), oIndex: oIdx++, nIndex: nIdx++ });
    else if (l.startsWith('-')) items.push({ type: 'old', text: l.slice(1), oIndex: oIdx++, nIndex: -1 });
    else if (l.startsWith('+')) items.push({ type: 'new', text: l.slice(1), oIndex: -1, nIndex: nIdx++ });
    else if (l.startsWith('\\')) items.push({ type: 'backslash', text: l.slice(1), oIndex: -1, nIndex: -1 });
    else if (l === '') items.push({ type: 'context', text: '', oIndex: oIdx++, nIndex: nIdx++ });
  }
  return items;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let hunkA = 0;
  let hunkRaw: string[] | null = null;
  let state: 'outside' | 'header' | 'body' | 'between' = 'outside';

  const flushHunk = () => {
    if (hunkRaw !== null && sec) {
      const raw = hunkRaw;
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      sec.hunks.push({ a: hunkA, body: parseBody(raw) });
      hunkRaw = null;
    }
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!;
    const num = idx + 1;
    if (state === 'body') {
      if (line.startsWith('diff --git ')) {
        flushHunk();
        state = 'between';
      } else if (line.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')) {
        flushHunk();
        state = 'between';
      } else if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '') {
        hunkRaw!.push(line);
        continue;
      } else {
        flushHunk();
        state = 'between';
      }
    }
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      const parts = rest.split(' ');
      if (parts.length !== 2 || !parts[0]!.startsWith('a/') || !parts[1]!.startsWith('b/')) throw new Exit2(`error: parse ${num}`);
      sec = {
        pairOld: undefined,
        pairNew: undefined,
        renameFrom: undefined,
        renameTo: undefined,
        diffOld: parts[0]!.slice(2),
        diffNew: parts[1]!.slice(2),
        isNew: false,
        isDeleted: false,
        hunks: [],
      };
      sections.push(sec);
      state = 'header';
      continue;
    }
    if (line.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')) {
      const op = unifiedPath(line);
      const np = unifiedPath(lines[idx + 1]!);
      if (state === 'header' && sec) {
        sec.pairOld = op;
        sec.pairNew = np;
      } else {
        sec = {
          pairOld: op,
          pairNew: np,
          renameFrom: undefined,
          renameTo: undefined,
          diffOld: undefined,
          diffNew: undefined,
          isNew: false,
          isDeleted: false,
          hunks: [],
        };
        sections.push(sec);
        state = 'header';
      }
      idx++;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (state === 'header') throw new Exit2(`error: parse ${num + 1}`);
      continue;
    }
    if (line.startsWith('@@')) {
      if (state === 'outside' || !sec) throw new Exit2(`error: parse ${num}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${num}`);
      hunkA = parseInt(m[1]!, 10);
      hunkRaw = [];
      state = 'body';
      continue;
    }
    if (state === 'header' && sec) {
      if (line.startsWith('rename from ')) {
        sec.renameFrom = line.slice('rename from '.length);
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renameTo = line.slice('rename to '.length);
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.isNew = true;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.isDeleted = true;
        continue;
      }
      continue;
    }
  }
  if (state === 'body') flushHunk();
  return sections;
}

/** Apply a section's hunks to a file's text; returns the new lines, break and final-break flag. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): { lines: string[]; br: string; final: boolean } {
  let { lines, br, final } = splitFile(before);
  let d = 0;
  for (const hunk of hunks) {
    const oItems = hunk.body.filter((b) => b.type === 'context' || b.type === 'old');
    const nItems = hunk.body.filter((b) => b.type === 'context' || b.type === 'new');
    const O = oItems.map((b) => b.text);
    let lastCN = -1;
    for (let k = 0; k < hunk.body.length; k++) {
      if (hunk.body[k]!.type === 'context' || hunk.body[k]!.type === 'new') lastCN = k;
    }
    const hasBackslash = lastCN >= 0 && hunk.body[lastCN + 1]?.type === 'backslash';
    if (O.length === 0) {
      const oldLen = lines.length;
      const insIdx = Math.min(hunk.a + d, oldLen);
      const N = nItems.map((b) => b.text);
      lines.splice(insIdx, 0, ...N);
      if (insIdx === oldLen) final = !hasBackslash;
      d += N.length;
      continue;
    }
    const tier = findTier(lines, O, strict);
    if (tier < 0) throw new Fail('no-match', path);
    const occs = occurrences(lines, O, tier);
    const target = hunk.a - 1 + d;
    let best = occs[0]!;
    for (const pos of occs) {
      const bd = Math.abs(pos - target);
      const bb = Math.abs(best - target);
      if (bd < bb || (bd === bb && pos < best)) best = pos;
    }
    const runsToEnd = best + O.length === lines.length;
    const repl = buildReplacement(
      lines,
      nItems.map((b) => ({ type: b.type as 'context' | 'new', text: b.text, oIndex: b.oIndex })),
      O,
      tier,
      best,
    );
    lines.splice(best, O.length, ...repl);
    if (runsToEnd) final = !hasBackslash;
    d += repl.length - O.length;
  }
  return { lines, br, final };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((sec) => {
    const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld !== undefined ? sec.diffOld : null;
    const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew !== undefined ? sec.diffNew : null;
    return (tree: Tree) => {
      const isCreation = oldP === null || sec.isNew;
      const isDeletion = newP === null || sec.isDeleted;
      if (isCreation) {
        const p = newP as string;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        for (const h of sec.hunks) for (const b of h.body) if (b.type === 'new') plus.push(b.text);
        let final = true;
        let lastPlus: { hunk: Hunk; idx: number } | null = null;
        for (const h of sec.hunks) {
          for (let k = 0; k < h.body.length; k++) if (h.body[k]!.type === 'new') lastPlus = { hunk: h, idx: k };
        }
        if (lastPlus && lastPlus.hunk.body[lastPlus.idx + 1]?.type === 'backslash') final = false;
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
        return;
      }
      if (isDeletion) {
        const p = oldP as string;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const src = oldP as string;
      const dst = newP as string;
      const isMove = src !== dst;
      if (!safe(src)) throw new Fail('unsafe', src);
      if (!safe(dst)) throw new Fail('unsafe', dst);
      const before = tree.get(src);
      if (before === null) throw new Fail('missing', src);
      if (isMove && tree.get(dst) !== null) throw new Fail('exists', dst);
      const { lines: outLines, br, final } = applyHunks(before, sec.hunks, strict, src);
      const content = joinFile(outLines, br, final);
      if (isMove) {
        tree.now.set(src, null);
        tree.now.set(dst, content);
        tree.moves.push([src, dst]);
      } else {
        tree.now.set(src, content);
      }
    };
  });
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks                                    */
/* ------------------------------------------------------------------ */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const searchIdxs: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') searchIdxs.push(i);
  }
  let prevEnd = 0;
  let prevPath: string | null = null;
  for (const sIdx of searchIdxs) {
    let eqIdx = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eqIdx = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eqIdx < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let repIdx = -1;
    for (let j = eqIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        repIdx = j;
        break;
      }
    }
    if (repIdx < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    const oldLines = lines.slice(sIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, repIdx);
    let path: string | null = null;
    for (let j = sIdx - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${sIdx + 1}`);
      path = prevPath;
    }
    prevPath = path;
    prevEnd = repIdx + 1;
    const p = path;
    const oL = [...oldLines];
    const nL = [...newLines];
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oL.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, nL.length === 0 ? '' : nL.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const { lines: fl, br, final } = splitFile(before);
      const tier = findTier(fl, oL, strict);
      if (tier < 0) throw new Fail('no-match', p);
      const occs = occurrences(fl, oL, tier);
      if (occs.length > 1) throw new Fail('ambiguous', p);
      const pos = occs[0]!;
      const repl = reindentNew(nL, oL, fl, pos, tier);
      fl.splice(pos, oL.length, ...repl);
      tree.now.set(p, joinFile(fl, br, final));
    });
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches                                              */
/* ------------------------------------------------------------------ */

interface V4AChunk {
  anchor: string | null;
  body: { type: 'context' | 'old' | 'new'; text: string; oIndex: number }[];
  eof: boolean;
}

function isV4ASectionStart(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const raw: { text: string; num: number }[] = [];
      i++;
      while (i < last && !isV4ASectionStart(lines[i]!)) {
        raw.push({ text: lines[i]!, num: i + 1 });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.num}`);
      }
      const p = path;
      const fl = [...fileLines];
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fl.length === 0 ? '' : fl.join('\n') + '\n');
      });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last && !isV4ASectionStart(lines[i]!)) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updNum = i + 1;
      const raw: { text: string; num: number }[] = [];
      i++;
      while (i < last && !isV4ASectionStart(lines[i]!)) {
        raw.push({ text: lines[i]!, num: i + 1 });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      let j = 0;
      let moveTo: string | null = null;
      if (j < raw.length && raw[j]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[j]!.text.slice('*** Move to: '.length).trim();
        j++;
      }
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      let firstChunk = true;
      const pushCur = () => {
        if (cur) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (j < raw.length) {
        const { text, num } = raw[j]!;
        if (!text.startsWith(' ') && text.trim() === '*** End of File') {
          if (!cur) throw new Exit2(`error: parse ${num}`);
          cur.eof = true;
          pushCur();
          firstChunk = false;
          j++;
          continue;
        }
        if (text.startsWith('@@')) {
          pushCur();
          cur = { anchor: text.slice(2).trim() === '' ? null : text.slice(2).trim(), body: [], eof: false };
          firstChunk = false;
          j++;
          continue;
        }
        if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
          if (!cur) {
            if (!firstChunk) {
              // A blank line between chunks (after an *** End of File) is a separator, not a body line.
              if (blank(text)) {
                j++;
                continue;
              }
              throw new Exit2(`error: parse ${num}`);
            }
            cur = { anchor: null, body: [], eof: false };
            firstChunk = false;
          }
          if (text === '') cur.body.push({ type: 'context', text: '', oIndex: -1 });
          else if (text.startsWith(' ')) cur.body.push({ type: 'context', text: text.slice(1), oIndex: -1 });
          else if (text.startsWith('-')) cur.body.push({ type: 'old', text: text.slice(1), oIndex: -1 });
          else cur.body.push({ type: 'new', text: text.slice(1), oIndex: -1 });
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${num}`);
      }
      pushCur();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updNum}`);
      for (const ch of chunks) {
        let oIdx = 0;
        for (const b of ch.body) {
          if (b.type === 'context' || b.type === 'old') b.oIndex = oIdx++;
        }
      }
      const p = path;
      const mt = moveTo;
      const chs = chunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
        const { lines: fl, br, final } = splitFile(before);
        let cursor = 0;
        for (const ch of chs) {
          if (ch.anchor !== null) {
            const a = ch.anchor;
            let found = -1;
            const maxT = strict ? 0 : 2;
            for (let t = 0; t <= maxT && found < 0; t++) {
              for (let k = cursor; k < fl.length; k++) {
                if (normLine(fl[k]!, t) === normLine(a, t)) {
                  found = k;
                  break;
                }
              }
            }
            if (found < 0) throw new Fail('no-match', p);
            cursor = found + 1;
          }
          const oItems = ch.body.filter((b) => b.type === 'context' || b.type === 'old');
          const nItems = ch.body.filter((b) => b.type === 'context' || b.type === 'new');
          const O = oItems.map((b) => b.text);
          if (O.length === 0) {
            const insIdx = ch.eof ? fl.length : cursor;
            const N = nItems.map((b) => b.text);
            fl.splice(insIdx, 0, ...N);
            cursor = insIdx + N.length;
            continue;
          }
          const tier = (() => {
            const maxT = strict ? 0 : 2;
            for (let t = 0; t <= maxT; t++) {
              const occs = occurrences(fl, O, t).filter((pos) => pos >= cursor && (!ch.eof || pos + O.length === fl.length));
              if (occs.length > 0) return t;
            }
            return -1;
          })();
          if (tier < 0) throw new Fail('no-match', p);
          const occs = occurrences(fl, O, tier).filter((pos) => pos >= cursor && (!ch.eof || pos + O.length === fl.length));
          const pos = occs[0]!;
          const repl = buildReplacement(
            fl,
            nItems.map((b) => ({ type: b.type as 'context' | 'new', text: b.text, oIndex: b.oIndex })),
            O,
            tier,
            pos,
          );
          fl.splice(pos, O.length, ...repl);
          cursor = pos + repl.length;
        }
        const content = joinFile(fl, br, final);
        if (mt !== null) {
          tree.now.set(p, null);
          tree.now.set(mt, content);
          tree.moves.push([p, mt]);
        } else {
          tree.now.set(p, content);
        }
      });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 1-2: invocation, output, exit codes                         */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rPaths = new Set<string>();
  const rRows: { key: string; line: string }[] = [];
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rRows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      rPaths.add(oldP);
      rPaths.add(newP);
    }
  }
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (rPaths.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  const all = [...rows, ...rRows].sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = all.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
