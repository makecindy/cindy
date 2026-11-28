import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshAccessAnnounce } from '@cindy/device-link';
import { CLOUD_GUEST_FILE_MARKER } from '../authorizedKeysFile.js';
import { createSshAccessTarget, type SshAccessSettings, type SshAccessTarget } from '../sshAccessTargetCore.js';
import { SSH_ACCESS_MAX_MANUAL_KEYS } from '../sshAccessRecord.js';
import { handleSshAccessRequest } from '../ipc.desktop.js';

vi.mock('../../logger', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }));
// The settings IPC body (ipc.desktop.ts) is exercised below without Electron or the desktop assembly.
vi.mock('electron', () => ({ ipcMain: { handle() {} }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent() {}, isTrustedAppRendererWindow: () => true }));
vi.mock('../sshAccessTarget.desktop.js', () => ({ currentSshAccessTarget: () => null }));

// 测试价值
// - 生产入口与可观察结果：createSshAccessTarget 的 activate / handleRemote / settingsChanged / noteDeviceList / readLocal /
//   setEnabled / removeDevice，平台事实经端口注入，home 与 profile 用真实临时目录；断言磁盘上的授权文件、远端回包、
//   结束会话的指纹与发出的 announce。
// - Bug／规则依据：spec 决定 2–4、9、11、12 与 2026-11-26 补充（云电脑文件首行标记、手工文件先导入为 manual 再接管）；
//   protocol 记录 device-link-ssh-access.md 的 announce 规则与 server-channel-review.md（关着时不发）。
// - 现有覆盖缺口：新模块；文件写入与会话结束各自有单测，这里验证它们在什么时候被触发。
// - 最小失败输入：恢复默认后仍保留 true；撤销后 authorized_keys 里还有那一行；换账号后旧账号的 key 还在；
//   另一台设备用同一把 key 登记；关着时对没有 key 的电脑发 announce；启动时把已移除设备的 key 写回云电脑文件；
//   不能按设备断开会话时（以 root 运行）readLocal 仍说能断开；添加公钥到上限时设置页只拿到「稍后重试」。
// - tier：unit（真实 fs 只在 mkdtemp 目录，平台与网络全部注入，announce 去抖用假计时器，单文件约 1s）。
const KEY_A = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJfYPtO9L0UmsOJcs+BJ3iMNHFGtQIONiQHLRdZfuvr7';
const FP_A = 'SHA256:djvBZ5K68oGMBtD5pFWRAPELgttcdadkztqINg63Joc';
const KEY_B = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMaGP9ZBWsUOAER5H5Zf4eYmzMBURk1Zj2heBDSMKSOi';
const FP_B = 'SHA256:mPr78KSflLHkRNgS3SpYoVqLKVcOT11nnMVTK+2G96Q';
const KEY_C = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJKEt0idaTeuNCEMu+wXT8G+Y6mBJ+zDXpCTg20sfDgC';

/** A distinct well-formed ssh-ed25519 key line per index (the 32 key bytes repeat index + 1). */
function ed25519Key(index: number): string {
  const field = (bytes: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, bytes.length]), bytes]);
  return `ssh-ed25519 ${Buffer.concat([field(Buffer.from('ssh-ed25519')), field(Buffer.alloc(32, index + 1))]).toString('base64')}`;
}

interface Harness {
  home: string;
  userData: string;
  owner: string | null;
  settings: SshAccessSettings;
  cloudGuest: boolean;
  sshdReachable: boolean;
  peers: string[];
  directory: string[] | null;
  directoryReads: number;
  announces: Array<[string, SshAccessAnnounce]>;
  terminated: string[][];
  revoked: string[];
  /** What the fake terminator says it can do: end particular keys' sessions (Linux, not as root). */
  endsKeySessions: boolean;
}

let h: Harness;
let targets: SshAccessTarget[] = [];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-ssh-target-'));
  h = {
    home: path.join(root, 'home'), userData: path.join(root, 'profile'), owner: 'owner-a',
    settings: { remoteControlEnabled: true, revokedControllers: [] }, cloudGuest: false, sshdReachable: true, peers: ['laptop', 'studio'],
    directory: ['laptop', 'studio', 'phone'], directoryReads: 0, announces: [], terminated: [], revoked: [], endsKeySessions: true,
  };
});
afterEach(async () => {
  for (const target of targets) target.deactivate();
  targets = [];
  vi.useRealTimers();
  await fs.rm(path.dirname(h.home), { recursive: true, force: true });
});

