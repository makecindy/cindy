import { describe, expect, it } from 'vitest';

import { resolveStartupSplashHandoff } from '../startupSplashContinuity';

describe('startup splash continuity', () => {
  it.each([
    ['light', 'light', 'light'],
    ['light', 'dark', 'light'],
    ['passthrough', 'light', 'light'],
    ['passthrough', 'dark', 'dark'],
  ] as const)(
    '首启门 %s + 系统 %s → JS 舞台 %s',
    (gate, systemTheme, targetTheme) => {
      expect(resolveStartupSplashHandoff(gate, systemTheme)).toEqual({
        showNativeBridge: false,
        targetTheme,
      });
    },
  );

  it.each(['light', 'dark'] as const)(
    '首启门 pending + 系统 %s 时保留原生品牌帧且不猜主题',
    (systemTheme) => {
      expect(resolveStartupSplashHandoff('pending', systemTheme)).toEqual({
        showNativeBridge: true,
        targetTheme: null,
      });
    },
  );
});
