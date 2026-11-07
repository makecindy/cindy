/**
 * Real migration registration, with explicit file-local host boundaries.
 * No real settings file, database, device, credential store or host service is loaded.
 * The normalize callback and checklist predicate are supplied by register.ts itself.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistedSetupMigrationState, SetupMigrationServiceDeps } from '../service.js';
import type { SetupMigrationChecklistItem } from '../../../shared/setupMigration.js';

const h = vi.hoisted(() => {
  const blocked = vi.fn((): never => { throw new Error('unexpected host boundary in register test'); });
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  log.child.mockReturnValue(log);
  return {
    blocked, log, ipcHandle: vi.fn(), snapshotHandler: vi.fn(), transferHandler: vi.fn(),
    oldBearer: vi.fn(() => 'fake-orphaned-old-bearer'),
    deps: undefined as SetupMigrationServiceDeps | undefined,
    normalize: undefined as ((raw: unknown) => PersistedSetupMigrationState) | undefined,
    disk: '',
  };
});

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: h.blocked }, ipcMain: { handle: h.ipcHandle } }));
vi.mock('../../maker-host/override-settings-file.js', () => ({
  createOverrideSettingsFile: (options: { label: string; defaults: PersistedSetupMigrationState; normalize(raw: unknown): PersistedSetupMigrationState }) => {
    if (options.label !== 'setup-migration') throw new Error('unexpected settings store');
    h.normalize = options.normalize;
    const read = () => options.normalize(JSON.parse(h.disk || JSON.stringify(options.defaults)));
    return {
      read,
      writePatchAtomic: async (patch: Partial<PersistedSetupMigrationState>) => {
        // Only the disk boundary is fake. Both directions invoke the actual normalizer.
        h.disk = JSON.stringify(options.normalize({ ...read(), ...patch }));
      },
    };
  },
}));
vi.mock('../service.js', () => ({
  createSetupMigrationService: (deps: SetupMigrationServiceDeps) => { h.deps = deps; return {}; },
}));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  readCustomMcpToken: h.oldBearer,
  getProviderSecretStore: h.blocked, providerSecretSavedForSetup: h.blocked, readCustomProviderKey: h.blocked,
}));
vi.mock('../../logger.js', () => ({ createLogger: () => h.log }));
vi.mock('../../maker-host/logger-adapter.js', () => ({ desktopMakerLogger: h.log }));
vi.mock('../settingsGroups.js', () => ({ SETUP_SETTINGS_GROUPS: [] }));
vi.mock('../rendererPrefsHost.js', () => ({ registerSetupMigrationRendererHost: () => ({ read: h.blocked }) }));
vi.mock('../../device-link/dispatch.js', () => ({
  setSetupSnapshotRemoteHandler: h.snapshotHandler, setSetupTransferRemoteHandler: h.transferHandler,
}));
vi.mock('../transfer.js', () => ({ createSetupTransferSource: () => h.blocked, requestSetupTransfer: h.blocked }));

// Named host imports are cut at this file's boundary, not recursively auto-mocked.
// None of these operations is part of the predicate/normalizer contract under test.
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: h.blocked, getActiveAppSession: h.blocked, isAppSessionBoundaryPending: h.blocked, ownerScopedUserDataPath: h.blocked }));
vi.mock('../../cindy-brain/index.js', () => ({ createWindowGhostInstallConsentPrompt: h.blocked, getGhostManager: h.blocked, getGhostSetupAssessment: h.blocked, readGhostUserSecretsForSetup: h.blocked, hasGhostUserSecretsForSetup: h.blocked, setGhostEnabledForUser: h.blocked, storeGhostUserSecretsForSetup: h.blocked }));
vi.mock('../../device-link/index.js', () => ({ remoteBackgroundInvoke: h.blocked }));
vi.mock('../../device-link/ipc.js', () => ({ defaultDeps: h.blocked, handleListDevices: h.blocked }));
vi.mock('../../device-link/settings-store.js', () => ({ readDeviceLinkSettings: h.blocked }));
vi.mock('../../im/ownerScopedStorage.js', () => ({ ownerScopedImSecrets: h.blocked }));
vi.mock('../../maker-host/active-catalog.js', () => ({ getActiveCatalog: h.blocked }));
vi.mock('../../maker-host/custom-mcp-store.js', () => ({ listCustomMcpNamesForSetup: h.blocked, listCustomMcpServers: h.blocked }));
vi.mock('../../maker-host/custom-provider-header-secrets.js', () => ({ hydrateCustomProviderHeaders: h.blocked }));
vi.mock('../../maker-host/custom-provider-store.js', () => ({ listCustomProviders: h.blocked }));
vi.mock('../../maker-ipc/mcpHandlers.js', () => ({ createCustomMcpServerForSetup: h.blocked }));
vi.mock('../../maker-ipc/providerHandlers.js', () => ({ createCustomProviderFromMain: h.blocked }));
vi.mock('../../maker-host/index.js', () => ({ getPluginRegistry: h.blocked }));
vi.mock('../../plugin-market/service.js', () => ({ getPluginMarketService: h.blocked }));
vi.mock('../../remote-ssh/index.js', () => ({ getRemoteSshPool: h.blocked, getRemoteSshPoolHydrated: h.blocked }));
vi.mock('../../remote-ssh/ssh-keys.js', () => ({ generateNewKey: h.blocked }));
vi.mock('../../remote-ssh/setupMigrationSsh.js', () => ({ addAndCheckSetupSshHost: h.blocked, authorizeSetupSshKey: h.blocked, listSetupSshHosts: h.blocked, localSshHostIds: h.blocked }));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: h.blocked }));
vi.mock('../../skillhub/activationPreferences.js', () => ({ setCindySkillEnabled: h.blocked }));
vi.mock('../../skillhub/installService.js', () => ({ install: h.blocked }));
vi.mock('../../skillhub/installLock.js', () => ({ tryAcquireSkillInstallLock: h.blocked }));
vi.mock('../../skillhub/scanner.js', () => ({ scanAllSkills: h.blocked }));
vi.mock('../../utils/ipcValidate.js', () => ({ throwIpcError: h.blocked }));
vi.mock('../transferPrompt.js', () => ({ confirmSetupTransfer: h.blocked }));


function deps(): SetupMigrationServiceDeps {
  if (!h.deps) throw new Error('real register did not construct the service dependencies');
  return h.deps;
}
function normalize(raw: unknown): PersistedSetupMigrationState {
  if (!h.normalize) throw new Error('real register did not supply its normalizer');
  return h.normalize(raw);
}
const item = (overrides: Partial<SetupMigrationChecklistItem> = {}): SetupMigrationChecklistItem => ({
  id: 'mcp-token:docs', kind: 'mcp-token', label: 'Docs', ref: 'docs', ...overrides,
});
const stateWith = (checklist: unknown[]) => ({
  suggestionDismissed: false,
  lastRun: { sourceName: 'Old computer', finishedAt: 1, checklist },
});

beforeAll(async () => {
  const { registerSetupMigration } = await import('../register.js');
  registerSetupMigration({ getMaker: h.blocked, getManagedSkillRoots: h.blocked, getBuiltInSkills: h.blocked, getMainWindow: h.blocked });
  expect(h.normalize).toBeTypeOf('function');
  expect(h.deps).toBeDefined();
  expect(h.snapshotHandler).toHaveBeenCalledTimes(1);
  expect(h.transferHandler).toHaveBeenCalledTimes(1);
  expect(h.ipcHandle).toHaveBeenCalledTimes(5);
  expect(h.blocked).not.toHaveBeenCalled();
});
beforeEach(() => {
  h.disk = '';
  h.oldBearer.mockClear();
  h.blocked.mockClear();
});

describe('real setup-migration registration callbacks', () => {
  it('retains the copied flag through actual normalization and fake disk round trips', async () => {
    const normalized = normalize(stateWith([item({ mcpCredentialsCopied: true })]));
    await deps().writeState(normalized);
    const first = deps().readState();
    expect(first.lastRun?.checklist[0]).toEqual(item({ mcpCredentialsCopied: true }));
    // Rehydrate JSON, then go through the same production callback again.
    h.disk = JSON.stringify(JSON.parse(h.disk));
    const second = deps().readState();
    expect(second).toEqual(first);
    expect(deps().checklistItemDone(second.lastRun!.checklist[0])).toBe(true);
    expect(h.oldBearer).not.toHaveBeenCalled();
    expect(h.blocked).not.toHaveBeenCalled();
  });

  it.each([undefined, false, 'true', 1, null])('drops malformed copy flags without inventing completion: %j', (flag) => {
    const normalized = normalize(stateWith([{ ...item(), mcpCredentialsCopied: flag }]));
    const pending = normalized.lastRun!.checklist[0];
    expect(Object.hasOwn(pending, 'mcpCredentialsCopied')).toBe(false);
    expect(deps().checklistItemDone(pending)).toBe(false);
    expect(h.oldBearer).not.toHaveBeenCalled();
  });

  it.each(['plugin-setup', 'provider-key', 'ssh-host'] as const)('does not retain an MCP-only flag on %s', (kind) => {
    const normalized = normalize(stateWith([item({ kind, mcpCredentialsCopied: true })]));
    expect(Object.hasOwn(normalized.lastRun!.checklist[0], 'mcpCredentialsCopied')).toBe(false);
  });

  it('never reads an orphan old bearer to complete a failed current copy with no flag', async () => {
    // The writer outcome is represented by the pending checklist produced by apply.
    // This test targets the real registered live predicate, not the writer implementation.
    const pending = normalize(stateWith([item()]));
    await deps().writeState(pending);
    const restored = deps().readState().lastRun!.checklist[0];
    expect(deps().checklistItemDone(restored)).toBe(false);
    expect(restored.done).not.toBe(true);
    expect(h.oldBearer).not.toHaveBeenCalled();
    expect(h.blocked).not.toHaveBeenCalled();
  });

  it('keeps old/manual done on disk even when no new-copy flag is available', async () => {
    await deps().writeState(normalize(stateWith([item({ done: true })])));
    const restored = deps().readState().lastRun!.checklist[0];
    expect(restored.done).toBe(true);
    expect(restored.mcpCredentialsCopied).toBeUndefined();
    // service.ts preserves done before consulting this live predicate (covered there).
    expect(h.oldBearer).not.toHaveBeenCalled();
    expect(h.blocked).not.toHaveBeenCalled();
  });
});
