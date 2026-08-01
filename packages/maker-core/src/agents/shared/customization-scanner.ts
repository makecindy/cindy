/**
 * 引擎无关的 customization 文件系统扫描器。
 *
 * 提供通用的目录扫描、SKILL.md 解析、frontmatter 提取能力。
 * 各 agent 通过提供自己的 SourceDef[] (路径 + engine 标签) 复用本模块。
 */

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

import type {
  AgentCustomization,
  AgentCustomizationFile,
  ListCustomizationsResult,
} from '../../types/customizations.js';

export interface SourceDef {
  engine: 'claude-code' | 'codex' | 'pi';
  kind: 'skill' | 'command' | 'agent';
  scope: string;
  dir: string;
  workingDir?: string;
}

export function parseFrontmatter(raw: string): {
  description?: string;
  frontmatter?: Record<string, unknown>;
  parseError?: string;
} {
  try {
    const parsed = matter(raw);
    if (parsed.data && typeof parsed.data === 'object') {
      const fm = parsed.data as Record<string, unknown>;
      const desc = fm.description;
      return {
        frontmatter: fm,
        ...(typeof desc === 'string' && desc.trim()
          ? { description: desc.trim().slice(0, 500) }
          : {}),
      };
    }
    return {};
  } catch (err) {
    return { parseError: err instanceof Error ? err.message : String(err) };
  }
}

function direntIsDirectoryOrSymlink(dirent: fs.Dirent): boolean {
  return dirent.isDirectory() || dirent.isSymbolicLink();
}

function readChildKind(parent: string, dirent: fs.Dirent): AgentCustomizationFile['kind'] {
  if (dirent.isDirectory()) return 'dir';
  if (!dirent.isSymbolicLink()) return 'file';

  try {
    return fs.statSync(path.join(parent, dirent.name)).isDirectory() ? 'dir' : 'file';
  } catch {
    return 'file';
  }
}

function readFolderSkill(source: SourceDef, folder: string, mdPath: string): AgentCustomization {
  const name = path.basename(folder);

  let description: string | undefined;
  let frontmatter: Record<string, unknown> | undefined;
  let parseError: string | undefined;
  try {
    const raw = fs.readFileSync(mdPath, 'utf-8');
    ({ description, frontmatter, parseError } = parseFrontmatter(raw));
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }

  let files: AgentCustomizationFile[] = [];
  try {
    files = fs.readdirSync(folder, { withFileTypes: true })
      .map((s) => ({ name: s.name, kind: readChildKind(folder, s) }))
      .sort((a, b) => {
        if (a.name === 'SKILL.md') return -1;
        if (b.name === 'SKILL.md') return 1;
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  } catch {
    // best-effort
  }

  return {
    engine: source.engine,
    kind: source.kind,
    scope: source.scope,
    name,
    description,
    absolutePath: folder,
    mdPath,
    files,
    frontmatter,
    parseError,
    ...(source.workingDir ? { workingDir: source.workingDir } : {}),
  };
}

function readFileCustomization(source: SourceDef, mdPath: string): AgentCustomization {
  const name = path.basename(mdPath, path.extname(mdPath));

  let description: string | undefined;
  let frontmatter: Record<string, unknown> | undefined;
  let parseError: string | undefined;
  try {
    const raw = fs.readFileSync(mdPath, 'utf-8');
    ({ description, frontmatter, parseError } = parseFrontmatter(raw));
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }

  return {
    engine: source.engine,
    kind: source.kind,
    scope: source.scope,
    name,
    description,
    absolutePath: mdPath,
    mdPath,
    files: [],
    frontmatter,
    parseError,
    ...(source.workingDir ? { workingDir: source.workingDir } : {}),
  };
}

function scanOneSource(source: SourceDef): {
  items: AgentCustomization[];
  errors: Array<{ path?: string; message: string }>;
} {
  const errors: Array<{ path?: string; message: string }> = [];
  try {
    if (!fs.existsSync(source.dir)) return { items: [], errors };
    const stat = fs.statSync(source.dir);
    if (!stat.isDirectory()) return { items: [], errors };

    const entries = fs.readdirSync(source.dir, { withFileTypes: true });
    const items: AgentCustomization[] = [];

    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      if (/\.bak\.\d+$/.test(ent.name)) continue;

      if (source.kind === 'skill') {
        if (!direntIsDirectoryOrSymlink(ent)) continue;
        const folder = path.join(source.dir, ent.name);
        const mdPath = path.join(folder, 'SKILL.md');
        let actualMd = mdPath;
        if (!fs.existsSync(actualMd) || !fs.statSync(actualMd).isFile()) {
          const lower = path.join(folder, 'skill.md');
          if (fs.existsSync(lower) && fs.statSync(lower).isFile()) {
            actualMd = lower;
          } else {
            continue;
          }
        }
        items.push(readFolderSkill(source, folder, actualMd));
      } else {
        if (!ent.isFile()) continue;
        if (!ent.name.toLowerCase().endsWith('.md')) continue;
        items.push(readFileCustomization(source, path.join(source.dir, ent.name)));
      }
    }

    return { items, errors };
  } catch (err) {
    errors.push({ path: source.dir, message: err instanceof Error ? err.message : String(err) });
    return { items: [], errors };
  }
}

/**
 * 通用文件系统扫描入口。
 *
 * 接受预构建的 SourceDef[]，逐目录扫描并返回合并结果（不排序）。
 * 各引擎 wrapper 负责构建 sources 并对结果排序。
 */
export function scanCustomizationSources(
  sources: SourceDef[],
  kindFilter?: Set<string> | null,
): ListCustomizationsResult {
  const filtered = kindFilter
    ? sources.filter((s) => kindFilter.has(s.kind))
    : sources;

  const items: AgentCustomization[] = [];
  const errors: Array<{ path?: string; message: string }> = [];

  for (const src of filtered) {
    const r = scanOneSource(src);
    items.push(...r.items);
    errors.push(...r.errors);
  }

  return { items, errors };
}
