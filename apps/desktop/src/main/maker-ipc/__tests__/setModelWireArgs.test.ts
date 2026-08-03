import { describe, expect, it } from 'vitest';

import { normalizeDeviceLinkSetModelWireArgs } from '../setModelWireArgs.js';

describe('normalizeDeviceLinkSetModelWireArgs', () => {
  it('将旧控制端完整 5 槽位的 JSON optional null 还原成未提供', () => {
    expect(normalizeDeviceLinkSetModelWireArgs(true, 5, null, null, null)).toEqual({
      providerId: undefined,
      expectedAgentSwitchRevision: undefined,
      selection: undefined,
    });
  });

  it('新版 3 参数调用中的 providerId null 仍表示明确清除', () => {
    expect(normalizeDeviceLinkSetModelWireArgs(true, 3, null, undefined, undefined)).toEqual({
      providerId: null,
      expectedAgentSwitchRevision: undefined,
      selection: undefined,
    });
  });

  it('带原子 selection 的新版调用不会误判 provider null 为旧占位', () => {
    const selection = { effort: 'high', fastMode: false };
    expect(normalizeDeviceLinkSetModelWireArgs(true, 5, null, null, selection)).toEqual({
      providerId: null,
      expectedAgentSwitchRevision: undefined,
      selection,
    });
  });

  it('本地 IPC 不放宽 null 校验', () => {
    expect(normalizeDeviceLinkSetModelWireArgs(false, 5, null, null, null)).toEqual({
      providerId: null,
      expectedAgentSwitchRevision: null,
      selection: null,
    });
  });

  it('保留有效的远程 revision / selection 值', () => {
    const selection = { effort: 'high', fastMode: false };
    expect(normalizeDeviceLinkSetModelWireArgs(true, 5, 'provider-a', 3, selection)).toEqual({
      providerId: 'provider-a',
      expectedAgentSwitchRevision: 3,
      selection,
    });
  });
});
