import { describe, expect, it } from 'vitest';

import {
  computeComputerPermissionGuideBounds,
  findSystemSettingsWindowBounds,
} from '../placement';

describe('computeComputerPermissionGuideBounds', () => {
  it('right-aligns the visible card and centers it vertically on System Settings', () => {
    const systemWindow = { x: 200, y: 100, width: 1000, height: 500 };
    const result = computeComputerPermissionGuideBounds(
      systemWindow,
      { x: 0, y: 25, width: 1440, height: 875 },
    );

    expect(result).toEqual({ x: 736, y: 190, width: 480, height: 272 });
    expect(result.x + result.width - 16).toBe(systemWindow.x + systemWindow.width);
    const visibleCardCenterY = result.y + 48 + (result.height - 48) / 2;
    const systemCenterY = systemWindow.y + systemWindow.height / 2;
    expect(visibleCardCenterY).toBe(systemCenterY);
  });

  it('supports a System Settings window on a display with negative coordinates', () => {
    expect(computeComputerPermissionGuideBounds(
      { x: -1200, y: 60, width: 1000, height: 500 },
      { x: -1440, y: 25, width: 1440, height: 875 },
    )).toEqual({ x: -664, y: 150, width: 480, height: 272 });
  });

  it('clamps the transparent guide window inside the matching work area', () => {
    expect(computeComputerPermissionGuideBounds(
      { x: 1300, y: 800, width: 500, height: 500 },
      { x: 0, y: 25, width: 1440, height: 875 },
    )).toEqual({ x: 960, y: 628, width: 480, height: 272 });
  });

  it('shrinks safely when the work area is smaller than the guide window', () => {
    expect(computeComputerPermissionGuideBounds(
      { x: -800, y: 0, width: 320, height: 200 },
      { x: -800, y: 0, width: 320, height: 200 },
    )).toEqual({ x: -800, y: 0, width: 320, height: 200 });
  });
});

describe('findSystemSettingsWindowBounds', () => {
  it('selects the visible titled System Settings window over helper surfaces', () => {
    expect(findSystemSettingsWindowBounds({
      windows: [
        {
          app_name: 'System Settings',
          title: '',
          is_on_screen: true,
          layer: 25,
          bounds: { x: 0, y: 0, width: 1440, height: 25 },
        },
        {
          app_name: 'System Settings',
          title: '',
          is_on_screen: true,
          layer: 0,
          bounds: { x: 120, y: 90, width: 440, height: 320 },
        },
        {
          app_name: 'System Settings',
          title: 'Privacy & Security',
          is_on_screen: true,
          layer: 0,
          bounds: { x: 160, y: 80, width: 1000, height: 720 },
        },
      ],
    })).toEqual({ x: 160, y: 80, width: 1000, height: 720 });
  });

  it('recognizes a localized window through its process executable', () => {
    expect(findSystemSettingsWindowBounds({
      windows: [{
        app_name: '系统设置',
        title: '隐私与安全性',
        is_on_screen: true,
        layer: 0,
        bounds: { x: 80, y: 40, width: 920, height: 680 },
        process: {
          executable: '/System/Applications/System Settings.app/Contents/MacOS/System Settings',
        },
      }],
    })).toEqual({ x: 80, y: 40, width: 920, height: 680 });
  });
});
