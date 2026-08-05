import { describe, expect, it } from 'vitest';

import { buildClaudeFlagSettings } from '../flag-settings.js';

describe('buildClaudeFlagSettings', () => {
  it('恒置空 apiKeyHelper — 屏蔽用户级 helper 对 oauth-spawn 订阅鉴权的劫持(回归锚点)', () => {
    // 用户 ~/.claude/settings.json 配了 apiKeyHelper 时,cc 鉴权优先级里它高于 claude.ai
    // OAuth;oauth-spawn(不注入鉴权 env)会被它劫持成 x-api-key 直打 api.anthropic.com
    // → 401。flag settings 层(优先级更高)置空是唯一确定性屏蔽手段,必须无条件存在。
    for (const memoryOverride of [undefined, true, false] as const) {
      for (const fastMode of [true, false]) {
        const settings = buildClaudeFlagSettings({
          showThinkingSummaries: false,
          memoryOverride,
          fastMode,
        });
        expect(settings.apiKeyHelper).toBe('');
      }
    }
  });

  it('默认形态(无 memory override / fast 关)只含 showThinkingSummaries + apiKeyHelper', () => {
    expect(
      buildClaudeFlagSettings({ showThinkingSummaries: true, fastMode: false }),
    ).toEqual({
      showThinkingSummaries: true,
      apiKeyHelper: '',
    });
  });

  it('memoryOverride 显式给定时同步落 autoMemoryEnabled / autoDreamEnabled 两字段', () => {
    expect(
      buildClaudeFlagSettings({ showThinkingSummaries: false, memoryOverride: true, fastMode: false }),
    ).toEqual({
      showThinkingSummaries: false,
      apiKeyHelper: '',
      autoMemoryEnabled: true,
      autoDreamEnabled: true,
    });
    expect(
      buildClaudeFlagSettings({ showThinkingSummaries: false, memoryOverride: false, fastMode: false }),
    ).toMatchObject({ autoMemoryEnabled: false, autoDreamEnabled: false });
  });

  it('fastMode 仅为 true 时落字段,false 时整字段缺省(与未升级行为一致)', () => {
    expect(
      buildClaudeFlagSettings({ showThinkingSummaries: false, fastMode: true }).fastMode,
    ).toBe(true);
    expect(
      'fastMode' in buildClaudeFlagSettings({ showThinkingSummaries: false, fastMode: false }),
    ).toBe(false);
  });
});
