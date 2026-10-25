/**
 * xdt-helper/get_task_digest.ts —— history 类:一件任务的短摘要(≤2KB)。
 *
 * 给被程序叫醒的伙伴用:先读这一份再决定继续、代答、换模型还是提醒主人,不必拉整段聊天记录。
 * 本机任务直接给 id;另一台电脑上的任务写 deviceId::sessionId(只读,对方须在线)。
 * 宿主负责取数;本文件只负责输出合同:每段文字 ≤300 字,整份 JSON ≤2KB(UTF-8 字节),
 * 超出时先收紧长文字、最后置空,不截断成非法 JSON。
 */
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import type { XdtHelperHistoryDeps } from './_history_types.js';
import { resolveHistoryScope } from './_history_scope.js';
import { errorPayload, okPayload } from './_payload.js';

export type TaskDigestPhase =
  | 'running'
  | 'waiting-permission'
  | 'waiting-answer'
  | 'errored'
  | 'usage-limit'
  | 'finished'
  | 'idle';

export interface TaskDigestRoute {
  harness: 'claude-code' | 'codex' | 'pi';
  provider_id: string | null;
  model: string;
  effort: string | null;
  fast: boolean | 'ultrafast';
}

export interface TaskDigestWire {
  session_id: string;
  /** 另一台电脑的名字;本机为 null。 */
  device: string | null;
  title: string;
  phase: TaskDigestPhase;
  /** 处于当前状态(或本轮运行)多少分钟;未知为 null。 */
  elapsed_minutes: number | null;
  /** 距离任务最后一次有动静(输出、工具结果)多少分钟;未知为 null。 */
  idle_minutes: number | null;
  /** 当前有工具调用正在执行(长时间构建 / 测试);宿主不知道时不出现这个字段。 */
  tool_in_flight?: boolean;
  last_user_ask: string | null;
  last_assistant_line: string | null;
  pending_question: string | null;
  error: string | null;
  current_route: TaskDigestRoute | null;
  /** set_session_runtime 的 expected_generation;另一台电脑上的任务为 null。 */
  runtime_generation: number | null;
  /** 调用方伙伴候选链里的下一条可用路线;没有则 null。 */
  suggested_route: TaskDigestRoute | null;
  pr_status: string | null;
  queued_count: number | null;
  follower_bot_id: string | null;
  creator_bot_id: string | null;
  /**
   * 共享给访客的任务:里面有账号外的人发的话。为 true 时不给 last_user_ask / last_assistant_line,
   * 伙伴不得据它自主行动,只告诉主人。
   */
  shared_task?: boolean;
}

export const TASK_DIGEST_MAX_BYTES = 2048;
export const TASK_DIGEST_TEXT_MAX = 300;
const TITLE_MAX = 120;
const SHRINKABLE = ['last_assistant_line', 'last_user_ask', 'pending_question', 'error', 'pr_status'] as const;

