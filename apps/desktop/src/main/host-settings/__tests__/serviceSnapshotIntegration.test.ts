import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HostSettingsDomain, HostSettingsUpdate } from '../../../shared/hostSettings.js';

const isolated = vi.hoisted(() => ({
  root: '', owner: 'fixture-owner', generation: 1, pending: false,
  forbiddenOwnerLoad: vi.fn(() => { throw new Error('No session loading or owner-scoped getter'); }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('electron', () => ({ app: { getPath: () => isolated.root } }));
const appearanceApplied = vi.hoisted(() => vi.fn());
// Appearance saves through its settings section; keep the real store write without window side effects.
vi.mock('../../appearance-settings-ipc.js', async () => {
  const store = await vi.importActual<typeof import('../../appearance-settings-store.js')>('../../appearance-settings-store.js');
  return {
    updateAppearanceFromSettings: async (patch: never) => { appearanceApplied(); return store.writeAppearanceSettingsPatch(patch); },
    resetAppearanceFromSettings: async () => { appearanceApplied(); return store.resetAppearanceSettings(); },
  };
});
// Custom instructions live in the app window; this stands in for that window.
const appWindow = vi.hoisted(() => ({ userPrompt: '', answers: true }));
vi.mock('../../app-settings/preferences.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../app-settings/preferences.js')>(),
  manageAppPreferences: async (operation: string, _patch?: unknown, _visibility?: unknown, { userPrompt }: { userPrompt?: string } = {}) => {
    if (!appWindow.answers || operation !== 'user-prompt') throw new Error('PREFERENCE_WINDOW_NOT_READY');
    if (userPrompt !== undefined) appWindow.userPrompt = userPrompt;
    return { value: {}, userPrompt: appWindow.userPrompt };
  },
}));
// Profile preferences are Host-owned only on a managed cloud instance.
vi.mock('../../instance-runtime/config.js', () => ({ getInstanceConfig: () => ({}) }));
vi.mock('../../logger.js', () => ({ createLogger: () => isolated.logger }));
vi.mock('../../maker-host/logger-adapter.js', () => ({ desktopMakerLogger: { child: () => isolated.logger } }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => String(isolated.generation),
  peekCommittedAppSession: () => ({ mode: 'cloud', dataOwnerId: isolated.owner, generation: isolated.generation }),
  isAppSessionBoundaryPending: () => isolated.pending,
  dataOwnerStorageKey: (id: string) => `test-${id}`,
  getActiveAppSession: isolated.forbiddenOwnerLoad,
  ownerScopedUserDataPath: isolated.forbiddenOwnerLoad,
}));
import {
  configureHostSettingsApplication, getHostSettings, getHostSettingsOperation,
  onHostSettingsChanged, readHostSettings, updateHostSettings,
} from '../index.js';
import { projectSettingsSnapshot } from '../snapshotProjection.js';
import { inspectPreferenceSettingsForSnapshot } from '../readers/preferences.js';
import { captureHostPersonalization } from '../startup.js';
import { readPersonalization } from '../personalization.js';
import { writeDatabaseSizeWarningSettings } from '../../database-size-warning-settings.js';

const warning = vi.fn();
const caller = { id: 'fixture-session', assertCurrent: () => {} };
const disposers: Array<() => void> = [];
async function change(domain: HostSettingsDomain, values: Pick<HostSettingsUpdate, 'set' | 'clear'>) {
  const current = await getHostSettings(caller, domain);
  if (current.status !== 'ready' || !('operationId' in current)) throw new Error('fixture settings not ready');
  return { domain, expectedRevision: current.revision, operationId: current.operationId, ...values };
}
beforeEach(() => {
  isolated.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-service-snapshot-'));
  isolated.owner = 'fixture-owner'; isolated.generation += 1; isolated.pending = false;
  appWindow.userPrompt = ''; appWindow.answers = true;
  vi.clearAllMocks(); warning.mockImplementation(() => {});
  configureHostSettingsApplication({ databaseWarning: warning });
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  try { expect(isolated.forbiddenOwnerLoad).not.toHaveBeenCalled(); }
  finally { fs.rmSync(isolated.root, { recursive: true, force: true }); }
});

