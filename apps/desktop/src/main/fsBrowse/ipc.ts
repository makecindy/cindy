/**
 * fsBrowse —— 本机文件系统「目录浏览」IPC(项目选择器用)。
 *
 * 用途:首页「添加远程项目」弹窗里逐级浏览一台机器的目录。
 *   - 本机调用:控制端浏览自己(当前未使用,但 channel 通用)。
 *   - device-link 经隧道:控制端 `deviceLink.invoke(deviceId, 'fs:list-dir'|..., [{path}])`
 *     在**被控端**进程执行 —— 被控端 = host,数据真相在它本地 FS。
 *
 * 能力面(只读 + mkdir -p):
 *   - fs:list-dir   列子目录(含 hidden,对齐 SSH `ls -A`;不含文件)
 *   - fs:stat-path  判断路径是 dir / file / missing
 *   - fs:mkdir-p    幂等创建目录(用户输入一个尚不存在的项目路径时)
 * **不**提供文件读/写/删/exec —— 仅项目目录选择所需的最小面(allowlist 注释同款理由)。
 *
 * 跨平台:`~` 用 os.homedir() 展开;路径拼接/上级一律走 node:path(被控端可能是
 * Windows)。每个 entry 回传 host-native 绝对 `path`,renderer 直接用它导航,不在
 * renderer 侧拼接,天然跨平台。
 *
 * 纯函数(listDir / statPath / mkdirP / expandHome)导出供单测;ipcMain.handle 只做 adapter。
 */

import { ipcMain } from 'electron';
import { promises as fs, type Dirent } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { throwIpcError, requireObject, requireString } from '../utils/ipcValidate.js';

export interface FsBrowseEntry {
  name: string;
  kind: 'dir' | 'symlink';
  /** host-native 绝对路径(renderer 导航直接用,免跨平台拼接)。 */
  path: string;
}
export interface FsListDirResult {
  resolvedPath: string;
  entries: FsBrowseEntry[];
  /** host-native 上级目录;已在根则 null。 */
  parent: string | null;
}
export interface FsStatResult {
  kind: 'dir' | 'file' | 'missing';
  resolvedPath: string;
  /** 文件最后修改时间(unix ms);仅 kind==='file' 时有值。「本轮产出文件」卡用它做时间窗校验。 */
  mtimeMs?: number;
  /** 文件创建时间(unix ms);仅 kind==='file'。部分 Linux FS 不支持时为 0,调用方需判 >0。 */
  birthtimeMs?: number;
}
export interface FsMkdirResult {
  resolvedPath: string;
}

/**
 * 把以 `~` 开头的路径展开到本机 home,并归一为绝对路径(去 `..` 等)。
 * 空串 / `~` → home;`~/x` → home/x;绝对路径 → resolve;相对路径 → 相对 home 兜底。
 */
export function expandHome(input: string): string {
  const home = os.homedir();
  const raw = (input ?? '').trim();
  if (raw === '' || raw === '~' || raw === '~/' || raw === '~\\') return home;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.resolve(home, raw.slice(2));
  }
  if (path.isAbsolute(raw)) return path.resolve(raw);
  // 项目选择器里不该出现相对路径,兜底归到 home 下(而非 process.cwd,后者在被控端无意义)。
  return path.resolve(home, raw);
}

/** 列出目录下的**子目录**(含 hidden,对齐 SSH `ls -A`;文件不列)。每项带 host-native 绝对路径。 */
export async function listDir(rawPath: string): Promise<FsListDirResult> {
  const resolvedPath = expandHome(rawPath);
  let dirents: Dirent[];
  try {
    // encoding:'utf8' 固定到 name:string 的重载(否则 readdir 返回 string|Buffer 名联合)。
    dirents = await fs.readdir(resolvedPath, { withFileTypes: true, encoding: 'utf8' });
  } catch (err) {
    throwIpcError('FS_BROWSE_FAILED', `list dir failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const entries: FsBrowseEntry[] = [];
  for (const d of dirents) {
    const childPath = path.join(resolvedPath, d.name);
    if (d.isDirectory()) {
      entries.push({ name: d.name, kind: 'dir', path: childPath });
    } else if (d.isSymbolicLink()) {
      // 仅收指向目录的 symlink(跟随链接 stat);dangling / 指向文件的跳过。
      try {
        const st = await fs.stat(childPath);
        if (st.isDirectory()) entries.push({ name: d.name, kind: 'symlink', path: childPath });
      } catch {
        /* dangling symlink → 跳过 */
      }
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(resolvedPath);
  return { resolvedPath, entries, parent: parent === resolvedPath ? null : parent };
}

/** 判断路径状态:dir / file / missing(missing 用于「输入了不存在的新项目目录」分支)。 */
export async function statPath(rawPath: string): Promise<FsStatResult> {
  const resolvedPath = expandHome(rawPath);
  try {
    const st = await fs.stat(resolvedPath);
    return st.isDirectory()
      ? { kind: 'dir', resolvedPath }
      : { kind: 'file', resolvedPath, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { kind: 'missing', resolvedPath };
    }
    throwIpcError('FS_BROWSE_FAILED', `stat failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 幂等创建目录(已存在直接成功)。 */
export async function mkdirP(rawPath: string): Promise<FsMkdirResult> {
  const resolvedPath = expandHome(rawPath);
  try {
    await fs.mkdir(resolvedPath, { recursive: true });
    return { resolvedPath };
  } catch (err) {
    throwIpcError('FS_BROWSE_FAILED', `mkdir failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 注册三个本机 FS 浏览 handler。channel 已在 device-link allowlist 内(经隧道在被控端执行)。 */
export function registerFsBrowseIpc(): void {
  ipcMain.handle('fs:list-dir', async (_e, arg: unknown) => {
    const obj = requireObject(arg);
    return listDir(requireString(obj.path, 'path'));
  });
  ipcMain.handle('fs:stat-path', async (_e, arg: unknown) => {
    const obj = requireObject(arg);
    return statPath(requireString(obj.path, 'path'));
  });
  ipcMain.handle('fs:mkdir-p', async (_e, arg: unknown) => {
    const obj = requireObject(arg);
    return mkdirP(requireString(obj.path, 'path'));
  });
}
