// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Schedule, ScheduleTemplate } from '@cindy/maker-scheduler';
import type { ProviderView } from '@cindy/model-providers';
import type { Session } from '@/lib/ccAgent.types';

import { useScheduleForm } from '../useScheduleForm';
import { formToProjectConfig } from '../../lib/projectAutomationConfig';

it('keeps a blank reminder audible until the user opts into quiet checks', () => {
  const { result } = renderHook(() => useScheduleForm(null));
  expect(result.current.toInput().silentWhenIdle).toBe(false);
  act(() => result.current.setField('silentWhenIdle', true));
  expect(result.current.toInput().silentWhenIdle).toBe(true);
});

/**
 * 回归(codex review #966):script 模式不展示前置检查区块,buildScheduleInput
 * 只保留已有的非空检查。若用户在 agent 模式下开了前置检查、命令留空,
 * 再切到 script,validate 不该沿用那条校验——否则用户看不到该区块、点不到
 * 那个开关,却被挡在保存之外。
 */
describe('useScheduleForm validate — script 模式跳过隐藏的前置检查校验', () => {
  it('agent 模式下 preRunHookEnabled=true 且命令为空时校验拦下(既有行为不变)', () => {
    const { result } = renderHook(() => useScheduleForm(null));
    act(() => {
      result.current.setField('name', 'test');
      result.current.setField('prompt', '/standup');
      result.current.setField('preRunHookEnabled', true);
      result.current.setField('preRunHookCommand', '');
    });
    expect(result.current.validate()).toEqual({
      key: 'scheduler.editor.validation.preRunHookCommandRequired',
    });
  });

  it('切到 script 模式后,残留的 preRunHookEnabled=true + 空命令不再拦截保存', () => {
    const { result } = renderHook(() => useScheduleForm(null));
    act(() => {
      result.current.setField('name', 'test');
      result.current.setField('preRunHookEnabled', true);
      result.current.setField('preRunHookCommand', '');
      result.current.setField('executionMode', 'script');
      result.current.setField('scriptCommand', 'python demo.py');
      result.current.setField('workingDir', '/repo');
    });
    expect(result.current.validate()).toBeNull();
  });
});