function makeTarget(platform = 'linux'): SshAccessTarget {
  const target = createSshAccessTarget({
    platform,
    homeDir: () => h.home,
    profileKey: 'profileA',
    ownerScope: () => (h.owner ? `cloud:${h.owner}:1` : null),
    recordPath: () => (h.owner ? path.join(h.userData, 'owners', h.owner, 'ssh-access.json') : null),
    managedCloudInstance: () => false,
    detectCloudGuest: async () => h.cloudGuest,
    readSettings: () => h.settings,
    writeEnabledOverride: async (value) => {
      const { sshAccessEnabled: _previous, ...rest } = h.settings;
      h.settings = value === undefined ? rest : { ...rest, sshAccessEnabled: value };
    },
    onlineDesktopPeers: () => h.peers,
    sendAnnounce: (deviceId, payload) => { h.announces.push([deviceId, payload]); },
    revokeDevice: async (deviceId) => {
      h.revoked.push(deviceId);
      h.settings = { ...h.settings, revokedControllers: [...h.settings.revokedControllers, deviceId] };
    },
    readDeviceDirectory: async () => { h.directoryReads += 1; return h.directory; },
    probeSshd: async () => h.sshdReachable,
    readEndpointFacts: async () => ({ user: 'ubuntu', port: 22, lanAddresses: [{ kind: 'lan', host: '10.0.0.5' }], mdnsName: null, hostKeys: [KEY_C] }),
    readPublicIpv4: async () => '203.0.113.7',
    terminator: {
      endsKeySessions: h.endsKeySessions,
      terminateFingerprints: async (fingerprints) => { h.terminated.push([...fingerprints].sort()); return { supported: true, terminated: fingerprints.size, unmapped: 0 }; },
      terminateAll: async () => ({ supported: true, terminated: 0, unmapped: 0 }),
    },
    log: { info() {}, warn() {} },
  });
  targets.push(target);
  return target;
}

const userFile = () => path.join(h.home, '.ssh', 'authorized_keys');
const cloudFile = () => path.join(h.home, '.ssh', 'cindy-owner-authorized-keys');
const readText = (file: string) => fs.readFile(file, 'utf8').catch(() => null);
const recordFile = (owner = 'owner-a') => path.join(h.userData, 'owners', owner, 'ssh-access.json');
const enroll = (target: SshAccessTarget, deviceId: string, publicKey: string) =>
  target.handleRemote(deviceId, { action: 'enroll', requestId: `req-${deviceId}-0001`, publicKey });
/** Every queued reconcile has run once these reads (queued behind them) return. */
async function settle(target: SshAccessTarget) { for (let i = 0; i < 3; i += 1) await target.readLocal(); }

