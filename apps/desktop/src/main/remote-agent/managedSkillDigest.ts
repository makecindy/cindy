/**
 * Cindy 托管 Skill 的文件清单与内容指纹：任务所在电脑与 Agent 所在电脑用同一套规则，指纹相同就说明两边这个
 * Skill 的文件一字不差，Agent 所在电脑直接复制自己那份，不再经设备互联传一遍。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** 超出这些上限的 Skill 不算指纹(总是整份传)，避免为一个异常大的目录做大量读盘。 */
const MAX_FILES = 2048;
const MAX_DEPTH = 8;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export interface ManagedSkillFile {
  /** 相对 Skill 目录、用 `/` 分隔的路径。 */
  relative: string;
  local: string;
  size: number;
  mtimeMs: number;
}

/** Skill 目录下的全部普通文件(跟随链接，跳过 `.git` 与 `node_modules`)，按路径排序；超出上限返回 null。 */
export async function listManagedSkillFiles(dir: string): Promise<ManagedSkillFile[] | null> {
  const out: ManagedSkillFile[] = [];
  let total = 0;
  const walk = async (current: string, within: string, depth: number, ancestors: ReadonlySet<string>): Promise<boolean> => {
    if (depth > MAX_DEPTH) return false;
    const real = await fs.realpath(current);
    if (ancestors.has(real)) return true;
    const inside = new Set(ancestors).add(real);
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const local = path.join(current, entry.name);
      const relative = within ? `${within}/${entry.name}` : entry.name;
      let stat: import('node:fs').Stats;
      try {
        stat = await fs.stat(local);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (!(await walk(local, relative, depth + 1, inside))) return false;
      } else if (stat.isFile()) {
        total += stat.size;
        out.push({ relative, local, size: stat.size, mtimeMs: stat.mtimeMs });
        if (out.length > MAX_FILES || total > MAX_TOTAL_BYTES) return false;
      }
    }
    return true;
  };
  try {
    if (!(await walk(dir, '', 0, new Set()))) return null;
  } catch {
    return null;
  }
  return out.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
}

const cache = new Map<string, { signature: string; digest: string }>();

/** 按文件清单算指纹(路径与内容)。清单的大小与修改时间没变就用上次的结果，不重读内容。 */
export async function managedSkillDigest(dir: string, files?: readonly ManagedSkillFile[] | null): Promise<string | null> {
  const list = files === undefined ? await listManagedSkillFiles(dir) : files;
  if (!list) return null;
  const signature = JSON.stringify(list.map((file) => [file.relative, file.size, file.mtimeMs]));
  const key = path.resolve(dir);
  const cached = cache.get(key);
  if (cached?.signature === signature) return cached.digest;
  const hash = createHash('sha256');
  try {
    for (const file of list) {
      const data = await fs.readFile(file.local);
      hash.update(`${file.relative}\0${data.length}\0`);
      hash.update(data);
    }
  } catch {
    return null;
  }
  const digest = hash.digest('hex');
  if (cache.size >= 256) cache.clear();
  cache.set(key, { signature, digest });
  return digest;
}
