import { describe, expect, it, vi } from 'vitest';
import { registerPluginListHandler } from '../pluginListHandler';
import { MAKER_INVOKE } from '../channels';
import { IpcHarness } from './helpers/ipcHarness';

function setup() {
  const items = ['contacts', 'lsp', 'docs'].map((id) => ({
    id, name: id, description: id, source: 'builtin' as const,
    essential: id === 'lsp', effectiveEnabled: true, productDefaultEnabled: true,
  }));
  const listPlugins = vi.fn(async () => items);
  const isBotToolsetAvailable = vi.fn(({ toolsetId }: { toolsetId: string }) => toolsetId === 'docs');
  const assertBotQuery = vi.fn();
  const ipc = new IpcHarness();
  registerPluginListHandler(ipc, { getPluginRegistry: () => ({ listPlugins }), isBotToolsetAvailable, assertBotQuery });
  return { ipc, items, listPlugins, isBotToolsetAvailable, assertBotQuery };
}

describe('Bot-aware plugin catalog IPC', () => {
  it('adds provider availability without changing existing registry fields or legacy queries', async () => {
    const h = setup();
    await expect(h.ipc.invoke(MAKER_INVOKE.PLUGINS_LIST, '/workspace', true)).resolves.toEqual(h.items);
    expect(h.isBotToolsetAvailable).not.toHaveBeenCalled();
    const context = { botId: 'bot-1', agentKind: 'pi', remoteHostId: 'ssh-1' };
    await expect(h.ipc.invoke(MAKER_INVOKE.PLUGINS_LIST, '/workspace', true, context)).resolves.toEqual(
      h.items.map((item) => ({ ...item, available: item.id === 'docs' })),
    );
    expect(h.assertBotQuery).toHaveBeenCalledTimes(1);
    expect(h.isBotToolsetAvailable).toHaveBeenCalledWith({ ...context, workingDir: '/workspace', toolsetId: 'lsp' });
    h.items[2].effectiveEnabled = false;
    await expect(h.ipc.invoke(MAKER_INVOKE.PLUGINS_LIST, '/workspace', true, context)).resolves.toEqual(
      h.items.map((item) => ({ ...item, available: false })),
    );
  });

  it('rejects invalid context and untrusted requests before running provider predicates', async () => {
    const h = setup();
    await expect(h.ipc.invoke(MAKER_INVOKE.PLUGINS_LIST, '', true, { botId: 'bot-1', agentKind: 'unknown' })).rejects.toThrow('INVALID_PARAMS');
    h.assertBotQuery.mockImplementation(() => { throw new Error('untrusted'); });
    await expect(h.ipc.invoke(MAKER_INVOKE.PLUGINS_LIST, '', true, { botId: 'bot-1', agentKind: 'pi' })).rejects.toThrow('untrusted');
    expect(h.isBotToolsetAvailable).not.toHaveBeenCalled();
    expect(h.listPlugins).not.toHaveBeenCalled();
  });
});