describe('SSH access target: effective setting', () => {
  it('stores only the person\'s choice, follows the default after "restore default", and empties the file while off', async () => {
    const target = makeTarget();
    await target.activate();
    expect(await target.readLocal()).toMatchObject({
      supported: true, setting: false, defaultSetting: false, customized: false, enabled: false, endsDeviceSessions: true,
    });

    await target.setEnabled(true);
    expect(h.settings.sshAccessEnabled).toBe(true);
    expect((await enroll(target, 'laptop', KEY_A)).authorized).toBe(true);
    expect(await readText(userFile())).toContain(`${KEY_A} cindy-device:laptop`);

    // Restoring the default deletes the stored choice (default off here): the line leaves, the record keeps the key.
    const restored = await target.setEnabled(null);
    expect('sshAccessEnabled' in h.settings).toBe(false);
    expect(restored).toMatchObject({ setting: false, customized: false, enabled: false });
    expect(restored.devices).toEqual([expect.objectContaining({ deviceId: 'laptop', fingerprint: FP_A, active: false })]);
    expect(await readText(userFile())).toBe('');
    expect(h.terminated).toEqual([[FP_A]]);

    // Master switch off ⇒ off even with an explicit choice; back on ⇒ the kept key returns.
    await target.setEnabled(true);
    expect(await readText(userFile())).toContain(KEY_A);
    h.settings = { ...h.settings, remoteControlEnabled: false };
    target.settingsChanged();
    expect((await target.readLocal()).enabled).toBe(false);
    expect(await readText(userFile())).toBe('');
    h.settings = { ...h.settings, remoteControlEnabled: true };
    target.settingsChanged();
    await settle(target);
    expect(await readText(userFile())).toContain(KEY_A);
  });

  it('is on by default on a Cindy cloud guest, whose file always starts with the marker line', async () => {
    h.cloudGuest = true;
    const target = makeTarget();
    await target.activate();
    expect(await target.readLocal()).toMatchObject({ cloudGuest: true, defaultSetting: true, setting: true, enabled: true,
      endpoint: { user: 'ubuntu', port: 22, addresses: [{ kind: 'public', host: '203.0.113.7' }, { kind: 'lan', host: '10.0.0.5' }] } });
    await enroll(target, 'laptop', KEY_A);
    expect(await readText(cloudFile())).toBe(`${CLOUD_GUEST_FILE_MARKER}\n# >>> Cindy SSH access profileA >>>\n${KEY_A} cindy-device:laptop\n# <<< Cindy SSH access profileA <<<\n`);
    await target.setEnabled(false);
    expect(await readText(cloudFile())).toBe(`${CLOUD_GUEST_FILE_MARKER}\n`);
    await target.setEnabled(null);
    expect(await readText(cloudFile())).toContain(KEY_A);
    expect(await readText(userFile())).toBeNull();
  });

  it('reports Windows as unsupported and never writes there', async () => {
    const target = makeTarget('win32');
    await target.activate();
    const status = await target.handleRemote('laptop', { action: 'status' });
    expect(status).toMatchObject({ enabled: false, blocked: 'PLATFORM_UNSUPPORTED', authorized: false, endpoint: null });
    await expect(enroll(target, 'laptop', KEY_A)).rejects.toThrow('[SSH_ACCESS_DISABLED]');
    expect(await readText(userFile())).toBeNull();
  });
});

