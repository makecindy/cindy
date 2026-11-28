import { RemoteControlSection } from '../../../src/renderer/components/settings/RemoteControlSection';
import { ToastContainer } from '../../../src/renderer/components/ui/toast/ToastContainer';
import type { SshAccessLocalState, SshAccessSessionCleanup, SshDeviceHostView } from '../../../src/shared/sshAccess';
import { AppFrame, ctx, forbid, mountPage, subscription } from '../../ui-page/harness';

// The person's devices (fictional names). CLOUD is a Cindy cloud host (Linux), STUDIO the Mac they work on.
const CLOUD = 'cloud-host-0123456789abcdef';
const STUDIO = 'studio-mac-0011223344556677';
const AIR = 'macbook-air-8899aabbccddeeff';
const LAB = 'lab-pc-0123012301230123';
const MINI = 'mac-mini-4455667788990011';
const IMAC = 'office-imac-5566778899aabbcc';
/** A device that left the account; this computer never saw its name. */
const GONE = 'old-laptop-aabbccddeeff0011';

type Device = DeviceLinkDeviceView;
type Scene = 'target' | 'target-blocked-linux' | 'target-blocked-mac' | 'controller';

function device(partial: Partial<Device> & { deviceId: string; name: string }): Device {
  return {
    platform: 'darwin',
    appVersion: '0.1.147',
    lastSeenAt: null,
    online: true,
    busy: false,
    remoteControlEnabled: true,
    controlEnabled: true,
    isSelf: false,
    ...partial,
  };
}

const scene = ctx.data.scene as Scene;
const selfIsCloud = scene !== 'controller' && scene !== 'target-blocked-mac';
const devices: Device[] = [
  device({ deviceId: CLOUD, name: 'VM-4-7-ubuntu', platform: 'linux', isSelf: selfIsCloud }),
  device({ deviceId: STUDIO, name: 'Studio Mac', isSelf: !selfIsCloud, deviceInfo: { modelLabel: 'Mac Studio' } }),
  device({ deviceId: AIR, name: 'MacBook Air' }),
  ...(scene === 'controller'
    ? [
        device({ deviceId: LAB, name: 'Lab PC', platform: 'linux', appVersion: '0.1.120' }),
        device({ deviceId: MINI, name: 'Mac mini', online: false, lastSeenAt: new Date(Date.now() - 3 * 3600e3).toISOString() }),
        device({ deviceId: IMAC, name: 'Office iMac' }),
      ]
    : []),
].map((d) => (d.isSelf ? { ...d, selfName: d.name } : d));

/** Today at a fixed time, so the list reads 「今天 13:05」 whatever the run time. */
function todayAt(hours: number, minutes: number): number {
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date.getTime();
}

const KEY_STUDIO = 'SHA256:XySgr8Xym3UBX0xPo8AkyHRPb4jhTA2wFX9VQNbhHCU';
const KEY_AIR = 'SHA256:4f8Wq0n2xYzP7lKcR1sVbT9uMhE3jD6aNoGiQ5wLt2E';
const KEY_OFFICE = 'SHA256:9fQ2mXc8RtV1bN4sLpW7yKjH3dGa6eUo0iZqT5vk1Zc';
const KEY_GONE = 'SHA256:Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90Uv1';

function initialState(): SshAccessLocalState {
  const base: SshAccessLocalState = {
    supported: true,
    remoteControlEnabled: true,
    setting: true,
    defaultSetting: selfIsCloud,
    customized: false,
    cloudGuest: selfIsCloud,
    enabled: true,
    blocked: null,
    endpoint: null,
    devices: [],
    manualKeys: [],
    recordUnreadable: false,
    lastSessionCleanup: null,
    // Only the Linux cloud host can end one device's sessions (a Mac keeps them open until "end all").
    endsDeviceSessions: selfIsCloud,
  };
  if (scene === 'target') {
    return {
      ...base,
      devices: [
        { deviceId: STUDIO, deviceName: 'Studio Mac', fingerprint: KEY_STUDIO, enrolledAt: todayAt(13, 5), active: true },
        // No name recorded here: the row takes the device list's name.
        { deviceId: AIR, fingerprint: KEY_AIR, enrolledAt: todayAt(13, 6), active: true },
      ],
      manualKeys: [{ fingerprint: KEY_OFFICE, label: 'Office server', addedAt: todayAt(9, 30), active: true }],
    };
  }
  if (scene === 'target-blocked-linux') {
    return {
      ...base,
      blocked: 'SSHD_UNREACHABLE',
      devices: [
        { deviceId: STUDIO, deviceName: 'Studio Mac', fingerprint: KEY_STUDIO, enrolledAt: todayAt(13, 5), active: true },
        { deviceId: GONE, fingerprint: KEY_GONE, enrolledAt: new Date(2026, 9, 3, 18, 20).getTime(), active: false },
      ],
    };
  }
  if (scene === 'target-blocked-mac') {
    // Turned on by the person on a Mac (off by default there), with Remote Login off; one device already enrolled.
    return {
      ...base,
      customized: true,
      blocked: 'REMOTE_LOGIN_OFF',
      devices: [{ deviceId: AIR, deviceName: 'MacBook Air', fingerprint: KEY_AIR, enrolledAt: todayAt(13, 6), active: true }],
    };
  }
  // The controller's own Mac: SSH access left at its default (off).
  return { ...base, setting: false, customized: false, enabled: false };
}

