/**
 * 主人本人那一轮让伙伴记下的项目目录(add_workbench_project)的校验。
 *
 * 只收绝对路径(允许 `~/` 开头)且真实存在的目录;不收磁盘根目录、主目录,也不收 Cindy 自己的
 * 数据目录——交出去的是项目,不是整台电脑。字面路径与符号链接指向的真实目录都要过这些规则,
 * 链接不能绕开限制。记下的是字面路径,与工作台里点选目录的写法一致(任务的工作目录也按它匹配)。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type HandoverDirectoryCheck =
  | { ok: true; path: string }
  | { ok: false; errorCode: 'INVALID_PROJECT_PATH' | 'NOT_A_DIRECTORY'; message: string };

export interface HandoverDirectoryEnv {
  homeDir: string;
  userDataDir: string;
  caseInsensitive: boolean;
}

function isInside(child: string, root: string, caseInsensitive: boolean): boolean {
  const relative = path.relative(caseInsensitive ? root.toLowerCase() : root, caseInsensitive ? child.toLowerCase() : child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function checkHandoverDirectory(raw: string, env: HandoverDirectoryEnv): Promise<HandoverDirectoryCheck> {
  const trimmed = raw.trim();
  const expanded = trimmed === '~' || trimmed.startsWith('~/') ? path.join(env.homeDir, trimmed.slice(1)) : trimmed;
  const invalid = (message: string): HandoverDirectoryCheck => ({ ok: false, errorCode: 'INVALID_PROJECT_PATH', message });
  if (!path.isAbsolute(expanded)) return invalid('请给项目目录的绝对路径');
  const resolved = path.resolve(expanded);
  let real: string;
  try {
    if (!(await fs.stat(resolved)).isDirectory()) return { ok: false, errorCode: 'NOT_A_DIRECTORY', message: '这不是一个目录' };
    real = await fs.realpath(resolved);
  } catch {
    return { ok: false, errorCode: 'NOT_A_DIRECTORY', message: '找不到这个目录' };
  }
  const home = path.resolve(env.homeDir);
  const userData = path.resolve(env.userDataDir);
  const [realHome, realUserData] = await Promise.all([
    fs.realpath(home).catch(() => home),
    fs.realpath(userData).catch(() => userData),
  ]);
  const same = (a: string, b: string) => (env.caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b);
  for (const candidate of [resolved, real]) {
    if (path.parse(candidate).root === candidate || same(candidate, home) || same(candidate, realHome)) {
      return invalid('不能把整个磁盘或主目录交给伙伴,请给具体的项目目录');
    }
    if (isInside(candidate, userData, env.caseInsensitive) || isInside(candidate, realUserData, env.caseInsensitive)) {
      return invalid('这是 Cindy 自己的数据目录,不是项目');
    }
  }
  return { ok: true, path: resolved };
}

/**
 * 移除项目时找到工作台里对应的那一条:允许 `~/` 开头、尾斜杠、大小写不同(macOS / Windows 默认文件系统
 * 不区分大小写),以及指向同一真实目录的符号链接。找不到返回 null。
 */
export async function findHandedProject(
  raw: string,
  directories: readonly string[],
  env: Pick<HandoverDirectoryEnv, 'homeDir'> & { caseInsensitive: boolean },
): Promise<string | null> {
  const trimmed = raw.trim();
  const expanded = trimmed === '~' || trimmed.startsWith('~/') ? path.join(env.homeDir, trimmed.slice(1)) : trimmed;
  if (!path.isAbsolute(expanded)) return null;
  const resolved = path.resolve(expanded);
  const key = (value: string) => (env.caseInsensitive ? value.toLowerCase() : value);
  const literal = directories.find((dir) => key(path.resolve(dir)) === key(resolved));
  if (literal) return literal;
  const real = await fs.realpath(resolved).catch(() => null);
  if (!real) return null;
  for (const dir of directories) {
    const dirReal = await fs.realpath(dir).catch(() => null);
    if (dirReal && key(dirReal) === key(real)) return dir;
  }
  return null;
}