describe('SSH access target: keys', () => {
  it('enrolls idempotently, replaces the caller\'s own key without ending its sessions, and refuses a key another device holds', async () => {
    h.settings.sshAccessEnabled = true;
    const target = makeTarget();
    await target.activate();
    const first = await enroll(target, 'laptop', KEY_A);
    expect(first).toMatchObject({ version: 1, enabled: true, blocked: null, authorized: true, endpoint: { user: 'ubuntu', port: 22 } });
    expect(await enroll(target, 'laptop', KEY_A)).toEqual(first);
    await expect(enroll(target, 'studio', KEY_A)).rejects.toThrow('[SSH_ACCESS_KEY_IN_USE]');
    await target.addManualKey(`${KEY_C} me@home`, '');
    await expect(enroll(target, 'studio', KEY_C)).rejects.toThrow('[SSH_ACCESS_KEY_IN_USE]');

    await enroll(target, 'laptop', KEY_B);
    const content = await readText(userFile());
    expect(content).toContain(`${KEY_B} cindy-device:laptop`);
    expect(content).not.toContain(KEY_A);
    expect(content).toContain(`${KEY_C} cindy-manual:me@home`);
    expect(h.terminated).toEqual([]);
    expect(await target.handleRemote('laptop', { action: 'withdraw', requestId: 'withdraw-0001' })).toMatchObject({ authorized: false });
    expect(await readText(userFile())).not.toContain(KEY_B);
    expect(h.terminated).toEqual([]);
    await expect(target.handleRemote('laptop', { action: 'enroll', requestId: 'x', publicKey: KEY_A })).rejects.toThrow('[SSH_ACCESS_INVALID]');

    await target.setEnabled(false);
    await expect(enroll(target, 'studio', KEY_B)).rejects.toThrow('[SSH_ACCESS_DISABLED]');
  });

  it('drops the line and ends that key\'s sessions on revocation, removal from the account and an account switch', async () => {
    h.settings.sshAccessEnabled = true;
    const target = makeTarget();
    await target.activate();
    await enroll(target, 'laptop', KEY_A);
    await enroll(target, 'studio', KEY_B);
    await target.addManualKey(KEY_C, 'work');

    // Revoked in 「它可以：控制本机」 (settings change from anywhere).
    h.settings = { ...h.settings, revokedControllers: ['laptop'] };
    target.settingsChanged();
    await settle(target);
    expect(await readText(userFile())).not.toContain(KEY_A);
    expect(h.terminated).toEqual([[FP_A]]);
    expect(JSON.parse((await readText(recordFile()))!).devices).not.toHaveProperty('laptop');

    // Removed from the account: a complete device list without it.
    target.noteDeviceList(['laptop', 'phone'], Date.now());
    await settle(target);
    expect(await readText(userFile())).not.toContain(KEY_B);
    expect(h.terminated).toEqual([[FP_A], [FP_B]]);

    // Another account signs in on this computer: the previous owner's keys leave, its record stays.
    h.owner = 'owner-b';
    await target.activate();
    expect(await readText(userFile())).toBe('');
    expect(h.terminated.at(-1)).toEqual(['SHA256:XySgr8Xym3UBX0xPo8AkyHRPb4jhTA2wFX9VQNbhHCU']);
    expect(JSON.parse((await readText(recordFile('owner-a')))!).manualKeys).toHaveLength(1);
  });

  it('removes a device row by revoking its remote access and reports the sessions it ended', async () => {
    h.settings.sshAccessEnabled = true;
    const target = makeTarget();
    await target.activate();
    await enroll(target, 'studio', KEY_B);
    const result = await target.removeDevice('studio');
    expect(h.revoked).toEqual(['studio']);
    expect(result).toMatchObject({ revoked: true, sessions: { supported: true, terminated: 1, unmapped: 0 } });
    expect(result.state.devices).toEqual([]);
    expect(await readText(userFile())).not.toContain(KEY_B);
    expect((await target.removeDevice('studio')).revoked).toBe(false);
  });

  it('tells the settings UI before a revocation whether the device\'s sessions can be ended here', async () => {
    // Linux with Cindy running as root: the terminator cannot end particular keys' sessions, whatever the platform.
    h.endsKeySessions = false;
    const target = makeTarget('linux');
    await target.activate();
    expect((await target.readLocal()).endsDeviceSessions).toBe(false);
  });
});

