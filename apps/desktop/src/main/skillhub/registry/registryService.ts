/**
 * registryService.ts — 组合 IO + lock，对外暴露语义化 API。
 * 写操作和会恢复主 registry 的读操作走 per-skillName 串行队列。
 */
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { RegistryError, type StoredInstall, type StoredManifest } from './types.js';
import * as manifestIO from './manifestIO.js';
import { sanitizeSkillName } from './derivations.js';
import { withLock } from './lock.js';
import { migrateStoredManifest } from './migrations.js';

import { createLogger } from '../../logger';

const log = createLogger('registryService');

function backupRoot(): string {
  return path.join(app.getPath('userData'), 'skillhub', 'manifests-backup');
}

function backupPath(skillName: string): string {
  return path.join(backupRoot(), `${sanitizeSkillName(skillName)}.json`);
}

async function writeManifestWithBackup(skillName: string, manifest: StoredManifest): Promise<void> {
  await manifestIO.writeFileAtomic(skillName, manifest);
  try {
    await fs.promises.mkdir(backupRoot(), { recursive: true });
    await fs.promises.writeFile(backupPath(skillName), JSON.stringify(manifest, null, 2), 'utf-8');
  } catch (err) {
    // backup 只用于短期降级兼容，不能因为兜底保护失败影响正常安装/发布流程。
    log.warn(`write registry backup failed for ${skillName}:`, err);
  }
}

async function unlinkManifestWithBackup(skillName: string): Promise<void> {
  await manifestIO.unlinkFile(skillName);
  try {
    await fs.promises.unlink(backupPath(skillName));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') log.warn(`delete registry backup failed for ${skillName}:`, err);
  }
}

async function readBackupManifest(skillName: string): Promise<StoredManifest | null> {
  try {
    const raw = await fs.promises.readFile(backupPath(skillName), 'utf-8');
    const parsed = JSON.parse(raw) as StoredManifest;
    if (parsed.skillName !== skillName) {
      log.warn(`backup manifest skillName mismatch for ${skillName}`);
      return null;
    }
    return migrateStoredManifest(parsed).manifest;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') log.warn(`read registry backup failed for ${skillName}:`, err);
    return null;
  }
}

async function hasLiveInstallPath(manifest: StoredManifest): Promise<boolean> {
  for (const installPath of Object.keys(manifest.installs)) {
    try {
      await fs.promises.access(installPath);
      return true;
    } catch {
      // continue
    }
  }
  return false;
}

async function listBackupSkillNames(): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(backupRoot(), { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') log.warn('list registry backup failed:', err);
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const skillName = entry.name.slice(0, -'.json'.length);
    try {
      names.push(sanitizeSkillName(skillName));
    } catch {
      log.warn(`非法 backup 文件名，跳过: ${entry.name}`);
    }
  }
  return names;
}

async function readManifestWithBackup(skillName: string): Promise<StoredManifest | null> {
  const manifest = await manifestIO.readFile(skillName);
  if (manifest) {
    const migrated = migrateStoredManifest(manifest);
    if (migrated.changed) await writeManifestWithBackup(skillName, migrated.manifest);
    return migrated.manifest;
  }

  // 短期兼容：用户可能降级到旧版后再升回新版。旧版 orphan cleanup 在
  // ~/.agents 实体目录 + ~/.claude symlink 场景下可能误删主 registry 文件。
  // backup 不被旧版识别；新版读到主文件缺失时恢复它，避免 SkillHub 安装记录永久丢失。
  const backup = await readBackupManifest(skillName);
  if (!backup) return null;
  if (!(await hasLiveInstallPath(backup))) return null;
  await writeManifestWithBackup(skillName, backup);
  return backup;
}

/**
 * 新增或覆盖一条 install 记录。
 * 文件不存在 → 自动新建 + 写 schemaVersion + skillName 自校验字段
 * 同 (skillName, installPath) 已存在 → 覆盖该条目
 * 文件存在但 skillName 字段不一致 → 抛 RegistryError('REGISTRY_CORRUPTED')
 */
export async function addInstall(
  skillName: string,
  installPath: string,
  entry: StoredInstall,
): Promise<void> {
  const normalizedPath = path.normalize(installPath);

  await withLock(skillName, async () => {
    const existing = await readManifestWithBackup(skillName);
    let manifest: StoredManifest;
    if (!existing) {
      manifest = {
        schemaVersion: 1,
        skillName,
        installs: { [normalizedPath]: { ...entry, catalogScopeMigrated: true } },
      };
    } else {
      manifest = {
        ...existing,
        installs: {
          ...existing.installs,
          [normalizedPath]: { ...entry, catalogScopeMigrated: true },
        },
      };
    }
    await writeManifestWithBackup(skillName, manifest);
  });
}

