import { SessionDeviceIndicator } from '../../../src/renderer/features/cc-agent/SessionDeviceIndicator';
import { AppFrame, ctx, mountPage, subscription } from '../../ui-page/harness';

const online = ctx.case !== 'offline';
const device: DeviceLinkDeviceView = {
  deviceId: 'peer', name: '工作室的 Mac', platform: 'darwin', appVersion: '1.4.0', online,
  busy: false, isSelf: false, remoteControlEnabled: true, controlEnabled: true,
  deviceInfo: { modelLabel: 'Mac Studio' }, lastSeenAt: new Date(Date.now() - 300_000).toISOString(),
};

void mountPage({
  host: {
    deviceLink: {
      getState: async () => ({ linkStatus: 'online' }),
      listDevices: async () => ({ devices: [device] }),
      getPeerLinks: async () => ({
        links: online ? [{ deviceId: 'peer', open: true, encrypted: true, path: ctx.case === 'relay' ? 'relay' : 'direct', rttMs: 8 }] : [],
        agentNetRoutes: ctx.case === 'relay'
          ? [{ deviceId: 'peer', path: 'relay', rttMs: 8, peerRelayVia: 'websocket' }]
          : [],
        relayRttMs: null, relayProtocol: 'agent-net', relayTransport: 'udp',
      }),
      onPresenceChanged: subscription('presence'),
      onStatusChanged: subscription('status'),
      onControlTargetChanged: subscription('control'),
      onPeerLinksChanged: subscription('links'),
    },
  },
  render: () => (
    <AppFrame>
      <div className="flex items-center gap-1 border-b border-[var(--border-default)] px-6 py-2 text-sm">
        <SessionDeviceIndicator deviceId="peer" fallbackName="Old Mac" connectionStatus={online ? 'connected' : 'disconnected'} />
        构建桌面应用
      </div>
    </AppFrame>
  ),
});