describe('SSH access target: cloud guest boot', () => {
  it('imports a hand-maintained file as manual keys before taking it over, then clears the boot gate', async () => {
    h.cloudGuest = true;
    await fs.mkdir(path.join(h.home, '.ssh'), { recursive: true });
    await fs.writeFile(cloudFile(), `# kept by me\n${KEY_C} me@home\n`);
    await fs.writeFile(`${cloudFile()}.held`, `${CLOUD_GUEST_FILE_MARKER}\n${KEY_A} cindy-device:old\n`);
    const target = makeTarget();
    await target.activate();
    const state = await target.readLocal();
    expect(state.manualKeys).toEqual([expect.objectContaining({ label: 'imported', active: true })]);
    expect(await readText(cloudFile())).toBe(`${CLOUD_GUEST_FILE_MARKER}\n# >>> Cindy SSH access profileA >>>\n${KEY_C} cindy-manual:imported\n# <<< Cindy SSH access profileA <<<\n`);
    expect(await readText(`${cloudFile()}.held`)).toBeNull();
  });

  it('never takes over a hand-maintained file with keys it cannot import, and leaves the held copy to the image', async () => {
    h.cloudGuest = true;
    await fs.mkdir(path.join(h.home, '.ssh'), { recursive: true });
    const handMade = `ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQDP863DXU2kt+JxGl4OIGkm5niIiGGWywhJGTjR7FoN me\n${KEY_C}\n`;
    await fs.writeFile(cloudFile(), handMade);
    await fs.writeFile(`${cloudFile()}.held`, `${CLOUD_GUEST_FILE_MARKER}\n`);
    const target = makeTarget();
    await target.activate();
    expect(await target.readLocal()).toMatchObject({ enabled: true, blocked: 'AUTHORIZED_KEYS_UNSUPPORTED', manualKeys: [] });
    expect(await readText(cloudFile())).toBe(handMade);
    expect(await readText(`${cloudFile()}.held`)).not.toBeNull();
  });

  it('reads the device list before the first write so a device removed while it was off never gets back in', async () => {
    h.cloudGuest = true;
    await fs.mkdir(path.dirname(recordFile()), { recursive: true });
    await fs.writeFile(recordFile(), JSON.stringify({ version: 1, manualKeys: [], devices: {
      laptop: { publicKey: KEY_A, fingerprint: FP_A, enrolledAt: 1 }, studio: { publicKey: KEY_B, fingerprint: FP_B, enrolledAt: 2 } } }));
    h.directory = ['laptop'];
    const target = makeTarget();
    await target.activate();
    expect(h.directoryReads).toBe(1);
    const content = await readText(cloudFile());
    expect(content).toContain(KEY_A);
    expect(content).not.toContain(KEY_B);
  });

  it('keeps cloud device keys held when the first directory read fails, then releases only listed devices', async () => {
    h.cloudGuest = true;
    h.directory = null;
    await fs.mkdir(path.dirname(recordFile()), { recursive: true });
    await fs.mkdir(path.dirname(cloudFile()), { recursive: true });
    await fs.writeFile(recordFile(), JSON.stringify({ version: 1, manualKeys: [], devices: {
      laptop: { publicKey: KEY_A, fingerprint: FP_A, enrolledAt: 1 },
      studio: { publicKey: KEY_B, fingerprint: FP_B, enrolledAt: 2 },
    } }));
    await fs.writeFile(`${cloudFile()}.held`, `${CLOUD_GUEST_FILE_MARKER}\n${KEY_A} cindy-device:laptop\n${KEY_B} cindy-device:studio\n`);
    const target = makeTarget();
    const starting = target.activate();
    await vi.advanceTimersByTimeAsync(10_000);
    await starting;
    expect(await readText(cloudFile())).not.toContain(KEY_A);
    expect(await readText(cloudFile())).not.toContain(KEY_B);
    expect(await readText(`${cloudFile()}.held`)).not.toBeNull();

    h.directory = ['laptop'];
    target.noteDeviceList(h.directory, Date.now());
    await settle(target);
    expect(await readText(cloudFile())).toContain(KEY_A);
    expect(await readText(cloudFile())).not.toContain(KEY_B);
    expect(await readText(`${cloudFile()}.held`)).toBeNull();
  });
});

describe('SSH access target: announce', () => {
  it('announces when local sshd becomes reachable without a settings or network change', async () => {
    h.settings.sshAccessEnabled = true;
    h.sshdReachable = false;
    const target = makeTarget();
    await target.activate();
    expect((await target.readLocal()).blocked).toBe('SSHD_UNREACHABLE');
    await vi.advanceTimersByTimeAsync(1_000);
    h.announces.length = 0;
    h.sshdReachable = true;
    await vi.advanceTimersByTimeAsync(30_000);
    await target.readLocal();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.announces.some(([, payload]) => payload.enabled && payload.authorized === false)).toBe(true);
    expect((await target.readLocal()).blocked).toBeNull();
  });

  it('sends nothing while off to peers without a key, then one push per peer for each change', async () => {
    const target = makeTarget();
    await target.activate();
    target.peerOnline('laptop');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.announces).toEqual([]);

    await target.setEnabled(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.announces.map(([id, payload]) => [id, payload.enabled, payload.authorized])).toEqual([['laptop', true, false], ['studio', true, false]]);
    const revision = h.announces[0]![1].revision;

    h.announces = [];
    await enroll(target, 'laptop', KEY_A);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.announces).toEqual([]); // the reply already told the caller
    target.peerOnline('laptop');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.announces).toEqual([['laptop', { version: 1, enabled: true, revision, authorized: true }]]);

    h.announces = [];
    await target.setEnabled(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.announces.map(([id, payload]) => [id, payload.enabled])).toEqual([['laptop', false], ['studio', false]]);
    h.announces = [];
    target.peerOnline('studio');
    target.peerOnline('laptop');
    await vi.advanceTimersByTimeAsync(1_000);
    // Off: only the peer that still has a key here hears it again.
    expect(h.announces.map(([id]) => id)).toEqual(['laptop']);
  });
});

