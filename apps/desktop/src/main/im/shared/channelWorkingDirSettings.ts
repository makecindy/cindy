/**
 * Owner-scoped, non-secret channel working-directory override store.
 *
 * 直连 IM 渠道(个人微信/企业微信)共用的工作目录配置:只持久化用户在 Main
 * 原生目录选择器里选中的 override,不保存静态默认值快照(「恢复默认」= 删文件);
 * 配置缺失、损坏或目录暂不可访问时安全回退渠道托管目录,不阻断入站消息。
 * 渠道差异(配置文件名、错误码前缀、托管目录命名)经工厂参数注入。
 *
 * Main 线程纪律: 用户所选目录可能在网络盘/可移动盘上, stat/realpath/写探针/
 * 删除全部走 node:fs/promises —— 挂起只阻塞当前 IPC/解析, 不冻结事件循环。
 * 只有 userData(rootPath 测试桩)下的托管目录与配置文件属于本机盘, 同步
 * mkdirSync / 异步落盘均可接受。目录解析拆成两层:
 *   - ensureManagedWorkingDir(): 稳定托管目录, 同步, 供 sessionRepo 等热路径;
 *   - resolveWorkingDirForNewConversation(): 异步读配置 + 探测用户目录, 只在
 *     设置刷新、首次对话与 /new 边界调用。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, rename, rm, stat, writeFile, mkdir } from 'node:fs/promises';

import { normalizeWorkingDirForStorage } from '../../../shared/workingDir';
import { createLogger, maskPath } from '../../logger';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';

const SETTINGS_VERSION = 1;

export interface ChannelWorkingDirSettings {
  version: typeof SETTINGS_VERSION;
  workingDir: string | null;
}

export interface ChannelWorkingDirSettingsState extends ChannelWorkingDirSettings {
  workingDirAvailable: boolean;
}

export interface ChannelWorkingDirStore {
  /** 设置刷新(设置页展开/聚焦 IPC)用: 异步读配置 + 异步探测用户目录可用性。 */
  read(rootPath?: string): Promise<ChannelWorkingDirSettingsState>;
  /** 校验并写入用户所选目录(一步到位版): 异步 normalize + 异步落盘。 */
  writeWorkingDir(selectedPath: string, rootPath?: string): Promise<ChannelWorkingDirSettingsState>;
  /** 只校验/规整用户所选目录(异步探测用户盘), 不落盘;返回存储形态路径。 */
  normalizeSelectedDirectory(selectedPath: string): Promise<string>;
  /**
   * 落盘已规整的目录: 只碰本地 userData 配置文件。供 IPC 在「用户盘探测完成」
   * 与「提交」之间二次校验 IM account generation 后调用, 缩短代次校验到写入的
   * 敏感窗口(探测网络盘可能秒级)。
   */
  commitWorkingDir(normalizedDir: string, rootPath?: string): Promise<ChannelWorkingDirSettingsState>;
  /** 「恢复默认」= 删配置文件(本地 userData)。 */
  resetWorkingDir(rootPath?: string): Promise<ChannelWorkingDirSettingsState>;
  /**
   * 稳定托管目录(userData 本机盘, 同步 mkdir 不会挂起 Main)。会话行的兜底
   * 目录与归属比较都用它 —— 不读配置、不探测用户盘。
   */
  ensureManagedWorkingDir(botId: string, rootPath?: string): string;
  /** 解析新对话实际目录: 异步读配置 + 探测用户目录, 不可用回退托管目录。 */
  resolveWorkingDirForNewConversation(
    botId: string,
    rootPath?: string,
  ): Promise<string>;
}

