// @vitest-environment jsdom
/**
 * Providers that a plugin offers, in Settings → Model providers
 * (docs/dev-rules/protocol-compatibility/plugin-harnesses.md「插件引擎进入模型供应商列表」).
 *
 * 测试价值
 * - 生产入口与可观察结果：ProvidersSection 左栏与右栏用的 PluginEngineProviderRows / PluginEngineProviderDetail，
 *   确认弹窗、路由与下拉菜单都是真实组件，预加载接口用内存替身。用户看到的是：哪一行带「插件」标识、能不能点、
 *   菜单和说明条里有哪些动作；点了以后写给主进程的是哪个引擎和什么值。
 * - 规则依据：用户要求(2026-11-22)插件供应商出现在供应商列表里、带单独标识、功能与普通供应商一致，
 *   「允许被远程调用」在供应商页也能操作并与插件页同步；provider-settings.md 的菜单与重命名约定；
 *   configuration-and-overrides.md「隐藏与停用是两根轴」。
 * - 现有覆盖缺口：新组件；PluginEngineRemoteUse.test 只覆盖插件详情页那张卡片。
 * - 最小失败输入：行上没有「插件」标识；隐藏写成停用；「改为隐藏」没有同时恢复启用；关一个模型写成别的模型或
 *   别的引擎；改回插件原名仍记一个显示名；停用后还列着模型和远程开关；本机没开远程控制时开关还能点；
 *   插件不上报用量也去读用量。
 * - tier：unit(jsdom，渲染真实组件)。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    i18n: { language: 'en', resolvedLanguage: 'en' },
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0 ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ toast: { error: toastError } }));
vi.mock('@/lib/scrollbarAutoHide', () => ({ flashScrollbar: () => {} }));

import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import type { PluginEngineView } from '../../../../shared/pluginEngines';
import { PluginEngineProviderDetail, PluginEngineProviderRows, pluginEngineRailGroup } from '../PluginEngineProviders';
import { getDataOwnerGeneration, setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

let engineIndex = 0;
/** A fresh key per engine: the usage reader shares a read per engine for a minute. */
const engine = (extra: Partial<PluginEngineView> = {}): PluginEngineView => {
  const key = extra.key ?? `dsh-plugin-${engineIndex += 1}:dsh`;
  return {
    key,
    providerId: `acp-plugin:${key}`,
    ghostId: key.split(':')[0]!,
    harnessId: key.split(':')[1]!,
    name: 'DeepSeek Harness',
    availability: { state: 'available' },
    models: [
      { id: 'deepseek-v4', displayName: 'DeepSeek-V4-Pro' },
      { id: 'deepseek-lite', displayName: 'DeepSeek Lite' },
    ],
    permissionModes: [{ id: 'ask', displayName: 'Ask' }],
    defaultPermissionMode: 'ask',
    remoteUse: { supported: true, enabled: false, shareSupported: true },
    ...extra,
  };
};

function stubApi(overrides: Record<string, unknown> = {}) {
  const api = {
    setPluginEnginePrefs: vi.fn(async () => null),
    setPluginEngineRemoteUse: vi.fn(async (_key: string, enabled: boolean) => ({ supported: true, enabled })),
    refreshPluginEngines: vi.fn(async () => undefined),
    getPluginEngineUsage: vi.fn(async () => null),
    ...overrides,
  };
  vi.stubGlobal('electronAPI', { maker: api });
  return api;
}

function Location() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderDetail(view: PluginEngineView, props: {
  remoteControlEnabled?: boolean | null;
  pendingShareRequests?: number;
  onManageShare?: () => void;
} = {}) {
  return render(
    <MemoryRouter initialEntries={['/settings?tab=providers']}>
      <ConfirmDialogProvider>
        <PluginEngineProviderDetail
          engine={view}
          remoteControlEnabled={props.remoteControlEnabled === undefined ? true : props.remoteControlEnabled}
          pendingShareRequests={props.pendingShareRequests ?? 0}
          onManageShare={props.onManageShare ?? (() => {})}
        />
        <Location />
      </ConfirmDialogProvider>
    </MemoryRouter>,
  );
}

