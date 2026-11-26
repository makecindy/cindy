// @vitest-environment node
/**
 * Agent-Net「远程供应商」三栏拓扑的纯状态推导与零重叠几何单测。
 * 规则依据：
 * - docs/dev-rules/protocol-compatibility/provider-sharing-hidden-computer-names.md（跨账号分享绝不展示分享者电脑名）；
 * - docs/product-rules/provider-groups.md（本机供应商组将组内活跃成员聚拢框起、其余成员折叠）；
 * - 本任务确认设计：>=3 任务自动收束为任务束、区分为直连/自建中转/官方中转/分享方自建中转、节点与中转无重叠。
 * 覆盖缺口：新模块 providerTopologyModel，此前无测试覆盖。
 * 最小失败输入：含同账号直连/中转机、跨账号分享、本机供应商组、3+ 任务的混合快照。
 * tier:unit。实测耗时：<1s。
 */

import type { ProviderShareReceived } from '@cindy/device-link';
import { describe, expect, it } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';
import type { ProviderGroupConfig } from '../../../../shared/providerGroup';
import {
  TASK_BUNDLE_THRESHOLD,
  buildProviderTopology,
  layoutProviderTopology,
} from '../providerTopologyModel';

function makeSession(partial: Partial<Session> & { id: string }): Session {
  return {
    userId: 'u-self',
    title: partial.title ?? partial.id,
    workingDir: null,
    workspaceKind: 'dialogue',
    model: partial.model ?? 'claude-opus-4-6',
    effort: 'medium',
    permissionMode: 'default',
    providerId: partial.providerId ?? 'claude-code',
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindow: 200_000,
    fastMode: false,
    clearedAt: null,
    pinnedAt: null,
    userSendAt: partial.userSendAt ?? '2026-11-26T01:00:00.000Z',
    status: partial.status ?? 'active',
    agentKind: 'cc',
    createdAt: '2026-11-26T00:00:00.000Z',
    updatedAt: partial.updatedAt ?? '2026-11-26T01:00:00.000Z',
    agentDeviceId: partial.agentDeviceId ?? null,
    deviceLinkDeviceId: partial.deviceLinkDeviceId ?? null,
    ...partial,
  } as Session;
}

function makeDevice(partial: Partial<DeviceLinkDeviceView> & { deviceId: string }): DeviceLinkDeviceView {
  return {
    name: partial.name ?? partial.deviceId,
    platform: partial.platform ?? 'darwin',
    appVersion: '1.0.0',
    lastSeenAt: null,
    online: partial.online ?? true,
    busy: partial.busy ?? false,
    remoteControlEnabled: partial.remoteControlEnabled ?? true,
    controlEnabled: true,
    isSelf: partial.isSelf ?? false,
    ...partial,
  };
}

function makeShare(partial: Partial<ProviderShareReceived> & { shareId: string }): ProviderShareReceived {
  return {
    memberId: `mem-${partial.shareId}`,
    providerId: partial.providerId ?? 'claude-code',
    providerLabel: partial.providerLabel ?? 'Claude Code',
    hostDeviceId: 'hidden-host-id',
    owner: partial.owner ?? { displayName: 'Chris', avatarUrl: null, region: 'cn' },
    deviceName: 'CHRIS-SECRET-MACBOOK-PRO',
    status: partial.status ?? 'active',
    hostOnline: partial.hostOnline ?? true,
    hostCapable: true,
    ...partial,
  };
}

function makePeerLinks(partial: Partial<DeviceLinkPeerLinksSnapshot> = {}): DeviceLinkPeerLinksSnapshot {
  return {
    links: [],
    agentNetRoutes: [],
    providerShareRoutes: [],
    relayRttMs: 14,
    relayProtocol: 'agent-net',
    relayTransport: 'udp',
    ...partial,
  };
}

