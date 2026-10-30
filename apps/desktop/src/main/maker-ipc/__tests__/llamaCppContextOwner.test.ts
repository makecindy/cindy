import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';
import { expect, it, vi } from 'vitest';

// Execute the production callback without loading Electron's complete IPC registry.
const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
const callback = source.slice(
  source.indexOf('writeModelContextLimit: async (targets, limit) => {'),
  source.indexOf('    // 通用 OAuth（目录 auth.oauth'),
);
const js = transpileModule(`return ({ ${callback} }).writeModelContextLimit;`, {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;

it.each(['lock', 'snapshot', 'provider', 'catalog', 'unchanged'])(
  'keeps the requesting account across %s',
  async (phase) => {
    let owner = { dataOwnerId: 'A', generation: 1 };
    const switchAt = (step: string) => {
      if (phase === step) owner = { dataOwnerId: 'B', generation: 2 };
    };
    const write = vi.fn();
    const snapshot = vi.fn(async () => {
      switchAt('snapshot');
      return { models: [] };
    });
    const configure = async (run: () => Promise<void>) => {
      switchAt('lock');
      return run();
    };
    const provider = vi.fn(async (_models, active) => {
      if (!active()) throw new Error('OWNER_CHANGED');
      switchAt('provider');
    });
    const catalog = vi.fn(async () => {
      switchAt('catalog');
    });
    const deps = {
      getActiveAppSession: () => owner,
      MANAGED_LLAMACPP_PROVIDER_ID: 'local-llamacpp',
      getManagedLlamaCppService: () => ({ configure, snapshot }),
      app: { getPath: () => '/unused' },
      ensureManagedLlamaCppProvider: provider,
      refreshCustomProvidersIntoCatalog: catalog,
      writeModelContextLimitsWithRefresh: write,
      refreshContextSettings: vi.fn(),
    };
    const run = new Function(...Object.keys(deps), js)(...Object.values(deps));
    const result = run([{ agent: 'pi', providerId: 'local-llamacpp', modelId: 'test' }], 1_000_000);
    if (phase === 'unchanged') {
      await result;
      expect(write).toHaveBeenCalledOnce();
    } else {
      await expect(result).rejects.toThrow('OWNER_CHANGED');
      expect(write).not.toHaveBeenCalled();
      if (phase === 'lock') expect(snapshot).not.toHaveBeenCalled();
      if (phase === 'provider') expect(catalog).not.toHaveBeenCalled();
    }
  },
);
