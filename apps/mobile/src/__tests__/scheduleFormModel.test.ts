import { describe, expect, it } from 'vitest';
import {
  applyMobileTemplateParams,
  applyTemplateToMobileScheduleDraft,
  buildMobileScheduleInput,
  createMobileScheduleDraft,
  createTemplateParamDefaults,
  deriveMobileScheduleSessionMode,
  localizeScheduleDraftValidation,
  localizeTemplateParamValidation,
  MOBILE_SCHEDULE_PENDING_SESSION_ID,
  updateDraftAgentKind,
  updateDraftBoundSessionId,
  updateDraftSessionMode,
  validateTemplateParamValues,
  validateMobileScheduleDraft,
} from '@/scheduler/scheduleFormModel';
import type { RemoteSchedule, RemoteScheduleTemplate } from '@/scheduler/types';

function schedule(patch: Partial<RemoteSchedule> = {}): RemoteSchedule {
  return {
    id: 'sched-1',
    name: '桌面巡检',
    prompt: '检查项目状态',
    kind: 'cron',
    cronExpr: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    recurring: true,
    manual: false,
    agentKind: 'claude-code',
    workspaceKind: 'project',
    workingDir: '/repo/xdt-maker',
    useWorktree: false,
    persistentSession: false,
    notify: { desktop: true, feishu: false },
    status: 'active',
    ...patch,
  };
}

