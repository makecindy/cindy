import { describe, expect, it, vi } from 'vitest';
import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';
import { GhostCardActionDispatcher } from '../cardActionDispatch.js';
import { GhostPreviewGate } from '../previewGate.js';
import { ghostInstallApprovalToken, ghostWebviewEntryPaths, type InstalledGhost } from '../../../shared/ghost.js';
import { findInstalledGhostByInstanceId, installedGhostLogicalIdentity, installedGhostPhysicalKeys, installedGhostStoragePart,
  parsePluginStoragePart, pluginStoragePart, resolveInstalledGhost } from '../../../shared/pluginIdentity.js';
import { ownerScopedGhostPartitionForInstalledGhost, resolveGhostWebviewPartitionClaim } from '../ghostWebviewPartition.js';

const load = createGhostProductionCallbacks<{
  resolveGhostWebviewAttach: (claim: string, src: string) => { ghost: InstalledGhost } | null;
  getGhostCardActionDispatcher: () => GhostCardActionDispatcher;
  resolveMobilePluginMedia: (id: string, url: string, current: () => boolean) => Promise<unknown>;
  setGhostEnabledForUser: (id: string, enabled: boolean, expectedInstalledApproval?: string) => Promise<{ ok: true }>;
}>({ functions: ['findGhostForInstanceId', 'findGhostForPhysicalStoragePart', 'resolveGhostWebviewAttach',
  'getGhostCardActionDispatcher', 'resolveMobilePluginMedia', 'setGhostEnabledForUser'],
  initialize: 'let cardActionDispatcherSingleton = null;' });

function harness() {
  const root: InstalledGhost = { manifest: { schemaVersion: 3, id: 'helper', name: 'Root', version: '1.0.0',
    kind: 'chip', entry: 'main.js', panel: { html: 'panel.html' }, settingsHtml: 'settings.html', card: {} },
    namespace: null, dir: '/ghosts/_ns/_root/helper', enabled: true,
    approval: { state: 'approved', revision: 'root' } };
  const organization: InstalledGhost = { ...root, namespace: 'acme', dir: '/ghosts/helper',
    manifest: { ...root.manifest, name: 'Organization' }, approval: { state: 'approved', revision: 'org' } };
  const ghosts = [organization, root];
  let storedId = 'helper';
  const send = vi.fn(() => true);
  const setEnabled = vi.fn(async () => ({}));
  const stop = vi.fn();
  const ghostCanRead = vi.fn(async () => true);
  const preview = new GhostPreviewGate({ ghostCanRead,
    getBlobInfo: async () => ({ mimeType: 'image/png', ext: '.png' }),
    blobUrl: (hash, ext) => 'cindy-media://blobs/' + hash + ext });
  const api = load({ availableGhosts: () => ghosts, findInstalledGhostByInstanceId, resolveInstalledGhost,
    installedGhostPhysicalKeys,
    requireGhostAvailableForActiveSession: vi.fn(), getGhostManager: () => ({ setEnabled }),
    beginGhostMutation: () => vi.fn(), captureGhostMutationOwner: vi.fn(),
    getGhostNodeRuntimeBroker: () => ({ stop }), getGhostSubscriptionGateway: () => ({ dropGhost: vi.fn() }),
    getGhostErrandSlot: () => ({ clearGhost: vi.fn() }),
    getGhostLibrarySlot: () => ({ disposeGhost: vi.fn() }),
    suspendGhostUnreadProjection: vi.fn(), refreshMivoLibraryExtraDirGrant: async () => {},
    broadcastGhostsChanged: vi.fn(),
    throwIpcError: (code: string) => { throw new Error(code); },
    installedGhostLogicalIdentity, installedGhostStoragePart, pluginStoragePart, parsePluginStoragePart,
    resolveGhostWebviewPartitionClaim, ownerScopedGhostPartitionForInstalledGhost, ghostWebviewEntryPaths,
    getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: 'owner', generation: 1 }),
    GHOST_SCHEME: 'cindy-ghost', ensureGhostProtocolRegistered: vi.fn(), GhostCardActionDispatcher,
    getGhostCardService: () => ({ callInfoOf: () => null, reopenForAction: vi.fn() }),
    getGhostCard: async () => ({ ghostId: storedId, sessionId: 'old-user-task' }),
    getGhostRuntime: () => ({ stateOf: () => 'running', spawn: vi.fn(async () => ({ ok: true })), stop }),
    sendToGhostLogic: send, getGhostAgentSlot: () => ({ issueUserActionToken: () => null, clearGhost: vi.fn() }),
    getGhostSessionActivityTracker: () => ({ begin: vi.fn() }), ghostOwnerScope: undefined,
    ghostInstallApprovalToken, log: { info: vi.fn(), warn: vi.fn() },
    getGhostPreviewGate: () => preview,
  });
  return { ...api, root, organization, ghosts, send, setEnabled, stop, ghostCanRead, setStoredId: (id: string) => { storedId = id; } };
}