describe('buildProviderTopology', () => {
  it('groups own machines, local provider groups, and cross-account shares without leaking sharer hostname', () => {
    const share = makeShare({
      shareId: 'sh-1',
      owner: { displayName: 'Chris', avatarUrl: 'https://example.com/a.png', region: 'cn' },
      deviceName: 'TOP-SECRET-HOST-NAME',
    });

    const localGroups: Record<string, ProviderGroupConfig> = {
      'claude-code': {
        strategy: 'order',
        autoSwitch: true,
        members: [
          { key: 'own:mac', kind: 'device', agentDeviceId: 'dev-mac', providerId: 'claude-code', label: 'Mac Studio', limit: 4, weight: 1, paused: false },
          { key: 'own:tokyo', kind: 'device', agentDeviceId: 'dev-tokyo', providerId: 'claude-code', label: 'Tokyo Cloud', limit: 4, weight: 1, paused: false },
          { key: 'own:idle', kind: 'device', agentDeviceId: 'dev-idle', providerId: 'claude-code', label: 'Office PC', limit: 4, weight: 1, paused: false },
        ],
      },
    };

    const sessions: Session[] = [
      // 3 tasks on dev-mac (should bundle)
      makeSession({ id: 't1', title: 'Payment refactor', agentDeviceId: 'dev-mac', model: 'Claude Opus 4.6' }),
      makeSession({ id: 't2', title: 'Dark mode audit', agentDeviceId: 'dev-mac', model: 'Claude Sonnet 4.6' }),
      makeSession({ id: 't3', title: 'SQL index check', agentDeviceId: 'dev-mac', model: 'Claude Opus 4.6' }),
      // 1 task on dev-tokyo via self-hosted relay
      makeSession({ id: 't4', title: 'Load test script', agentDeviceId: 'dev-tokyo', model: 'GPT-5.3-Codex' }),
      // 1 task on cross-account share via sharer's self-hosted relay
      makeSession({ id: 't5', title: 'Protocol check', agentDeviceId: 'share:sh-1', model: 'Claude Opus 4.6' }),
      // Local-only session and archived session must be excluded
      makeSession({ id: 't-local', title: 'Local task', agentDeviceId: null }),
      makeSession({ id: 't-archived', title: 'Old task', agentDeviceId: 'dev-mac', status: 'archived' }),
    ];

    const devices: DeviceLinkDeviceView[] = [
      makeDevice({ deviceId: 'self-pc', name: 'My Laptop', isSelf: true }),
      makeDevice({ deviceId: 'dev-mac', name: 'Mac Studio', platform: 'darwin', busy: true }),
      makeDevice({ deviceId: 'dev-tokyo', name: 'Tokyo Cloud', platform: 'linux', busy: true }),
      makeDevice({ deviceId: 'dev-idle', name: 'Office PC', platform: 'win32', online: true }),
      makeDevice({ deviceId: 'dev-standby', name: 'Standby Mini', platform: 'darwin', online: true }),
    ];

    const peerLinks = makePeerLinks({
      links: [
        { deviceId: 'dev-mac', open: true, path: 'direct', rttMs: 4, sentAgoMs: 500, receivedAgoMs: 200 },
        { deviceId: 'dev-tokyo', open: true, path: 'relay', rttMs: 26, sentAgoMs: 800, receivedAgoMs: 300 },
      ],
      agentNetRoutes: [
        { deviceId: 'dev-mac', path: 'direct', rttMs: 4, directRttMs: 4, relayRttMs: 18, pathPreference: 'auto' },
        { deviceId: 'dev-tokyo', path: 'relay', rttMs: 26, directRttMs: null, relayRttMs: 26, pathPreference: 'auto' },
      ],
      providerShareRoutes: [
        {
          shareId: 'sh-1',
          path: 'relay',
          rttMs: 29,
          sentAgoMs: null,
          receivedAgoMs: null,
          relayKind: 'sharer-relay',
          relayHost: 'chris-relay.example',
          relayTransport: 'udp',
          relayRttMs: 17,
          region: 'sg',
        },
      ],
    });

    const shareDisplayNames = new Map<string, string>([['sh-1', '来自 Chris 的分享']]);

    const model = buildProviderTopology({
      sessions,
      runningSessionIds: new Set(['t1', 't4']),
      devices,
      peerLinks,
      localGroups,
      receivedShares: [share],
      shareDisplayNames,
      primaryRelayName: 'hk-edge-01',
      primarySelfHosted: true,
      officialRelayLabel: 'Cindy 中转',
      unresponsiveIds: new Set(),
      scope: 'all',
      query: '',
    });

    expect(model.unfilteredTaskCount).toBe(5);
    expect(model.unfilteredRunningCount).toBe(2);
    expect(model.machines).toHaveLength(3);

    // Privacy invariant: sharer's raw deviceName must never appear in the model
    const shareMachine = model.machines.find((m) => m.kind === 'share');
    expect(shareMachine?.name).toBe('来自 Chris 的分享');
    expect(JSON.stringify(model)).not.toContain('TOP-SECRET-HOST-NAME');

    // Relay differentiation: self-hosted relay for Tokyo + sharer-relay for sh-1
    expect(model.relays.map((r) => r.kind).sort()).toEqual(['self-hosted', 'sharer-relay']);
    expect(model.relays.find((r) => r.kind === 'self-hosted')?.name).toBe('hk-edge-01');
    expect(model.relays.find((r) => r.kind === 'sharer-relay')?.name).toBe('chris-relay.example');

    // Provider group block wraps dev-mac + dev-tokyo and folds dev-idle into idleMembers
    const groupBlock = model.blocks.find((b) => b.kind === 'group');
    expect(groupBlock?.kind).toBe('group');
    if (groupBlock?.kind === 'group') {
      expect(groupBlock.machines.map((m) => m.targetId).sort()).toEqual(['dev-mac', 'dev-tokyo']);
      expect(groupBlock.idleMembers.map((m) => m.name)).toEqual(['Office PC']);
    }

    // Standalone online machine with 0 tasks goes to idleProviders (not group member dev-idle)
    expect(model.idleProviders.map((p) => p.name)).toEqual(['Standby Mini']);

    // Layout geometry: dev-mac (>=3 tasks) uses bundle; dev-tokyo (1 task) uses single task box; no overlapping cards
    const layout = layoutProviderTopology(model, 820, new Set());
    const macLayout = layout.machines.find((ml) => ml.machine.targetId === 'dev-mac')!;
    const tokyoLayout = layout.machines.find((ml) => ml.machine.targetId === 'dev-tokyo')!;
    expect(macLayout.machine.visibleTasks.length).toBeGreaterThanOrEqual(TASK_BUNDLE_THRESHOLD);
    expect(macLayout.useBundle).toBe(true);
    expect(tokyoLayout.useBundle).toBe(false);
    expect(tokyoLayout.taskBoxes).toHaveLength(1);

    // Relay nodes must not vertically overlap each other
    const sortedRelays = [...layout.relays].sort((a, b) => a.top - b.top);
    for (let i = 1; i < sortedRelays.length; i += 1) {
      expect(sortedRelays[i].top).toBeGreaterThanOrEqual(sortedRelays[i - 1].top + sortedRelays[i - 1].h);
    }

    // Machine cards must not vertically overlap each other
    const sortedMachines = [...layout.machines].sort((a, b) => a.machTop - b.machTop);
    for (let i = 1; i < sortedMachines.length; i += 1) {
      expect(sortedMachines[i].machTop).toBeGreaterThanOrEqual(
        sortedMachines[i - 1].machTop + sortedMachines[i - 1].machH,
      );
    }
  });

  it('filters by running scope and matches search query across task title, machine name, and relay name', () => {
    const sessions: Session[] = [
      makeSession({ id: 't1', title: 'Alpha build', agentDeviceId: 'dev-a' }),
      makeSession({ id: 't2', title: 'Beta idle', agentDeviceId: 'dev-a' }),
      makeSession({ id: 't3', title: 'Gamma check', agentDeviceId: 'dev-b' }),
    ];
    const devices = [
      makeDevice({ deviceId: 'dev-a', name: 'Studio A' }),
      makeDevice({ deviceId: 'dev-b', name: 'Worker B' }),
    ];
    const peerLinks = makePeerLinks({
      agentNetRoutes: [
        { deviceId: 'dev-a', path: 'direct', rttMs: 5, directRttMs: 5, relayRttMs: 20, pathPreference: 'auto' },
        { deviceId: 'dev-b', path: 'relay', rttMs: 30, directRttMs: null, relayRttMs: 30, pathPreference: 'auto' },
      ],
    });

    const runningOnly = buildProviderTopology({
      sessions,
      runningSessionIds: new Set(['t1']),
      devices,
      peerLinks,
      localGroups: {},
      receivedShares: [],
      shareDisplayNames: new Map(),
      primaryRelayName: 'tokyo-relay',
      primarySelfHosted: true,
      officialRelayLabel: 'Cindy 中转',
      unresponsiveIds: new Set(),
      scope: 'running',
      query: '',
    });
    expect(runningOnly.machines).toHaveLength(1);
    expect(runningOnly.machines[0].targetId).toBe('dev-a');
    expect(runningOnly.machines[0].visibleTasks.map((t) => t.id)).toEqual(['t1']);

    // Search by relay name matches dev-b
    const byRelay = buildProviderTopology({
      sessions,
      runningSessionIds: new Set(['t1']),
      devices,
      peerLinks,
      localGroups: {},
      receivedShares: [],
      shareDisplayNames: new Map(),
      primaryRelayName: 'tokyo-relay',
      primarySelfHosted: true,
      officialRelayLabel: 'Cindy 中转',
      unresponsiveIds: new Set(),
      scope: 'all',
      query: 'tokyo-relay',
    });
    expect(byRelay.machines.map((m) => m.targetId)).toEqual(['dev-b']);
  });
});
