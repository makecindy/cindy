import fs from 'node:fs';
import path from 'node:path';

import {
  GHOST_LOCALE_MAX_BYTES,
  validateGhostManifestLocaleResource,
  type GhostManifest,
} from '../../shared/ghost.js';
import { classifyGhostDirEntrySync } from './ghostContentTree.js';

export type GhostLocaleDirectoryValidation = { ok: true } | { ok: false; reason: string };

/**
 * Resolve a manifest path one segment at a time so case-insensitive filesystems
 * cannot hide a casing mismatch that would later produce a different ZIP entry.
 *
 * 遍历留在本地(它要报"磁盘实际大小写"这种只有这里需要的诊断),但**条目类型判定
 * 走 ghostContentTree**:链接一律不算目录/文件,与技能指纹、快照拷贝、打包收集同
 * 一份判据,不再各自信 Dirent 的类型位。
 */
function resolveExactFile(rootDir: string, relativePath: string): string {
  const segments = relativePath.split('/');
  let current = rootDir;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const entries = fs.readdirSync(current, { withFileTypes: true });
    const exact = entries.find((entry) => entry.name === segment);
    if (!exact) {
      const caseInsensitive = entries.find(
        (entry) => entry.name.toLowerCase() === segment.toLowerCase(),
      );
      if (caseInsensitive) {
        throw new Error(
          `路径大小写不一致：manifest 声明 ${JSON.stringify(segment)}，磁盘实际为 ${JSON.stringify(caseInsensitive.name)}`,
        );
      }
      throw new Error(`路径不存在：${relativePath}`);
    }
    const isLast = index === segments.length - 1;
    const kind = classifyGhostDirEntrySync(path.join(current, exact.name));
    if (kind !== (isLast ? 'file' : 'directory')) {
      throw new Error(`路径不是${isLast ? '文件' : '目录'}：${relativePath}`);
    }
    current = path.join(current, exact.name);
  }
  return current;
}

/** Forge 与内置播种共用的目录 locale 校验。 */
export function validateGhostLocaleResourcesInDirectory(
  rootDir: string,
  manifest: GhostManifest,
): GhostLocaleDirectoryValidation {
  if (!manifest.locales) return { ok: true };
  for (const [locale, relativePath] of Object.entries(manifest.locales)) {
    try {
      const absolutePath = resolveExactFile(rootDir, relativePath);
      const stat = fs.statSync(absolutePath);
      if (stat.size > GHOST_LOCALE_MAX_BYTES) {
        return {
          ok: false,
          reason: `locales.${locale} 超过 ${GHOST_LOCALE_MAX_BYTES} 字节上限(${relativePath})`,
        };
      }
      const raw = JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as unknown;
      const localized = validateGhostManifestLocaleResource(raw, manifest);
      if (!localized.ok) {
        return {
          ok: false,
          reason: `locales.${locale} 不合格(${relativePath}):${localized.reason}`,
        };
      }
    } catch (error) {
      return {
        ok: false,
        reason: `locales.${locale} 不可用(${relativePath}):${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return { ok: true };
}
