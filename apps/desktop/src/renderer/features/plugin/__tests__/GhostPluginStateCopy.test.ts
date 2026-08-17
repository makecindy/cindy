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
      toast: { installedAsleep: string };
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
    expect(zhCommon.settings.ghosts.toast.installedAsleep).toContain('可随时在此启用');
    expect(zhCommon.settings.ghosts.detail.customSlotAsleep).toContain('启用后');
  });
});
