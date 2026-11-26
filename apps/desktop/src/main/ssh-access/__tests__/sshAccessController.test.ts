import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceLinkError, sshAccessErrorCode, type SshAccessRequest } from '@cindy/device-link';
import { generateOpenSshEd25519KeyPair } from '@cindy/maker-remote-ssh';
import { CLOUD_GUEST_AUTHORIZED_KEYS_FILE } from '../authorizedKeysFile.js';
import { createSshAccessController, type DeviceHostSpec, type SshAccessController } from '../sshAccessController.js';
import { createSshAccessTarget, type SshAccessSettings, type SshAccessTarget } from '../sshAccessTargetCore.js';
import { handleSshDeviceHostsRequest } from '../ipc.desktop.js';

vi.mock('../../logger', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }));
// The IPC bodies (ipc.desktop.ts) are exercised without Electron or the desktop assemblies.
vi.mock('electron', () => ({ ipcMain: { handle() {} }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent() {}, isTrustedAppRendererWindow: () => true }));
vi.mock('../sshAccessTarget.desktop.js', () => ({ currentSshAccessTarget: () => null }));

// 测试价值
// - 生产入口与可观察结果：createSshAccessController 的 activate / receiveAnnounce / notePeerVersion / noteDeviceList /
//   revokedBy / settingsChanged / hostRemovedByUser / restoreHost / readState / deviceHostFor，对端是真实的
//   createSshAccessTarget（Cindy 云电脑，真实临时 home），两者之间是按 dispatch.ts 准入规则模拟的内存 device link。
//   断言对端授权文件里的专用公钥、写入「SSH 远程主机」的主机（别名、地址、固定的主机密钥、IdentityFile）、
//   ~/.ssh/cindy_known_hosts、用户自己的 known_hosts 不变、经过 device link 的调用次数与界面状态。
// - Bug／规则依据：spec 决定 2、5–8 与控制端架构条目；device-link-ssh-access.md 的「旧端」「通道预算」；
//   server-channel-review.md（同一目标同时只有一次登记、繁忙有界退避、稳定状态零流量）。
// - 现有覆盖缺口：新模块；被控端测试只覆盖到它发出 announce 为止，没有任何东西消费它。
// - 最小失败输入：同一 revision 的 announce 又调一次 status；用户删掉主机后对端变化时被加回；旧端每次都重试；
//   换账号后在途结果写进新账号；「控制它」关着时仍登记公钥；被撤销后主机被删掉而不是标为不可用。
// - tier：unit（真实 fs 只在 mkdtemp 目录；device link 与 SSH 主机列表注入；announce 去抖与重试用假计时器）。
const TARGET = 'cloud-host-0123456789abcdef';
const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJKEt0idaTeuNCEMu+wXT8G+Y6mBJ+zDXpCTg20sfDgC';
const HOST_KEY_FP = 'SHA256:XySgr8Xym3UBX0xPo8AkyHRPb4jhTA2wFX9VQNbhHCU';
const OWN_KNOWN_HOSTS = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n';
const ALIAS = 'cindy-studio-cloud';
const OTHER_COMPUTER = 'desktop-0011223344556677';

interface World {
  root: string;
  owner: string | null;
  self: string;
  targetSettings: SshAccessSettings;
  targetOnline: boolean;
  /** The device answers like a Cindy without SSH access (CHANNEL_NOT_ALLOWED). */
  targetOld: boolean;
  publicIp: string;
  controlDisabled: boolean;
  /** Calls that fail with BACKPRESSURE before reaching the device. */
  busy: number;
  hold: { promise: Promise<void>; release(): void } | null;
  invokes: SshAccessRequest[];
  hosts: Map<string, { managed: boolean; spec: DeviceHostSpec | null }>;
}

let w: World;
let target: SshAccessTarget;
let controller: SshAccessController;

const targetHome = () => path.join(w.root, 'target-home');
const controllerHome = () => path.join(w.root, 'controller-home');
const keyDir = (owner = 'owner-a') => path.join(w.root, 'controller-profile', 'owners', owner, 'ssh-access');
const readText = (file: string) => fs.readFile(file, 'utf8').catch(() => null);
const states = () => controller.readState();

