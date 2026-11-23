import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const isolated = vi.hoisted(() => ({ root: '', generation: 1 }));
vi.mock('electron', () => ({ app: { getPath: () => isolated.root }, net: { fetch: vi.fn() } }));
// Appearance saves through its settings section; keep the real store write without window side effects.
vi.mock('../../appearance-settings-ipc.js', async () => {
  const store = await vi.importActual<typeof import('../../appearance-settings-store.js')>('../../appearance-settings-store.js');
  return {
    updateAppearanceFromSettings: async (patch: never) => { return store.writeAppearanceSettingsPatch(patch); },
    resetAppearanceFromSettings: async () => { return store.resetAppearanceSettings(); },
  };
});
// Custom instructions live in the app window; this stands in for that window.
const appWindow = vi.hoisted(() => ({ userPrompt: '' }));
vi.mock('../../app-settings/preferences.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../app-settings/preferences.js')>(),
  manageAppPreferences: async (operation: string, _patch?: unknown, _visibility?: unknown, { userPrompt }: { userPrompt?: string } = {}) => {
    if (operation !== 'user-prompt') throw new Error('PREFERENCE_WINDOW_NOT_READY');
    if (userPrompt !== undefined) appWindow.userPrompt = userPrompt;
    return { value: {}, userPrompt: appWindow.userPrompt };
  },
}));
// New-task defaults are Host-owned only on a managed cloud instance.
vi.mock('../../instance-runtime/config.js', () => ({ getInstanceConfig: () => ({}) }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }));
vi.mock('../../maker-host/logger-adapter.js', () => ({ desktopMakerLogger: { child: () => ({ info() {}, warn() {}, error() {}, debug() {} }) } }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => String(isolated.generation), peekCommittedAppSession: () => ({ mode: 'cloud', dataOwnerId: 'fixture-owner', generation: isolated.generation }), isAppSessionBoundaryPending: () => false, dataOwnerStorageKey: () => 'fixture-owner' }));
vi.mock('../snapshotRuntime.js', () => ({ getCloudSettingsSnapshotContext: () => null }));
// This suite exercises real settings files and CAS; account-management services
// (OAuth, IM, contacts) are covered separately and must not start here.
vi.mock('../managementRuntime.js', () => ({
  executeCloudManagement: vi.fn(() => { throw new Error('Unexpected management request'); }),
  startCloudManagementMaintenance: vi.fn(() => () => {}),
}));
vi.mock('../../maker-host/model-visibility-mirror.js', () => ({ getModelVisibilityOverride: () => undefined }));
vi.mock('../catalog.js', () => ({ readSettingsModelCatalog: async () => ({ providers: [], agents: [], assertCurrent() {} }) }));
import { executeWebSettingsRequest } from '../webRuntime.js';
import { configureHostSettingsApplication } from '../index.js';
import { settingsWebResultSchema, type SettingsWebCommand, type SettingsWebEnvelope } from '../../../shared/settingsWeb.js';
const input = (command: SettingsWebCommand, sessionKey = 'a'.repeat(64)): SettingsWebEnvelope => ({ requestId: randomUUID(), runtimeId: randomUUID(), sessionKey, expiresAtMs: Date.now() + 30_000, command });
beforeEach(() => {
  isolated.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-web-settings-')); isolated.generation += 1;
  appWindow.userPrompt = '';
  configureHostSettingsApplication({ databaseWarning() {} });
});
afterEach(() => fs.rmSync(isolated.root, { recursive: true, force: true }));
describe('web adapter uses actual Host settings files', () => {
  it('initializes several domains in one request, without writes, and keeps session-bound CAS', async () => {
    const request = input({kind:'readBatch',domains:['databaseWarning','personalization','appearance']});
    const result = settingsWebResultSchema.parse(await executeWebSettingsRequest(request, () => {}));
    if (!result.ok || !('entries' in result)) throw new Error('expected batch');
    expect(result.remainingDomains).toEqual([]);
    expect(result.entries.map(entry => entry.domain)).toEqual(request.command.kind === 'readBatch' ? request.command.domains : []);
    expect(fs.readdirSync(isolated.root)).toEqual([]);
    const first = result.entries[0]!.result;
    if (!first.ok || first.settings.status !== 'ready') throw new Error('fixture read');
    const change = { domain: 'databaseWarning' as const, operationId: first.settings.operationId, expectedRevision: first.settings.revision, set: {thresholdGiB:7} };
    expect(await executeWebSettingsRequest(input({kind:'update',change}, 'b'.repeat(64)), () => {})).toMatchObject({ok:false,code:'OPERATION_MISMATCH'});
    expect(await executeWebSettingsRequest(input({kind:'update',change}), () => {})).toMatchObject({receipt:{saved:true}});
  });
  it('saves, reads back and clears through the same CAS writer', async () => {
    const before = await executeWebSettingsRequest(input({ kind: 'read', domain: 'databaseWarning' }), () => {});
    if (!before.ok || !('settings' in before) || before.settings.status !== 'ready') throw new Error('fixture read');
    const change = { domain: 'databaseWarning' as const, operationId: before.settings.operationId, expectedRevision: before.settings.revision, set: { thresholdGiB: 5 } };
    expect(await executeWebSettingsRequest(input({ kind: 'update', change }), () => {})).toMatchObject({ ok: true, receipt: { saved: true, application: 'applied' } });
    const after = await executeWebSettingsRequest(input({ kind: 'read', domain: 'databaseWarning' }), () => {});
    expect(after).toMatchObject({ settings: { value: { thresholdGiB: 5, disabled: false }, customizedKeys: ['thresholdGiB'] } });
    if (!after.ok || !('settings' in after) || after.settings.status !== 'ready') throw new Error('fixture read');
    expect(await executeWebSettingsRequest(input({ kind: 'update', change: { domain: 'databaseWarning', operationId: after.settings.operationId, expectedRevision: after.settings.revision, clear: ['thresholdGiB'] } }), () => {})).toMatchObject({ receipt: { saved: true } });
    expect(await executeWebSettingsRequest(input({ kind: 'read', domain: 'databaseWarning' }), () => {})).toMatchObject({ settings: { value: { thresholdGiB: 10, disabled: false }, customizedKeys: [] } });
  });
  it.each([
    ['personalization', { userPrompt: 'fixture custom prompt' }],
    ['appearance', { uiSize: 16 }],
  ] as const)('reads and writes %s with a response accepted by the actual wire schema', async (domain, set) => {
    const before = settingsWebResultSchema.parse(await executeWebSettingsRequest(input({ kind: 'read', domain }), () => {}));
    if (!before.ok || !('settings' in before) || before.settings.status !== 'ready') throw new Error('fixture read');
    const receipt = await executeWebSettingsRequest(input({ kind: 'update', change: { domain, operationId: before.settings.operationId, expectedRevision: before.settings.revision, set } } as SettingsWebCommand), () => {});
    expect(settingsWebResultSchema.parse(receipt)).toMatchObject({ receipt: { saved: true } });
    const after = settingsWebResultSchema.parse(await executeWebSettingsRequest(input({ kind: 'read', domain }), () => {}));
    expect(after).toMatchObject({ settings: { customizedKeys: Object.keys(set), isCustomized: true } });
    if (domain === 'personalization') {
      expect(JSON.stringify(after)).not.toContain('fixture custom prompt');
      expect(appWindow.userPrompt).toBe('fixture custom prompt');
    }
  });
  it('reports new-task defaults as kept by the app window, like any desktop', async () => {
    expect(settingsWebResultSchema.parse(await executeWebSettingsRequest(input({ kind: 'read', domain: 'newTaskDefaults' }), () => {})))
      .toMatchObject({ ok: true, settings: { status: 'unavailable', domain: 'newTaskDefaults' } });
  });
  it('rejects a revision from another browser session and never changes the file', async () => {
    const before = await executeWebSettingsRequest(input({ kind: 'read', domain: 'databaseWarning' }), () => {});
    if (!before.ok || !('settings' in before) || before.settings.status !== 'ready') throw new Error('fixture read');
    const result = await executeWebSettingsRequest(input({ kind: 'update', change: { domain: 'databaseWarning', operationId: before.settings.operationId, expectedRevision: before.settings.revision, set: { thresholdGiB: 8 } } }, 'b'.repeat(64)), () => {});
    expect(result).toMatchObject({ ok: false, code: 'OPERATION_MISMATCH' });
    expect(fs.readdirSync(isolated.root)).toEqual([]);
  });
});
