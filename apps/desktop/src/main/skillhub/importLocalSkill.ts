/**
 * Local skill import — zip or standalone SKILL.md → ~/.agents/skills/<name>/ (or custom installPath).
 *
 * Flow mirrors market install final-switch + learn apply registry write, without Hub download.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import JSZip from 'jszip';

import { getCurrentDataOwnerId, getCurrentUserId } from '../authManager';
import {
  assertGhostSkillProjectionBoundaryStableForOwner,
  withSharedGlobalSkillProjectionMutation,
} from '../authBoundaryQuarantine.js';
import { createLogger, maskPath } from '../logger';
import {
  prepareSharedGlobalSkillLinks,
  prepareSharedProjectSkillLinks,
  projectWorkingDirFromSkillPath,
} from '../maker-host/shared-global-skills.js';
import { computeFolderHash } from './folderHash';
import {
  classifyImportSourcePath,
  extractSkillMetadataFromMd,
  findZipSkillPackageRoot,
  fitsUncompressedBudget,
  relativizeZipEntry,
  resolveImportInstallPath,
  type ImportLocalErrorCode,
  type SkillImportMetadata,
} from './importLocalSkill.pure.js';
import { getSkillInstallLockOwner, tryAcquireSkillInstallLock } from './installLock';
import { ensureSymlinkToShared } from './installService';
import { registryService } from './registry';

const log = createLogger('skillhub:importLocal');

const MAX_SKILL_ZIP = 200 * 1024 * 1024;
const MAX_SKILL_UNCOMPRESSED = 500 * 1024 * 1024;
/** Cap a single SKILL.md inflate/read so inspect cannot OOM on one entry. */
const MAX_SKILL_MD = 2 * 1024 * 1024;
const MAX_SKILL_ZIP_ENTRIES = 10_000;

export interface InspectLocalParams {
  filePath: string;
}

export interface ImportLocalParams {
  filePath: string;
  installPath?: string;
  force?: boolean;
}

export type InspectLocalResult =
  | { success: true; name: string; description: string; version: string }
  | { success: false; errorCode: ImportLocalErrorCode; message: string };

export type ImportLocalResult =
  | {
      success: true;
      name: string;
      description: string;
      version: string;
      absolutePath: string;
      projectWorkingDir?: string;
    }
  | { success: false; errorCode: ImportLocalErrorCode; message: string };

function rand(): string {
  return crypto.randomBytes(4).toString('hex');
}

function backupsRoot(): string {
  return path.join(app.getPath('userData'), 'skillhub', 'backups');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

function isSubPathOrSame(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function safeJoin(dest: string, relPath: string): string | null {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const resolved = path.resolve(dest, normalized);
  return isSubPathOrSame(dest, resolved) ? resolved : null;
}

function busyMessage(skillName: string): string {
  const owner = getSkillInstallLockOwner(skillName);
  if (owner === 'market-install') return `${skillName} 正在从市场安装中，请稍后再导入`;
  if (owner === 'market-uninstall') return `${skillName} 正在卸载中，请稍后再导入`;
  if (owner === 'learn-apply') return `${skillName} 正在应用学习产物，请稍后再导入`;
  if (owner === 'local-import') return `${skillName} 正在导入中`;
  return `${skillName} 正在被其它安装任务占用`;
}

function getDeclaredUncompressedSize(entry: JSZip.JSZipObject): number | null {
  const raw = (entry as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

/**
 * Inflate a zip entry with a hard byte ceiling so a zip bomb cannot fully
 * materialize into memory before the budget check runs.
 */
async function readZipEntryLimited(
  entry: JSZip.JSZipObject,
  maxBytes: number,
): Promise<Buffer> {
  const declared = getDeclaredUncompressedSize(entry);
  if (declared != null && declared > maxBytes) {
    throw new Error(`zip entry 解压后大小超过上限：${maxBytes} bytes`);
  }

  // JSZip typings expose a DOM ReadableStream; runtime returns a Node stream.
  const stream = entry.nodeStream('nodebuffer') as unknown as NodeJS.ReadableStream & {
    destroy?: (error?: Error) => void;
  };
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      stream.destroy?.(err);
      reject(err);
    };
    stream.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > maxBytes) {
        fail(new Error(`zip entry 解压后大小超过上限：${maxBytes} bytes`));
        return;
      }
      chunks.push(buf);
    });
    stream.on('error', (err: Error) => fail(err));
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
  });
}

