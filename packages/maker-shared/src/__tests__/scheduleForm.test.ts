import { describe, expect, it } from 'vitest';
import {
  applyMobileTemplateParams,
  applyTemplateToMobileScheduleDraft,
  buildMobileScheduleInput,
  createMobileScheduleDraft,
  createTemplateParamDefaults,
  deriveMobileScheduleSessionMode,
  MOBILE_SCHEDULE_PENDING_SESSION_ID,
  updateDraftAgentKind,
  updateDraftBoundSessionId,
  updateDraftSessionMode,
  validateTemplateParamValues,
  validateMobileScheduleDraft,
} from '../scheduleForm.js';
import type { RemoteSchedule, RemoteScheduleTemplate } from '../scheduleTypes.js';

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

  it('matches desktop heartbeat update semantics for bound sessions', () => {
    const draft = createMobileScheduleDraft(schedule({
      agentKind: 'codex',
      model: '',
      effort: '',
      fastMode: true,
      targetSessionId: 'session-1',
      persistentSession: false,
      useWorktree: true,
    }));
    const input = buildMobileScheduleInput(draft);

    expect(input.targetSessionId).toBe('session-1');
    expect(input.useWorktree).toBe(false);
    expect(hasOwn(input, 'workingDir')).toBe(false);
    expect(hasOwn(input, 'model')).toBe(true);
    expect(hasOwn(input, 'effort')).toBe(true);
    expect(input.model).toBeUndefined();
    expect(input.effort).toBeUndefined();
    expect(hasOwn(input, 'fastMode')).toBe(false);
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

  it('does not block editing a script-only desktop schedule on an empty prompt (codex review 966)', () => {
    // 桌面端"仅运行脚本"任务(见 docs/dev-rules/remote-and-mobile-adaptation.md)prompt 合法为空——mobile
    // 没有编辑 scriptConfig 的 UI,不该拿桌面端才有意义的字段挡住 mobile 打开/
    // 保存这类任务的其它字段(改名、通知开关等)。
    const draft = createMobileScheduleDraft(schedule({
      prompt: undefined,
      executionMode: 'script',
    }));

    expect(draft.executionMode).toBe('script');
    expect(validateMobileScheduleDraft(draft)).toBeNull();
    // executionMode 只读,不回写进 write input——引擎侧 patch 合并时缺这个 key
    // 才会保留原有值,若这里显式带上反而有被误改成别的值的风险。
    expect(hasOwn(buildMobileScheduleInput({ ...draft, name: '更新后的脚本任务' }), 'executionMode'))
      .toBe(false);
  });

  it('pins agent-only fields back to script-safe values when serializing a script draft (codex review 966 second pass)', () => {
    // 表单残留或误操作把 draft 拨到 script 非法组合(worktree/绑定/持续会话/
    // dialogue 工作区/静默)时,序列化层必须钉回合法值——否则引擎合并态校验
    // 直接拒绝整个 patch,一个可见控件就能让保存失败。
    const draft = {
      ...createMobileScheduleDraft(schedule({ prompt: undefined, executionMode: 'script' })),
      workspaceKind: 'dialogue' as const,
      useWorktree: true,
      persistentSession: true,
      targetSessionId: 'sess-oops',
      silentWhenIdle: true,
    };
    const input = buildMobileScheduleInput(draft);

    expect(input).toMatchObject({
      workspaceKind: 'project',
      workingDir: '/repo/xdt-maker',
      useWorktree: false,
      persistentSession: false,
      silentWhenIdle: false,
    });
    expect(input.targetSessionId).toBeUndefined();
  });

  it('still requires a prompt for a regular agent-mode schedule', () => {
    const draft = createMobileScheduleDraft(schedule({ prompt: '' }));
    expect(validateMobileScheduleDraft(draft)).toMatchObject({ field: 'prompt' });
  });

  it('does not require a project path when editing a bound desktop schedule', () => {
    const draft = createMobileScheduleDraft(schedule({
      workingDir: '',
      targetSessionId: 'session-1',
    }));

    expect(validateMobileScheduleDraft(draft)).toBeNull();
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

  it('switches a worktree template draft into project workspace so useWorktree survives serialization', () => {
    const template: RemoteScheduleTemplate = {
      id: 'nightly-test-heal',
      name: '夜间自愈测试',
      description: 'Nightly test healing',
      category: 'dev-automation',
      source: 'builtin',
      prompt: 'Run tests and fix failures',
      cronExpr: '0 2 * * *',
      timezone: 'Asia/Shanghai',
      recurring: true,
      agentKind: 'claude-code',
      useWorktree: true,
      notify: { desktop: true, feishu: false },
    };
    // 默认空 draft 是 dialogue workspace；不切 project 的话 useWorktree 会在
    // buildMobileScheduleInput 里被静默打回 false（review #316 P1）。
    const draft = applyTemplateToMobileScheduleDraft(createMobileScheduleDraft(null), template);

    expect(draft.workspaceKind).toBe('project');
    expect(draft.useWorktree).toBe(true);
    expect(validateMobileScheduleDraft(draft)).toMatchObject({ field: 'workingDir' });
    expect(buildMobileScheduleInput({ ...draft, workingDir: '/repo' }).useWorktree).toBe(true);

    // 绑定会话的 draft 上应用 worktree 模板：绑定与 worktree 互斥，必须清掉
    // targetSessionId，否则序列化的 heartbeat 分支同样会打回 false。
    const boundDraft = updateDraftBoundSessionId(createMobileScheduleDraft(null), 'session-1');
    const fromBound = applyTemplateToMobileScheduleDraft(boundDraft, template);
    expect(fromBound.targetSessionId).toBe('');
    expect(fromBound.useWorktree).toBe(true);
    expect(buildMobileScheduleInput({ ...fromBound, workingDir: '/repo' }).useWorktree).toBe(true);
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

    expect(validateTemplateParamValues(template, {})).toBe('请输入模板参数：Project');
    expect(() => applyMobileTemplateParams('Run {{project}}', {}, template.parameters))
      .toThrow('Missing required template parameter');
  });
});

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
