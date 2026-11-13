import { RemoteControlSection } from '../../../src/renderer/components/settings/RemoteControlSection';
import type { PeerAgentNetReply, SelfHostedRelayCommand } from '../../../src/shared/selfHostedRelay';
import { AppFrame, ctx, forbid, mountPage, subscription } from '../../ui-page/harness';

type Device = DeviceLinkDeviceView;
type Link = DeviceLinkPeerLinkView;

function device(partial: Partial<Device> & { deviceId: string; name: string }): Device {
  return {
    platform: 'darwin',
    appVersion: '1.4.0',
    lastSeenAt: null,
    online: true,
    busy: false,
    remoteControlEnabled: true,
    controlEnabled: true,
    isSelf: false,
    ...partial,
  };
}

const SELF = device({ deviceId: 'self', name: 'Studio Mac', selfName: 'Studio Mac', isSelf: true, deviceInfo: { modelLabel: 'Mac Studio' } });

/** 一条已建链路;sent / received 是「多少毫秒前有业务消息」,不传就是闲着。 */
function link(deviceId: string, path: Link['path'], rttMs: number | null, sent: number | null = null, received: number | null = null): Link {
  return { deviceId, path, rttMs, open: true, encrypted: true, sentAgoMs: sent, receivedAgoMs: received };
}

