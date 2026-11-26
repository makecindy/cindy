// @vitest-environment jsdom
/**
 * RemoteProviderTopology 组件单测。
 * 规则依据：
 * - 用户明确要求：对端主机图标与设备连接拓扑共用一套（.rcv2-tile + PlatformGlyph / ShareAvatar）；
 * - 用户明确要求：展开任务束后点击任务行直接跳转到对应会话，且行内不显示冗余“跳转”文案；
 * - 同账号在线机器弹出层可复用现有线路偏好切换（auto / direct / relay）。
 * 覆盖缺口：新组件 RemoteProviderTopology，此前无渲染与交互覆盖。
 * 最小失败输入：1 台承载 3 个任务的同账号机器 + 1 个跨账号分享任务。
 * tier:unit(jsdom 组件)。实测耗时：<1s。
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  const { default: zh } = await import('../../../i18n/locales/zh-CN/common.json');
  function lookup(path: string): string {
    const parts = path.split('.');
    let cur: unknown = zh;
    for (const part of parts) {
      if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[part];
      } else {
        return path;
      }
    }
    return typeof cur === 'string' ? cur : path;
  }
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) => {
        let s = lookup(key);
        if (opts) {
          for (const [k, v] of Object.entries(opts)) {
            s = s.replaceAll(`{{${k}}}`, String(v));
          }
        }
        return s;
      },
    }),
  };
});

import type { ProviderShareReceived } from '@cindy/device-link';
import type { Session } from '@/lib/ccAgent.types';
import { buildProviderTopology } from '../providerTopologyModel';
import { RemoteProviderTopology } from '../RemoteProviderTopology';

afterEach(() => {
  cleanup();
});

function makeSession(partial: Partial<Session> & { id: string }): Session {
  return {
    userId: 'u-self',
    title: partial.title ?? partial.id,
    workingDir: null,
    workspaceKind: 'dialogue',
    model: partial.model ?? 'Claude Opus 4.6',
    effort: 'medium',
    permissionMode: 'default',
    providerId: 'claude-code',
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindow: 200_000,
    fastMode: false,
    clearedAt: null,
    pinnedAt: null,
    userSendAt: partial.userSendAt ?? '2026-11-26T01:00:00Z',
    status: 'active',
    agentKind: 'cc',
    createdAt: '2026-11-26T00:00:00Z',
    updatedAt: partial.updatedAt ?? '2026-11-26T01:00:00Z',
    agentDeviceId: partial.agentDeviceId ?? null,
    deviceLinkDeviceId: null,
    ...partial,
  } as Session;
}

function buildFixtureModel() {
  const sessions: Session[] = [
    makeSession({ id: 'sess-1', title: '重构支付结算核心状态机', agentDeviceId: 'dev-mac', model: 'Claude Opus 4.6' }),
    makeSession({ id: 'sess-2', title: 'Orca 多 Worker 并发调度', agentDeviceId: 'dev-mac', model: 'Claude Sonnet 4.6' }),
    makeSession({ id: 'sess-3', title: '桌面端深色模式 Token 走查', agentDeviceId: 'dev-mac', model: 'Claude Sonnet 4.6' }),
    makeSession({ id: 'sess-share', title: '跨账号协议兼容检查', agentDeviceId: 'share:sh-1', model: 'Claude Opus 4.6' }),
  ];

  const devices: DeviceLinkDeviceView[] = [
    {
      deviceId: 'dev-mac',
      name: 'Mac Studio',
      platform: 'darwin',
      appVersion: '1.0.0',
      lastSeenAt: null,
      online: true,
      busy: true,
      remoteControlEnabled: true,
      controlEnabled: true,
      isSelf: false,
    },
  ];

  const receivedShares: ProviderShareReceived[] = [
    {
      shareId: 'sh-1',
      memberId: 'mem-1',
      providerId: 'claude-code',
      providerLabel: 'Claude Code',
      hostDeviceId: 'hidden-host-id',
      owner: { displayName: 'Chris', avatarUrl: null, region: 'cn' },
      deviceName: 'HIDDEN-HOST',
      status: 'active',
      hostOnline: true,
      hostCapable: true,
    },
  ];

  const peerLinks: DeviceLinkPeerLinksSnapshot = {
    links: [
      { deviceId: 'dev-mac', open: true, path: 'direct', rttMs: 4, sentAgoMs: 500, receivedAgoMs: 200 },
    ],
    agentNetRoutes: [
      { deviceId: 'dev-mac', path: 'direct', rttMs: 4, directRttMs: 4, relayRttMs: 18, pathPreference: 'auto' },
    ],
    providerShareRoutes: [
      {
        shareId: 'sh-1',
        path: 'relay',
        rttMs: 28,
        sentAgoMs: null,
        receivedAgoMs: null,
        relayKind: 'official',
        relayHost: null,
        relayTransport: 'udp',
        relayRttMs: 16,
        region: 'cn-east',
      },
    ],
    relayRttMs: 16,
    relayProtocol: 'agent-net',
    relayTransport: 'udp',
  };

  return buildProviderTopology({
    sessions,
    runningSessionIds: new Set(['sess-1', 'sess-2', 'sess-3', 'sess-share']),
    devices,
    peerLinks,
    localGroups: {},
    receivedShares,
    shareDisplayNames: new Map([['sh-1', '来自 Chris 的分享']]),
    primaryRelayName: 'Cindy 中转',
    primarySelfHosted: false,
    officialRelayLabel: 'Cindy 中转',
    unresponsiveIds: new Set(),
    scope: 'running',
    query: '',
  });
}

describe('RemoteProviderTopology', () => {
  it('reuses .rcv2-tile + PlatformGlyph on own hosts and opens jumpable task list without redundant jump text', () => {
    const model = buildFixtureModel();
    const onOpenTask = vi.fn();

    const { container } = render(
      <RemoteProviderTopology
        model={model}
        onOpenTask={onOpenTask}
      />,
    );

    // Same-account machine tile reuses .rcv2-tile with live state and orange busy indicator
    const liveTile = container.querySelector('.rcv2-tile[data-live="true"]');
    expect(liveTile).not.toBeNull();
    expect(liveTile?.querySelector('svg')).not.toBeNull();
    expect(liveTile?.querySelector('.rcv2-busy')).not.toBeNull();

    // Cross-account share never leaks raw hostname, uses sharer initial ('C' for Chris, not '来'), and shows machine badge
    expect(container.textContent).not.toContain('HIDDEN-HOST');
    const shareBadge = container.querySelector('.rcv2-prov-host-badge');
    expect(shareBadge).not.toBeNull();
    expect(shareBadge?.parentElement?.textContent?.trim()).toBe('C');

    // Click the Task Bundle card (>= 3 running tasks on Mac Studio) to expand task popover
    const bundleButton = screen.getByRole('button', { name: /3 个运行中/ });
    fireEvent.click(bundleButton);

    // Popover shows all 3 tasks cleanly without "跳转 ↗" label text
    const taskRows = Array.from(document.querySelectorAll<HTMLButtonElement>('.rcv2-prov-task-row'));
    expect(taskRows).toHaveLength(3);
    const targetRow = taskRows.find((el) => el.textContent?.includes('重构支付结算核心状态机'));
    expect(targetRow).toBeDefined();
    expect(targetRow?.textContent).not.toContain('跳转');

    // Clicking a task row navigates to that exact task
    fireEvent.click(targetRow!);
    expect(onOpenTask).toHaveBeenCalledTimes(1);
    expect(onOpenTask.mock.calls[0][0].id).toBe('sess-1');
  });

  it('jumps directly when clicking a single task card and allows switching path preference in machine popover', async () => {
    const model = buildFixtureModel();
    const onOpenTask = vi.fn();
    const onPathPreferenceChange = vi.fn().mockResolvedValue(true);

    render(
      <RemoteProviderTopology
        model={model}
        onOpenTask={onOpenTask}
        onPathPreferenceChange={onPathPreferenceChange}
      />,
    );

    // Single task card on cross-account share jumps directly on click
    const singleTaskBtn = screen.getByRole('button', { name: /跨账号协议兼容检查/ });
    fireEvent.click(singleTaskBtn);
    expect(onOpenTask).toHaveBeenCalledTimes(1);
    expect(onOpenTask.mock.calls[0][0].id).toBe('sess-share');

    // Open Mac Studio machine popover, check auto-route rule info button, and switch path preference to relay
    const macCard = screen.getByRole('button', { name: /Mac Studio/ });
    fireEvent.click(macCard);
    const infoBtn = screen.getByRole('button', { name: '自动选路规则' });
    fireEvent.click(infoBtn);
    expect(screen.getByText(/25–50 ms/)).not.toBeNull();
    const relayOption = screen.getByRole('radio', { name: '中转' });
    await act(async () => {
      fireEvent.click(relayOption);
    });
    expect(onPathPreferenceChange).toHaveBeenCalledWith('dev-mac', 'relay');
  });
});