function held() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function makeTarget(): SshAccessTarget {
  return createSshAccessTarget({
    platform: 'linux',
    homeDir: targetHome,
    profileKey: 'cloudProfile',
    ownerScope: () => 'cloud:owner-a:1',
    recordPath: () => path.join(w.root, 'target-profile', 'ssh-access.json'),
    managedCloudInstance: () => false,
    detectCloudGuest: async () => true,
    readSettings: () => w.targetSettings,
    writeEnabledOverride: async (value) => {
      const { sshAccessEnabled: _previous, ...rest } = w.targetSettings;
      w.targetSettings = value === undefined ? rest : { ...rest, sshAccessEnabled: value };
    },
    onlineDesktopPeers: () => (w.targetOnline ? [w.self] : []),
    // The relay delivers the signed push to this computer, which hands it to the controller (device-link/index.ts).
    sendAnnounce: (deviceId, payload) => {
      if (deviceId === w.self) controller.receiveAnnounce(TARGET, JSON.parse(JSON.stringify(payload)));
    },
    revokeDevice: async () => undefined,
    readDeviceDirectory: async () => ['laptop-fedcba9876543210', OTHER_COMPUTER, TARGET],
    probeSshd: async () => true,
    readEndpointFacts: async () => ({ user: 'ubuntu', port: 22, lanAddresses: [{ kind: 'lan', host: '10.0.0.5' }], mdnsName: null, hostKeys: [HOST_KEY] }),
    readPublicIpv4: async () => w.publicIp,
    terminator: {
      terminateFingerprints: async (fingerprints) => ({ supported: true, terminated: fingerprints.size, unmapped: 0 }),
      terminateAll: async () => ({ supported: true, terminated: 0, unmapped: 0 }),
    },
    log: { info() {}, warn() {} },
  });
}

/** The device link as the target's dispatcher answers (dispatch.ts): admission first, then the SSH access port. */
async function invoke(deviceId: string, request: SshAccessRequest) {
  w.invokes.push(request);
  if (w.hold) await w.hold.promise;
  if (w.busy > 0) {
    w.busy -= 1;
    throw new DeviceLinkError('BACKPRESSURE', 'busy');
  }
  if (deviceId !== TARGET || !w.targetOnline) throw new DeviceLinkError('DEVICE_OFFLINE', 'offline');
  if (w.targetOld) return { ok: false as const, error: { code: 'CHANNEL_NOT_ALLOWED', message: 'not allowed remotely' } };
  if (!w.targetSettings.remoteControlEnabled) return { ok: false as const, error: { code: 'REMOTE_DISABLED', message: 'remote control disabled' } };
  if (w.targetSettings.revokedControllers.includes(w.self)) {
    return { ok: false as const, error: { code: 'ACCESS_REVOKED', message: 'access revoked by target device' } };
  }
  try {
    return { ok: true as const, result: JSON.parse(JSON.stringify(await target.handleRemote(w.self, request))) };
  } catch (error) {
    const code = sshAccessErrorCode(error instanceof Error ? error.message : '') ?? 'SSH_ACCESS_UNAVAILABLE';
    return { ok: false as const, error: { code: 'IPC_ERROR', message: `[${code}] ssh access request failed` } };
  }
}

function makeController(): SshAccessController {
  return createSshAccessController({
    ownerScope: () => (w.owner ? `cloud:${w.owner}:1` : null),
    recordPath: () => (w.owner ? path.join(w.root, 'controller-profile', 'owners', w.owner, 'ssh-device-access.json') : null),
    keyDir: () => (w.owner ? keyDir(w.owner) : null),
    selfDeviceId: () => w.self,
    homeDir: controllerHome,
    peer: (deviceId) => (deviceId === TARGET ? { desktop: true, name: 'Studio Cloud' } : null),
    controlDisabled: () => w.controlDisabled,
    invoke,
    hostAliases: async () => new Map([...w.hosts].map(([alias, host]) => [alias, host.managed ? host.spec?.hostKeyAlias ?? null : null])),
    // The SSH host list's main-only upsert (remote-ssh/index.ts upsertPinnedDeviceHost), in memory.
    upsertHost: async (spec, { expectPresent }) => {
      const existing = w.hosts.get(spec.alias);
      if (!existing && expectPresent) return 'missing';
      if (existing && (!existing.managed || existing.spec?.hostKeyAlias !== spec.hostKeyAlias)) return 'alias-taken';
      w.hosts.set(spec.alias, { managed: true, spec });
      if (!existing) return 'created';
      return JSON.stringify({ ...existing.spec, previousDisplayName: null }) === JSON.stringify({ ...spec, previousDisplayName: null })
        ? 'unchanged' : 'updated';
    },
    generateKeyPair: (comment) => generateOpenSshEd25519KeyPair(comment),
    log: { info() {}, warn() {} },
  });
}

