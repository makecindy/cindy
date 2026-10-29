/**
 * 测试价值
 * - 生产入口与可观察结果:`deployRelayToServer` —— 「部署到我的服务器」按服务器上的实际情况决定继续还是停下,
 *   以及停下时给用户的错误码与原因(界面据此告诉用户去开安全组、换服务器还是清掉旧中转)。
 * - Bug/规则依据:docs/self-hosted-relay-plan.md §15.3:没有 root / 免密 sudo 时停下而不索要密码;
 *   80/443 被占时不覆盖别人的服务;服务器上已有别人的中转时不覆盖;证书失败时把 CA 给的原因带回来;
 *   非 root 时所有改动经 `sudo -n`。
 * - 现有覆盖缺口:部署脚本本身已在 systemd 容器 + Pebble 里实测(见方案),但「服务器输出 → 错误码」的判断只在这里。
 * - 最小失败输入:每条用例一种服务器状态(ROOT none / BUSY 80 / 别的主人的 STATE / 证书 failed)与一条成功路径。
 * - tier:unit。SSH 主机、HTTPS 检查为进程内 fake;轮询等待用 fake timers,不做真实等待。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-relay-deploy-test-'));
const appPath = path.join(appRoot, 'apps', 'desktop');
const bundleDir = path.join(appRoot, 'packages', 'device-link-relay', 'dist');
fs.mkdirSync(appPath, { recursive: true });
fs.mkdirSync(bundleDir, { recursive: true });
fs.writeFileSync(path.join(bundleDir, 'relay.mjs'), 'export {};\n');

type Exec = { stdout: string; stderr: string; exitCode: number | null };
const mocks = vi.hoisted(() => ({
  responses: {} as Record<string, (command: string) => Exec>,
  commands: [] as Array<{ label: string; command: string }>,
  ensureReady: vi.fn(async () => undefined),
}));

vi.mock('electron', () => ({ app: { getAppPath: () => appPath } }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../remote-ssh/index.js', () => ({
  ensureRemoteHostReady: mocks.ensureReady,
  getRemoteSshPool: () => ({
    get: () => ({
      exec: vi.fn(async (command: string, options: { label: string; input?: Buffer }) => {
        mocks.commands.push({ label: options.label, command });
        if (options.label === 'relay-deploy-upload') {
          const { createHash } = await import('node:crypto');
          return {
            stdout: `SHA ${createHash('sha256').update(options.input!).digest('hex')}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        const respond = mocks.responses[options.label];
        return respond ? respond(command) : { stdout: '', stderr: '', exitCode: 0 };
      }),
    }),
  }),
}));

import { deployRelayToServer, uninstallRelayFromServer, RelayDeployError } from '../selfHostedRelayDeploy';

const ok = (stdout: string): Exec => ({ stdout, stderr: '', exitCode: 0 });
const PROBE_SUDO = 'OS Linux\nARCH x86_64\nROOT sudo\nSYSTEMD yes\nIPV6 no\nFETCH yes\n';
const init = {
  name: 'My relay',
  relayId: '0b7a4a52-8f6a-4d55-9a53-3f1f6f2c9e10',
  ownerUserId: 'u1',
  ownerDeviceId: 'pc-1',
  ownerDeviceName: 'PC',
  ownerCredentialHash: 'a'.repeat(64),
  ownerPublicKey: 'Q'.repeat(43),
  ownerCert: { v: 1 },
};

async function run(overrides: Partial<Parameters<typeof deployRelayToServer>[0]> = {}) {
  const steps: string[] = [];
  const promise = deployRelayToServer({
    sshHostId: 'my-vps',
    address: '203.0.113.10',
    baseUrl: 'https://203.0.113.10',
    replaceExisting: false,
    init,
    preferMirror: false,
    onStep: (step) => steps.push(step),
    ...overrides,
  });
  const settled = promise.then(
    (value) => ({ value, error: null }),
    (error: unknown) => ({ value: null, error }),
  );
  await vi.runAllTimersAsync();
  return { ...(await settled), steps };
}

describe('deployRelayToServer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    mocks.commands = [];
    mocks.ensureReady.mockReset().mockResolvedValue(undefined);
    mocks.responses = {
      'relay-deploy-probe': () => ok(PROBE_SUDO),
      'relay-deploy-runtime': () => ok('NODE_READY v24.22.1\n'),
      'relay-deploy-configure': () => ok('INITIALIZED\nCONFIGURED\n'),
      'relay-deploy-status': () => ok(`ACTIVE active\nSTATUS {"certificate":{"state":"ready","identifier":"203.0.113.10"}}\n`),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ relayId: init.relayId }), { status: 200 })),
    );
  });

  afterAll(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    fs.rmSync(appRoot, { recursive: true, force: true });
  });

  it('runs every step through sudo -n and checks the relay over https', async () => {
    const result = await run();
    expect(result.error).toBeNull();
    expect(result.steps).toEqual(['connect', 'check', 'runtime', 'upload', 'configure', 'certificate', 'verify']);
    const privileged = mocks.commands.filter((c) => c.label !== 'relay-deploy-probe');
    expect(privileged.length).toBeGreaterThan(0);
    expect(privileged.every((c) => c.command.startsWith('sudo -n bash -c '))).toBe(true);
    expect(fetch).toHaveBeenCalledWith('https://203.0.113.10/api/device-link/relay/info', expect.anything());
  });

  it.each([
    [
      'no root or passwordless sudo',
      { 'relay-deploy-probe': () => ok(PROBE_SUDO.replace('ROOT sudo', 'ROOT none')) },
      'NEEDS_ROOT',
      undefined,
    ],
    ['port 80 used by another program', { 'relay-deploy-inspect': () => ok('BUSY 80 apache2\n') }, 'PORT_BUSY', '80 apache2'],
    [
      'a relay owned by someone else',
      { 'relay-deploy-inspect': () => ok(`STATE 2 ${init.relayId} ${'R'.repeat(43)}\n`) },
      'RELAY_MISMATCH',
      undefined,
    ],
    [
      'the CA rejecting validation',
      {
        'relay-deploy-status': () =>
          ok('ACTIVE active\nSTATUS {"certificate":{"state":"failed","error":"validation failed: connection refused"}}\n'),
      },
      'CERTIFICATE_FAILED',
      'validation failed: connection refused',
    ],
  ])('stops on %s', async (_label, responses, code, detail) => {
    Object.assign(mocks.responses, responses);
    const { error } = await run();
    expect(error).toBeInstanceOf(RelayDeployError);
    expect(error).toMatchObject({ code, detail });
    // 停下时不会走到写配置、重启服务那一步(证书失败除外:那时服务已经配置好)。
    const configured = mocks.commands.some((c) => c.label === 'relay-deploy-configure');
    expect(configured).toBe(code === 'CERTIFICATE_FAILED');
  });

  // 2026-10-29: 用户要求已有 Nginx 时自动部署，而不是让用户停网站或复制配置。
  // 缺口：旧入口对 BUSY 80 nginx 一律返回 PORT_BUSY。最小输入：两个端口均为 Nginx。
  // tier: unit；检查生产入口的结果、自动选择和失败后的恢复请求。
  it('automatically deploys behind the existing Nginx and restores it if verification fails', async () => {
    mocks.responses['relay-deploy-inspect'] = () => ok('BUSY 80 nginx\nBUSY 443 nginx\nBUSY 443 nginx\n');
    mocks.responses['relay-deploy-nginx-prepare'] = () =>
      ok('{"event":"nginx","port":47822,"challengePort":47823,"existingCertificate":false}\n');
    const success = await run();
    expect(success.error).toBeNull();
    expect(mocks.commands.some((c) => c.label === 'relay-deploy-nginx-activate')).toBe(true);
    expect(mocks.commands.some((c) => c.label === 'relay-deploy-nginx-commit')).toBe(true);
    const configure = mocks.commands.find((c) => c.label === 'relay-deploy-configure')!;
    // 远端命令的参数协议：复用 Nginx 后只允许中转监听回环地址及探测出的空闲端口。
    expect(configure.command).toContain("'203.0.113.10' '127.0.0.1' 'https://203.0.113.10'");
    expect(configure.command).toContain("'nginx-acme' '47822' '47823'");
    mocks.commands = [];
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 502 }));
    const failed = await run();
    expect(failed.error).toMatchObject({ code: 'NOT_REACHABLE' });
    expect(mocks.commands.some((c) => c.label === 'relay-deploy-nginx-rollback')).toBe(true);
    expect(mocks.commands.some((c) => c.label === 'relay-deploy-nginx-commit')).toBe(false);
  });

  it('uses the existing trusted HTTPS certificate without waiting for a new certificate', async () => {
    mocks.responses['relay-deploy-inspect'] = () => ok('BUSY 80 nginx\nBUSY 443 nginx\n');
    mocks.responses['relay-deploy-nginx-prepare'] = () =>
      ok('{"event":"nginx","port":47820,"challengePort":47821,"existingCertificate":true}\n');
    const { error } = await run();
    expect(error).toBeNull();
    expect(mocks.commands.some(c => c.label === 'relay-deploy-status')).toBe(false);
    expect(mocks.commands.find(c => c.label === 'relay-deploy-configure')!.command).toContain("'nginx-existing' '47820' '47821'");
  });

  it('replaces a foreign relay only when asked to', async () => {
    mocks.responses['relay-deploy-inspect'] = () => ok(`STATE 2 other-relay ${'R'.repeat(43)}\n`);
    const { error } = await run({ replaceExisting: true });
    expect(error).toBeNull();
    const configure = mocks.commands.find((c) => c.label === 'relay-deploy-configure')!;
    // 第 4 个位置参数是 REPLACE。
    expect(configure.command).toContain(`'203.0.113.10' '0.0.0.0' 'https://203.0.113.10' '1'`);
  });

  // #7722 discussion_r4402946293:保留数据卸载后 Node 已移除，初次检查无法读取身份。
  // 先恢复运行环境再读取；匹配身份才能继续，其他主人或仍不可读时不能上传/写配置。tier: unit。
  it.each([
    [`2 ${init.relayId} ${init.ownerPublicKey}`, true],
    [`2 ${init.relayId} ${'R'.repeat(43)}`, false],
    ['unknown', false],
  ])('rechecks retained data after restoring Node: %s', async (state, matches) => {
    let inspections = 0;
    mocks.responses['relay-deploy-inspect'] = () => ok(`STATE ${++inspections === 1 ? 'unknown' : state}\n`);
    const { error } = await run();
    expect(mocks.commands.some((c) => c.label === 'relay-deploy-runtime')).toBe(true);
    expect(inspections).toBe(2);
    if (matches) expect(error).toBeNull();
    else expect(error).toMatchObject({ code: 'RELAY_MISMATCH' });
    expect(mocks.commands.some((c) => c.label === 'relay-deploy-upload')).toBe(matches);
    expect(mocks.commands.some((c) => c.label === 'relay-deploy-configure')).toBe(matches);
  });

  it('does not access another account’s SSH connection after the owner changes while connecting', async () => {
    let current = true;
    mocks.ensureReady.mockImplementationOnce(async () => {
      current = false;
    });
    const { error } = await run({
      assertCurrent: () => {
        if (!current) throw new Error('owner changed');
      },
    });
    expect(error).toMatchObject({ message: 'owner changed' });
    expect(mocks.commands).toEqual([]);
  });

  // Bug：RELAY_MISMATCH 失败后仍有本地记录，卸载不能绕过部署时的身份保护。
  // 最小输入：同一 SSH 主机的 STATE 属于另一主人；tier: unit，观察没有卸载写操作。
  it('refuses uninstall when the server belongs to another relay owner', async () => {
    mocks.responses['relay-deploy-inspect'] = () => ok(`STATE 2 ${init.relayId} ${'R'.repeat(43)}\n`);
    await expect(uninstallRelayFromServer('my-vps', init, true, () => {})).rejects.toMatchObject({
      code: 'RELAY_MISMATCH',
    });
    expect(mocks.commands.some((c) => c.label === 'relay-deploy-uninstall')).toBe(false);
  });

  it('uninstalls a matching relay and rejects an identity changed before deletion', async () => {
    mocks.responses['relay-deploy-inspect'] = () => ok(`STATE 2 ${init.relayId} ${init.ownerPublicKey}\n`);
    await expect(uninstallRelayFromServer('my-vps', init, true, () => {})).resolves.toBeUndefined();
    mocks.responses['relay-deploy-uninstall'] = () => ({
      stdout: 'RELAY_MISMATCH\n',
      stderr: '',
      exitCode: 22,
    });
    await expect(uninstallRelayFromServer('my-vps', init, true, () => {})).rejects.toMatchObject({
      code: 'RELAY_MISMATCH',
    });
  });
});
