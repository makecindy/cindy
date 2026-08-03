import { describe, expect, it } from 'vitest';

import { normalizeDeviceLinkSetModelWireArgs } from '../setModelWireArgs.js';

describe('normalizeDeviceLinkSetModelWireArgs', () => {
  it('将 Device Link JSON optional null 还原成未提供', () => {
    expect(normalizeDeviceLinkSetModelWireArgs(true, null, null)).toEqual({
      expectedAgentSwitchRevision: undefined,
      selection: undefined,
    });
  });

  it('本地 IPC 不放宽 null 校验', () => {
    expect(normalizeDeviceLinkSetModelWireArgs(false, null, null)).toEqual({
      expectedAgentSwitchRevision: null,
      selection: null,
    });
  });

  it('保留有效的远程 revision / selection 值', () => {
    const selection = { effort: 'high', fastMode: false };
    expect(normalizeDeviceLinkSetModelWireArgs(true, 3, selection)).toEqual({
      expectedAgentSwitchRevision: 3,
      selection,
    });
  });
});
