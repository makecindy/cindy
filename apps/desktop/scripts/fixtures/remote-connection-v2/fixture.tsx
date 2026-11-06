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

const SELF = device({ deviceId: 'self', name: 'Studio Mac', selfName: 'Studio Mac', deviceInfo: { modelLabel: 'Mac Studio' } });

function scenario(name: string): { devices: Device[]; links: Link[]; relayRttMs: number | null } {
  if (name === 'empty') return { devices: [SELF], links: [], relayRttMs: 18 };
  if (name === 'many') {
    const devices: Device[] = [SELF];
    const links: Link[] = [];
    for (let i = 0; i < 20; i++) {
      const id = `d${i}`;
      const kind = i % 5;
      const platform = i % 3 === 0 ? 'win32' : i % 3 === 1 ? 'darwin' : 'linux';
      if (kind === 0) {
        devices.push(device({ deviceId: id, name: `Desk ${i}`, platform }));
        links.push({ deviceId: id, path: 'direct', rttMs: 2 + i, open: true });
      } else if (kind === 1) {
        devices.push(device({ deviceId: id, name: `Office ${i}`, platform }));
        links.push({ deviceId: id, path: 'relay', rttMs: 40 + i * 3, open: true });
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
      device({ deviceId: 'mini', name: 'Mac mini', deviceInfo: { modelLabel: 'Mac mini' } }),
      device({ deviceId: 'nas', name: 'Home server', platform: 'linux' }),
      device({ deviceId: 'book', name: 'MacBook Air', remoteControlEnabled: false }),
      device({ deviceId: 'phone', name: 'iPhone', platform: 'ios' }),
      device({ deviceId: 'old', name: 'Old laptop', platform: 'win32', online: false, lastSeenAt: '2026-10-30T12:00:00Z' }),
      device({ deviceId: 'old2', name: 'Spare PC', platform: 'win32', online: false, lastSeenAt: '2026-09-02T12:00:00Z' }),
    ],
    links: [
      { deviceId: 'win', path: 'direct', rttMs: 3, open: true },
      { deviceId: 'mini', path: 'direct', rttMs: 1, open: true },
      { deviceId: 'nas', path: 'relay', rttMs: 96, open: true },
    ],
    relayRttMs: 24,
  };
}

const data = scenario(ctx.case);

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
