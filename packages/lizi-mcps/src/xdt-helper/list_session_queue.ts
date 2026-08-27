/**
 * xdt-helper/list_session_queue.ts —— 查询任意本机 session 的只读输入队列。
 *
 * 与 cindy_orca/get_worker_queue_status 的边界不同：本工具不要求 Lead 身份，也不暴露
 * 修改、撤回或重排能力；它只把 host 注入的队列快照压成有界摘要，供 agent 确认
 * 一条消息是否已经排队、位于什么位置、是否正在投递。
 */

import { z } from "zod";

import type { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import type { ControlResult } from "../types.js";
import { errorPayload, okPayload } from "./_payload.js";

const MAX_CONTENT_SUMMARY_CHARS = 500;

export interface SessionQueuedMessageEntry {
  queuedMessageId: string;
  position: number;
  source: "user" | "orca" | "scheduler" | "session";
  sourceLabel: string | null;
  enqueuedAtMs: number | null;
  content: string;
  consuming: boolean;
}

export interface SessionQueueDeps {
  listSessionQueue: (
    sessionId: string,
  ) => Promise<
    ControlResult<{ messages: SessionQueuedMessageEntry[] }, "NOT_FOUND">
  >;
  listSessionQueuedCounts: (
    sessionIds: string[],
  ) => Promise<ControlResult<{ counts: Record<string, number> }>>;
}

const DESCRIPTION =
  "只读列出本机任意 session 当前尚未消费的输入队列。每条返回队列位置、来源、入队时间、" +
  "正文摘要与 consuming 状态；consuming=true 表示该条正在投递。此工具不提供修改、撤回或重排。" +
  "session_id 建议来自 list_sessions。失败码: NOT_FOUND / HOST_NOT_READY / INTERNAL。";

export function registerListSessionQueueTool(
  registry: XdtHelperToolRegistry,
  deps: SessionQueueDeps,
): void {
  registry.register({
    name: "list_session_queue",
    category: "history",
    description: DESCRIPTION,
    inputShape: {
      session_id: z
        .string()
        .min(1)
        .describe("目标 session id，建议来自 list_sessions。"),
    },
    handler: async ({ session_id }) => {
      const result = await deps.listSessionQueue(session_id);
      if (!result.ok) {
        if (result.errorCode === "NOT_FOUND") {
          return errorPayload(
            "NOT_FOUND",
            `找不到 session ${session_id}，请先用 list_sessions 核对 id。`,
          );
        }
        if (result.errorCode === "HOST_NOT_READY") {
          return errorPayload(
            "HOST_NOT_READY",
            "本机 session 队列服务尚未就绪，请稍后重试。",
          );
        }
        return errorPayload("INTERNAL", result.message);
      }
      return okPayload({
        session_id,
        queued_count: result.messages.length,
        queue: result.messages.map((entry) => {
          const summary = summarizeContent(entry.content);
          const out: Record<string, unknown> = {
            queued_message_id: entry.queuedMessageId,
            position: entry.position,
            source: entry.source,
            enqueued_at:
              entry.enqueuedAtMs === null
                ? null
                : new Date(entry.enqueuedAtMs).toISOString(),
            content_summary: summary.text,
            truncated: summary.truncated,
            consuming: entry.consuming,
          };
          if (entry.sourceLabel !== null) out.source_label = entry.sourceLabel;
          return out;
        }),
      });
    },
  });
}

function summarizeContent(content: string): {
  text: string;
  truncated: boolean;
} {
  const normalized = content.replace(/\s+/gu, " ").trim();
  const chars = Array.from(normalized);
  if (chars.length <= MAX_CONTENT_SUMMARY_CHARS) {
    return { text: normalized, truncated: false };
  }
  return {
    text: `${chars.slice(0, MAX_CONTENT_SUMMARY_CHARS).join("")}…`,
    truncated: true,
  };
}
