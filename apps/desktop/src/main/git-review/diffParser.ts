/**
 * Unified diff parser for git-review.
 *
 * The parser accepts git output produced by `--patch-with-raw -z`, where a
 * NUL-separated raw header may appear before the textual patch.
 */

import type { DiffChangeKind, DiffLine, FileDiff, Hunk } from './types.js';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

interface RawMeta {
  oldMode: string | null;
  newMode: string | null;
  oldOid: string | null;
  newOid: string | null;
  status: DiffChangeKind;
  path: string | null;
  oldPath: string | null;
  rawHeader: string;
}

function changeKindFromRaw(code: string | undefined): DiffChangeKind {
  const c = code?.[0];
  switch (c) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'typechange';
    default:
      return 'unknown';
  }
}

function parseRawMetas(rawPart: string): RawMeta[] {
  const chunks = rawPart.split('\0').filter(Boolean);
  const metas: RawMeta[] = [];
  let i = 0;
  while (i < chunks.length) {
    const first = chunks[i];
    i += 1;
    if (!first?.startsWith(':')) continue;
    const fields = first.split(' ');
    if (fields.length < 5) continue;
    const oldMode = fields[0]?.slice(1) || null;
    const newMode = fields[1] || null;
    const oldOid = fields[2] || null;
    const newOid = fields[3] || null;
    const statusCode = fields[4] || '';
    const firstPath = chunks[i] ?? null;
    i += 1;
    const secondPath = statusCode.startsWith('R') || statusCode.startsWith('C')
      ? chunks[i] ?? null
      : null;
    if (secondPath !== null) i += 1;
    const rawChunks = [first, firstPath, secondPath].filter((chunk): chunk is string => Boolean(chunk));
    metas.push({
      oldMode,
      newMode,
      oldOid,
      newOid,
      status: changeKindFromRaw(statusCode),
      path: secondPath ?? firstPath,
      oldPath: secondPath ? firstPath : null,
      rawHeader: `${rawChunks.join('\0')}\0\0`,
    });
  }
  return metas;
}

function parseRawMeta(rawPart: string): RawMeta | null {
  return parseRawMetas(rawPart)[0] ?? null;
}

