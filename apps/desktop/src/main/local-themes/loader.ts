import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeImage } from 'electron';

import {
  LOCAL_THEME_SUFFIX,
  parseLocalThemeDocument,
  type LocalThemeDocument,
  type LocalThemeBrandBounds,
  type LocalThemeBrandRevisions,
  type LocalThemeDiagnostic,
  type LocalThemeWire,
  type LocalThemesResult,
} from '../../shared/local-themes';
import { findVisibleAlphaBounds } from '../../shared/imageVisibleBounds';
import type { ImageVisibleBounds } from '../../shared/imageVisibleBounds';
import { createLogger } from '../logger';
import { lastGoodOmarchyTheme, OMARCHY_THEME_FILE, readOmarchyTheme } from './omarchy';
import { readPackagedThemesSync, THEME_BRAND_MAX_BYTES, THEME_BRAND_MAX_PIXELS, type PackagedThemeEntry } from './packages';
import { readBoundedFileNoFollowSync } from '../utils/readBoundedFile';

const log = createLogger('local-themes');

interface FileEntry {
  file: string;
  content: string;
}

export function getLocalThemesDir(): string {
  // 所有消费方（loader / writer / open-dir IPC）都经这里拿路径，先确保一次性搬迁完成。
  migrateLegacyThemesDirOnce();
  return path.join(os.homedir(), '.cindy', 'themes');
}

/** 品牌迁移前的旧主题目录（2026-07-20 起硬切为 ~/.cindy/themes），仅用于一次性搬迁。 */
function getLegacyLocalThemesDir(): string {
  return path.join(os.homedir(), '.xdmaker', 'themes');
}

let themesMigrationDone = false;
const visibleBoundsCache = new Map<
  string,
  { size: number; mtimeMs: number; bounds: ImageVisibleBounds | undefined }
>();

interface InspectedBrandAsset {
  revision: string;
  bounds?: ImageVisibleBounds;
}

/** 仅供测试：清掉进程内"已搬迁"标记。 */
export function resetLocalThemesMigrationForTest(): void {
  themesMigrationDone = false;
  visibleBoundsCache.clear();
}

/**
 * 一次性把 ~/.xdmaker/themes 搬到 ~/.cindy/themes（老在新不在 → rename）。
 * 同步实现：loadLocalThemesSync 在 renderer 启动的同步 IPC 里跑，搬迁必须
 * 发生在它第一次扫描目录之前。幂等（进程内只跑一次），失败仅 warn 不阻断——
 * 后续按新目录为空的语义继续。搬空后的 ~/.xdmaker 空壳顺手删掉（失败忽略）。
 */
function migrateLegacyThemesDirOnce(): void {
  if (themesMigrationDone) return;
  themesMigrationDone = true;
  const oldDir = getLegacyLocalThemesDir();
  // 不走 getLocalThemesDir()（它会回调本函数），直接拼新路径。
  const newDir = path.join(os.homedir(), '.cindy', 'themes');
  try {
    if (!fs.existsSync(oldDir) || !fs.statSync(oldDir).isDirectory()) return;
    if (fs.existsSync(newDir)) return;
    fs.mkdirSync(path.dirname(newDir), { recursive: true });
    fs.renameSync(oldDir, newDir);
    log.info(`Migrated local themes dir from '${oldDir}' to '${newDir}'.`);
    try {
      fs.rmdirSync(path.dirname(oldDir));
    } catch {
      // 旧 ~/.xdmaker 非空（还有别的东西）或删除失败：保留即可。
    }
  } catch (error) {
    log.warn(`Failed to migrate legacy local themes dir: ${normalizeError(error)}`);
  }
}


const MAX_ALPHA_SCAN_PIXELS = THEME_BRAND_MAX_PIXELS;

/**
 * 读取品牌图片的文件版本与透明像素边界，只生成运行时元数据，不改写/复制原图。
 * 大图仍提供版本号，但跳过 alpha 扫描，避免同步主题 bootstrap 出现不可控主进程停顿。
 */
function inspectBrandAsset(filePath: string, assetRoot?: string): InspectedBrandAsset | undefined {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return undefined;
    const revision = `${stat.size}:${stat.mtimeMs}`;
    const cached = visibleBoundsCache.get(filePath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return {
        revision,
        ...(cached.bounds ? { bounds: cached.bounds } : {}),
      };
    }
    if (assetRoot && stat.size > THEME_BRAND_MAX_BYTES) {
      visibleBoundsCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, bounds: undefined });
      return { revision };
    }
    const bytes = assetRoot ? readBoundedFileNoFollowSync(filePath, THEME_BRAND_MAX_BYTES, { containWithin: assetRoot }) : undefined;
    if (assetRoot && !bytes) return { revision };
    const image = bytes ? nativeImage.createFromBuffer(bytes) : nativeImage.createFromPath(filePath);
    if (image.isEmpty()) {
      visibleBoundsCache.set(filePath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        bounds: undefined,
      });
      return { revision };
    }
    const { width, height } = image.getSize();
    if (width <= 0 || height <= 0 || width * height > MAX_ALPHA_SCAN_PIXELS) {
      visibleBoundsCache.set(filePath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        bounds: undefined,
      });
      return { revision };
    }
    const bitmap = image.toBitmap({ scaleFactor: 1 });
    const bounds = findVisibleAlphaBounds(bitmap, width, height);
    visibleBoundsCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, bounds });
    return { revision, ...(bounds ? { bounds } : {}) };
  } catch {
    visibleBoundsCache.delete(filePath);
    return undefined;
  }
}

