import { describe, expect, it } from 'vitest';

import { detectSensitivePath } from '../sensitivePath.js';

/*
 * 测试价值
 * - 生产入口与可观察结果：detectSensitivePath 对插件引擎隔离账号目录、Antigravity 文件型
 *   OAuth 凭证与内置多账号目录返回敏感路径原因，同时不误伤仓库源码路径。
 * - Bug／规则依据：docs/dev-rules/credentials-and-local-storage.md（凭证不得进入快照或技能包）。
 * - 现有覆盖缺口：sensitivePath.ts 此前无独立单测，且未覆盖 plugin-engine-accounts / antigravity-oauth-token。
 * - 最小失败输入：owners/<account>/plugin-engine-accounts/...、.gemini/antigravity-cli/...、
 *   antigravity-oauth-token、.claude-cindy-... 以及对比项 apps/desktop/src/main/plugin-engine-accounts/paths.ts。
 * - tier：unit（纯函数，无 IO）。实测耗时：< 50ms。
 */

describe('detectSensitivePath', () => {
  it('flags plugin-engine isolated accounts, Antigravity credentials, and built-in account homes', () => {
    expect(
      detectSensitivePath('owners/abae59844621cadf5062/plugin-engine-accounts/_root__agy/agy/cindy-1/state'),
    ).toBe('sensitive-directory');
    expect(detectSensitivePath('.gemini/antigravity-cli/antigravity-oauth-token')).toBe('sensitive-directory');
    expect(detectSensitivePath('antigravity-oauth-token')).toBe('sensitive-basename');
    expect(detectSensitivePath('.claude-cindy-0123456789ab-11111111-1111-4111-8111-111111111111/settings.json')).toBe(
      'sensitive-directory',
    );
    expect(detectSensitivePath('.codex-cindy-0123456789ab-11111111-1111-4111-8111-111111111111/auth.json')).toBe(
      'sensitive-directory',
    );
  });

  it('does not flag ordinary repository source paths for plugin-engine-accounts', () => {
    expect(detectSensitivePath('apps/desktop/src/main/plugin-engine-accounts/paths.ts')).toBeNull();
    expect(detectSensitivePath('.gemini/settings.json')).toBeNull();
  });
});
