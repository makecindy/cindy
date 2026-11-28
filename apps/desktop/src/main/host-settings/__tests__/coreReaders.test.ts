import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  root: '', owner: 'owner-a', generation: 1, platform: 'darwin' as NodeJS.Platform, arch: 'arm64',
  legacyOtherOwner: false,
  forbidden: vi.fn(() => { throw new Error('Runtime/credential/permission entry must not be called'); }),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('electron', () => ({
  app: { getPath: (name: string) => {
    if (name !== 'userData') return state.forbidden();
    return state.root;
  } },
  safeStorage: { isEncryptionAvailable: state.forbidden, decryptString: state.forbidden },
  systemPreferences: { getMediaAccessStatus: state.forbidden },
}));
vi.mock('electron-store', () => ({ default: state.forbidden }));
vi.mock('../../logger.js', () => ({ createLogger: () => state.log }));
vi.mock('../../maker-host/logger-adapter.js', () => ({ desktopMakerLogger: { child: () => state.log }, createMakerLogger: () => state.log }));
vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: state.forbidden,
  getDataOwnerLifetime: state.forbidden,
  ownerScopedUserDataPath: state.forbidden,
  activeOwnerScopeKey: state.forbidden,
  isAppSessionBoundaryPending: state.forbidden,
  dataOwnerStorageKey: (owner: string) => `test-${owner}`,
}));
// Native stores ask the injected owner context for the ambient owner; pure inspection
// receives its owner root explicitly and must not consult it either.
vi.mock('../../ownerContext.js', () => ({
  configureOwnerContext: () => {},
  ownerScopedPath: state.forbidden, activeDataOwnerId: state.forbidden, hasCommittedOwner: state.forbidden,
  isOwnerBoundaryPending: state.forbidden, ownerGeneration: state.forbidden,
}));
vi.mock('../../ownerNamespaceMigration.js', () => ({
  hasExclusiveSharedLegacyUserDataAccess: state.forbidden,
  hasLegacyOwnerNamespaceClaim: state.forbidden,
  isLegacyOwnerNamespaceClaimedByOtherOwner: () => state.legacyOtherOwner,
}));
vi.mock('../../maker-host/index.js', () => ({ getMakerIfReady: state.forbidden }));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({ getDesktopProviderService: state.forbidden }));
vi.mock('../../maker-host/model-visibility-mirror.js', () => ({
  getModelVisibilityOverride: state.forbidden, waitForModelVisibilityMirror: state.forbidden,
}));
vi.mock('../../maker-host/newMakerDefaultsCache.js', () => ({ getSelectedNewMakerRoute: state.forbidden }));

import { inspectCollaborationSettings } from '../../maker-host/collaboration-settings-store.js';
import { inspectAgentResourceSettings } from '../../maker-host/agent-resource-settings-store.js';
import { inspectGitSafetySettings } from '../../maker-host/git-safety-settings-store.js';
import { inspectMemorySettings } from '../../maker-host/memory-settings-store.js';
import { inspectCompactionSettings, inspectPiCompactionSettings } from '../../maker-host/compaction-settings-store.js';
import { inspectSilentEncryptedRetrySettings } from '../../maker-host/silent-encrypted-retry-store.js';
import { inspectChatEmbeddingSettings } from '../../maker-host/chat-embedding-settings-store.js';
import { inspectLspModeSettings } from '../../maker-host/lsp-mode-store.js';
import { inspectSubagentModelSettings } from '../../maker-host/subagent-model-settings-store.js';
import { inspectAuxiliaryModelSettings } from '../../utility-model/auxiliary-model-settings-store.js';
import { inspectBotModelChainSettings } from '../../maker-host/bot-model-chain-settings-store.js';
import { inspectTerminalPrefs } from '../../terminal/terminalPrefsStore.js';
import { inspectWindowBehaviorSettings } from '../../window-behavior-settings-store.js';
import { inspectDeviceLinkSettings } from '../../device-link/settings-store.desktop.js';
import { inspectUpdateChannelSettings } from '../../updateChannelStore.js';
import { inspectAutoUpdateSettings } from '../../auto-update-settings-store.js';
import { inspectAnalyticsSettings } from '../../analytics-settings-store.js';
import { inspectLogUploadSettings } from '../../log-upload/logUploadSettingsStore.js';
import { encodeCatalogModelPin } from '../../../shared/catalogModelPin.js';
import { SETTINGS_READ_CATALOG } from '../../../shared/settingsReadCatalog.js';
import { supportsBetaUpdateChannel } from '../../../shared/updateChannelCapability.js';
import { CORE_SETTINGS_FIELD_IDS, readCoreSettings, type CoreSettingsStores, type CoreSettingsReadContext } from '../readers/core.js';
import type { SettingsFileInspection } from '../../maker-host/settings-inspection.js';
import { configureUserDataDir } from '../../userDataPath.js';

