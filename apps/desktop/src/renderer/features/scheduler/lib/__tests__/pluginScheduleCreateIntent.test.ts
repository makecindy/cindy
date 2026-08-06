/**
 * @vitest-environment node
 *
 * pluginScheduleCreateIntent.test — 插件请求新建自动化的意图/预填纯函数层。
 */

import { describe, expect, it } from 'vitest';

import {
  buildPluginScheduleFormOverrides,
  pluginScheduleNavigationState,
  readPluginScheduleCreateIntent,
  type PluginScheduleCreateIntent,
} from '../pluginScheduleCreateIntent';

const intent: PluginScheduleCreateIntent = {
  kind: 'plugin-schedule-draft',
  requestId: 'req-1',
  ghostId: 'codex-reset-planner',
  ghostName: 'Codex 重置管家',
  name: 'Codex 重置提醒',
  prompt: '检查本机 Codex 重置时间,快到了就调 update_status 写回去。',
  intervalMs: 3_600_000,
};

describe('readPluginScheduleCreateIntent', () => {
  it('往返:navigationState → read 得回原 intent', () => {
    expect(readPluginScheduleCreateIntent(pluginScheduleNavigationState(intent))).toEqual(intent);
  });

  it('不带 intervalMs 也合法(面板用自己的默认频率)', () => {
    const noInterval: PluginScheduleCreateIntent = { ...intent };
    delete noInterval.intervalMs;
    expect(readPluginScheduleCreateIntent(pluginScheduleNavigationState(noInterval))).toEqual(
      noInterval,
    );
  });

  it.each([
    ['null', null],
    ['非对象', 'nope'],
    ['空对象', {}],
    ['kind 不对', { pluginScheduleDraft: { ...intent, kind: 'other' } }],
    ['缺 requestId', { pluginScheduleDraft: { ...intent, requestId: '' } }],
    ['缺 ghostId', { pluginScheduleDraft: { ...intent, ghostId: '' } }],
    ['缺 ghostName', { pluginScheduleDraft: { ...intent, ghostName: '' } }],
    ['缺 name', { pluginScheduleDraft: { ...intent, name: '' } }],
    ['缺 prompt', { pluginScheduleDraft: { ...intent, prompt: '' } }],
    ['intervalMs 非数字', { pluginScheduleDraft: { ...intent, intervalMs: 'soon' } }],
    ['intervalMs 为 0', { pluginScheduleDraft: { ...intent, intervalMs: 0 } }],
    ['intervalMs 为负', { pluginScheduleDraft: { ...intent, intervalMs: -1 } }],
    ['intervalMs 非有限', { pluginScheduleDraft: { ...intent, intervalMs: Number.NaN } }],
  ])('形状不对就当没有:%s → null', (_label, state) => {
    expect(readPluginScheduleCreateIntent(state)).toBeNull();
  });
});

describe('buildPluginScheduleFormOverrides', () => {
  it('落成普通 agent 自动化 —— 不带任何插件专属执行配置', () => {
    const overrides = buildPluginScheduleFormOverrides(intent);
    expect(overrides.executionMode).toBe('agent');
    // 插件不是执行者,所以不该出现 script/plugin 那类执行配置字段。
    expect(overrides).not.toHaveProperty('scriptCommand');
    expect(overrides).not.toHaveProperty('pluginConfig');
  });

  it('模型/来源/思考强度一律留空 = 用默认模型,由用户在面板上自己选', () => {
    const overrides = buildPluginScheduleFormOverrides(intent);
    expect(overrides.model).toBe('');
    expect(overrides.providerId).toBe('');
    expect(overrides.effort).toBe('');
    expect(overrides.fastMode).toBe(false);
  });

  it('预填 name / prompt 原样透传(净化与截断已在 main 侧做完)', () => {
    const overrides = buildPluginScheduleFormOverrides(intent);
    expect(overrides.name).toBe(intent.name);
    expect(overrides.prompt).toBe(intent.prompt);
  });

  it('带建议频率 → 写进 intervalMs;不带 → 不带该 key(沿用面板默认)', () => {
    expect(buildPluginScheduleFormOverrides(intent).intervalMs).toBe(3_600_000);
    const noInterval: PluginScheduleCreateIntent = { ...intent };
    delete noInterval.intervalMs;
    expect(buildPluginScheduleFormOverrides(noInterval)).not.toHaveProperty('intervalMs');
  });

  it('不绑会话、不占工作目录、不开隔离工作区', () => {
    const overrides = buildPluginScheduleFormOverrides(intent);
    expect(overrides.targetSessionId).toBe('');
    expect(overrides.persistentSession).toBe(false);
    expect(overrides.workspaceKind).toBe('dialogue');
    expect(overrides.workingDir).toBe('');
    expect(overrides.useWorktree).toBe(false);
  });

  it('不落库发起插件 id(避免为一个展示字段欠下不可回退的 schema 债)', () => {
    // ghostId 只用于面板上的来源标注,不进表单提交内容。
    expect(buildPluginScheduleFormOverrides(intent)).not.toHaveProperty('originGhostId');
  });
});
