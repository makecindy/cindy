import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { prepareSharedPluginLinks } from '../shared-plugin-links';

const roots: string[] = [];

function tempHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-plugin-links-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('prepareSharedPluginLinks', () => {
  it('links the default account plugins into a second account home', async () => {
    const home = tempHome();
    const defaultPlugins = path.join(home, '.claude', 'plugins');
    fs.mkdirSync(path.join(defaultPlugins, 'cache'), { recursive: true });
    const accountHome = path.join(home, '.claude-cindy-owner-abc');
    fs.mkdirSync(accountHome, { recursive: true });

    await prepareSharedPluginLinks(home);

    const linked = path.join(accountHome, 'plugins');
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(linked)).toBe(fs.realpathSync(defaultPlugins));
  });

  it('leaves an account home that already owns plugins untouched', async () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
    const accountHome = path.join(home, '.claude-cindy-owner-abc');
    const accountPlugins = path.join(accountHome, 'plugins');
    fs.mkdirSync(accountPlugins, { recursive: true });
    fs.writeFileSync(path.join(accountPlugins, 'installed_plugins.json'), '{"plugins":{}}');

    await prepareSharedPluginLinks(home);

    // 账号自己的插件集合优先，不能被默认账号覆盖。
    expect(fs.lstatSync(accountPlugins).isSymbolicLink()).toBe(false);
    expect(fs.readdirSync(accountPlugins)).toEqual(['installed_plugins.json']);
  });

  it('does nothing when the default account has no plugins', async () => {
    const home = tempHome();
    const accountHome = path.join(home, '.claude-cindy-owner-abc');
    fs.mkdirSync(accountHome, { recursive: true });

    await prepareSharedPluginLinks(home);

    expect(fs.existsSync(path.join(accountHome, 'plugins'))).toBe(false);
  });
});
