/**
 * xdt-helper/get_message_status.ts —— 只读查询一条已投递消息的送达状态。
 *
 * 输入是 send_to_session 回执里的 queued_message_id（本机 clientId），目标会话可为
 * 本机 id 或 deviceId::sessionId。状态机由 host 侧按持久化队列快照 + messages 表
 * 推导：queued(含位置) / processing / dispatched / consumed / failed。
 * 本工具不做轮询、不改变投递；跨电脑经 device-link 只读通道，目标不可达时返回
 * REMOTE_* 并在 message 里明示结果不完整。
 */

import { z } from "zod";

import type { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import type { ControlResult } from "../types.js";
import type { HistoryReadErrorCode } from "./_history_types.js";
import { errorPayload, okPayload } from "./_payload.js";

export type MessageStatusState =
  | "queued"
  | "processing"
  | "dispatched"
  | "consumed"
  | "failed";

/** host 返回的状态快照；session/message id 由工具层按入参回显。 */
export interface MessageStatusSnapshot {
  status: MessageStatusState;
  /** 0-based 队列位置（与 list_session_queue 的 position 同口径），仅 queued/processing(投递中) 附带。 */
  position?: number;
  source?: "user" | "orca" | "scheduler" | "session";
  source_label?: string | null;
  enqueued_at?: string | null;
  /** failed 原因或 dispatched/processing 的补充说明。 */
  detail?: string;
  /** consumed 时首个 assistant 回复行的 ISO 时间。 */
  consumed_at?: string | null;
}

export type MessageStatusErrorCode =
  | HistoryReadErrorCode
  | "HOST_NOT_READY"
  | "INTERNAL";

export interface MessageStatusDeps {
  /**
   * host 注入的状态查询。sessionId 可以是本机 id 或 deviceId::sessionId；
   * host 负责本机/远程分流与 REMOTE_* 错误归一。
   */
  getMessageStatus: (args: {
    sessionId: string;
    messageId: string;
  }) => Promise<ControlResult<MessageStatusSnapshot, MessageStatusErrorCode>>;
}

const MAX_MESSAGE_ID_CHARS = 256;

const DESCRIPTION = [
  "只读查询一条已通过 send_to_session 投递的消息现在处于什么状态。输入目标会话（本机 id 或 deviceId::sessionId）+ message_id（send_to_session 回执里的 queued_message_id；直接派发的消息同样适用）。",
  "",
  "【状态】queued=仍在目标任务输入队列(附 position 队列位置、来源、入队时间); processing=正在投递给 agent 或该任务正在处理这条消息; dispatched=已受理并落库、尚无 assistant 回复; consumed=该消息之后已出现 assistant 回复轮(附 consumed_at); failed=投递失败或消息已被移除(取消/清空/回滚)，detail 写明原因。",
  "",
  "【跨电脑】session_id 传 deviceId::sessionId 时经远程只读通道查询目标电脑；对方离线、未开远程控制、版本不支持或超时时返回 REMOTE_* 错误，此时状态结果不完整，message 会写明。",
  "",
  "【不要轮询】这是按需查询：需要确认送达/回复时调一次即可，不要循环调用。想等回复完成请用 get_task_digest 或在需要时再查一次。",
  "",
  "失败码: NOT_FOUND(任务或消息不存在) / INVALID_ARGS / HOST_NOT_READY / INTERNAL / REMOTE_*(远程不可达,结果不完整)。",
].join("\n");

const STATUS_VALUES = new Set<MessageStatusState>([
  "queued",
  "processing",
  "dispatched",
  "consumed",
  "failed",
]);

function isRemoteIncompleteCode(code: string): boolean {
  return code.startsWith("REMOTE_") || code === "DEVICE_LINK_NOT_READY";
}

export function registerGetMessageStatusTool(
  registry: XdtHelperToolRegistry,
  deps: MessageStatusDeps,
): void {
  registry.register({
    name: "get_message_status",
    category: "history",
    description: DESCRIPTION,
    inputShape: {
      session_id: z
        .string()
        .min(1)
        .describe(
          "目标任务 id：本机 id 或另一台电脑上的 deviceId::sessionId（形式同 send_to_session / get_chat_history）。",
        ),
      message_id: z
        .string()
        .min(1)
        .max(MAX_MESSAGE_ID_CHARS)
        .describe(
          "要查询的消息 id：send_to_session 成功回执里的 queued_message_id（即目标侧 clientId）。",
        ),
    },
    handler: async ({ session_id, message_id }) => {
      const result = await deps.getMessageStatus({
        sessionId: session_id,
        messageId: message_id,
      });
      if (!result.ok) {
        const suffix = isRemoteIncompleteCode(result.errorCode)
          ? "；远程送达状态结果不完整，请稍后重试或改用 get_chat_history 核对。"
          : "";
        return errorPayload(result.errorCode, `${result.message}${suffix}`);
      }
      if (!STATUS_VALUES.has(result.status)) {
        return errorPayload("INTERNAL", "host returned an unknown message status");
      }
      const snapshot = result;
      return okPayload({
        session_id,
        message_id,
        status: snapshot.status,
        ...(snapshot.position !== undefined ? { position: snapshot.position } : {}),
        ...(snapshot.source !== undefined ? { source: snapshot.source } : {}),
        ...(snapshot.source_label !== undefined
          ? { source_label: snapshot.source_label }
          : {}),
        ...(snapshot.enqueued_at !== undefined
          ? { enqueued_at: snapshot.enqueued_at }
          : {}),
        ...(snapshot.detail !== undefined ? { detail: snapshot.detail } : {}),
        ...(snapshot.consumed_at !== undefined
          ? { consumed_at: snapshot.consumed_at }
          : {}),
      });
    },
  });
}
