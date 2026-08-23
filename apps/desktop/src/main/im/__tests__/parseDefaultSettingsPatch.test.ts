/**
 * IM 默认设置 patch 的 IPC 白名单解析。
 *
 * 核心是最后那条**字段全覆盖**守卫: 这层白名单漏一个键就是"设置项切了没反应"
 * (renderer 乐观更新 → 这里丢键 → handler 回读旧值发回 → UI 弹回原档, 无任何
 * 报错)。群聊权限档(groupPermissionMode)正是这么静默失效过一次。
 */
import { describe, expect, it } from 'vitest';

import {
  IM_DEFAULT_SETTINGS,
  type ImDefaultSettings,
} from '../../../shared/imDefaultSettings.js';
import { parseImDefaultSettingsPatch } from '../parseDefaultSettingsPatch.js';

describe('parseImDefaultSettingsPatch', () => {
  it('keeps agentKind / permissionMode / groupPermissionMode', () => {
    expect(
      parseImDefaultSettingsPatch({
        agentKind: 'codex',
        permissionMode: 'plan',
        groupPermissionMode: 'bypassPermissions',
      }),
    ).toEqual({
      agentKind: 'codex',
      permissionMode: 'plan',
      groupPermissionMode: 'bypassPermissions',
    });
  });

  it('keeps a groupPermissionMode-only patch (飞书群聊权限档单独保存)', () => {
    expect(parseImDefaultSettingsPatch({ groupPermissionMode: 'bypassPermissions' })).toEqual({
      groupPermissionMode: 'bypassPermissions',
    });
  });

  it('rejects an invalid groupPermissionMode instead of dropping it', () => {
    expect(() => parseImDefaultSettingsPatch({ groupPermissionMode: 'nope' })).toThrow(
      /groupPermissionMode/,
    );
  });

  it('parses all three harnesses symmetrically', () => {
    const parsed = parseImDefaultSettingsPatch({
      agents: {
        'claude-code': { model: ' m-cc ', effort: 'high', providerId: ' p1 ' },
        codex: { model: 'm-codex', effort: 'low', providerId: null },
        pi: { model: 'm-pi', effort: 'medium', providerId: '  ' },
      },
    });
    expect(parsed.agents).toEqual({
      // 字符串两端空白收敛, 空白串的 providerId 归 null(隐式默认路由)
      'claude-code': { model: 'm-cc', effort: 'high', providerId: 'p1' },
      codex: { model: 'm-codex', effort: 'low', providerId: null },
      pi: { model: 'm-pi', effort: 'medium', providerId: null },
    });
  });

  it('rejects non-object payloads', () => {
    expect(() => parseImDefaultSettingsPatch(null)).toThrow(/object/);
    expect(() => parseImDefaultSettingsPatch([])).toThrow(/object/);
  });

  /**
   * 守卫: ImDefaultSettings 的每个顶层键都必须被这层白名单解析出来。
   * 新增设置项只改 shared 类型 + store + UI 而漏了 IPC 解析时, 这里红。
   */
  it('parses every top-level ImDefaultSettings key (no silently dropped field)', () => {
    // 每个键给一个「与出厂值不同」的合法值,才能证明解析结果确实来自入参。
    const nonDefault: ImDefaultSettings = {
      agentKind: 'codex',
      permissionMode: 'plan',
      groupPermissionMode: 'bypassPermissions',
      agents: {
        'claude-code': { providerId: 'p-cc', model: 'm-cc', effort: 'low' },
        codex: { providerId: 'p-codex', model: 'm-codex', effort: 'low' },
        pi: { providerId: 'p-pi', model: 'm-pi', effort: 'low' },
      },
    };
    for (const key of Object.keys(IM_DEFAULT_SETTINGS) as Array<keyof ImDefaultSettings>) {
      expect(nonDefault[key]).not.toEqual(IM_DEFAULT_SETTINGS[key]);
    }

    const parsed = parseImDefaultSettingsPatch(nonDefault);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(IM_DEFAULT_SETTINGS).sort());
    expect(parsed).toEqual(nonDefault);
  });
});