describe('saved automation model selection', () => {
  const template: ScheduleTemplate = {
    id: 'model-template', name: 'Model template', description: '',
    category: 'code-quality', source: 'builtin',
  };

  // Merge regression, unit/jsdom: opening and renaming a legacy persistent task
  // must retain its fresh-run default without pinning its existing task location.
  it('keeps legacy location semantics until the user explicitly changes the selection', () => {
    const saved = { id: 'legacy', name: 'Legacy', prompt: 'run', cronExpr: '0 * * * *',
      timezone: 'UTC', recurring: true, agentKind: 'codex', model: 'remote-model',
      providerId: 'remote-provider', agentDeviceId: 'studio', persistentSession: true,
      targetSessionId: 'bound-task', notify: { desktop: true, feishu: false } } as Schedule;
    const { result } = renderHook(() => useScheduleForm(saved));
    act(() => result.current.setField('name', 'Renamed'));
    expect(result.current.toInput()).toMatchObject({ name: 'Renamed', agentDeviceId: 'studio',
      modelAgentDeviceId: undefined, modelAgentKind: undefined });
    act(() => result.current.selectModelConfiguration(null));
    expect(result.current.toInput()).toMatchObject({ agentDeviceId: undefined,
      modelAgentDeviceId: undefined, model: undefined });
  });

  // PR #6830 merge review, unit/jsdom: without matching local history a provider-only
  // template used to clear its local intent and leave the bound task on a share.
  it.each([true, false])('keeps a local template complete or blocks saving (catalog ready=%s)', (ready) => {
    const { result } = renderHook(() => useScheduleForm(null));
    act(() => {
      result.current.setField('name', 'Template');
      result.current.setField('prompt', 'Run');
      result.current.selectBoundSession({ id: 'remote-task', agentKind: 'codex' } as Session);
    });
    act(() => result.current.selectModelConfiguration({ agentKind: 'codex', model: 'remote-model',
      providerId: 'remote-provider', modelAgentDeviceId: 'shared:owner', effort: 'high', fastMode: false }));
    const providers = [{ id: 'template-local-provider', name: 'Local', source: 'user', connected: true,
      agents: ['codex'], models: { codex: [{ id: 'local-model', name: 'Local model' }] },
      routing: { codex: {} }, auth: { method: 'none' },
    }] as ProviderView[];
    act(() => result.current.applyTemplateAgentFields({ ...template, providerId: 'template-local-provider' },
      ready ? providers : undefined));
    expect(result.current.toInput()).toMatchObject({ targetSessionId: 'remote-task',
      modelAgentKind: 'codex', modelAgentDeviceId: '', providerId: 'template-local-provider',
      model: ready ? 'local-model' : undefined });
    expect(result.current.validate()).toEqual(ready ? null : {
      key: 'scheduler.editor.validation.modelUnavailable', values: { model: 'template-local-provider' },
    });
  });

  // PR #6830: the hook used to reset location separately from the retained route.
  // Unit/jsdom: apply a same-Harness template to a shared choice, then serialize it.
  it('keeps the shared route when a template only repeats the current Harness', () => {
    const { result } = renderHook(() => useScheduleForm(null));
    const route = { agentKind: 'claude-code' as const, model: 'remote-model', providerId: 'remote-provider',
      modelAgentDeviceId: 'shared:owner', effort: 'high' as const, fastMode: true };
    act(() => result.current.selectModelConfiguration(route));
    act(() => result.current.applyTemplateAgentFields({ ...template, agentKind: route.agentKind }));
    expect(result.current.toInput()).toMatchObject({ modelAgentDeviceId: route.modelAgentDeviceId,
      agentKind: route.agentKind, model: route.model, providerId: route.providerId });
  });

  // A partial local template must not combine its model/provider with the old share.
  it.each([
    { override: { model: 'local-model' }, legacy: false },
    { override: { providerId: 'local-provider' }, legacy: false },
    { override: { model: 'local-model' }, legacy: true },
    { override: { providerId: 'local-provider' }, legacy: true },
  ])('discards inherited shared fields when applying a local route %j', ({ override, legacy }) => {
    const { result } = renderHook(() => useScheduleForm(null));
    act(() => result.current.selectModelConfiguration({ agentKind: 'claude-code', model: 'remote-model',
      providerId: 'remote-provider', modelAgentDeviceId: 'shared:owner', effort: 'high', fastMode: true }));
    if (legacy) act(() => {
      result.current.setField('modelAgentDeviceId', undefined);
      result.current.setField('agentDeviceId', 'studio');
    });
    act(() => result.current.applyTemplateAgentFields({ ...template, ...override }));
    expect(result.current.form).toMatchObject({ ...override, modelAgentDeviceId: '' });
    expect(result.current.form.model).not.toBe('remote-model');
    expect(result.current.form.providerId).not.toBe('remote-provider');
  });

  it.each(['codex', 'pi'] as const)('saves the %s template Harness with its model after binding a task', (agentKind) => {
    const { result } = renderHook(() => useScheduleForm(null));
    act(() => result.current.selectBoundSession({ id: 'bound-codex', agentKind: 'codex' } as Session));
    expect(result.current.toInput()).toHaveProperty('modelAgentKind', undefined);

    act(() => result.current.applyTemplateAgentFields({
      ...template, agentKind, model: 'template-model', providerId: 'custom', effort: 'medium', fastMode: true,
    }));
    expect(result.current.toInput()).toMatchObject({
      targetSessionId: 'bound-codex', agentKind: 'codex', modelAgentKind: agentKind,
      model: 'template-model', providerId: 'custom', effort: 'medium', fastMode: true,
    });

    act(() => result.current.selectModelConfiguration(null));
    expect(result.current.toInput()).toMatchObject({
      targetSessionId: 'bound-codex', agentKind: 'codex', modelAgentKind: undefined,
      model: undefined, providerId: undefined, effort: undefined, fastMode: undefined,
    });
  });

  it('keeps following the bound task when the template supplies no model selection', () => {
    const { result } = renderHook(() => useScheduleForm(null));
    act(() => result.current.selectBoundSession({ id: 'bound-codex', agentKind: 'codex' } as Session));
    act(() => result.current.applyTemplateAgentFields(template));
    expect(result.current.toInput()).toMatchObject({
      targetSessionId: 'bound-codex', agentKind: 'codex', modelAgentKind: undefined,
      model: undefined, providerId: undefined, effort: undefined, fastMode: undefined,
    });
  });

  it('saves every selected axis for the next fire and clears all overrides when following the task', () => {
    const { result } = renderHook(() => useScheduleForm(null));
    const baselineAgent = result.current.form.agentKind;
    act(() => result.current.setField('targetSessionId', 'existing-task'));
    act(() => result.current.selectModelConfiguration({
      agentKind: 'pi', model: 'test-model', providerId: 'custom', effort: 'medium', fastMode: true,
    }));
    expect(result.current.toInput()).toMatchObject({
      targetSessionId: 'existing-task', agentKind: baselineAgent, modelAgentKind: 'pi',
      model: 'test-model', providerId: 'custom', effort: 'medium', fastMode: true,
    });
    act(() => result.current.setRunMode('fresh'));
    act(() => result.current.setRunMode('bound'));
    expect(result.current.toInput()).toMatchObject({ modelAgentKind: 'pi', model: 'test-model', fastMode: true });
    act(() => result.current.selectModelConfiguration(null));
    expect(result.current.toInput()).toMatchObject({ modelAgentKind: undefined, model: undefined, effort: undefined, providerId: undefined });
    expect(result.current.form.fastMode).toBe(false);
    expect(result.current.toInput()).toHaveProperty('fastMode', undefined);
  });

  it('restores the bound Harness after an explicit override and fresh/persistent round trip', () => {
    const { result } = renderHook(() => useScheduleForm(null));
    act(() => result.current.selectBoundSession({ id: 'bound-codex', agentKind: 'codex' } as Session));
    act(() => result.current.setRunMode('persistent'));
    act(() => result.current.selectModelConfiguration({
      agentKind: 'pi', model: 'test-model', providerId: 'custom', effort: 'medium', fastMode: true,
    }));
    act(() => result.current.setRunMode('fresh'));
    act(() => result.current.setRunMode('persistent'));
    act(() => result.current.selectModelConfiguration(null));
    expect(result.current.toInput()).toMatchObject({
      targetSessionId: 'bound-codex', persistentSession: true, agentKind: 'codex',
      modelAgentKind: undefined, model: undefined, effort: undefined, providerId: undefined,
    });
    expect(result.current.form.fastMode).toBe(false);
  });

  it('uses the current bound reference when reopening a saved override', () => {
    const { result } = renderHook(() => useScheduleForm(null));
    const saved = { ...result.current.toInput(), id: 'schedule', targetSessionId: 'bound-codex',
      agentKind: 'pi', modelAgentKind: 'pi', model: 'test-model' } as Schedule;
    act(() => result.current.reset(saved));
    act(() => result.current.selectModelConfiguration(null, 'codex'));
    expect(result.current.toInput()).toMatchObject({ agentKind: 'codex', modelAgentKind: undefined });
    act(() => result.current.selectModelConfiguration({
      agentKind: 'pi', model: 'test-model', providerId: 'custom', effort: 'medium', fastMode: false,
    }));
    act(() => result.current.selectModelConfiguration(null));
    expect(result.current.toInput()).toMatchObject({ agentKind: 'codex', modelAgentKind: undefined });
  });

  it.each([false, true])('preserves the bound baseline across save, reopen and follow (persistent: %s)', (persistentSession) => {
    const { result } = renderHook(() => useScheduleForm(null));
    const saved = { ...result.current.toInput(), id: 'schedule', targetSessionId: 'bound-codex',
      agentKind: 'codex', modelAgentKind: 'pi', model: 'test-model', persistentSession } as Schedule;
    act(() => result.current.reset(saved));
    act(() => result.current.setField('name', 'Renamed'));
    expect(result.current.form.agentKind).toBe('pi');
    const input = result.current.toInput();
    expect(input).toMatchObject({ name: 'Renamed', agentKind: 'codex', modelAgentKind: 'pi', model: 'test-model' });
    expect(input).not.toHaveProperty('boundAgent');
    expect(formToProjectConfig(result.current.form, 'daily')).toMatchObject({ agentKind: 'codex', modelAgentKind: 'pi' });
    act(() => result.current.reset({ ...saved, ...input } as Schedule));
    act(() => result.current.setRunMode('fresh'));
    expect(result.current.toInput()).toMatchObject({ agentKind: 'pi', modelAgentKind: 'pi', targetSessionId: undefined });
    act(() => result.current.setRunMode(persistentSession ? 'persistent' : 'bound'));
    expect(result.current.toInput()).toMatchObject({ agentKind: 'codex', modelAgentKind: 'pi' });
    act(() => result.current.selectModelConfiguration(null));
    expect(result.current.toInput()).toMatchObject({ agentKind: 'codex', modelAgentKind: undefined, model: undefined });
  });

  it('does not restore a previous target Harness after selecting another bound task', () => {
    const { result } = renderHook(() => useScheduleForm(null));
    act(() => result.current.selectBoundSession({ id: 'old', agentKind: 'codex' } as Session));
    act(() => result.current.selectBoundSession({ id: 'new', agentKind: 'cc' } as Session));
    act(() => result.current.selectModelConfiguration({
      agentKind: 'pi', model: 'test-model', providerId: 'custom', effort: 'medium', fastMode: false,
    }));
    act(() => result.current.selectModelConfiguration(null));
    expect(result.current.toInput()).toMatchObject({ targetSessionId: 'new', agentKind: 'claude-code' });
  });
});