const stores: CoreSettingsStores = {
  collaboration: inspectCollaborationSettings, agentResource: inspectAgentResourceSettings,
  gitSafety: inspectGitSafetySettings, memory: inspectMemorySettings,
  compaction: inspectCompactionSettings, piCompaction: inspectPiCompactionSettings,
  silentEncryptedRetry: inspectSilentEncryptedRetrySettings,
  chatEmbedding: inspectChatEmbeddingSettings, lsp: inspectLspModeSettings,
  subagentModel: inspectSubagentModelSettings, auxiliaryModel: inspectAuxiliaryModelSettings,
  botModelChain: inspectBotModelChainSettings,
  terminal: inspectTerminalPrefs, windowBehavior: inspectWindowBehaviorSettings,
  deviceLink: inspectDeviceLinkSettings, updateChannel: inspectUpdateChannelSettings,
  autoUpdate: inspectAutoUpdateSettings, analytics: inspectAnalyticsSettings,
  logUpload: inspectLogUploadSettings,
};
function ownerRoot() { return path.join(state.root, 'owners', state.owner); }
function context(): CoreSettingsReadContext {
  return { mode: 'cloud', dataOwnerId: state.owner, generation: state.generation,
    ownerRoot: ownerRoot(), userDataPath: state.root, membershipKind: 'org', isAuthenticated: true,
    platform: state.platform, arch: state.arch };
}
function inspectEmbedding() {
  return inspectChatEmbeddingSettings({ ownerRoot: ownerRoot(), userDataPath: state.root,
    context: { mode: 'cloud', isAuthenticated: true, userId: state.owner, membershipKind: 'org' } });
}
function inspectAuxiliary() {
  return inspectAuxiliaryModelSettings({ ownerRoot: ownerRoot(), userDataPath: state.root, ownerId: state.owner });
}
const privatePin = encodeCatalogModelPin({ agentKind: 'codex', providerId: 'private-provider', model: 'retired/private-model' });
interface Fixture {
  file: string;
  owner?: boolean;
  inspect(): SettingsFileInspection<object>;
  leaf: string;
  value: unknown;
  expected: unknown;
  source?: 'unknown';
  bad: unknown;
}
const fixtures: Fixture[] = [
  { file: 'collaboration-settings.json', inspect: inspectCollaborationSettings, leaf: 'workerSoftLimit', value: 6.5, expected: 6.5, bad: '6' },
  { file: 'agent-resource-settings.json', inspect: inspectAgentResourceSettings, leaf: 'maxConcurrentCommands', value: 3.9, expected: 3, bad: '3' },
  { file: 'git-safety-settings.json', inspect: inspectGitSafetySettings, leaf: 'autoSnapshotEnabled', value: true, expected: true, bad: 1 },
  { file: 'memory-settings.json', owner: true, inspect: () => inspectMemorySettings(ownerRoot()), leaf: 'maker', value: false, expected: false, bad: null },
  { file: 'compaction-settings.json', owner: true, inspect: () => inspectCompactionSettings(ownerRoot()), leaf: 'claudeCodeAutoCompactPct', value: 67.8, expected: 68, bad: '90' },
  { file: 'pi-compaction-settings.json', owner: true, inspect: () => inspectPiCompactionSettings(ownerRoot()), leaf: 'piAutoCompactPct', value: 200, expected: 95, bad: null },
  { file: 'silent-encrypted-retry-settings.json', inspect: inspectSilentEncryptedRetrySettings, leaf: 'enabled', value: false, expected: false, bad: [] },
  { file: 'chat-embedding-settings.json', owner: true, inspect: inspectEmbedding, leaf: 'enabled', value: false, expected: false, bad: 'true' },
  { file: 'lsp-mode-settings.json', inspect: inspectLspModeSettings, leaf: 'enabled', value: true, expected: true, bad: 1, source: 'unknown' },
  { file: 'subagent-model-settings.json', owner: true, inspect: () => inspectSubagentModelSettings(ownerRoot()), leaf: 'claudeCode', value: ' retired-private-model ', expected: 'retired-private-model', bad: 42 },
  { file: 'auxiliary-model-settings.json', owner: true, inspect: inspectAuxiliary, leaf: 'models', value: [privatePin], expected: [privatePin], bad: [12] },
  { file: 'bot-model-chain-settings.json', owner: true, inspect: () => inspectBotModelChainSettings(ownerRoot()), leaf: 'modelChain',
    value: [{ harness: 'pi', model: 'retired-private-model', providerId: 'private-provider', effort: 'old-effort', fastMode: true }],
    expected: [{ harness: 'pi', model: 'retired-private-model', providerId: 'private-provider', effort: 'old-effort', fastMode: true }], bad: [{ model: false }] },
  { file: 'terminal-prefs.json', inspect: inspectTerminalPrefs, leaf: 'defaultShellPref', value: 'wsl', expected: 'wsl', bad: 'unknown-shell', source: 'unknown' },
  { file: 'window-behavior-settings.json', inspect: inspectWindowBehaviorSettings, leaf: 'windowsCloseBehavior', value: 'tray', expected: 'tray', bad: 'hide' },
  { file: 'device-link-settings.json', inspect: inspectDeviceLinkSettings, leaf: 'keepAwake', value: true, expected: true, bad: 'true', source: 'unknown' },
  { file: 'update-channel-settings.json', inspect: inspectUpdateChannelSettings, leaf: 'enableBeta', value: false, expected: false, bad: 0 },
  { file: 'auto-update-settings.json', inspect: inspectAutoUpdateSettings, leaf: 'autoRelaunchOnIdle', value: true, expected: true, bad: 1 },
  { file: 'analytics-settings.json', inspect: inspectAnalyticsSettings, leaf: 'analyticsEnabled', value: true, expected: true, bad: 'true' },
  { file: 'log-upload-settings.json', inspect: inspectLogUploadSettings, leaf: 'crashAutoUploadEnabled', value: false, expected: false, bad: null },
];
function fixturePath(f: Fixture) { return path.join(f.owner ? ownerRoot() : state.root, f.file); }
function write(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}
function treeBytes(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { result[path.relative(root, file)] = '<directory>'; visit(file); }
      else result[path.relative(root, file)] = fs.readFileSync(file).toString('base64');
    }
  }
  visit(root);
  return result;
}
function unchanged<T>(read: () => T): T {
  const root = state.root;
  const before = treeBytes(root);
  const writes = [
    vi.spyOn(fs, 'writeFileSync'), vi.spyOn(fs, 'mkdirSync'), vi.spyOn(fs, 'unlinkSync'),
    vi.spyOn(fs, 'renameSync'), vi.spyOn(fs, 'linkSync'), vi.spyOn(fs, 'rmSync'),
  ];
  const result = read();
  for (const spy of writes) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); }
  expect(treeBytes(root)).toEqual(before);
  expect(state.forbidden).not.toHaveBeenCalled();
  expect(state.log.info).not.toHaveBeenCalled();
  expect(state.log.warn).not.toHaveBeenCalled();
  return result;
}
let base: string;
beforeAll(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'core-settings-')); });
beforeEach(() => {
  state.root = fs.mkdtempSync(path.join(base, 'profile-'));
  // Profile-root stores (e.g. agent-resource) read the injected userData root, not Electron.
  configureUserDataDir(state.root);
  state.owner = 'owner-a'; state.generation = 1; state.platform = 'darwin'; state.arch = 'arm64';
  state.legacyOtherOwner = false;
  vi.clearAllMocks();
  vi.stubGlobal('fetch', state.forbidden);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => { fs.rmSync(base, { recursive: true, force: true }); });

describe.each(fixtures)('$file pure inspection', (f) => {
  it('missing means real defaults and does not create any file or owner directory', () => {
    const result = unchanged(f.inspect);
    expect(result.status).toBe('ready');
    if (result.status === 'ready') expect(Object.values(result.sources)).toEqual(expect.arrayContaining(['default']));
  });
  it('reads fresh authoritative values and preserves bytes and provenance', () => {
    write(fixturePath(f), { [f.leaf]: f.value });
    const result = unchanged(f.inspect);
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect((result.value as Record<string, unknown>)[f.leaf]).toEqual(f.expected);
      expect((result.sources as Record<string, string>)[f.leaf]).toBe(f.source ?? 'override');
    }
    fs.writeFileSync(fixturePath(f), '{bad json');
    expect(unchanged(f.inspect)).toEqual({ status: 'unreadable' });
  });
  it('retains explicit same-as-default provenance instead of inferring from value equality', () => {
    const initial = f.inspect();
    expect(initial.status).toBe('ready');
    if (initial.status !== 'ready') return;
    const defaultValue = (initial.value as Record<string, unknown>)[f.leaf];
    write(fixturePath(f), { [f.leaf]: defaultValue });
    const explicit = unchanged(f.inspect);
    expect(explicit.status).toBe('ready');
    if (explicit.status === 'ready') {
      expect((explicit.sources as Record<string, string>)[f.leaf]).toBe(f.source ?? 'override');
      expect((explicit.value as Record<string, unknown>)[f.leaf]).toEqual(defaultValue);
    }
  });
  it.each(['null', '[]', '42', '"string"', '{truncated'])('preserves malformed root %s rather than repairing/defaulting', (content) => {
    fs.mkdirSync(path.dirname(fixturePath(f)), { recursive: true });
    fs.writeFileSync(fixturePath(f), content);
    expect(unchanged(f.inspect)).toEqual({ status: 'unreadable' });
  });
  it('rejects bad known leaf types without substituting defaults', () => {
    write(fixturePath(f), { [f.leaf]: f.bad });
    expect(unchanged(f.inspect)).toEqual({ status: 'unreadable' });
  });
  it('does not equate a denied read with absence', () => {
    write(fixturePath(f), { [f.leaf]: f.value });
    const original = fs.openSync;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] === fixturePath(f)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return original(...args);
    });
    expect(f.inspect()).toEqual({ status: 'unreadable' });
    spy.mockRestore();
    expect(fs.existsSync(fixturePath(f))).toBe(true);
    expect(state.forbidden).not.toHaveBeenCalled();
  });
});