// 设置 IPC 的业务体：结构校验在调用被控端之前，被控端错误映射成 IPC 错误码且不带内部细节
// (engineering-conventions §2、electron-security §5)。真实被控端驱动一条完整的添加 / 移除，其余用替身计数。
describe('SSH access settings IPC body', () => {
  it('runs the operations on the real target and maps its errors', async () => {
    h.settings.sshAccessEnabled = true;
    const target = makeTarget();
    await target.activate();
    const added = await handleSshAccessRequest(target, { operation: 'add-key', publicKey: `${KEY_C} me@home`, label: 'Work laptop' });
    expect(added).toMatchObject({ fingerprint: 'SHA256:XySgr8Xym3UBX0xPo8AkyHRPb4jhTA2wFX9VQNbhHCU',
      state: { manualKeys: [{ label: 'Work laptop', active: true }] } });
    await expect(handleSshAccessRequest(target, { operation: 'add-key', publicKey: KEY_C })).rejects.toThrow('[ALREADY_EXISTS]');
    await expect(handleSshAccessRequest(target, { operation: 'add-key', publicKey: `no-pty ${KEY_A}` })).rejects.toThrow('[INVALID_PARAMS]');
    await expect(handleSshAccessRequest(target, { operation: 'remove-key', fingerprint: 'SHA256:XySgr8Xym3UBX0xPo8AkyHRPb4jhTA2wFX9VQNbhHCU' }))
      .resolves.toMatchObject({ manualKeys: [] });
    expect(h.terminated).toEqual([['SHA256:XySgr8Xym3UBX0xPo8AkyHRPb4jhTA2wFX9VQNbhHCU']]);
  });

  // At the limit of added keys the dialog must say so (its own IPC code), not "try again later"; the Host command line
  // keeps the wire code.
  it('refuses a key past the limit of added keys with a code of its own', async () => {
    h.settings.sshAccessEnabled = true;
    const target = makeTarget();
    await target.activate();
    const keys = Array.from({ length: SSH_ACCESS_MAX_MANUAL_KEYS + 1 }, (_, index) => ed25519Key(index));
    for (const key of keys.slice(0, -1)) await target.addManualKey(key);
    await expect(handleSshAccessRequest(target, { operation: 'add-key', publicKey: keys.at(-1)! }))
      .rejects.toThrow(/^\[SSH_ACCESS_KEY_LIMIT\] /);
    await expect(target.addManualKey(keys.at(-1)!)).rejects.toMatchObject({ code: 'SSH_ACCESS_UNAVAILABLE' });
    expect((await target.readLocal()).manualKeys).toHaveLength(SSH_ACCESS_MAX_MANUAL_KEYS);
  });

  it('rejects malformed requests before the target and hides unexpected failures', async () => {
    const calls: string[] = [];
    const fake = new Proxy({}, { get: (_target, name) => async () => { calls.push(String(name)); throw new Error('/Users/someone/.ssh: EACCES'); } });
    for (const request of [{ operation: 'drop-all' }, { operation: 'read', extra: 1 }, { operation: 'remove-key', fingerprint: 'md5:aa' },
      { operation: 'add-key', publicKey: 'x'.repeat(5000) }, { operation: 'set-enabled', enabled: 'yes' }, { operation: 'remove-device' }]) {
      await expect(handleSshAccessRequest(fake as SshAccessTarget, request), JSON.stringify(request).slice(0, 60)).rejects.toThrow('[INVALID_PARAMS]');
    }
    expect(calls).toEqual([]);
    await expect(handleSshAccessRequest(null, { operation: 'read' })).rejects.toThrow('[PRECONDITION_FAILED]');
    await expect(handleSshAccessRequest(fake as SshAccessTarget, { operation: 'end-sessions' })).rejects.toThrow(/^\[INTERNAL\] SSH access request failed$/);
  });
});
