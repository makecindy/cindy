// @vitest-environment jsdom
/**
 * 插件引擎任务的身份图标：运行闪烁时保留插件自身配色，仅非运行时显示灰色
 * (2026-11-19 用户反馈：空闲时不能保留蓝色鲸鱼；后续补充：运行闪烁时应保留插件自身颜色)；
 * 远程电脑的插件引擎任务在侧栏里无需先点进会话即可按电脑共享一次目录拉取并展示插件自身图标。
 *
 * 测试价值
 * - 生产入口与可观察结果：VendorIcon(vendor 'acp') 与 SessionStatusIcon(经 usePluginEngineIdentity
 *   读 usePluginEngines 远端目录)；看空闲剪影/灰度、运行原色呼吸、远程侧栏多行共用一次
 *   maker:list-plugin-engines 拉取后从通用拼图切换成插件图标，以及断线不发、本机引擎走本地、
 *   共享任务不越权、撤权逐出丢弃迟到回包。
 * - 规则依据：VendorIcon 头注的插件引擎状态色规则(2026-11-19 用户裁决)、engineering-conventions.md
 *   §8.1/§8.3/§8.4 与 DESIGN.md 灰阶规则。
 * - 现有覆盖缺口：此前 usePluginEngineIdentity 未触发远端目录首次读取，侧栏查看另一台电脑的插件
 *   引擎任务时始终显示通用拼图；PluginEnginesSection.test 只覆盖显式 readOnEntry 的选择器路径。
 * - 最小失败输入：渲染远程设备上的 acp 任务 SessionStatusIcon(未打开会话/选择器)，旧实现零调用
 *   maker:list-plugin-engines 并永远停在通用拼图；本机提供引擎的远程任务误走 deviceLink.invoke。
 * - tier：unit(jsdom 不能解码图片，测量结果用测试入口登记；远端调用用 stub electronAPI)。
 */
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  selfDeviceId: 'device-self' as string | null,
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useOptionalAuthDeviceId: () => mocks.selfDeviceId,
}));
vi.mock('@/hooks/useComposerDraftPresence', () => ({ useComposerDraftPresence: () => false }));
vi.mock('@/hooks/useSessionPausedQueue', () => ({ useSessionPausedQueue: () => false }));

