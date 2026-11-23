// mend — one patch tool for every AI edit format.
// Node 22 standard library only. Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// Reads SPEC.md sentence by sentence: four formats (unified diff, SEARCH/REPLACE,
// V4A, JSON tool calls), three tiers of line matching, all-or-nothing atomicity,
// and a one-line-per-file report.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

class Exit2 extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}
class Fail extends Error {
  readonly kind: string;
  readonly path: string;
  constructor(kind: string, path: string) {
    super(kind + ' ' + path);
    this.kind = kind;
    this.path = path;
  }
}
const kindOf = (e: unknown): string => (e instanceof Fail ? e.kind : 'error');
const pathOf = (e: unknown): string => (e instanceof Fail ? e.path : '');

const isBlankLine = (l: string): boolean => l.trim() === '';
const patchLines = (text: string): string[] => {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
};
const cmpBytes = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

const readText = (p: string): string => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

// A path is safe when it is not empty, does not start with `/`, holds no
// `\`, and none of its `/`-separated segments is empty, `.` or `..`.
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

interface FileState {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}
const parseFile = (text: string): FileState => {
  const first = text.indexOf('\n');
  const br = first > 0 && text[first - 1] === '\r' ? '\r\n' : '\n';
  const ends = first !== -1 && text.endsWith(br);
  const body = ends ? text.slice(0, -br.length) : text;
  return { lines: body === '' ? [] : body.split(br), br, final: ends };
};
const renderFile = (f: FileState): string =>
  f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');

interface Edit {
  paths: string[];
  apply: (tree: Tree, strict: boolean) => void;
}

class Tree {
  readonly orig = new Map<string, string | null>();
  now = new Map<string, string | null>();
  moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readText(p);
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p) ?? null;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p) ?? null : this.original(p);
  }
  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

// ---- line matching (SPEC section 5) ----

// The leading spaces and tabs of a line.
const ws = (s: string): string => {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return s.slice(0, i);
};
const matchLine = (a: string, b: string, tier: number): boolean => {
  if (tier === 0) return a === b;
  if (tier === 1) return a.trimEnd() === b.trimEnd();
  return a.trim() === b.trim();
};
// Every 0-based position where O occurs in lines at this tier, left to right.
const occurrences = (lines: string[], o: string[], tier: number): number[] => {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!matchLine(o[j], lines[i + j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
};
// The tier (0, 1 or 2) where O first occurs, or -1. Strict limits to tier 0.
const findTier = (lines: string[], o: string[], strict: boolean): number => {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    if (occurrences(lines, o, t).length > 0) return t;
  }
  return -1;
};

interface Match {
  tier: number;
  pos: number;
  count: number;
}
// Locate O in lines. With `from`, the occurrence nearest to it (ties to the
// smaller position). Without it, pos is -1 when there is more than one.
function locate(lines: string[], o: string[], strict: boolean, from?: number): Match | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(lines, o, t);
    if (occ.length === 0) continue;
    if (from === undefined) {
      if (occ.length > 1) return { tier: t, pos: -1, count: occ.length };
      return { tier: t, pos: occ[0], count: 1 };
    }
    let best = occ[0];
    for (const p of occ) {
      if (Math.abs(p - from) < Math.abs(best - from)) best = p;
    }
    return { tier: t, pos: best, count: occ.length };
  }
  return null;
}

// One line of a patch body: a context line, a removed line, an added line,
// or a `\` line (kept only to decide the final line break).
interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'back';
  text: string;
  raw: string;
}
const bodyOld = (body: BodyItem[]): string[] =>
  body.filter((b) => b.kind === 'ctx' || b.kind === 'old').map((b) => b.text);
const bodyNew = (body: BodyItem[]): string[] =>
  body.filter((b) => b.kind === 'ctx' || b.kind === 'new').map((b) => b.text);

