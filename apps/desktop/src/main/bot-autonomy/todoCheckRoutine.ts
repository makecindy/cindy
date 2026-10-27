/**
 * 内置「每天查待办」例行任务（cindy-bots-runtime.md §6.3.4「伙伴近况」）：主人在近况里打开
 * 「每天帮我查一次」时才建，工作日 9:00 让伙伴在已授权的来源里找需要主人以后处理的新事项。
 *
 * - 每个伙伴最多一条，id 固定为 builtinTodoCheckRoutineId(botId)；关掉只是暂停，再打开恢复同一条。
 * - 指令是例行任务那一轮的用户侧指令，不是 system 段；改措辞要递增 TODO_CHECK_PROMPT_VERSION，
 *   下次打开时宿主按新模板重写。
 * - silentWhenIdle：没查到新待办不打扰主人。
 * - 与内置「跟进」一样不参与云端同步，只在当前运行的电脑上存在。
 */
import { createHash } from 'node:crypto';
import type { RoutineInput } from '@cindy/maker-scheduler';
import { BUILTIN_TODO_CHECK_ROUTINE_PREFIX } from '../../shared/botAutonomy.js';

/** 与例行任务引擎的 creationId 校验一致。 */
const ROUTINE_ID_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;

export function builtinTodoCheckRoutineId(botId: string): string {
  const plain = `${BUILTIN_TODO_CHECK_ROUTINE_PREFIX}${botId}`;
  if (ROUTINE_ID_PATTERN.test(plain)) return plain;
  return `${BUILTIN_TODO_CHECK_ROUTINE_PREFIX}${createHash('sha256').update(botId).digest('hex').slice(0, 40)}`;
}

export const TODO_CHECK_PROMPT_VERSION = 1;

/** 内置规则的保存名；渲染层按 builtin 字段本地化显示，这里只是落盘值。 */
export const TODO_CHECK_ROUTINE_NAME = '每天查待办';

/** 工作日 9:00，按这台电脑的时区。 */
export const TODO_CHECK_CRON = '0 9 * * 1-5';

export function buildTodoCheckRoutinePrompt(): string {
  return '看看我已连接的邮箱、飞书等来源里，上次检查之后有没有需要我以后处理的新事项，有就按待办规则记下来。只用已经授权的来源，没连接的不要说查过；没有新待办就不用提醒我。';
}

export function buildTodoCheckRoutineInput(timezone: string): RoutineInput {
  return {
    name: TODO_CHECK_ROUTINE_NAME,
    prompt: buildTodoCheckRoutinePrompt(),
    enabled: true,
    silentWhenIdle: true,
    triggers: [{ id: 'weekday-morning', kind: 'cron', expression: TODO_CHECK_CRON, timezone }],
  };
}
