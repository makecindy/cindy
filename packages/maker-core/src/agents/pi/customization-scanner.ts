/**
 * Pi filesystem customization scanner.
 *
 * Pi reads user skills from ~/.agents/skills in Cindy sessions. Project skills
 * live in {cwd}/.pi/skills and in every .agents/skills directory from cwd up to
 * the nearest Git repository root. Project discovery is only a preview until
 * Pi's runtime catalog confirms a skill was loaded.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  AgentCustomization,
  AgentCustomizationFile,
  ListCustomizationsOptions,
  ListCustomizationsResult,
} from '../../types/customizations.js';
import {
  isCustomizationPathInside,
  parseFrontmatter,
  type SourceDef,
} from '../shared/customization-scanner.js';

export const PI_CUSTOMIZATION_SCAN_DEADLINE_MS = 30_000;
export const MAX_PI_CUSTOMIZATION_SCAN_ENTRIES = 10_000;
const MAX_PI_CUSTOMIZATION_SKILL_MD_BYTES = 16 * 1024 * 1024;
const MAX_PI_CUSTOMIZATION_SCAN_TOTAL_BYTES = 64 * 1024 * 1024;
const PI_CUSTOMIZATION_SCAN_TIMEOUT = 'PI_CUSTOMIZATION_SCAN_TIMEOUT';
const PI_CUSTOMIZATION_SCAN_BUDGET = 'PI_CUSTOMIZATION_SCAN_BUDGET';
const PI_CUSTOMIZATION_SCAN_UNSAFE_FILE = 'PI_CUSTOMIZATION_SCAN_UNSAFE_FILE';

/** Injectable async filesystem surface used to test fail-closed scan budgets. */
export interface PiCustomizationScanDeps {
  stat: (candidate: string) => Promise<fs.Stats>;
  realpath: (candidate: string) => Promise<string>;
  openDirectory: (candidate: string) => Promise<fs.Dir>;
  openFile: (candidate: string) => Promise<FileHandle>;
  deadlineMs: number;
}

const defaultScanDeps: PiCustomizationScanDeps = {
  stat: (candidate) => fsp.stat(candidate),
  realpath: (candidate) => fsp.realpath(candidate),
  openDirectory: (candidate) => fsp.opendir(candidate),
  openFile: (candidate) => fsp.open(
    candidate,
    fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0),
  ),
  deadlineMs: PI_CUSTOMIZATION_SCAN_DEADLINE_MS,
};

interface PiCustomizationScanBudget {
  remainingEntries: number;
  remainingBytes: number;
  readonly deadlineAtMs: number;
}

export interface PiRuntimeUserSkillSource {
  readonly baseDir: string;
  readonly sourcePath: string;
  readonly canonicalSourcePath: string;
  readonly runtimeCommandName: string;
  readonly proof: PiRuntimeUserSkillSourceProof;
}

export interface PiRuntimeUserSkillFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export interface PiRuntimeUserSkillSourceProof {
  readonly canonicalSourcePath: string;
  readonly entry: PiRuntimeUserSkillFileIdentity;
  readonly target: PiRuntimeUserSkillFileIdentity;
  readonly entrypointPath: string;
  readonly entrypoint: PiRuntimeUserSkillFileIdentity;
}

function scanTimeoutError(): Error & { code: string } {
  return Object.assign(new Error('Pi customization scan deadline expired'), {
    code: PI_CUSTOMIZATION_SCAN_TIMEOUT,
  });
}

function isScanTimeout(error: unknown): boolean {
  return !!error && typeof error === 'object'
    && (error as { code?: unknown }).code === PI_CUSTOMIZATION_SCAN_TIMEOUT;
}

function scanBudgetError(): Error & { code: string } {
  return Object.assign(new Error('Pi customization scan entry budget exceeded'), {
    code: PI_CUSTOMIZATION_SCAN_BUDGET,
  });
}

