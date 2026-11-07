import { RemoteControlSection } from '../../../src/renderer/components/settings/RemoteControlSection';
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
      command: async () => ({
        state: {
          available: true,
          agentNetEnabled: ctx.case !== 'legacy-off',
          agentNetOnlyEncrypted: ctx.case === 'empty',
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
  },
  render: () => (
    <AppFrame>
      <div className="mx-auto w-full max-w-[920px] px-6 py-6">
        <RemoteControlSection />
      </div>
    </AppFrame>
  ),
});
