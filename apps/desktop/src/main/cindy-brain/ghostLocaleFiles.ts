import fs from 'node:fs';
import path from 'node:path';

import {
  GHOST_LOCALE_MAX_BYTES,
  validateGhostManifestLocaleResource,
  type GhostManifest,
} from '../../shared/ghost.js';
import { readBoundedFileNoFollowSync } from '../utils/readBoundedFile.js';

export type GhostLocaleDirectoryValidation = { ok: true } | { ok: false; reason: string };

/**
 * Resolve a manifest path one segment at a time so case-insensitive filesystems
 * cannot hide a casing mismatch that would later produce a different ZIP entry.
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
    if (isLast ? !exact.isFile() : !exact.isDirectory()) {
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
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(rootDir);
  } catch (error) {
    return {
      ok: false,
      reason: `locale 根目录不可用:${error instanceof Error ? error.message : String(error)}`,
    };
  }
  for (const [locale, relativePath] of Object.entries(manifest.locales)) {
    try {
      const absolutePath = resolveExactFile(rootDir, relativePath);
      // 单句柄限量闸(同步变体):statSync 后再 readFileSync 是两次独立打开,
      // 并发方可在其间把文件换成超大文件或符号链接绕过大小闸;containWithin
      // 复核堵中间目录被换成根外链接的窗口。
      const bytes = readBoundedFileNoFollowSync(absolutePath, GHOST_LOCALE_MAX_BYTES, {
        containWithin: realRoot,
      });
      if (bytes === null) {
        return {
          ok: false,
          reason: `locales.${locale} 不是普通文件或超过 ${GHOST_LOCALE_MAX_BYTES} 字节上限(${relativePath})`,
        };
      }
      const raw = JSON.parse(bytes.toString('utf8')) as unknown;
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