it('distinguishes explicit default, clear, and legacy unknown evidence', () => {
  const file = path.join(state.root, 'update-channel-settings.json');
  write(file, { orgDefaultEnableBeta: true });
  expect(unchanged(inspectUpdateChannelSettings)).toMatchObject({ status: 'ready', value: { enableBeta: true }, sources: { enableBeta: 'default' } });
  write(file, { orgDefaultEnableBeta: true, enableBeta: false });
  expect(unchanged(inspectUpdateChannelSettings)).toMatchObject({ status: 'ready', value: { enableBeta: false }, sources: { enableBeta: 'override' } });
  fs.unlinkSync(file);
  expect(unchanged(inspectUpdateChannelSettings)).toMatchObject({ status: 'ready', value: { enableBeta: false }, sources: { enableBeta: 'default' } });
  write(path.join(state.root, 'device-link-settings.json'), { remoteControlEnabled: false, keepAwake: false });
  expect(unchanged(inspectDeviceLinkSettings)).toMatchObject({ sources: { remoteControlEnabled: 'unknown', keepAwake: 'unknown', remoteDesktopEnabled: 'default' } });
});

it('Pi observation does not migrate old customized Claude percentages or write its marker', () => {
  write(path.join(ownerRoot(), 'compaction-settings.json'), { claudeCodeAutoCompactPct: 75 });
  expect(unchanged(() => inspectPiCompactionSettings(ownerRoot()))).toEqual({ status: 'migrationPending' });
  write(path.join(ownerRoot(), 'pi-compaction-migrated.json'), { version: 1 });
  expect(unchanged(() => inspectPiCompactionSettings(ownerRoot()))).toMatchObject({ status: 'ready', value: { piAutoCompactPct: 90 }, sources: { piAutoCompactPct: 'default' } });
});

