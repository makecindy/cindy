// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useScheduleForm } from '../useScheduleForm';

/**
 * 回归(codex review #966):script 模式不展示前置检查区块,buildScheduleInput
 * 的 script 分支也会把它清空。若用户在 agent 模式下开了前置检查、命令留空,
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
  it('saves every selected axis for the next fire and clears all overrides when following the task', () => {
    const { result } = renderHook(() => useScheduleForm(null));
    act(() => result.current.setField('targetSessionId', 'existing-task'));
    act(() => result.current.selectModelConfiguration({
      agentKind: 'pi', model: 'test-model', providerId: 'custom', effort: 'medium', fastMode: true,
    }));
    expect(result.current.toInput()).toMatchObject({
      targetSessionId: 'existing-task', agentKind: 'pi', modelAgentKind: 'pi',
      model: 'test-model', providerId: 'custom', effort: 'medium', fastMode: true,
    });
    act(() => result.current.setRunMode('fresh'));
    act(() => result.current.setRunMode('bound'));
    expect(result.current.toInput()).toMatchObject({ modelAgentKind: 'pi', model: 'test-model', fastMode: true });
    act(() => result.current.selectModelConfiguration(null));
    expect(result.current.toInput()).toMatchObject({ modelAgentKind: undefined, model: undefined, effort: undefined, providerId: undefined });
    expect(result.current.form.fastMode).toBe(false);
  });
});