function stripGitPathPrefix(p: string): string {
  return p.replace(/^[ab]\//, '').replace(/\t$/, '');
}

function unquoteGitPathToken(token: string): string {
  if (!token.startsWith('"')) return token;
  const end = token.endsWith('"') ? token.length - 1 : token.length;
  let out = '';
  let bytes: number[] = [];
  const flushBytes = () => {
    if (bytes.length === 0) return;
    out += Buffer.from(bytes).toString('utf8');
    bytes = [];
  };
  for (let i = 1; i < end; i += 1) {
    const char = token[i];
    if (char !== '\\') {
      flushBytes();
      out += char;
      continue;
    }
    const next = token[i + 1];
    if (next === undefined) break;
    i += 1;
    switch (next) {
      case 'a':
        flushBytes();
        out += '\x07';
        break;
      case 'b':
        flushBytes();
        out += '\b';
        break;
      case 'f':
        flushBytes();
        out += '\f';
        break;
      case 'n':
        flushBytes();
        out += '\n';
        break;
      case 'r':
        flushBytes();
        out += '\r';
        break;
      case 't':
        flushBytes();
        out += '\t';
        break;
      case 'v':
        flushBytes();
        out += '\v';
        break;
      case '"':
      case '\\':
        flushBytes();
        out += next;
        break;
      default:
        if (/[0-7]/.test(next)) {
          let octal = next;
          for (let j = 0; j < 2 && /[0-7]/.test(token[i + 1] ?? ''); j += 1) {
            i += 1;
            octal += token[i];
          }
          bytes.push(Number.parseInt(octal, 8));
        } else {
          flushBytes();
          out += next;
        }
        break;
    }
  }
  flushBytes();
  return out;
}

function readQuotedGitPathToken(body: string, start: number): { token: string; end: number } | null {
  if (body[start] !== '"') return null;
  for (let i = start + 1; i < body.length; i += 1) {
    if (body[i] === '\\') {
      i += 1;
      continue;
    }
    if (body[i] === '"') {
      return { token: body.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}

function parseDiffGit(line: string): { oldPath: string | null; path: string | null } {
  const body = line.slice('diff --git '.length);
  if (body.startsWith('"')) {
    const oldToken = readQuotedGitPathToken(body, 0);
    if (!oldToken) return { oldPath: null, path: null };
    const nextStart = body.slice(oldToken.end).search(/\S/);
    if (nextStart < 0) return { oldPath: null, path: null };
    const newStart = oldToken.end + nextStart;
    const newQuoted = readQuotedGitPathToken(body, newStart);
    const newToken = newQuoted?.token ?? body.slice(newStart);
    return {
      oldPath: stripGitPathPrefix(unquoteGitPathToken(oldToken.token)),
      path: stripGitPathPrefix(unquoteGitPathToken(newToken)),
    };
  }
  const quotedMarker = ' "b/';
  const quotedIdx = body.indexOf(quotedMarker);
  const marker = ' b/';
  const idx = quotedIdx >= 0 ? quotedIdx : body.indexOf(marker);
  if (idx < 0) return { oldPath: null, path: null };
  const newToken = body.slice(idx + 1);
  return {
    oldPath: stripGitPathPrefix(unquoteGitPathToken(body.slice(0, idx))),
    path: stripGitPathPrefix(unquoteGitPathToken(newToken)),
  };
}

function parseIndexLine(line: string): { oldOid: string | null; newOid: string | null; mode: string | null } {
  const m = /^index\s+([0-9a-f]+)\.\.([0-9a-f]+)(?:\s+(\d+))?/.exec(line);
  return { oldOid: m?.[1] ?? null, newOid: m?.[2] ?? null, mode: m?.[3] ?? null };
}

function parseRenamePath(line: string, prefix: string): string {
  return unquoteGitPathToken(line.slice(prefix.length));
}

function ensurePreviousNoNewline(hunk: Hunk | null): void {
  const prev = hunk?.lines[hunk.lines.length - 1];
  if (prev) prev.noTrailingNewLine = true;
}

/**
 * Stable per-source file identity. Deliberately content-independent so the
 * renderer's expand state survives refreshes while the agent keeps editing.
 */
function makeFileId(source: FileDiff['source'], path: string, idPrefix?: string): string {
  return idPrefix ? `${source}:${idPrefix}:${path}` : `${source}:${path}`;
}

export function parseGitDiff(raw: string, opts: {
  source: FileDiff['source'];
  idPrefix?: string;
  pathHint?: string | null;
  oldPathHint?: string | null;
  kind?: FileDiff['kind'];
  size?: number | null;
  isSubmodule?: boolean;
  isUntracked?: boolean;
  error?: string | null;
}): FileDiff {
  const patchStart = raw.indexOf('diff --git ');
  const rawPart = patchStart >= 0 ? raw.slice(0, patchStart) : '';
  const patch = patchStart >= 0 ? raw.slice(patchStart).replace(/\0/g, '') : raw.replace(/\0/g, '');
  const rawMeta = parseRawMeta(rawPart);
  const lines = patch.split('\n');
  const diffGit = lines[0]?.startsWith('diff --git ') ? parseDiffGit(lines[0]) : { oldPath: null, path: null };
  const hasAuthoritativePath = opts.pathHint != null || rawMeta?.path != null;
  const hasAuthoritativeOldPath = opts.oldPathHint != null || rawMeta?.oldPath != null;

  let path = opts.pathHint ?? rawMeta?.path ?? diffGit.path ?? '';
  let oldPath = opts.oldPathHint ?? rawMeta?.oldPath ?? null;
  let status = rawMeta?.status ?? 'unknown';
  let oldMode = rawMeta?.oldMode ?? null;
  let newMode = rawMeta?.newMode ?? null;
  let oldOid = rawMeta?.oldOid ?? null;
  let newOid = rawMeta?.newOid ?? null;
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let additions = 0;
  let deletions = 0;
  const headerLines: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      headerLines.push(line);
      continue;
    }
    if (line.startsWith('new file mode ')) {
      status = 'added';
      newMode = line.slice('new file mode '.length).trim();
      headerLines.push(line);
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      status = 'deleted';
      oldMode = line.slice('deleted file mode '.length).trim();
      headerLines.push(line);
      continue;
    }
    if (line.startsWith('rename from ')) {
      status = 'renamed';
      if (!hasAuthoritativeOldPath) oldPath = parseRenamePath(line, 'rename from ');
      headerLines.push(line);
      continue;
    }
    if (line.startsWith('rename to ')) {
      status = 'renamed';
      if (!hasAuthoritativePath) path = parseRenamePath(line, 'rename to ');
      headerLines.push(line);
      continue;
    }
    if (line.startsWith('index ')) {
      const idx = parseIndexLine(line);
      oldOid = idx.oldOid ?? oldOid;
      newOid = idx.newOid ?? newOid;
      oldMode = idx.mode ?? oldMode;
      newMode = idx.mode ?? newMode;
      headerLines.push(line);
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('similarity index ')) {
      headerLines.push(line);
      continue;
    }
    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[3]);
      current = {
        index: hunks.length,
        header: line,
        oldStart: oldLine,
        oldLines: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: newLine,
        newLines: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        section: hunkMatch[5]?.trim() ?? '',
        lines: [],
        selectableLines: [],
        raw: `${line}\n`,
      };
      hunks.push(current);
      continue;
    }
    if (line.startsWith('\\ No newline')) {
      ensurePreviousNoNewline(current);
      if (current) current.raw += `${line}\n`;
      continue;
    }
    if (!current) continue;
    if (line === '' && i === lines.length - 1) continue;

    const prefix = line[0] ?? ' ';
    const content = line.length > 0 ? line.slice(1) : '';
    let diffLine: DiffLine | null = null;
    if (prefix === '+') {
      diffLine = {
        index: current.lines.length,
        type: 'add',
        content,
        raw: line,
        oldLineNumber: null,
        newLineNumber: newLine,
        originalLineNumber: newLine,
        selectable: true,
        noTrailingNewLine: false,
      };
      newLine += 1;
      additions += 1;
    } else if (prefix === '-') {
      diffLine = {
        index: current.lines.length,
        type: 'delete',
        content,
        raw: line,
        oldLineNumber: oldLine,
        newLineNumber: null,
        originalLineNumber: oldLine,
        selectable: true,
        noTrailingNewLine: false,
      };
      oldLine += 1;
      deletions += 1;
    } else {
      diffLine = {
        index: current.lines.length,
        type: 'context',
        content: line.startsWith(' ') ? line.slice(1) : line,
        raw: line.startsWith(' ') ? line : ` ${line}`,
        oldLineNumber: oldLine,
        newLineNumber: newLine,
        originalLineNumber: oldLine,
        selectable: false,
        noTrailingNewLine: false,
      };
      oldLine += 1;
      newLine += 1;
    }
    current.lines.push(diffLine);
    if (diffLine.selectable) current.selectableLines.push(diffLine.index);
    current.raw += `${line}\n`;
  }

  const finalPath = path || opts.pathHint || '';
  return {
    id: makeFileId(opts.source, finalPath, opts.idPrefix),
    source: opts.source,
    path: finalPath,
    oldPath,
    // untracked 文件经 `--no-index /dev/null` 读出的 patch 会带 new file mode,
    // 按 patch 解析是 'added';这里以 status 层事实为准,保证 renderer 端
    // untracked 判定(如 discard 确认文案)拿到一致的 'untracked'。
    status: opts.isUntracked ? 'untracked' : status,
    kind: opts.kind ?? 'text',
    size: opts.size ?? null,
    additions,
    deletions,
    isBinary: opts.kind === 'binary',
    isSubmodule: opts.isSubmodule ?? false,
    isTooLarge: opts.kind === 'too-large',
    mode: { old: oldMode, new: newMode },
    index: { oldOid, newOid },
    rawHeader: headerLines.join('\n'),
    rawPatch: patch,
    hunks,
    error: opts.error ?? null,
  };
}

