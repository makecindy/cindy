import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const isolated = vi.hoisted(() => ({ root: '', generation: 1 }));
vi.mock('electron', () => ({ app: { getPath: () => isolated.root }, net: { fetch: vi.fn() } }));
vi.mock('../../instance-runtime/config.js', () => ({ getInstanceConfig: () => ({}) }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }));
vi.mock('../../maker-host/logger-adapter.js', () => ({ desktopMakerLogger: { child: () => ({ info() {}, warn() {}, error() {}, debug() {} }) } }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => String(isolated.generation), peekCommittedAppSession: () => ({ mode: 'cloud', dataOwnerId: 'fixture-owner', generation: isolated.generation }), isAppSessionBoundaryPending: () => false, dataOwnerStorageKey: () => 'fixture-owner' }));
vi.mock('../snapshotRuntime.js', () => ({ getCloudSettingsSnapshotContext: () => null }));
vi.mock('../../maker-host/model-visibility-mirror.js', () => ({ getModelVisibilityOverride: () => undefined }));
vi.mock('../catalog.js', () => ({ readSettingsModelCatalog: async () => ({ providers: [], agents: [], assertCurrent() {} }) }));
import { createAppSettingsService } from '../../app-settings/service.js';
import { runtimeSettingsSections } from '../../app-settings/runtime.js';
import { configureHostSettingsApplication } from '../index.js';
import { registerHostAppSettingsSections, HOST_APP_SETTINGS_SECTION_IDS } from '../appSettingsSections.js';

// Sections the app already registers, and Host domains that map onto them or stay out of the Agent surface.
const APP_SECTIONS = ['preferences', 'appearance', 'git-safety', 'goal-defaults', 'agent-resources', 'subagent-models', 'vision-bridge', 'memory', 'auxiliary-models'];
const NOT_REGISTERED = ['appearance', 'gitSafety', 'agentResource', 'memory', 'subagentModel', 'auxiliaryModel', 'visionBridge',
  'modelVisibility', 'modelContext', 'modelAccess', 'providerNames', 'modelPrices', 'newTaskDefaults', 'personalization',
  'workspaceTools', 'contacts', 'contactsSync', 'desktopGeneral', 'desktopChat', 'desktopNotifications'];
const current = async () => {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const manage = (input: Parameters<ReturnType<typeof createAppSettingsService>>[0]) => createAppSettingsService(runtimeSettingsSections())(input, current) as Promise<any>;

beforeEach(() => {
  isolated.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-app-sections-')); isolated.generation += 1;
  configureHostSettingsApplication({ databaseWarning() {} });
  registerHostAppSettingsSections();
});
afterEach(() => fs.rmSync(isolated.root, { recursive: true, force: true }));

describe('Host settings as app settings sections on a cloud instance', () => {
  it('registers only what the app lacks, each with a schema the tools can describe', () => {
    const ids = runtimeSettingsSections().map(section => section.id);
    expect(ids).toEqual(expect.arrayContaining(HOST_APP_SETTINGS_SECTION_IDS));
    for (const id of [...APP_SECTIONS, ...NOT_REGISTERED]) expect(HOST_APP_SETTINGS_SECTION_IDS).not.toContain(id);
    for (const section of runtimeSettingsSections()) expect(() => z.toJSONSchema(section.schema), section.id).not.toThrow();
  });

  it('reads, writes and resets the actual Host store through the app settings service', async () => {
    expect((await manage({ operation: 'list', query: '数据库' })).sections.map((section: { id: string }) => section.id)).toEqual(['databaseWarning']);
    expect(await manage({ operation: 'get', section: 'databaseWarning' })).toMatchObject({ state: { value: { thresholdGiB: 10, disabled: false }, customizedKeys: [] } });
    expect(fs.readdirSync(isolated.root)).toEqual([]);
    expect(await manage({ operation: 'update', section: 'databaseWarning', patch: { thresholdGiB: 20 } }))
      .toMatchObject({ result: { ok: true }, state: { value: { thresholdGiB: 20 }, customizedKeys: ['thresholdGiB'] } });
    expect(JSON.parse(fs.readFileSync(path.join(isolated.root, 'database-size-warning-settings.json'), 'utf8'))).toMatchObject({ thresholdGiB: 20 });
    expect(await manage({ operation: 'update', section: 'databaseWarning', patch: { thresholdGiB: 0 } })).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(await manage({ operation: 'reset', section: 'databaseWarning' })).toMatchObject({ state: { value: { thresholdGiB: 10 }, customizedKeys: [] } });
  });
});
