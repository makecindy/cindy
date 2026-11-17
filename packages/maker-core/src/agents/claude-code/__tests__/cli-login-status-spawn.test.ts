/**
 * 共享的 `auth status` 读取(Node host 用)同样不加载用户级设置:
 * 终端 claude 配的 apiKeyHelper / 网关 env 会让 CLI 报非订阅,盖住已有的订阅登录。
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFile: h.execFile }));

import { readClaudeCliLoginStatusBySpawn } from '../cli-login-status.js';
import { CLAUDE_SUBSCRIPTION_CLI_ISOLATION_ARGS } from '../subscription-settings-isolation.js';

describe('readClaudeCliLoginStatusBySpawn', () => {
  it('runs `auth status` without user-level settings and classifies the subscription login', async () => {
    h.execFile.mockImplementation((_binary: string, _args: string[], _opts: unknown, callback: (error: Error | null, stdout: string) => void) => {
      callback(null, JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro' }));
    });
    await expect(readClaudeCliLoginStatusBySpawn({ binary: '/opt/claude', env: {}, timeoutMs: 1000 }))
      .resolves.toMatchObject({ loggedIn: true, subscriptionType: 'pro' });
    expect(h.execFile).toHaveBeenCalledWith(
      '/opt/claude',
      [...CLAUDE_SUBSCRIPTION_CLI_ISOLATION_ARGS, 'auth', 'status', '--json'],
      expect.anything(),
      expect.any(Function),
    );
    expect(CLAUDE_SUBSCRIPTION_CLI_ISOLATION_ARGS).toEqual(['--setting-sources', '', '--settings', '{"apiKeyHelper":""}']);
  });
});