/** Lets queued target work, announce debounces and controller operations run (no retry timer is reached). */
async function flush(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await target.readLocal();
    await vi.advanceTimersByTimeAsync(1_000);
    await controller.idle();
  }
}

async function start(options: { holdCalls?: boolean } = {}): Promise<void> {
  target = makeTarget();
  controller = makeController();
  controller.activate();
  await target.activate();
  if (!options.holdCalls) {
    await flush();
    return;
  }
  // A held call never finishes on its own: deliver the announce and let real file work run until the call reaches
  // the link (setImmediate and Date are not faked; only setTimeout is).
  await vi.advanceTimersByTimeAsync(1_000);
  const deadline = Date.now() + 5_000;
  while (!w.invokes.length && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
}

const hostSpec = () => w.hosts.get(ALIAS)?.spec ?? null;
const dedicatedPublicKey = async () => (await fs.readFile(path.join(keyDir(), 'id_ed25519.pub'), 'utf8')).split(' ').slice(0, 2).join(' ');
const targetFile = () => readText(path.join(targetHome(), '.ssh', CLOUD_GUEST_AUTHORIZED_KEYS_FILE));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-ssh-controller-'));
  w = {
    root, owner: 'owner-a', self: 'laptop-fedcba9876543210', targetSettings: { remoteControlEnabled: true, revokedControllers: [] },
    targetOnline: true, targetOld: false, publicIp: '203.0.113.7', controlDisabled: false, busy: 0, hold: null, invokes: [], hosts: new Map(),
  };
  await fs.mkdir(path.join(controllerHome(), '.ssh'), { recursive: true });
  await fs.writeFile(path.join(controllerHome(), '.ssh', 'known_hosts'), OWN_KNOWN_HOSTS);
});

afterEach(async () => {
  w.hold?.release();
  await controller?.idle();
  target?.deactivate();
  controller?.deactivate();
  vi.useRealTimers();
  await fs.rm(w.root, { recursive: true, force: true });
});

describe('SSH access controller: setting up a device host', () => {
  it('enrolls on the announce, adds the pinned host and alias, and costs nothing while the device is unchanged', async () => {
    await start();
    expect(w.invokes.map((request) => request.action)).toEqual(['enroll']);
    const identityFile = path.join(keyDir(), 'id_ed25519');
    expect(hostSpec()).toEqual({
      alias: ALIAS, displayName: 'Studio Cloud', previousDisplayName: null, hostname: '203.0.113.7', port: 22, user: 'ubuntu',
      identityFile, hostKeyAlias: `cindy-device-${TARGET}`, userKnownHostsFile: '~/.ssh/cindy_known_hosts', hostKeyFingerprint: HOST_KEY_FP,
    });
    // The device authorizes exactly this computer's dedicated key; the private half never left.
    expect(await targetFile()).toContain(`${await dedicatedPublicKey()} cindy-device:${w.self}`);
    if (process.platform !== 'win32') {
      expect((await fs.stat(identityFile)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(keyDir())).mode & 0o777).toBe(0o700);
    }
    expect(await readText(path.join(controllerHome(), '.ssh', 'cindy_known_hosts'))).toContain(`cindy-device-${TARGET} ${HOST_KEY}\n`);
    expect(await readText(path.join(controllerHome(), '.ssh', 'known_hosts'))).toBe(OWN_KNOWN_HOSTS);
    expect(await states()).toEqual([{ deviceId: TARGET, alias: ALIAS, hostId: ALIAS, state: 'ready', reason: null, blocked: null }]);
    expect(controller.deviceHostFor(ALIAS)).toEqual({ deviceId: TARGET, available: true });

    // This computer reconnects: the device announces the same revision again; no call is made.
    target.peerOnline(w.self);
    await flush();
    expect(w.invokes).toHaveLength(1);

    // The device's public address changes: one status call, and the host follows it.
    w.publicIp = '203.0.113.9';
    target.networkChanged();
    await flush();
    expect(w.invokes.map((request) => request.action)).toEqual(['enroll', 'status']);
    expect(hostSpec()).toMatchObject({ hostname: '203.0.113.9', previousDisplayName: 'Studio Cloud' });
  });

  it('does not enroll while this computer\'s 「控制它」 for the device is off, and does once it is back on', async () => {
    w.controlDisabled = true;
    await start();
    expect(w.invokes).toEqual([]);
    expect(await states()).toEqual([]);
    w.controlDisabled = false;
    controller.settingsChanged();
    await flush();
    expect(w.invokes.map((request) => request.action)).toEqual(['enroll']);
    expect((await states())[0]).toMatchObject({ state: 'ready', hostId: ALIAS });
  });

  it('makes a new key for a profile copied to another computer and enrolls it there', async () => {
    await start();
    const firstKey = await dedicatedPublicKey();
    // The same profile starts on another computer (another device id).
    controller.deactivate();
    w.self = OTHER_COMPUTER;
    controller = makeController();
    controller.activate();
    target.peerOnline(w.self);
    await flush();
    const secondKey = await dedicatedPublicKey();
    expect(secondKey).not.toBe(firstKey);
    expect(await targetFile()).toContain(`${secondKey} cindy-device:${w.self}`);
    expect(hostSpec()?.identityFile).toBe(path.join(keyDir(), 'id_ed25519'));
  });
});