function scenario(name: string): { devices: Device[]; links: Link[]; relayRttMs: number | null } {
  if (name === 'empty') return { devices: [SELF], links: [], relayRttMs: 18 };
  if (name === 'fleet') {
    // 与真实账号同一形状(3 直连、7 经中转、15 离线),名字是虚构的;两台正在收发。
    const devices: Device[] = [SELF];
    const links: Link[] = [];
    const direct = [
      ['Render Box', 'win32', 38],
      ['Home mini', 'darwin', 76],
      ['Travel MacBook', 'darwin', 76],
    ] as const;
    direct.forEach(([name, platform, rtt], i) => {
      devices.push(device({ deviceId: `dir${i}`, name, platform }));
      links.push(link(`dir${i}`, 'direct', rtt, i === 0 ? 300 : null, i === 0 ? 120 : null));
    });
    const relayed = [
      ['Build Server', 'win32', 85],
      ['Studio Mac Pro', 'darwin', 86],
      ['Office MacBook', 'darwin', 148],
      ['Cloud Runner', 'linux', 194],
      ['Lab mini', 'darwin', 286],
      ['Spare mini', 'darwin', 308],
      ['CI Linux', 'linux', 316],
    ] as const;
    relayed.forEach(([name, platform, rtt], i) => {
      devices.push(device({ deviceId: `rel${i}`, name, platform }));
      links.push(link(`rel${i}`, 'relay', rtt, i === 3 ? 900 : null, null));
    });
    for (let i = 0; i < 15; i++) {
      devices.push(device({ deviceId: `off${i}`, name: `Old device ${i + 1}`, platform: i % 2 ? 'win32' : 'darwin', online: false, lastSeenAt: '2026-10-20T08:00:00Z' }));
    }
    return { devices, links, relayRttMs: 25 };
  }
  if (name.startsWith('remote-switch')) {
    // 原型:在拓扑卡片里远程切换连接方式。每台设备一种情况(见 ui-page.mjs 的 remote-switch)。
    const enc = (l: Link, encrypted: boolean): Link => ({ ...l, encrypted });
    return {
      devices: [
        SELF,
        device({ deviceId: 'work', name: 'Work PC', platform: 'win32', deviceInfo: { modelLabel: 'ThinkPad X1' } }),
        device({ deviceId: 'build', name: 'Build Server', platform: 'linux' }),
        device({ deviceId: 'vault', name: 'Archive Server', platform: 'linux' }),
        device({ deviceId: 'lab', name: 'Lab Mac', deviceInfo: { modelLabel: 'Mac mini' } }),
        device({ deviceId: 'phone', name: 'iPhone', platform: 'ios' }),
        device({ deviceId: 'home', name: 'Home PC', platform: 'win32' }),
        device({ deviceId: 'air', name: 'MacBook Air', appVersion: '1.3.2', deviceInfo: { modelLabel: 'MacBook Air' } }),
        device({ deviceId: 'office', name: 'Office PC', platform: 'win32', remoteControlEnabled: false }),
        device({ deviceId: 'spare', name: 'Spare PC', platform: 'win32' }),
        device({ deviceId: 'mini', name: 'Mac mini', online: false, lastSeenAt: '2026-11-12T05:00:00Z' }),
      ],
      links: [
        enc(link('work', 'direct', 4), false),
        enc(link('build', 'direct', 3), true),
        enc(link('vault', 'direct', 5), true),
        enc(link('lab', 'direct', 2), false),
        enc(link('phone', 'direct', 18), false),
        enc(link('home', 'relay', 46), false),
        enc(link('air', 'relay', 52), false),
        enc(link('spare', 'direct', 6), false),
      ],
      relayRttMs: 21,
    };
  }
  if (name === 'many') {
    const devices: Device[] = [SELF];
    const links: Link[] = [];
    for (let i = 0; i < 20; i++) {
      const id = `d${i}`;
      const kind = i % 5;
      const platform = i % 3 === 0 ? 'win32' : i % 3 === 1 ? 'darwin' : 'linux';
      if (kind === 0) {
        devices.push(device({ deviceId: id, name: `Desk ${i}`, platform }));
        links.push(link(id, 'direct', 2 + i));
      } else if (kind === 1) {
        devices.push(device({ deviceId: id, name: `Office ${i}`, platform }));
        links.push(link(id, 'relay', 40 + i * 3));
      } else if (kind === 2) {
        devices.push(device({ deviceId: id, name: `Lab ${i}`, platform }));
      } else if (kind === 3) {
        devices.push(device({ deviceId: id, name: `Home ${i}`, platform, remoteControlEnabled: false }));
      } else {
        devices.push(device({ deviceId: id, name: `Old ${i}`, platform, online: false, lastSeenAt: '2026-11-01T08:00:00Z' }));
      }
    }
    return { devices, links, relayRttMs: 22 };
  }
  return {
    devices: [
      SELF,
      device({ deviceId: 'win', name: 'Work PC', platform: 'win32', deviceInfo: { modelLabel: 'ThinkPad X1' } }),
      device({ deviceId: 'mini', name: 'Mac mini', busy: true, deviceInfo: { modelLabel: 'Mac mini' } }),
      device({ deviceId: 'nas', name: 'Home server', platform: 'linux' }),
      device({ deviceId: 'book', name: 'MacBook Air', remoteControlEnabled: false }),
      device({ deviceId: 'phone', name: 'iPhone', platform: 'ios' }),
      device({ deviceId: 'pixel', name: 'Pixel', platform: 'android' }),
      device({ deviceId: 'old', name: 'Old laptop', platform: 'win32', online: false, lastSeenAt: '2026-10-30T12:00:00Z' }),
      device({ deviceId: 'old2', name: 'Spare PC', platform: 'win32', online: false, lastSeenAt: '2026-09-02T12:00:00Z' }),
    ],
    links: [
      // 正在操作 Work PC:双向都有消息;Home server 只收到它发来的。
      link('win', 'direct', 3, 200, 400),
      link('mini', 'direct', 1),
      link('nas', 'relay', 96, null, 600),
    ],
    relayRttMs: 24,
  };
}