function scanByteBudgetError(): Error & { code: string } {
  return Object.assign(new Error('Pi customization scan byte budget exceeded'), {
    code: PI_CUSTOMIZATION_SCAN_BUDGET,
  });
}

function unsafeSkillFileError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), {
    code: PI_CUSTOMIZATION_SCAN_UNSAFE_FILE,
  });
}

function isScanFatal(error: unknown): boolean {
  if (isScanTimeout(error)) return true;
  return !!error && typeof error === 'object'
    && (error as { code?: unknown }).code === PI_CUSTOMIZATION_SCAN_BUDGET;
}

function isUnsafeSkillFile(error: unknown): boolean {
  return !!error && typeof error === 'object'
    && (error as { code?: unknown }).code === PI_CUSTOMIZATION_SCAN_UNSAFE_FILE;
}

async function awaitScanStep<T>(
  operation: () => Promise<T>,
  budget: PiCustomizationScanBudget,
): Promise<T> {
  const remainingMs = budget.deadlineAtMs - Date.now();
  if (remainingMs <= 0) throw scanTimeoutError();
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(scanTimeoutError()), remainingMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function consumeScanEntry(budget: PiCustomizationScanBudget): void {
  budget.remainingEntries -= 1;
  if (budget.remainingEntries < 0) {
    throw scanBudgetError();
  }
}

function reserveScanBytes(
  budget: PiCustomizationScanBudget,
  byteLength: number,
): void {
  if (
    !Number.isSafeInteger(byteLength)
    || byteLength < 0
    || byteLength > budget.remainingBytes
  ) {
    throw scanByteBudgetError();
  }
  budget.remainingBytes -= byteLength;
}

function filesystemErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object'
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

function sameFileSnapshot(first: fs.Stats, second: fs.Stats): boolean {
  return first.isFile()
    && second.isFile()
    && first.ino !== 0
    && second.ino !== 0
    && first.dev === second.dev
    && first.ino === second.ino
    && first.size === second.size
    && first.mtimeMs === second.mtimeMs
    && first.ctimeMs === second.ctimeMs;
}

function runtimeUserSkillFileIdentity(stat: fs.BigIntStats): PiRuntimeUserSkillFileIdentity {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  });
}

function sameRuntimeUserSkillFileIdentity(
  first: PiRuntimeUserSkillFileIdentity,
  second: PiRuntimeUserSkillFileIdentity,
): boolean {
  return first.ino !== 0n
    && second.ino !== 0n
    && first.dev === second.dev
    && first.ino === second.ino
    && first.mode === second.mode
    && first.size === second.size
    && first.mtimeNs === second.mtimeNs
    && first.ctimeNs === second.ctimeNs;
}