it('embedding resolves account defaults without claiming an unowned legacy opt-out', () => {
  expect(unchanged(inspectEmbedding)).toMatchObject({ value: { enabled: true }, sources: { enabled: 'default' } });
  const personal = () => inspectChatEmbeddingSettings({ ownerRoot: ownerRoot(), userDataPath: state.root,
    context: { mode: 'cloud', isAuthenticated: true, userId: state.owner, membershipKind: 'personal' } });
  expect(unchanged(personal)).toMatchObject({ value: { enabled: false } });
  write(path.join(state.root, 'chat-embedding-settings.json'), { enabled: false });
  expect(unchanged(inspectEmbedding)).toEqual({ status: 'migrationPending' });
  write(path.join(state.root, '.chat-embedding-settings-owner-claim-v1.json'), { version: 1, ownerKey: 'test-owner-a', complete: false });
  expect(unchanged(inspectEmbedding)).toMatchObject({ value: { enabled: false }, sources: { enabled: 'override' } });
  state.owner = 'owner-b';
  expect(unchanged(inspectEmbedding)).toMatchObject({ value: { enabled: true }, sources: { enabled: 'default' } });
});

it('auxiliary reads legacy pins in place, and defers voice migration without adopting another owner', () => {
  const file = path.join(ownerRoot(), 'auxiliary-model-settings.json');
  write(file, { sessionTitleModel: privatePin });
  expect(unchanged(inspectAuxiliary)).toMatchObject({ value: { models: [privatePin] }, sources: { models: 'override' } });
  fs.unlinkSync(file);
  write(path.join(state.root, 'voice-input-models.json'), { utilityModelProvider: 'qwen' });
  expect(unchanged(inspectAuxiliary)).toEqual({ status: 'migrationPending' });
  state.legacyOtherOwner = true;
  expect(unchanged(inspectAuxiliary)).toMatchObject({ status: 'ready', value: { models: [] }, sources: { models: 'default' } });
});