let state = initialState();
const cleanup = (terminated: number, unmapped: number): SshAccessSessionCleanup => ({ at: Date.now(), supported: true, terminated, unmapped });

// This computer as controller: what it keeps for the other devices.
let deviceHosts: SshDeviceHostView[] = scene === 'controller'
  ? [
      { deviceId: CLOUD, alias: 'cindy-vm-4-7-ubuntu', hostId: 'cindy-vm-4-7-ubuntu', state: 'ready', reason: null, blocked: null },
      { deviceId: AIR, alias: 'cindy-macbook-air', hostId: null, state: 'user-deleted', reason: null, blocked: null },
      { deviceId: LAB, alias: null, hostId: null, state: 'needs-update', reason: null, blocked: null },
      { deviceId: MINI, alias: 'cindy-mac-mini', hostId: 'cindy-mac-mini', state: 'unavailable', reason: 'off', blocked: null },
      // Access is on there, but Remote Login is off on that Mac: the card says so.
      { deviceId: IMAC, alias: 'cindy-office-imac', hostId: 'cindy-office-imac', state: 'unavailable', reason: 'blocked', blocked: 'REMOTE_LOGIN_OFF' },
    ]
  : [];

function sshHost(id: string, displayName: string, hostname: string, user: string, extra: Partial<RemoteHostSnapshot> = {}, deviceHost = false): RemoteHostSnapshot {
  return {
    config: {
      id,
      displayName,
      hostname,
      port: 22,
      user,
      authMethod: deviceHost ? 'key' : 'agent',
      identityFileConfigured: deviceHost,
      ...(deviceHost ? { identityFileName: 'id_ed25519' } : {}),
      source: 'ssh-config',
      managedByCindy: true,
      ...(deviceHost ? { deviceHost: true as const } : {}),
    },
    status: 'disconnected',
    statusChangedAt: 0,
    autoConnect: false,
    agentProxy: null,
    agentProxyTunnel: null,
    ...extra,
  };
}

/** Where each device host points (fictional addresses). */
const ENDPOINTS: Record<string, { hostname: string; user: string }> = {
  [CLOUD]: { hostname: '203.0.113.24', user: 'ubuntu' },
  [MINI]: { hostname: '192.168.1.42', user: 'studio' },
  [IMAC]: { hostname: '192.168.1.57', user: 'office' },
};
/** Device hosts whose key main reports pinned; the Mac mini's pin is gone (Cindy's host-key file was reset). */
const PINNED = new Set([CLOUD, IMAC]);

function sshHosts(): RemoteHostSnapshot[] {
  if (scene !== 'controller') return [];
  const listed = deviceHosts.filter((view) => view.hostId !== null);
  const names = new Map(devices.map((d) => [d.deviceId, d.name] as const));
  return [
    ...listed.map((view) => sshHost(view.hostId!, names.get(view.deviceId) ?? view.hostId!, ENDPOINTS[view.deviceId]?.hostname ?? '192.168.1.31', ENDPOINTS[view.deviceId]?.user ?? 'dash', {
      device: { deviceId: view.deviceId, available: view.state === 'ready' },
      ...(PINNED.has(view.deviceId) ? { hostKeyPinned: true as const } : {}),
    }, true)),
    sshHost('dev-server', 'dev-server', 'dev.example.com', 'dash'),
  ];
}

