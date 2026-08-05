import type { Schedule } from '@cindy/maker-scheduler';

import { buildPreRunHook } from './scheduleFormLogic';
import type { ScheduleFormState } from '../hooks/useScheduleForm';
import { stripTrailingPathSeparators } from '../../../../shared/pathText';
import { PROJECT_AUTOMATION_REL_SEGMENTS } from '../../../../shared/projectAutomationPaths';

export interface ProjectScheduleConfig {
  id: string;
  name: string;
  prompt: string;
  cronExpr: string;
  timezone?: string;
  recurring?: boolean;
  manual?: boolean;
  intervalMs?: number;
  agentKind?: 'claude-code' | 'codex';
  model?: string;
  effort?: string;
  /** Codex Fast 模式开关，仅 Codex 有意义。详见 Schedule.fastMode。 */
  fastMode?: boolean;
  useWorktree?: boolean;
  persistentSession?: boolean;
  silentWhenIdle?: boolean;
  /**
   * 前置检查脚本(Pre-run Hook)。省略 = 未启用;reconcile 时恒带 key,
   * 配置文件里删掉即清空 DB 里的 hook(与表单「恒带 key」语义一致)。
   * ⚠️ 与 main 侧 project-automation-loader.ts 的 ProjectScheduleConfig 保持同形。
   */
  preRunHook?: { command: string; timeoutMs?: number };
  notify?: { desktop?: boolean; feishu?: boolean };
}

export function generateProjectScheduleId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `auto-${random}`;
}

export function projectAutomationConfigPath(workingDir: string): string {
  const trimmed = stripTrailingPathSeparators(workingDir);
  const sep = trimmed.includes('\\') ? '\\' : '/';
  return [trimmed, ...PROJECT_AUTOMATION_REL_SEGMENTS].join(sep);
}

export function scheduleToProjectConfig(
  schedule: Schedule,
  id = schedule.projectConfigId ?? generateProjectScheduleId(),
): ProjectScheduleConfig {
  return {
    id,
    name: schedule.name,
    prompt: schedule.prompt,
    cronExpr: schedule.cronExpr,
    timezone: schedule.timezone,
    recurring: schedule.recurring,
    manual: schedule.manual,
    intervalMs: schedule.intervalMs,
    agentKind: schedule.agentKind,
    model: schedule.model,
    effort: schedule.effort,
    fastMode: schedule.fastMode,
    useWorktree: schedule.useWorktree,
    persistentSession: schedule.persistentSession,
    silentWhenIdle: schedule.silentWhenIdle,
    preRunHook: schedule.preRunHook?.command
      ? { command: schedule.preRunHook.command, timeoutMs: schedule.preRunHook.timeoutMs }
      : undefined,
    notify: schedule.notify,
  };
}

export function formToProjectConfig(
  form: ScheduleFormState,
  id: string,
): ProjectScheduleConfig {
  const cronExpr = form.cronExpr.trim();
  return {
    id,
    name: form.name.trim(),
    prompt: form.prompt,
    cronExpr,
    timezone: form.timezone.trim(),
    recurring: form.recurring,
    manual: form.manual,
    intervalMs: form.intervalMs,
    agentKind: form.agentKind,
    model: form.model.trim() || undefined,
    effort: form.effort || undefined,
    fastMode: form.agentKind === 'codex' && form.fastMode ? true : undefined,
    useWorktree: form.useWorktree,
    persistentSession: form.persistentSession,
    silentWhenIdle: form.silentWhenIdle,
    // 与 buildScheduleInput 同源:未启用为 undefined(JSON 序列化时省略该字段;
    // 类型上抹掉 null——那是 update patch 的清空语义,config 文件里用"字段缺席"表达)
    preRunHook: buildPreRunHook(form) ?? undefined,
    notify: { desktop: form.notifyDesktop, feishu: form.notifyFeishu },
  };
}