it('subagent orphan and retired fields are not cleaned up; routes do not need live catalog approval', () => {
  write(path.join(ownerRoot(), 'subagent-model-settings.json'), { claudeCodeProviderId: 'private-provider', codexModel: 'retired' });
  expect(unchanged(() => inspectSubagentModelSettings(ownerRoot()))).toMatchObject({ status: 'ready', value: { claudeCode: null, claudeCodeProviderId: null }, sources: { claudeCodeProviderId: 'override' } });
  expect(unchanged(() => inspectBotModelChainSettings(ownerRoot()))).toMatchObject({ status: 'ready', value: { modelChain: [] } });
});

it('does not silently accept empty consent or crash preference records', () => {
  write(path.join(state.root, 'analytics-settings.json'), {});
  write(path.join(state.root, 'log-upload-settings.json'), {});
  expect(unchanged(inspectAnalyticsSettings)).toEqual({ status: 'unreadable' });
  expect(unchanged(inspectLogUploadSettings)).toEqual({ status: 'unreadable' });
});

it('aggregates all fixed leaves with native facts, bounded-domain error isolation, and no private device records', () => {
  write(path.join(state.root, 'collaboration-settings.json'), { workerSoftLimit: 'invalid' });
  write(path.join(state.root, 'device-link-settings.json'), { keepAwake: true, revokedControllers: ['private-device'], lastKnownDeviceNames: { secret: 'private-name' } });
  const result = unchanged(() => readCoreSettings({ getContext: context, stores }));
  expect(Object.keys(result.fields).sort()).toEqual([...CORE_SETTINGS_FIELD_IDS].sort());
  expect(result.fields['collaboration.workerSoftLimit']).toEqual({ status: 'unreadable' });
  expect(result.fields['gitSafety.autoSnapshotEnabled']).toEqual({ status: 'value', value: true, source: 'default' });
  // The app has no vision bridge; its snapshot fields stay in the contract as unsupported.
  expect(result.fields['visionBridge.enabled']).toEqual({ status: 'unsupported' });
  expect(result.collections?.visionBridgeTargets).toEqual({ status: 'unsupported' });
  expect(JSON.stringify(result)).not.toContain('private-device');
  expect(JSON.stringify(result)).not.toContain('private-name');
  for (const id of CORE_SETTINGS_FIELD_IDS) expect(SETTINGS_READ_CATALOG[id]).toBeDefined();
});

it.each(['darwin', 'win32', 'linux'] as const)('marks inapplicable fields on %s without probing runtime availability', (platform) => {
  state.platform = platform;
  state.arch = platform === 'linux' ? 'arm64' : 'x64';
  const result = unchanged(() => readCoreSettings({ getContext: context, stores }));
  expect(result.fields['windowBehavior.windowsCloseBehavior'].status).toBe(platform === 'win32' ? 'value' : 'unsupported');
  expect(result.fields['windowBehavior.linuxCloseBehavior'].status).toBe(platform === 'linux' ? 'value' : 'unsupported');
  // No platform has an embedded iOS simulator.
  expect(result.fields['iosSimulator.autoOpenEmbeddedPanel'].status).toBe('unsupported');
  expect(result.fields['updateChannel.enableBeta'].status).toBe(supportsBetaUpdateChannel(platform, state.arch) ? 'value' : 'unsupported');
  expect(result.fields['contacts.deviceSyncEnabled'].status).toBe('unsupported');
});

