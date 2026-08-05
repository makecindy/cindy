/**
 * Regression coverage for the Cindy-assisted Plugin creation draft.
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
  settings: { ghosts: { page: { createPrompt: string } } };
};

describe('Ghost Plugin creation prompt', () => {
  it('reads the forge guide before designing, packing, and installing', () => {
    const prompt = zhCommon.settings.ghosts.page.createPrompt;

    expect(prompt).toContain('先从提问开始');
    expect(prompt.indexOf('ghost_forge_guide')).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf('ghost_forge_guide')).toBeLessThan(prompt.indexOf('ghost_forge_pack'));
    expect(prompt).toContain('打包并安装插件');
  });
});
