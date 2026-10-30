/**
 * 内置「夜间学习」例行任务（bot-routines.md「内置夜间学习」）：每个在用伙伴默认一条，只在主力电脑上建。
 *
 * - 例行任务只负责「什么时候」和「开没开」：到点后 routines/service.ts 的 execute 直接交给宿主里的
 *   runNightlyLearning，不派到伙伴主对话，指令正文不会进伙伴上下文。
 * - 频率每天 / 每周存在伙伴的 nightly-learning.json（缺省 = 每天），改频率时宿主按新模板重写这条规则；
 *   用户只能暂停 / 恢复，不能改内容或删除。
 * - silentWhenIdle：整理结果只进学习记录，不发聊天消息或推送。
 */
import { createHash } from 'node:crypto';
import type { RoutineInput } from '@cindy/maker-scheduler';
import { BUILTIN_NIGHTLY_LEARNING_ROUTINE_PREFIX } from '../../shared/botAutonomy.js';
import type { NightlyLearningFrequency } from '../../shared/botNightlyLearning.js';

/** 与例行任务引擎的 creationId 校验一致。 */
const ROUTINE_ID_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;

export function builtinNightlyLearningRoutineId(botId: string): string {
  const plain = `${BUILTIN_NIGHTLY_LEARNING_ROUTINE_PREFIX}${botId}`;
  if (ROUTINE_ID_PATTERN.test(plain)) return plain;
  return `${BUILTIN_NIGHTLY_LEARNING_ROUTINE_PREFIX}${createHash('sha256').update(botId).digest('hex').slice(0, 40)}`;
}

/** 模板版本：改触发方式或指令措辞时递增，下次 ensure 重写。 */
export const NIGHTLY_LEARNING_BUILTIN_VERSION = 1;

/** 内置规则的保存名；渲染层按 builtin 字段本地化显示，这里只是落盘值。 */
export const NIGHTLY_LEARNING_ROUTINE_NAME = '夜间学习';

/** 每天 3:30；每周一 3:30。按这台电脑的时区。 */
export const NIGHTLY_LEARNING_CRON: Record<NightlyLearningFrequency, string> = {
  daily: '30 3 * * *',
  weekly: '30 3 * * 1',
};

export function buildNightlyLearningRoutineInput(frequency: NightlyLearningFrequency, timezone: string): RoutineInput {
  return {
    name: NIGHTLY_LEARNING_ROUTINE_NAME,
    // 宿主在 execute 里直接执行，不把这段发给伙伴；只用于例行任务列表与运行记录。
    prompt: 'Nightly learning runs inside the host: tidy this teammate\'s memories and Skills from conversations since the last run.',
    enabled: true,
    silentWhenIdle: true,
    // 本版在 execute 里提前返回，不会执行这个前置检查；降级后的旧版不认识这条内置规则，
    // 会把它当普通规则派给伙伴，前置检查以 exit 2 跳过，不调用模型。
    preRunHook: { command: 'exit 2', timeoutMs: 10_000 },
    triggers: [{ id: `nightly-${frequency}`, kind: 'cron', expression: NIGHTLY_LEARNING_CRON[frequency], timezone }],
  };
}