async function chooseFromMenu(item: string) {
  await userEvent.click(screen.getByRole('button', { name: 'settings.providers.detail.moreActionsAria' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: item }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  toastError.mockReset();
});

describe('plugin providers in the provider list', () => {
  // Unit: open the real settings dialog and save only a level the plugin offers.
  it('edits and restores the default reasoning level of an Antigravity model', async () => {
    const api = stubApi();
    const engineView = engine({ name: 'Antigravity', models: [{ id: 'gemini', displayName: 'Gemini', efforts: ['low', 'high'], defaultEffort: 'high' }],
      modelEfforts: { gemini: 'high' } });
    renderDetail(engineView);
    const trigger = screen.getByRole('button', { name: /advanced.openAria/ });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const dialog = within(await screen.findByRole('dialog', { name: 'Gemini' }));
    expect(dialog.getByRole('radio', { name: 'effortLevels.high' }).getAttribute('aria-checked')).toBe('true');
    expect(dialog.queryByRole('radio', { name: 'effortLevels.medium' })).toBeNull();
    await userEvent.click(dialog.getByRole('radio', { name: 'effortLevels.low' }));
    const { dataOwnerId, generation } = getDataOwnerGeneration();
    const stamp = { dataOwnerId, ownerGeneration: generation };
    expect(api.setPluginEnginePrefs).toHaveBeenLastCalledWith({ key: engineView.key, modelEffort: { id: 'gemini', effort: 'low' }, ownerStamp: stamp });
    await userEvent.click(dialog.getByRole('button', { name: 'settings.providers.models.advanced.restoreDefault' }));
    expect(api.setPluginEnginePrefs).toHaveBeenLastCalledWith({ key: engineView.key, modelEffort: { id: 'gemini', effort: null }, ownerStamp: stamp });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('marks every row as coming from a plugin, shows whether it can run and opens the one clicked', async () => {
    stubApi();
    const ready = engine({ name: 'DeepSeek Harness' });
    const notSignedIn = engine({ name: 'Gemini CLI', availability: { state: 'unavailable', message: 'Sign in first' } });
    const onSelect = vi.fn();
    render(
      <ConfirmDialogProvider>
        <PluginEngineProviderRows engines={[ready, notSignedIn]} selectedKey={notSignedIn.key} onSelect={onSelect} />
      </ConfirmDialogProvider>,
    );
    const rows = screen.getAllByTestId('plugin-engine-provider-row');
    expect(rows.map((row) => within(row).getByTestId('plugin-engine-provider-tag').textContent))
      .toEqual(['settings.providers.plugin.badge', 'settings.providers.plugin.badge']);
    expect(rows.map((row) => row.getAttribute('aria-current'))).toEqual(['false', 'true']);
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      'settings.providers.plugin.rowTip:{"provider":"DeepSeek Harness"}',
      'settings.providers.plugin.rowTip:{"provider":"Gemini CLI"}',
    ]);
    fireEvent.click(rows[0]!);
    expect(onSelect).toHaveBeenCalledWith(ready.key);
    // Like an ordinary provider's row: double-click renames.
    fireEvent.doubleClick(rows[1]!);
    expect((within(await screen.findByRole('alertdialog')).getByRole('textbox') as HTMLInputElement).value).toBe('Gemini CLI');
    // The left rail files a provider under one group: turned off wins over hidden.
    expect([engine(), engine({ hidden: true }), engine({ hidden: true, suspended: true })].map(pluginEngineRailGroup))
      .toEqual(['active', 'hidden', 'suspended']);
  });

  it('hides and turns off through the provider menu, each as its own setting', async () => {
    const api = stubApi();
    const shown = engine();
    const view = renderDetail(shown);
    await chooseFromMenu('settings.providers.menu.hideProvider');
    expect(api.setPluginEnginePrefs).toHaveBeenLastCalledWith({ key: shown.key, hidden: true });
    await chooseFromMenu('settings.providers.menu.disableProvider');
    expect(api.setPluginEnginePrefs).toHaveBeenLastCalledWith({ key: shown.key, suspended: true });
    view.unmount();

    // Hidden: says so, keeps its models, and offers to show it again from the note and the menu.
    const hidden = engine({ hidden: true });
    renderDetail(hidden);
    expect(screen.getByRole('status').textContent).toBe('settings.providers.pill.hidden');
    expect(screen.getByTestId('plugin-engine-models')).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('plugin-engine-hidden')).getByRole('button', { name: 'settings.providers.button.showProvider' }));
    expect(api.setPluginEnginePrefs).toHaveBeenLastCalledWith({ key: hidden.key, hidden: false });
    await chooseFromMenu('settings.providers.menu.showProvider');
    expect(api.setPluginEnginePrefs).toHaveBeenLastCalledWith({ key: hidden.key, hidden: false });
  });

  it('shows a turned-off provider without its models or remote switch, and restores it or hides it instead', async () => {
    const api = stubApi({ setPluginEnginePrefs: vi.fn(async () => { throw new Error('disk full'); }) });
    const suspended = engine({ suspended: true, availability: { state: 'unavailable', reason: 'suspended' }, reportsUsage: true });
    renderDetail(suspended);
    expect(screen.getByRole('status').textContent).toBe('settings.providers.pill.suspended');
    expect(screen.queryByTestId('plugin-engine-models')).toBeNull();
    expect(screen.queryByTestId('plugin-engine-remote-access')).toBeNull();
    expect(screen.queryByTestId('plugin-engine-unavailable')).toBeNull();
    expect(api.getPluginEngineUsage).not.toHaveBeenCalled();

    const banner = within(screen.getByTestId('plugin-engine-suspended'));
    fireEvent.click(banner.getByRole('button', { name: 'settings.providers.button.hideInstead' }));
    // One change: out of the picker and usable again.
    expect(api.setPluginEnginePrefs).toHaveBeenLastCalledWith({ key: suspended.key, hidden: true, suspended: false });
    fireEvent.click(banner.getByRole('button', { name: 'settings.providers.button.enableProvider' }));
    expect(api.setPluginEnginePrefs).toHaveBeenLastCalledWith({ key: suspended.key, suspended: false });
    // A failed save is reported; nothing is shown as changed until main pushes a new list.
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('settings.providers.models.accessWriteFailed'));
    expect(screen.getByRole('status').textContent).toBe('settings.providers.pill.suspended');
  });

  it('turns single models off and on again, naming the engine and the model', async () => {
    const api = stubApi();
    const view = engine({
      models: [{ id: 'deepseek-v4', displayName: 'DeepSeek-V4-Pro' }],
      disabledModels: [{ id: 'deepseek-lite', displayName: 'DeepSeek Lite' }],
    });
    renderDetail(view);
    const on = within(screen.getByTestId('plugin-engine-models')).getByRole('switch');
    const off = within(screen.getByTestId('plugin-engine-models-off')).getByRole('switch');
    expect([on.getAttribute('aria-checked'), off.getAttribute('aria-checked')]).toEqual(['true', 'false']);
    expect(off.getAttribute('aria-label')).toBe('settings.providers.plugin.modelSwitchAria:{"model":"DeepSeek Lite"}');
    fireEvent.click(on);
    expect(api.setPluginEnginePrefs).toHaveBeenLastCalledWith({ key: view.key, models: { ids: ['deepseek-v4'], disabled: true } });
    fireEvent.click(off);
    expect(api.setPluginEnginePrefs).toHaveBeenLastCalledWith({ key: view.key, models: { ids: ['deepseek-lite'], disabled: false } });
    await waitFor(() => expect((on as HTMLButtonElement).disabled).toBe(false));
  });

  it('renames on this computer only and goes back to the plugin’s name without keeping one', async () => {
    const api = stubApi();
    const declared = engine();
    const view = renderDetail(declared);
    expect(screen.queryByRole('menuitem', { name: 'settings.providers.plugin.resetName' })).toBeNull();
    await chooseFromMenu('settings.providers.pill.rename');
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '  Work DeepSeek  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.providers.custom.save' }));
    await waitFor(() => expect(api.setPluginEnginePrefs).toHaveBeenLastCalledWith(expect.objectContaining({ key: declared.key, name: 'Work DeepSeek' })));
    view.unmount();

    const renamed = engine({ name: 'Work DeepSeek', declaredName: 'DeepSeek Harness' });
    renderDetail(renamed);
    // The header tells which plugin name is behind the user's own.
    expect(screen.getByText('settings.providers.plugin.declaredName:{"name":"DeepSeek Harness"}')).toBeTruthy();
    await chooseFromMenu('settings.providers.pill.rename');
    const again = await screen.findByRole('alertdialog');
    fireEvent.change(within(again).getByRole('textbox'), { target: { value: 'DeepSeek Harness' } });
    fireEvent.click(within(again).getByRole('button', { name: 'settings.providers.custom.save' }));
    await waitFor(() => expect(api.setPluginEnginePrefs).toHaveBeenLastCalledWith(expect.objectContaining({ key: renamed.key, name: null })));
    api.setPluginEnginePrefs.mockClear();
    await chooseFromMenu('settings.providers.plugin.resetName');
    expect(api.setPluginEnginePrefs).toHaveBeenLastCalledWith({ key: renamed.key, name: null });
  });

  // Owner-scoped writes must drop a pending dialog after an account switch (unit, real dialog).
  it('drops a rename confirmed after switching accounts', async () => {
    const originalOwner = getDataOwnerGeneration();
    const api = stubApi();
    renderDetail(engine());
    await chooseFromMenu('settings.providers.pill.rename');
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Work DeepSeek' } });
    try {
      act(() => setDataOwnerGeneration('other-account'));
      fireEvent.click(within(dialog).getByRole('button', { name: 'settings.providers.custom.save' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(api.setPluginEnginePrefs).not.toHaveBeenCalled();
    } finally {
      act(() => setDataOwnerGeneration(originalOwner.dataOwnerId, originalOwner.generation));
    }
  });

  it('offers the same remote-use switch and share entry as the plugin page, level by level', async () => {
    const api = stubApi();
    const onManageShare = vi.fn();
    const shareable = engine();
    const view = renderDetail(shareable, { onManageShare, pendingShareRequests: 2 });
    const row = () => within(screen.getByTestId('plugin-engine-remote-access'));
    fireEvent.click(row().getByRole('switch'));
    expect(api.setPluginEngineRemoteUse).toHaveBeenCalledWith(shareable.key, true);
    await waitFor(() => expect(row().getByRole('switch').getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(row().getByRole('button', { name: /providerShare\.entry/ }));
    expect(onManageShare).toHaveBeenCalledTimes(1);
    view.unmount();

    // This computer does not allow remote control: the switch stays visible, cannot be used and says why.
    const blocked = renderDetail(engine(), { remoteControlEnabled: false });
    expect((row().getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
    expect(row().getByText(/settings\.ghosts\.detail\.engineRemoteUse\.remoteControlOff/)).toBeTruthy();
    blocked.unmount();

    // The plugin does not offer the mode: no share entry, and the reason is the plugin's.
    const unsupported = renderDetail(engine({ remoteUse: { supported: false, enabled: false } }));
    expect((row().getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
    expect(row().getByText('settings.ghosts.detail.engineRemoteUse.unsupported')).toBeTruthy();
    expect(row().queryByRole('button', { name: /providerShare\.entry/ })).toBeNull();
    unsupported.unmount();

    // Not read yet: nothing rather than a flash of "remote control is off".
    renderDetail(engine(), { remoteControlEnabled: null });
    expect(screen.queryByTestId('plugin-engine-remote-access')).toBeNull();
  });

  it('leaves sign-in to the plugin: says why it cannot run, opens the plugin and asks for its models', async () => {
    const api = stubApi();
    const notSignedIn = engine({
      key: 'gemini plugin:gemini',
      name: 'Gemini CLI',
      availability: { state: 'unavailable', message: ' Sign in with gemini auth ' },
      models: [],
    });
    renderDetail(notSignedIn);
    expect(api.refreshPluginEngines).toHaveBeenCalledExactlyOnceWith(notSignedIn.ghostId);
    expect(screen.getByRole('status').textContent).toBe('newChat.pluginEngines.unavailable');
    expect(screen.getByTestId('plugin-engine-unavailable').textContent)
      .toBe('settings.providers.plugin.unavailableBannerReason:{"reason":"Sign in with gemini auth"}');
    // No model listed yet is a normal state with an explanation, not an empty list.
    expect(screen.getByText('settings.providers.plugin.modelsEmpty')).toBeTruthy();
    expect(screen.queryByTestId('plugin-engine-models')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.plugin.openPlugin' }));
    expect(screen.getByTestId('location').textContent).toBe('/settings?tab=ghosts&ghost=gemini%20plugin');
  });

  it('shows the account usage only for an engine whose plugin reports it', async () => {
    const usage = { updatedAt: Date.now(), windows: [{ label: 'Weekly requests', remainingPercent: 64 }] };
    const api = stubApi({ getPluginEngineUsage: vi.fn(async () => usage) });
    const reporting = engine({ reportsUsage: true });
    const view = renderDetail(reporting);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(api.getPluginEngineUsage).toHaveBeenCalledWith(reporting.key);
    expect(within(await screen.findByTestId('provider-usage-module')).getByText('Weekly requests')).toBeTruthy();
    view.unmount();

    api.getPluginEngineUsage.mockClear();
    renderDetail(engine());
    await act(async () => { await Promise.resolve(); });
    expect(api.getPluginEngineUsage).not.toHaveBeenCalled();
    expect(screen.queryByTestId('provider-usage-module')).toBeNull();
  });
});