describe('SSH access controller: the person\'s deletion and unavailable devices', () => {
  it('never adds back a host the person deleted, and 「添加到 SSH 远程主机」 brings it back', async () => {
    await start();
    w.hosts.delete(ALIAS);
    controller.hostRemovedByUser(ALIAS);
    await controller.idle();
    expect((await states())[0]).toMatchObject({ state: 'user-deleted', hostId: null, alias: ALIAS });
    expect(controller.deviceHostFor(ALIAS)).toBeNull();

    w.publicIp = '203.0.113.9';
    target.networkChanged();
    await flush();
    expect(w.invokes).toHaveLength(1);
    expect(w.hosts.has(ALIAS)).toBe(false);

    expect((await controller.restoreHost(TARGET))[0]).toMatchObject({ state: 'pending' });
    await flush();
    expect(hostSpec()).toMatchObject({ hostname: '203.0.113.9' });
    expect((await states())[0]).toMatchObject({ state: 'ready', hostId: ALIAS });

    // Deleted from cindy.conf by hand: found missing at the next update and not written again.
    w.hosts.delete(ALIAS);
    w.publicIp = '203.0.113.11';
    target.networkChanged();
    await flush();
    expect(w.hosts.has(ALIAS)).toBe(false);
    expect((await states())[0]).toMatchObject({ state: 'user-deleted' });
  });

  it('marks the host unavailable when the device turns access off, revokes this computer or leaves the account, and recovers', async () => {
    await start();
    await target.setEnabled(false);
    await flush();
    expect((await states())[0]).toMatchObject({ state: 'unavailable', reason: 'off', hostId: ALIAS });
    expect(controller.deviceHostFor(ALIAS)).toEqual({ deviceId: TARGET, available: false });
    expect(w.hosts.has(ALIAS)).toBe(true);
    await target.setEnabled(true);
    await flush();
    expect((await states())[0]).toMatchObject({ state: 'ready' });

    // Revoked there (its link-close reaches this computer); the device keeps nothing of this computer.
    w.targetSettings = { ...w.targetSettings, revokedControllers: [w.self] };
    target.settingsChanged();
    controller.revokedBy(TARGET);
    await flush();
    expect((await states())[0]).toMatchObject({ state: 'unavailable', reason: 'revoked', hostId: ALIAS });
    expect(await targetFile()).not.toContain(await dedicatedPublicKey());
    // Restored there; when this computer is next online the device tells it, and it enrolls again.
    w.targetSettings = { ...w.targetSettings, revokedControllers: [] };
    target.settingsChanged();
    target.peerOnline(w.self);
    await flush();
    expect(w.invokes.at(-1)?.action).toBe('enroll');
    expect((await states())[0]).toMatchObject({ state: 'ready' });

    controller.noteDeviceList([w.self]);
    await controller.idle();
    expect((await states())[0]).toMatchObject({ state: 'unavailable', reason: 'removed', hostId: ALIAS });
    controller.noteDeviceList([w.self, TARGET]);
    await controller.idle();
    expect((await states())[0]).toMatchObject({ state: 'pending' });
    target.peerOnline(w.self);
    await flush();
    expect((await states())[0]).toMatchObject({ state: 'ready' });
    expect(w.hosts.has(ALIAS)).toBe(true);
  });
});