// Build the lines that replace O at position pos. A context line is written
// as the file's own line at that position. At tier 2, when the leading
// whitespace of O's first line differs from that of the file's first matched
// line, every other line that starts with O's first line's leading whitespace
// has that prefix replaced by the file's.
function replaceFromBody(lines: string[], pos: number, body: BodyItem[], tier: number): string[] {
  const out: string[] = [];
  let oIdx = 0;
  const first = body.find((b) => b.kind === 'ctx' || b.kind === 'old');
  const p = tier === 2 && first ? ws(first.text) : '';
  const f = tier === 2 ? ws(lines[pos] ?? '') : '';
  for (const item of body) {
    if (item.kind === 'ctx') {
      out.push(lines[pos + oIdx]);
      oIdx++;
    } else if (item.kind === 'old') {
      oIdx++;
    } else if (item.kind === 'new') {
      let ln = item.text;
      if (tier === 2 && p !== f && ln !== '' && ln.trim() !== '' && ln.startsWith(p)) {
        ln = f + ln.slice(p.length);
      }
      out.push(ln);
    }
  }
  return out;
}

// ---- unified diff (SPEC section 6) ----

interface Hunk {
  a: number;
  items: BodyItem[];
}
// The body without its `\` lines.
const hunkBody = (h: Hunk): BodyItem[] => h.items.filter((i) => i.kind !== 'back');
// Whether a `\` line follows the hunk's last context or `+` line.
const hunkBackAfterLast = (h: Hunk): boolean => {
  let v = false;
  for (let i = 0; i < h.items.length; i++) {
    if (h.items[i].kind === 'ctx' || h.items[i].kind === 'new') {
      v = i + 1 < h.items.length && h.items[i + 1].kind === 'back';
    }
  }
  return v;
};
// Whether a `\` line follows the section's last `+` line (creation files).
const creationBackAfterLast = (hunks: Hunk[]): boolean => {
  let v = false;
  for (const h of hunks) {
    for (let i = 0; i < h.items.length; i++) {
      if (h.items[i].kind === 'new') {
        v = i + 1 < h.items.length && h.items[i + 1].kind === 'back';
      }
    }
  }
  return v;
};

