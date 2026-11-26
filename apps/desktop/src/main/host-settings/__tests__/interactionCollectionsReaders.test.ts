import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const state = vi.hoisted(() => ({ forbidden: vi.fn(() => { throw new Error('forbidden runtime access'); }), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('electron', () => ({ app: { getPath: state.forbidden }, ipcMain: { on: state.forbidden, handle: state.forbidden }, BrowserWindow: { getAllWindows: state.forbidden }, safeStorage: { isEncryptionAvailable: state.forbidden, decryptString: state.forbidden }, systemPreferences: { getMediaAccessStatus: state.forbidden } }));
vi.mock('electron-store', () => ({ default: state.forbidden }));
// Model presentation collections are read only on a managed cloud instance.
const instance = vi.hoisted(() => ({ value: {} as object | null }));
vi.mock('../../instance-runtime/config.js', () => ({ getInstanceConfig: () => instance.value }));
vi.mock('../../logger.js', () => ({ createLogger: () => state.log }));
vi.mock('../../maker-host/logger-adapter.js', () => ({ desktopMakerLogger: { child: () => state.log } }));
vi.mock('../../appSessionState.js', () => ({ getActiveAppSession: state.forbidden, ownerScopedUserDataPath: state.forbidden, activeOwnerScopeKey: state.forbidden, getActiveDataOwnerPushStamp: state.forbidden, isAppSessionBoundaryPending: state.forbidden, dataOwnerStorageKey: (v: string) => v }));
// The app keeps the ambient owner and profile root behind injected modules; readers get both explicitly.
vi.mock('../../ownerContext.js', () => ({ configureOwnerContext: () => {}, ownerScopedPath: state.forbidden, activeDataOwnerId: state.forbidden, hasCommittedOwner: state.forbidden, isOwnerBoundaryPending: state.forbidden, ownerGeneration: state.forbidden }));
vi.mock('../../userDataPath.js', () => ({ configureUserDataDir: () => {}, getUserDataDir: state.forbidden, userDataPath: state.forbidden }));
vi.mock('../../ownerNamespaceMigration.js', () => ({ hasExclusiveSharedLegacyUserDataAccess: state.forbidden, hasLegacyOwnerNamespaceClaim: state.forbidden, isLegacyOwnerNamespaceClaimOwnedBy: state.forbidden, isLegacyOwnerNamespaceClaimedByOtherOwner: state.forbidden }));
vi.mock('../../im/ownerScopedStorage.js', () => ({ claimLegacyImPath: state.forbidden, ownerScopedImUserDataPath: state.forbidden, ownerScopedImSecrets: { read: state.forbidden, write: state.forbidden } }));
vi.mock('../../voice-input/VoiceDictionarySyncStore.js', () => ({ voiceDictionarySyncStore: new Proxy({}, { get: () => state.forbidden }) }));
vi.mock('../../utility-model/resolveAuxiliaryModelChain.js', () => ({ getEffectiveAuxiliaryModelChain: state.forbidden }));
vi.mock('../../input-devices/registry.js', () => ({ resumeInputDeviceTaskSlots: state.forbidden }));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: state.forbidden }));
vi.mock('../../windowFocusClassifier.js', () => ({ isAppContentWindow: state.forbidden }));
vi.mock('../../usage/accountReferencePrice.js', () => ({ accountReferencePriceQuote: state.forbidden }));
vi.mock('../../maker-host/model-visibility-owner-claim.js', () => ({ claimLegacyModelVisibilityOwner: state.forbidden }));
vi.mock('../personalization.js', () => ({ currentSettingsOwner: state.forbidden }));

import { inspectInteractionSettings, INTERACTION_SETTINGS_FIELD_IDS } from '../readers/interaction.js';
import { inspectDynamicSettingsCollections } from '../readers/collections.js';
import { inspectSettingsJson } from '../../maker-host/inspect-settings-json.js';
import { SETTINGS_READ_CATALOG, SETTINGS_READ_FIELD_IDS, SETTINGS_READ_COLLECTION_CATALOG, SETTINGS_READ_COLLECTION_IDS, SETTINGS_READ_SHORTCUT_IDS } from '../../../shared/settingsReadCatalog.js';
import { projectSettingsSnapshotV2 } from '../snapshotProjectionV2.js';
import type { ReadonlySettingsInspection } from '../readTypes.js';

