import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcHandler } from '../../maker-ipc/ipcHandlerRegistry.js';
import { MAKER_INVOKE } from '../../maker-ipc/channels.js';
const mocks = vi.hoisted(() => ({ ensure: vi.fn(), resolve: vi.fn() }));
vi.mock('../../lifecycle.js', () => ({ onQuit: vi.fn() }));
vi.mock('../../maker-host/active-catalog.js', () => ({
  getActiveLocalModelCatalog: () => undefined,
}));
vi.mock('../managedLlamaCppProvider.js', () => ({ ensureManagedLlamaCppProvider: mocks.ensure }));
vi.mock('../llamaCppDownloads.js', async (original) => ({
  ...(await original<typeof import('../llamaCppDownloads.js')>()),
  resolveHfRepository: mocks.resolve,
}));
vi.mock('../llamaCppService.js', () => ({ getManagedLlamaCppService: vi.fn() }));
import { registerLlamaCppHandlers } from '../llamaCppIpc.js';

function harness() {
  const handlers = new Map<string, IpcHandler>();
  let owner = { dataOwnerId: 'owner-a', generation: 1 };
  const service = {
    snapshot: vi.fn().mockResolvedValue({ models: [] }),
    install: vi.fn(),
    download: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    remove: vi.fn(),
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    dispose: vi.fn(),
  };
  const deps = {
    service,
    userDataDir: '/unused',
    assertTrustedSender: vi.fn(),
    refreshCatalog: vi.fn(),
    broadcastChanged: vi.fn(),
    currentOwnerSession: () => owner,
  };
  registerLlamaCppHandlers(
    {
      handle: (key, fn) => {
        handlers.set(key, fn);
      },
    },
    deps,
  );
  return {
    service,
    deps,
    invoke: (key: string, ...args: unknown[]) => handlers.get(key)!({}, ...args),
    changeOwner: () => {
      owner = { dataOwnerId: 'owner-b', generation: 2 };
    },
  };
}
beforeEach(() => vi.clearAllMocks());
describe('managed llama.cpp IPC boundary', () => {
  it.each([
    MAKER_INVOKE.LLAMACPP_STATUS,
    MAKER_INVOKE.LLAMACPP_DOWNLOAD,
    MAKER_INVOKE.LLAMACPP_START,
  ])('never publishes an inventory when scanning fails through %s', async (channel) => {
    const h = harness();
    h.service.snapshot.mockRejectedValueOnce(
      Object.assign(new Error('scan failed'), { code: 'EACCES' }),
    );
    await expect(h.invoke(channel, { repo: 'owner/repo', file: 'a.gguf' })).rejects.toThrow(
      'LLAMACPP_OPERATION_FAILED',
    );
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(h.deps.refreshCatalog).not.toHaveBeenCalled();
    expect(h.deps.broadcastChanged).not.toHaveBeenCalled();
  });
  it('reconciles installed files for the current owner without repeated catalog broadcasts', async () => {
    const h = harness();
    const models = [{ id: 'model', repo: 'owner/repo', file: 'a.gguf', size: 10 }];
    h.service.snapshot.mockResolvedValue({ models });
    mocks.ensure
      .mockImplementationOnce(async (_models, active) => {
        expect(active()).toBe(true);
        return true;
      })
      .mockResolvedValue(false);
    await h.invoke(MAKER_INVOKE.LLAMACPP_STATUS);
    await h.invoke(MAKER_INVOKE.LLAMACPP_STATUS);
    expect(mocks.ensure).toHaveBeenCalledWith(models, expect.any(Function), expect.any(Array));
    expect(h.deps.broadcastChanged).toHaveBeenCalledOnce();
    expect(h.service.start).not.toHaveBeenCalled();
  });
  it('validates pause/resume controls and totals every shard for the manual picker', async () => {
    const h = harness();
    await h.invoke(MAKER_INVOKE.LLAMACPP_CANCEL, 'pause');
    await h.invoke(MAKER_INVOKE.LLAMACPP_CANCEL, 'resume');
    await h.invoke(MAKER_INVOKE.LLAMACPP_CANCEL);
    expect(h.service.pause).toHaveBeenCalledOnce();
    expect(h.service.resume).toHaveBeenCalledOnce();
    expect(h.service.cancel).toHaveBeenCalledOnce();
    await expect(h.invoke(MAKER_INVOKE.LLAMACPP_CANCEL, 'unknown')).rejects.toThrow(
      'INVALID_PARAMS',
    );
    mocks.resolve.mockResolvedValue({
      files: [1, 2].map((i) => ({
        name: `model-0000${i}-of-00002.gguf`,
        size: 10,
        sha256: 'a'.repeat(64),
      })),
    });
    expect(await h.invoke(MAKER_INVOKE.LLAMACPP_FILES, 'owner/model')).toEqual([
      { name: 'model-00001-of-00002.gguf', size: 20 },
    ]);
  });
  it('adds the provider without waiting for any runtime operation', async () => {
    const h = harness();
    mocks.ensure.mockResolvedValue(undefined);
    await h.invoke(MAKER_INVOKE.LLAMACPP_ENSURE);
    expect(mocks.ensure).toHaveBeenCalledWith(undefined, expect.any(Function));
    expect(h.service.snapshot).not.toHaveBeenCalled();
    expect(h.service.install).not.toHaveBeenCalled();
    expect(h.service.start).not.toHaveBeenCalled();
    expect(h.service.download).not.toHaveBeenCalled();
    expect(h.deps.broadcastChanged).toHaveBeenCalledOnce();
  });
  it('publishes downloaded models automatically without restarting an active server', async () => {
    const h = harness();
    mocks.ensure.mockResolvedValue(undefined);
    const models = [{ id: 'model', repo: 'owner/repo', file: 'a.gguf', size: 10 }];
    h.service.snapshot.mockResolvedValue({ models });
    await h.invoke(MAKER_INVOKE.LLAMACPP_DOWNLOAD, { repo: 'owner/repo', file: 'a.gguf' });
    expect(mocks.ensure).toHaveBeenCalledWith(models, expect.any(Function), expect.any(Array));
    expect(h.deps.broadcastChanged).toHaveBeenCalledOnce();
    expect(h.service.start).not.toHaveBeenCalled();
  });
  it('does not publish cancelled downloads or write downloads to a switched account', async () => {
    const h = harness();
    h.service.download.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'));
    await expect(
      h.invoke(MAKER_INVOKE.LLAMACPP_DOWNLOAD, { repo: 'owner/repo', file: 'a.gguf' }),
    ).rejects.toThrow('OPERATION_CANCELLED');
    expect(mocks.ensure).not.toHaveBeenCalled();
    h.service.download.mockImplementation(async () => h.changeOwner());
    mocks.ensure.mockImplementation(async (_models, active) => {
      if (!active()) throw new Error('OWNER_CHANGED');
    });
    await expect(
      h.invoke(MAKER_INVOKE.LLAMACPP_DOWNLOAD, { repo: 'owner/repo', file: 'a.gguf' }),
    ).rejects.toThrow('OWNER_CHANGED');
    expect(h.deps.broadcastChanged).not.toHaveBeenCalled();
  });
  it('checks sender before installing or downloading', async () => {
    const h = harness();
    h.deps.assertTrustedSender.mockImplementation(() => {
      throw new Error('untrusted');
    });
    await expect(h.invoke(MAKER_INVOKE.LLAMACPP_INSTALL)).rejects.toThrow('untrusted');
    expect(h.service.install).not.toHaveBeenCalled();
  });
  it('rejects arbitrary paths and URLs before download', async () => {
    const h = harness();
    for (const input of [
      null,
      {},
      { repo: 'https://example.test/x', file: 'a.gguf' },
      { repo: 'owner/repo', file: '../a.gguf' },
    ]) {
      await expect(h.invoke(MAKER_INVOKE.LLAMACPP_DOWNLOAD, input)).rejects.toThrow(
        'INVALID_PARAMS',
      );
    }
    expect(h.service.download).not.toHaveBeenCalled();
  });
  it('does not write the provider to a different account after startup', async () => {
    const h = harness();
    h.service.start.mockImplementation(async () => h.changeOwner());
    mocks.ensure.mockImplementation(async (_models, active) => {
      if (!active()) throw new Error('OWNER_CHANGED');
    });
    await expect(h.invoke(MAKER_INVOKE.LLAMACPP_START)).rejects.toThrow('OWNER_CHANGED');
    expect(h.deps.refreshCatalog).not.toHaveBeenCalled();
  });
  it('refreshes the catalog after connecting and never exposes filesystem errors', async () => {
    const h = harness();
    mocks.ensure.mockResolvedValue(undefined);
    await h.invoke(MAKER_INVOKE.LLAMACPP_START);
    expect(h.deps.broadcastChanged).toHaveBeenCalledOnce();
    h.service.install.mockRejectedValue(new Error('write /private/user/secret-file failed'));
    await expect(h.invoke(MAKER_INVOKE.LLAMACPP_INSTALL)).rejects.toThrow(
      'LLAMACPP_OPERATION_FAILED',
    );
  });
  it('distinguishes cancellation from completion', async () => {
    const h = harness();
    h.service.install.mockRejectedValue(new DOMException('cancelled', 'AbortError'));
    await expect(h.invoke(MAKER_INVOKE.LLAMACPP_INSTALL)).rejects.toThrow('OPERATION_CANCELLED');
  });
});
