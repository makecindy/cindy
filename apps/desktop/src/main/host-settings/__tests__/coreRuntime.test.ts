import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreSettingsReadContext } from '../readers/core.js';

const mocks = vi.hoisted(() => {
  const inspect = () => vi.fn(() => ({ status: 'unreadable' as const }));
  return {
    context: null as CoreSettingsReadContext | null,
    getContext: vi.fn(),
    forbidden: vi.fn(() => { throw new Error('No runtime, credential, filesystem, or network initialization'); }),
    stores: {
      collaboration: inspect(), agentResource: inspect(), gitSafety: inspect(), memory: inspect(),
      compaction: inspect(), piCompaction: inspect(), silentEncryptedRetry: inspect(),
      chatEmbedding: inspect(), lsp: inspect(), subagentModel: inspect(), auxiliaryModel: inspect(),
      botModelChain: inspect(), terminal: inspect(), windowBehavior: inspect(),
      deviceLink: inspect(), updateChannel: inspect(), autoUpdate: inspect(), analytics: inspect(),
      logUpload: inspect(),
    },
  };
});

vi.mock('../readContext.js', () => ({ getSettingsReadContext: mocks.getContext }));
vi.mock('../../maker-host/collaboration-settings-store.js', () => ({ inspectCollaborationSettings: mocks.stores.collaboration }));
vi.mock('../../maker-host/agent-resource-settings-store.js', () => ({ inspectAgentResourceSettings: mocks.stores.agentResource }));
vi.mock('../../maker-host/git-safety-settings-store.js', () => ({ inspectGitSafetySettings: mocks.stores.gitSafety }));
vi.mock('../../maker-host/memory-settings-store.js', () => ({ inspectMemorySettings: mocks.stores.memory }));
vi.mock('../../maker-host/compaction-settings-store.js', () => ({
  inspectCompactionSettings: mocks.stores.compaction, inspectPiCompactionSettings: mocks.stores.piCompaction,
}));
vi.mock('../../maker-host/silent-encrypted-retry-store.js', () => ({ inspectSilentEncryptedRetrySettings: mocks.stores.silentEncryptedRetry }));
vi.mock('../../maker-host/chat-embedding-settings-store.js', () => ({ inspectChatEmbeddingSettings: mocks.stores.chatEmbedding }));
vi.mock('../../maker-host/lsp-mode-store.js', () => ({ inspectLspModeSettings: mocks.stores.lsp }));
vi.mock('../../maker-host/subagent-model-settings-store.js', () => ({ inspectSubagentModelSettings: mocks.stores.subagentModel }));
vi.mock('../../utility-model/auxiliary-model-settings-store.js', () => ({ inspectAuxiliaryModelSettings: mocks.stores.auxiliaryModel }));
vi.mock('../../maker-host/bot-model-chain-settings-store.js', () => ({ inspectBotModelChainSettings: mocks.stores.botModelChain }));
vi.mock('../../terminal/terminalPrefsStore.js', () => ({ inspectTerminalPrefs: mocks.stores.terminal }));
vi.mock('../../window-behavior-settings-store.js', () => ({ inspectWindowBehaviorSettings: mocks.stores.windowBehavior }));
vi.mock('../../device-link/settings-store.desktop.js', () => ({ inspectDeviceLinkSettings: mocks.stores.deviceLink }));
vi.mock('../../updateChannelStore.js', () => ({ inspectUpdateChannelSettings: mocks.stores.updateChannel }));
vi.mock('../../auto-update-settings-store.js', () => ({ inspectAutoUpdateSettings: mocks.stores.autoUpdate }));
vi.mock('../../analytics-settings-store.js', () => ({ inspectAnalyticsSettings: mocks.stores.analytics }));
vi.mock('../../log-upload/logUploadSettingsStore.js', () => ({ inspectLogUploadSettings: mocks.stores.logUpload }));
vi.mock('electron', () => ({ app: { getPath: mocks.forbidden }, safeStorage: { decryptString: mocks.forbidden } }));
vi.mock('../../authManager.js', () => ({ getAuthState: mocks.forbidden, getAccessToken: mocks.forbidden }));
vi.mock('node:fs', () => ({ readFileSync: mocks.forbidden, mkdirSync: mocks.forbidden, writeFileSync: mocks.forbidden }));

