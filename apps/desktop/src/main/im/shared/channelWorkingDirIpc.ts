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
 *   - **每个操作(get/choose/reset)入口都绑定一个非空 generation**: null =
 *     IM 账号边界未激活(启动早期/登出/换号窗口), 一律直接拒绝 — null→null
 *     不构成"稳定账号", 否则换号窗口的慢读取会把 A 的路径交给 B(review P1);
 *   - 选择器与用户目录探测都是异步的: 打开/探测期间登出/换号会推进 IM
 *     account generation(或回落 null), **三个异步边界归来后都必须复检仍是
 *     同一个非空 generation** — ① 选择器返回后、② 异步探测返回后
 *     (commit 前, 必检)、③ 本地 commit 返回后(切号期间已落盘的状态不返回
 *     给 Renderer, 报错代替);
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

  /**
   * 捕获并**要求非空**的 generation 作为本次操作的绑定代次。null 表示 IM
   * 账号边界未激活(启动早期/登出/换号窗口) — 期间配置属于哪个账号是未定义
   * 的, 读配置、弹选择器、重置、提交一律拒绝, 不能把 null→null 当成"稳定
   * 账号"(review P1: 换号窗口的慢读取会把 A 的路径交给 B)。
   */
  function requireStableGeneration(): number {
    const generation = deps.captureGeneration();
    if (generation === null) {
      deps.warn(`${channelLabel} working directory IPC rejected: no active IM account boundary`);
      throwIpcError(updateFailedCode, 'no active account');
    }
    return generation;
  }

  /** 异步边界归来后复检: 仍是同一个非空 generation 才放行(null 同样算变化)。 */
  function assertSameGeneration(expected: number, phase: string): void {
    if (deps.captureGeneration() !== expected) {
      deps.warn(`${channelLabel} working directory ${phase} crossed an account switch; dropped`);
      throwIpcError(updateFailedCode, `account changed while ${phase}`);
    }
  }

  /**
   * 按既定 generation 读取渠道设置: A 账号的目录在慢速网络盘上时,
   * readSettings 可能挂到 deadline 才返回 — 期间切到 B 账号后, A 的绝对
   * 路径不得交给当前 Renderer。返回前复检仍是同一 generation, 变化(含
   * 回落 null)即丢弃结果并抛渠道 UPDATE_FAILED(renderer 无法可靠拦截
   * 跨账号响应, 守卫必须在 Main 侧)。**不重新捕获** — 语义上不得在读取
   * 边界重新绑定账号。
   */
  async function readSettingsForGeneration(expected: number): Promise<ChannelWorkingDirSettingsState> {
    const state = await deps.readSettings();
    assertSameGeneration(expected, 'settings read');
    return state;
  }

  return {
    async getChannelSettings(): Promise<ChannelWorkingDirSettingsState> {
      return readSettingsForGeneration(requireStableGeneration());
    },

    async chooseWorkingDirectory(
      sender: unknown,
    ): Promise<{ canceled: boolean; state: ChannelWorkingDirSettingsState }> {
      const expected = requireStableGeneration();

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

      // 选择器返回后立即复检 — **取消分支同样不得跨账号返回状态**: 弹窗
      // 期间 A→B 切号后取消, A 发起的 IPC 不能把 B 的绝对路径带回去
      // (renderer 的 owner epoch 只是第二道防线, Main 边界不依赖它)。
      assertSameGeneration(expected, 'pick');
      const picked = result.canceled || !result.filePaths[0] ? undefined : result.filePaths[0];
      if (picked === undefined) {
        return { canceled: true, state: await readSettingsForGeneration(expected) };
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
      assertSameGeneration(expected, 'probe');
      let state: ChannelWorkingDirSettingsState;
      try {
        state = await deps.commitWorkingDir(normalized);
      } catch (error) {
        deps.warn(`failed to save user-picked ${channelLabel} working directory`, {
          errorCode: nodeErrorCodeOf(error),
        });
        throwIpcError(updateFailedCode, 'failed to save working directory');
      }
      assertSameGeneration(expected, 'commit');
      return { canceled: false, state };
    },

    async resetWorkingDir(): Promise<ChannelWorkingDirSettingsState> {
      const expected = requireStableGeneration();
      try {
        const state = await deps.resetWorkingDir();
        assertSameGeneration(expected, 'reset');
        return state;
      } catch (error) {
        if ((error as { code?: unknown }).code === updateFailedCode) throw error;
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
