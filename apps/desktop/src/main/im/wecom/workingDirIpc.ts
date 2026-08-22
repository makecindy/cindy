/**
 * wecomBot 工作目录 IPC 的可注入业务体 — im/index.ts 的 ipcMain.handle 只做
 * Electron adapter(可信 sender 校验 + 事件解包), 业务与错误映射都在这里,
 * 便于免 Electron 的 handler 级测试(主路径 + 关键错误路径)。
 *
 * 安全不变量:
 *   - 目录授权只来自 Main 原生选择器, Renderer 不提交路径;
 *   - 原生弹窗与用户目录探测都是异步的: 打开/探测期间登出/换号会推进 IM
 *     account generation, **每个异步边界归来后都必须重校验** —— 只在弹窗前
 *     校验一次是同步时代的老假设, 探测网络盘可能秒级, A 账号选的绝对路径
 *     会趁探测间隙写进 B 账号的 owner-scoped 配置;
 *   - 校验/探测(normalizeSelectedDirectory)与落盘(commitWorkingDir)拆开:
 *     代次二次校验夹在两者之间, 校验通过后的写入只碰本地 userData, 窗口
 *     收敛到一次本机盘 IO;
 *   - 取消选择不是错误, 也不改变配置。
 */

import { throwIpcError } from '../../utils/ipcValidate';
import type { WecomChannelSettingsState } from './channelSettings';

export interface WecomWorkingDirIpcDeps {
  readSettings(): Promise<WecomChannelSettingsState>;
  /**
   * 校验并规整用户所选目录 — 异步探测用户盘(可能是网络盘, 挂起只阻塞本
   * IPC, 不冻结 Main 事件循环), 不落盘。
   */
  normalizeSelectedDirectory(selectedPath: string): Promise<string>;
  /** 落盘已规整目录(只碰本地 userData 配置文件)。 */
  commitWorkingDir(normalizedDir: string): Promise<WecomChannelSettingsState>;
  resetWorkingDir(): Promise<WecomChannelSettingsState>;
  /**
   * 解析可信宿主窗口并打开 Main 原生目录选择器。
   * 返回 null = 无有效窗口(同步失败, 不弹窗); Promise 拒绝 = 选择器异常。
   */
  showDirectoryPicker(sender: unknown): Promise<{ canceled: boolean; filePaths: string[] } | null>;
  /** IM account generation 快照(accountBoundary); 前后不一致 = 弹窗期间切号。 */
  captureGeneration(): number | null;
  warn(message: string, context?: Record<string, unknown>): void;
}

export function createWecomWorkingDirIpcHandlers(deps: WecomWorkingDirIpcDeps) {
  return {
    async getChannelSettings(): Promise<WecomChannelSettingsState> {
      return deps.readSettings();
    },

    async chooseWorkingDirectory(
      sender: unknown,
    ): Promise<{ canceled: boolean; state: WecomChannelSettingsState }> {
      const generationAtOpen = deps.captureGeneration();

      let result: { canceled: boolean; filePaths: string[] } | null = null;
      try {
        result = await deps.showDirectoryPicker(sender);
      } catch (error) {
        deps.warn('WeCom working directory picker failed', {
          errorCode: nodeErrorCodeOf(error),
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throwIpcError('WECOM_WORKING_DIR_UPDATE_FAILED', 'directory picker failed');
      }
      if (!result) {
        throwIpcError('WECOM_WORKING_DIR_UPDATE_FAILED', 'settings window unavailable');
      }

      const picked = result.canceled || !result.filePaths[0] ? undefined : result.filePaths[0];
      if (picked === undefined) {
        return { canceled: true, state: await deps.readSettings() };
      }
      if (deps.captureGeneration() !== generationAtOpen) {
        // 弹窗期间登出/换号: 选中的路径属于上一个账号的语境, 不落盘。
        // 前后代次相等(含双双为 null 的未激活窗口)才允许继续。
        deps.warn('WeCom working directory pick crossed an account switch; dropped');
        throwIpcError('WECOM_WORKING_DIR_UPDATE_FAILED', 'account changed while picking');
      }

      let normalized: string;
      try {
        // 异步探测用户所选目录(网络盘可能秒级挂起 — 只阻塞本 IPC)。
        normalized = await deps.normalizeSelectedDirectory(picked);
      } catch (error) {
        deps.warn('failed to validate user-picked WeCom working directory', {
          errorCode: nodeErrorCodeOf(error),
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throwIpcError('WECOM_WORKING_DIR_UPDATE_FAILED', 'failed to save working directory');
      }
      if (deps.captureGeneration() !== generationAtOpen) {
        // 探测期间登出/换号: 二次校验。校验通过后的提交只碰本地 userData,
        // 代次校验到落盘之间不再有用户盘 IO。
        deps.warn('WeCom working directory probe crossed an account switch; dropped');
        throwIpcError('WECOM_WORKING_DIR_UPDATE_FAILED', 'account changed while probing');
      }
      try {
        return { canceled: false, state: await deps.commitWorkingDir(normalized) };
      } catch (error) {
        deps.warn('failed to save user-picked WeCom working directory', {
          errorCode: nodeErrorCodeOf(error),
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throwIpcError('WECOM_WORKING_DIR_UPDATE_FAILED', 'failed to save working directory');
      }
    },

    async resetWorkingDirectory(): Promise<WecomChannelSettingsState> {
      try {
        return await deps.resetWorkingDir();
      } catch (error) {
        deps.warn('failed to reset WeCom working directory', {
          errorCode: nodeErrorCodeOf(error),
        });
        throwIpcError('WECOM_WORKING_DIR_UPDATE_FAILED', 'failed to reset working directory');
      }
    },
  };
}

/** 日志用 Node 错误码(ENOENT/EACCES/...);不含路径与堆栈,避免泄漏用户目录。 */
function nodeErrorCodeOf(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'UNKNOWN';
}

/** ipcMain.handle 的最小投影 — 测试注入 fake, 不拉起 Electron。 */
export interface IpcHandleSink {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): unknown;
}

export type WecomWorkingDirIpcHandlers = ReturnType<typeof createWecomWorkingDirIpcHandlers>;

/**
 * 注册三个 wecomBot 工作目录 channel。**可信 sender 校验先于一切业务体**
 * (读设置 / 开弹窗 / 重置) — 这条安全边界由 workingDirIpc.test 的回归用例
 * 锁住, 不许静默回退。
 */
export function registerWecomWorkingDirIpc(options: {
  ipc: IpcHandleSink;
  handlers: WecomWorkingDirIpcHandlers;
  /** main/im/index.ts 注入 assertTrustedAppRendererEvent。 */
  assertTrustedEvent(event: unknown): void;
}): void {
  const { ipc, handlers, assertTrustedEvent } = options;
  ipc.handle('wecomBot:get-channel-settings', (event) => {
    assertTrustedEvent(event);
    return handlers.getChannelSettings();
  });
  ipc.handle('wecomBot:choose-working-directory', (event) => {
    assertTrustedEvent(event);
    return handlers.chooseWorkingDirectory((event as { sender: unknown }).sender);
  });
  ipc.handle('wecomBot:reset-working-directory', (event) => {
    assertTrustedEvent(event);
    return handlers.resetWorkingDirectory();
  });
}
