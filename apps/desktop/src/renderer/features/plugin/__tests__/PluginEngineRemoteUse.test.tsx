// @vitest-environment jsdom
/**
 * 「允许被远程调用」cards of a plugin's task engines (docs/plans/acp-plugin-bridge.md, third phase).
 *
 * 测试价值
 * - 生产入口与可观察结果：真实的 usePluginRemoteUseEngines + PluginEngineRemoteUseCards(插件详情页「配置」
 *   区块用的就是这一对)，引擎列表与远程控制状态来自预加载接口的内存替身。用户看到的是：开关能不能点、
 *   不能点时写的是哪一种原因、点了以后写给主进程的是哪个引擎和什么值。
 * - 规则依据：供应商分享规则「允许远程控制 → 允许被远程调用」逐级开启；插件引擎只对自己的其他电脑开放，
 *   开关必须由宿主画、由用户在装着插件的电脑上操作。
 * - 现有覆盖缺口：ProvidersSection 的测试只覆盖普通供应商那一行；插件引擎的三种状态(可开、插件不支持、
 *   本机未允许远程控制)与「只列本插件的引擎」没有覆盖。
 * - 最小失败输入：插件不支持时开关仍可点；未允许远程控制时开关可点；点开关写成别的插件的引擎；
 *   没有引擎的插件也出现卡片。
 * - 2026-11-22 补：引擎在「设置 → 模型供应商」里被停用时，其他电脑用不了它，这张卡片不能还显示成可开关的样子
 *   (两处是同一个引擎的设置，要讲同一件事)。最小失败输入：停用后开关仍可点、没有说明去哪里恢复。
 * - tier：unit(jsdom，渲染真实组件)。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    i18n: { language: 'en', resolvedLanguage: 'en' },
    t: (key: string, options?: Record<string, string>) => (options?.engine ? `${key}:${options.engine}` : key),
  }),
}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ toast: { error: toastError } }));

import { resetPluginEnginesStoreForTests } from '@/hooks/usePluginEngines';
import type { PluginEngineView } from '../../../../shared/pluginEngines';
import { PluginEngineRemoteUseCards, usePluginRemoteUseEngines } from '../PluginEngineRemoteUse';

const engine = (key: string, name: string, remoteUse?: PluginEngineView['remoteUse']): PluginEngineView => ({
  key,
  providerId: `acp-plugin:${key}`,
  ghostId: key.split(':')[0]!,
  harnessId: key.split(':')[1]!,
  name,
  availability: { state: 'available' },
  models: [],
  permissionModes: [{ id: 'ask', displayName: 'Ask' }],
  defaultPermissionMode: 'ask',
  ...(remoteUse ? { remoteUse } : {}),
});

function Cards({ ghostId, onManageShare }: { ghostId: string; onManageShare?: (engine: PluginEngineView) => void }) {
  return <PluginEngineRemoteUseCards engines={usePluginRemoteUseEngines(ghostId)} onManageShare={onManageShare} surfaceClassName="" />;
}

async function renderCards(input: {
  ghostId?: string;
  engines: PluginEngineView[];
  remoteControlEnabled?: boolean;
  setPluginEngineRemoteUse?: ReturnType<typeof vi.fn>;
  onManageShare?: (engine: PluginEngineView) => void;
}) {
  const setPluginEngineRemoteUse = input.setPluginEngineRemoteUse
    ?? vi.fn(async (_key: string, enabled: boolean) => ({ supported: true, enabled }));
  vi.stubGlobal('electronAPI', {
    maker: {
      listPluginEngines: vi.fn(async () => input.engines),
      onPluginEnginesChanged: vi.fn(() => () => {}),
      setPluginEngineRemoteUse,
    },
    deviceLink: { getState: vi.fn(async () => ({ remoteControlEnabled: input.remoteControlEnabled ?? true })) },
  });
  render(<MemoryRouter><Cards ghostId={input.ghostId ?? 'dsh-plugin'} onManageShare={input.onManageShare} /></MemoryRouter>);
  // The engine list and this computer's remote-control state both arrive asynchronously.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return { setPluginEngineRemoteUse };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetPluginEnginesStoreForTests();
  toastError.mockReset();
});

describe('remote use of a plugin’s task engines', () => {
  it('writes the switch for this plugin’s engine only and shows the stored state', async () => {
    const { setPluginEngineRemoteUse } = await renderCards({
      engines: [
        engine('dsh-plugin:dsh', 'DeepSeek Harness', { supported: true, enabled: false }),
        engine('other-plugin:other', 'Other engine', { supported: true, enabled: true }),
      ],
    });
    // One card: the other plugin's engine does not belong on this plugin's page.
    const toggle = await screen.findByRole('switch');
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('settings.ghosts.detail.engineRemoteUse.description')).toBeTruthy();

    fireEvent.click(toggle);
    expect(setPluginEngineRemoteUse).toHaveBeenCalledWith('dsh-plugin:dsh', true);
    await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true'));
  });

  it.each([
    ['the plugin does not offer the mode', { supported: false, enabled: false }, true, 'settings.ghosts.detail.engineRemoteUse.unsupported'],
    ['a Cindy main process from before the switch existed', undefined, true, 'settings.ghosts.detail.engineRemoteUse.unsupported'],
    ['this computer does not allow remote control', { supported: true, enabled: true }, false, 'settings.ghosts.detail.engineRemoteUse.remoteControlOff'],
  ] as const)('keeps the switch visible but unusable when %s', async (_label, remoteUse, remoteControlEnabled, reason) => {
    const { setPluginEngineRemoteUse } = await renderCards({
      engines: [engine('dsh-plugin:dsh', 'DeepSeek Harness', remoteUse)],
      remoteControlEnabled,
    });
    const toggle = await screen.findByRole('switch');
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(reason, { exact: false })).toBeTruthy();
    fireEvent.click(toggle);
    expect(setPluginEngineRemoteUse).not.toHaveBeenCalled();
  });

  it('shows the stored switch but locks it while the provider is turned off in the provider settings', async () => {
    const { setPluginEngineRemoteUse } = await renderCards({
      engines: [{
        ...engine('dsh-plugin:dsh', 'DeepSeek Harness', { supported: true, enabled: true }),
        suspended: true as const,
        availability: { state: 'unavailable' as const, reason: 'suspended' },
      }],
    });
    const toggle = await screen.findByRole('switch');
    // What the user set is kept and shown; it applies again once the provider is turned on.
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('settings.ghosts.detail.engineRemoteUse.providerDisabled', { exact: false })).toBeTruthy();
    expect(screen.queryByText('settings.ghosts.detail.engineRemoteUse.description')).toBeNull();
    fireEvent.click(toggle);
    expect(setPluginEngineRemoteUse).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'settings.ghosts.detail.engineRemoteUse.openProviders' })).toBeTruthy();
  });

  it('restores the switch and says why when the plugin turned out not to support it', async () => {
    const setPluginEngineRemoteUse = vi.fn(async () => {
      throw new Error("Error invoking remote method: [PLUGIN_ENGINE_REMOTE_USE_UNSUPPORTED] This plugin engine can only run tasks on this computer");
    });
    await renderCards({
      engines: [engine('dsh-plugin:dsh', 'DeepSeek Harness', { supported: true, enabled: false })],
      setPluginEngineRemoteUse,
    });
    fireEvent.click(await screen.findByRole('switch'));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('chat.remoteError.PLUGIN_ENGINE_REMOTE_USE_UNSUPPORTED'));
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('shows nothing for a plugin that provides no engine', async () => {
    await renderCards({ ghostId: 'no-engines', engines: [engine('dsh-plugin:dsh', 'DeepSeek Harness', { supported: true, enabled: true })] });
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('shows the Remote & sharing button only when shareSupported is true and routes clicks to onManageShare', async () => {
    const onManageShare = vi.fn();
    await renderCards({
      engines: [engine('dsh-plugin:dsh', 'DeepSeek Harness', { supported: true, enabled: true })],
      onManageShare,
    });
    expect(screen.queryByTestId('provider-share-entry')).toBeNull();
    cleanup();
    resetPluginEnginesStoreForTests();

    const shareable = engine('dsh-plugin:dsh', 'DeepSeek Harness', { supported: true, shareSupported: true, enabled: true });
    await renderCards({ engines: [shareable], onManageShare });
    expect(screen.getByText('settings.ghosts.detail.engineRemoteUse.descriptionShareable')).toBeTruthy();
    fireEvent.click(screen.getByTestId('provider-share-entry'));
    expect(onManageShare).toHaveBeenCalledWith(shareable);
  });
});
