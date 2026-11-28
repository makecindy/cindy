import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { throwIpcError } from '../../utils/ipcValidate.js';
import { createIpcError } from '../../../shared/ipc-errors.js';
import { readSshCodexModelList } from '../codex-model-list.js';

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
  const hostSource = readFileSync(resolve(__dirname, '..', '..', 'maker-host', 'index.ts'), 'utf8');
  const begin = hostSource.indexOf('export async function listSshCodexProviders(');
  const code = hostSource.slice(begin, hostSource.indexOf('\nexport async function', begin + 1));
  const compiled = transpileModule(code.replace('export async', 'async'), {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  /** listSshCodexProviders with injected install and model-list steps; `disconnect` emits a non-ready snapshot. */
  const load = (steps: {
    install?: (disconnect: () => void) => Promise<unknown>;
    list?: (disconnect: () => void) => Promise<string[]>;
  }) => {
    let onStatus!: (snapshot: { status: string }) => void;
    const stop = vi.fn();
    const remote = { getStatus: () => 'ready', onStatus: (fn: typeof onStatus) => { onStatus = fn; return stop; } };
    const disconnect = () => onStatus({ status: 'disconnected' });
    const agent = { listRemoteModels: async () => (steps.list ? steps.list(disconnect) : ['remote-model']) };
    const read = new Function('getActiveAppSession', 'getRemoteSshPool', 'ensureRemoteAgentInstalledOrInstall',
      'getMaker', '_codexAgent', 'remoteCodexProvider', 'throwIpcError', compiled + '; return listSshCodexProviders;')(
      () => ({ generation: 1 }), () => new Map([['builder', remote]]),
      async () => steps.install?.(disconnect),
      () => {}, agent, (models: string[]) => models, throwIpcError,
    ) as (hostId: string) => Promise<string[][]>;
    return { read, stop };
  };

  it.each(['ready', 'disconnected'])('handles a %s snapshot during discovery', async (status) => {
    const { read, stop } = load({
      list: async (disconnect) => { if (status !== 'ready') disconnect(); return ['remote-model']; },
    });
    if (status === 'ready') await expect(read('builder')).resolves.toEqual([['remote-model']]);
    // A stale read is a connection problem the user can fix by reconnecting, not a Codex failure.
    else await expect(read('builder')).rejects.toMatchObject({ code: 'SSH_NOT_CONNECTED', message: expect.stringContaining('SSH model request is stale') });
    expect(stop).toHaveBeenCalledOnce();
  });

  // PR #13491 review: closing the transport rejects pending requests with a plain Error. When the
  // connection changed meanwhile, the picker must ask to reconnect instead of blaming the install or
  // Codex itself; when it did not change, the original failure category is kept.
  it.each([
    ['install', true, 'SSH_NOT_CONNECTED', new Error('Connection closed')],
    ['install', false, 'SSH_INSTALL_FAILED', createIpcError('SSH_INSTALL_FAILED', 'curl: (56)')],
    ['model list', true, 'SSH_NOT_CONNECTED', new Error('transport closed')],
    ['model list', false, 'SSH_EXEC_FAILED', new Error('File exists (os error 17)')],
  ] as const)('a %s rejection (connection changed: %s) is reported as %s', async (step, changed, code, failure) => {
    const reject = async (disconnect: () => void): Promise<never> => {
      if (changed) disconnect();
      throw failure;
    };
    const { read, stop } = load(step === 'install' ? { install: reject } : { list: reject });
    await expect(readSshCodexModelList({ id: 'builder' }, read as never)).rejects.toMatchObject({ code });
    expect(stop).toHaveBeenCalledOnce();
  });
});
