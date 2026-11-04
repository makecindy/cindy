/**
 * 近况「每天帮我查一次」背后的「每天查待办」（cindy-bots-runtime.md §6.3.4「伙伴近况」）：主人在近况里打开时，
 * 宿主按默认内容建一条普通例行任务；之后名称、指令与时间和其它例行任务一样可改、可删，宿主不再改写。
 *
 * - 每个伙伴最多一条，id 固定为 todoCheckRoutineId(botId)，近况开关按 id 找到它；关掉只是暂停，删掉后再打开按默认内容重建。
 * - 什么算待办、去哪查由伙伴自己的记忆与技能决定（teammate-guide）；默认指令与「帮我查查」同一句。
 * - silentWhenIdle：没查到新待办不打扰主人。
 * - 早期版本把它存成宿主内置规则：调度器加载旧数据去掉内置标记的同时调用 localizedLegacyTodoCheck，把内置默认内容换成当前语言；
 *   只在这次迁移时做，之后主人保存的名称与指令不再被识别或改写。
 * - id 沿用 `builtin-` 前缀，运行仍按宿主发起（autonomous）判定身份，见 BUILTIN_ROUTINE_SCHEDULE_PREFIX。
 */
import { createHash } from 'node:crypto';
import type { Routine, RoutineInput } from '@cindy/maker-scheduler';
import { TODO_CHECK_ROUTINE_PREFIX } from '../../shared/botAutonomy.js';
import { t } from '../i18n.js';

/** 与例行任务引擎的 creationId 校验一致。 */
const ROUTINE_ID_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;

export function todoCheckRoutineId(botId: string): string {
  const plain = `${TODO_CHECK_ROUTINE_PREFIX}${botId}`;
  if (ROUTINE_ID_PATTERN.test(plain)) return plain;
  return `${TODO_CHECK_ROUTINE_PREFIX}${createHash('sha256').update(botId).digest('hex').slice(0, 40)}`;
}

/** 工作日 9:00，按这台电脑的时区。 */
export const TODO_CHECK_CRON = '0 9 * * 1-5';

/** 内置时期固定写入的名称与指令，只用来识别没人改过的旧规则。 */
const LEGACY_NAME = '每天查待办';
const LEGACY_PROMPT = '看看我已连接的邮箱、飞书等来源里，上次检查之后有没有需要我以后处理的新事项，有就按待办规则记下来。只用已经授权的来源，没连接的不要说查过；没有新待办就不用提醒我。';

/** 按主进程当前界面语言给出默认名称与指令。 */
function defaultContent(): Pick<RoutineInput, 'name' | 'prompt'> {
  return { name: t('routines.todoCheck.name'), prompt: t('bots.glance.checkPrompt') };
}

export function buildTodoCheckRoutineInput(timezone: string): RoutineInput {
  return {
    ...defaultContent(),
    enabled: true,
    silentWhenIdle: true,
    triggers: [{ id: 'weekday-morning', kind: 'cron', expression: TODO_CHECK_CRON, timezone }],
  };
}

/** 正在迁移的旧内置规则：仍是内置默认值的名称、指令换成当前语言的默认内容；没有要换的返回 null。 */
export function localizedLegacyTodoCheck(routine: Routine): Pick<RoutineInput, 'name' | 'prompt'> | null {
  const next = defaultContent();
  const name = routine.name === LEGACY_NAME ? next.name : routine.name;
  const prompt = routine.prompt === LEGACY_PROMPT ? next.prompt : routine.prompt;
  return name === routine.name && prompt === routine.prompt ? null : { name, prompt };
}
