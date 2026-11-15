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

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

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
    const protocol = encrypted === undefined ? '' : `settings.remoteControl.v2.protocol.${encrypted ? 'agentNet' : 'deviceLink'} · `;
    // 2026-11-13: 协议画成图标 + 名称后文字分在两段里，完整的「协议 · 路径」在这一行的悬停提示上。
    const pathRow = screen.getByTitle(protocol + 'settings.remoteControl.v2.path.direct');
    expect(pathRow.textContent?.replace(/\s/g, '')).toBe((protocol + 'settings.remoteControl.v2.path.direct').replace(/\s/g, ''));
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
});