const data = scenario(ctx.case);
if (ctx.case === 'remote-switch-controller-strict') data.links = data.links.filter((l) => l.encrypted);
/**
 * 远程切换连接方式的模拟对端(remote-switch):代替那台电脑回答 `peer-agent-net`,并像真实切换一样
 * 让与它的连接先断开、再以新方式连回来。MacBook Air 是旧版 Cindy(不认识这个请求)，Spare PC 在当前中转上
 * 没有 Agent-Net 身份；Agent-Net 不通的那台(单台场景 Home PC、批量场景 Lab Mac)连回来的仍是 Device Link，
 * 在它给出的期限后显示已退回。
 */
const peerPlan: Record<string, { status?: 'unsupported' | 'NOT_SIGNED_IN' | 'SECURE_STORAGE_UNAVAILABLE' | 'RELAY_IDENTITY_MISSING'; agentNetFails?: boolean; onlyEncrypted?: boolean; relayOnly?: boolean }> =
  ctx.case.startsWith('remote-switch')
    ? {
        air: { status: 'unsupported' },
        spare: { status: 'RELAY_IDENTITY_MISSING' },
        build: { onlyEncrypted: ctx.case !== 'remote-switch-controller-strict' },
        vault: { relayOnly: true },
        // 单台：Home PC 退回；批量：第一台 Home PC 成功，Lab Mac 退回，Work PC 成功。
        [ctx.case === 'remote-switch' ? 'home' : 'lab']: { agentNetFails: true },
      }
    : {};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pendingDeadline = new Map<string, number>();
async function simulatePeer(command: Extract<SelfHostedRelayCommand, { type: 'peer-agent-net' }>): Promise<PeerAgentNetReply> {
  const plan = peerPlan[command.deviceId] ?? {};
  const link = data.links.find((l) => l.deviceId === command.deviceId);
  const request = command.request;
  await wait(request.action === 'status' ? 800 : 300);
  if (plan.status === 'unsupported') return { ok: false, code: 'CHANNEL_NOT_ALLOWED', message: 'channel not allowed remotely' };
  if (request.action === 'status') {
    return { ok: true, controllerBlock: ctx.case === 'remote-switch-controller-strict' ? 'ENCRYPTION_REQUIRED' : null,
      result: { version: 1, enabled: link?.encrypted === true, encrypted: link?.encrypted === true,
      disableBlocked: plan.relayOnly ? 'V2_ONLY_RELAY' : null,
      onlyEncrypted: plan.onlyEncrypted === true, blocked: plan.status ?? null, pending: (pendingDeadline.get(command.deviceId) ?? 0) > Date.now() } };
  }
  if (request.action === 'confirm') {
    // 像真实对方一样：重连期间联系不上；连回来但不是 Agent-Net 时不认；过了期限说明已经退回。
    if (pendingDeadline.has(command.deviceId) && Date.now() > pendingDeadline.get(command.deviceId)!) {
      return { ok: false, code: 'IPC_ERROR', message: '[AGENT_NET_SWITCH_STALE] agent-net switch failed' };
    }
    if (!link?.open) return { ok: false, code: 'NOT_CONNECTED', message: 'reconnecting' };
    if (link.encrypted !== true) return { ok: false, code: 'IPC_ERROR', message: '[AGENT_NET_SWITCH_NOT_ON_AGENT_NET] agent-net switch failed' };
    pendingDeadline.delete(command.deviceId);
    return { ok: true, result: { version: 1, switchId: request.switchId, confirmed: true } };
  }
  if (!request.enabled && ctx.case === 'remote-switch-controller-strict') return { ok: false, code: 'IPC_ERROR', message: '[AGENT_NET_SWITCH_CONTROLLER_ENCRYPTION_REQUIRED] controller requires encryption' };
  if (!request.enabled && plan.relayOnly) return { ok: false, code: 'IPC_ERROR', message: '[AGENT_NET_SWITCH_V2_ONLY_RELAY] network requires encryption' };
  if (!request.enabled && plan.onlyEncrypted) return { ok: false, code: 'IPC_ERROR', message: '[AGENT_NET_SWITCH_ENCRYPTION_REQUIRED] target requires encryption' };
  if (request.enabled && plan.status) return { ok: false, code: 'IPC_ERROR', message: '[AGENT_NET_SWITCH_NOT_READY] agent-net switch failed' };
  if (link) {
    setTimeout(() => { link.open = false; }, 300);
    setTimeout(() => { link.open = true; link.encrypted = request.enabled && !plan.agentNetFails; }, 1_500);
  }
  const confirmWithinMs = request.enabled ? (plan.agentNetFails ? 4_000 : 60_000) : null;
  if (confirmWithinMs) pendingDeadline.set(command.deviceId, Date.now() + confirmWithinMs);
  return { ok: true, result: { version: 1, switchId: request.switchId, enabled: request.enabled, confirmWithinMs } };
}
if (ctx.case === 'default' && data.links[0]) data.links[0].encrypted = false;

