/**
 * 外部主题导入（VSCode `*.json` / Obsidian `theme.css`）→ 本地主题 JSON。
 *
 * 这里只做 IO 与编排：弹原生文件对话框、读字节、调 `shared/theme-import` 的纯
 * 函数转换、复用 `writeLocalTheme()` 落盘。转换规则本身见
 * `shared/theme-import/palette.ts`。
 *
 * 安全边界：**对话框由 main 自己弹、文件由 main 自己读**，Renderer 全程拿不到
 * 也传不进任何路径（`docs/dev-rules/electron-security-and-process-boundaries.md`
 * §5：不把「Renderer 传来一个绝对路径」视为授权）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { dialog, type BrowserWindow } from 'electron';

import { isLocalThemeId, LOCAL_THEME_SUFFIX } from '../../shared/local-themes';
import {
  convertObsidianTheme,
  convertVsCodeTheme,
  detectImportSource,
  themeFamilyId,
  UnsupportedThemePaletteError,
} from '../../shared/theme-import';
import type {
  ConvertedTheme,
  ImportedThemeFile,
  ImportedThemeFileInternal,
  LocalThemeImportResult,
  ThemeConversionResult,
} from '../../shared/theme-import/types';
import { createLogger } from '../logger';
import { throwIpcError } from '../utils/ipcValidate';
import { loadLocalThemesSync } from './loader';
import { writeLocalTheme } from './writer';

const log = createLogger('local-themes/importer');

/**
 * 单文件字节上限。Obsidian 主题 CSS 动辄上百 KB（Minimal 一类含大量选择器），
 * 4MB 足够宽松，同时挡住"选错文件把整个日志/数据库读进内存"。
 */
const MAX_THEME_FILE_BYTES = 4 * 1024 * 1024;

const FAMILY_SUFFIX_LIMIT = 99;

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 已被占用的家族键，**含隐式的「每文件自成家族」那一类**。
 *
 * renderer 侧 `buildLocalFamilies()` 的分组键是 `family ?? theme.id`（都带
 * `-local` 后缀）。所以判重必须把两类都算进来：只收显式 `family` 的话，用户已有
 * 一个 id 为 `minimal` 的旧本地主题时，导入同名双态主题会拿到 family `minimal`
 * → 分组键 `minimal-local` 与旧主题撞车 → 同类型变体只保留先加载的那个，新导入
 * 的方案在「导入成功」提示之后仍然看不见。
 */
function usedFamilyKeys(): Set<string> {
  const used = new Set<string>();
  const payload = loadLocalThemesSync();
  if (!payload.success) return used;
  for (const theme of payload.themes) {
    // 每个主题的 normalized ID 都要保留：即使有 explicit family，其 ID 被复用
    // 仍会导致 writeLocalTheme 的文件名冲突或 loader 的 ID 去重丢弃后者。
    const normalizedId = isLocalThemeId(theme.id)
      ? theme.id.slice(0, -LOCAL_THEME_SUFFIX.length)
      : theme.id;
    used.add(normalizedId);
    // If the ID looks like `<slug>-light` or `<slug>-dark`, also reserve the
    // base slug so paired imports don't generate colliding variant IDs.
    const variantMatch = normalizedId.match(/^(.+)-(light|dark)$/);
    if (variantMatch) used.add(variantMatch[1]);
    if (theme.family) {
      used.add(theme.family);
    }
  }
  return used;
}

/**
 * 挑一个未占用的家族键。重复导入同一个主题时会拿到 `minimal` / `minimal-2`，
 * 两组产物各自成家族、都能在设置里看到。
 */
function pickFamilyId(slug: string, used: Set<string>): string {
  for (let i = 1; i <= FAMILY_SUFFIX_LIMIT; i += 1) {
    const candidate = i === 1 ? slug : `${slug}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${slug}-${Date.now()}`;
}

/** Obsidian 主题目录里的 manifest.json 带更规范的展示名。 */
function readObsidianManifestName(filePath: string): string | null {
  try {
    const manifestPath = path.join(path.dirname(filePath), 'manifest.json');
    // 先 stat 再读：避免巨大文件、特殊设备文件阻塞主进程。
    const stat = fs.statSync(manifestPath);
    if (!stat.isFile() || stat.size > MAX_THEME_FILE_BYTES) return null;
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const name = (parsed as { name?: unknown }).name;
      if (typeof name === 'string' && name.trim().length > 0) return name.trim();
    }
  } catch {
    // 没有 manifest 或格式不对都无所谓——回退到目录/文件名。
  }
  return null;
}

/** 源文件没有可用名字时的兜底展示名。 */
function fallbackNameFor(filePath: string, source: 'vscode' | 'obsidian'): string {
  const base = path.basename(filePath, path.extname(filePath));
  if (source === 'obsidian' && /^theme(\.dark|\.light)?$/i.test(base)) {
    // `<vault>/.obsidian/themes/<主题名>/theme.css` —— 目录名才是主题名。
    const dirName = path.basename(path.dirname(filePath));
    if (dirName && dirName !== '.' && dirName.toLowerCase() !== 'themes') return dirName;
  }
  return base;
}

function convert(filePath: string, content: string): ThemeConversionResult | null {
  const source = detectImportSource(filePath);
  if (source === null) return null;
  if (source === 'vscode') {
    return convertVsCodeTheme(content, fallbackNameFor(filePath, 'vscode'));
  }
  const name = readObsidianManifestName(filePath) ?? fallbackNameFor(filePath, 'obsidian');
  return convertObsidianTheme(content, name);
}

