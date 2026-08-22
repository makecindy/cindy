/**
 * 直连 IM 渠道(个人微信/企业微信)「工作目录」IPC 业务体的共享工厂。
 *
 * 渠道差异只经两个显式参数注入:`updateFailedCode`(完整 IpcErrorCode,不做
 * 字符串拼接/强转,保持 throwIpcError 类型安全)与 `channelLabel`(日志文案)。
 * 固定 IPC channel 注册与可信 sender 校验**不**泛化 —— 各渠道在各自的
 * workingDirIpc.ts 里保留(避免出现可配置任意 channel 的通用注册器)。
 *
 * 安全不变量(六轮 review 裁决的延续):
 *   - 目录授权只来自 Main 原生选择器, Renderer 不提交路径;
 *   - 选择器与用户目录探测都是异步的: 打开/探测期间登出/换号会推进 IM
 *     account generation, **三个异步边界归来后都必须重校验** —
 *     ① 选择器返回后、② 异步探测返回后(commit 前, 必检)、③ 本地 commit
 *     返回后(切号期间已落盘的状态不返回给 Renderer, 报错代替);
 *   - 校验/探测(normalizeSelectedDirectory)与落盘(commitWorkingDir)拆开:
 *     ② 与 ③ 之间只剩一次本地 userData 写入, 敏感窗口收敛到本机盘 IO;
 *   - 取消选择不是错误, 也不改变配置;
 *   - 日志只记 Node 错误码(ENOENT/EACCES/…与渠道校验码), 不记 error.message
 *     —— 原生文件系统错误的 message 含完整用户目录, 是隐私泄漏。
 */

import { throwIpcError } from '../../utils/ipcValidate';
import type { IpcErrorCode } from '../../../shared/ipc-errors';
import type { ChannelWorkingDirSettingsState } from './channelWorkingDirSettings';

export interface ChannelWorkingDirIpcDeps {
  readSettings(): Promise<ChannelWorkingDirSettingsState>;
  /**
   * 校验并规整用户所选目录 — 异步探测用户盘(可能是网络盘, 挂起只阻塞本
   * IPC, 不冻结 Main 事件循环), 不落盘。
   */
  normalizeSelectedDirectory(selectedPath: string): Promise<string>;
  /** 落盘已规整目录(只碰本地 userData 配置文件)。 */
  commitWorkingDir(normalizedDir: string): Promise<ChannelWorkingDirSettingsState>;
  resetWorkingDir(): Promise<ChannelWorkingDirSettingsState>;
  /**
   * 解析可信宿主窗口并打开 Main 原生目录选择器。
   * 返回 null = 无有效窗口(同步失败, 不弹窗); Promise 拒绝 = 选择器异常。
   */
  showDirectoryPicker(sender: unknown): Promise<{ canceled: boolean; filePaths: string[] } | null>;
  /** IM account generation 快照(accountBoundary);前后不一致 = 期间切号。 */
  captureGeneration(): number | null;
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface ChannelWorkingDirIpcOptions {
  /** 完整错误码, 如 'WECOM_WORKING_DIR_UPDATE_FAILED'。 */
  updateFailedCode: IpcErrorCode;
  /** 日志里的渠道名, 如 'WeCom' / 'personal WeChat'。 */
  channelLabel: string;
  deps: ChannelWorkingDirIpcDeps;
}

export function createChannelWorkingDirIpcHandlers(options: ChannelWorkingDirIpcOptions) {
  const { updateFailedCode, channelLabel, deps } = options;
  return {
    async getChannelSettings(): Promise<ChannelWorkingDirSettingsState> {
      return deps.readSettings();
    },

    async chooseWorkingDirectory(
      sender: unknown,
    ): Promise<{ canceled: boolean; state: ChannelWorkingDirSettingsState }> {
      const generationAtOpen = deps.captureGeneration();

      let result: { canceled: boolean; filePaths: string[] } | null = null;
      try {
        result = await deps.showDirectoryPicker(sender);
      } catch (error) {
        deps.warn(`${channelLabel} working directory picker failed`, {
          errorCode: nodeErrorCodeOf(error),
        });
        throwIpcError(updateFailedCode, 'directory picker failed');
      }
      if (!result) {
        throwIpcError(updateFailedCode, 'settings window unavailable');
      }

      const picked = result.canceled || !result.filePaths[0] ? undefined : result.filePaths[0];
      if (picked === undefined) {
        return { canceled: true, state: await deps.readSettings() };
      }
      if (deps.captureGeneration() !== generationAtOpen) {
        // ① 弹窗期间登出/换号: 选中的路径属于上一个账号的语境, 不落盘。
        // 前后代次相等(含双双为 null 的未激活窗口)才允许继续。
        deps.warn(`${channelLabel} working directory pick crossed an account switch; dropped`);
        throwIpcError(updateFailedCode, 'account changed while picking');
      }

      let normalized: string;
      try {
        // 异步探测用户所选目录(网络盘可能秒级挂起 — 只阻塞本 IPC)。
        normalized = await deps.normalizeSelectedDirectory(picked);
      } catch (error) {
        deps.warn(`failed to validate user-picked ${channelLabel} working directory`, {
          errorCode: nodeErrorCodeOf(error),
        });
        throwIpcError(updateFailedCode, 'failed to save working directory');
      }
      if (deps.captureGeneration() !== generationAtOpen) {
        // ② 探测期间登出/换号: 必检。校验通过后的提交只碰本地 userData,
        // 代次校验到落盘之间不再有用户盘 IO。
        deps.warn(`${channelLabel} working directory probe crossed an account switch; dropped`);
        throwIpcError(updateFailedCode, 'account changed while probing');
      }
      let state: ChannelWorkingDirSettingsState;
      try {
        state = await deps.commitWorkingDir(normalized);
      } catch (error) {
        deps.warn(`failed to save user-picked ${channelLabel} working directory`, {
          errorCode: nodeErrorCodeOf(error),
        });
        throwIpcError(updateFailedCode, 'failed to save working directory');
      }
      if (deps.captureGeneration() !== generationAtOpen) {
        // ③ commit 期间切号: 已落盘的状态属于上一个账号的语境, 不返回给
        // Renderer — 报错让界面回落到重新读取, 而不是展示跨账号路径。
        deps.warn(`${channelLabel} working directory commit crossed an account switch; dropped`);
        throwIpcError(updateFailedCode, 'account changed while committing');
      }
      return { canceled: false, state };
    },

    async resetWorkingDir(): Promise<ChannelWorkingDirSettingsState> {
      try {
        return await deps.resetWorkingDir();
      } catch (error) {
        deps.warn(`failed to reset ${channelLabel} working directory`, {
          errorCode: nodeErrorCodeOf(error),
        });
        throwIpcError(updateFailedCode, 'failed to reset working directory');
      }
    },
  };
}

/** 日志用 Node 错误码(ENOENT/EACCES/渠道校验码...);不含路径与原始 message。 */
export function nodeErrorCodeOf(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'UNKNOWN';
}

export type ChannelWorkingDirIpcHandlers = ReturnType<typeof createChannelWorkingDirIpcHandlers>;
