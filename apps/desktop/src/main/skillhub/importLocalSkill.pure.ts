/**
 * Pure helpers for local skill import (zip / SKILL.md inspection).
 * No fs / Electron — unit-testable without I/O.
 */

import path from 'node:path';

import matter from 'gray-matter';

import { parseAndValidateFrontmatter } from './frontmatterValidation.js';

export type ImportLocalErrorCode =
  | 'INVALID_FILE'
  | 'MISSING_SKILL_MD'
  | 'INVALID_FRONTMATTER'
  | 'INVALID_NAME'
  | 'CONFLICT_USER_OWNED'
  | 'EXTRACT_FAILED'
  | 'WRITE_FAILED'
  | 'BUSY'
  | 'INTERNAL';

export interface SkillImportMetadata {
  name: string;
  description: string;
  version: string;
}

const DEFAULT_VERSION = '0.1.0';
const SKILL_MD_NAMES = new Set(['SKILL.md', 'skill.md']);

/** Registry / folder name rule (same as sanitizeSkillName). */
export function isValidImportSkillName(name: string): boolean {
  return /^[a-z0-9-]{1,200}$/.test(name);
}

/**
 * Locate the package root inside a zip entry list.
 * Accepts SKILL.md at zip root, or under a single top-level directory.
 */
export function findZipSkillPackageRoot(
  entryNames: ReadonlyArray<string>,
): { packageRoot: string } | { error: string } {
  const skillMdPaths: string[] = [];
  for (const raw of entryNames) {
    const name = raw.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!name || name.endsWith('/')) continue;
    if (name.startsWith('__MACOSX/')) continue;
    const base = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
    if (SKILL_MD_NAMES.has(base)) {
      skillMdPaths.push(name);
    }
  }

  if (skillMdPaths.length === 0) {
    return { error: '压缩包中未找到 SKILL.md' };
  }

  const rootLevel = skillMdPaths.filter((p) => !p.includes('/'));
  if (rootLevel.length === 1 && skillMdPaths.length === 1) {
    return { packageRoot: '' };
  }
  if (rootLevel.length > 0) {
    // Root has SKILL.md; ignore nested copies only when exactly one root hit.
    if (rootLevel.length === 1) {
      return { packageRoot: '' };
    }
    return { error: '压缩包根目录存在多个 SKILL.md，无法确定技能包' };
  }

  const topDirs = new Set(skillMdPaths.map((p) => p.split('/')[0]!));
  if (topDirs.size !== 1) {
    return { error: '压缩包中存在多个技能目录，请只包含一个含 SKILL.md 的包' };
  }
  const top = [...topDirs][0]!;
  const underTop = skillMdPaths.filter((p) => p.startsWith(`${top}/`));
  const depthOne = underTop.filter((p) => p.split('/').length === 2);
  if (depthOne.length !== 1) {
    return { error: `压缩包 ${top}/ 下未找到唯一的 SKILL.md` };
  }
  return { packageRoot: `${top}/` };
}

/** Strip packageRoot prefix from a zip entry path; null if outside package. */
export function relativizeZipEntry(entryName: string, packageRoot: string): string | null {
  const name = entryName.replace(/\\/g, '/').replace(/^\/+/, '');
  if (name.startsWith('__MACOSX/')) return null;
  if (!packageRoot) return name;
  if (!name.startsWith(packageRoot)) return null;
  return name.slice(packageRoot.length);
}