function inspectBrandAssets(theme: LocalThemeDocument, assetRoot?: string): {
  bounds?: LocalThemeBrandBounds;
  revisions?: LocalThemeBrandRevisions;
} {
  const iconPath = theme.brand?.icon;
  const logoPath = theme.brand?.logo;
  const icon = iconPath ? inspectBrandAsset(iconPath, assetRoot) : undefined;
  const logo = logoPath ? inspectBrandAsset(logoPath, assetRoot) : undefined;
  const bounds = icon?.bounds || logo?.bounds
    ? {
        ...(icon?.bounds ? { icon: icon.bounds } : {}),
        ...(logo?.bounds ? { logo: logo.bounds } : {}),
      }
    : undefined;
  const revisions = icon || logo
    ? {
        ...(icon ? { icon: icon.revision } : {}),
        ...(logo ? { logo: logo.revision } : {}),
      }
    : undefined;
  return {
    ...(bounds ? { bounds } : {}),
    ...(revisions ? { revisions } : {}),
  };
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function processEntries(
  entries: Array<FileEntry | PackagedThemeEntry>,
): LocalThemesResult {
  const themes: LocalThemeWire[] = [];
  const diagnostics: LocalThemeDiagnostic[] = [];
  const seenIds = new Set<string>();
  const activeBrandAssets = new Set<string>();
  const packageIds = new Set(entries.flatMap(entry => 'theme' in entry ? [`${entry.theme.id}${LOCAL_THEME_SUFFIX}`] : []));

  for (const entry of entries) {
    if ('error' in entry) {
      log.warn(`Failed to load local theme '${entry.file}': ${entry.error}`);
      diagnostics.push({ file: entry.file, error: entry.error });
      continue;
    }
    try {
      const parsed = 'theme' in entry ? entry.theme : parseLocalThemeDocument(JSON.parse(entry.content));
      const id = `${parsed.id}${LOCAL_THEME_SUFFIX}`;
      if (seenIds.has(id)) {
        // A package deliberately updates the effective value of a matching loose theme.
        if (!('theme' in entry) && packageIds.has(id)) continue;
        const error = `Skipped duplicate local theme '${id}' from '${entry.file}'.`;
        log.warn(error);
        diagnostics.push({ file: entry.file, error });
        continue;
      }
      seenIds.add(id);
      for (const file of Object.values(parsed.brand ?? {})) activeBrandAssets.add(file);
      const { bounds: brandBounds, revisions: brandRevisions } = inspectBrandAssets(parsed, 'theme' in entry ? entry.assetRoot : undefined);
      themes.push({
        ...parsed,
        id,
        ...('theme' in entry ? { packageSha256: entry.packageSha256 } : {}),
        ...(brandBounds ? { brandBounds } : {}),
        ...(brandRevisions ? { brandRevisions } : {}),
      });
    } catch (error) {
      const message = normalizeError(error);
      log.warn(`Failed to load local theme '${entry.file}': ${message}`);
      diagnostics.push({ file: entry.file, error: message });
    }
  }

  for (const file of visibleBoundsCache.keys()) if (!activeBrandAssets.has(file)) visibleBoundsCache.delete(file);

  try {
    const omarchy = readOmarchyTheme();
    if (omarchy) themes.push(omarchy);
  } catch (error) {
    log.warn(`Failed to load Omarchy theme: ${normalizeError(error)}`);
    diagnostics.push({
      file: OMARCHY_THEME_FILE,
      error: (error as NodeJS.ErrnoException).code ?? normalizeError(error),
    });
    const lastGood = lastGoodOmarchyTheme();
    if (lastGood) themes.push(lastGood);
  }

  return { success: true, themes, diagnostics };
}

function pickJsonFiles(entries: string[]): string[] {
  return entries
    .filter((entry) => entry.toLowerCase().endsWith('.json'))
    .sort((a, b) => a.localeCompare(b));
}

function topLevelFailure(error: unknown): LocalThemesResult {
  const message = normalizeError(error);
  log.warn(`Failed to scan local themes: ${message}`);
  return { success: false, error: message, themes: [], diagnostics: [] };
}

export async function loadLocalThemes(): Promise<LocalThemesResult> {
  try {
    const dir = getLocalThemesDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const names = await fs.promises.readdir(dir);
    const files = pickJsonFiles(names);
    const entries = await Promise.all(
      files.map(async (file): Promise<FileEntry | { file: string; error: string }> => {
        try {
          const content = await fs.promises.readFile(path.join(dir, file), 'utf8');
          return { file, content };
        } catch (error) {
          return { file, error: normalizeError(error) };
        }
      }),
    );
    return processEntries([...(names.includes('.packages') ? readPackagedThemesSync(dir) : []), ...entries]);
  } catch (error) {
    return topLevelFailure(error);
  }
}

export function loadLocalThemesSync(): LocalThemesResult {
  try {
    const dir = getLocalThemesDir();
    fs.mkdirSync(dir, { recursive: true });
    const names = fs.readdirSync(dir);
    const files = pickJsonFiles(names);
    const entries = files.map((file): FileEntry | { file: string; error: string } => {
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf8');
        return { file, content };
      } catch (error) {
        return { file, error: normalizeError(error) };
      }
    });
    return processEntries([...(names.includes('.packages') ? readPackagedThemesSync(dir) : []), ...entries]);
  } catch (error) {
    return topLevelFailure(error);
  }
}