function clip(value: string | null | undefined, max: number, keepEnd = false): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  if (!keepEnd) return `${chars.slice(0, max - 1).join('')}…`;
  const head = Math.floor((max - 1) / 2);
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - (max - 1 - head)).join('')}`;
}

const encoder = new TextEncoder();
const payloadBytes = (digest: TaskDigestWire) =>
  encoder.encode(JSON.stringify({ ok: true, ...digest })).length;

/** 输出合同:文字逐段 ≤300 字,整份(含 ok 外壳)≤2KB。 */
export function boundTaskDigest(raw: TaskDigestWire): TaskDigestWire {
  const digest: TaskDigestWire = {
    ...raw,
    title: clip(raw.title, TITLE_MAX) ?? '',
    last_user_ask: clip(raw.last_user_ask, TASK_DIGEST_TEXT_MAX),
    last_assistant_line: clip(raw.last_assistant_line, TASK_DIGEST_TEXT_MAX, true),
    pending_question: clip(raw.pending_question, TASK_DIGEST_TEXT_MAX),
    error: clip(raw.error, TASK_DIGEST_TEXT_MAX),
    pr_status: clip(raw.pr_status, TASK_DIGEST_TEXT_MAX),
  };
  for (let max = TASK_DIGEST_TEXT_MAX; payloadBytes(digest) > TASK_DIGEST_MAX_BYTES && max >= 20; max = Math.floor(max / 2)) {
    for (const key of SHRINKABLE) digest[key] = clip(digest[key], max, key === 'last_assistant_line');
    digest.title = clip(digest.title, Math.min(TITLE_MAX, max)) ?? '';
  }
  // 极端情况(超长 id / 模型名):去掉可选文字,保证合同成立。
  for (const key of SHRINKABLE) {
    if (payloadBytes(digest) <= TASK_DIGEST_MAX_BYTES) break;
    digest[key] = null;
  }
  if (payloadBytes(digest) > TASK_DIGEST_MAX_BYTES) {
    digest.suggested_route = null;
    digest.title = clip(digest.title, 20) ?? '';
  }
  return digest;
}

const DESCRIPTION = [
  '读一件任务的短摘要(≤2KB):状态 phase、已持续分钟数、最近用户消息(排除隐藏协调/续跑输入)、最新助手回复首尾片段、待回答的问题、错误、当前模型路线、',
  '建议换到的下一条路线(只在出错或撞用量上限、换模型确实有用且装得下当前上下文时,给你候选链里还没试过的那条;否则 null,此时提醒主人)、PR 状态、排队消息数、谁开的 / 谁在跟。',
  'idle_minutes 距最后一次动静的分钟数;tool_in_flight 为 true 表示有工具调用(如长时间构建、测试)正在执行,宿主不知道时不出现。',
  '被程序叫醒跟进任务时先读这一份再决定;要看原文再用 get_chat_history。',
  '作用范围:本机任务直接传 id;另一台电脑上的任务传 deviceId::sessionId(只读,对方须在线)。',
  'phase:running 运行中 / waiting-permission 等权限 / waiting-answer 等回答 / errored 出错 / usage-limit 撞用量上限 / finished 本轮已结束 / idle 空闲。',
  'finished 只描述所查任务的本轮，不代表它委派的后台任务或用户目标已完成。下一条消息的派发仍由该任务的实时运行状态和输入队列决定。',
  'suggested_route 只供判断，不是换模型授权。获得目标和变更的明确授权后才用 set_session_runtime(expected_generation 填 runtime_generation;只支持本机任务)。',
].join('\n');

export interface GetTaskDigestToolDeps {
  history: XdtHelperHistoryDeps;
  getSessionContext?: () => LiziMcpSessionContext | undefined;
}

export function registerGetTaskDigestTool(
  registry: XdtHelperToolRegistry,
  deps: GetTaskDigestToolDeps,
): void {
  const read = deps.history.taskDigest;
  if (!read) return;
  registry.register({
    name: 'get_task_digest',
    category: 'history',
    description: DESCRIPTION,
    inputShape: {
      session_id: z
        .string()
        .min(1)
        .max(512)
        .describe('任务 id;另一台电脑上的任务写 deviceId::sessionId'),
    },
    handler: async ({ session_id }) => {
      const scope = await resolveHistoryScope(deps.history, deps.getSessionContext, [session_id]);
      if (!scope.ok) return errorPayload(scope.errorCode, scope.message);
      if (scope.deniedSessionIds.length > 0) {
        return errorPayload('HISTORY_SCOPE_DENIED', '这件任务不在你可读取的范围内。', {
          denied_session_ids: scope.deniedSessionIds,
        });
      }
      const result = await read({
        sessionId: session_id,
        callerSessionId: deps.getSessionContext?.()?.sessionId,
      });
      if (!result.ok) return errorPayload(result.errorCode, result.message);
      return okPayload({ ...boundTaskDigest(result.digest) });
    },
  });
}