function applyUnifiedHunk(file: FileState, hunk: Hunk, strict: boolean, d: number, path: string): FileState {
  const body = hunkBody(hunk);
  const o = bodyOld(body);
  const n = bodyNew(body);
  if (o.length === 0) {
    const at = Math.max(0, Math.min(hunk.a + d, file.lines.length));
    const lines = [...file.lines.slice(0, at), ...n, ...file.lines.slice(at)];
    const final = at === file.lines.length ? !hunkBackAfterLast(hunk) : file.final;
    return { lines, br: file.br, final };
  }
  const from = hunk.a - 1 + d;
  const m = locate(file.lines, o, strict, from);
  if (!m) throw new Fail('no-match', path);
  const replacement = replaceFromBody(file.lines, m.pos, body, m.tier);
  const lines = [...file.lines.slice(0, m.pos), ...replacement, ...file.lines.slice(m.pos + o.length)];
  const matchedToEnd = m.pos + o.length === file.lines.length;
  const final = matchedToEnd ? !hunkBackAfterLast(hunk) : file.final;
  return { lines, br: file.br, final };
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function applyUnifiedSection(tree: Tree, section: UnifiedSection, strict: boolean): void {
  const oldPath = section.oldPath;
  const newPath = section.newPath;
  if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
  if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
  const isCreate = oldPath === null || section.isCreate;
  const isDelete = newPath === null || section.isDelete;
  if (isCreate) {
    if (newPath === null) return;
    if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const plus: string[] = [];
    for (const h of section.hunks) {
      for (const item of h.items) {
        if (item.kind === 'new') plus.push(item.text);
      }
    }
    const text = plus.length === 0 ? '' : plus.join('\n') + (creationBackAfterLast(section.hunks) ? '' : '\n');
    tree.set(newPath, text);
    return;
  }
  if (isDelete) {
    if (oldPath === null) return;
    if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
    tree.set(oldPath, null);
    return;
  }
  if (oldPath !== newPath) {
    // rename, with hunks applied to the old file
    const oldText = tree.get(oldPath!);
    if (oldText === null) throw new Fail('missing', oldPath!);
    if (tree.get(newPath!) !== null) throw new Fail('exists', newPath!);
    let file = parseFile(oldText);
    let d = 0;
    for (const hunk of section.hunks) {
      file = applyUnifiedHunk(file, hunk, strict, d, oldPath!);
      const body = hunkBody(hunk);
      d += bodyNew(body).length - bodyOld(body).length;
    }
    tree.set(newPath!, renderFile(file));
    tree.set(oldPath!, null);
    tree.moves.push([oldPath!, newPath!]);
    return;
  }
  // change in place
  const text = tree.get(oldPath!);
  if (text === null) throw new Fail('missing', oldPath!);
  let file = parseFile(text);
  let d = 0;
  for (const hunk of section.hunks) {
    file = applyUnifiedHunk(file, hunk, strict, d, oldPath!);
    const body = hunkBody(hunk);
    d += bodyNew(body).length - bodyOld(body).length;
  }
  tree.set(oldPath!, renderFile(file));
}

// The path named by a `--- ` or `+++ ` line: the text after the four
// characters, up to the first tab, with surrounding spaces removed.
// `/dev/null` means no file; a leading `a/` or `b/` is removed.
function parseUnifiedHeaderPath(line: string): string | null {
  const raw = line.slice(4);
  const cut = raw.split('\t')[0];
  const p = cut.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
function parseHunkHeader(line: string, i: number): number {
  const m = HUNK_HEADER.exec(line);
  if (!m) throw new Exit2(`error: parse ${i + 1}`);
  return parseInt(m[1], 10);
}

// Collect a hunk body starting at lines[startI]. Returns the hunk and the
// index of the first line after the body. The body ends at the first other
// line, at a `diff --git ` line, at a `--- ` line followed by a `+++ ` line,
// or at the end of the patch; empty lines at the end of a body are not part
// of it.
function collectHunkBody(lines: string[], startI: number, a: number): { hunk: Hunk; nextI: number } {
  const items: BodyItem[] = [];
  let i = startI;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && lines[i + 1] !== undefined && lines[i + 1].startsWith('+++ ')) break;
    if (l.startsWith(' ')) items.push({ kind: 'ctx', text: l.slice(1), raw: l });
    else if (l.startsWith('-')) items.push({ kind: 'old', text: l.slice(1), raw: l });
    else if (l.startsWith('+')) items.push({ kind: 'new', text: l.slice(1), raw: l });
    else if (l.startsWith('\\')) items.push({ kind: 'back', text: l, raw: l });
    else if (l === '') items.push({ kind: 'ctx', text: '', raw: l });
    else break;
    i++;
  }
  while (items.length > 0 && items[items.length - 1].raw === '') items.pop();
  return { hunk: { a, items }, nextI: i };
}

interface SectionBuilder {
  pairOld?: string | null;
  pairNew?: string | null;
  renameOld?: string;
  renameNew?: string;
  diffOld?: string;
  diffNew?: string;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}
const finalizeSection = (b: SectionBuilder): UnifiedSection => {
  const oldPath =
    b.pairOld !== undefined ? b.pairOld : b.renameOld !== undefined ? b.renameOld : b.diffOld !== undefined ? b.diffOld : null;
  const newPath =
    b.pairNew !== undefined ? b.pairNew : b.renameNew !== undefined ? b.renameNew : b.diffNew !== undefined ? b.diffNew : null;
  return { oldPath, newPath, isCreate: b.isCreate, isDelete: b.isDelete, hunks: b.hunks };
};

