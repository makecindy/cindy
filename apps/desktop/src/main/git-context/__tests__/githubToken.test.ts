/**
 * 测试价值
 * - 生产入口与可观察结果：调用 readGithubTokenDetailed，验证 PR 状态与 GitHub 读取链路优先使用 GitHub 插件凭证（插件 PAT / GitHub App），未配置时才回落本地 gh CLI，且切账号时拒绝跨账号凭证泄漏。
 * - Bug／规则依据：用户明确要求 GitHub 连接优先以 GitHub 插件为主（对齐 GitLab 插件优先规则）。
 * - 现有覆盖缺口：此前无单测锁定 readGithubTokenDetailed 的插件优先顺序与回落逻辑。
 * - 最小失败输入：同时存在插件凭证与本地 gh token 时不得先调 gh；插件均为空时回落 gh。
 * - tier：unit（纯内存 mock，无外部进程）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  owner: 'owner-a',
  readGhostSecret: vi.fn(),
  readGithubAppToken: vi.fn<() => Promise<string | null>>(),
  readGhDetailed: vi.fn(),
}));

vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => mocks.owner,
}));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  readGhostSecret: mocks.readGhostSecret,
}));
vi.mock('../githubAppAuthorization.desktop.js', () => ({
  readGithubAppToken: mocks.readGithubAppToken,
}));
vi.mock('../ghCliTokenSource.js', () => ({
  getSharedGhCliTokenSource: () => ({
    readTokenDetailed: mocks.readGhDetailed,
  }),
}));

import { readGithubTokenDetailed } from '../githubToken.desktop.js';

describe('readGithubTokenDetailed (GitHub plugin-first precedence)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.owner = 'owner-a';
    mocks.readGhostSecret.mockReturnValue(null);
    mocks.readGithubAppToken.mockResolvedValue(null);
    mocks.readGhDetailed.mockResolvedValue({ ok: false, reason: 'gh-not-logged-in' });
  });

  it('prefers the GitHub plugin PAT over GitHub App and local gh CLI', async () => {
    mocks.readGhostSecret.mockImplementation((id: string, key: string) =>
      id === '_root__cindy-github' && key === 'github_pat' ? 'ghp_plugin_pat' : null,
    );
    mocks.readGithubAppToken.mockResolvedValue('ghu_app_token');
    mocks.readGhDetailed.mockResolvedValue({ ok: true, token: 'gho_cli_token' });

    await expect(readGithubTokenDetailed()).resolves.toEqual({
      ok: true,
      token: 'ghp_plugin_pat',
    });
    expect(mocks.readGithubAppToken).not.toHaveBeenCalled();
    expect(mocks.readGhDetailed).not.toHaveBeenCalled();
  });

  it('prefers Cindy GitHub App authorization over local gh CLI when plugin PAT is absent', async () => {
    mocks.readGithubAppToken.mockResolvedValue('ghu_app_token');
    mocks.readGhDetailed.mockResolvedValue({ ok: true, token: 'gho_cli_token' });

    await expect(readGithubTokenDetailed()).resolves.toEqual({
      ok: true,
      token: 'ghu_app_token',
    });
    expect(mocks.readGhDetailed).not.toHaveBeenCalled();
  });

  it('falls back to local gh CLI when neither plugin PAT nor GitHub App is connected', async () => {
    mocks.readGhDetailed.mockResolvedValue({ ok: true, token: 'gho_cli_token' });

    await expect(readGithubTokenDetailed()).resolves.toEqual({
      ok: true,
      token: 'gho_cli_token',
    });
  });

  it('returns unauthenticated when account scope switches during async token lookup', async () => {
    mocks.readGithubAppToken.mockImplementation(async () => {
      mocks.owner = 'owner-b';
      return 'ghu_stale_owner';
    });

    await expect(readGithubTokenDetailed()).resolves.toEqual({
      ok: false,
      reason: 'gh-not-logged-in',
    });
  });
});
