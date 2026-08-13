import fs from 'node:fs';
import path from 'node:path';

import type { CindyGhostManualIndexItem, CindyGhostManualResult } from 'cindy-tools';

import {
  GHOST_MANUAL_ENTRY_FILE,
  GHOST_MANUAL_MD_MAX_BYTES,
  type GhostManualItem,
  type InstalledGhost,
} from '../../shared/ghost.js';
import {
  isRealPathWithinRoot,
  readBoundedFileNoFollowWithStat,
} from '../utils/readBoundedFile.js';
import {
  decodeGhostManualMarkdown,
  ghostManualLogicalPathForEntry,
  parseGhostManualLogicalPath,
} from './ghostManualValidation.js';

const MANUAL_CANDIDATE_MAX_ITEMS = 32;
const MANUAL_CANDIDATE_MAX_BYTES = 4096;
const MANUAL_SCAN_MAX_ENTRIES = 512;

function rootIndex(ghost: InstalledGhost): CindyGhostManualIndexItem[] {
  return (ghost.manifest.manual?.items ?? []).map(({ name, description }) => ({
    name,
    description,
  }));
}

function unavailable(message: string): CindyGhostManualResult {
  return {
    ok: false,
    manual: [],
    content: '',
    errorCode: 'MANUAL_UNAVAILABLE',
    message,
  };
}

function pathNotFound(
  message: string,
  manual: CindyGhostManualIndexItem[],
): CindyGhostManualResult {
  return {
    ok: false,
    manual,
    content: '',
    errorCode: 'MANUAL_PATH_NOT_FOUND',
    message,
  };
}

async function readManualFile(
  absolutePath: string,
  realUnitRoot: string,
): Promise<{ ok: true; content: string } | { ok: false }> {
  try {
    const read = await readBoundedFileNoFollowWithStat(
      absolutePath,
      GHOST_MANUAL_MD_MAX_BYTES,
      {
        containWithin: realUnitRoot,
      },
    );
    if (read === null || read.bytes.byteLength !== read.expectedSize) return { ok: false };
    const decoded = decodeGhostManualMarkdown(read.bytes);
    return decoded.ok ? decoded : { ok: false };
  } catch {
    return { ok: false };
  }
}

async function collectUnitCandidates(
  item: GhostManualItem,
  unitRoot: string,
  realUnitRoot: string,
): Promise<
  { status: 'ok' | 'missing'; manual: CindyGhostManualIndexItem[] } | { status: 'unavailable' }
> {
  const candidates: CindyGhostManualIndexItem[] = [];
  let scannedEntries = 0;
  let truncated = false;
  let sawMissing = false;

  const serializedBytes = (items: CindyGhostManualIndexItem[]): number =>
    Buffer.byteLength(JSON.stringify(items), 'utf8');

  const addCandidate = (candidate: CindyGhostManualIndexItem): boolean => {
    if (
      candidates.length >= MANUAL_CANDIDATE_MAX_ITEMS ||
      serializedBytes([...candidates, candidate]) > MANUAL_CANDIDATE_MAX_BYTES
    ) {
      truncated = true;
      return false;
    }
    candidates.push(candidate);
    return true;
  };

  const visit = async (
    currentDir: string,
    relativeDir: string,
  ): Promise<'ok' | 'missing' | 'truncated' | 'unavailable'> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      return isMissingPathError(error) ? 'missing' : 'unavailable';
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      scannedEntries += 1;
      if (scannedEntries > MANUAL_SCAN_MAX_ENTRIES) {
        truncated = true;
        return 'truncated';
      }
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink()) return 'unavailable';
      if (entry.isDirectory()) {
        if (ghostManualLogicalPathForEntry(item.name, relativePath, 'directory') === null) {
          return 'unavailable';
        }
        const nestedState = await visit(absolutePath, relativePath);
        if (nestedState === 'missing') {
          sawMissing = true;
          continue;
        }
        if (nestedState !== 'ok') return nestedState;
        continue;
      }
      if (!entry.isFile()) return 'unavailable';
      const logicalPath = ghostManualLogicalPathForEntry(item.name, relativePath, 'file');
      if (logicalPath === null) return 'unavailable';
      const read = await readManualFile(absolutePath, realUnitRoot);
      if (!read.ok) return 'unavailable';
      if (
        !addCandidate({
          name: logicalPath,
          description:
            relativePath === GHOST_MANUAL_ENTRY_FILE
              ? item.description
              : '该手册单元内可按需读取的 Markdown 文件',
        })
      ) {
        return 'truncated';
      }
    }
    return 'ok';
  };

  const scanState = await visit(unitRoot, '');
  if (scanState === 'unavailable') return { status: 'unavailable' };
  if (scanState === 'missing') sawMissing = true;
  if (truncated) {
    const withoutEntry = candidates.filter((candidate) => candidate.name !== item.name);
    candidates.splice(
      0,
      candidates.length,
      { name: item.name, description: `${item.description}（候选已截断）` },
      ...withoutEntry,
    );
    if (candidates.length > MANUAL_CANDIDATE_MAX_ITEMS) candidates.pop();
    while (candidates.length > 1 && serializedBytes(candidates) > MANUAL_CANDIDATE_MAX_BYTES) {
      candidates.pop();
    }
  }
  return { status: sawMissing ? 'missing' : 'ok', manual: candidates };
}

