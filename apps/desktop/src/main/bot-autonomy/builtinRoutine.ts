/**
 * 内置「跟进」例行任务的宿主模板：每个在用伙伴一条，id 固定为 builtinFollowUpRoutineId(botId)。
 *
 * - 6 个事件触发：订阅宿主内置事件源 `host:sessions`，只收 followerBotId 等于自己的事件
 *   （谁跟由层 0 状态表决定，伙伴之间不会收到彼此的事件）。其中 `sweep` 是程序级条件兜底：
 *   只有还有待处理任务、且距上次被叫醒满 `fallbackIntervalMs` 时宿主才发；没有定时触发，
 *   没事的伙伴不会被白叫醒。
 * - silentWhenIdle：没事可报时不打扰主人。
 * - 用户只能暂停 / 恢复，不能删除或改内容；宿主每次 ensure 时把指令与触发条件对齐到模板。
 */
import { createHash } from 'node:crypto';
import type { RoutineInput, RoutineTrigger } from '@cindy/maker-scheduler';
import {
  AUTONOMY_EVENT_TYPES,
  BUILTIN_FOLLOW_UP_ROUTINE_PREFIX,
  HOST_SESSIONS_SOURCE_ID,
} from '../../shared/botAutonomy.js';
import { FOLLOW_UP_PROMPT_VERSION, buildFollowUpRoutinePrompt } from './followUpPrompt.js';

/** 与例行任务引擎的 creationId 校验一致。 */
const ROUTINE_ID_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;

/**
 * 内置跟进规则的 id：前缀 + 伙伴 id 合法时原样拼接（已落盘的 id 不变）；伙伴 id 过长（合法伙伴 id 可到
 * 128 字符）或含引擎不接受的字符时，改用前缀 + 伙伴 id 的 sha256 前 40 位，长度与字符集都稳定合法。
 * 不要从 id 反推伙伴 id。
 */
export function builtinFollowUpRoutineId(botId: string): string {
  const plain = `${BUILTIN_FOLLOW_UP_ROUTINE_PREFIX}${botId}`;
  if (ROUTINE_ID_PATTERN.test(plain)) return plain;
  return `${BUILTIN_FOLLOW_UP_ROUTINE_PREFIX}${createHash('sha256').update(botId).digest('hex').slice(0, 40)}`;
}

/** 内置规则的保存名；渲染层按 builtin 字段本地化显示，这里只是落盘值。 */
export const FOLLOW_UP_ROUTINE_NAME = '跟进任务';

/**
 * 模板版本：随规则落盘（`builtinVersion`）。ensure 时版本不同就重写这条内置规则（即使正文恰好相同），
 * 指令措辞改动由 followUpPrompt.ts 的 FOLLOW_UP_PROMPT_VERSION 递增驱动。
 */
export const FOLLOW_UP_BUILTIN_VERSION = FOLLOW_UP_PROMPT_VERSION;

export function buildFollowUpRoutineInput(botId: string): RoutineInput {
  const triggers: RoutineTrigger[] = AUTONOMY_EVENT_TYPES.map((type): RoutineTrigger => ({
    id: `event-${type}`,
    kind: 'event',
    sourceId: HOST_SESSIONS_SOURCE_ID,
    eventType: type,
    filters: [{ field: 'followerBotId', operator: 'equals', value: botId }],
  }));
  return {
    name: FOLLOW_UP_ROUTINE_NAME,
    prompt: buildFollowUpRoutinePrompt(botId),
    enabled: true,
    silentWhenIdle: true,
    triggers,
  };
}