it.each(['owner', 'generation', 'profile'] as const)('invalidates the complete aggregate on %s drift', (kind) => {
  const memory = vi.fn(stores.memory);
  const result = unchanged(() => readCoreSettings({ getContext: context, stores: { ...stores, memory,
    collaboration: () => {
      const value = stores.collaboration();
      if (kind === 'owner') state.owner = 'owner-b';
      else if (kind === 'generation') state.generation++;
      else state.root = path.join(state.root, 'new-profile');
      return value;
    },
  } }));
  expect(Object.values(result.fields).every((field) => field.status === 'unavailable')).toBe(true);
  expect(result.collections?.visionBridgeTargets).toEqual({ status: 'unavailable' });
  expect(memory).not.toHaveBeenCalled();
});

it.each([
  ['device-link-settings.json', { lastKnownDeviceNames: [] }, inspectDeviceLinkSettings],
  ['device-link-settings.json', { revokedControllers: [false] }, inspectDeviceLinkSettings],
  ['device-link-settings.json', { lastKnownDeviceNames: { device: 2 } }, inspectDeviceLinkSettings],
] as const)('rejects malformed nested structures in %s without fallback', (file, raw, inspect) => {
  write(path.join(state.root, file), raw);
  expect(unchanged(() => inspect())).toEqual({ status: 'unreadable' });
});

it('does not report an ambiguous owner embedding file or malformed legacy voice shape as defaults', () => {
  write(path.join(ownerRoot(), 'chat-embedding-settings.json'), {});
  expect(unchanged(inspectEmbedding)).toEqual({ status: 'unreadable' });
  write(path.join(ownerRoot(), 'voice-input-models.json'), { utilityModelProviderChain: [42] });
  expect(unchanged(inspectAuxiliary)).toEqual({ status: 'unreadable' });
});

it('reads different owners from captured roots without sharing cached values', () => {
  write(path.join(ownerRoot(), 'memory-settings.json'), { maker: false });
  expect(unchanged(() => readCoreSettings({ getContext: context, stores })).fields['memory.maker'])
    .toEqual({ status: 'value', value: false, source: 'override' });
  state.owner = 'owner-b'; state.generation++;
  expect(unchanged(() => readCoreSettings({ getContext: context, stores })).fields['memory.maker'])
    .toEqual({ status: 'value', value: true, source: 'default' });
  state.owner = 'owner-a'; state.generation++;
  expect(unchanged(() => readCoreSettings({ getContext: context, stores })).fields['memory.maker'])
    .toEqual({ status: 'value', value: false, source: 'override' });
});

it('aliases voice refinement to the same auxiliary inspection and schedules no deferred side effect', async () => {
  write(path.join(ownerRoot(), 'auxiliary-model-settings.json'), { models: [privatePin] });
  const auxiliary = vi.fn(stores.auxiliaryModel);
  const before = treeBytes(state.root);
  const asyncWrites = [
    vi.spyOn(fs.promises, 'writeFile'), vi.spyOn(fs.promises, 'mkdir'), vi.spyOn(fs.promises, 'unlink'),
    vi.spyOn(fs.promises, 'rename'), vi.spyOn(fs.promises, 'rm'),
  ];
  const result = unchanged(() => readCoreSettings({ getContext: context, stores: { ...stores, auxiliaryModel: auxiliary } }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(result.fields['voice.refinerChain']).toBe(result.fields['auxiliaryModel.models']);
  expect(auxiliary).toHaveBeenCalledTimes(1);
  for (const spy of asyncWrites) expect(spy).not.toHaveBeenCalled();
  expect(treeBytes(state.root)).toEqual(before);
  expect(state.forbidden).not.toHaveBeenCalled();
});

it('isolates a throwing reader without retaining its error or interrupting other domains', () => {
  const result = unchanged(() => readCoreSettings({ getContext: context, stores: { ...stores,
    collaboration: () => { throw new Error('private error detail'); },
  } }));
  expect(result.fields['collaboration.workerHardLimit']).toEqual({ status: 'unreadable' });
  expect(result.fields['memory.maker']).toEqual({ status: 'value', value: true, source: 'default' });
  expect(JSON.stringify(result)).not.toContain('private error detail');
});

it('returns unavailable without a committed owner and never invokes a store', () => {
  const collaboration = vi.fn(stores.collaboration);
  const result = readCoreSettings({ getContext: () => null, stores: { ...stores, collaboration } });
  expect(Object.values(result.fields).every((field) => field.status === 'unavailable')).toBe(true);
  expect(collaboration).not.toHaveBeenCalled();
});
