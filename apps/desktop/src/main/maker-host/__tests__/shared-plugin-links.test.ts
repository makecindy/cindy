import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockAccountDirectory = vi.fn<(provider: string, id: string) => string>();
const mockReadPool = vi.fn<() => unknown>();

vi.mock('../../subscription-accounts/store.js', () => ({
  accountDirectory: (...args: unknown[]) => mockAccountDirectory(...(args as [string, string])),
  readPool: () => mockReadPool(),
}));

import { prepareSharedPluginLinks } from '../shared-plugin-links';

const roots: string[] = [];

function tempHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-plugin-links-'));
  roots.push(root);
  return root;
}

function setupPool(home: string, accountIds: string[]): void {
  mockAccountDirectory.mockImplementation(
    (provider: string, id: string) =>
      path.join(home, `.${provider === 'anthropic' ? 'claude' : 'codex'}-${id === 'default' ? '' : id}`),
  );
  mockReadPool.mockReturnValue({
    strategy: 'least',
    accounts: accountIds.map((id) => ({ id, paused: false, limit: 0, weight: 1 })),
  });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('prepareSharedPluginLinks', () => {
  beforeEach(() => {
    // 每条用例默认走 ~/.claude；需要自定义目录的用例再单独覆盖。
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  });

  it('links the default account plugins into a second account home', async () => {
    const home = tempHome();
    const defaultPlugins = path.join(home, '.claude', 'plugins');
    fs.mkdirSync(path.join(defaultPlugins, 'cache'), { recursive: true });
    setupPool(home, ['default', 'cindy-abcdef123456-uuid-here']);

    await prepareSharedPluginLinks(home);

    const linked = path.join(home, '.claude-cindy-abcdef123456-uuid-here', 'plugins');
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(linked)).toBe(fs.realpathSync(defaultPlugins));
  });

  it('shares plugins from a CLAUDE_CONFIG_DIR override', async () => {
    const home = tempHome();
    const customConfig = path.join(home, 'custom-claude');
    fs.mkdirSync(path.join(customConfig, 'plugins', 'cache'), { recursive: true });
    setupPool(home, ['default', 'cindy-abcdef123456-uuid-here']);
    vi.stubEnv('CLAUDE_CONFIG_DIR', customConfig);

    await prepareSharedPluginLinks(home);

    // 默认账号把配置目录移走后，共享源必须跟着走，而不是继续链 ~/.claude。
    const linked = path.join(home, '.claude-cindy-abcdef123456-uuid-here', 'plugins');
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(linked)).toBe(fs.realpathSync(path.join(customConfig, 'plugins')));
  });

  it('leaves an account home that already owns plugins untouched', async () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
    const accountPlugins = path.join(home, '.claude-cindy-abcdef123456-uuid-here', 'plugins');
    fs.mkdirSync(accountPlugins, { recursive: true });
    fs.writeFileSync(path.join(accountPlugins, 'installed_plugins.json'), '{"plugins":{}}');
    setupPool(home, ['default', 'cindy-abcdef123456-uuid-here']);

    await prepareSharedPluginLinks(home);

    expect(fs.lstatSync(accountPlugins).isSymbolicLink()).toBe(false);
    expect(fs.readdirSync(accountPlugins)).toEqual(['installed_plugins.json']);
  });

  it('does nothing when the default account has no plugins', async () => {
    const home = tempHome();
    setupPool(home, ['default', 'cindy-abcdef123456-uuid-here']);

    await prepareSharedPluginLinks(home);

    expect(fs.existsSync(path.join(home, '.claude-cindy-abcdef123456-uuid-here', 'plugins'))).toBe(false);
  });

  it('does nothing when there is no subscription pool', async () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
    mockAccountDirectory.mockImplementation(
      (provider: string, id: string) => path.join(home, `.${provider}-${id}`),
    );
    mockReadPool.mockReturnValue(null);

    await prepareSharedPluginLinks(home);

    expect(fs.existsSync(path.join(home, '.claude-cindy-abcdef123456-uuid-here', 'plugins'))).toBe(false);
  });
});
