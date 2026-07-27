// normalizeGhostPanelWindowsSettings:坏数据 fail-closed 清洗。
import { describe, expect, it } from 'vitest';

import { normalizeGhostPanelWindowsSettings } from '../settings-store.js';

describe('normalizeGhostPanelWindowsSettings', () => {
  it('合法条目原样保留', () => {
    expect(
      normalizeGhostPanelWindowsSettings({
        windows: { 'stock-2400-tracker': { detached: true, lastOpen: false } },
      }),
    ).toEqual({ windows: { 'stock-2400-tracker': { detached: true, lastOpen: false } } });
  });

  it('非对象 / 缺 windows / windows 非对象 → 空表', () => {
    expect(normalizeGhostPanelWindowsSettings(null)).toEqual({ windows: {} });
    expect(normalizeGhostPanelWindowsSettings('x')).toEqual({ windows: {} });
    expect(normalizeGhostPanelWindowsSettings({})).toEqual({ windows: {} });
    expect(normalizeGhostPanelWindowsSettings({ windows: 42 })).toEqual({ windows: {} });
  });

  it('非法 ghostId / 非布尔字段 / 非对象条目:整条丢弃,不影响同表其它条目', () => {
    expect(
      normalizeGhostPanelWindowsSettings({
        windows: {
          'BAD ID': { detached: true, lastOpen: true },
          'cindy-art': { detached: 'yes', lastOpen: true },
          'no-fields': null,
          good: { detached: false, lastOpen: true },
        },
      }),
    ).toEqual({ windows: { good: { detached: false, lastOpen: true } } });
  });
});
