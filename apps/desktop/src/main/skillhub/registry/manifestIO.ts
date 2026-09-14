/**
 * manifestIO.ts — 纯文件 IO，不感知业务语义。
 * 所有错误统一包装为 RegistryError，上层调用方决定是否吞掉。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { RegistryError, type StoredManifest } from './types.js';
import { sanitizeSkillName } from './derivations.js';

import { createLogger, maskPath } from '../../logger';

const log = createLogger('manifestIO');

export function manifestsRoot(): string {
  return path.join(app.getPath('userData'), 'skillhub', 'manifests');
}

export function manifestPath(skillName: string): string {
  const safe = sanitizeSkillName(skillName);
  return path.join(manifestsRoot(), `${safe}.json`);
}

export async function ensureRoot(): Promise<void> {
  await fs.promises.mkdir(manifestsRoot(), { recursive: true });
}

export async function readFile(skillName: string): Promise<StoredManifest | null> {
  const filePath = manifestPath(skillName);
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    let parsed: StoredManifest;
    try {
      parsed = JSON.parse(raw) as StoredManifest;
    } catch {
      log.warn(`JSON 损坏，跳过: ${maskPath(filePath)}`);
      return null;
    }
    if (parsed.skillName !== skillName) {
      throw new RegistryError(
        'REGISTRY_CORRUPTED',
        `manifest 文件 skillName 字段 "${parsed.skillName}" 与传入参数 "${skillName}" 不符`,
      );
    }
    return parsed;
  } catch (err) {
    if (err instanceof RegistryError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new RegistryError('REGISTRY_IO_FAILED', `读取 ${filePath} 失败: ${String(err)}`, err);
  }
}

export async function writeFileAtomic(skillName: string, manifest: StoredManifest): Promise<void> {
  await ensureRoot();
  const dest = manifestPath(skillName);
  const tmp = `${dest}.tmp.${crypto.randomBytes(4).toString('hex')}`;
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf-8');
    await fs.promises.rename(tmp, dest);
  } catch (err) {
    // 清理临时文件（忽略失败）
    await fs.promises.unlink(tmp).catch(() => {});
    throw new RegistryError('REGISTRY_IO_FAILED', `写入 ${dest} 失败: ${String(err)}`, err);
  }
}

export async function unlinkFile(skillName: string): Promise<void> {
  const filePath = manifestPath(skillName);
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return; // 不存在 → no-op
    throw new RegistryError('REGISTRY_IO_FAILED', `删除 ${filePath} 失败: ${String(err)}`, err);
  }
}

export async function listAllFiles(): Promise<Array<{ skillName: string; manifest: StoredManifest }>> {
  const root = manifestsRoot();
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return []; // 目录还没创建过
    throw new RegistryError('REGISTRY_IO_FAILED', `读取 manifests 目录失败: ${String(err)}`, err);
  }

  const results = await Promise.all(
    entries
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map(async (e) => {
        const skillName = e.name.slice(0, -'.json'.length);
        // 文件名不通过 sanitizeSkillName → 跳过 + 记日志
        try {
          sanitizeSkillName(skillName);
        } catch {
          log.warn(`非法文件名，跳过: ${e.name}`);
          return null;
        }
        try {
          const manifest = await readFile(skillName);
          if (!manifest) return null;
          return { skillName, manifest };
        } catch (err) {
          log.warn(`读取 ${e.name} 失败，跳过:`, err);
          return null;
        }
      }),
  );

  return results.filter((r): r is { skillName: string; manifest: StoredManifest } => r !== null);
}