async function moveDir(src: string, dst: string): Promise<void> {
  try {
    await fs.promises.rename(src, dst);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  await fs.promises.cp(src, dst, { recursive: true, verbatimSymlinks: true });
  await fs.promises.rm(src, { recursive: true, force: true });
}

async function movePersistentBackup(tempDir: string, skillName: string): Promise<void> {
  const root = path.join(backupsRoot(), skillName);
  await fs.promises.mkdir(root, { recursive: true });
  const dest = path.join(root, `${Date.now()}-${rand()}`);
  await moveDir(tempDir, dest);
}

interface LoadedPackage {
  metadata: SkillImportMetadata;
  /** Write skill contents into stagingDir (must create SKILL.md at staging root). */
  materialize: (stagingDir: string) => Promise<void>;
}

async function loadPackageFromPath(filePath: string): Promise<
  | { ok: true; pkg: LoadedPackage }
  | { ok: false; errorCode: ImportLocalErrorCode; message: string }
> {
  const abs = path.resolve(filePath);
  if (!(await pathExists(abs))) {
    return { ok: false, errorCode: 'INVALID_FILE', message: '文件不存在' };
  }

  const kindResult = classifyImportSourcePath(abs);
  if ('error' in kindResult) {
    return { ok: false, errorCode: 'INVALID_FILE', message: kindResult.error };
  }

  if (kindResult.kind === 'md') {
    let content: string;
    try {
      const st = await fs.promises.stat(abs);
      if (st.size > MAX_SKILL_MD) {
        return {
          ok: false,
          errorCode: 'EXTRACT_FAILED',
          message: `SKILL.md 过大：${st.size} bytes（上限 ${MAX_SKILL_MD}）`,
        };
      }
      content = await fs.promises.readFile(abs, 'utf-8');
    } catch (err) {
      return {
        ok: false,
        errorCode: 'INVALID_FILE',
        message: `读取文件失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (Buffer.byteLength(content, 'utf-8') > MAX_SKILL_MD) {
      return {
        ok: false,
        errorCode: 'EXTRACT_FAILED',
        message: `SKILL.md 过大（上限 ${MAX_SKILL_MD} bytes）`,
      };
    }
    const meta = extractSkillMetadataFromMd(content);
    if (!meta.ok) return meta;
    return {
      ok: true,
      pkg: {
        metadata: meta.metadata,
        materialize: async (stagingDir) => {
          await fs.promises.mkdir(stagingDir, { recursive: true });
          await fs.promises.writeFile(path.join(stagingDir, 'SKILL.md'), content, 'utf-8');
        },
      },
    };
  }

  // zip
  let zipBuf: Buffer;
  try {
    const st = await fs.promises.stat(abs);
    if (st.size > MAX_SKILL_ZIP) {
      return {
        ok: false,
        errorCode: 'EXTRACT_FAILED',
        message: `文件过大：${st.size} bytes（上限 ${MAX_SKILL_ZIP}）`,
      };
    }
    zipBuf = await fs.promises.readFile(abs);
  } catch (err) {
    return {
      ok: false,
      errorCode: 'INVALID_FILE',
      message: `读取压缩包失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBuf);
  } catch (err) {
    return {
      ok: false,
      errorCode: 'EXTRACT_FAILED',
      message: `无法解析压缩包：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const entries = Object.values(zip.files);
  if (entries.length > MAX_SKILL_ZIP_ENTRIES) {
    return {
      ok: false,
      errorCode: 'EXTRACT_FAILED',
      message: `zip entry 数量超过上限：${entries.length}/${MAX_SKILL_ZIP_ENTRIES}`,
    };
  }

  const rootResult = findZipSkillPackageRoot(entries.map((e) => e.name));
  if ('error' in rootResult) {
    return { ok: false, errorCode: 'MISSING_SKILL_MD', message: rootResult.error };
  }
  const { packageRoot } = rootResult;

  const skillMdEntryName = packageRoot ? `${packageRoot}SKILL.md` : 'SKILL.md';
  const skillMdAlt = packageRoot ? `${packageRoot}skill.md` : 'skill.md';
  const skillEntry =
    entries.find((e) => e.name.replace(/\\/g, '/') === skillMdEntryName) ??
    entries.find((e) => e.name.replace(/\\/g, '/') === skillMdAlt) ??
    entries.find((e) => {
      const rel = relativizeZipEntry(e.name, packageRoot);
      return rel === 'SKILL.md' || rel === 'skill.md';
    });

  if (!skillEntry || skillEntry.dir) {
    return { ok: false, errorCode: 'MISSING_SKILL_MD', message: '压缩包中未找到 SKILL.md' };
  }

  // Reject zip bombs before any inflate: sum declared uncompressed sizes for
  // package file entries (directories ignored). Unknown sizes are skipped here
  // and enforced by the streaming reader below.
  const declaredSizes: number[] = [];
  for (const entry of entries) {
    if (entry.dir) continue;
    const rel = relativizeZipEntry(entry.name, packageRoot);
    if (rel == null || rel === '') continue;
    const declared = getDeclaredUncompressedSize(entry);
    if (declared == null) continue;
    declaredSizes.push(declared);
  }
  if (!fitsUncompressedBudget(declaredSizes, MAX_SKILL_UNCOMPRESSED)) {
    return {
      ok: false,
      errorCode: 'EXTRACT_FAILED',
      message: `zip 解压后大小超过上限：${MAX_SKILL_UNCOMPRESSED} bytes`,
    };
  }

  const skillMdDeclared = getDeclaredUncompressedSize(skillEntry);
  if (skillMdDeclared != null && skillMdDeclared > MAX_SKILL_MD) {
    return {
      ok: false,
      errorCode: 'EXTRACT_FAILED',
      message: `SKILL.md 过大：${skillMdDeclared} bytes（上限 ${MAX_SKILL_MD}）`,
    };
  }

  let skillMdContent: string;
  try {
    const skillMdBuf = await readZipEntryLimited(skillEntry, MAX_SKILL_MD);
    skillMdContent = skillMdBuf.toString('utf8');
  } catch (err) {
    return {
      ok: false,
      errorCode: 'EXTRACT_FAILED',
      message: `读取 SKILL.md 失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const meta = extractSkillMetadataFromMd(skillMdContent);
  if (!meta.ok) return meta;

  return {
    ok: true,
    pkg: {
      metadata: meta.metadata,
      materialize: async (stagingDir) => {
        await fs.promises.mkdir(stagingDir, { recursive: true });
        let totalUncompressedBytes = 0;
        for (const entry of entries) {
          const rel = relativizeZipEntry(entry.name, packageRoot);
          if (rel == null || rel === '') continue;
          const dest = safeJoin(stagingDir, rel);
          if (!dest) {
            throw new Error(`非法 zip entry 路径：${entry.name}`);
          }
          if (entry.dir) {
            await fs.promises.mkdir(dest, { recursive: true });
            continue;
          }
          await fs.promises.mkdir(path.dirname(dest), { recursive: true });
          const remaining = MAX_SKILL_UNCOMPRESSED - totalUncompressedBytes;
          if (remaining <= 0) {
            throw new Error(`zip 解压后大小超过上限：${MAX_SKILL_UNCOMPRESSED} bytes`);
          }
          const buf = await readZipEntryLimited(entry, remaining);
          totalUncompressedBytes += buf.byteLength;
          if (totalUncompressedBytes > MAX_SKILL_UNCOMPRESSED) {
            throw new Error(`zip 解压后大小超过上限：${MAX_SKILL_UNCOMPRESSED} bytes`);
          }
          await fs.promises.writeFile(dest, buf);
        }
        // Normalize entry file name to SKILL.md when source was skill.md
        const lowerMd = path.join(stagingDir, 'skill.md');
        const canonicalMd = path.join(stagingDir, 'SKILL.md');
        if ((await pathExists(lowerMd)) && !(await pathExists(canonicalMd))) {
          await fs.promises.rename(lowerMd, canonicalMd);
        }
        if (!(await pathExists(canonicalMd))) {
          throw new Error('解压后未找到 SKILL.md');
        }
      },
    },
  };
}

function resolveFinalDir(
  name: string,
  installPath?: string,
): { finalDir: string } | { errorCode: ImportLocalErrorCode; message: string } {
  return resolveImportInstallPath(name, installPath, os.homedir());
}

async function reconcileProjectLinks(...skillPaths: string[]): Promise<string | undefined> {
  const projectWorkingDir = skillPaths
    .map((skillPath) => projectWorkingDirFromSkillPath(skillPath))
    .find((workingDir): workingDir is string => Boolean(workingDir));
  if (!projectWorkingDir || path.resolve(projectWorkingDir) === path.resolve(os.homedir())) {
    return undefined;
  }
  try {
    const linkResult = await prepareSharedProjectSkillLinks({ workingDir: projectWorkingDir });
    for (const warning of linkResult.warnings) {
      log.warn('[importLocal] shared project skill link warning:', warning);
    }
  } catch (err) {
    log.warn('[importLocal] prepare shared project skill links failed:', err);
  }
  return projectWorkingDir;
}

export async function inspectLocalSkill(params: InspectLocalParams): Promise<InspectLocalResult> {
  if (typeof params?.filePath !== 'string' || !params.filePath.trim()) {
    return { success: false, errorCode: 'INVALID_FILE', message: '缺少 filePath' };
  }
  const loaded = await loadPackageFromPath(params.filePath.trim());
  if (!loaded.ok) {
    return { success: false, errorCode: loaded.errorCode, message: loaded.message };
  }
  const { name, description, version } = loaded.pkg.metadata;
  return { success: true, name, description, version };
}

export async function importLocalSkill(params: ImportLocalParams): Promise<ImportLocalResult> {
  if (typeof params?.filePath !== 'string' || !params.filePath.trim()) {
    return { success: false, errorCode: 'INVALID_FILE', message: '缺少 filePath' };
  }

  const loaded = await loadPackageFromPath(params.filePath.trim());
  if (!loaded.ok) {
    return { success: false, errorCode: loaded.errorCode, message: loaded.message };
  }
  const { metadata, materialize } = loaded.pkg;
  const { name, description, version } = metadata;

  const resolved = resolveFinalDir(name, params.installPath);
  if ('errorCode' in resolved) {
    return { success: false, errorCode: resolved.errorCode, message: resolved.message };
  }
  const finalDir = resolved.finalDir;

  if (await pathExists(finalDir)) {
    if (!params.force) {
      return {
        success: false,
        errorCode: 'CONFLICT_USER_OWNED',
        message: `目标位置已存在 ${name}/`,
      };
    }
  }

  const releaseLock = tryAcquireSkillInstallLock(name, 'local-import');
  if (!releaseLock) {
    return { success: false, errorCode: 'BUSY', message: busyMessage(name) };
  }

  const stagingDir = path.join(path.dirname(finalDir), `.xdt-importing-${name}-${rand()}`);
  let replaceDir: string | null = null;
  let finalDirCreated = false;

  const rollback = async () => {
    if (finalDirCreated) {
      await fs.promises.rm(finalDir, { recursive: true, force: true }).catch(() => undefined);
    }
    if (replaceDir) {
      await fs.promises.rename(replaceDir, finalDir).catch(async (err) => {
        log.error('[importLocal] restore replaced dir failed:', err);
        try {
          await moveDir(replaceDir!, finalDir);
        } catch (restoreErr) {
          log.error('[importLocal] EXDEV restore failed:', restoreErr);
        }
      });
    }
    await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    try {
      await materialize(stagingDir);
    } catch (err) {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      return {
        success: false,
        errorCode: 'EXTRACT_FAILED',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    try {
      if (await pathExists(finalDir)) {
        replaceDir = path.join(path.dirname(finalDir), `.xdt-replacing-${name}-${rand()}`);
        await moveDir(finalDir, replaceDir);
        await moveDir(stagingDir, finalDir);
        finalDirCreated = true;
      } else {
        await fs.promises.mkdir(path.dirname(finalDir), { recursive: true });
        await moveDir(stagingDir, finalDir);
        finalDirCreated = true;
      }
    } catch (err) {
      await rollback();
      return {
        success: false,
        errorCode: 'WRITE_FAILED',
        message: `写入失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const folderHash = (await computeFolderHash(finalDir).catch(() => null)) ?? '';
    const nowSec = Math.floor(Date.now() / 1000);
    // 与 scanner join 一致：registry key 用 realpath，避免 symlink / 规范化差异导致
    // 详情页挂上了 registryEntry，但卸载按路径查不到 origin=imported。
    let registryPath = path.normalize(finalDir);
    try {
      registryPath = path.normalize(await fs.promises.realpath(finalDir));
    } catch {
      // keep normalized finalDir
    }
    try {
      await registryService.addInstall(name, registryPath, {
        version,
        authorId: getCurrentUserId() ?? '',
        folderHash,
        installedAt: nowSec,
        updatedAt: nowSec,
        origin: 'imported',
      });
    } catch (err) {
      log.error('[importLocal] registry.addInstall failed, rolling back:', err);
      await rollback();
      return {
        success: false,
        errorCode: 'WRITE_FAILED',
        message: `注册失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (replaceDir) {
      try {
        await movePersistentBackup(replaceDir, name);
      } catch (err) {
        log.warn(`[importLocal] persist backup failed, left at ${maskPath(replaceDir)}:`, err);
      }
      replaceDir = null;
    }

    // Global default path: Claude discovery symlink (same as market install).
    if (!params.installPath) {
      const claudeLink = path.join(os.homedir(), '.claude', 'skills', name);
      try {
        await ensureSymlinkToShared(claudeLink, finalDir);
      } catch (err) {
        log.warn('[importLocal] claude symlink failed (non-fatal):', claudeLink, err);
      }
    }

    const projectWorkingDir = await reconcileProjectLinks(finalDir);
    try {
      const ownerId = getCurrentDataOwnerId();
      const linkResult = await withSharedGlobalSkillProjectionMutation(ownerId, () =>
        prepareSharedGlobalSkillLinks({
          assertOwnerStable: () =>
            assertGhostSkillProjectionBoundaryStableForOwner(ownerId),
        }),
      );
      for (const warning of linkResult.warnings) {
        log.warn('[importLocal] shared global skill link warning:', warning);
      }
    } catch (err) {
      log.warn('[importLocal] prepare shared global skill links failed:', err);
    }

    return {
      success: true,
      name,
      description,
      version,
      absolutePath: finalDir,
      ...(projectWorkingDir ? { projectWorkingDir } : {}),
    };
  } finally {
    releaseLock();
  }
}
