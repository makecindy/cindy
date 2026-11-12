// @vitest-environment jsdom
/**
 * 拓扑卡片只展示连接信息(用户裁决 2026-11-07:拓扑图只管拓扑,改名、开关、删除留在「我的设备」)。
 * 规则:所有卡片都不放开关、删除或「管理设备…」;本机设置已在同一页上方。
 * 远程桌面只给在线、能被控、两边都允许控制的电脑;忙碌的状态字是心动橙。改坏了拓扑卡片会重新长出配置,
 * 或者重新长出同页重复的管理入口(用户反馈 2026-11-12)。
 * 覆盖缺口:旧用例要求本机卡片提供管理按钮。最小失败输入:有本机连接信息的 HubNodePopover。
 * tier:unit(jsdom 组件)。单独运行实测耗时:3.36s。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { DeviceNodePopover, HubNodePopover } from '../DeviceNodePopover';
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

afterEach(() => cleanup());

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

  it('只展示与中转的连接、连接问题与待机说明,不重复提供同页管理入口', () => {
    render(<HubNodePopover model={model} linkStatus="online" issue="连接已失效" standby />);
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(screen.getByText('连接已失效')).toBeTruthy();
    expect(screen.getByText('settings.devices.standbyHint')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