let root: string;
const context = () => ({ ownerRoot: path.join(root, 'owner-a'), userDataPath: root, ownerId: 'owner-a', ownerGeneration: 7, mode: 'local' as const, platform: 'darwin' as const, officialAccountFingerprint: 'account_a_123' });
const write = (name: string, value: unknown, owner = true) => { const file = path.join(owner ? context().ownerRoot : root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
const read = () => inspectInteractionSettings(context());
const lists = () => inspectDynamicSettingsCollections(context()).collections!;
const projectedLists = () => projectSettingsSnapshotV2({
  fields: Object.fromEntries(SETTINGS_READ_FIELD_IDS.map(id => [id, { status: 'unsupported' } as const])),
  collections: { ...Object.fromEntries(SETTINGS_READ_COLLECTION_IDS.map(id => [id, { status: 'unavailable' } as const])), ...lists() },
}).collections;
function value(result: ReadonlySettingsInspection, key: string) { const item = result.fields[key]; expect(item?.status, key).toBe('value'); return item?.status === 'value' ? item.value : undefined; }
function noWrites<T>(fn: () => T): T {
  const methods = ['writeFileSync', 'mkdirSync', 'unlinkSync', 'rmSync', 'renameSync', 'copyFileSync', 'readdirSync'] as const;
  const spies = methods.map(name => vi.spyOn(fs, name).mockImplementation(state.forbidden as never));
  try { return fn(); } finally { for (const spy of spies) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); } }
}
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'interaction-inspection-')); state.forbidden.mockClear(); instance.value = {}; });
afterEach(() => { expect(state.forbidden).not.toHaveBeenCalled(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe('actual interaction preference readers', () => {
  it('uses evidenced defaults with zero writes, no owner getter, no credentials and no hardware startup', () => {
    const result = noWrites(read);
    expect(value(result, 'voice.language')).toBeDefined();
    expect(value(result, 'browser.backend')).toBe('external');
    expect(value(result, 'browser.enabled')).toBe(true);
    expect(value(result, 'android.enabled')).toBe(false);
    expect(value(result, 'computer.enabled')).toBe(false);
    expect(result.fields['im.wecom.notificationsEnabled']).toEqual({ status: 'private' });
    expect(value(result, 'im.official.slackEnabled')).toBe(false);
    expect(Object.keys(result.fields).filter(k => k.startsWith('shortcuts.'))).toHaveLength(30);
    for (const [key, item] of Object.entries(result.fields)) {
      expect(key in SETTINGS_READ_CATALOG, key).toBe(true);
      if (item.status === 'value' && !key.match(/^im\.(global|feishu|slack|discord|wechat|telegram|dingtalk|wecom|imessage)\.agents\..*\.(model|providerId)$/)) expect(z.safeParse(SETTINGS_READ_CATALOG[key as keyof typeof SETTINGS_READ_CATALOG].valueSchema, item.value).success, key).toBe(true);
    }
    expect(new Set(Object.keys(result.fields))).toEqual(new Set(INTERACTION_SETTINGS_FIELD_IDS));
    expect(INTERACTION_SETTINGS_FIELD_IDS).not.toContain('voice.refinerChain');
    for (const prefix of ['worklouder.codex-micro.', 'worklouder.creator-micro-2.', 'gamepad.xbox.', 'gamepad.playstation.', 'gamepad.nintendo.', 'gamepad.generic.']) {
      const expected = Object.keys(SETTINGS_READ_CATALOG).filter(key => key.startsWith(prefix));
      expect(expected.length).toBeGreaterThan(20);
      expect(Object.keys(result.fields).filter(key => key.startsWith(prefix))).toEqual(expect.arrayContaining(expected));
      for (const key of expected) expect(['value', 'unsupported']).toContain(result.fields[key].status);
    }
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it('preserves explicit default-valued overrides and platform-specific shortcut definitions', () => {
    write('app-shortcuts.v1.json', { version: 1, overrides: { 'toggle-sidebar': null, 'new-maker': { code: 'KeyQ', key: 'private display text', meta: true } } }, false);
    write('browser-backend-settings.json', { kind: 'external', useRealProfile: true }, false);
    const result = noWrites(read);
    expect(value(result, 'shortcuts.toggle-sidebar')).toEqual([]);
    expect(result.fields['browser.backend']).toMatchObject({ source: 'override', value: 'external' });
    expect(value(result, 'shortcuts.new-maker')).toEqual([{ code: 'KeyQ', meta: true, ctrl: false, alt: false, shift: false }]);
    expect(result.fields['shortcuts.zoom-in']).toEqual({ status: 'unsupported' });
    const windows = inspectInteractionSettings({ ...context(), platform: 'win32' });
    expect(windows.fields['shortcuts.open-settings']).toEqual({ status: 'unsupported' });
    expect(value(windows, 'shortcuts.zoom-in')).toHaveLength(3);
    const linux = inspectInteractionSettings({ ...context(), platform: 'linux' });
    expect(value(linux, 'voice.shortcutConfigured')).toBe(false);
    expect(SETTINGS_READ_SHORTCUT_IDS).toHaveLength(30);
  });
  it('reads saved owner preferences, not live model eligibility, and drops sensitive payloads', () => {
    write('voice-input-data.v1.json', { settings: { language: 'ja', microphoneDeviceId: 'private-mic', refinementInstructions: 'private-prompt', dictionaryEntries: [{ text: 'private-dictionary' }], dictionarySyncEnabledOverride: false }, history: [{ transcript: 'private-history' }] });
    write('voice-input-models.json', { serviceMode: 'byok', customAsr: { protocol: 'openai-realtime', websocketUrl: 'wss://example.test/private', model: 'private-asr-model' } });
    write('android-automation-settings.json', { adbPathOverride: '/private/adb', defaultDeviceSerial: 'private-serial' }, false);
    write('telegram-bot-persona.json', { botName: 'private-name', soul: 'private-persona' });
    write('im-default-settings.json', { schemaVersion: 3, channels: { telegram: { agents: { codex: { model: 'retired-private-model', effort: 'high' } } } } });
    write('worklouder-codex-settings.json', { customAgentKeys: [{ type: 'task', sessionId: 'private-session' }], deviceEnabled: true, layout: { encoderMode: 'custom', encoder: { click: { type: 'composer-text', text: 'private-command' } } } });
    const result = noWrites(read);
    expect(result.fields['voice.language']).toMatchObject({ value: 'ja', source: 'unknown' });
    expect(result.fields['voice.dictionarySyncEnabled']).toMatchObject({ value: false, source: 'override' });
    expect(value(result, 'im.telegram.agents.codex.model')).toBe('retired-private-model');
    expect(value(result, 'worklouder.codex-micro.customAgentKeys.0')).toEqual({ type: 'task', configured: true });
    const text = JSON.stringify(result);
    for (const secret of ['private-mic', 'private-prompt', 'private-dictionary', 'private-history', 'private-asr-model', '/private/adb', 'private-serial', 'private-persona', 'private-name', 'private-session', 'private-command']) expect(text).not.toContain(secret);
    const other = inspectInteractionSettings({ ...context(), ownerRoot: path.join(root, 'owner-b'), ownerId: 'owner-b' });
    expect(value(other, 'worklouder.codex-micro.deviceEnabled')).toBe(false);
  });
  it('keeps corrupt bytes, isolates failures, rejects symlinks and marks unclaimed legacy migration', () => {
    const file = write('voice-input-data.v1.json', '{bad');
    write('telegram-bot-behavior.json', '[]');
    const result = noWrites(read);
    expect(result.fields['voice.language']).toEqual({ status: 'unreadable' });
    expect(result.fields['im.localTelegram.emojiReactions']).toEqual({ status: 'unreadable' });
    expect(value(result, 'gamepad.generic.deviceEnabled')).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('{bad');
    const target = write('target.json', { private: 'do not read' });
    fs.symlinkSync(target, path.join(root, 'link.json'));
    expect(inspectSettingsJson(path.join(root, 'link.json'), v => v)).toEqual({ status: 'unreadable' });
    write('im-default-settings.json', { model: 'legacy-private' }, false);
    expect(read().fields['im.global.agentKind']).toEqual({ status: 'migrationPending' });
  });
  it.each([
    ['voice-input-data.v1.json', { settings: { muteSystemAudio: 'yes' } }, 'voice.muteSystemAudio', true],
    ['voice-input-models.json', { asrProvider: 42 }, 'voice.asrProvider', true],
    ['worklouder-codex-settings.json', { layout: { encoder: { click: { type: 'command', commandId: 'private-shell-command' } } } }, 'worklouder.codex-micro.deviceEnabled', true],
    ['generic-gamepad-settings.json', { layout: { sticks: { left: { mode: 'invalid' } } } }, 'gamepad.generic.deviceEnabled', true],
    ['im-default-settings.json', { channels: { wecom: { agents: { pi: { effort: 'not-effort' } } } } }, 'im.wecom.agentKind', true],
    ['telegram-bot-behavior.json', { groupActivation: { notChatId: 'always' } }, 'im.localTelegram.emojiReactions', true],
    ['browser-backend-settings.json', { kind: 'bad-backend' }, 'browser.backend', false],
    ['android-automation-settings.json', { adbPathOverride: 42 }, 'android.adbPathOverrideConfigured', false],
    ['builtin-tools-settings.json', { builtinTools: { browser: { enabled: 'yes' } } }, 'browser.enabled', true],
  ] as const)('rejects malformed known settings without normalizing them to defaults: %s', (name, raw, field, owner) => {
    const file = write(name, raw, owner);
    const before = fs.readFileSync(file);
    expect(noWrites(read).fields[field]).toEqual({ status: 'unreadable' });
    expect(fs.readFileSync(file)).toEqual(before);
  });
  it('yields hidden session shortcuts to the actual saved voice keyboard chord', () => {
    write('voice-input-data.v1.json', { settings: { shortcut: { trigger: 'keyboard', code: 'Digit1', key: '1', modifiers: { meta: true, ctrl: false, alt: false, shift: false, fn: false } } } });
    expect(value(noWrites(read), 'shortcuts.switch-session-1')).toEqual([]);
  });
  it('reads only selected official account and does not migrate v1/legacy documents', () => {
    write('slack-hook.json', { version: 2, accounts: { account_a_123: { slack: { enabled: true, lifecycleAnnouncementOverride: false }, telegram: { enabled: true, defaultWorkspace: 'project' } }, account_b_123: { x: { enabled: true } } }, workspaces: { project: '/private/project' } });
    const result = noWrites(read);
    expect(value(result, 'im.official.slackEnabled')).toBe(true);
    expect(value(result, 'im.official.xEnabled')).toBe(false);
    expect(value(result, 'im.official.telegramDefaultWorkspaceConfigured')).toBe(true);
    expect(result.fields['im.official.slackLifecycleAnnouncement']).toMatchObject({ value: false, source: 'override' });
    expect(JSON.stringify(result)).not.toContain('/private/project');
    write('slack-hook.json', { enabled: true });
    expect(noWrites(read).fields['im.official.slackEnabled']).toEqual({ status: 'migrationPending' });
  });
});

describe('known persisted dynamic collections', () => {
  it('reports model presentation as unavailable on an ordinary desktop', () => {
    instance.value = null;
    const result = noWrites(lists);
    for (const name of ['modelVisibility', 'modelEngines', 'modelFavorites'])
      expect(result[name]).toEqual({ status: 'unavailable' });
  });
  it('reports empty/default and migration states honestly without enumerating workspaces', () => {
    const result = noWrites(lists);
    expect(result.modelVisibility).toEqual({ status: 'unavailable' });
    expect(result.modelDisable).toEqual({ status: 'value', entries: [], total: 0, complete: true });
    expect(result.builtinToolOverrides).toEqual({ status: 'value', entries: [], total: null, complete: false });
    expect(result.modelParameterHistory).toEqual({ status: 'unavailable' });
  });
  it('preserves sparse, retired-model, nullable price and plugin preferences using safe entry leaves', () => {
    write('model-disable-prefs.json', { disabledModels: { 'private-provider:retired-model': true }, disabledProviders: { 'private-provider': true } });
    write('local-codex-provider-prefs.json', { providers: { private: { name: 'private-provider-name', removed: false } } });
    write('model-context-limit-prefs.json', { limits: { 'pi:private:retired': 99999 } });
    write('model-price-overrides.json', { version: 1, entries: { first: { providerId: 'private', agent: 'pi', modelId: 'retired', values: { currency: 'CNY', cacheReadPerMtok: null, inputPerMtok: 0 }, baseReference: null, updatedAt: 'unused' } } });
    write('ghost-cindy-prefs.json', { overrides: { 'private-ghost': { 'text.oneshot': 'private-model' } }, inflightLimits: { 'private-ghost': 2 } });
    write('ghost-errand-prefs.json', { errand: { 'private-ghost': { agentKind: 'cc', model: 'private-model', workingDir: '/private/path', fastMode: false } }, sessions: { 'private-ghost': 'private-session' } });
    write('sidebar-settings.json', { hiddenMainViewGhostIds: ['private-ghost'], pinnedOrder: ['project:/private/project'] });
    write('telegram-bot-behavior.json', { groupActivation: { '-12345': 'always' } });
    const result = noWrites(lists);
    for (const [name, collection] of Object.entries(result)) if (collection.status === 'value') {
      for (const [index, item] of collection.entries.entries()) {
        const publicFields = Object.fromEntries(Object.entries(item.fields).map(([key, inspected]) => [key, inspected.status === 'value' ? inspected.value : undefined]));
        expect(z.safeParse(SETTINGS_READ_COLLECTION_CATALOG[name as keyof typeof SETTINGS_READ_COLLECTION_CATALOG].entrySchema, { ordinal: index + 1, source: 'override', ...publicFields }).success, name).toBe(true);
        const text = JSON.stringify(publicFields);
        for (const secret of ['private-model', 'private-provider-name', 'private-ghost', '/private/', 'private-session', '-12345']) expect(text).not.toContain(secret);
      }
    }
    const prices = result.modelPrices;
    expect(prices.status).toBe('value');
    if (prices.status === 'value') expect(Object.keys(prices.entries[0].fields)).toEqual(['currency', 'inputPerMtok', 'cacheReadPerMtok']);
  });
  it.each([
    ['model-disable-prefs.json', { disabledModels: { test: false } }, 'modelDisable'],
    ['model-context-limit-prefs.json', { limits: { test: '10000' } }, 'modelContextBudget'],
    ['ghost-cindy-prefs.json', { overrides: { plugin: { 'text.oneshot': false } } }, 'pluginCindyPrefs'],
    ['ghost-errand-prefs.json', { errand: { plugin: { permissionMode: 'invalid-permission' } } }, 'pluginErrandPrefs'],
    ['local-codex-provider-prefs.json', { providers: { private: { removed: 'true' } } }, 'providerPresentation'],
  ] as const)('rejects malformed collection leaves and leaves bytes intact: %s', (name, raw, collection) => {
    const file = write(name, raw);
    const before = fs.readFileSync(file);
    expect(noWrites(lists)[collection]).toEqual({ status: 'unreadable' });
    expect(fs.readFileSync(file)).toEqual(before);
  });
  it('reports per-model tuning as kept by the app window and keeps local workspace tombstones', () => {
    write('host-new-task-defaults.json', { _initialized: true, _history: null });
    write('hook-workspace-prefs.json', { version: 1, entries: [{ channel: 'telegram', teamId: null, workspace: 'project', model: null, effort: null, agentKind: null, permissionMode: null, dirty: true, dirtyPatch: { model: null } }] });
    const result = noWrites(lists);
    expect(result.modelParameterHistory).toEqual({ status: 'unavailable' });
    expect(result.imWorkspacePrefs).toMatchObject({ status: 'value', total: 1, entries: [{ fields: { modelConfigured: { value: false }, dirty: { value: true } } }] });
  });
  it.each([
    [null, undefined, true],
    ['private-model', undefined, false],
    [null, false, false],
    ['private-model', true, true],
  ] as const)('workspace旧行遵循真实dirty规则：model=%s dirty=%s', (model, dirty, expected) => {
    write('hook-workspace-prefs.json', { version: 1, entries: [{ channel: 'telegram', teamId: null, workspace: 'private-workspace', model, effort: null, agentKind: null, permissionMode: null, ...(dirty === undefined ? {} : { dirty }) }] });
    const result = noWrites(projectedLists).imWorkspacePrefs;
    expect(result).toMatchObject({ status: 'complete', total: 1, omitted: 0, entries: [{ ordinal: 1, dirty: expected, modelConfigured: model !== null }] });
    expect(JSON.stringify(result)).not.toContain('private-');
  });
  it('reports presentation axes as on any desktop and covers known user/project tool overrides without arbitrary KV', () => {
    write('builtin-tools-settings.json', { builtinTools: { browser: { enabled: false }, arbitrary: { enabled: true, token: 'secret' } } });
    const workspace = path.join(root, 'known-project');
    fs.mkdirSync(path.join(workspace, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.claude/settings.json'), JSON.stringify({ xdtMaker: { plugins: { ssh: { enabled: false } } }, arbitrary: { token: 'secret' } }));
    const result = noWrites(() => inspectDynamicSettingsCollections({ ...context(), knownWorkspaces: [workspace], knownWorkspacesComplete: true }).collections!);
    // The three presentation axes live in the app window.
    for (const name of ['modelVisibility', 'modelEngines', 'modelFavorites'] as const) expect(result[name]).toEqual({ status: 'unavailable' });
    expect(result.builtinToolOverrides).toMatchObject({ total: 2, complete: true });
    expect(JSON.stringify(result.builtinToolOverrides)).not.toContain('arbitrary');
  });
});