import { inspectCoreSettingsForSnapshot } from '../readers/coreRuntime.js';

// Recorded before any test resets the mocks: importing the adapter must not read anything.
const callsDuringImport = [mocks.getContext, mocks.forbidden, ...Object.values(mocks.stores)]
  .map((spy) => spy.mock.calls.length);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context = {
    mode: 'cloud', dataOwnerId: 'membership-test', generation: 7,
    ownerRoot: '/test-profile/owners/hashed-member', userDataPath: '/test-profile',
    isAuthenticated: true, membershipKind: 'org', platform: 'darwin', arch: 'arm64',
  };
  mocks.getContext.mockImplementation(() => mocks.context ? { ...mocks.context } : null);
  for (const mock of Object.values(mocks.stores)) mock.mockImplementation(() => ({ status: 'unreadable' }));
  vi.stubGlobal('fetch', mocks.forbidden);
});
afterEach(() => {
  expect(mocks.forbidden).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('core production reader adapter', () => {
  it('performs no read, identity resolution, or runtime initialization when imported', () => {
    expect(callsDuringImport.every((calls) => calls === 0)).toBe(true);
  });

  it.each(['darwin', 'win32', 'linux'] as const)('wires the real core aggregate to the correct native inspectors on %s', (platform) => {
    mocks.context!.platform = platform;
    mocks.context!.arch = 'x64';
    const result = inspectCoreSettingsForSnapshot();
    for (const [name, inspect] of Object.entries(mocks.stores)) {
      const applicable = name === 'windowBehavior' ? platform !== 'darwin' : true;
      expect(inspect, name).toHaveBeenCalledTimes(applicable ? 1 : 0);
    }
    expect(result.fields['collaboration.workerSoftLimit']).toEqual({ status: 'unreadable' });
    // The app has no vision bridge; its frozen collection reads unsupported without a store.
    expect(result.collections?.visionBridgeTargets).toEqual({ status: 'unsupported' });
    expect(result.fields['voice.refinerChain']).toBe(result.fields['auxiliaryModel.models']);
    const context = mocks.context!;
    for (const name of ['memory', 'compaction', 'piCompaction', 'subagentModel', 'botModelChain'] as const) {
      expect(mocks.stores[name]).toHaveBeenCalledWith(context.ownerRoot);
    }
    expect(result.fields['iosSimulator.autoOpenEmbeddedPanel']).toEqual({ status: 'unsupported' });
    expect(result.fields['contacts.enabled']).toEqual({ status: 'unsupported' });
    expect(mocks.stores.chatEmbedding).toHaveBeenCalledWith({
      ownerRoot: context.ownerRoot, userDataPath: context.userDataPath,
      context: { mode: 'cloud', isAuthenticated: true, userId: context.dataOwnerId, membershipKind: 'org' },
    });
    expect(mocks.stores.auxiliaryModel).toHaveBeenCalledWith({
      ownerRoot: context.ownerRoot, userDataPath: context.userDataPath, ownerId: context.dataOwnerId,
    });
  });

  it('does not invoke any native inspector when the committed context is unavailable', () => {
    mocks.context = null;
    const result = inspectCoreSettingsForSnapshot();
    expect(Object.values(result.fields).every((field) => field.status === 'unavailable')).toBe(true);
    for (const inspect of Object.values(mocks.stores)) expect(inspect).not.toHaveBeenCalled();
  });

  it('stops subsequent native reads and discards all fields when the owner generation changes', () => {
    mocks.stores.collaboration.mockImplementation(() => {
      mocks.context!.generation++;
      return { status: 'unreadable' };
    });
    const result = inspectCoreSettingsForSnapshot();
    expect(Object.values(result.fields).every((field) => field.status === 'unavailable')).toBe(true);
    expect(result.collections?.visionBridgeTargets).toEqual({ status: 'unavailable' });
    expect(mocks.stores.collaboration).toHaveBeenCalledTimes(1);
    expect(mocks.stores.agentResource).not.toHaveBeenCalled();
    expect(mocks.stores.memory).not.toHaveBeenCalled();
  });
});
