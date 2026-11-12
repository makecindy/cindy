// @vitest-environment jsdom
/**
 * 拓扑卡片只展示连接信息(用户裁决 2026-11-07:拓扑图只管拓扑,改名、开关、删除留在「我的设备」)。
 * 规则:卡片上没有任何开关、删除或「管理设备…」(其它设备不列在「我的设备」里);这台电脑的卡片的「管理设备…」
 * 把本机交给页面去定位本机卡片;
 * 远程桌面只给在线、能被控、两边都允许控制的电脑;忙碌的状态字是心动橙。改坏了拓扑卡片会重新长出配置,
 * 或者「管理设备…」定位错设备。
 * 覆盖缺口:卡片此前没有组件测试。最小失败输入:见各用例。
 * tier:unit(jsdom 组件)。单文件命令实测 3.82s（14 例，Vitest 2.77s）。
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

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
    expect(screen.getByText(protocol + 'settings.remoteControl.v2.path.direct')).toBeTruthy();
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

  it('只展示与中转的连接、连接问题与待机说明;「管理设备…」交出本机', () => {
    const onManage = vi.fn();
    render(<HubNodePopover model={model} linkStatus="online" issue="连接已失效" standby selfDeviceId="self" onManage={onManage} />);
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(screen.getByText('连接已失效')).toBeTruthy();
    expect(screen.getByText('settings.devices.standbyHint')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'settings.remoteControl.v2.popover.manage' }));
    expect(onManage).toHaveBeenCalledWith('self');
  });

  it('设备目录还没拉到(没有本机 id)时不给「管理设备…」', () => {
    render(<HubNodePopover model={model} linkStatus="online" issue={null} standby={false} selfDeviceId={null} onManage={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'settings.remoteControl.v2.popover.manage' })).toBeNull();
  });
});