export function createChannelWorkingDirStore(options: {
  /** 日志 tag,如 'im/wecom/channel-settings'。 */
  logTag: string;
  /** owner-scoped 配置文件名,如 'wecom-channel.json'。 */
  fileName: string;
  /** 校验错误码前缀,如 'WECOM' → 'WECOM_WORKING_DIR_INVALID'。 */
  errorCodePrefix: string;
  /** botId → 托管目录名。渠道各自的既定命名,存量目录依赖它保持稳定。 */
  managedDirNameFor(botId: string): string;
}): ChannelWorkingDirStore {
  const log = createLogger(options.logTag);
  const invalidErrorCode = `${options.errorCodePrefix}_WORKING_DIR_INVALID`;
  const notDirectoryErrorCode = `${options.errorCodePrefix}_WORKING_DIR_NOT_DIRECTORY`;
  const defaults: ChannelWorkingDirSettings = { version: SETTINGS_VERSION, workingDir: null };

  function settingsFilePath(rootPath?: string): string {
    return rootPath
      ? path.join(rootPath, options.fileName)
      : ownerScopedImUserDataPath(options.fileName);
  }

  async function read(rootPath?: string): Promise<ChannelWorkingDirSettingsState> {
    const file = settingsFilePath(rootPath);
    try {
      let raw: string;
      try {
        raw = await readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { ...defaults, workingDirAvailable: true };
        }
        throw error;
      }
      const normalized = normalizeSettings(JSON.parse(raw));
      return {
        ...normalized,
        workingDirAvailable:
          normalized.workingDir === null || (await isUsableWorkingDirectory(normalized.workingDir)),
      };
    } catch (error) {
      log.warn(`failed to read ${options.logTag} settings; using defaults`, {
        path: maskPath(file),
        errorCode: nodeErrorCode(error),
      });
      return { ...defaults, workingDirAvailable: true };
    }
  }

  async function writeWorkingDir(
    selectedPath: string,
    rootPath?: string,
  ): Promise<ChannelWorkingDirSettingsState> {
    return commitWorkingDir(await normalizeSelectedDirectory(selectedPath), rootPath);
  }

  async function normalizeSelectedDirectory(selectedPath: string): Promise<string> {
    if (typeof selectedPath !== 'string' || !path.isAbsolute(selectedPath)) {
      throw new Error(invalidErrorCode);
    }
    // 用户所选目录可能是网络盘/可移动盘 — realpath/stat 全异步, 挂起不冻结 Main。
    // fs.promises 没有 realpath.native(那只有同步版), 用标准 fsp.realpath —
    // 同样解析符号链接, Node 22 实测与 realpathSync.native 结果一致。
    const realPath = await realpath(selectedPath);
    if (!(await stat(realPath)).isDirectory()) throw new Error(notDirectoryErrorCode);
    const normalized = normalizeWorkingDirForStorage(realPath);
    if (!normalized) throw new Error(invalidErrorCode);
    return normalized;
  }

  async function commitWorkingDir(
    normalizedDir: string,
    rootPath?: string,
  ): Promise<ChannelWorkingDirSettingsState> {
    await writeSettings({ ...defaults, workingDir: normalizedDir }, rootPath);
    return read(rootPath);
  }

  async function resetWorkingDir(rootPath?: string): Promise<ChannelWorkingDirSettingsState> {
    const file = settingsFilePath(rootPath);
    try {
      await rm(file, { force: true });
    } catch (error) {
      log.warn(`failed to reset ${options.logTag} settings`, {
        path: maskPath(file),
        errorCode: nodeErrorCode(error),
      });
      throw error;
    }
    return { ...defaults, workingDirAvailable: true };
  }

  function ensureManagedWorkingDir(botId: string, rootPath?: string): string {
    const dir = rootPath
      ? path.join(rootPath, 'im-working-dir', options.managedDirNameFor(botId))
      : ownerScopedImUserDataPath('im-working-dir', options.managedDirNameFor(botId));
    // 本地 userData 托管目录 — 本机盘, 同步创建不会挂起 Main 事件循环。
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async function resolveWorkingDirForNewConversation(
    botId: string,
    rootPath?: string,
  ): Promise<string> {
    const configured = await read(rootPath);
    if (configured.workingDir && configured.workingDirAvailable) return configured.workingDir;
    return ensureManagedWorkingDir(botId, rootPath);
  }

  function normalizeSettings(raw: unknown): ChannelWorkingDirSettings {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...defaults };
    const input = raw as Record<string, unknown>;
    const workingDir =
      typeof input.workingDir === 'string' && path.isAbsolute(input.workingDir)
        ? normalizeWorkingDirForStorage(input.workingDir)
        : null;
    return {
      version: SETTINGS_VERSION,
      workingDir,
    };
  }

  /**
   * tmp + rename 原子落盘:崩溃不会留下半份 JSON。
   * tmp 只有在本调用确认独占创建成功后才清理 — 'wx' 碰撞(EEXIST)说明那个
   * 路径属于别人, 无条件 rm 会删掉竞争文件(P0)。
   */
  async function writeSettings(settings: ChannelWorkingDirSettings, rootPath?: string): Promise<void> {
    const file = settingsFilePath(rootPath);
    const tmp = `${file}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(file), { recursive: true });
    let tmpCreated = false;
    try {
      await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      tmpCreated = true;
      await rename(tmp, file);
    } finally {
      if (tmpCreated) {
        try {
          // rename 成功后是 ENOENT 幂等 no-op;rename 失败则清掉自己的半成品。
          await rm(tmp, { force: true });
        } catch {
          // 清理被锁挡住: 接受 tmp 残留, 不掩盖真正的写入错误。
        }
      }
    }
  }

  return {
    read,
    writeWorkingDir,
    normalizeSelectedDirectory,
    commitWorkingDir,
    resetWorkingDir,
    ensureManagedWorkingDir,
    resolveWorkingDirForNewConversation,
  };
}

/**
 * 目录「可用」按工作目录的实际用途判定: agent 要往里写文件。stat/access 都
 * 只能证明「存在」— 遍历/写权限被收回时它们仍成功(Windows 上 access 对目录
 * 基本恒过), 随后 /new 会拿到一个无法使用的目录而不是回退托管目录。所以用
 * 真写入探测: `writeFile(flag 'wx')` 独占创建并删除一个一次性 0 字节探针 —
 * 全异步, 不经 open/close 手工描述符生命周期, 挂起的网络盘只阻塞本探测。
 *
 * 删除的所有权纪律(六轮 review 裁决, 两条都不可退让):
 *   - **绝不按文件名前缀扫描删除** — 用户自建的同前缀文件不属于 Cindy。
 *   - **只删除本次调用确认独占创建的探针** — 'wx' 碰撞(EEXIST)说明那个
 *     路径属于别人; 「记住路径跨时间重试」也不行, 路径被其它进程替换后
 *     重试会删掉替换文件。删除失败(锁)接受 0 字节 UUID 残留, 不设任何
 *     延迟重试队列。
 */
const WORKDIR_PROBE_PREFIX = '.cindy-workdir-probe-';

async function isUsableWorkingDirectory(candidate: string): Promise<boolean> {
  const probe = path.join(candidate, `${WORKDIR_PROBE_PREFIX}${randomUUID()}`);
  let created = false;
  try {
    if (!(await stat(candidate)).isDirectory()) return false;
    await writeFile(probe, '', { flag: 'wx' });
    created = true;
    return true;
  } catch {
    return false;
  } finally {
    if (created) {
      try {
        await rm(probe, { force: true });
      } catch {
        // 删除被锁挡住: 接受 0 字节残留 — 不记住路径, 不重试, 不扫描。
      }
    }
  }
}

function nodeErrorCode(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'UNKNOWN';
}

export const __testing = { isUsableWorkingDirectory };
