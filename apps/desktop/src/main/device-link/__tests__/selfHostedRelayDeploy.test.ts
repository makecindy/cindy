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
 * - 单文件实测：0.82 秒（Windows）；新增流式进度用例覆盖命令结束前回报及超时退出。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-relay-deploy-test-'));
const appPath = path.join(appRoot, 'apps', 'desktop');
const bundleDir = path.join(appRoot, 'packages', 'device-link-relay', 'dist');
fs.mkdirSync(appPath, { recursive: true });
fs.mkdirSync(bundleDir, { recursive: true });
fs.writeFileSync(path.join(bundleDir, 'relay.mjs'), 'export {};\n');

type Exec = { stdout: string; stderr: string; exitCode: number | null };
const mocks = vi.hoisted(() => ({
  responses: {} as Record<string, (command: string, input?: Buffer) => Exec>,
  commands: [] as Array<{ label: string; command: string }>,
  ensureReady: vi.fn(async () => undefined),
  stream: vi.fn(),
}));

vi.mock('electron', () => ({ app: { getAppPath: () => appPath } }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../remote-ssh/index.js', () => ({
  ensureRemoteHostReady: mocks.ensureReady,
  getRemoteSshPool: () => ({
    get: () => ({
      execStream: mocks.stream,
      exec: vi.fn(async (command: string, options: { label: string; input?: Buffer }) => {
        mocks.commands.push({ label: options.label, command });
        if (options.label === 'relay-deploy-upload') {
          mocks.responses[options.label]?.(command, options.input);
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

import { checkRelayServer, deployRelayToServer, uninstallRelayFromServer, RelayDeployError } from '../selfHostedRelayDeploy';

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
    onProgress: () => {},
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
    mocks.stream.mockImplementation(async (command: string) => {
      mocks.commands.push({ label: 'relay-deploy-runtime', command });
      let stdout: (value: string) => void = () => {};
      let stderr: (value: string) => void = () => {};
      let close: (value: { code: number }) => void = () => {};
      return {
        onStdout: (cb: typeof stdout) => { stdout = cb; return () => {}; },
        onStderr: (cb: typeof stderr) => { stderr = cb; return () => {}; },
        onClose: (cb: typeof close) => { close = cb; return () => {}; },
        onError: () => () => {},
        end: () => queueMicrotask(() => {
          const result = mocks.responses['relay-deploy-runtime']?.(command) ?? ok('');
          stdout(result.stdout);
          stderr(result.stderr);
          close({ code: result.exitCode ?? 0 });
        }),
        kill: vi.fn(),
      };
    });
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

  afterEach(() => { vi.useRealTimers(); });

  afterAll(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    fs.rmSync(appRoot, { recursive: true, force: true });
  });

  it('runs every step through sudo -n and checks the relay over https', async () => {
    const result = await run();
    expect(result.error).toBeNull();
    expect(result.steps).toEqual(['check', 'runtime', 'upload', 'configure', 'certificate', 'verify']);
    const privileged = mocks.commands.filter((c) => c.label !== 'relay-deploy-probe');
    expect(privileged.length).toBeGreaterThan(0);
    expect(privileged.every((c) => c.command.startsWith('sudo -n bash -c '))).toBe(true);
    expect(fetch).toHaveBeenCalledWith('https://203.0.113.10/api/device-link/relay/info', expect.anything());
  });

  // 2026-10-29：下载中界面没有反馈；旧 exec 等待命令结束才拿到输出。
  // 最小输入：SSH 分片输出一个进度标记后保持运行；unit，回调必须先于下载完成，且不透传原文。
  it('reports allowlisted download events before the SSH command finishes', async () => {
    let emit!: (chunk: string) => void;
    let finish!: (value: { code: number }) => void;
    mocks.stream.mockImplementationOnce(async () => ({
      onStdout: (cb: typeof emit) => { emit = cb; return () => {}; },
      onStderr: () => () => {},
      onClose: (cb: typeof finish) => { finish = cb; return () => {}; },
      onError: () => () => {},
      end: () => {},
      kill: vi.fn(),
    }));
    const progress = vi.fn();
    const steps = vi.fn();
    const promise = deployRelayToServer({
      sshHostId: 'my-vps', address: '203.0.113.10', baseUrl: 'https://203.0.113.10',
      replaceExisting: false, init, preferMirror: false, onStep: steps, onProgress: progress,
    });
    const result = promise.then(value => ({ value, error: null }), error => ({ value: null, error }));
    await vi.waitFor(() => expect(emit).toBeTypeOf('function'));
    emit('private server output\nPROG');
    emit('RESS runtime-download\nPROGRESS unknown-value\n');
    expect(progress.mock.calls).toEqual([['runtime-download']]);
    expect(steps).not.toHaveBeenCalledWith('upload');
    emit('PROGRESS runtime-checksum\nNODE_READY v24.22.1\n');
    finish({ code: 0 });
    await vi.runAllTimersAsync();
    expect((await result).error).toBeNull();
    expect(progress).toHaveBeenCalledWith('runtime-checksum');
  });

  // 下载卡住或进度处理抛错时，须结束 channel 并交回失败结果，不能留下下载或让异步事件异常崩溃。
  it.each(['timeout', 'progress-error'] as const)('ends the download on %s without uploading', async (failure) => {
    const kill = vi.fn();
    const opened = vi.fn();
    let emit: (chunk: string) => void = () => {};
    mocks.stream.mockImplementationOnce(async () => ({
      onStdout: (cb: typeof emit) => { emit = cb; return () => {}; }, onStderr: () => () => {},
      onClose: () => () => {}, onError: () => () => {},
      end: () => {
        opened();
        if (failure === 'progress-error') queueMicrotask(() => emit('PROGRESS runtime-download\n'));
      },
      kill,
    }));
    const promise = run({ onProgress: () => { throw new Error('progress display failed'); } });
    const { error } = await promise;
    expect(opened).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ code: 'DOWNLOAD_FAILED', detail: failure === 'timeout' ? 'runtime download timed out' : 'progress display failed' });
    expect(kill).toHaveBeenCalledOnce();
    expect(mocks.commands.some(c => c.label === 'relay-deploy-upload')).toBe(false);
  });

  it.each([
    [
      'no root or passwordless sudo',
      { 'relay-deploy-probe': () => ok(PROBE_SUDO.replace('ROOT sudo', 'ROOT none')) },
      'NEEDS_ROOT',
      undefined,
    ],
    // 2026-10-29 实机：选中 git@git.xindong.com，原提示为“只支持 64 位 Linux”并附 `? ?`。
    ['an SSH account without a shell', { 'relay-deploy-probe': () => ok('') }, 'SHELL_UNAVAILABLE', undefined],
    ['port 80 used by another program', { 'relay-deploy-inspect': () => ok('BUSY 80 apache2\n') }, 'PORT_BUSY', 'apache2'],
    // 2026-10-29 实机：Nginx 跑在 Docker 容器里，原来只报 docker-proxy 和“已有 Nginx 会自动配置”。
    [
      'ports published by a Docker container',
      { 'relay-deploy-inspect': () => ok('BUSY 80 docker:fp2-server-nginx-1,\nBUSY 443 docker:fp2-server-nginx-1,\n') },
      'PORT_BUSY_CONTAINER',
      'fp2-server-nginx-1',
    ],
    [
      'Node rejecting the uploaded Nginx helper before it can emit JSON',
      {
        'relay-deploy-inspect': () => ok('BUSY 80 nginx\n'),
        'relay-deploy-nginx-prepare': () => ({ stdout: '', stderr: 'TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension\n', exitCode: 1 }),
      },
      'NGINX_FAILED',
      'ERR_UNKNOWN_FILE_EXTENSION',
    ],
    [
      'runtime download failing with a server error',
      { 'relay-deploy-runtime': () => ({ stdout: 'ERROR DOWNLOAD\n', stderr: 'curl: (22) HTTP 404\n', exitCode: 21 }) },
      'DOWNLOAD_FAILED',
      'curl: (22) HTTP 404',
    ],
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
    const onServerChange = vi.fn();
    const { error } = await run({ onServerChange });
    expect(error).toBeInstanceOf(RelayDeployError);
    expect(error).toMatchObject({ code, detail });
    // 停下时不会走到写配置、重启服务那一步(证书失败除外:那时服务已经配置好)。
    const configured = mocks.commands.some((c) => c.label === 'relay-deploy-configure');
    expect(configured).toBe(code === 'CERTIFICATE_FAILED');
    // 检查阶段停下时还没动服务器:调用方不能保存部署记录(否则界面会出现一个从未装上的中转)。
    const checkStage = ['SHELL_UNAVAILABLE', 'NEEDS_ROOT', 'PORT_BUSY', 'PORT_BUSY_CONTAINER', 'RELAY_MISMATCH'].includes(code);
    expect(onServerChange).toHaveBeenCalledTimes(checkStage ? 0 : 1);
  });

  // 部署表单选服务器时自动检查：只能读，不能安装或改配置；结论决定界面能否点「开始部署」。
  // 最小输入：系统 Nginx 占着 80，服务器上是本机主人的中转。tier: unit。
  it('checks a server read-only and reports the plan and existing relay', async () => {
    mocks.responses['relay-deploy-probe'] = () => ok(`${PROBE_SUDO}DISTRO Debian GNU/Linux 13 (trixie)\n`);
    mocks.responses['relay-deploy-inspect'] = () => ok(`BUSY 80 nginx\nSTATE 2 ${init.relayId} ${init.ownerPublicKey}\n`);
    await expect(checkRelayServer('my-vps', init)).resolves.toEqual({
      system: 'Debian GNU/Linux 13 (trixie) · x86_64',
      plan: 'nginx',
      existing: 'mine',
    });
    await expect(checkRelayServer('my-vps', null)).resolves.toMatchObject({ existing: 'other' });
    expect(new Set(mocks.commands.map((c) => c.label))).toEqual(new Set(['relay-deploy-probe', 'relay-deploy-inspect']));
  });

  // 2026-10-29 实机：中转第一次连 Let's Encrypt 时 `fetch failed`(会自行重试)，部署方读到 failed 就回滚。
  // 最小输入：status 先报 transient 失败再 ready；或一直 transient 到等待超时。tier: unit，假时钟。
  it('waits while the relay retries an unreachable certificate authority', async () => {
    // 等待截止时间按 Date 计算:改用同时伪造 Date 的假时钟,超时分支才不会真的等四分钟。
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const unreachable = (at: string) =>
      ok(`ACTIVE active\nSTATUS {"certificate":{"state":"failed","transient":true,"error":"could not reach the certificate authority (ECONNRESET)","updatedAt":"${at}"}}\n`);
    let polls = 0;
    mocks.responses['relay-deploy-status'] = () =>
      ++polls < 3 ? unreachable('t1') : ok('ACTIVE active\nSTATUS {"certificate":{"state":"ready"}}\n');
    const progress = vi.fn();
    const recovered = await run({ onProgress: progress });
    expect(recovered.error).toBeNull();
    expect(progress.mock.calls.filter(([message]) => message === 'certificate-retry')).toHaveLength(1);

    mocks.responses['relay-deploy-status'] = () => unreachable(`t${++polls}`);
    const { error } = await run();
    expect(error).toMatchObject({ code: 'CA_UNREACHABLE', detail: expect.stringContaining('ECONNRESET') });
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

  // 2026-10-29 实机：临时程序 relay.mjs.new 被 Node 拒绝，Nginx prepare 尚未执行就失败。
  // 旧 SSH fake 从不加载上传文件，未覆盖后缀。unit：使用生产命令实际指定的文件名，
  // 在现有唯一临时目录写入上传内容，再由本进程的原生 Node ESM loader 加载；无子进程或网络。
  it('uploads a staged program that the Node ESM loader can run during Nginx preparation', async () => {
    let invokedPath = '';
    mocks.responses['relay-deploy-inspect'] = () => ok('BUSY 80 nginx\n');
    mocks.responses['relay-deploy-upload'] = (command, input) => {
      const uploadedPath = /cat > (\S+)/.exec(command)![1];
      fs.writeFileSync(path.join(appRoot, path.posix.basename(uploadedPath)), input!);
      return ok('');
    };
    mocks.responses['relay-deploy-nginx-prepare'] = (command) => {
      const staged = /if \[ -f (\S+) \]; then BUNDLE=([^;\s]+)/.exec(command)!;
      const selected = fs.existsSync(path.join(appRoot, path.posix.basename(staged[1])))
        ? staged[2] : /\bBUNDLE=(\S+)/.exec(command)![1];
      invokedPath = path.join(appRoot, path.posix.basename(selected));
      return ok('{"event":"nginx","port":47822,"challengePort":47823,"existingCertificate":false}\n');
    };
    const result = await run();
    expect(result.error).toBeNull();
    // 绕开 Vitest 的源码转换，保留与服务器 Node 相同的文件扩展名判据。
    const nativeImport = compileFunction('return import(specifier)', ['specifier'], {
      importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    }) as (specifier: string) => Promise<unknown>;
    await expect(nativeImport(pathToFileURL(invokedPath).href)).resolves.toBeDefined();
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

  // Bug：部署停在检查端口时服务器上还没有设备档案，移除却报“不是这台电脑部署的”，只能本机移除。
  // 最小输入：INSPECT 没有 STATE；tier: unit，观察移除成功并执行了服务器清理。
  it('removes an incomplete deployment that never wrote device records', async () => {
    mocks.responses['relay-deploy-inspect'] = () => ok('');
    mocks.responses['relay-deploy-uninstall'] = () => ok('UNINSTALLED\n');
    await expect(uninstallRelayFromServer('my-vps', init, true, () => {})).resolves.toBeUndefined();
    expect(mocks.commands.some((c) => c.label === 'relay-deploy-uninstall')).toBe(true);
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