export function extractSkillMetadataFromMd(
  content: string,
): { ok: true; metadata: SkillImportMetadata } | { ok: false; errorCode: ImportLocalErrorCode; message: string } {
  let data: Record<string, unknown>;
  try {
    data = (matter(content).data as Record<string, unknown>) ?? {};
  } catch (err) {
    return {
      ok: false,
      errorCode: 'INVALID_FRONTMATTER',
      message: `YAML frontmatter 解析失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const { issues } = parseAndValidateFrontmatter(content, 'skill');
  if (issues.length > 0) {
    return {
      ok: false,
      errorCode: 'INVALID_FRONTMATTER',
      message: issues.map((i) => i.message).join('；'),
    };
  }

  const name = typeof data.name === 'string' ? data.name.trim() : '';
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  if (!name || !description) {
    return {
      ok: false,
      errorCode: 'INVALID_FRONTMATTER',
      message: 'SKILL.md frontmatter 必须包含非空的 name 与 description',
    };
  }
  if (!isValidImportSkillName(name)) {
    return {
      ok: false,
      errorCode: 'INVALID_NAME',
      message: `skill name "${name}" 不符合 ^[a-z0-9-]{1,200}$ 格式`,
    };
  }

  let version = DEFAULT_VERSION;
  if (data.version != null) {
    if (typeof data.version === 'string' && data.version.trim()) {
      version = data.version.trim();
    } else if (typeof data.version === 'number' && Number.isFinite(data.version)) {
      version = String(data.version);
    }
  }

  return { ok: true, metadata: { name, description, version } };
}

export function isSkillMdFileName(fileName: string): boolean {
  return SKILL_MD_NAMES.has(fileName);
}

export function classifyImportSourcePath(
  filePath: string,
): { kind: 'md' | 'zip' } | { error: string } {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
  const lower = base.toLowerCase();
  if (lower.endsWith('.zip')) {
    return { kind: 'zip' };
  }
  if (lower === 'skill.md') {
    return { kind: 'md' };
  }
  if (lower.endsWith('.md')) {
    return { error: '单独导入时文件名须为 SKILL.md' };
  }
  return { error: '仅支持 .zip 压缩包或 SKILL.md 文件' };
}

function pathNameEquals(actual: string, expected: string): boolean {
  return process.platform === 'win32'
    ? actual.toLowerCase() === expected.toLowerCase()
    : actual === expected;
}

/**
 * Resolve the final install directory for a local import.
 * - omit installPath → `~/.agents/skills/<name>`
 * - otherwise require an absolute path whose basename is `name`, under
 *   `<root>/.agents/skills/<name>` or `<root>/.claude/skills/<name>`
 */
export function resolveImportInstallPath(
  name: string,
  installPath: string | undefined,
  homeDir: string,
): { finalDir: string } | { errorCode: ImportLocalErrorCode; message: string } {
  if (installPath == null || !installPath.trim()) {
    return { finalDir: path.join(homeDir, '.agents', 'skills', name) };
  }

  const trimmed = installPath.trim();
  if (!path.isAbsolute(trimmed)) {
    return {
      errorCode: 'INTERNAL',
      message: 'installPath 必须是绝对路径',
    };
  }

  const finalDir = path.normalize(trimmed);
  if (!pathNameEquals(path.basename(finalDir), name)) {
    return {
      errorCode: 'INTERNAL',
      message: `installPath 的 basename "${path.basename(finalDir)}" 与 name "${name}" 不符`,
    };
  }

  const skillsDir = path.dirname(finalDir);
  const discoveryDir = path.dirname(skillsDir);
  if (!pathNameEquals(path.basename(skillsDir), 'skills')) {
    return {
      errorCode: 'INTERNAL',
      message: 'installPath 必须位于 .agents/skills 或 .claude/skills 目录下',
    };
  }
  const discoveryRoot = path.basename(discoveryDir);
  if (
    !pathNameEquals(discoveryRoot, '.agents') &&
    !pathNameEquals(discoveryRoot, '.claude')
  ) {
    return {
      errorCode: 'INTERNAL',
      message: 'installPath 必须位于 .agents/skills 或 .claude/skills 目录下',
    };
  }

  return { finalDir };
}

/**
 * Running total of declared uncompressed sizes. Returns false as soon as the
 * budget is exceeded (used to reject zip bombs before inflate).
 */
export function fitsUncompressedBudget(
  sizes: ReadonlyArray<number>,
  maxTotal: number,
): boolean {
  let total = 0;
  for (const size of sizes) {
    if (!Number.isFinite(size) || size < 0) return false;
    total += size;
    if (total > maxTotal) return false;
  }
  return true;
}
