/**
 * Owner-scoped, non-secret channel working-directory override store.
 *
 * 直连 IM 渠道(个人微信/企业微信)共用的工作目录配置:只持久化用户在 Main
 * 原生目录选择器里选中的 override,不保存静态默认值快照(「恢复默认」= 删文件);
 * 配置缺失、损坏或目录暂不可访问时安全回退渠道托管目录,不阻断入站消息。
 * 渠道差异(配置文件名、错误码前缀、托管目录命名)经工厂参数注入。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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
  read(rootPath?: string): ChannelWorkingDirSettingsState;
  writeWorkingDir(selectedPath: string, rootPath?: string): ChannelWorkingDirSettingsState;
  resetWorkingDir(rootPath?: string): ChannelWorkingDirSettingsState;
  /** 解析 bot 的生效目录;回退托管目录时负责创建它。 */
  resolveWorkingDir(botId: string, rootPath?: string): string;
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

  function read(rootPath?: string): ChannelWorkingDirSettingsState {
    const file = settingsFilePath(rootPath);
    try {
      if (!fs.existsSync(file)) return { ...defaults, workingDirAvailable: true };
      const normalized = normalizeSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
      return {
        ...normalized,
        workingDirAvailable:
          normalized.workingDir === null || isUsableWorkingDirectory(normalized.workingDir),
      };
    } catch (error) {
      log.warn(`failed to read ${options.logTag} settings; using defaults`, {
        path: maskPath(file),
        errorCode: nodeErrorCode(error),
      });
      return { ...defaults, workingDirAvailable: true };
    }
  }

  function writeWorkingDir(
    selectedPath: string,
    rootPath?: string,
  ): ChannelWorkingDirSettingsState {
    const workingDir = normalizeSelectedDirectory(selectedPath);
    writeSettings({ ...defaults, workingDir }, rootPath);
    return read(rootPath);
  }

  function resetWorkingDir(rootPath?: string): ChannelWorkingDirSettingsState {
    const file = settingsFilePath(rootPath);
    try {
      fs.rmSync(file, { force: true });
    } catch (error) {
      log.warn(`failed to reset ${options.logTag} settings`, {
        path: maskPath(file),
        errorCode: nodeErrorCode(error),
      });
      throw error;
    }
    return { ...defaults, workingDirAvailable: true };
  }

  function resolveWorkingDir(botId: string, rootPath?: string): string {
    const configured = read(rootPath);
    if (configured.workingDir && configured.workingDirAvailable) return configured.workingDir;

    const dir = rootPath
      ? path.join(rootPath, 'im-working-dir', options.managedDirNameFor(botId))
      : ownerScopedImUserDataPath('im-working-dir', options.managedDirNameFor(botId));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function normalizeSelectedDirectory(selectedPath: string): string {
    if (typeof selectedPath !== 'string' || !path.isAbsolute(selectedPath)) {
      throw new Error(invalidErrorCode);
    }
    const realPath = fs.realpathSync.native(selectedPath);
    if (!fs.statSync(realPath).isDirectory()) throw new Error(notDirectoryErrorCode);
    const normalized = normalizeWorkingDirForStorage(realPath);
    if (!normalized) throw new Error(invalidErrorCode);
    return normalized;
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
  function writeSettings(settings: ChannelWorkingDirSettings, rootPath?: string): void {
    const file = settingsFilePath(rootPath);
    const tmp = `${file}.${randomUUID()}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let tmpCreated = false;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      tmpCreated = true;
      fs.renameSync(tmp, file);
    } finally {
      if (tmpCreated) {
        try {
          // rename 成功后是 ENOENT 幂等 no-op;rename 失败则清掉自己的半成品。
          fs.rmSync(tmp, { force: true });
        } catch {
          // 清理被锁挡住: 接受 tmp 残留, 不掩盖真正的写入错误。
        }
      }
    }
  }

  return { read, writeWorkingDir, resetWorkingDir, resolveWorkingDir };
}

/**
 * 目录「可用」按工作目录的实际用途判定: agent 要往里写文件。stat/access 都
 * 只能证明「存在」— 遍历/写权限被收回时它们仍成功(Windows 上 access 对目录
 * 基本恒过), 随后 /new 会拿到一个无法使用的目录而不是回退托管目录。所以用
 * 真写入探测: `writeFileSync(flag 'wx')` 独占创建并删除一个一次性 0 字节
 * 探针 — 不经 openSync/closeSync, 探测路径上没有手工描述符生命周期可泄漏。
 *
 * 删除的所有权纪律(六轮 review 裁决, 两条都不可退让):
 *   - **绝不按文件名前缀扫描删除** — 用户自建的同前缀文件不属于 Cindy。
 *   - **只删除本次调用确认独占创建的探针** — 'wx' 碰撞(EEXIST)说明那个
 *     路径属于别人; 「记住路径跨时间重试」也不行, 路径被其它进程替换后
 *     重试会删掉替换文件。删除失败(锁)接受 0 字节 UUID 残留, 不设任何
 *     延迟重试队列。
 */
const WORKDIR_PROBE_PREFIX = '.cindy-workdir-probe-';

function isUsableWorkingDirectory(candidate: string): boolean {
  const probe = path.join(candidate, `${WORKDIR_PROBE_PREFIX}${randomUUID()}`);
  let created = false;
  try {
    if (!fs.statSync(candidate).isDirectory()) return false;
    fs.writeFileSync(probe, '', { flag: 'wx' });
    created = true;
    return true;
  } catch {
    return false;
  } finally {
    if (created) {
      try {
        fs.rmSync(probe, { force: true });
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