describe('SSH access controller: calls on the shared channel', () => {
  it('asks a device that needs a Cindy update again only after its version changes', async () => {
    w.targetOld = true;
    target = makeTarget();
    controller = makeController();
    controller.activate();
    controller.notePeerVersion(TARGET, '0.1.140');
    await target.activate();
    await flush();
    expect(w.invokes.map((request) => request.action)).toEqual(['enroll']);
    expect(await states()).toEqual([{ deviceId: TARGET, alias: null, hostId: null, state: 'needs-update', reason: null, blocked: null }]);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    controller.notePeerVersion(TARGET, '0.1.140');
    await flush();
    expect(w.invokes).toHaveLength(1);

    w.targetOld = false;
    controller.notePeerVersion(TARGET, '0.1.150');
    await flush();
    expect(w.invokes.map((request) => request.action)).toEqual(['enroll', 'status', 'enroll']);
    expect((await states())[0]).toMatchObject({ state: 'ready', hostId: ALIAS });
  });

  it('retries a busy device after 30 s, 2 min and 10 min, then waits for its next announce', async () => {
    w.busy = 10;
    await start();
    expect(w.invokes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(40_000);
    await controller.idle();
    await vi.advanceTimersByTimeAsync(150_000);
    await controller.idle();
    await vi.advanceTimersByTimeAsync(700_000);
    await controller.idle();
    expect(w.invokes).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    await controller.idle();
    expect(w.invokes).toHaveLength(4);
    w.busy = 0;
    target.peerOnline(w.self);
    await flush();
    expect((await states())[0]).toMatchObject({ state: 'ready' });
  });

  it('keeps one call in flight per device and runs the latest announce once afterwards', async () => {
    w.hold = held();
    await start({ holdCalls: true });
    expect(w.invokes).toHaveLength(1);
    controller.receiveAnnounce(TARGET, { version: 1, enabled: true, revision: 1, authorized: false });
    controller.receiveAnnounce(TARGET, { version: 1, enabled: true, revision: 2, authorized: false });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(w.invokes).toHaveLength(1);
    w.hold.release();
    w.hold = null;
    await flush();
    expect(w.invokes.map((request) => request.action)).toEqual(['enroll', 'enroll']);
    expect((await states())[0]).toMatchObject({ state: 'ready' });
  });

  it('drops a call in flight when the account changes', async () => {
    w.hold = held();
    await start({ holdCalls: true });
    expect(w.invokes).toHaveLength(1);
    w.owner = 'owner-b';
    w.hold.release();
    w.hold = null;
    await flush();
    expect(w.hosts.size).toBe(0);
    expect(await states()).toEqual([]);
    expect(await readText(path.join(controllerHome(), '.ssh', 'cindy_known_hosts'))).toBeNull();
    const ownerA = JSON.parse((await readText(path.join(w.root, 'controller-profile', 'owners', 'owner-a', 'ssh-device-access.json')))!);
    expect(ownerA.targets[TARGET]).toMatchObject({ status: 'pending', hostAdded: false });
  });
});

describe('SSH device hosts IPC body', () => {
  it('validates requests and answers an empty list before the controller exists', async () => {
    await expect(handleSshDeviceHostsRequest(null, { operation: 'restore' })).rejects.toThrow('[INVALID_PARAMS]');
    await expect(handleSshDeviceHostsRequest(null, { operation: 'read', extra: 1 })).rejects.toThrow('[INVALID_PARAMS]');
    await expect(handleSshDeviceHostsRequest(null, { operation: 'read' })).resolves.toEqual([]);
  });
});