/**
 * 回滚已落盘的产物。双态导入写到一半失败时必须清干净:否则 UI 报「导入失败」而
 * 目录里留着一个孤立的单态主题,刷新后它会冒出来,用户重试又生成一份,越攒越乱。
 * best-effort——删不掉只 warn,不把回滚失败盖掉原始错误。
 */
async function rollbackWritten(written: ImportedThemeFileInternal[]): Promise<void> {
  for (const item of written) {
    try {
      await fs.promises.unlink(item.path);
    } catch (error) {
      log.warn(`Failed to roll back '${item.path}': ${normalizeError(error)}`);
    }
  }
}

const MAX_DISPLAY_NAME_LENGTH = 100;

function boundDisplayName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= MAX_DISPLAY_NAME_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_DISPLAY_NAME_LENGTH).trimEnd()}…`;
}

async function writeConverted(
  themes: ConvertedTheme[],
): Promise<{ written: ImportedThemeFileInternal[]; error?: string }> {
  const pair = themes.length > 1;
  const used = usedFamilyKeys();
  const familyKey = pickFamilyId(themeFamilyId(themes[0].name), used);
  // For paired imports, also reserve the generated variant IDs.
  if (pair) {
    used.add(familyKey);
    used.add(`${familyKey}-light`);
    used.add(`${familyKey}-dark`);
  }
  const written: ImportedThemeFileInternal[] = [];
  for (const theme of themes) {
    const baseId = pair ? `${familyKey}-${theme.type}` : familyKey;
    const displayName = boundDisplayName(theme.name);
    const result = await writeLocalTheme({
      baseId,
      theme: {
        id: baseId,
        name: displayName,
        type: theme.type,
        ...(pair ? { family: familyKey } : {}),
        colors: theme.colors,
      },
    });
    if (!result.success) {
      await rollbackWritten(written);
      return { written: [], error: result.error };
    }
    written.push({
      path: result.path,
      id: result.finalId,
      name: displayName,
      type: theme.type,
    });
  }
  return { written };
}

export interface ImportThemeDeps {
  /** 对话框的父窗口；拿不到时无模态弹出。 */
  parentWindow?: BrowserWindow | null;
}

/**
 * 走完「选文件 → 转换 → 落盘」。返回结构里如实带上转换报告，让 UI 能告诉用户
 * 哪些东西没跟过来。任何一步失败都返回 `success: false` 而不抛。
 */
export async function importExternalTheme(
  deps: ImportThemeDeps = {},
): Promise<LocalThemeImportResult> {
  try {
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      filters: [
        { name: 'Theme (*.json, *.jsonc, *.css)', extensions: ['json', 'jsonc', 'css'] },
        { name: 'VSCode (*.json, *.jsonc)', extensions: ['json', 'jsonc'] },
        { name: 'Obsidian (*.css)', extensions: ['css'] },
      ],
    };
    const picked = deps.parentWindow
      ? await dialog.showOpenDialog(deps.parentWindow, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) {
      return { canceled: true };
    }
    const filePath = picked.filePaths[0];

    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      throwIpcError('THEME_NOT_A_FILE', 'selected path is not a regular file');
    }
    if (stat.size > MAX_THEME_FILE_BYTES) {
      throwIpcError('THEME_FILE_TOO_LARGE', `file exceeds ${MAX_THEME_FILE_BYTES} bytes`);
    }
    const content = await fs.promises.readFile(filePath, 'utf8');

    const converted = convert(filePath, content);
    if (!converted) {
      throwIpcError('THEME_UNSUPPORTED_FILE', 'file is not a recognized VSCode or Obsidian theme');
    }
    if (converted.themes.length === 0) {
      const hasInclude = converted.report.unresolved.some((u) => u.startsWith('include:'));
      if (hasInclude) {
        throwIpcError('THEME_USES_INCLUDE', 'theme uses include and cannot be fully parsed standalone');
      }
      throwIpcError('THEME_UNSUPPORTED_FILE', 'no usable color palette could be extracted');
    }

    const { written, error } = await writeConverted(converted.themes);
    if (error) {
      log.warn(`Failed to write imported theme: ${error}`);
      throwIpcError('THEME_WRITE_ERROR', 'failed to persist theme file');
    }
    log.info(
      `Imported ${written.length} theme(s) from ${converted.report.source}: `
      + written.map((w) => w.id).join(', '),
    );
    const safeWritten: ImportedThemeFile[] = written.map(({ id, name, type }) => ({ id, name, type }));
    return {
      canceled: false,
      written: safeWritten,
      report: converted.report,
    };
  } catch (error) {
    // Re-throw IPC errors from throwIpcError() (already typed and safe for renderer).
    if (error instanceof Error && 'code' in error) throw error;
    if (error instanceof UnsupportedThemePaletteError) {
      log.warn(`Unsupported theme palette: ${error.message}`);
      throwIpcError(
        'THEME_CONTRAST_UNSUPPORTED',
        'theme colors cannot produce a visible unchecked Switch state',
      );
    }
    const message = normalizeError(error);
    log.warn(`Theme import failed: ${message}`);
    throwIpcError('THEME_IMPORT_INTERNAL', 'unexpected error during theme import');
  }
}