describe('production plugin instance boundaries', () => {
  it('rejects a confirmed close after source replacement before stopping any runtime', async () => {
    const fixture = harness();
    const confirmedApproval = ghostInstallApprovalToken(fixture.organization.approval);
    fixture.organization.approval = { state: 'approved', revision: 'replacement' };
    await expect(fixture.setGhostEnabledForUser('helper', false, confirmedApproval)).rejects.toThrow('NOT_FOUND');
    expect(fixture.setEnabled).not.toHaveBeenCalled();
    expect(fixture.stop).not.toHaveBeenCalled();
    const currentApproval = ghostInstallApprovalToken(fixture.organization.approval);
    await fixture.setGhostEnabledForUser('helper', false, currentApproval);
    expect(fixture.setEnabled).toHaveBeenCalledExactlyOnceWith('helper', false, currentApproval);
  });
  it('does not disable a logical twin after the original physical target disappears', async () => {
    const fixture = harness();
    await fixture.setGhostEnabledForUser('helper', false);
    expect(fixture.setEnabled).toHaveBeenCalledWith('helper', false, ghostInstallApprovalToken(fixture.organization.approval));
    fixture.setEnabled.mockClear();
    fixture.stop.mockClear();
    fixture.ghosts.splice(0, 1);
    await expect(fixture.setGhostEnabledForUser('helper', false)).rejects.toThrow('NOT_FOUND');
    expect(fixture.setEnabled).not.toHaveBeenCalled();
    expect(fixture.stop).not.toHaveBeenCalled();
  });
  it.each(['root', 'in-place', 'organization'])('opens Mobile media with the protocol host and %s physical authority', async (layout) => {
    const fixture = harness();
    const ghost = layout === 'root' ? fixture.root : fixture.organization;
    if (layout === 'organization') ghost.dir = '/ghosts/_ns/acme/helper';
    const id = installedGhostStoragePart(ghost), hash = 'a'.repeat(64);
    await expect(fixture.resolveMobilePluginMedia(id, 'cindy-ghost://helper/preview/' + hash + '.jpg', () => true))
      .resolves.toEqual({ path: '/media/' + hash + '.png', mediaKind: 'image' });
    expect(fixture.ghostCanRead).toHaveBeenCalledWith(hash, id);
    await expect(fixture.resolveMobilePluginMedia(id, 'cindy-ghost://other/preview/' + hash + '.png', () => true))
      .resolves.toBeNull();
    fixture.ghosts.splice(fixture.ghosts.indexOf(ghost), 1);
    await expect(fixture.resolveMobilePluginMedia(id, 'cindy-ghost://helper/preview/' + hash + '.png', () => true))
      .resolves.toBeNull();
  });
  it.each(['panel.html', 'settings.html'])('attaches the logical root %s beside an in-place enterprise twin', (entry) => {
    const fixture = harness();
    expect(fixture.resolveGhostWebviewAttach('cindy-ghost-_root__helper', 'cindy-ghost://helper/' + entry)?.ghost).toBe(fixture.root);
    expect(fixture.resolveGhostWebviewAttach('cindy-ghost-helper', 'cindy-ghost://helper/' + entry)?.ghost)
      .toBe(fixture.organization);
    expect(fixture.resolveGhostWebviewAttach('cindy-ghost-helper', 'cindy-ghost://helper/undeclared.html')).toBeNull();
  });

  it('never redirects a persisted physical card owner to a logical root after uninstall', async () => {
    const fixture = harness(), dispatcher = fixture.getGhostCardActionDispatcher();
    await expect(dispatcher.dispatch('old-card', 'continue', 'private input')).resolves.toEqual({ ok: true });
    expect(fixture.send).toHaveBeenLastCalledWith('helper', expect.objectContaining({ prompt: 'private input' }));
    fixture.send.mockClear();
    fixture.ghosts.splice(0, 1);
    await expect(dispatcher.dispatch('old-card', 'continue', 'private input')).resolves.toEqual({ ok: false, reason: 'ghost-unavailable' });
    expect(fixture.send).not.toHaveBeenCalled();
    fixture.setStoredId('_root__helper');
    await expect(dispatcher.dispatch('root-card', 'continue')).resolves.toEqual({ ok: true });
    expect(fixture.send).toHaveBeenLastCalledWith('_root__helper', expect.any(Object));
  });
});