async function readBoundedSkillFile(
  mdPath: string,
  dependencies: PiCustomizationScanDeps,
  budget: PiCustomizationScanBudget,
  captureIdentity?: (identity: PiRuntimeUserSkillFileIdentity) => void,
): Promise<string> {
  const pathBefore = await awaitScanStep(() => dependencies.stat(mdPath), budget);
  if (!pathBefore.isFile() || pathBefore.size > MAX_PI_CUSTOMIZATION_SKILL_MD_BYTES) {
    throw unsafeSkillFileError('Pi Skill entrypoint is not a bounded file');
  }
  reserveScanBytes(budget, pathBefore.size);

  const handle = await awaitScanStep(() => dependencies.openFile(mdPath), budget);
  let iterator: AsyncIterator<unknown> | undefined;
  let stream: fs.ReadStream | undefined;
  const controller = new AbortController();
  try {
    const handleBefore = await awaitScanStep(() => handle.stat(), budget);
    if (!sameFileSnapshot(pathBefore, handleBefore)) {
      throw unsafeSkillFileError('Pi Skill entrypoint changed before reading');
    }
    const identityBefore = captureIdentity
      ? runtimeUserSkillFileIdentity(await awaitScanStep(
          () => handle.stat({ bigint: true }),
          budget,
        ))
      : undefined;

    const chunks: Buffer[] = [];
    let byteLength = 0;
    let chargedByteLength = pathBefore.size;
    stream = handle.createReadStream({
      start: 0,
      autoClose: false,
      highWaterMark: 64 * 1024,
      signal: controller.signal,
    });
    iterator = stream[Symbol.asyncIterator]();
    while (true) {
      const result = await awaitScanStep(() => iterator!.next(), budget);
      if (result.done) break;
      if (!Buffer.isBuffer(result.value)) {
        throw unsafeSkillFileError('Pi Skill entrypoint returned a non-binary chunk');
      }
      const chunk = result.value;
      byteLength += chunk.byteLength;
      if (byteLength > MAX_PI_CUSTOMIZATION_SKILL_MD_BYTES) {
        throw unsafeSkillFileError('Pi Skill entrypoint exceeded the byte budget');
      }
      if (byteLength > chargedByteLength) {
        reserveScanBytes(budget, byteLength - chargedByteLength);
        chargedByteLength = byteLength;
      }
      chunks.push(chunk);
    }

    const [handleAfter, pathAfter] = await Promise.all([
      awaitScanStep(() => handle.stat(), budget),
      awaitScanStep(() => dependencies.stat(mdPath), budget),
    ]);
    if (
      !sameFileSnapshot(handleBefore, handleAfter)
      || !sameFileSnapshot(handleBefore, pathAfter)
    ) {
      throw unsafeSkillFileError('Pi Skill entrypoint changed while reading');
    }
    if (identityBefore) {
      const [handleIdentityAfter, pathIdentityAfter] = await Promise.all([
        awaitScanStep(() => handle.stat({ bigint: true }), budget),
        awaitScanStep(() => fsp.stat(mdPath, { bigint: true }), budget),
      ]);
      const stableIdentity = runtimeUserSkillFileIdentity(handleIdentityAfter);
      if (
        !handleIdentityAfter.isFile()
        || !pathIdentityAfter.isFile()
        || !sameRuntimeUserSkillFileIdentity(identityBefore, stableIdentity)
        || !sameRuntimeUserSkillFileIdentity(
          stableIdentity,
          runtimeUserSkillFileIdentity(pathIdentityAfter),
        )
      ) {
        throw unsafeSkillFileError('Pi Skill entrypoint changed while reading');
      }
      captureIdentity?.(stableIdentity);
    }
    return Buffer.concat(chunks, byteLength).toString('utf8');
  } finally {
    controller.abort();
    stream?.destroy?.();
    if (iterator?.return) {
      void Promise.resolve().then(() => iterator!.return!()).catch(() => {});
    }
    void Promise.resolve().then(() => handle.close()).catch(() => {});
  }
}

async function readDirectoryEntries(
  dir: string,
  dependencies: PiCustomizationScanDeps,
  budget: PiCustomizationScanBudget,
): Promise<fs.Dirent[]> {
  const handle = await awaitScanStep(() => dependencies.openDirectory(dir), budget);
  const entries: fs.Dirent[] = [];
  try {
    while (true) {
      const entry = await awaitScanStep(() => handle.read(), budget);
      if (!entry) break;
      consumeScanEntry(budget);
      entries.push(entry);
    }
  } finally {
    void handle.close().catch(() => {});
  }
  return entries;
}

async function canonicalDirectoryAsync(
  dir: string,
  dependencies: PiCustomizationScanDeps,
  budget: PiCustomizationScanBudget,
): Promise<string> {
  const resolved = path.resolve(dir);
  try {
    return await awaitScanStep(() => dependencies.realpath(resolved), budget);
  } catch (error) {
    if (isScanFatal(error)) throw error;
    return resolved;
  }
}

