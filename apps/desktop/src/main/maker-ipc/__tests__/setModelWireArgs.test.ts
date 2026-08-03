import { describe, expect, it } from 'vitest';

import { normalizeDeviceLinkSetModelWireArgs } from '../setModelWireArgs.js';

describe('normalizeDeviceLinkSetModelWireArgs', () => {
  it('将旧控制端完整 5 槽位的 JSON optional null 还原成未提供', () => {
    expect(normalizeDeviceLinkSetModelWireArgs(true, false, null, null, null)).toEqual({
      providerId: undefined,
      expectedAgentSwitchRevision: undefined,
      selection: undefined,
    });
  });

  it('新 capability 允许短参数调用中的 providerId null 表示明确清除', () => {
    expect(normalizeDeviceLinkSetModelWireArgs(true, true, null, undefined, undefined)).toEqual({
      providerId: null,
      expectedAgentSwitchRevision: undefined,
      selection: undefined,
    });
  });

  it('旧控制端带原子 selection 也把 provider null 视为占位', () => {
    const selection = { effort: 'high', fastMode: false };
    expect(normalizeDeviceLinkSetModelWireArgs(true, false, null, null, selection)).toEqual({
      providerId: undefined,
      expectedAgentSwitchRevision: undefined,
      selection,
    });
  });

  it('新 capability 带原子 selection 时保留显式 provider null', () => {
    const selection = { effort: 'high', fastMode: false };
    expect(normalizeDeviceLinkSetModelWireArgs(true, true, null, null, selection)).toEqual({
      providerId: null,
      expectedAgentSwitchRevision: undefined,
      selection,
    });
  });

  it('本地 IPC 不放宽 null 校验', () => {
    expect(normalizeDeviceLinkSetModelWireArgs(false, false, null, null, null)).toEqual({
      providerId: null,
      expectedAgentSwitchRevision: null,
      selection: null,
    });
  });

  it('保留有效的远程 revision / selection 值', () => {
    const selection = { effort: 'high', fastMode: false };
    expect(normalizeDeviceLinkSetModelWireArgs(true, false, 'provider-a', 3, selection)).toEqual({
      providerId: 'provider-a',
      expectedAgentSwitchRevision: 3,
      selection,
    });
  });
});
