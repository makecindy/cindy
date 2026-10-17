/**
 * partner-bridge/types.ts
 * ---------------------------------------------------------------------------
 * 外部系统(自研服务、微信自动化脚本等)经本机回环 HTTP 调 Cindy 伙伴的契约。
 * 执行层复用 maker-ipc 的统一投递通路与 hook-control 的 turn 观察器,本文件
 * 只定义"一次任务"的形状与注入面 —— 不含 Electron / 数据库依赖,便于单测。
 *
 * 安全口径(与 ghost errand 同源):
 *   - permissionMode 只认白名单 plan / acceptEdits / auto,缺省 plan(只读);
 *     bypassPermissions 在协议上就不存在;
 *   - 调用方给的 workingDir 由宿主校验(存在且是目录)后才采纳,失败即拒绝;
 *   - 附件只回本机绝对路径,不做 base64 搬运 —— 调用方按定义与本机同侧。
 */

import type { ObservableSession } from '../hook-control/turnObserver.js';

/** 外部调用可用的权限档。刻意不含 bypassPermissions。 */
export const PARTNER_PERMISSION_MODES = ['plan', 'acceptEdits', 'auto'] as const;
export type PartnerPermissionMode = (typeof PARTNER_PERMISSION_MODES)[number];

/** 任何来路的权限档都收敛进白名单,缺省 plan(只读)。 */
export function clampPartnerPermissionMode(value: unknown): PartnerPermissionMode {
  return typeof value === 'string' &&
    (PARTNER_PERMISSION_MODES as readonly string[]).includes(value)
    ? (value as PartnerPermissionMode)
    : 'plan';
}

/** 一次外部调用的入参(HTTP body 校验后的形态)。 */
export interface PartnerTurnRequest {
  /** 会话分间键。同一 key 的多次调用复用同一间会话(上下文连续)。 */
  key: string;
  prompt: string;
  /** 完成后 POST 结果的地址(可选);失败重试若干次后放弃并留日志。 */
  callbackUrl?: string;
  /** 工作目录(绝对路径);缺省落 app 托管的对话间。 */
  workingDir?: string;
  permissionMode?: PartnerPermissionMode;
  /**
   * 可选:本单用哪个 agent。缺省跟随 New Maker 草稿默认(与用户手动新建一致);
   * 外部系统有明确偏好时可以显式指定。
   */
  agentKind?: 'cc' | 'codex' | 'pi';
}

export type PartnerTaskStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface PartnerTaskAttachment {
  name: string;
  absPath: string;
  bytes: number;
  kind: 'image' | 'file';
}

export interface PartnerTaskRecord {
  taskId: string;
  key: string;
  prompt: string;
  sessionId: string | null;
  status: PartnerTaskStatus;
  text: string | null;
  attachments: PartnerTaskAttachment[];
  /** 机器可读的错误码(调用方按它分流);成功时为 null。 */
  errorCode: string | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

/** 会话行的关键面(复用判定用)。 */
export interface PartnerSessionRow {
  status: string;
  agentKind: string;
  permissionMode: string;
  workingDir: string | null;
  workspaceKind: string;
}

export interface PartnerSessionCreateParams {
  key: string;
  title: string | null;
  permissionMode: PartnerPermissionMode;
  workingDir?: string;
  agentKind?: 'cc' | 'codex' | 'pi';
  model?: string;
  effort?: string;
  fastMode?: boolean;
  providerId?: string | null;
}

export interface PartnerDraftDefaults {
  agentKind?: 'cc' | 'codex' | 'pi';
  model?: string;
  effort?: string;
  fastMode?: boolean;
  providerId?: string | null;
}

export type PartnerDispatchResult =
  | { ok: true; wakeKind: 'resumed' | 'already-active' | 'created' | 'queued' }
  | { ok: false; errorCode: string; message: string };

/** 宿主注入面(生产在 maker-ipc/register.ts 接线;测试注入内存 fake)。 */
export interface PartnerBridgeDeps {
  /** 读某 key 的专属会话映射;null = 还没建过。 */
  readSessionId(key: string): string | null;
  writeSessionId(key: string, sessionId: string | null): void;
  getSessionRow(sessionId: string): Promise<PartnerSessionRow | null>;
  createSession(params: PartnerSessionCreateParams): Promise<string>;
  /**
   * 取某个 agent 的草稿默认。不传 = 按 New Maker 里有选择记录的第一档
   * (cc → codex → pi);传了 = 只取该 agent 对应 vendor 的默认,避免把另一个
   * agent 的模型／来源写进会话。
   */
  getDraftDefaults(agentKind?: 'cc' | 'codex' | 'pi'): PartnerDraftDefaults;
  /** 宿主侧路径校验 + 规范化(非绝对路径/不存在/不是目录返回 null)。 */
  normalizeWorkingDir(dir: string): Promise<string | null>;
  isSessionBusy(sessionId: string): boolean;
  dispatch(params: { targetSessionId: string; message: string }): Promise<PartnerDispatchResult>;
  /** 中止该会话当前这一轮(取消任务时调用)。 */
  abortSession(sessionId: string): Promise<void>;
  getObservableSession(sessionId: string): ObservableSession | null;
  onSilentStopSettled(
    sessionId: string,
    cb: (sessionId: string, reason: string) => void,
  ): () => void;
  /** 收口后读该会话 sinceMs 之后最新一条 assistant 正文(兜底;查无 → null)。 */
  readLatestAssistantText(sessionId: string, sinceMs: number): Promise<string | null>;
  /** 从终稿文本解析附件引用并剥离正文(实现见 ./attachments.ts 的工厂)。 */
  resolveAttachments(args: {
    text: string;
    workingDir: string | null;
    sessionId: string;
  }): Promise<{ text: string; attachments: PartnerTaskAttachment[] }>;
  /** 回调投递(生产走回环 HTTP POST;失败由调用方重试)。 */
  deliverCallback(url: string, payload: unknown): Promise<void>;
  log: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  turnTimeoutMs?: number;
  callbackRetries?: number;
}