function parseUnified(lines: string[], _strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: SectionBuilder | null = null;
  let state: 'outside' | 'header' | 'after' = 'outside';
  const startSection = (): SectionBuilder => {
    if (cur) sections.push(finalizeSection(cur));
    const b: SectionBuilder = { isCreate: false, isDelete: false, hunks: [] };
    cur = b;
    return b;
  };
  const diffGit = (line: string, i: number): [string, string] => {
    const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
    if (!m) throw new Exit2(`error: parse ${i + 1}`);
    return [m[1], m[2]];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (state === 'outside') {
      if (line.startsWith('diff --git ')) {
        const [o, n] = diffGit(line, i);
        const b = startSection();
        b.diffOld = o;
        b.diffNew = n;
        state = 'header';
        i++;
      } else if (line.startsWith('--- ')) {
        const next = lines[i + 1];
        if (next !== undefined && next.startsWith('+++ ')) {
          const b = startSection();
          b.pairOld = parseUnifiedHeaderPath(line);
          b.pairNew = parseUnifiedHeaderPath(next);
          state = 'header';
          i += 2;
        } else {
          i++;
        }
      } else {
        i++;
      }
    } else if (state === 'header') {
      if (line.startsWith('diff --git ')) {
        const [o, n] = diffGit(line, i);
        const b = startSection();
        b.diffOld = o;
        b.diffNew = n;
        state = 'header';
        i++;
      } else if (line.startsWith('--- ')) {
        const next = lines[i + 1];
        if (next !== undefined && next.startsWith('+++ ')) {
          if (cur) {
            cur.pairOld = parseUnifiedHeaderPath(line);
            cur.pairNew = parseUnifiedHeaderPath(next);
          }
          i += 2;
        } else {
          throw new Exit2(`error: parse ${i + 2}`);
        }
      } else if (line.startsWith('+++ ')) {
        if (cur) cur.pairNew = parseUnifiedHeaderPath(line);
        i++;
      } else if (line.startsWith('@@')) {
        const a = parseHunkHeader(line, i);
        const { hunk, nextI } = collectHunkBody(lines, i + 1, a);
        cur!.hunks.push(hunk);
        state = 'after';
        i = nextI;
      } else if (line.startsWith('rename from ')) {
        if (cur) cur.renameOld = line.slice('rename from '.length).trim();
        i++;
      } else if (line.startsWith('rename to ')) {
        if (cur) cur.renameNew = line.slice('rename to '.length).trim();
        i++;
      } else if (line === 'new file mode' || line.startsWith('new file mode ')) {
        if (cur) cur.isCreate = true;
        i++;
      } else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        if (cur) cur.isDelete = true;
        i++;
      } else {
        i++;
      }
    } else {
      // after: after the first hunk of a section
      if (line.startsWith('diff --git ')) {
        const [o, n] = diffGit(line, i);
        const b = startSection();
        b.diffOld = o;
        b.diffNew = n;
        state = 'header';
        i++;
      } else if (line.startsWith('--- ')) {
        const next = lines[i + 1];
        if (next !== undefined && next.startsWith('+++ ')) {
          const b = startSection();
          b.pairOld = parseUnifiedHeaderPath(line);
          b.pairNew = parseUnifiedHeaderPath(next);
          state = 'header';
          i += 2;
        } else {
          i++;
        }
      } else if (line.startsWith('@@')) {
        const a = parseHunkHeader(line, i);
        const { hunk, nextI } = collectHunkBody(lines, i + 1, a);
        cur!.hunks.push(hunk);
        i = nextI;
      } else {
        i++;
      }
    }
  }
  if (cur) sections.push(finalizeSection(cur));
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => ({
    paths: [s.oldPath, s.newPath].filter((p): p is string => p !== null),
    apply: (tree, strict) => applyUnifiedSection(tree, s, strict),
  }));
}

// ---- SEARCH/REPLACE (SPEC section 7) ----

function parseSearchReplace(lines: string[]): Edit[] {
  const blocks: Array<{ path: string; oldLines: string[]; newLines: string[] }> = [];
  let i = 0;
  let prevEnd = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i;
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const l = lines[j];
        if (l.trim() === '') continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (blocks.length > 0) path = blocks[blocks.length - 1].path;
        else throw new Exit2(`error: parse ${searchLine + 1}`);
      }
      let eq = -1;
      for (let k = i + 1; k < lines.length; k++) {
        if (lines[k].trimEnd() === '=======') {
          eq = k;
          break;
        }
        if (lines[k].trimEnd() === '<<<<<<< SEARCH' || lines[k].trimEnd() === '>>>>>>> REPLACE') {
          throw new Exit2(`error: parse ${searchLine + 1}`);
        }
      }
      if (eq === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
      let rep = -1;
      for (let m = eq + 1; m < lines.length; m++) {
        if (lines[m].trimEnd() === '>>>>>>> REPLACE') {
          rep = m;
          break;
        }
        if (lines[m].trimEnd() === '<<<<<<< SEARCH') {
          throw new Exit2(`error: parse ${searchLine + 1}`);
        }
      }
      if (rep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
      blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
      prevEnd = rep + 1;
      i = rep + 1;
    } else {
      i++;
    }
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => makeSearchReplaceEdit(b.path, b.oldLines, b.newLines));
}

function makeSearchReplaceEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return {
    paths: [path],
    apply: (tree, strict) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const file = parseFile(before);
      const body: BodyItem[] = [
        ...oldLines.map((t): BodyItem => ({ kind: 'old', text: t, raw: t })),
        ...newLines.map((t): BodyItem => ({ kind: 'new', text: t, raw: t })),
      ];
      const m = locate(file.lines, oldLines, strict);
      if (!m) throw new Fail('no-match', path);
      if (m.count > 1) throw new Fail('ambiguous', path);
      const replacement = replaceFromBody(file.lines, m.pos, body, m.tier);
      const lines = [...file.lines.slice(0, m.pos), ...replacement, ...file.lines.slice(m.pos + oldLines.length)];
      tree.set(path, renderFile({ lines, br: file.br, final: file.final }));
    },
  };
}

// ---- V4A (SPEC section 8) ----

interface V4aChunk {
  anchor: string | null;
  body: BodyItem[];
  eof: boolean;
}
interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  chunks: V4aChunk[];
  addLines: string[];
}

function parseV4a(lines: string[]): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlankLine(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) throw new Exit2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlankLine(lines[i])) {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface RawSection {
    kind: 'add' | 'delete' | 'update';
    path: string;
    start: number;
    end: number;
  }
  const raw: RawSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    }
    if (kind) {
      if (raw.length > 0) raw[raw.length - 1].end = i;
      raw.push({ kind, path, start: i, end: last });
      i++;
    } else if (isBlankLine(line)) {
      i++;
    } else if (raw.length === 0) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  if (raw.length === 0) throw new Exit2('error: parse 1');
  const sections: V4aSection[] = raw.map((r) => {
    let end = r.end;
    while (end > r.start + 1 && isBlankLine(lines[end - 1])) end--;
    const bodyLines = lines.slice(r.start + 1, end);
    return parseV4aSection(r.kind, r.path, bodyLines, r.start + 1);
  });
  return sections.map((s) => makeV4aEdit(s));
}