import { sharedTaskHostPeer } from '@cindy/device-link';
import { VendorIcon } from '@/components/sidebar/VendorIcon';
import { isSilhouetteIcon, rememberPluginIconSilhouetteForTests } from '@/components/icons/pluginIconSilhouette';
import { getDataOwnerGeneration, setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { SessionStatusIcon } from '@/features/cc-agent/sidebar/SessionStatusIcon';
import {
  evictRemotePluginEngines,
  markRemotePluginEnginesStale,
  prefetchRemotePluginEngines,
  resetPluginEnginesStoreForTests,
} from '@/hooks/usePluginEngines';
import type { Session } from '@/lib/ccAgent.types';
import { PLUGIN_ENGINES_INVOKE, type PluginEngineView } from '../../shared/pluginEngines';

afterEach(() => {
  cleanup();
  mocks.selfDeviceId = 'device-self';
  vi.unstubAllGlobals();
  resetPluginEnginesStoreForTests();
});

/** 4×4 RGBA pixels from an alpha map (row by row). */
const pixels = (alpha: number[]) => alpha.flatMap((value) => [77, 107, 254, value]);

describe('plugin engine identity icon', () => {
  it('uses a shape on a clear background as a silhouette, never an opaque or rounded-square icon', () => {
    // The DeepSeek whale measures 68 % clear / 31 % solid.
    expect(isSilhouetteIcon(pixels([0, 0, 0, 0, 0, 255, 255, 0, 0, 255, 255, 255, 0, 0, 0, 0]))).toBe(true);
    expect(isSilhouetteIcon(pixels(Array(16).fill(255)))).toBe(false);
    // Clear only in the four corners: an app tile, which would become a grey block.
    expect(isSilhouetteIcon(pixels([0, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 0]))).toBe(false);
    expect(isSilhouetteIcon(pixels(Array(16).fill(0)))).toBe(false);
  });

  it('renders a grey silhouette when idle and keeps its own colours while running and breathing', () => {
    const whale = 'data:image/png;base64,whale';
    rememberPluginIconSilhouetteForTests(whale, true);
    const idle = render(<VendorIcon vendor="acp" iconDataUrl={whale} />).container;
    const mark = idle.querySelector<HTMLElement>('[data-plugin-icon="silhouette"]')!;
    expect(mark.style.backgroundColor).toBe('currentcolor');
    expect(mark.style.maskImage).toContain(whale);
    expect(idle.querySelector('img')).toBeNull();
    expect(idle.firstElementChild!.className).toContain('text-[hsl(var(--sidebar-muted))]');

    const running = render(<VendorIcon vendor="acp" iconDataUrl={whale} running />).container;
    const runningImg = running.querySelector<HTMLImageElement>('img[data-plugin-icon="original"]')!;
    expect(runningImg.getAttribute('src')).toBe(whale);
    expect(runningImg.className).not.toContain('grayscale');
    expect(running.querySelector('[data-plugin-icon="silhouette"]')).toBeNull();
    expect(running.firstElementChild!.className).toContain('session-status-breathing');
  });

  it('shows an opaque or unmeasured icon in greyscale when idle, and in its own colours while running', () => {
    const tile = 'data:image/png;base64,tile';
    rememberPluginIconSilhouetteForTests(tile, false);
    for (const url of [tile, 'data:image/png;base64,unmeasured']) {
      const idleImage = render(<VendorIcon vendor="acp" iconDataUrl={url} />).container.querySelector('img')!;
      expect(idleImage.getAttribute('data-plugin-icon')).toBe('greyscale');
      expect(idleImage.className).toContain('grayscale');
      cleanup();

      const running = render(<VendorIcon vendor="acp" iconDataUrl={url} running />).container;
      const runningImage = running.querySelector<HTMLImageElement>('img[data-plugin-icon="original"]')!;
      expect(runningImage.getAttribute('src')).toBe(url);
      expect(runningImage.className).not.toContain('grayscale');
      expect(running.firstElementChild!.className).toContain('session-status-breathing');
      cleanup();
    }
  });

  it('keeps Thinking Orange on the generic fallback puzzle while running without a plugin icon', () => {
    const running = render(<VendorIcon vendor="acp" running />).container;
    expect(running.querySelector('svg')).not.toBeNull();
    expect(running.firstElementChild!.className).toContain('text-[var(--warning-accent)]');
    expect(running.firstElementChild!.className).toContain('session-status-breathing');
  });
});

function remoteEngine(key: string, name: string, iconDataUrl?: string): PluginEngineView {
  return {
    key,
    providerId: `acp-plugin:${key}`,
    ghostId: key.split(':')[0]!,
    harnessId: key.split(':')[1]!,
    name,
    ...(iconDataUrl ? { iconDataUrl } : {}),
    availability: { state: 'available' },
    models: [],
    permissionModes: [{ id: 'ask', displayName: 'Ask' }],
    defaultPermissionMode: 'ask',
  };
}

function acpSession(overrides: Partial<Session>): Session {
  return {
    id: 's1',
    agentKind: 'acp',
    providerId: 'acp-plugin:dsh-plugin:dsh',
    status: 'active',
    ...overrides,
  } as Session;
}

describe('remote plugin engine icons in sidebar SessionStatusIcon', () => {
  it('shares one remote catalogue read across multiple sidebar rows and switches from puzzle to plugin icon', async () => {
    const before = getDataOwnerGeneration();
    const icon = 'data:image/png;base64,remote-whale';
    const invoke = vi.fn(async () => [remoteEngine('dsh-plugin:dsh', 'DeepSeek Harness', icon)]);
    vi.stubGlobal('electronAPI', { deviceLink: { invoke } });
    setDataOwnerGeneration('acct-1');
    try {
      const view = render(
        <>
          <SessionStatusIcon
            session={acpSession({ id: 's1', deviceLinkDeviceId: 'device-a', deviceLinkConnectionStatus: 'connected' })}
            isRunning
            isAttached={false}
            hasAttentionNotification={false}
            isActive={false}
          />
          <SessionStatusIcon
            session={acpSession({ id: 's2', deviceLinkDeviceId: 'device-a', deviceLinkConnectionStatus: 'connected' })}
            isRunning
            isAttached={false}
            hasAttentionNotification={false}
            isActive={false}
          />
        </>,
      );

      await waitFor(() => {
        const imgs = view.container.querySelectorAll<HTMLImageElement>('img[data-plugin-icon="original"]');
        expect(imgs).toHaveLength(2);
        expect(imgs[0].getAttribute('src')).toBe(icon);
        expect(imgs[1].getAttribute('src')).toBe(icon);
      });
      expect(invoke.mock.calls).toEqual([['device-a', PLUGIN_ENGINES_INVOKE.LIST, []]]);
      expect(view.getAllByTitle('DeepSeek Harness')).toHaveLength(2);
    } finally {
      setDataOwnerGeneration(before.dataOwnerId, before.generation);
    }
  });

  it('skips remote reads while disconnected and loads once the computer connects or reconnects', async () => {
    const before = getDataOwnerGeneration();
    const icon = 'data:image/png;base64,reconnected-icon';
    const invoke = vi.fn(async () => [remoteEngine('dsh-plugin:dsh', 'DeepSeek Harness', icon)]);
    vi.stubGlobal('electronAPI', { deviceLink: { invoke } });
    setDataOwnerGeneration('acct-1');
    try {
      const view = render(
        <SessionStatusIcon
          session={acpSession({ deviceLinkDeviceId: 'device-a', deviceLinkConnectionStatus: 'disconnected' })}
          isRunning
          isAttached={false}
          hasAttentionNotification={false}
          isActive={false}
        />,
      );
      expect(invoke).not.toHaveBeenCalled();
      expect(view.container.querySelector('svg')).not.toBeNull();

      view.rerender(
        <SessionStatusIcon
          session={acpSession({ deviceLinkDeviceId: 'device-a', deviceLinkConnectionStatus: 'connected' })}
          isRunning
          isAttached={false}
          hasAttentionNotification={false}
          isActive={false}
        />,
      );
      await waitFor(() => {
        expect(view.container.querySelector('img[data-plugin-icon="original"]')?.getAttribute('src')).toBe(icon);
      });
      expect(invoke).toHaveBeenCalledTimes(1);

      // Transient disconnect retains the cached icon, then reconnect prefetch refreshes it.
      const updatedIcon = 'data:image/png;base64,refreshed-icon';
      invoke.mockResolvedValueOnce([remoteEngine('dsh-plugin:dsh', 'DeepSeek Harness', updatedIcon)]);
      markRemotePluginEnginesStale('device-a');
      expect(view.container.querySelector('img[data-plugin-icon="original"]')?.getAttribute('src')).toBe(icon);
      await act(async () => {
        await prefetchRemotePluginEngines('device-a');
      });
      expect(view.container.querySelector('img[data-plugin-icon="original"]')?.getAttribute('src')).toBe(updatedIcon);
      expect(invoke).toHaveBeenCalledTimes(2);
    } finally {
      setDataOwnerGeneration(before.dataOwnerId, before.generation);
    }
  });

  it('probes an uninstalled remote plugin once without repeating on remount, and clears on eviction', async () => {
    const before = getDataOwnerGeneration();
    let resolveInFlight!: (value: PluginEngineView[]) => void;
    const invoke = vi.fn()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => new Promise<PluginEngineView[]>((resolve) => { resolveInFlight = resolve; }));
    vi.stubGlobal('electronAPI', { deviceLink: { invoke } });
    setDataOwnerGeneration('acct-1');
    try {
      const first = render(
        <SessionStatusIcon
          session={acpSession({ deviceLinkDeviceId: 'device-a', deviceLinkConnectionStatus: 'connected' })}
          isRunning={false}
          isAttached={false}
          hasAttentionNotification={false}
          isActive={false}
        />,
      );
      await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
      first.unmount();

      // Remounting a row for the same missing provider does not re-invoke the remote computer.
      const second = render(
        <SessionStatusIcon
          session={acpSession({ id: 's2', deviceLinkDeviceId: 'device-a', deviceLinkConnectionStatus: 'connected' })}
          isRunning={false}
          isAttached={false}
          hasAttentionNotification={false}
          isActive={false}
        />,
      );
      expect(invoke).toHaveBeenCalledTimes(1);
      second.unmount();

      // Eviction discards an in-flight reply so a revoked device cannot repopulate the cache.
      markRemotePluginEnginesStale('device-a');
      const inflight = prefetchRemotePluginEngines('device-a');
      await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
      evictRemotePluginEngines('device-a');
      resolveInFlight([remoteEngine('dsh-plugin:dsh', 'DeepSeek Harness', 'data:image/png;base64,late')]);
      await inflight;

      const third = render(
        <SessionStatusIcon
          session={acpSession({ id: 's3', deviceLinkDeviceId: 'device-a', deviceLinkConnectionStatus: 'disconnected' })}
          isRunning={false}
          isAttached={false}
          hasAttentionNotification={false}
          isActive={false}
        />,
      );
      expect(third.container.querySelector('img')).toBeNull();
    } finally {
      setDataOwnerGeneration(before.dataOwnerId, before.generation);
    }
  });

  it('uses the local engine list when a remote task runs its plugin engine on this computer, and stays fail-closed for shared tasks', async () => {
    const before = getDataOwnerGeneration();
    const localIcon = 'data:image/png;base64,local-engine-icon';
    const invoke = vi.fn(async () => []);
    const listPluginEngines = vi.fn(async () => [remoteEngine('dsh-plugin:dsh', 'Local DSH', localIcon)]);
    vi.stubGlobal('electronAPI', {
      deviceLink: { invoke },
      maker: { listPluginEngines, onPluginEnginesChanged: () => () => {} },
    });
    setDataOwnerGeneration('acct-1');
    try {
      const ownEngine = render(
        <SessionStatusIcon
          session={acpSession({
            deviceLinkDeviceId: 'device-a',
            deviceLinkConnectionStatus: 'connected',
            agentDeviceId: 'device-self',
          })}
          isRunning
          isAttached={false}
          hasAttentionNotification={false}
          isActive={false}
        />,
      );
      await waitFor(() => {
        expect(ownEngine.container.querySelector('img[data-plugin-icon="original"]')?.getAttribute('src')).toBe(localIcon);
      });
      expect(invoke).not.toHaveBeenCalled();
      ownEngine.unmount();

      // A shared task peer must neither call maker:list-plugin-engines nor borrow this computer's local plugin icon.
      const shared = render(
        <SessionStatusIcon
          session={acpSession({
            id: 's-shared',
            deviceLinkDeviceId: sharedTaskHostPeer('share-1', 'host-device-1'),
            deviceLinkConnectionStatus: 'connected',
          })}
          isRunning
          isAttached={false}
          hasAttentionNotification={false}
          isActive={false}
        />,
      );
      expect(invoke).not.toHaveBeenCalled();
      expect(shared.container.querySelector('img')).toBeNull();
      expect(shared.container.querySelector('svg')).not.toBeNull();
    } finally {
      setDataOwnerGeneration(before.dataOwnerId, before.generation);
    }
  });
});
