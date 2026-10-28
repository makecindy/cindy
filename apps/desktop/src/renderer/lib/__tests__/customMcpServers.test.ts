import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomMcpServer, updateCustomMcpServer } from '../customMcpServers';

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

// Protect the real settings save path: a failed secure write must not look
// like a completed MCP installation or release a waiting original-task input.
const config = { id: 'tools', name: 'Tools', transport: 'http' as const,
  url: 'https://example.test/mcp', headers: {} };

function setup() {
  const maker = {
    createCustomMcpServer: vi.fn(async () => ({ ok: true, saveId: 'save' })),
    updateCustomMcpServer: vi.fn(async () => ({ ok: true, saveId: 'save' })),
    refreshCustomMcpCodex: vi.fn(async () => ({ ok: true })),
  };
  const api = { maker, safeStorageStore: vi.fn(async () => true),
    safeStorageRemove: vi.fn(async () => ({ success: true })) };
  vi.stubGlobal('window', { electronAPI: api });
  return api;
}

afterEach(() => vi.unstubAllGlobals());

describe('MCP configuration and credential save boundary', () => {
  it('commits the revision only after the secure write completes', async () => {
    const api = setup();
    let finish!: (ok: boolean) => void;
    api.safeStorageStore.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const saving = createCustomMcpServer(config, 'fixture');
    await vi.waitFor(() => expect(api.safeStorageStore).toHaveBeenCalledOnce());
    expect(api.maker.refreshCustomMcpCodex).not.toHaveBeenCalled();
    finish(true);
    await saving;
    expect(api.maker.createCustomMcpServer).toHaveBeenCalledWith(config, { deferRuntimeRefresh: true });
    expect(api.maker.refreshCustomMcpCodex).toHaveBeenCalledExactlyOnceWith({ saveId: 'save', committed: true });
  });

  it.each(['write', 'remove'] as const)('reports a failed secure %s and rejects the stable commit', async kind => {
    const api = setup();
    api.safeStorageStore.mockResolvedValue(false);
    api.safeStorageRemove.mockResolvedValue({ success: false });
    await expect(updateCustomMcpServer(config, kind === 'write' ? 'fixture' : '', true))
      .rejects.toThrow('credentialSaveFailed');
    expect(api.maker.refreshCustomMcpCodex).toHaveBeenCalledExactlyOnceWith({ saveId: 'save', committed: false });
  });

  it('commits a configuration-only edit without erasing the existing credential', async () => {
    const api = setup();
    await updateCustomMcpServer(config, '', false);
    expect(api.safeStorageStore).not.toHaveBeenCalled();
    expect(api.safeStorageRemove).not.toHaveBeenCalled();
    expect(api.maker.refreshCustomMcpCodex).toHaveBeenCalledExactlyOnceWith({ saveId: 'save', committed: true });
  });
});