function parseV4aSection(kind: 'add' | 'delete' | 'update', path: string, bodyLines: string[], bodyStart: number): V4aSection {
  if (kind === 'add') {
    const addLines: string[] = [];
    for (let j = 0; j < bodyLines.length; j++) {
      const l = bodyLines[j];
      if (l.startsWith('+')) addLines.push(l.slice(1));
      else if (l === '') addLines.push('');
      else throw new Exit2(`error: parse ${bodyStart + j + 1}`);
    }
    return { kind, path, moveTo: null, chunks: [], addLines };
  }
  if (kind === 'delete') {
    for (let j = 0; j < bodyLines.length; j++) {
      if (!isBlankLine(bodyLines[j])) throw new Exit2(`error: parse ${bodyStart + j + 1}`);
    }
    return { kind, path, moveTo: null, chunks: [], addLines: [] };
  }
  let moveTo: string | null = null;
  let idx = 0;
  if (bodyLines.length > 0 && bodyLines[0].startsWith('*** Move to: ')) {
    moveTo = bodyLines[0].slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  for (let j = idx; j < bodyLines.length; j++) {
    const l = bodyLines[j];
    if (l.startsWith('@@')) {
      if (cur) chunks.push(cur);
      cur = { anchor: l.slice(2).trim(), body: [], eof: false };
    } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (!cur) cur = { anchor: null, body: [], eof: false };
      if (l.startsWith(' ')) cur.body.push({ kind: 'ctx', text: l.slice(1), raw: l });
      else if (l.startsWith('-')) cur.body.push({ kind: 'old', text: l.slice(1), raw: l });
      else if (l.startsWith('+')) cur.body.push({ kind: 'new', text: l.slice(1), raw: l });
      else cur.body.push({ kind: 'ctx', text: '', raw: l });
    } else if (l.trim() === '*** End of File') {
      if (!cur) throw new Exit2(`error: parse ${bodyStart + j + 1}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
    } else {
      throw new Exit2(`error: parse ${bodyStart + j + 1}`);
    }
  }
  if (cur) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${bodyStart}`);
  return { kind, path, moveTo, chunks, addLines: [] };
}

function applyV4aChunk(
  file: FileState,
  chunk: V4aChunk,
  strict: boolean,
  cursor: number,
  path: string,
): { file: FileState; cursor: number } {
  let start = cursor;
  if (chunk.anchor !== null && chunk.anchor !== '') {
    // The first line at or after the cursor equal to the anchor at the first
    // tier where one is; both sides a single line.
    let found = -1;
    const max = strict ? 0 : 2;
    for (let t = 0; t <= max && found === -1; t++) {
      for (let i = start; i < file.lines.length; i++) {
        if (matchLine(chunk.anchor, file.lines[i], t)) {
          found = i;
          break;
        }
      }
    }
    if (found === -1) throw new Fail('no-match', path);
    start = found + 1;
  }
  const o = bodyOld(chunk.body);
  if (o.length === 0) {
    const n = bodyNew(chunk.body);
    const at = chunk.eof ? file.lines.length : start;
    const lines = [...file.lines.slice(0, at), ...n, ...file.lines.slice(at)];
    return { file: { lines, br: file.br, final: file.final }, cursor: at + n.length };
  }
  if (chunk.eof) {
    // An end-of-file chunk takes only an occurrence that ends at the file's
    // last line: its old lines are the file's last lines.
    if (o.length > file.lines.length) throw new Fail('no-match', path);
    const tail = file.lines.slice(file.lines.length - o.length);
    const tier = findTier(tail, o, strict);
    if (tier === -1) throw new Fail('no-match', path);
    const pos = file.lines.length - o.length;
    const replacement = replaceFromBody(file.lines, pos, chunk.body, tier);
    const lines = [...file.lines.slice(0, pos), ...replacement, ...file.lines.slice(pos + o.length)];
    return { file: { lines, br: file.br, final: file.final }, cursor: pos + replacement.length };
  }
  // The chunk takes the first occurrence of O at or after the cursor, at the
  // first tier with one.
  const sub = file.lines.slice(start);
  const tier = findTier(sub, o, strict);
  if (tier === -1) throw new Fail('no-match', path);
  const occ = occurrences(sub, o, tier);
  const pos = start + occ[0];
  const replacement = replaceFromBody(file.lines, pos, chunk.body, tier);
  const lines = [...file.lines.slice(0, pos), ...replacement, ...file.lines.slice(pos + o.length)];
  return { file: { lines, br: file.br, final: file.final }, cursor: pos + replacement.length };
}

function makeV4aEdit(s: V4aSection): Edit {
  return {
    paths: s.moveTo ? [s.path, s.moveTo] : [s.path],
    apply: (tree, strict) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (s.kind === 'add') {
        if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
        tree.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
        return;
      }
      if (s.kind === 'delete') {
        if (tree.get(s.path) === null) throw new Fail('missing', s.path);
        tree.set(s.path, null);
        return;
      }
      if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
      const before = tree.get(s.path);
      if (before === null) throw new Fail('missing', s.path);
      if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
      let file = parseFile(before);
      let cursor = 0;
      for (const chunk of s.chunks) {
        const res = applyV4aChunk(file, chunk, strict, cursor, s.path);
        file = res.file;
        cursor = res.cursor;
      }
      const rendered = renderFile(file);
      if (s.moveTo !== null) {
        tree.set(s.moveTo, rendered);
        tree.set(s.path, null);
        tree.moves.push([s.path, s.moveTo]);
      } else {
        tree.set(s.path, rendered);
      }
    },
  };
}

// ---- JSON tool calls (SPEC section 9) ----
// The patch is either one JSON array of edit objects, or JSON Lines: one edit
// object a line, blank lines ignored. In array form any fault is
// `error: parse <the line where the array starts>`; in JSON Lines form a line
// that does not hold one valid edit object is `error: parse <that line>`.

// One JSON edit object, or null when it is not one.
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
    return {
      paths: [p],
      apply: (tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.set(p, text);
      },
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return {
      paths: [p],
      apply: (tree) => {
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
        tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
      },
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return {
      paths: [p],
      apply: (tree) => {
        const before = exists(tree);
        const nl = before.indexOf('\n');
        const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
        const lines = before === '' ? [] : before.split(br);
        const final = before !== '' && before.endsWith(br);
        if (final) lines.pop();
        if (line < 0 || line > lines.length) throw new Fail('no-match', p);
        lines.splice(line, 0, ...add);
        tree.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
      },
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlankLine(l));
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
    if (isBlankLine(l)) return;
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

// ---- format detection and dispatch (SPEC section 1) ----

type Format = 'unified' | 'search-replace' | 'v4a' | 'json';
const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function detectFormat(lines: string[]): Format | null {
  const first = lines.findIndex((l) => !isBlankLine(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  )
    return 'unified';
  return null;
}

function parsePatch(lines: string[], format: Format, strict: boolean): Edit[] {
  if (format === 'unified') return parseUnified(lines, strict);
  if (format === 'search-replace') return parseSearchReplace(lines);
  if (format === 'v4a') return parseV4a(lines);
  throw new Exit2('error: parse 1');
}

function run(argv: string[]): number {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else {
        process.stdout.write('error: usage\n');
        return 2;
      }
    } else pos.push(a);
  }
  if (pos.length > 1) {
    process.stdout.write('error: usage\n');
    return 2;
  }
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) {
      process.stdout.write('error: no-patch\n');
      return 2;
    }
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : (format as Format);
  if (kind === null) {
    process.stdout.write('error: format\n');
    return 2;
  }
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : parsePatch(lines, kind, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) {
      process.stdout.write(e.line + '\n');
      return 2;
    }
    throw e;
  }
  const tree = new Tree();
  const failures: string[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.now);
    const movesSnapshot = [...tree.moves];
    try {
      edit.apply(tree, strict);
    } catch (e) {
      if (e instanceof Fail) {
        tree.now.clear();
        for (const [k, v] of snapshot) tree.now.set(k, v);
        tree.moves = movesSnapshot;
        failures.push(`error: ${kindOf(e)} ${pathOf(e)}`);
      } else throw e;
    }
  }
  if (failures.length > 0) {
    process.stdout.write(failures.join('\n') + '\n');
    process.stdout.write(`failed: ${failures.length} of ${edits.length} edits\n`);
    return 1;
  }
  // One line per changed file, sorted by path bytes. A deletion of a file
  // that existed and a creation at a path that did not exist fold into one
  // `R <old> -> <new>` line when the edit renamed the file.
  const rows: Array<{ key: string; text: string }> = [];
  const consumedD = new Set<string>();
  const consumedA = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      consumedD.add(oldP);
      consumedA.add(newP);
    }
  }
  for (const [p, v] of tree.now) {
    const was = tree.original(p);
    if (was === v) continue;
    if (was === null && consumedA.has(p)) continue;
    if (v === null && consumedD.has(p)) continue;
    const kind = was === null ? 'A' : v === null ? 'D' : 'M';
    rows.push({ key: p, text: `${kind} ${p}` });
  }
  rows.sort((a, b) => cmpBytes(a.key, b.key));
  const out = [...rows.map((r) => r.text), `ok: ${rows.length} file${rows.length === 1 ? '' : 's'}`].join('\n') + '\n';
  if (!check) {
    const changed: Array<[string, string | null]> = [];
    for (const [p, v] of tree.now) {
      const was = tree.original(p);
      if (was === v) continue;
      changed.push([p, v]);
    }
    changed.sort((a, b) => cmpBytes(a[0], b[0]));
    for (const [p, v] of changed) {
      if (v === null) rmSync(p, { force: true });
    }
    for (const [p, v] of changed) {
      if (v !== null) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, v);
      }
    }
  }
  process.stdout.write(out);
  return 0;
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  process.exitCode = run(process.argv.slice(2));
}