async function isExistingDirectoryAsync(
  dir: string,
  dependencies: PiCustomizationScanDeps,
  budget: PiCustomizationScanBudget,
): Promise<boolean> {
  try {
    return (await awaitScanStep(() => dependencies.stat(dir), budget)).isDirectory();
  } catch (error) {
    if (isScanFatal(error)) throw error;
    return false;
  }
}

async function hasGitMarkerAsync(
  dir: string,
  dependencies: PiCustomizationScanDeps,
  budget: PiCustomizationScanBudget,
): Promise<boolean> {
  try {
    const marker = await awaitScanStep(
      () => dependencies.stat(path.join(dir, '.git')),
      budget,
    );
    return marker.isDirectory() || marker.isFile();
  } catch (error) {
    if (isScanFatal(error)) throw error;
    const code = filesystemErrorCode(error);
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

async function findNearestGitRootAsync(
  workingDir: string,
  dependencies: PiCustomizationScanDeps,
  budget: PiCustomizationScanBudget,
): Promise<string | null> {
  let current = await canonicalDirectoryAsync(workingDir, dependencies, budget);
  while (true) {
    if (await hasGitMarkerAsync(current, dependencies, budget)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function agentSkillAncestorsAsync(
  workingDir: string,
  dependencies: PiCustomizationScanDeps,
  budget: PiCustomizationScanBudget,
): Promise<string[]> {
  const start = await canonicalDirectoryAsync(workingDir, dependencies, budget);
  const repoRoot = await findNearestGitRootAsync(start, dependencies, budget);
  const result: string[] = [];
  let current = start;
  while (true) {
    result.push(current);
    if (!repoRoot || current === repoRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}

export function piUserSkillRoot(): string {
  return path.join(os.homedir(), '.agents', 'skills');
}

async function buildPiSourcesAsync(
  workingDirs: string[],
  dependencies: PiCustomizationScanDeps,
  budget: PiCustomizationScanBudget,
): Promise<SourceDef[]> {
  const sources: SourceDef[] = [
    { engine: 'pi', kind: 'skill', scope: 'user', dir: piUserSkillRoot() },
  ];
  const seen = new Set<string>();

  for (const input of workingDirs) {
    if (
      !input
      || !path.isAbsolute(input)
      || !await isExistingDirectoryAsync(input, dependencies, budget)
    ) continue;
    const workingDir = path.resolve(input);
    const scanRoot = await canonicalDirectoryAsync(input, dependencies, budget);
    const projectBoundary = await findNearestGitRootAsync(scanRoot, dependencies, budget)
      ?? scanRoot;
    const addProjectSource = async (dir: string): Promise<void> => {
      const key = `${workingDir}\0${await canonicalDirectoryAsync(dir, dependencies, budget)}`;
      if (seen.has(key)) return;
      seen.add(key);
      sources.push({
        engine: 'pi',
        kind: 'skill',
        scope: 'repo',
        dir,
        workingDir,
        runtimeStatus: 'discovered',
        skillContainWithin: projectBoundary,
      });
    };

    await addProjectSource(path.join(scanRoot, '.pi', 'skills'));
    for (const ancestor of await agentSkillAncestorsAsync(scanRoot, dependencies, budget)) {
      await addProjectSource(path.join(ancestor, '.agents', 'skills'));
    }
  }
  return sources;
}

async function readChildKindAsync(
  parent: string,
  entry: fs.Dirent,
  dependencies: PiCustomizationScanDeps,
  budget: PiCustomizationScanBudget,
): Promise<AgentCustomizationFile['kind']> {
  if (entry.isDirectory()) return 'dir';
  if (!entry.isSymbolicLink()) return 'file';
  try {
    return (await awaitScanStep(
      () => dependencies.stat(path.join(parent, entry.name)),
      budget,
    )).isDirectory()
      ? 'dir'
      : 'file';
  } catch (error) {
    if (isScanFatal(error)) throw error;
    return 'file';
  }
}

async function readFolderSkillAsync(
  source: SourceDef,
  folder: string,
  mdPath: string,
  dependencies: PiCustomizationScanDeps,
  budget: PiCustomizationScanBudget,
  captureEntrypointIdentity?: (identity: PiRuntimeUserSkillFileIdentity) => void,
): Promise<AgentCustomization> {
  let description: string | undefined;
  let frontmatter: Record<string, unknown> | undefined;
  let parseError: string | undefined;
  try {
    const raw = await readBoundedSkillFile(
      mdPath,
      dependencies,
      budget,
      captureEntrypointIdentity,
    );
    ({ description, frontmatter, parseError } = parseFrontmatter(raw));
  } catch (error) {
    if (isScanFatal(error) || (source.scope === 'repo' && isUnsafeSkillFile(error))) {
      throw error;
    }
    parseError = error instanceof Error ? error.message : String(error);
  }

  const files: AgentCustomizationFile[] = [];
  try {
    const entries = await readDirectoryEntries(folder, dependencies, budget);
    for (const entry of entries) {
      files.push({
        name: entry.name,
        kind: await readChildKindAsync(folder, entry, dependencies, budget),
      });
    }
    files.sort((left, right) => {
      if (left.name === 'SKILL.md') return -1;
      if (right.name === 'SKILL.md') return 1;
      if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  } catch (error) {
    if (isScanFatal(error)) throw error;
    // File previews remain best-effort, matching the legacy shared scanner.
  }

  return {
    engine: source.engine,
    kind: source.kind,
    scope: source.scope,
    name: path.basename(folder),
    description,
    absolutePath: folder,
    mdPath,
    files,
    frontmatter,
    parseError,
    ...(source.workingDir ? { workingDir: source.workingDir } : {}),
    ...(source.runtimeStatus ? { runtimeStatus: source.runtimeStatus } : {}),
  };
}

async function realPathInsideAsync(
  parentRealPath: string,
  candidate: string,
  dependencies: PiCustomizationScanDeps,
  budget: PiCustomizationScanBudget,
): Promise<boolean> {
  try {
    return isCustomizationPathInside(
      parentRealPath,
      await awaitScanStep(() => dependencies.realpath(candidate), budget),
    );
  } catch (error) {
    if (isScanFatal(error)) throw error;
    return false;
  }
}

async function statFileIfPresent(
  candidate: string,
  dependencies: PiCustomizationScanDeps,
  budget: PiCustomizationScanBudget,
): Promise<boolean> {
  try {
    return (await awaitScanStep(() => dependencies.stat(candidate), budget)).isFile();
  } catch (error) {
    if (isScanFatal(error)) throw error;
    return false;
  }
}

async function scanOneSourceAsync(
  source: SourceDef,
  dependencies: PiCustomizationScanDeps,
  budget: PiCustomizationScanBudget,
): Promise<{ items: AgentCustomization[]; errors: Array<{ path?: string; message: string }> }> {
  const errors: Array<{ path?: string; message: string }> = [];
  try {
    let sourceStat: fs.Stats;
    try {
      sourceStat = await awaitScanStep(() => dependencies.stat(source.dir), budget);
    } catch (error) {
      if (isScanFatal(error)) throw error;
      const code = filesystemErrorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return { items: [], errors };
      throw error;
    }
    if (!sourceStat.isDirectory()) return { items: [], errors };

    let containmentRoot: string | null = null;
    if (source.skillContainWithin) {
      containmentRoot = await awaitScanStep(
        () => dependencies.realpath(source.skillContainWithin!),
        budget,
      );
      if (!await realPathInsideAsync(containmentRoot, source.dir, dependencies, budget)) {
        return { items: [], errors };
      }
    }

    const entries = await readDirectoryEntries(source.dir, dependencies, budget);
    const items: AgentCustomization[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') || /\.bak\.\d+$/.test(entry.name)) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const folder = path.join(source.dir, entry.name);
      const canonicalMd = path.join(folder, 'SKILL.md');
      let actualMd = canonicalMd;
      if (!await statFileIfPresent(canonicalMd, dependencies, budget)) {
        if (source.scope === 'repo') continue;
        const lowerMd = path.join(folder, 'skill.md');
        if (!await statFileIfPresent(lowerMd, dependencies, budget)) continue;
        actualMd = lowerMd;
      }
      if (
        containmentRoot
        && (
          !await realPathInsideAsync(containmentRoot, folder, dependencies, budget)
          || !await realPathInsideAsync(containmentRoot, actualMd, dependencies, budget)
        )
      ) continue;
      items.push(await readFolderSkillAsync(
        source,
        folder,
        actualMd,
        dependencies,
        budget,
      ));
    }
    return { items, errors };
  } catch (error) {
    if (isScanFatal(error) || isUnsafeSkillFile(error)) throw error;
    errors.push({
      path: source.dir,
      message: error instanceof Error ? error.message : String(error),
    });
    return { items: [], errors };
  }
}

/**
 * Resolve Pi user commands back to the exact directory entries that supplied
 * their frontmatter names. This is internal runtime provenance only; callers
 * still need to revalidate the returned directory snapshot before use.
 */
export async function scanPiRuntimeUserSkillSources(
  baseDirs: readonly string[],
  deadlineAtMs: number,
): Promise<PiRuntimeUserSkillSource[]> {
  const dependencies = defaultScanDeps;
  const budget: PiCustomizationScanBudget = {
    remainingEntries: MAX_PI_CUSTOMIZATION_SCAN_ENTRIES,
    remainingBytes: MAX_PI_CUSTOMIZATION_SCAN_TOTAL_BYTES,
    deadlineAtMs,
  };
  const sources: PiRuntimeUserSkillSource[] = [];

  for (const baseDir of baseDirs) {
    const source: SourceDef = {
      engine: 'pi',
      kind: 'skill',
      scope: 'user',
      dir: path.join(baseDir, 'skills'),
    };
    try {
      const entries = await readDirectoryEntries(source.dir, dependencies, budget);
      for (const entry of entries) {
        if (entry.name.startsWith('.') || /\.bak\.\d+$/.test(entry.name)) continue;
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const folder = path.join(source.dir, entry.name);
        const canonicalMd = path.join(folder, 'SKILL.md');
        let actualMd = canonicalMd;
        if (!await statFileIfPresent(canonicalMd, dependencies, budget)) {
          const lowerMd = path.join(folder, 'skill.md');
          if (!await statFileIfPresent(lowerMd, dependencies, budget)) continue;
          actualMd = lowerMd;
        }

        const [entryBefore, targetBefore, canonicalBefore] = await Promise.all([
          awaitScanStep(() => fsp.lstat(folder, { bigint: true }), budget),
          awaitScanStep(() => fsp.stat(folder, { bigint: true }), budget),
          awaitScanStep(() => dependencies.realpath(folder), budget),
        ]);
        let entrypointIdentity: PiRuntimeUserSkillFileIdentity | undefined;
        const item = await readFolderSkillAsync(
          source,
          folder,
          actualMd,
          dependencies,
          budget,
          (identity) => { entrypointIdentity = identity; },
        );
        const [entryAfter, targetAfter, canonicalAfter] = await Promise.all([
          awaitScanStep(() => fsp.lstat(folder, { bigint: true }), budget),
          awaitScanStep(() => fsp.stat(folder, { bigint: true }), budget),
          awaitScanStep(() => dependencies.realpath(folder), budget),
        ]);
        const entryIdentityBefore = runtimeUserSkillFileIdentity(entryBefore);
        const entryIdentityAfter = runtimeUserSkillFileIdentity(entryAfter);
        const targetIdentityBefore = runtimeUserSkillFileIdentity(targetBefore);
        const targetIdentityAfter = runtimeUserSkillFileIdentity(targetAfter);
        if (
          item.parseError
          || !entrypointIdentity
          || (!entryBefore.isDirectory() && !entryBefore.isSymbolicLink())
          || !targetBefore.isDirectory()
          || !sameRuntimeUserSkillFileIdentity(entryIdentityBefore, entryIdentityAfter)
          || !sameRuntimeUserSkillFileIdentity(targetIdentityBefore, targetIdentityAfter)
          || canonicalBefore !== canonicalAfter
          || !path.isAbsolute(canonicalBefore)
          || canonicalBefore.includes('\0')
        ) continue;

        const frontmatterName = item.frontmatter?.name;
        const runtimeName = typeof frontmatterName === 'string' && frontmatterName.trim()
          ? frontmatterName
          : item.name;
        const runtimeCommandName = `skill:${runtimeName}`;
        if (!/^skill:[^\s/\\\0]+$/.test(runtimeCommandName)) continue;
        const proof = Object.freeze({
          canonicalSourcePath: canonicalBefore,
          entry: entryIdentityAfter,
          target: targetIdentityAfter,
          entrypointPath: actualMd,
          entrypoint: entrypointIdentity,
        } satisfies PiRuntimeUserSkillSourceProof);
        sources.push({
          baseDir,
          sourcePath: item.absolutePath,
          canonicalSourcePath: canonicalBefore,
          runtimeCommandName,
          proof,
        });
      }
    } catch (error) {
      if (isScanFatal(error)) throw error;
      // Catalog discovery is diagnostic; missing or unstable proof fails closed per Skill.
    }
  }
  return sources;
}

async function dedupePiItemsAsync(
  items: AgentCustomization[],
  dependencies: PiCustomizationScanDeps,
  budget: PiCustomizationScanBudget,
): Promise<AgentCustomization[]> {
  const seen = new Set<string>();
  const result: AgentCustomization[] = [];
  for (const item of items) {
    const key = [
      item.scope,
      item.workingDir ?? '',
      await canonicalDirectoryAsync(item.absolutePath, dependencies, budget),
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

export async function scanPiCustomizations(
  opts: ListCustomizationsOptions,
  overrides: Partial<PiCustomizationScanDeps> = {},
): Promise<ListCustomizationsResult> {
  if (opts.kinds && opts.kinds.length > 0 && !opts.kinds.includes('skill')) {
    return { items: [], errors: [] };
  }
  const dependencies: PiCustomizationScanDeps = { ...defaultScanDeps, ...overrides };
  const deadlineMs = Number.isSafeInteger(dependencies.deadlineMs) && dependencies.deadlineMs >= 0
    ? dependencies.deadlineMs
    : 0;
  const budget: PiCustomizationScanBudget = {
    remainingEntries: MAX_PI_CUSTOMIZATION_SCAN_ENTRIES,
    remainingBytes: MAX_PI_CUSTOMIZATION_SCAN_TOTAL_BYTES,
    deadlineAtMs: Date.now() + deadlineMs,
  };
  try {
    const sources = await buildPiSourcesAsync(opts.workingDirs ?? [], dependencies, budget);
    const items: AgentCustomization[] = [];
    const errors: Array<{ path?: string; message: string }> = [];
    for (const source of sources) {
      const scanned = await scanOneSourceAsync(source, dependencies, budget);
      items.push(...scanned.items);
      errors.push(...scanned.errors);
    }
    const deduped = await dedupePiItemsAsync(items, dependencies, budget);
    deduped.sort((left, right) => {
      if (left.scope !== right.scope) return left.scope.localeCompare(right.scope);
      if (left.name !== right.name) return left.name.localeCompare(right.name);
      return left.absolutePath.localeCompare(right.absolutePath);
    });
    return { items: deduped, errors };
  } catch (error) {
    return {
      items: [],
      errors: [{ message: error instanceof Error ? error.message : String(error) }],
    };
  }
}
