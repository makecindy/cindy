import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_APPEARANCE_SETTINGS } from '../../../shared/appearanceSettings.js';
import type { HostSettingState, NewTaskDefaultSettings } from '../../../shared/hostSettings.js';

const forbidden = vi.hoisted(() => vi.fn(() => { throw new Error('不得越过注入的读取边界'); }));
vi.mock('../../appearance-settings-store.js', () => ({ inspectAppearanceSettings: forbidden }));
vi.mock('../../database-size-warning-settings.js', () => ({ inspectDatabaseSizeWarningSettings: forbidden }));
import { inspectPreferenceSettingsForSnapshot, type PreferenceSettingsReaders } from '../readers/preferences.js';

function ready<T>(value: T, customizedKeys: string[] = []): Extract<HostSettingState<T>, { status: 'ready' }> {
  return { status: 'ready', value, defaults: structuredClone(value), customizedKeys,
    isCustomized: customizedKeys.length > 0, revision: 'private-revision' };
}
function fixture() {
  const appearance = ready({ ...DEFAULT_APPEARANCE_SETTINGS }, ['uiFamily']);
  const newTaskDefaults: NewTaskDefaultSettings = { harness: 'codex', providerId: null, modelId: null,
    effort: null, fast: false, thinking: true, worktree: false, planMode: false };
  const readers: PreferenceSettingsReaders = {
    appearance: () => appearance,
    newTaskDefaults: () => ready(newTaskDefaults), personalization: () => ready({ isCustomized: false }),
    databaseWarning: () => ready({ thresholdGiB: 10, disabled: false }),
  };
  return { appearance, readers };
}

describe('桌面与原四域的逐叶只读投影', () => {
  it('不读取字体名，且不输出内部revision', () => {
    const { appearance, readers } = fixture();
    const privateRead = vi.fn(() => { throw new Error('不得读取私密正文'); });
    Object.defineProperty(appearance.value, 'uiFamily', { get: privateRead });
    Object.defineProperty(appearance.value, 'codeFamily', { get: privateRead });
    const out = inspectPreferenceSettingsForSnapshot('darwin', readers);
    expect(out.fields['appearance.uiFontCustomized']).toEqual({ status: 'value', value: true, source: 'override' });
    expect(JSON.stringify(out)).not.toMatch(/private-revision|uiFamily/);
    expect(privateRead).not.toHaveBeenCalled(); expect(forbidden).not.toHaveBeenCalled();
  });
  it('桌面偏好留在应用窗口里，快照与普通桌面一样报告不可用', () => {
    const { readers } = fixture();
    const mac = inspectPreferenceSettingsForSnapshot('darwin', readers);
    expect(mac.fields['desktop.theme']).toEqual({ status: 'unavailable' });
    expect(mac.fields['desktop.agentIslandEnabled']).toEqual({ status: 'unavailable' });
    const linux = inspectPreferenceSettingsForSnapshot('linux', readers);
    expect(linux.fields['desktop.notificationsEnabled']).toEqual({ status: 'unavailable' });
    expect(linux.fields['desktop.agentIslandEnabled']).toEqual({ status: 'unsupported' });
  });
  it('单域抛错只使该域不可读，不使其它字段回退或失败', () => {
    const { readers } = fixture();
    readers.appearance = () => { throw new Error('私密底层错误'); };
    const out = inspectPreferenceSettingsForSnapshot('darwin', readers);
    expect(out.fields['appearance.uiFontSize']).toEqual({ status: 'unreadable' });
    expect(out.fields['databaseWarning.disabled']).toMatchObject({ status: 'value', value: false });
    expect(JSON.stringify(out)).not.toContain('私密底层错误');
  });
});