/**
 * 部分更新一条 install 记录（只更新指定字段）。
 * installPath 不存在 → 抛 RegistryError('REGISTRY_IO_FAILED', 'install entry not found')
 */
export async function updateInstall(
  skillName: string,
  installPath: string,
  partial: Partial<Pick<StoredInstall, 'version' | 'folderHash' | 'updatedAt' | 'authorId' | 'origin' | 'autoSynced' | 'catalogScope'>>,
): Promise<void> {
  const normalizedPath = path.normalize(installPath);

  await withLock(skillName, async () => {
    const existing = await readManifestWithBackup(skillName);
    if (!existing || !existing.installs[normalizedPath]) {
      throw new RegistryError(
        'REGISTRY_IO_FAILED',
        `install entry not found: ${skillName} @ ${normalizedPath}`,
      );
    }
    const updated: StoredManifest = {
      ...existing,
      installs: {
        ...existing.installs,
        [normalizedPath]: { ...existing.installs[normalizedPath], ...partial },
      },
    };
    await writeManifestWithBackup(skillName, updated);
  });
}

/**
 * 删除一条 install 记录。
 * 如果是该 skill 最后一条 install → 整个文件 unlink
 * 不存在的 (name, path) → no-op，不抛错
 */
export async function removeInstall(skillName: string, installPath: string): Promise<void> {
  const normalizedPath = path.normalize(installPath);

  await withLock(skillName, async () => {
    const existing = await readManifestWithBackup(skillName);
    if (!existing || !existing.installs[normalizedPath]) {
      return; // no-op
    }

    const installs = { ...existing.installs };
    delete installs[normalizedPath];

    if (Object.keys(installs).length === 0) {
      // 最后一条 → 删整个文件
      await unlinkManifestWithBackup(skillName);
    } else {
      await writeManifestWithBackup(skillName, { ...existing, installs });
    }
  });
}

/**
 * 读取整个 manifest。
 * 文件不存在返 null。JSON 损坏 → 返 null + console.warn（降级，不抛）
 */
export async function readManifest(skillName: string): Promise<StoredManifest | null> {
  try {
    return await withLock(skillName, () => readManifestWithBackup(skillName));
  } catch (err) {
    if (err instanceof RegistryError && err.code === 'REGISTRY_IO_FAILED') {
      log.warn('readManifest IO error:', err);
      return null;
    }
    throw err;
  }
}

/**
 * 便利方法：readManifest + 取 installs[normalize(installPath)]
 */
export async function getInstall(
  skillName: string,
  installPath: string,
): Promise<StoredInstall | null> {
  const manifest = await readManifest(skillName);
  if (!manifest) return null;
  const normalizedPath = path.normalize(installPath);
  return manifest.installs[normalizedPath] ?? null;
}

/**
 * 一次性扫描 manifests/ 目录，展平所有 install 记录。
 * 单文件 JSON 损坏 → 跳过 + 记日志，不影响其他文件读取
 */
export async function listAllInstalls(): Promise<
  Array<{ skillName: string; installPath: string; entry: StoredInstall }>
> {
  const filesByName = new Map<string, StoredManifest>();
  for (const { skillName } of await manifestIO.listAllFiles()) {
    const manifest = await withLock(skillName, () => readManifestWithBackup(skillName)).catch((err) => {
      log.warn(`read registry manifest failed for ${skillName}:`, err);
      return null;
    });
    if (manifest) filesByName.set(skillName, manifest);
  }
  for (const skillName of await listBackupSkillNames()) {
    if (filesByName.has(skillName)) continue;
    const restored = await withLock(skillName, () => readManifestWithBackup(skillName)).catch((err) => {
      log.warn(`restore registry from backup failed for ${skillName}:`, err);
      return null;
    });
    if (restored) filesByName.set(skillName, restored);
  }
  const result: Array<{ skillName: string; installPath: string; entry: StoredInstall }> = [];
  for (const [skillName, manifest] of filesByName) {
    for (const [installPath, entry] of Object.entries(manifest.installs)) {
      result.push({ skillName, installPath, entry });
    }
  }
  return result;
}

/** Re-point installs from one catalog after the server moves that record. */
export async function updateCatalogScopeForSkill(
  skillName: string,
  catalogScope: StoredInstall['catalogScope'],
  previousCatalogScope: StoredInstall['catalogScope'],
): Promise<void> {
  await withLock(skillName, async () => {
    const existing = await readManifestWithBackup(skillName);
    if (!existing) return;
    const updatedAt = Math.floor(Date.now() / 1000);
    let changed = false;
    const installs = Object.fromEntries(Object.entries(existing.installs).map(([installPath, entry]) => {
      if (entry.catalogScope !== previousCatalogScope) return [installPath, entry];
      changed = true;
      return [installPath, { ...entry, catalogScope, updatedAt }];
    }));
    if (changed) await writeManifestWithBackup(skillName, { ...existing, installs });
  });
}
