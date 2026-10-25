import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {createSshAgentInstaller} from '@cindy/app-runtime/sshAgentInstaller';

const {probe}=vi.hoisted(()=>({probe:vi.fn()}));
vi.mock('@cindy/maker-remote-ssh',async importOriginal=>({...await importOriginal<typeof import('@cindy/maker-remote-ssh')>(),probeRemoteAgent:probe}));

describe('SSH Codex managed installation admission', () => {
  it.each([false, true])('uses full-package probe (installed=%s) before caching', async (installed) => {
    const host = { getStatus: () => 'ready', exec: vi.fn() };
    probe.mockReset().mockResolvedValue({ installed, installedVersion: 'managed-version' });
    const logger={trace:vi.fn(),debug:vi.fn(),info:vi.fn(),warn:vi.fn(),error:vi.fn(),fatal:vi.fn(),child:()=>logger};
    const runtime=createSshAgentInstaller({getPool:()=>new Map([['builder',host as unknown as import('@cindy/maker-remote-ssh').RemoteHost]]),log:logger,
      installRemoteAgent:vi.fn(),broadcastInstallProgress:vi.fn(),broadcastSilentInstallStatus:vi.fn()});
    const ensure=runtime.ensureRemoteAgentInstalled,cache=runtime.remoteAgentInstalledCache;
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