export function parseGitDiffs(raw: string, opts: {
  source: FileDiff['source'];
  idPrefix?: string;
  kind?: FileDiff['kind'];
  size?: number | null;
  isSubmodule?: boolean;
  isUntracked?: boolean;
  error?: string | null;
}): FileDiff[] {
  const patchStart = raw.indexOf('diff --git ');
  if (patchStart < 0) return [];
  const rawPart = raw.slice(0, patchStart);
  const rawMetas = parseRawMetas(rawPart);
  const rawMetaByPath = new Map<string, RawMeta>();
  for (const meta of rawMetas) {
    if (meta.path) rawMetaByPath.set(meta.path, meta);
    if (meta.oldPath && !rawMetaByPath.has(meta.oldPath)) rawMetaByPath.set(meta.oldPath, meta);
  }
  const patches = raw
    .slice(patchStart)
    .replace(/\0/g, '')
    .split(/(?=^diff --git )/m)
    .filter(Boolean);
  const rawMetasMatchPatches = rawMetas.length === patches.length;
  return patches.map((patch, index) => {
    const firstLine = patch.split('\n', 1)[0] ?? '';
    const patchPath = firstLine.startsWith('diff --git ') ? parseDiffGit(firstLine).path : null;
    const rawMeta = rawMetasMatchPatches ? rawMetas[index] ?? null : patchPath ? rawMetaByPath.get(patchPath) : null;
    return parseGitDiff(`${rawMeta?.rawHeader ?? ''}${patch}`, opts);
  });
}
