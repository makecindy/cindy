import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeImage } from 'electron';

import {
  LOCAL_THEME_SUFFIX,
  type LocalThemeBrandBounds,
  type LocalThemeBrandConfig,
  type LocalThemeBrandRevisions,
  type LocalThemeDiagnostic,
  type LocalThemeWire,
  type LocalThemesResult,
} from '../../shared/local-themes';
import { findVisibleAlphaBounds } from '../../shared/imageVisibleBounds';
import type { ImageVisibleBounds } from '../../shared/imageVisibleBounds';
import { createLogger } from '../logger';

const log = createLogger('local-themes');

interface LocalThemeJson {
  id: string;
  name: string;
  type: 'light' | 'dark';
  /** 可选家族键，见 shared/local-themes.ts 的 LocalThemeWire.family。 */
  family?: string;
  colors: Record<string, string>;
  brand?: LocalThemeBrandConfig;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid '${field}': expected non-empty string.`);
  }
  return value;
}

function asOptionalPath(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseBrand(value: unknown): LocalThemeBrandConfig | undefined {
  if (!isRecord(value)) return undefined;
  const icon = asOptionalPath(value.icon);
  const logo = asOptionalPath(value.logo);
  return icon || logo
    ? { ...(icon ? { icon } : {}), ...(logo ? { logo } : {}) }
    : undefined;
}

function parseLocalThemeJson(raw: unknown): LocalThemeJson {
  if (!isRecord(raw)) {
    throw new Error('Invalid theme JSON: expected object.');
  }

  const id = asNonEmptyString(raw.id, 'id');
  const name = asNonEmptyString(raw.name, 'name');
  if (raw.type !== 'light' && raw.type !== 'dark') {
    throw new Error("Invalid 'type': expected 'light' or 'dark'.");
  }
  if (!isRecord(raw.colors)) {
    throw new Error("Invalid 'colors': expected object.");
  }

  const colors: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.colors)) {
    if (typeof value !== 'string') {
      throw new Error(`Invalid color '${key}': expected string value.`);
    }
    colors[key] = value;
  }

  const brand = parseBrand(raw.brand);
  // family 只认非空字符串;缺省/空白一律视为"不配对"(每个文件各自成家族),
  // 保持引入该字段前的行为。
  const family = typeof raw.family === 'string' && raw.family.trim().length > 0
    ? raw.family.trim()
    : undefined;
  return {
    id,
    name,
    type: raw.type,
    ...(family ? { family } : {}),
    colors,
    ...(brand ? { brand } : {}),
  };
}

const MAX_ALPHA_SCAN_PIXELS = 8_000_000;

/**
 * 读取品牌图片的文件版本与透明像素边界，只生成运行时元数据，不改写/复制原图。
 * 大图仍提供版本号，但跳过 alpha 扫描，避免同步主题 bootstrap 出现不可控主进程停顿。
 */
function inspectBrandAsset(filePath: string): InspectedBrandAsset | undefined {
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
    const image = nativeImage.createFromPath(filePath);
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
    return undefined;
  }
}

function inspectBrandAssets(theme: LocalThemeJson): {
  bounds?: LocalThemeBrandBounds;
  revisions?: LocalThemeBrandRevisions;
} {
  const iconPath = theme.brand?.icon;
  const logoPath = theme.brand?.logo;
  const icon = iconPath ? inspectBrandAsset(iconPath) : undefined;
  const logo = logoPath ? inspectBrandAsset(logoPath) : undefined;
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
  entries: Array<FileEntry | { file: string; error: string }>,
): LocalThemesResult {
  const themes: LocalThemeWire[] = [];
  const diagnostics: LocalThemeDiagnostic[] = [];
  const seenIds = new Set<string>();

  for (const entry of entries) {
    if ('error' in entry) {
      log.warn(`Failed to load local theme '${entry.file}': ${entry.error}`);
      diagnostics.push({ file: entry.file, error: entry.error });
      continue;
    }
    try {
      const parsed = parseLocalThemeJson(JSON.parse(entry.content));
      const id = `${parsed.id}${LOCAL_THEME_SUFFIX}`;
      if (seenIds.has(id)) {
        const error = `Skipped duplicate local theme '${id}' from '${entry.file}'.`;
        log.warn(error);
        diagnostics.push({ file: entry.file, error });
        continue;
      }
      seenIds.add(id);
      const { bounds: brandBounds, revisions: brandRevisions } = inspectBrandAssets(parsed);
      themes.push({
        ...parsed,
        id,
        ...(brandBounds ? { brandBounds } : {}),
        ...(brandRevisions ? { brandRevisions } : {}),
      });
    } catch (error) {
      const message = normalizeError(error);
      log.warn(`Failed to load local theme '${entry.file}': ${message}`);
      diagnostics.push({ file: entry.file, error: message });
    }
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
    const files = pickJsonFiles(await fs.promises.readdir(dir));
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
    return processEntries(entries);
  } catch (error) {
    return topLevelFailure(error);
  }
}

export function loadLocalThemesSync(): LocalThemesResult {
  try {
    const dir = getLocalThemesDir();
    fs.mkdirSync(dir, { recursive: true });
    const files = pickJsonFiles(fs.readdirSync(dir));
    const entries = files.map((file): FileEntry | { file: string; error: string } => {
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf8');
        return { file, content };
      } catch (error) {
        return { file, error: normalizeError(error) };
      }
    });
    return processEntries(entries);
  } catch (error) {
    return topLevelFailure(error);
  }
}
