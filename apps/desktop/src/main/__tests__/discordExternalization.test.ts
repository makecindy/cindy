import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const DESKTOP_ROOT = resolve(__dirname, '..', '..', '..');

describe('discord.js main-process packaging', () => {
  it('keeps discord.js external to avoid bundling its circular CJS graph', () => {
    const viteConfig = readFileSync(resolve(DESKTOP_ROOT, 'vite.main.config.ts'), 'utf8');

    expect(viteConfig).toContain("'discord.js'");
    expect(viteConfig).toContain('discord.js uses circular CommonJS requires');
  });

  it('copies discord.js into the packaged runtime node_modules', () => {
    const forgeConfig = readFileSync(resolve(DESKTOP_ROOT, 'forge.config.ts'), 'utf8');

    expect(forgeConfig).toContain("'discord.js'");
    expect(forgeConfig).toContain('DISCORD_RUNTIME_DEPS');
  });

  it('preserves Discord dependency versions instead of flattening the runtime closure', () => {
    const forgeConfig = readFileSync(resolve(DESKTOP_ROOT, 'forge.config.ts'), 'utf8');
    const nativeDepsBlock = forgeConfig.match(/const NATIVE_RUNTIME_DEPS = \[[\s\S]*?\];/)?.[0];

    expect(nativeDepsBlock).toBeTruthy();
    expect(nativeDepsBlock).not.toContain('...DISCORD_RUNTIME_DEPS');
    expect(forgeConfig).toContain('copyDiscordRuntimeDeps(destModules)');
    expect(forgeConfig).toContain('copyRuntimeTrees(deps, destModules, resolvePackageDir)');
  });
});