async function resolveUnitRoot(
  ghost: InstalledGhost,
  item: GhostManualItem,
): Promise<{ unitRoot: string; realUnitRoot: string } | null> {
  try {
    let unitRoot = ghost.dir;
    for (const segment of item.dir.split('/')) {
      unitRoot = path.join(unitRoot, segment);
      const stat = await fs.promises.lstat(unitRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    }
    const [realGhostRoot, realUnitRoot] = await Promise.all([
      fs.promises.realpath(ghost.dir),
      fs.promises.realpath(unitRoot),
    ]);
    if (!isRealPathWithinRoot(realUnitRoot, realGhostRoot)) return null;
    return { unitRoot, realUnitRoot };
  } catch {
    return null;
  }
}

async function resolveManualEntry(
  ghost: InstalledGhost,
  item: GhostManualItem,
): Promise<
  | { ok: true; unitRoot: string; realUnitRoot: string; content: string }
  | { ok: false; result: CindyGhostManualResult }
> {
  const roots = await resolveUnitRoot(ghost, item);
  if (!roots) {
    return {
      ok: false,
      result: unavailable('插件声明的手册不可用；请更新或重装插件。'),
    };
  }
  const entry = await readManualFile(
    path.join(roots.unitRoot, GHOST_MANUAL_ENTRY_FILE),
    roots.realUnitRoot,
  );
  if (!entry.ok) {
    return {
      ok: false,
      result: unavailable('插件声明的手册入口不可用；请更新或重装插件。'),
    };
  }
  return { ok: true, ...roots, content: entry.content };
}

async function pathNotFoundWithUnitCandidates(
  message: string,
  item: GhostManualItem,
  unitRoot: string,
  realUnitRoot: string,
): Promise<CindyGhostManualResult> {
  const candidates = await collectUnitCandidates(item, unitRoot, realUnitRoot);
  if (candidates.status === 'unavailable') {
    return unavailable('插件声明的手册不可用；请更新或重装插件。');
  }
  return pathNotFound(message, candidates.manual);
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function classifyRelativeParents(
  unitRoot: string,
  relativeFile: string,
): Promise<'ok' | 'missing' | 'unavailable'> {
  const parents = relativeFile.split('/').slice(0, -1);
  let current = unitRoot;
  for (const segment of parents) {
    current = path.join(current, segment);
    try {
      const stat = await fs.promises.lstat(current);
      if (stat.isSymbolicLink()) return 'unavailable';
      if (stat.isFile()) return 'missing';
      if (!stat.isDirectory()) return 'unavailable';
    } catch (error) {
      return isMissingPathError(error) ? 'missing' : 'unavailable';
    }
  }
  return 'ok';
}

/**
 * 读取已安装插件的随包手册。只认 manifest 声明的逻辑 name，不做 URL decode，
 * 物理路径始终被声明单元目录与单句柄 no-follow 读取共同约束。
 */
export async function readInstalledGhostManual(
  ghost: InstalledGhost,
  requestedPath?: string,
): Promise<CindyGhostManualResult> {
  const index = rootIndex(ghost);
  if (requestedPath === undefined) {
    return { ok: true, manual: index, content: '' };
  }
  const segments = parseGhostManualLogicalPath(requestedPath);
  if (!segments) {
    const firstSegment = requestedPath.split('/')[0];
    const item = ghost.manifest.manual?.items.find((candidate) => candidate.name === firstSegment);
    if (!item) {
      return pathNotFound('手册路径不合法；请从返回索引选择可用路径。', index);
    }
    const resolved = await resolveManualEntry(ghost, item);
    if (!resolved.ok) return resolved.result;
    return pathNotFoundWithUnitCandidates(
      '手册路径不合法；请从返回候选选择可用路径。',
      item,
      resolved.unitRoot,
      resolved.realUnitRoot,
    );
  }
  const item = ghost.manifest.manual?.items.find((candidate) => candidate.name === segments[0]);
  if (!item) {
    return pathNotFound('未找到该手册单元；请从返回索引选择可用路径。', index);
  }
  const resolved = await resolveManualEntry(ghost, item);
  if (!resolved.ok) return resolved.result;
  const relativeFile =
    segments.length === 1 ? GHOST_MANUAL_ENTRY_FILE : segments.slice(1).join('/');
  if (relativeFile === GHOST_MANUAL_ENTRY_FILE) {
    return { ok: true, manual: [], content: resolved.content };
  }
  if (ghostManualLogicalPathForEntry(item.name, relativeFile, 'file') === null) {
    return pathNotFoundWithUnitCandidates(
      '手册路径未命中 Markdown 文件；请从返回候选选择。',
      item,
      resolved.unitRoot,
      resolved.realUnitRoot,
    );
  }
  const parentState = await classifyRelativeParents(resolved.unitRoot, relativeFile);
  if (parentState === 'unavailable') {
    return unavailable('插件声明的手册文件不可用；请更新或重装插件。');
  }
  if (parentState === 'missing') {
    return pathNotFoundWithUnitCandidates(
      '未找到该手册文件；请从返回候选选择。',
      item,
      resolved.unitRoot,
      resolved.realUnitRoot,
    );
  }
  const absolutePath = path.join(resolved.unitRoot, ...relativeFile.split('/'));
  let exists: fs.Stats;
  try {
    exists = await fs.promises.lstat(absolutePath);
  } catch (error) {
    if (!isMissingPathError(error)) {
      return unavailable('插件声明的手册文件不可用；请更新或重装插件。');
    }
    return pathNotFoundWithUnitCandidates(
      '未找到该手册文件；请从返回候选选择。',
      item,
      resolved.unitRoot,
      resolved.realUnitRoot,
    );
  }
  if (exists.isSymbolicLink()) {
    return unavailable('插件声明的手册文件不可用；请更新或重装插件。');
  }
  if (exists.isDirectory()) {
    return pathNotFoundWithUnitCandidates(
      '手册路径未命中 Markdown 文件；请从返回候选选择。',
      item,
      resolved.unitRoot,
      resolved.realUnitRoot,
    );
  }
  if (!exists.isFile()) {
    return unavailable('插件声明的手册文件不可用；请更新或重装插件。');
  }
  const read = await readManualFile(absolutePath, resolved.realUnitRoot);
  if (!read.ok) {
    return unavailable('插件声明的手册文件不可用；请更新或重装插件。');
  }
  return { ok: true, manual: [], content: read.content };
}
