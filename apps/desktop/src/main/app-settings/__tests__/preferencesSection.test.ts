import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Unit: the preferences section through the real settings service. Only the window round trip
// (manageAppPreferences) and the instance identity are stubbed; the other sections' stores are
// stubbed so loading the section list touches no disk.
const state = vi.hoisted(() => ({ instance: false }));
const manageAppPreferences = vi.hoisted(() => vi.fn());
vi.mock('../preferences.js', () => ({ manageAppPreferences }));
vi.mock('../../instance-runtime/config.js', () => ({ getInstanceConfig: () => (state.instance ? {} : null) }));
vi.mock('../../appearance-settings-store.js', () => ({ readAppearanceSettingsState: vi.fn() }));
vi.mock('../../appearance-settings-ipc.js', () => ({ updateAppearanceFromSettings: vi.fn(), resetAppearanceFromSettings: vi.fn() }));
vi.mock('../../maker-host/git-safety-settings-store.js', () => ({ readGitSafetySettingsState: vi.fn(), writeGitSafetyMode: vi.fn(), resetGitSafetySettings: vi.fn() }));
vi.mock('../../maker-host/goal-settings-store.js', () => ({ readGoalSettingsState: vi.fn(), writeGoalSettings: vi.fn(), resetGoalSettings: vi.fn() }));
vi.mock('../../maker-host/agent-resource-settings-store.js', () => ({ readAgentResourceSettingsState: vi.fn(), writeAgentResourceSetting: vi.fn(), resetAgentResourceSettings: vi.fn() }));
vi.mock('../changes.js', () => ({ notifyAppSettingsChanged: vi.fn() }));
vi.mock('../runtime.js', () => ({ runtimeSettingsSections: () => [] }));
vi.mock('../plugins.js', () => ({ pluginSettingsSections: () => [] }));
vi.mock('../../task-management/store.js', () => ({ taskManagementStore: { read: vi.fn() } }));
vi.mock('../../task-management/service.js', () => ({ taskArchiveEngine: { preview: vi.fn() }, updateTaskArchiveSettings: vi.fn() }));

import { appSettingsSections } from '../sections';
import { createAppSettingsService } from '../service';
import { updateAppearanceFromSettings } from '../../appearance-settings-ipc.js';
import { readAppearanceSettingsState } from '../../appearance-settings-store.js';
import { writeGitSafetyMode, resetGitSafetySettings } from '../../maker-host/git-safety-settings-store.js';
import { writeAgentResourceSetting } from '../../maker-host/agent-resource-settings-store.js';

const CLOUD_ONLY = ['sidebarPinned', 'sidebarTasks', 'feishuNotifications', 'swallowActivationClick', 'networkDebug'];
const windowState = {
  theme: 'system', language: 'system', notifications: true,
  sidebarPinned: 'card', sidebarTasks: 'text', feishuNotifications: true, swallowActivationClick: true, networkDebug: false,
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (input: Parameters<ReturnType<typeof createAppSettingsService>>[0]) => createAppSettingsService(appSettingsSections)(input, async () => {}) as Promise<any>;
const schemaKeys = (schema: unknown) => Object.keys((schema as { properties: Record<string, unknown> }).properties);

beforeEach(() => {
  manageAppPreferences.mockReset();
  manageAppPreferences.mockImplementation(async (operation: string, patch?: Record<string, unknown>) => ({
    value: operation === 'update' ? { ...windowState, ...patch } : windowState, themeFamilies: [],
  }));
});

// Unit: a save based on an earlier read reaches each built-in section's write, which applies
// nothing once that read is out of date.
describe('a save checked against its read', () => {
  const service = createAppSettingsService(appSettingsSections);
  const stale = { assertUnchanged: () => { throw new Error('CONFLICT'); } };
  it('stops each built-in section before it persists', async () => {
    const onPersisted = vi.fn();
    await expect(service({ operation: 'update', section: 'git-safety', patch: { mode: 'off' } }, async () => {}, { guard: stale, onPersisted })).rejects.toThrow('CONFLICT');
    await expect(service({ operation: 'reset', section: 'git-safety' }, async () => {}, { guard: stale, onPersisted })).rejects.toThrow('CONFLICT');
    await expect(service({ operation: 'update', section: 'agent-resources', patch: { maxConcurrentCommands: 2 } }, async () => {}, { guard: stale, onPersisted })).rejects.toThrow('CONFLICT');
    expect(writeGitSafetyMode).not.toHaveBeenCalled();
    expect(resetGitSafetySettings).not.toHaveBeenCalled();
    expect(writeAgentResourceSetting).not.toHaveBeenCalled();
    expect(onPersisted).not.toHaveBeenCalled();
    // Appearance checks inside its store's update, and the app window compares its preferences.
    vi.mocked(readAppearanceSettingsState).mockReturnValue({ value: {}, defaults: {} } as never);
    await service({ operation: 'update', section: 'appearance', patch: { uiSize: 14 } }, async () => {}, { guard: stale });
    expect(() => vi.mocked(updateAppearanceFromSettings).mock.calls[0]![1]!.assertCurrent!()).toThrow('CONFLICT');
    await service({ operation: 'update', section: 'preferences', patch: { notifications: false } }, async () => {}, { guard: { ...stale, expected: { notifications: true } }, onPersisted });
    expect(manageAppPreferences).toHaveBeenCalledWith('update', { notifications: false }, undefined, { expected: { notifications: true } });
    expect(onPersisted).toHaveBeenCalledOnce();
  });
});

describe('the preferences section', () => {
  it('keeps the ordinary fields on an ordinary computer: Agents cannot read or change the cloud-only ones', async () => {
    state.instance = false;
    const [listed] = (await call({ operation: 'list', query: '偏好' })).sections;
    expect(listed.description).not.toContain('网络诊断日志');
    const read = await call({ operation: 'get', section: 'preferences' });
    for (const key of CLOUD_ONLY) {
      expect(read.state.value).not.toHaveProperty(key);
      expect(schemaKeys(read.schema)).not.toContain(key);
    }
    expect(read.state.value).toMatchObject({ theme: 'system', notifications: true });

    for (const key of CLOUD_ONLY) {
      const refused = await call({ operation: 'update', section: 'preferences', patch: { [key]: windowState[key as keyof typeof windowState] } });
      expect(refused, key).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
      expect(schemaKeys(refused.schema)).not.toContain(key);
    }
    expect(manageAppPreferences).not.toHaveBeenCalledWith('update', expect.anything());

    const saved = await call({ operation: 'update', section: 'preferences', patch: { notifications: false } });
    expect(manageAppPreferences).toHaveBeenCalledWith('update', { notifications: false });
    for (const key of CLOUD_ONLY) expect(saved.result.value).not.toHaveProperty(key);
  });

  it('accepts the cloud-only fields on a managed cloud instance, where the cloud settings page writes them', async () => {
    state.instance = true;
    const [listed] = (await call({ operation: 'list', query: '偏好' })).sections;
    expect(listed.description).toContain('网络诊断日志');
    const read = await call({ operation: 'get', section: 'preferences' });
    expect(read.state.value).toMatchObject({ networkDebug: false, sidebarPinned: 'card' });
    expect(schemaKeys(read.schema)).toEqual(expect.arrayContaining(CLOUD_ONLY));

    await call({ operation: 'update', section: 'preferences', patch: { networkDebug: true } });
    expect(manageAppPreferences).toHaveBeenCalledWith('update', { networkDebug: true });
    expect(() => z.toJSONSchema(appSettingsSections.find(section => section.id === 'preferences')!.schema)).not.toThrow();
  });
});
