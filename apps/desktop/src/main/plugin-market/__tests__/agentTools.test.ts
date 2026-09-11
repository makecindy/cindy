import { describe, expect, it, vi } from 'vitest';
import { createPluginMarketAgentTools } from '../agentTools.js';
import type { PluginMarketDetail, PluginMarketSnapshot } from '../../../shared/pluginMarket.js';
import type { InstalledGhost } from '../../../shared/ghost.js';
import { throwIpcError } from '../../utils/ipcValidate.js';

function harness(ghostId = 'mail-suite', name = 'Google Gmail') {
  const detail: PluginMarketDetail = {
    pluginId: 'catalog-id', ghostId, name, description: 'Read mail and connect accounts',
    author: 'Publisher', scope: 'public', organizationId: null, defaultInstall: false,
    releaseId: 'release-1', version: '1.0.0', publishedAt: '', icon: null,
    installState: 'not-installed', enabled: null, sourceType: 'server', sourceMarketName: null,
    manifest: { schemaVersion: 3, id: ghostId, name, kind: 'chip', version: '1.0.0', entry: 'main.js' },
  };
  const snapshot: PluginMarketSnapshot = {
    items: [detail], unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [],
  };
  const state = { installed: false, errorCode: null as string | null, current: true };
  const assertCurrent = vi.fn(() => {
    if (!state.current) throwIpcError('PERMISSION_DENIED', 'scope changed');
  });
  const release = vi.fn();
  const market = {
    snapshot: vi.fn(async () => snapshot), detail: vi.fn(async () => detail),
    install: vi.fn(async (_id: string, _options: unknown, guard?: () => void) => {
      guard?.();
      state.installed = true;
      return { ghost: { manifest: detail.manifest, enabled: true } as InstalledGhost };
    }),
  };
  const tools = createPluginMarketAgentTools({
    market, installedState: () => ({ exists: state.installed, errorCode: state.errorCode }),
    captureRead: () => assertCurrent,
    captureInstall: () => { assertCurrent(); return { assertCurrent, release }; },
  });
  return { tools, market, detail, snapshot, state, release };
}

describe('Agent plugin discovery and installation', () => {
  it.each([['mail-suite', 'Google Gmail', 'gmail'], ['image-studio', 'Image creation', 'image']])(
    'discovers and installs %s through the same catalog contract', async (id, name, query) => {
      const h = harness(id, name);
      expect(await h.tools.search(query)).toMatchObject({ ok: true, complete: true, items: [{ ghost_id: id, plugin_id: 'catalog-id', release_id: 'release-1', installed: false }] });
      expect(h.market.snapshot).toHaveBeenCalledWith({ discoveryOnly: true });
      expect(h.market.install).not.toHaveBeenCalled();
      expect(await h.tools.install({ pluginId: 'catalog-id', releaseId: 'release-1' })).toMatchObject({ ok: true, status: 'installed', ghost_id: id });
      expect(h.market.install).toHaveBeenCalledWith('catalog-id', { expectedReleaseId: 'release-1', expectedManifest: h.detail.manifest, allowSourceReplacement: false }, expect.any(Function));
      expect(h.release).toHaveBeenCalledOnce();
    },
  );

  it.each([null, 'GHOST_ASLEEP', 'GHOST_DISABLED_IN_WORKDIR', 'GHOST_NOT_FOUND'])('preserves an existing installation and reports %s', async (errorCode) => {
    const h = harness(); h.state.installed = true; h.state.errorCode = errorCode;
    expect(await h.tools.install({ pluginId: 'catalog-id', releaseId: 'release-1' })).toMatchObject({ status: 'already-installed', plugin: { installed: true, availability: errorCode ?? 'available' } });
    expect(h.market.install).not.toHaveBeenCalled();
  });

  it('distinguishes unavailable sources from an exhaustive empty result without leaking errors', async () => {
    const h = harness(); h.snapshot.items = [];
    h.snapshot.unavailableReason = '/private/credentials?token=secret';
    h.snapshot.unavailableCustomSourceNames = ['private-market'];
    const result = await h.tools.search('image');
    expect(result).toMatchObject({ ok: true, items: [], complete: false, unavailable_sources: ['server', 'custom'] });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('rejects an account switch during discovery before returning old account metadata', async () => {
    const h = harness(); h.market.snapshot.mockImplementation(async () => { h.state.current = false; return h.snapshot; });
    await expect(h.tools.search('gmail')).rejects.toThrow();
  });

  it('rejects a changed release without downloading anything', async () => {
    const h = harness();
    expect(await h.tools.install({ pluginId: 'catalog-id', releaseId: 'old-release' })).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED' });
    expect(h.market.install).not.toHaveBeenCalled(); expect(h.release).toHaveBeenCalledOnce();
  });

  it.each(['scope', 'concurrent-install'])('checks %s again at package placement', async (change) => {
    const h = harness();
    h.market.install.mockImplementation(async (_id, _options, guard) => {
      if (change === 'scope') h.state.current = false; else h.state.installed = true;
      guard?.(); throw new Error('should never reach placement');
    });
    expect(await h.tools.install({ pluginId: 'catalog-id', releaseId: 'release-1' })).toMatchObject({ ok: false, errorCode: change === 'scope' ? 'PERMISSION_DENIED' : 'PRECONDITION_FAILED' });
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('does not leak service errors or claim connection success after installation fails', async () => {
    const h = harness(); h.market.install.mockRejectedValue(new Error('private-token'));
    const result = await h.tools.install({ pluginId: 'catalog-id', releaseId: 'release-1' });
    expect(result).toMatchObject({ ok: false, errorCode: 'INSTALL_UNAVAILABLE' });
    expect(JSON.stringify(result)).not.toContain('private-token'); expect(h.release).toHaveBeenCalledOnce();
  });
});
