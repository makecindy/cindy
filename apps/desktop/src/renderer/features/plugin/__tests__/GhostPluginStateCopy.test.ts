/**
 * Regression coverage for Plugin lifecycle wording in the Chinese UI.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const zhCommon = JSON.parse(
  readFileSync(
    resolve(__dirname, '..', '..', '..', 'i18n', 'locales', 'zh-CN', 'common.json'),
    'utf8',
  ),
) as {
  extraDirs: { pluginDisabled: string };
  settings: {
    ghosts: {
      disabledTag: string;
      enableAria: string;
      detail: { customSlotAsleep: string; disabledLabel: string };
    };
  };
};

describe('Ghost Plugin lifecycle wording', () => {
  it('describes a reversible disabled state instead of implying incompatibility', () => {
    expect(zhCommon.extraDirs.pluginDisabled).toBe('已停用');
    expect(zhCommon.settings.ghosts.disabledTag).toBe('已停用');
    expect(zhCommon.settings.ghosts.detail.disabledLabel).toBe('已停用');
    expect(zhCommon.settings.ghosts.enableAria).toContain('启用');
    // 原先还钉 toast.installedAsleep(「已装入但沉睡」)。新装的「立即开启」勾选框
    // 去掉后一律装入即生效,那条 toast 与其文案 key 一起删了,故不再断言。
    expect(zhCommon.settings.ghosts.detail.customSlotAsleep).toContain('启用后');
  });
});