describe('mobile schedule form model', () => {
  it('builds a desktop-compatible create input for recurring project schedules', () => {
    const draft = createMobileScheduleDraft(null, { fallbackWorkingDir: '/repo/xdt-maker' });
    const input = buildMobileScheduleInput({
      ...draft,
      name: '移动端巡检',
      prompt: '每天检查 PR 状态',
      intervalMinutes: '15',
      effort: 'medium',
    });

    expect(input).toMatchObject({
      name: '移动端巡检',
      prompt: '每天检查 PR 状态',
      kind: 'cron',
      cronExpr: '*/15 * * * *',
      timezone: 'Asia/Shanghai',
      recurring: true,
      manual: false,
      intervalMs: 900_000,
      agentKind: 'claude-code',
      workspaceKind: 'project',
      workingDir: '/repo/xdt-maker',
      useWorktree: false,
      effort: 'medium',
      notify: { desktop: true, feishu: false },
    });
  });

  it('preserves hidden desktop-only schedule semantics when editing', () => {
    const draft = createMobileScheduleDraft(schedule({
      targetSessionId: 'session-1',
      persistentSession: true,
      silentWhenIdle: true,
      intervalMs: 3_600_000,
      notify: { desktop: false, feishu: true },
    }));
    const input = buildMobileScheduleInput({ ...draft, name: '更新后的巡检' });

    expect(draft.intervalMinutes).toBe('60');
    expect(input).toMatchObject({
      name: '更新后的巡检',
      targetSessionId: 'session-1',
      persistentSession: true,
      silentWhenIdle: true,
      notify: { desktop: false, feishu: true },
    });
  });

  it('keeps codex fast mode explicit and clears it when switching back to Claude', () => {
    const draft = updateDraftAgentKind(createMobileScheduleDraft(null), 'codex');
    expect(buildMobileScheduleInput({ ...draft, name: 'Codex', prompt: 'run', fastMode: true }))
      .toMatchObject({ agentKind: 'codex', model: 'gpt-5.5', fastMode: true });

    const claude = updateDraftAgentKind({ ...draft, fastMode: true }, 'claude-code');
    expect(buildMobileScheduleInput({ ...claude, name: 'Claude', prompt: 'run' })).not.toHaveProperty('fastMode');
  });

  it('validates required fields and supported interval-style cron presets', () => {
    const draft = createMobileScheduleDraft(null);
    expect(validateMobileScheduleDraft(draft)).toMatchObject({ field: 'name' });
    expect(validateMobileScheduleDraft({
      ...draft,
      name: 'Bad',
      prompt: 'run',
      intervalMinutes: '90',
    })).toMatchObject({
      field: 'intervalMinutes',
    });
    expect(validateMobileScheduleDraft({
      ...draft,
      name: 'Manual',
      prompt: 'run',
      runMode: 'manual',
      intervalMinutes: '90',
    })).toBeNull();
  });

  it('relocalizes a stored draft validation without rerunning validation rules', () => {
    const draft = createMobileScheduleDraft(null);
    const oldLocalizer = {
      translate: () => '旧语言错误',
    };
    const validation = validateMobileScheduleDraft(draft, oldLocalizer);

    expect(validation).toMatchObject({
      field: 'name',
      message: '旧语言错误',
      messageKey: 'devices.automations.presentation.validation.name',
    });
    expect(validation && localizeScheduleDraftValidation(validation, {
      translate: () => 'New locale error',
    })).toBe('New locale error');
  });

  it('relocalizes a stored template-parameter validation', () => {
    const template: RemoteScheduleTemplate = {
      id: 'custom',
      name: 'Custom',
      description: 'Custom',
      category: 'status-reports',
      source: 'builtin',
      parameters: [
        { key: 'project', label: 'Project', type: 'string', required: true },
      ],
    };
    const validation = validateTemplateParamValues(template, {}, {
      translate: () => '旧语言参数错误',
    });

    expect(validation).toMatchObject({
      field: 'prompt',
      message: '旧语言参数错误',
      messageKey: 'devices.automations.presentation.validation.templateParameter',
      messageValues: { label: 'Project' },
      parameterKey: 'project',
    });
    const relocalizedTemplate = {
      ...template,
      parameters: [
        { key: 'project', label: '项目', type: 'string' as const, required: true },
      ],
    };
    expect(validation && localizeTemplateParamValidation(
      validation,
      relocalizedTemplate,
      { translate: (_key, _fallback, values) => `新语言参数：${values?.label}` },
    )).toBe('新语言参数：项目');
  });

  it('does not require a project path when editing a bound desktop schedule', () => {
    const draft = createMobileScheduleDraft(schedule({
      workingDir: '',
      targetSessionId: 'session-1',
    }));

    expect(validateMobileScheduleDraft(draft)).toBeNull();
  });

  it('derives and switches fresh / persistent / bound session modes', () => {
    const draft = {
      ...createMobileScheduleDraft(null),
      name: 'Bound',
      prompt: 'run',
      workspaceKind: 'project' as const,
      workingDir: '/repo/xdt-maker',
      useWorktree: true,
    };

    expect(deriveMobileScheduleSessionMode(draft)).toBe('fresh');

    const pending = updateDraftSessionMode(draft, 'bound');
    expect(deriveMobileScheduleSessionMode(pending)).toBe('bound');
    expect(pending).toMatchObject({
      persistentSession: false,
      targetSessionId: MOBILE_SCHEDULE_PENDING_SESSION_ID,
      useWorktree: false,
    });
    expect(validateMobileScheduleDraft(pending)).toMatchObject({ field: 'targetSessionId' });

    const selected = updateDraftBoundSessionId({ ...pending, useWorktree: true }, 'session-1');
    expect(selected).toMatchObject({
      persistentSession: false,
      targetSessionId: 'session-1',
      useWorktree: false,
    });
    expect(validateMobileScheduleDraft(selected)).toBeNull();

    const persistent = updateDraftSessionMode(selected, 'persistent');
    expect(deriveMobileScheduleSessionMode(persistent)).toBe('persistent');
    expect(persistent).toMatchObject({
      persistentSession: true,
      targetSessionId: 'session-1',
    });

    const fresh = updateDraftSessionMode(persistent, 'fresh');
    expect(deriveMobileScheduleSessionMode(fresh)).toBe('fresh');
    expect(fresh).toMatchObject({
      persistentSession: false,
      targetSessionId: '',
    });
  });

  it('applies schedule templates using the desktop parameter semantics', () => {
    const template: RemoteScheduleTemplate = {
      id: 'daily',
      name: 'Daily Report',
      description: 'Daily status',
      category: 'status-reports',
      source: 'builtin',
      prompt: 'Summarize {{project}} with {{scope}}',
      cronExpr: '0 9 * * *',
      timezone: 'Asia/Shanghai',
      recurring: true,
      agentKind: 'codex',
      model: 'gpt-5.5',
      fastMode: true,
      notify: { desktop: true, feishu: false },
      parameters: [
        { key: 'project', label: 'Project', type: 'string', required: true, default: 'XDMaker' },
        { key: 'scope', label: 'Scope', type: 'string', required: false, default: 'today' },
      ],
    };
    const defaults = createTemplateParamDefaults(template);
    const draft = applyTemplateToMobileScheduleDraft(createMobileScheduleDraft(null), template, defaults);

    expect(defaults).toEqual({ project: 'XDMaker', scope: 'today' });
    expect(draft).toMatchObject({
      name: 'Daily Report',
      prompt: 'Summarize XDMaker with today',
      agentKind: 'codex',
      model: 'gpt-5.5',
      fastMode: true,
    });
    expect(applyMobileTemplateParams(template.prompt!, { project: 'Mobile', scope: 'week' }, template.parameters))
      .toBe('Summarize Mobile with week');
    expect(validateTemplateParamValues(template, { scope: 'today' })).toBeNull();
  });

  it('flags missing required template parameters without defaults', () => {
    const template: RemoteScheduleTemplate = {
      id: 'custom',
      name: 'Custom',
      description: 'Custom',
      category: 'status-reports',
      source: 'builtin',
      parameters: [
        { key: 'project', label: 'Project', type: 'string', required: true },
      ],
    };

    expect(validateTemplateParamValues(template, {})).toMatchObject({
      field: 'prompt',
      message: '请输入模板参数：Project',
      messageKey: 'devices.automations.presentation.validation.templateParameter',
      messageValues: { label: 'Project' },
      parameterKey: 'project',
    });
    expect(() => applyMobileTemplateParams('Run {{project}}', {}, template.parameters))
      .toThrow('Missing required template parameter');
  });
});
