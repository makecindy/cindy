import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf8');
const start = source.indexOf('export async function ensureRemoteAgentInstalled(');
const end = source.indexOf('\n/**', start);
const js = transpileModule(source.slice(start, end).replace('export async', 'async'), {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;

describe('SSH Codex managed installation admission', () => {
  it.each([false, true])('uses full-package probe (installed=%s) before caching', async (installed) => {
    const host = { getStatus: () => 'ready', exec: vi.fn() };
    const cache = new Map();
    const probe = vi.fn().mockResolvedValue({ installed, installedVersion: 'managed-version' });
    const ensure = new Function('remoteAgentInstalledCache', 'isAgentCacheHit', 'getPool',
      'probeRemoteAgent', 'throwIpcError', js + '; return ensureRemoteAgentInstalled;')(
      cache, (cached: Map<string, unknown> | undefined, kind: string) => cached?.has(kind),
      () => new Map([['builder', host]]), probe,
      (code: string) => { throw new Error(code); },
    );
    if (installed) {
      await ensure('builder', 'codex');
      await ensure('builder', 'codex');
      expect(cache.get('builder').get('codex')).toEqual({ installedVersion: 'managed-version' });
    } else {
      await expect(ensure('builder', 'codex')).rejects.toThrow('SSH_AGENT_NOT_INSTALLED');
      expect(cache.size).toBe(0);
    }
    expect(probe).toHaveBeenCalledExactlyOnceWith(host, 'codex');
    expect(host.exec).not.toHaveBeenCalled();
  });
});

describe('SSH Codex model read status ownership', () => {
  it.each(['ready', 'disconnected'])('handles a %s snapshot during discovery', async (status) => {
    const hostSource = readFileSync(resolve(__dirname, '..', '..', 'maker-host', 'index.ts'), 'utf8');
    const begin = hostSource.indexOf('export async function listSshCodexProviders(');
    const code = hostSource.slice(begin, hostSource.indexOf('\nexport async function', begin + 1));
    const compiled = transpileModule(code.replace('export async', 'async'), {
      compilerOptions: { target: ScriptTarget.ES2022 },
    }).outputText;
    let onStatus!: (snapshot: { status: string }) => void;
    const stop = vi.fn();
    const remote = { getStatus: () => 'ready', onStatus: (fn: typeof onStatus) => { onStatus = fn; return stop; } };
    const agent = { listRemoteModels: async () => { onStatus({ status }); return ['remote-model']; } };
    const read = new Function('getActiveAppSession', 'getRemoteSshPool', 'ensureRemoteAgentInstalledOrInstall',
      'getMaker', '_codexAgent', 'remoteCodexProvider', compiled + '; return listSshCodexProviders;')(
      () => ({ generation: 1 }), () => new Map([['builder', remote]]), async () => {},
      () => {}, agent, (models: string[]) => models,
    );
    if (status === 'ready') await expect(read('builder')).resolves.toEqual([['remote-model']]);
    else await expect(read('builder')).rejects.toThrow('SSH model request is stale');
    expect(stop).toHaveBeenCalledOnce();
  });
});
