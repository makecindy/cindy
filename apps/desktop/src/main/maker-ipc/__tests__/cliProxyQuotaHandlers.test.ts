import { describe, expect, it, vi } from 'vitest';
import {
  registerCliProxyQuotaHandlers,
  type CliProxyQuotaHandlerDeps,
} from '../cliProxyQuotaHandlers.js';
import type { IpcHandler } from '../ipcHandlerRegistry.js';

function setup(overrides: Partial<CliProxyQuotaHandlerDeps> = {}) {
  const deps: CliProxyQuotaHandlerDeps = {
    assertTrusted: vi.fn(),
    scope: () => 'owner',
    isBoundaryPending: () => false,
    identity: () => 'connection',
    baseUrl: async () => 'http://localhost:8317/v1',
    readKey: () => null,
    writeKey: vi.fn(() => true),
    removeKey: vi.fn(() => true),
    fetch: vi.fn(),
    ...overrides,
  };
  let handler: IpcHandler = () => {};
  registerCliProxyQuotaHandlers(
    {
      handle: (_name, callback) => {
        handler = callback;
      },
    },
    deps,
  );
  return {
    deps,
    invoke: (...args: unknown[]) => Promise.resolve().then(() => handler({}, ...args)),
  };
}

describe('local CLI proxy quota IPC', () => {
  it('checks sender before reading credentials', async () => {
    const { invoke, deps } = setup({
      assertTrusted: () => {
        throw new Error('untrusted');
      },
    });
    await expect(invoke('local')).rejects.toThrow('untrusted');
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it('reads configuration without querying upstream or returning the saved key', async () => {
    const { invoke, deps } = setup({ readKey: () => 'saved-private-key' });
    expect(await invoke('local')).toEqual({ configured: true, accounts: [], observedAt: 0 });
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it('rejects remote endpoints and invalid requests', async () => {
    const { invoke, deps } = setup({ baseUrl: async () => 'https://remote.example/v1' });
    await expect(invoke('local', 'secret')).rejects.toThrow();
    await expect(invoke('../escape', 'secret')).rejects.toThrow();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it('disconnects without touching model inference credentials', async () => {
    const { invoke, deps } = setup();
    expect(await invoke('local', '')).toMatchObject({ configured: false });
    expect(deps.removeKey).toHaveBeenCalledWith('connection');
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it('does not save an unverified key and sanitizes proxy errors', async () => {
    const { invoke, deps } = setup({
      fetch: vi.fn(async () => new Response('private error', { status: 401 })),
    });
    await expect(invoke('local', 'secret')).rejects.toThrow('Could not read CLI proxy quota');
    expect(deps.writeKey).not.toHaveBeenCalled();
  });
  it('rejects an in-flight refresh after disconnect without saving its key', async () => {
    let resolve!: (response: Response) => void;
    const { invoke, deps } = setup({
      fetch: vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    });
    const refresh = invoke('local', 'new-key', true);
    await vi.waitFor(() => expect(deps.fetch).toHaveBeenCalledOnce());
    await invoke('local', '');
    resolve(new Response(JSON.stringify({ files: [] })));
    await expect(refresh).rejects.toThrow('Could not read CLI proxy quota');
    expect(deps.writeKey).not.toHaveBeenCalled();
  });
  it('does not bind a previous connection key to a recreated provider', async () => {
    let incarnation = 'original';
    const { invoke, deps } = setup({
      identity: () => incarnation,
      fetch: vi.fn(async () => {
        incarnation = 'recreated';
        return new Response(JSON.stringify({ files: [] }));
      }),
    });
    await expect(invoke('local', 'new-key', true)).rejects.toThrow(
      'Could not read CLI proxy quota',
    );
    expect(deps.writeKey).not.toHaveBeenCalled();
  });
});