void mountPage({
  route: scene === 'controller' ? '/settings?tab=remote-control&section=remoteControl.devices' : '/settings?tab=remote-control',
  host: {
    // The scene's own computer, whatever machine runs the check (remote desktop's setting reads it). What SSH access can
    // do there arrives with its state (endsDeviceSessions).
    platform: selfIsCloud ? 'linux' : 'darwin',
    deviceLink: {
      cloudComputerEntry: async () => null,
      listDevices: async () => ({ devices }),
      getState: async () => ({
        remoteControlEnabled: true,
        keepAwake: false,
        linkStatus: 'online',
        connectionIssue: null,
        standby: false,
        controlledBy: [],
        revokedControllers: [],
        disabledControlDeviceIds: [],
        unresponsiveDeviceIds: [],
      }),
      getPeerLinks: async () => ({ links: [], traffic: null, agentNetRoutes: [], relayProtocol: 'device-link', relayTransport: 'websocket', relayRttMs: 20 }),
      onPeerLinksChanged: subscription('peerLinks'),
      onPresenceChanged: subscription('presence'),
      onStatusChanged: subscription('linkStatus'),
      onConnectionIssue: subscription('connectionIssue'),
      onOwnershipChanged: subscription('ownership'),
      onControlledState: subscription('controlled'),
      onControlTargetChanged: subscription('controlTarget'),
      onControlEnabledChanged: subscription('controlEnabled'),
      setEnabled: forbid('deviceLink.setEnabled'),
      renameDevice: forbid('deviceLink.renameDevice'),
      deleteDevice: forbid('deviceLink.deleteDevice'),
      revoke: forbid('deviceLink.revoke'),
      restore: forbid('deviceLink.restore'),
      setDeviceControlEnabled: forbid('deviceLink.setDeviceControlEnabled'),
      disconnectAll: forbid('deviceLink.disconnectAll'),
      rejoin: forbid('deviceLink.rejoin'),
    },
    cloudSettings: { instanceAccess: async () => ({ schemaVersion: 1, allowed: false }) },
    remoteDesktop: { state: async () => ({ enabled: false }) },
    selfHostedRelay: {
      command: async () => ({
        state: {
          available: true,
          agentNetEnabled: false,
          agentNetOnlyEncrypted: false,
          agentNetChangedBy: null,
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
    // This computer as target. Each operation answers like main: the new state (and what it ended).
    sshAccess: {
      read: async () => state,
      setEnabled: async (enabled: boolean) => {
        state = { ...state, setting: enabled, customized: true, enabled };
        return state;
      },
      restoreDefault: async () => {
        state = { ...state, setting: state.defaultSetting, customized: false, enabled: state.defaultSetting };
        return state;
      },
      addKey: async (publicKey: string, label?: string) => {
        if (!publicKey.trim().startsWith('ssh-ed25519 ')) throw new Error('[INVALID_PARAMS] not an ssh-ed25519 public key');
        const fingerprint = 'SHA256:Zq0n2xYzP7lKcR1sVbT9uMhE3jD6aNoGiQ5wLt2E4f8';
        state = { ...state, manualKeys: [...state.manualKeys, { fingerprint, label: label ?? '', addedAt: Date.now(), active: true }] };
        return { state, fingerprint };
      },
      removeKey: async (fingerprint: string) => {
        state = { ...state, manualKeys: state.manualKeys.filter((key) => key.fingerprint !== fingerprint) };
        return state;
      },
      // One of its sessions ended, one other session's key could not be identified (left running).
      removeDevice: async (deviceId: string) => {
        state = { ...state, devices: state.devices.filter((row) => row.deviceId !== deviceId) };
        return { state, revoked: true, sessions: cleanup(1, 1) };
      },
      endAllSessions: async () => {
        const sessions = cleanup(2, 0);
        state = { ...state, lastSessionCleanup: sessions };
        return { state, sessions };
      },
      onChanged: subscription('sshAccessChanged'),
    },
    // This computer as controller.
    sshDeviceHosts: {
      read: async () => deviceHosts,
      restore: async (deviceId: string) => {
        deviceHosts = deviceHosts.map((view) => (view.deviceId === deviceId && view.alias
          ? { ...view, hostId: view.alias, state: 'ready' as const }
          : view));
        return deviceHosts;
      },
      onChanged: subscription('sshDeviceHostsChanged'),
    },
    remoteSsh: {
      list: async () => ({ hosts: sshHosts() }),
      onStatusChanged: subscription('sshStatus'),
      onHostsChanged: subscription('sshHosts'),
      connect: async () => undefined,
      add: forbid('remoteSsh.add'),
      update: forbid('remoteSsh.update'),
      remove: forbid('remoteSsh.remove'),
      setAutoConnect: forbid('remoteSsh.setAutoConnect'),
    },
    openRemoteDesktop: forbid('openRemoteDesktop'),
  },
  render: () => (
    <AppFrame>
      <div className="mx-auto w-full max-w-[920px] px-6 py-6">
        <RemoteControlSection />
      </div>
      <ToastContainer />
    </AppFrame>
  ),
});