describe('真实 Host 领域保存到脱敏快照的集成', () => {
  it('新任务默认值留在窗口草稿：Host 不读写文件', async () => {
    const dir = path.join(isolated.root, 'owners', `test-${isolated.owner}`);
    fs.mkdirSync(dir, { recursive: true });
    const defaultsFile = path.join(dir, 'host-new-task-defaults.json');
    const defaultsBytes = JSON.stringify({ _initialized: true, worktree: true });
    fs.writeFileSync(defaultsFile, defaultsBytes);
    const writes = [vi.spyOn(fs, 'writeFileSync'), vi.spyOn(fs, 'mkdirSync'), vi.spyOn(fs, 'unlinkSync')];
    try {
      expect(readHostSettings().newTaskDefaults).toEqual({ status: 'unavailable', revision: null });
      expect(await getHostSettings(caller, 'newTaskDefaults')).toEqual({ status: 'unavailable', revision: null });
      expect(inspectPreferenceSettingsForSnapshot('darwin').fields['newTaskDefaults.modelId']).toEqual({ status: 'unavailable' });
      for (const spy of writes) expect(spy).not.toHaveBeenCalled();
      expect(isolated.forbiddenOwnerLoad).not.toHaveBeenCalled();
      expect(fs.readFileSync(defaultsFile, 'utf8')).toBe(defaultsBytes);
    } finally { writes.forEach(spy => spy.mockRestore()); }
  });

  it('owner 缺失时直接静态拒绝定位，不回退到全局或临时目录', async () => {
    isolated.owner = '';
    await expect(readPersonalization()).resolves.toEqual({ status: 'unavailable', revision: null });
    expect(readHostSettings().ownerStamp).toBeNull();
    expect(fs.readdirSync(isolated.root)).toEqual([]);
  });

  it('v2只报告 Host 自己保存的值，窗口里的设置报告不可用，读取不写盘且不交出正文', async () => {
    const before = inspectPreferenceSettingsForSnapshot('darwin');
    expect(before.fields['newTaskDefaults.modelId']).toEqual({ status: 'unavailable' });
    // The instructions stay in the app window, so the synchronous report cannot see them.
    expect(before.fields['personalization.customized']).toEqual({ status: 'unavailable' });
    // Desktop preferences stay in the app window.
    expect(before.fields['desktop.theme']).toEqual({ status: 'unavailable' });
    expect(before.fields['databaseWarning.thresholdGiB']).toEqual({ status: 'value', value: 10, source: 'default' });
    expect(fs.readdirSync(isolated.root)).toEqual([]);
    await updateHostSettings(caller, await change('personalization', { set: { userPrompt: 'PRIVATE-TEST-PROMPT' } }));
    const after = inspectPreferenceSettingsForSnapshot('darwin');
    expect(after.fields['personalization.customized']).toEqual({ status: 'unavailable' });
    expect(JSON.stringify(after)).not.toContain('PRIVATE-TEST-PROMPT');
    await updateHostSettings(caller, await change('personalization', { clear: ['userPrompt'] }));
    expect(inspectPreferenceSettingsForSnapshot('linux').fields['desktop.agentIslandEnabled']).toEqual({ status: 'unsupported' });
  });

  it('第一次查询和投影不创建任何 profile 或 owner 文件', () => {
    const result = projectSettingsSnapshot(readHostSettings());
    expect(result.databaseWarning).toMatchObject({ status: 'supported', fields: { thresholdGiB: { value: 10, source: 'default' } } });
    expect(result.personalization).toMatchObject({ status: 'unavailable' });
    expect(fs.readdirSync(isolated.root)).toEqual([]);
  });

  it('写真实文件，变化通知驱动投影；显式默认值与 clear 不混同', async () => {
    const changed = vi.fn(); disposers.push(onHostSettingsChanged(changed));
    const request = await change('databaseWarning', { set: { thresholdGiB: 10, disabled: false } });
    const receipt = await updateHostSettings(caller, request);
    expect(receipt).toMatchObject({ status: 'saved', saved: true, application: 'applied' });
    expect(changed).toHaveBeenCalledOnce(); expect(warning).toHaveBeenCalledOnce();
    const file = path.join(isolated.root, 'database-size-warning-settings.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ thresholdGiB: 10, disabled: false });
    expect(projectSettingsSnapshot(readHostSettings()).databaseWarning).toMatchObject({ fields: {
      thresholdGiB: { value: 10, source: 'override' }, disabled: { value: false, source: 'override' },
    } });
    const clear = await updateHostSettings(caller, await change('databaseWarning', { clear: ['thresholdGiB', 'disabled'] }));
    expect(clear.saved).toBe(true);
    expect(projectSettingsSnapshot(readHostSettings()).databaseWarning).toMatchObject({ fields: {
      thresholdGiB: { value: 10, source: 'default' }, disabled: { value: false, source: 'default' },
    } });
  });

  it('个性化正文保存在窗口里，查询只说是否自定义，Host 不另存文件', async () => {
    const body = '仅用于隔离测试的个性化说明';
    const receipt = await updateHostSettings(caller, await change('personalization', { set: { userPrompt: body } }));
    expect(receipt).toMatchObject({ saved: true, application: 'next_agent_start' });
    expect(appWindow.userPrompt).toBe(body);
    const state = await getHostSettings(caller, 'personalization');
    expect(state).toMatchObject({ status: 'ready', value: { isCustomized: true } });
    expect(JSON.stringify(state)).not.toContain(body);
    expect(JSON.stringify(projectSettingsSnapshot(readHostSettings()))).not.toContain(body);
    await updateHostSettings(caller, await change('personalization', { clear: ['userPrompt'] }));
    expect(appWindow.userPrompt).toBe('');
    expect(await getHostSettings(caller, 'personalization')).toMatchObject({ status: 'ready', value: { isCustomized: false } });
    expect(fs.readdirSync(isolated.root)).toEqual([]);
  });

  it('窗口在别处改过正文时，旧版本号的保存被拒绝', async () => {
    const request = await change('personalization', { set: { userPrompt: '控制端看到的旧版本' } });
    appWindow.userPrompt = '实例窗口里刚改的';
    expect(await updateHostSettings(caller, request)).toMatchObject({ saved: false, code: 'CONFLICT' });
    expect(appWindow.userPrompt).toBe('实例窗口里刚改的');
  });

  it('启动从实例窗口读正文，拒绝控制端副本；生成上下文保持尾部拼接，旧任务不热改', async () => {
    await updateHostSettings(caller, await change('personalization', { set: { userPrompt: 'Host 第一版' } }));
    const first: Parameters<typeof captureHostPersonalization>[0] = {
      userPrompt: '控制端副本', makerMemoryEnabled: true, displayReasoning: 'summarized',
      hostStartupPreferences: { userPrompt: '控制端伪造快照' },
    };
    await captureHostPersonalization(first);
    first.userPrompt += '\n\n项目生成上下文';
    expect(first.hostStartupPreferences).toEqual({ userPrompt: 'Host 第一版', makerMemoryEnabled: true, displayReasoning: 'summarized' });
    expect(first.userPrompt).toBe('Host 第一版\n\n项目生成上下文');
    await updateHostSettings(caller, await change('personalization', { set: { userPrompt: 'Host 第二版' } }));
    expect(first.hostStartupPreferences?.userPrompt).toBe('Host 第一版');
    const next: Parameters<typeof captureHostPersonalization>[0] = {};
    await captureHostPersonalization(next);
    expect(next.userPrompt).toBe('Host 第二版');
  });

  it('窗口一直不应答时阻止启动，不偷偷使用默认值或控制端副本', async () => {
    vi.useFakeTimers();
    try {
      appWindow.answers = false;
      const opts: Parameters<typeof captureHostPersonalization>[0] = { userPrompt: '不应启用' };
      const started = captureHostPersonalization(opts);
      const settled = expect(started).rejects.toMatchObject({ code: 'UNREADABLE' });
      await vi.runAllTimersAsync();
      await settled;
      expect(opts.hostStartupPreferences).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it('字体正文只留 Host，快照只带自定义标志和数值', async () => {
    await updateHostSettings(caller, await change('appearance', { set: { uiFamily: '仅本地测试字体', uiSize: 16, windowZoom: 1.2 } }));
    expect(appearanceApplied).toHaveBeenCalledOnce();
    const snapshot = projectSettingsSnapshot(readHostSettings());
    expect(snapshot.appearance).toMatchObject({ fields: { uiFontCustomized: { value: true, source: 'override' }, uiFontSize: { value: 16 }, zoomFactor: { value: 1.2 } } });
    expect(JSON.stringify(snapshot)).not.toContain('仅本地测试字体');
  });

  it('应用失败仍报告已保存，同 ID 重试不再次写入/应用', async () => {
    warning.mockImplementation(() => { throw new Error('模拟应用失败，不应进入回执'); });
    const changed = vi.fn(); disposers.push(onHostSettingsChanged(changed));
    const request = await change('databaseWarning', { set: { thresholdGiB: 20 } });
    const first = await updateHostSettings(caller, request);
    const second = await updateHostSettings(caller, request);
    expect(first).toMatchObject({ status: 'saved', saved: true, application: 'failed' }); expect(second).toEqual(first);
    expect(getHostSettingsOperation(caller, request.operationId)).toMatchObject(first);
    expect(warning).toHaveBeenCalledOnce(); expect(changed).toHaveBeenCalledOnce();
    expect(projectSettingsSnapshot(readHostSettings()).databaseWarning).toMatchObject({ fields: { thresholdGiB: { value: 20, source: 'override' } } });
  });

  it('原子发布成功后回读故障，不把已经写入的更改报告成未保存', async () => {
    const file = path.join(isolated.root, 'database-size-warning-settings.json');
    const request = await change('databaseWarning', { set: { thresholdGiB: 25 } });
    const originalRename = fs.renameSync;
    const originalRead = fs.readFileSync;
    let published = false;
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      originalRename(from, to);
      if (String(to) === file) published = true;
    });
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (published && String(args[0]) === file) throw Object.assign(new Error('模拟回读故障'), { code: 'EACCES' });
      return originalRead(...args);
    }) as typeof fs.readFileSync);
    try {
      const receipt = await updateHostSettings(caller, request);
      expect(published).toBe(true);
      expect(receipt).toMatchObject({ status: 'saved', saved: true });
      expect(receipt.revision).toEqual(expect.any(String));
    } finally { read.mockRestore(); rename.mockRestore(); }
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).thresholdGiB).toBe(25);
  });

  it('个性化查询不返回正文', async () => {
    const body = '仅本地保存的测试说明';
    await updateHostSettings(caller, await change('personalization', { set: { userPrompt: body } }));
    expect(JSON.stringify(await getHostSettings(caller, 'personalization'))).not.toContain(body);
    expect(JSON.stringify(projectSettingsSnapshot(readHostSettings()))).not.toContain(body);
  });

  it('旧 UI writer 写入也通知，过期 CAS 拒绝覆盖，投影反映磁盘新值', async () => {
    const request = await change('databaseWarning', { set: { thresholdGiB: 30 } });
    const changed = vi.fn(); disposers.push(onHostSettingsChanged(changed));
    await writeDatabaseSizeWarningSettings({ thresholdGiB: 40 });
    expect(changed).toHaveBeenCalledOnce();
    expect(await updateHostSettings(caller, request)).toMatchObject({ saved: false, code: 'CONFLICT' });
    expect(projectSettingsSnapshot(readHostSettings()).databaseWarning).toMatchObject({ fields: { thresholdGiB: { value: 40 } } });
  });

  it('坏文件读为 unavailable，不删除、不修复、不把默认值报成真实设置', () => {
    const file = path.join(isolated.root, 'database-size-warning-settings.json');
    fs.writeFileSync(file, '{broken-fixture');
    expect(projectSettingsSnapshot(readHostSettings()).databaseWarning).toEqual({ status: 'unavailable', scope: 'profile', boundary: 'immediate' });
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken-fixture');
  });
});
