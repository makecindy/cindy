// @vitest-environment jsdom
/**
 * 拓扑卡片只展示连接信息(用户裁决 2026-11-07:拓扑图只管拓扑,改名、开关、删除留在「我的设备」)。
 * 规则:所有卡片都不放开关、删除或「管理设备…」;本机设置已在同一页上方。
 * 远程桌面只给在线、能被控、两边都允许控制的电脑;忙碌的状态字是心动橙。改坏了拓扑卡片会重新长出配置,
 * 或者重新长出同页重复的管理入口(用户反馈 2026-11-12)。
 * 覆盖缺口:旧用例要求本机卡片提供管理按钮。最小失败输入:有本机连接信息的 HubNodePopover。
 * tier:unit(jsdom 组件)。实测耗时见本 PR 验证记录。
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async () => {
  const { default: common } = await import('../../../i18n/locales/en/common.json');
  return {
    useTranslation: () => ({
      t: (key: string, options?: { value?: number; version?: string }) => {
        if (key === 'settings.remoteControl.v2.ms') return `${options?.value} ms`;
        if (key === 'settings.devices.apps.cindy') return common.settings.devices.apps.cindy;
        if (key === 'settings.devices.apps.cindyFriend') return common.settings.devices.apps.cindyFriend;
        if (key === 'settings.remoteControl.v2.popover.version') {
          return common.settings.remoteControl.v2.popover.version.replace('{{version}}', options?.version ?? '');
        }
        return key;
      },
    }),
  };
});

import { DeviceNodePopover, HubNodePopover } from '../DeviceNodePopover';
import { RemoteSwitchBatch } from '../RemoteSwitchBatch';
import { isNonDevAppVersion, peerUpdateStore, startPeerUpdate } from '../peerAppUpdate';
import type { TopologyModel, TopologyNode } from '../topologyModel';

function node(partial: Partial<TopologyNode> = {}): TopologyNode {
  return {
    id: 'win',
    name: 'Work PC',
    platform: 'win32',
    modelLabel: null,
    isMobile: false,
    status: 'direct',
    path: 'direct',
    controlLinkOpen: true,
    rttMs: 3,
    flow: null,
    flowText: null,
    busy: false,
    lastSeenAt: null,
    controlling: false,
    attention: null,
    remoteControlEnabled: true,
    controlEnabled: true,
    appVersion: null,
    ...partial,
  };
}

const remoteDesktop = () => screen.queryByRole('button', { name: 'remoteDesktop.title' });

// Non-Cindy Apps on desktop platforms must not be probed as outdated Cindy or
// offered remote desktop. The real locale also exposes the fixed Cindy version
// brand that a key-only translation stub missed. Minimal input: App + version. Unit.
it.each(['cindy-friend', 'other-app'])('labels app=%s and excludes it from card and batch computer actions', app => {
  const command = vi.fn();
  vi.stubGlobal('electronAPI', { selfHostedRelay: { command } });
  const peer = node({ id: app, app, appVersion: '1.4.0', encrypted: true });
  render(<><DeviceNodePopover node={peer} relayName="Cindy" onRemoteDesktop={vi.fn()} onSwitch={vi.fn()} />
    <RemoteSwitchBatch nodes={[peer]} entries={new Map()} /></>);
  const appName = app === 'cindy-friend' ? 'Cindy Friend' : app;
  expect(screen.getByText(`${appName} · Work PC`)).toBeTruthy();
  expect(screen.getByText(`Windows · ${appName} 1.4.0`)).toBeTruthy();
  expect(remoteDesktop()).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  expect(command).not.toHaveBeenCalled();
});

// App version routing must preserve both legacy omission and explicit Cindy.
it.each([undefined, 'cindy'])('keeps the Cindy version label for app=%s', app => {
  render(<DeviceNodePopover node={node({ id: `version-${app ?? 'legacy'}`, app, appVersion: '1.4.0', remoteControlEnabled: false })}
    relayName="Cindy" onRemoteDesktop={vi.fn()} />);
  expect(screen.getByText('Work PC')).toBeTruthy();
  expect(screen.getByText('Windows · Cindy 1.4.0')).toBeTruthy();
});

afterEach(() => { cleanup(); peerUpdateStore.resetForTest(); vi.unstubAllGlobals(); vi.useRealTimers(); });

// 2026-11-12 用户裁决：单台与批量入口都须保留目标的仅加密选择。真实组件+状态探测，tier:unit。
it.each([
  ['strict-card', true, null, null, 'encryptionRequired'],
  ['strict-controller-card', false, 'ENCRYPTION_REQUIRED', null, 'disableBlocked.controller-encryption-required'],
  ['v2-relay-card', false, null, 'V2_ONLY_RELAY', 'disableBlocked.agent-net-only-relay'],
] as const)('explains why %s cannot switch back from its device card', async (id, onlyEncrypted, controllerBlock, disableBlocked, key) => {
  const command = vi.fn(async () => ({ state: {}, peer: { ok: true, controllerBlock, result: { enabled: true, onlyEncrypted, disableBlocked, blocked: null } } }));
  vi.stubGlobal('electronAPI', { selfHostedRelay: { command } });
  render(<DeviceNodePopover node={node({ id, encrypted: true })} relayName="Cindy" onRemoteDesktop={vi.fn()} onSwitch={vi.fn()} />);
  expect(await screen.findByText('settings.remoteControl.v2.peerSwitch.' + key)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'settings.remoteControl.v2.peerSwitch.toDeviceLink' })).toBeNull();
});

it('probes switch-back candidates and excludes the strict target before choosing the canary', async () => {
  vi.useFakeTimers();
  let disabled = false;
  const command = vi.fn(async (input: { deviceId: string; request: { action: string } }) => {
    if (input.request.action === 'set') disabled = true;
    return { state: {}, peer: { ok: true, result: { enabled: !disabled, encrypted: !disabled, onlyEncrypted: input.deviceId === 'strict-batch', blocked: null, confirmWithinMs: null } } };
  });
  vi.stubGlobal('electronAPI', { selfHostedRelay: { command } });
  render(<RemoteSwitchBatch nodes={[node({ id: 'strict-batch', encrypted: true }), node({ id: 'allowed-batch', encrypted: true })]} entries={new Map()} />);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'settings.remoteControl.v2.peerSwitch.batch.toDeviceLink' })));
  expect(screen.getByText('settings.remoteControl.v2.peerSwitch.batch.skipReason.encryption-required')).toBeTruthy();
  expect(screen.getAllByText('settings.remoteControl.v2.peerSwitch.batch.ready')).toHaveLength(1);
  expect(command.mock.calls.map(([input]) => input.request.action)).toEqual(['status', 'status']);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'settings.remoteControl.v2.peerSwitch.batch.run' })));
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(command.mock.calls.filter(([input]) => input.request.action === 'set').map(([input]) => input.deviceId)).toEqual(['allowed-batch']);
  expect(screen.getByText('settings.remoteControl.v2.peerSwitch.batch.state.done')).toBeTruthy();
});

// #10095 discussion_r4546067865：最后一台候选进入切换状态后，已打开的进度浮层仍须保留。
// 真实组件入口；现有设备卡片用例未覆盖批量浮层。最小输入：一台候选变成 running。tier:unit。
it('keeps the open batch panel mounted when its last candidate starts switching', async () => {
  const n = node({ id: 'batch-progress', encrypted: false });
  const view = render(<RemoteSwitchBatch nodes={[n]} entries={new Map()} />);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'settings.remoteControl.v2.peerSwitch.batch.toAgentNet' })));
  expect(screen.getByText('settings.remoteControl.v2.peerSwitch.batch.confirmTitleAgentNet')).toBeTruthy();
  view.rerender(<RemoteSwitchBatch nodes={[n]} entries={new Map([[n.id, { kind: 'running', target: 'agent-net', step: 'request' }]])} />);
  expect(screen.getByText('settings.remoteControl.v2.peerSwitch.batch.confirmTitleAgentNet')).toBeTruthy();
});

describe('DeviceNodePopover', () => {
  // The UI must distinguish certified V2, legacy relay exposure and an old host's unknown status.
  it.each([[true, 'encrypted'], [false, 'legacyConnection'], [undefined, 'encryptionUnknown']] as const)('shows the actual encryption status %s', (encrypted, key) => {
    render(<DeviceNodePopover node={node({ encrypted })} relayName="Cindy" onRemoteDesktop={vi.fn()} />);
    expect(screen.getByText('settings.remoteControl.v2.popover.' + key)).toBeTruthy();
    // 2026-11-08: route details must identify the actual protocol, not just direct versus relay.
    // 2026-11-19: 同时带上实际底层传输协议（UDP / WebRTC / WS）。
    // 2026-11-22: 协议与底层传输拆成独立的「连接方式」行,避免与长中转名挤在同一行被截断。
    if (encrypted === undefined) {
      expect(screen.getByText('settings.remoteControl.v2.path.direct')).toBeTruthy();
    } else {
      const expectedConnection = `settings.remoteControl.v2.protocol.${encrypted ? 'agentNet' : 'deviceLink'} · settings.remoteControl.v2.${encrypted ? 'relayTransport.udp' : 'linkTransport.webrtc'}`;
      const connRow = screen.getByTitle(expectedConnection);
      expect(connRow.textContent?.replace(/\s/g, '')).toBe(expectedConnection.replace(/\s/g, ''));
      expect(screen.getByText('settings.remoteControl.v2.path.direct')).toBeTruthy();
    }
    expect(!!screen.queryByText('settings.remoteControl.v2.popover.legacyEncryptionHint')).toBe(encrypted === false);
  });
  it('只展示信息:没有开关、没有删除,也没有「管理设备…」', () => {
    render(<DeviceNodePopover node={node()} relayName="Cindy" onRemoteDesktop={vi.fn()} />);
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.remoteControl.v2.popover.manage' })).toBeNull();
  });

  it('远程桌面只给在线、能被控、两边都允许控制的电脑', () => {
    const onRemoteDesktop = vi.fn();
    const n = node();
    const { rerender } = render(<DeviceNodePopover node={n} relayName="Cindy" onRemoteDesktop={onRemoteDesktop} />);
    fireEvent.click(remoteDesktop()!);
    expect(onRemoteDesktop).toHaveBeenCalledWith(n);
    for (const partial of [
      { status: 'offline' as const, path: null },
      { remoteControlEnabled: false },
      { controlEnabled: false },
      { platform: 'ios', isMobile: true },
    ]) {
      rerender(<DeviceNodePopover node={node(partial)} relayName="Cindy" onRemoteDesktop={onRemoteDesktop} />);
      expect(remoteDesktop()).toBeNull();
    }
  });

  // 用户裁决(2026-11-07):没有单独的「需要处理」卡片,有问题的设备点开卡片就能看到原因。
  it('要处理的设备:「状态」用红字写原因,「路径」只写怎么连', () => {
    render(
      <DeviceNodePopover
        node={node({ status: 'attention', attention: 'peer-control-off', remoteControlEnabled: false })}
        relayName="Cindy"
        onRemoteDesktop={vi.fn()}
      />,
    );
    expect(screen.getByText('settings.remoteControl.myDevices.peerControlOff').className).toContain('--error-fg');
    expect(screen.getByText('settings.remoteControl.v2.path.direct')).toBeTruthy();
  });

  it('忙碌的状态字是心动橙,离线时不是', () => {
    const { rerender } = render(
      <DeviceNodePopover node={node({ busy: true })} relayName="Cindy" onRemoteDesktop={vi.fn()} />,
    );
    expect(screen.getByText('settings.devices.status.busy').className).toContain('--warning-accent');
    rerender(
      <DeviceNodePopover node={node({ busy: true, status: 'offline', path: null })} relayName="Cindy" onRemoteDesktop={vi.fn()} />,
    );
    expect(screen.getByText('settings.remoteControl.v2.path.offline').className).not.toContain('--warning-accent');
  });

  // 2026-11-19 用户要求：每台电脑之间的链接显示实际底层传输协议（UDP / WS / WebRTC）。
  // 生产入口:DeviceNodePopover 路径行。覆盖缺口:此前设备卡片路径行只写协议和直连/中转,没有底层传输协议。
  // 最小失败输入:Agent-Net 直连/经中转(UDP/WS)、Device Link 直连(WebRTC)/经中转(WS)与切换重连中。tier: unit。
  it.each([
    ['Agent-Net direct UDP', { encrypted: true, path: 'direct' as const, transport: 'udp' as const }, 'settings.remoteControl.v2.relayTransport.udp'],
    ['Agent-Net relay WS', { encrypted: true, path: 'relay' as const, status: 'relay' as const, transport: 'websocket' as const }, 'settings.remoteControl.v2.relayTransport.websocket'],
    ['Device Link direct WebRTC', { encrypted: false, path: 'direct' as const, transport: 'webrtc' as const }, 'settings.remoteControl.v2.linkTransport.webrtc'],
    ['Device Link relay WS', { encrypted: false, path: 'relay' as const, status: 'relay' as const, transport: 'websocket' as const }, 'settings.remoteControl.v2.relayTransport.websocket'],
  ])('设备卡片路径行显示底层传输协议: %s', (_label, partial, expectedTransport) => {
    render(<DeviceNodePopover node={node(partial)} relayName="Cindy" onRemoteDesktop={vi.fn()} />);
    expect(screen.getByText(`· ${expectedTransport}`)).toBeTruthy();
  });
});

describe('HubNodePopover', () => {
  const model = {
    self: { name: 'Studio Mac', platform: 'darwin' },
    relay: { name: 'Cindy', selfHosted: false, rttMs: 20, flow: null },
  } as unknown as TopologyModel;

  // 2026-11-13 用户要求延迟显示整数。现有卡片测试只传整数，无法发现小数直接显示的回归。
  // 真实设备与中转卡片入口，分别覆盖 186.252 向下和 186.752 向上取整。tier: unit。
  it('rounds peer and relay latency to whole milliseconds', () => {
    render(<>
      <DeviceNodePopover node={node({ rttMs: 186.252 })} relayName="Cindy" onRemoteDesktop={vi.fn()} />
      <HubNodePopover model={{ ...model, relay: { ...model.relay, rttMs: 186.752 } }} linkStatus="online" issue={null} standby={false} />
    </>);
    expect(screen.getByText('186 ms · settings.remoteControl.v2.popover.rttNote')).toBeTruthy();
    expect(screen.getByText('settings.devices.linkStatus.online · 187 ms')).toBeTruthy();
  });

  it('只展示与中转的连接、连接问题与待机说明,不重复提供同页管理入口', () => {
    render(<HubNodePopover model={model} linkStatus="online" issue="连接已失效" standby />);
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(screen.getByText('连接已失效')).toBeTruthy();
    expect(screen.getByText('settings.devices.standbyHint')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  // 2026-11-18 用户要求这台电脑也写出它实际用的连接方式。原来本机卡片只有与中转的连接，没有连接方式。
  // 最小失败输入:relayProtocol 为 Agent-Net / Device Link 且在线;连接中时主连接还没定，不能先写成 Device Link。tier: unit。
  it('在线时单独一行写这台电脑用的连接方式，连接中不写', () => {
    const { unmount } = render(<HubNodePopover model={{ ...model, relay: { ...model.relay, protocol: 'agent-net' } }} linkStatus="online" issue={null} standby={false} />);
    expect(screen.getByText('settings.remoteControl.v2.popover.protocol')).toBeTruthy();
    expect(screen.getByText('settings.remoteControl.v2.protocol.agentNet')).toBeTruthy();
    expect(screen.getByText('settings.devices.linkStatus.online · 20 ms')).toBeTruthy();
    unmount();

    const legacy = render(<HubNodePopover model={{ ...model, relay: { ...model.relay, protocol: 'device-link' } }} linkStatus="online" issue={null} standby={false} />);
    expect(screen.getByText('settings.remoteControl.v2.protocol.deviceLink')).toBeTruthy();
    legacy.unmount();

    render(<HubNodePopover model={{ ...model, relay: { ...model.relay, protocol: 'device-link' } }} linkStatus="connecting" issue={null} standby={false} />);
    expect(screen.queryByText('settings.remoteControl.v2.popover.protocol')).toBeNull();
    expect(screen.queryByText('settings.remoteControl.v2.protocol.deviceLink')).toBeNull();
    expect(screen.getByText('settings.devices.linkStatus.connecting')).toBeTruthy();
  });

  // 2026-11-18 用户要求：看得出中转走的是 Agent-Net 的 UDP 还是 WS,往返是那条路的。原来这一行只有状态和心跳往返。
  // 最小失败输入:Agent-Net 主连接、transport 为 udp / websocket;连接中不写走法。tier: unit。
  it('与中转那一行写经中转的数据走 UDP 还是 WS,连接中不写', () => {
    const relay = { ...model.relay, protocol: 'agent-net' as const };
    const udp = render(<HubNodePopover model={{ ...model, relay: { ...relay, transport: 'udp', rttMs: 9 } }} linkStatus="online" issue={null} standby={false} />);
    expect(screen.getByText('settings.devices.linkStatus.online · settings.remoteControl.v2.relayTransport.udp · 9 ms')).toBeTruthy();
    udp.unmount();

    const ws = render(<HubNodePopover model={{ ...model, relay: { ...relay, transport: 'websocket' } }} linkStatus="online" issue={null} standby={false} />);
    expect(screen.getByText('settings.devices.linkStatus.online · settings.remoteControl.v2.relayTransport.websocket · 20 ms')).toBeTruthy();
    ws.unmount();

    render(<HubNodePopover model={{ ...model, relay: { ...relay, transport: 'udp' } }} linkStatus="connecting" issue={null} standby={false} />);
    expect(screen.getByText('settings.devices.linkStatus.connecting')).toBeTruthy();
  });

  // 2026-11-22 用户需求:在线 Agent-Net 设备展示独立线路区(直连与中转延迟+三档切换),直连不可达时直连档禁用并标明不可用;
  // 非 Agent-Net(Device Link)仍保持单行延迟。tier: unit。
  it('Agent-Net 在线设备展示线路卡片与三档切换器,直连不可达时禁用直连档,保存失败时回退乐观选中,旧版连接保持单行延迟', async () => {
    const onPref = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const dual = node({
      id: 'dual-peer',
      encrypted: true,
      path: 'relay',
      status: 'relay',
      rttMs: 86,
      directRttMs: 220,
      relayRttMs: 86,
      pathPreference: 'auto',
    });
    const { rerender } = render(
      <DeviceNodePopover node={dual} relayName="Cindy" onRemoteDesktop={vi.fn()} onPathPreferenceChange={onPref} />,
    );
    expect(screen.getByText('settings.remoteControl.v2.path.direct')).toBeTruthy();
    expect(screen.getByText('220 ms')).toBeTruthy();
    expect(screen.getByText('settings.remoteControl.v2.path.relay')).toBeTruthy();
    expect(screen.getByText('86 ms')).toBeTruthy();
    const directRadio = screen.getByRole('radio', { name: 'settings.remoteControl.v2.popover.routeDirect' }) as HTMLButtonElement;
    expect(directRadio.disabled).toBe(false);
    // First click fails to save -> optimistic selection reverts back to serverPref ('auto').
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: 'settings.remoteControl.v2.popover.routeRelay' }));
    });
    expect(onPref).toHaveBeenCalledWith(dual, 'relay');
    expect(screen.getByRole('radio', { name: 'settings.remoteControl.v2.popover.routeAuto' }).getAttribute('aria-checked')).toBe('true');
    // Second click succeeds -> optimistic selection stays on 'relay'.
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: 'settings.remoteControl.v2.popover.routeRelay' }));
    });
    expect(screen.getByRole('radio', { name: 'settings.remoteControl.v2.popover.routeRelay' }).getAttribute('aria-checked')).toBe('true');

    // Direct unreachable on Agent-Net: still shows route card and switcher, with Direct disabled & marked unavailable.
    rerender(
      <DeviceNodePopover
        node={node({ id: 'relay-only-peer', encrypted: true, path: 'relay', status: 'relay', rttMs: 23, directRttMs: null, relayRttMs: 23 })}
        relayName="Cindy"
        onRemoteDesktop={vi.fn()}
        onPathPreferenceChange={onPref}
      />,
    );
    expect(screen.getByRole('radiogroup', { name: 'settings.remoteControl.v2.popover.routePreference' })).toBeTruthy();
    expect(screen.getByText('settings.remoteControl.v2.popover.routeUnavailable')).toBeTruthy();
    expect(screen.getByText('23 ms')).toBeTruthy();
    expect((screen.getByRole('radio', { name: 'settings.remoteControl.v2.popover.routeDirect' }) as HTMLButtonElement).disabled).toBe(true);

    // Legacy Device Link connection keeps the single latency row without the Agent-Net route switcher.
    rerender(
      <DeviceNodePopover
        node={node({ id: 'legacy-peer', encrypted: false, path: 'relay', status: 'relay', rttMs: 86 })}
        relayName="Cindy"
        onRemoteDesktop={vi.fn()}
        onPathPreferenceChange={onPref}
      />,
    );
    expect(screen.queryByRole('radiogroup', { name: 'settings.remoteControl.v2.popover.routePreference' })).toBeNull();
    expect(screen.getByText('86 ms · settings.remoteControl.v2.popover.rttNote')).toBeTruthy();
  });

  // 2026-11-26 用户需求：非 dev 版本卡片版本号旁检查是否有新版本，有则显示图标，点击走二次确认再触发内置更新。
  // 最小失败输入：dev 版本(0.0.0 / 0.1.0-dev)、老版本对端(CHANNEL_NOT_ALLOWED)、有新版本的普通桌面端、本机卡片。tier: unit。
  it('shows update icon beside non-dev version and invokes onUpdate for secondary confirmation', async () => {
    const command = vi.fn(async (input: { type: string; deviceId?: string; request?: { action: string } }) => {
      if (input.type === 'peer-app-update' && input.deviceId === 'mac-peer') {
        return {
          state: {},
          peerUpdate: {
            ok: true,
            result: {
              version: 1,
              state: 'available',
              currentVersion: '0.1.143',
              targetVersion: '0.1.145',
              busy: true,
              platform: 'darwin',
            },
          },
        };
      }
      if (input.type === 'self-app-update') {
        return {
          state: {},
          peerUpdate: {
            ok: true,
            result: {
              version: 1,
              state: 'ready',
              currentVersion: '0.1.143',
              targetVersion: '0.1.145',
              busy: false,
              platform: 'darwin',
            },
          },
        };
      }
      return { state: {}, peerUpdate: { ok: false, code: 'CHANNEL_NOT_ALLOWED', message: 'not allowed' } };
    });
    vi.stubGlobal('electronAPI', { selfHostedRelay: { command } });

    const onUpdate = vi.fn();
    const { unmount } = render(
      <DeviceNodePopover
        node={node({ id: 'mac-peer', name: 'XDMBP', platform: 'darwin', appVersion: '0.1.143', busy: true })}
        relayName="Cindy"
        onRemoteDesktop={vi.fn()}
        onUpdate={onUpdate}
      />,
    );

    const btn = await screen.findByRole('button', { name: 'settings.remoteControl.v2.peerUpdate.availableTip' });
    fireEvent.click(btn);
    expect(onUpdate).toHaveBeenCalledWith({
      targetId: 'mac-peer',
      isSelf: false,
      deviceName: 'XDMBP',
      currentVersion: '0.1.143',
      targetVersion: '0.1.145',
      busy: true,
      platform: 'darwin',
    });
    unmount();

    // Self HubNodePopover shows version and update icon when non-dev and newer version is available.
    const onSelfUpdate = vi.fn();
    render(
      <HubNodePopover
        model={{ ...model, self: { name: 'Studio Mac', platform: 'darwin', appVersion: '0.1.143' } }}
        linkStatus="online"
        issue={null}
        standby={false}
        onUpdate={onSelfUpdate}
      />,
    );
    expect(screen.getByText('macOS · Cindy 0.1.143')).toBeTruthy();
    const selfBtn = await screen.findByRole('button', { name: 'settings.remoteControl.v2.peerUpdate.availableTip' });
    fireEvent.click(selfBtn);
    expect(onSelfUpdate).toHaveBeenCalledWith({
      targetId: '__self__',
      isSelf: true,
      deviceName: 'Studio Mac',
      currentVersion: '0.1.143',
      targetVersion: '0.1.145',
      busy: false,
      platform: 'darwin',
    });
  });

  it('skips probing dev versions and hides icon when older peer returns CHANNEL_NOT_ALLOWED', async () => {
    expect(isNonDevAppVersion('0.0.0')).toBe(false);
    expect(isNonDevAppVersion('0.0.0-dev')).toBe(false);
    expect(isNonDevAppVersion('0.1.143-dev.1')).toBe(false);
    expect(isNonDevAppVersion('0.1.143')).toBe(true);
    expect(isNonDevAppVersion('0.1.143-beta.2')).toBe(true);

    const command = vi.fn(async () => ({
      state: {},
      peerUpdate: { ok: false, code: 'CHANNEL_NOT_ALLOWED', message: 'unsupported' },
    }));
    vi.stubGlobal('electronAPI', { selfHostedRelay: { command } });

    const { rerender } = render(
      <DeviceNodePopover
        node={node({ id: 'dev-peer', appVersion: '0.0.0' })}
        relayName="Cindy"
        onRemoteDesktop={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );
    expect(command).not.toHaveBeenCalled();

    rerender(
      <DeviceNodePopover
        node={node({ id: 'old-peer', appVersion: '0.1.120' })}
        relayName="Cindy"
        onRemoteDesktop={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );
    await act(async () => { await Promise.resolve(); });
    expect(command).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'settings.remoteControl.v2.peerUpdate.availableTip' })).toBeNull();
  });

  it('transitions to updating spinner after confirmed install and surfaces background failure', async () => {
    vi.useFakeTimers();
    let polls = 0;
    const command = vi.fn(async (input: { type: string; request: { action: string; expectedVersion?: string } }) => {
      if (input.request.action === 'install') {
        return { state: {}, peerUpdate: { ok: true, result: { version: 1, accepted: true, state: 'downloading', targetVersion: '0.1.145' } } };
      }
      polls += 1;
      return {
        state: {},
        peerUpdate: {
          ok: true,
          result: {
            version: 1,
            state: 'available',
            currentVersion: '0.1.143',
            targetVersion: '0.1.145',
            lastErrorCode: 'download_failed',
          },
        },
      };
    });
    vi.stubGlobal('electronAPI', { selfHostedRelay: { command } });

    const onError = vi.fn();
    const res = await startPeerUpdate('peer-x', '0.1.145', '0.1.143', onError);
    expect(res).toEqual({ ok: true, state: 'downloading', targetVersion: '0.1.145' });
    expect(peerUpdateStore.getSnapshot().entries.get('peer-x')).toMatchObject({ kind: 'updating', phase: 'downloading' });

    await vi.advanceTimersByTimeAsync(3_500);
    expect(polls).toBe(1);
    expect(onError).toHaveBeenCalledWith('download_failed');
    expect(peerUpdateStore.getSnapshot().entries.get('peer-x')).toMatchObject({ kind: 'available', targetVersion: '0.1.145' });
  });
});