void mountPage({
  route: '/settings?tab=remote-control',
  host: {
    deviceLink: {
      listDevices: async () => ({ devices: data.devices }),
      getState: async () => ({
        remoteControlEnabled: ctx.case !== 'empty',
        keepAwake: false,
        linkStatus: 'online',
        connectionIssue: null,
        standby: false,
        controlledBy: ctx.case === 'default' ? [{ deviceId: 'win', name: 'Work PC' }] : [],
        revokedControllers: [],
        disabledControlDeviceIds: [],
        unresponsiveDeviceIds: [],
      }),
      getPeerLinks: async () => ({ links: data.links, relayRttMs: data.relayRttMs }),
      onPeerLinksChanged: subscription('peerLinks'),
      onPresenceChanged: subscription('presence'),
      onStatusChanged: subscription('linkStatus'),
      onConnectionIssue: subscription('connectionIssue'),
      onOwnershipChanged: subscription('ownership'),
      onControlledState: subscription('controlled'),
      onControlTargetChanged: subscription('controlTarget'),
      setEnabled: forbid('deviceLink.setEnabled'),
      renameDevice: forbid('deviceLink.renameDevice'),
      deleteDevice: forbid('deviceLink.deleteDevice'),
    },
    selfHostedRelay: {
      command: async (command: SelfHostedRelayCommand) => ({
        ...(command.type === 'peer-agent-net' ? { peer: await simulatePeer(command) } : {}),
        state: {
          available: true,
          agentNetEnabled: ctx.case !== 'legacy-off',
          agentNetOnlyEncrypted: ctx.case === 'empty' || ctx.case === 'remote-switch-controller-strict',
          // 被切的那台电脑:开关下面写「由谁在几点远程打开」。
          agentNetChangedBy: ctx.case === 'switched-here'
            ? { deviceId: 'mbp', deviceName: 'MacBook Pro', at: new Date(2026, 10, 12, 10, 32).getTime(), enabled: true }
            : null,
          mode: 'official',
          relay: null,
          issue: null,
          host: { enabled: false, running: false, error: null, port: 7443, listenAll: false, externalUrl: null, suggestedUrls: [] },
          deployments: [],
          deployJob: null,
          bundledRelayVersion: '1.0.0',
          joinLink: null,
          pendingRequests: [],
          join: { status: 'idle' },
        },
      }),
      onChanged: subscription('relayChanged'),
    },
    remoteSsh: {
      list: async () => ({ hosts: [] }),
      onStatusChanged: subscription('sshStatus'),
      onHostsChanged: subscription('sshHosts'),
    },
    openRemoteDesktop: forbid('openRemoteDesktop'),
    maker: {
      getOwnComputerModelUse: async () => ({ enabled: ctx.case === 'model-access-on' }),
      setOwnComputerModelUse: async ({ enabled }: { enabled: boolean }) => ({ ok: true, enabled }),
    },
  },
  render: () => (
    <AppFrame>
      <div className="mx-auto w-full max-w-[920px] px-6 py-6">
        <RemoteControlSection />
      </div>
    </AppFrame>
  ),
});
