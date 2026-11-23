/*
 * 测试价值
 * - 生产入口与可观察结果：createArtifactsHandlers + OpenArtifactService（tools/list、tools/call 带上宿主核实的任务与工作区，
 *   远程任务拒绝）、createWakeHandler（主人评论进任务输入队列并回答 resumed / queued，其他来源回答 failed 留在收件箱）、
 *   createOpenHandler（页面开在该任务的右侧栏，重复打开聚焦已有页签，含上次运行恢复的同页页签）、
 *   OpenArtifactService.resumeAtLaunch / close（用过这个 home 且本机已有可用运行时才在启动后起守护进程，从不下载；
 *   退出时只停自己起的守护进程，等待有上限；别的应用起的照常运行）、usedHomeBefore（runtimes.json 里有 cindy 适配器）、prepareRuntime / startDaemon（已在运行就照用，
 *   不论版本；本机运行时不低于固定版本才用，否则用 Cindy 自己的副本，按 sha256 + 大小 + 仅 registry.npmjs.org 的校验下载；
 *   经真实 kit 的 ensureDaemon 调 spawnDaemonInUtilityProcess：只起选定的那个运行时，带 threads 与 OPEN_ARTIFACT_HOME、
 *   去掉 ELECTRON_RUN_AS_NODE，输出追加到 daemon.out，进程退出即快速失败），
 *   renderArtifactsSkill（提交的 SKILL.md 与 kit 渲染一致）。
 * - Bug／规则依据：Open Artifact docs/integrating/wake.md「Who sent it」（只有 owner 能成为用户消息）；
 *   docs/product-rules/message-source.md（来源复用 sourcePlugin 的 local-app: 前缀，不新增 origin）；
 *   Open Artifact docs/integrating/runtime.md「Electron」（utility process 里只有 0.14.1 起的运行时能用 worker threads 跑类型服务，旧的会挂住）；
 *   实测：随应用被杀的守护进程留下过期的 daemon.json / daemon.lock，重启后恢复的页签空白、重开又多一个页签；
 *   lifecycle.ts（async 退出钩子共用有上限的预算，不能挂住退出）；
 *   docs/dev-rules/verified-downloads.md（固定摘要与大小、限定主机、不跟随重定向）；
 *   lizi-mcps session-context（工具不信任参数自报身份）；resources/system-skills/README.md（生成的 Skill 不手改）。
 * - 现有覆盖缺口：新模块，没有相邻测试。
 * - 最小失败输入：collaborator 来源的 wake；不带 getSessionContext 结果的调用；remoteHostId 非空的上下文；
 *   本机只有 0.14.0；下载重定向到别的主机；utility process 立刻退出；SKILL.md 被手改一个字节；
 *   从未用过的 home；本机没有运行时；kill 后不退出的守护进程；恢复的页签 URL 带 hash。
 * - tier：unit。真实 socket 只有 kit 自带的 fake daemon（loopback、系统分配端口、afterAll 关闭），
 *   electron 的 utilityProcess 换成内存里的假子进程，home 是 mkdtemp 临时目录，从不碰本人的 ~/.agents/open-artifact。
 * - 实测耗时：约 1.9 s 墙钟（vitest Duration 1.17 s；pnpm --dir apps/desktop exec vitest run src/main/open-artifact/__tests__/openArtifact.test.ts）。
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureDaemon } from '@open-artifact/harness-kit';
import { startFakeDaemon, type FakeDaemon } from '@open-artifact/harness-kit/testing';
import { TOOL_DEFINITIONS, type WakeDeliverParams } from '@open-artifact/protocol';
import type { LiziMcpSessionContext } from '@cindy/mcps';
import type { DownloadOptions } from '../../downloader/index.js';
import { createArtifactsHandlers } from '../tools.js';
import { OpenArtifactService } from '../service.js';
import { createWakeHandler, OPEN_ARTIFACT_SOURCE } from '../wake.js';
import { createOpenHandler, tabsAt } from '../open.js';
import {
  OPEN_ARTIFACT_CLI_ARTIFACT,
  OPEN_ARTIFACT_CLI_SIZE,
  OPEN_ARTIFACT_CLI_VERSION,
  OpenArtifactUnavailableError,
  prepareRuntime,
  startDaemon,
  usedHomeBefore,
} from '../runtime.js';
import { renderArtifactsSkill } from '../skill.js';
import { spawnDaemonInUtilityProcess } from '../daemonSpawn.desktop.js';

// Electron's utility process, as the kit's spawn hook sees it: a child whose output is piped and whose exit is
// observable. The child here prints one line and exits at once, as a runtime that cannot start would.
const fork = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ utilityProcess: { fork } }));

const SKILL_FILE = path.resolve(__dirname, '../../../../resources/system-skills/artifacts/SKILL.md');

// The contract of @cindy/mcps resolveLiziMcpSessionContext that matters here (tested in lizi-mcps itself): a
// host accessor is authoritative, and one that cannot resolve leaves no session. Injected so this file does not load
// the whole @cindy/mcps package (≈4 s of collection).
const resolve = (context: LiziMcpSessionContext): LiziMcpSessionContext =>
  context.getSessionContext ? context.getSessionContext() ?? { ...context, sessionId: undefined, workingDir: '' } : context;

const owner = (session = 's1'): WakeDeliverParams => ({
  session, workspace: '/w', artifact: 'open-artifact://artifact/a1', artifactId: 'a1', text: 'Comment: make it blue',
  source: {
    kind: 'open-artifact.event', artifactId: 'a1', url: 'open-artifact://artifact/a1', title: 'Deck', root: '/w/deck',
    viewUrl: 'http://127.0.0.1:1/a/a1', threads: [], requests: [], summary: 'make it blue', reason: 'comment',
    from: { kind: 'owner' },
  },
} as unknown as WakeDeliverParams);

describe('cindy_artifacts tools through the harness (fake daemon)', () => {
  let fake: FakeDaemon;
  let service: OpenArtifactService;
  const prepare = vi.fn();
  const opened: unknown[] = [];

  beforeAll(async () => {
    fake = await startFakeDaemon({
      onToolCall: (name, args) => ({ ok: true, echo: { name, args } }) as never,
    });
    service = new OpenArtifactService({
      home: fake.home,
      runtime: () => ({ toolsRoot: '/unused' }),
      spawn: vi.fn(),
      open: async (request) => { opened.push(request); return true; },
      prepareRuntime: prepare,
    });
  });
  afterAll(async () => {
    await service.close();
    await fake.close();
  });

  it('lists the bundled definitions before any daemon is connected', async () => {
    const offline = new OpenArtifactService({ home: '/nowhere', runtime: () => ({ toolsRoot: '/x' }), spawn: vi.fn(), open: async () => true });
    const handlers = createArtifactsHandlers(offline, { agentKind: 'claude-code', workingDir: '' }, resolve);
    expect((await handlers.list()).tools.map((tool) => tool.name)).toEqual(TOOL_DEFINITIONS.map((tool) => tool.name));
  });

  it('calls the daemon as the host-attested task and workspace, never the arguments', async () => {
    const context = {
      agentKind: 'codex', workingDir: '', sessionId: undefined,
      getSessionContext: () => ({ agentKind: 'codex', workingDir: '/w', sessionId: 's1' }),
    };
    const handlers = createArtifactsHandlers(service, context, resolve);
    const result = await handlers.call('Artifact', { action: 'list', session: 'forged', workspace: '/elsewhere' });
    expect(result.isError).toBe(false);
    const call = fake.calls.find((entry) => entry.method === 'tools.call');
    expect(call?.params).toEqual({ name: 'Artifact', arguments: { action: 'list', session: 'forged', workspace: '/elsewhere' }, caller: { session: 's1', workspace: '/w' } });
    expect([...fake.sessions.values()]).toContainEqual(expect.objectContaining({ session: 's1', workspace: '/w' }));
    // The daemon was already running: no runtime was prepared, so nothing was downloaded.
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each([
    ['an SSH remote task', { agentKind: 'claude-code', workingDir: '/remote', sessionId: 's2', remoteHostId: 'h1' }, /remote/],
    ['a call whose task cannot be resolved', { agentKind: 'codex', workingDir: '', getSessionContext: () => undefined }, /which one/],
  ])('refuses %s without calling the daemon', async (_name, context, message) => {
    const before = fake.calls.filter((entry) => entry.method === 'tools.call').length;
    const result = await createArtifactsHandlers(service, context as LiziMcpSessionContext, resolve).call('Artifact', { action: 'list' });
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(message) }] });
    expect(fake.calls.filter((entry) => entry.method === 'tools.call')).toHaveLength(before);
  });

  it('hands daemon wakes to the session bridge and page opens to the open handler', async () => {
    const wake = vi.fn(async () => 'resumed' as const);
    service.setSessionBridge({ wake, isInTurn: () => false, observeTurns: () => () => undefined });
    expect(await fake.wake({ session: 's1', text: 'Comment: hi' })).toMatchObject({ status: 'resumed' });
    expect(wake).toHaveBeenCalledWith(expect.objectContaining({ session: 's1', text: 'Comment: hi' }));
    expect(await fake.open({ url: 'open-artifact://artifact/a1', view_url: 'http://127.0.0.1:1/a/a1', session: 's1' })).toEqual({ opened: true });
    expect(opened).toContainEqual(expect.objectContaining({ session: 's1', viewUrl: 'http://127.0.0.1:1/a/a1' }));
  });

  it('reports running / idle when an attached task starts or ends a turn', async () => {
    let notify: (sessionId: string) => void = () => undefined;
    let inTurn = true;
    service.setSessionBridge({ wake: async () => 'failed', isInTurn: () => inTurn, observeTurns: (listener) => { notify = listener; return () => undefined; } });
    notify('s1');
    expect((await fake.waitFor('session.status')).params).toMatchObject({ session: 's1', status: 'running' });
    inTurn = false;
    notify('s1');
    expect((await fake.waitFor('session.status')).params).toMatchObject({ session: 's1', status: 'idle' });
  });
});

describe('comment wakes', () => {
  it.each([
    ['an idle task resumes', false, 'resumed'],
    ['a busy task queues it as its next turn', true, 'queued'],
  ])('owner comment: %s', async (_name, busy, answer) => {
    const send = vi.fn(async () => ({ ok: true as const, wakeKind: 'queued' }));
    const handler = createWakeHandler({ send, isBusy: () => busy });
    expect(await handler(owner())).toBe(answer);
    expect(send).toHaveBeenCalledWith({
      targetSessionId: 's1', message: 'Comment: make it blue', clientId: expect.stringMatching(/^open-artifact-/),
      forceQueue: true, resumeWithStoredPermissionMode: true, sourcePlugin: { ...OPEN_ARTIFACT_SOURCE },
    });
  });

  it.each([
    ['a collaborator comment stays a notice', { ...owner(), source: { ...owner().source, from: { kind: 'collaborator', name: 'Eve', role: 'commenter' } } }, true],
    ['a system notice stays a notice', { ...owner(), source: { ...owner().source, from: { kind: 'system' } } }, true],
    ['a task Cindy cannot deliver to', owner('gone'), false],
  ])('%s: answers failed so the daemon keeps it', async (_name, params, sendSkipped) => {
    const send = vi.fn(async () => ({ ok: false as const, errorCode: 'NOT_FOUND' }));
    expect(await createWakeHandler({ send, isBusy: () => false })(params as WakeDeliverParams)).toBe('failed');
    expect(send).toHaveBeenCalledTimes(sendSkipped ? 0 : 1);
  });
});

describe('opening pages in the right sidebar', () => {
  it('opens the full page in the task sidebar, focuses it again, and reopens a closed tab', async () => {
    const dispatch = vi.fn()
      .mockResolvedValueOnce({ reqId: '1', ok: true, tabId: 't1' })
      .mockResolvedValueOnce({ reqId: '2', ok: true, tabId: 't1' })
      .mockResolvedValueOnce({ reqId: '3', ok: false, error: 'tab t1 not found' })
      .mockResolvedValueOnce({ reqId: '4', ok: true, tabId: 't2' });
    const open = createOpenHandler({ dispatch, activeSessionId: () => null });
    const request = { session: 's1', url: 'open-artifact://artifact/a1', viewUrl: 'http://127.0.0.1:9/a/a1', embedUrl: 'http://127.0.0.1:9/e/a1' };
    expect(await open(request)).toBe(true);
    expect(await open(request)).toBe(true);
    expect(await open(request)).toBe(true);
    expect(dispatch.mock.calls.map(([op]) => op)).toEqual([
      { op: 'open', sessionId: 's1', url: 'http://127.0.0.1:9/a/a1' },
      { op: 'focus', sessionId: 's1', tabId: 't1' },
      { op: 'focus', sessionId: 's1', tabId: 't1' },
      { op: 'open', sessionId: 's1', url: 'http://127.0.0.1:9/a/a1' },
    ]);
  });

  it('focuses the tab restored from the last run that shows the same page, instead of adding a second one', async () => {
    const dispatch = vi.fn(async (_op: unknown) => ({ reqId: '1', ok: true as const, tabId: 'r1' }));
    const sessionTabs = vi.fn(() => [
      { tabId: 'other', url: 'http://127.0.0.1:9/a/a2' },
      { tabId: 'r1', url: 'http://127.0.0.1:9/a/a1#c=3' },
    ]);
    const open = createOpenHandler({ dispatch, activeSessionId: () => null, sessionTabs });
    const request = { session: 's1', url: 'open-artifact://artifact/a1', viewUrl: 'http://127.0.0.1:9/a/a1', embedUrl: 'http://127.0.0.1:9/e/a1' };
    expect(await open(request)).toBe(true);
    expect(sessionTabs).toHaveBeenCalledWith('s1');
    expect(dispatch.mock.calls.map(([op]) => op)).toEqual([{ op: 'focus', sessionId: 's1', tabId: 'r1' }]);
    // Only pages of the daemon that came back are reloaded.
    expect(tabsAt([{ tabId: 'a', url: 'http://127.0.0.1:9/a/a1' }, { tabId: 'b', url: 'https://example.com/' }], 'http://127.0.0.1:9')
      .map((tab) => tab.tabId)).toEqual(['a']);
  });

  it.each([
    ['uses the task in front for a page opened without a task', 'front', true],
    ['shows nothing when no task is in front', null, false],
  ])('%s', async (_name, active, shown) => {
    const dispatch = vi.fn(async () => ({ reqId: '1', ok: true as const, tabId: 't' }));
    const open = createOpenHandler({ dispatch, activeSessionId: () => active });
    expect(await open({ session: null, url: 'u', viewUrl: 'http://v', embedUrl: 'http://e' })).toBe(shown);
    expect(dispatch).toHaveBeenCalledTimes(shown ? 1 : 0);
  });
});

describe('runtime acquisition', () => {
  let toolsRoot: string;
  beforeAll(async () => { toolsRoot = await mkdtemp(path.join(os.tmpdir(), 'cindy-oa-runtime-')); });
  afterAll(async () => { await rm(toolsRoot, { recursive: true, force: true }); });

  const OWN_BIN = '/m/gen/package/scripts/open-artifact.mjs';
  const own = { source: 'cindy', bin: OWN_BIN, runtime: { dir: '/m/gen/package', version: OPEN_ARTIFACT_CLI_VERSION, update: 'bundled' } };
  const computer = (version: string) => vi.fn(() => ({ tries: [{ bin: `/r/${version}/scripts/open-artifact.mjs`, version, env: { R: version } }], override: false }));
  const base = () => ({
    toolsRoot, home: path.join(toolsRoot, 'home'),
    readDaemon: vi.fn(async () => null),
    daemonStartPlan: vi.fn(() => ({ tries: [], override: false })),
    installedTool: vi.fn(async () => undefined as string | undefined),
    runtimeInfo: vi.fn(() => ({ bin: 'b', version: OPEN_ARTIFACT_CLI_VERSION, protocols: { min: 1, max: 1 } })),
    installTool: vi.fn(),
    download: vi.fn(),
  });

  it.each([
    ['a running daemon is used as it is, whatever its version', { readDaemon: vi.fn(async () => ({ url: 'http://127.0.0.1:1', version: '0.13.0' }) as never) }, { source: 'running' }],
    ['a newer runtime on this computer is used', { daemonStartPlan: computer('9.0.0') }, { source: 'computer', bin: '/r/9.0.0/scripts/open-artifact.mjs', version: '9.0.0', env: { R: '9.0.0' } }],
    ['an installed copy is reused', { installedTool: vi.fn(async () => OWN_BIN) }, own],
    // A 0.14.0 runtime would start the Electron helper as Node from the utility process and hang.
    ['a computer runtime older than the pinned one is passed over for the installed copy', { daemonStartPlan: computer('0.14.0'), installedTool: vi.fn(async () => OWN_BIN) }, own],
  ])('%s, without downloading', async (_name, override, expected) => {
    const deps = { ...base(), ...override };
    await expect(prepareRuntime(deps)).resolves.toEqual(expected);
    expect(deps.installTool).not.toHaveBeenCalled();
  });

  it('downloads the pinned tarball only from the registry, with its size and digest, when the computer has only an older runtime', async () => {
    const deps = { ...base(), daemonStartPlan: computer('0.14.0') };
    deps.installTool.mockImplementation(async (input: { artifact: unknown }, installDeps: { download: (o: DownloadOptions) => Promise<unknown> }) => {
      expect(input.artifact).toBe(OPEN_ARTIFACT_CLI_ARTIFACT);
      await installDeps.download({ url: OPEN_ARTIFACT_CLI_ARTIFACT.url, sha256: OPEN_ARTIFACT_CLI_ARTIFACT.sha256, targetPath: '/t' });
      return OWN_BIN;
    });
    await expect(prepareRuntime(deps)).resolves.toEqual(own);
    const options = deps.download.mock.calls[0]![0] as DownloadOptions;
    expect(options).toMatchObject({ url: `https://registry.npmjs.org/@open-artifact/cli/-/cli-${OPEN_ARTIFACT_CLI_VERSION}.tgz`, sha256: OPEN_ARTIFACT_CLI_ARTIFACT.sha256, expectedSize: OPEN_ARTIFACT_CLI_SIZE, redirect: 'error' });
    expect(options.isUrlAllowed?.('https://registry.npmjs.org/x.tgz')).toBe(true);
    expect(options.isUrlAllowed?.('https://evil.example/x.tgz')).toBe(false);
    expect(options.isUrlAllowed?.('http://registry.npmjs.org/x.tgz')).toBe(false);
  });

  it('a failed download fails with a readable error instead of hanging', async () => {
    const deps = { ...base(), installTool: vi.fn(async () => { throw new Error('CHECKSUM'); }) };
    await expect(prepareRuntime(deps)).rejects.toMatchObject({ name: 'OpenArtifactUnavailableError', code: 'runtime_download_failed' });
  });

  it('starts exactly the chosen runtime through the utility process, in threads mode, and fails fast when it exits', async () => {
    const home = path.join(toolsRoot, 'spawn-home');
    fork.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
      setImmediate(() => {
        child.stderr.end('cannot start\n');
        child.stdout.end();
        child.emit('exit', 1);
      });
      return child;
    });
    const before = { ...process.env };
    process.env.ELECTRON_RUN_AS_NODE = '1';
    const started = Date.now();
    try {
      await expect(startDaemon(home, own as never, spawnDaemonInUtilityProcess, ensureDaemon))
        .rejects.toMatchObject({ code: 'daemon_start_failed', message: expect.stringContaining(path.join(home, 'logs', 'daemon.out')) });
    } finally {
      process.env = before;
    }
    // The returned process ends the wait at once instead of after the kit's 15 s timeout, and no older runtime is tried.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fork).toHaveBeenCalledTimes(1);
    const [bin, args, options] = fork.mock.calls[0]!;
    expect([bin, args]).toEqual([OWN_BIN, ['daemon', 'run']]);
    expect(options).toMatchObject({ stdio: 'pipe', serviceName: 'Open Artifact', env: { OPEN_ARTIFACT_HOME: home, OPEN_ARTIFACT_NODE_CHILDREN: 'threads' } });
    expect(options.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    await vi.waitFor(async () => expect(await readFile(path.join(home, 'logs', 'daemon.out'), 'utf8')).toContain('cannot start'));
  });

  it('passes a computer runtime\'s own environment to the kit', async () => {
    const ensure = vi.fn(async () => ({ url: 'http://127.0.0.1:1' }) as never);
    const spawn = vi.fn();
    await startDaemon('/h', { source: 'computer', bin: '/r/b.mjs', version: '9.0.0', env: { R: '1' } }, spawn, ensure);
    expect(ensure).toHaveBeenCalledWith({ home: '/h', bin: '/r/b.mjs', version: '9.0.0', env: { R: '1' }, spawn });
  });
});

describe('launch and quit', () => {
  const OWN = { source: 'cindy', bin: '/m/package/scripts/open-artifact.mjs', runtime: { dir: '/m/package', version: OPEN_ARTIFACT_CLI_VERSION, update: 'bundled' } } as const;
  const URL_ = 'http://127.0.0.1:7';
  /** A daemon process that exits on kill() (or, with `stubborn`, never does). */
  const child = (stubborn = false) => {
    const c = Object.assign(new EventEmitter(), { kill: vi.fn(() => { if (!stubborn) setImmediate(() => c.emit('exit', 0)); return true; }) });
    return c;
  };
  const make = (over: { running?: boolean; used?: boolean; local?: unknown; proc?: ReturnType<typeof child> } = {}) => {
    let up = over.running ?? false;
    const proc = over.proc ?? child();
    const harness = { ready: vi.fn(async () => undefined), connected: true, close: vi.fn() };
    const deps = {
      home: '/h',
      runtime: () => ({ toolsRoot: '/t' }),
      open: async () => true,
      spawn: vi.fn(() => proc),
      readDaemon: vi.fn(async () => (up ? { url: URL_ } : null) as never),
      usedHomeBefore: vi.fn(() => over.used ?? true),
      localRuntime: vi.fn(async () => ('local' in over ? over.local : OWN) as never),
      prepareRuntime: vi.fn(),
      startDaemon: vi.fn(async (_home: string, _prepared: unknown, spawn: (s: never) => unknown) => {
        await spawn({ bin: OWN.bin, args: ['daemon', 'run'], env: {}, logFile: '/l' } as never);
        up = true;
        return { url: URL_ } as never;
      }),
      createHarness: vi.fn(async () => harness as never),
      stopWaitMs: 100,
    };
    return { service: new OpenArtifactService(deps), deps, proc, harness };
  };

  it('starts the daemon after launch from a runtime on disk when Cindy used this home before, never downloading', async () => {
    const { service, deps } = make();
    await expect(service.resumeAtLaunch()).resolves.toBe(URL_);
    expect(deps.startDaemon).toHaveBeenCalledWith('/h', OWN, expect.any(Function));
    expect(deps.spawn).toHaveBeenCalledTimes(1);
    expect(deps.prepareRuntime).not.toHaveBeenCalled();
  });

  it.each([
    ['Cindy never used this home', { used: false }],
    ['no runtime that can start here is on disk (that waits for the first tool call)', { local: null }],
  ])('starts nothing at launch when %s', async (_name, over) => {
    const { service, deps } = make(over);
    await expect(service.resumeAtLaunch()).resolves.toBeNull();
    expect(deps.startDaemon).not.toHaveBeenCalled();
    expect(deps.prepareRuntime).not.toHaveBeenCalled();
  });

  it('connects to a daemon another app runs, and leaves it running at quit', async () => {
    const { service, deps, proc, harness } = make({ running: true });
    await expect(service.resumeAtLaunch()).resolves.toBeNull();
    expect(deps.createHarness).toHaveBeenCalledTimes(1);
    await service.close();
    expect(harness.close).toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('asks the daemon it started to stop at quit and waits for its exit', async () => {
    const { service, proc } = make();
    await service.resumeAtLaunch();
    await service.close();
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });

  it('gives up waiting after the bound when the daemon does not exit, so quit never hangs', async () => {
    const { service, proc } = make({ proc: child(true) });
    await service.resumeAtLaunch();
    const started = Date.now();
    await service.close();
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('does not stop a daemon that already ended on its own', async () => {
    const { service, proc } = make();
    await service.resumeAtLaunch();
    proc.emit('exit', 0);
    await service.close();
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it.each([
    ['Cindy connected before', { runtimes: [], adapters: { cindy: { protocols: { min: 1, max: 1 }, seenAt: 'x' } } }, true],
    ['only other apps connected', { runtimes: [], adapters: { dsh: { protocols: { min: 1, max: 1 }, seenAt: 'x' } } }, false],
    ['the file cannot be read', null, false],
  ])('the "used before" signal: %s', (_name, file, used) => {
    const read = vi.fn(() => { if (!file) throw new Error('EACCES'); return file; });
    expect(usedHomeBefore('/h', read as never)).toBe(used);
  });
});

describe('the /artifacts system Skill', () => {
  it('is exactly what the pinned kit renders (regenerate it after a kit upgrade, never edit by hand)', async () => {
    expect(await readFile(SKILL_FILE, 'utf8')).toBe(renderArtifactsSkill());
  });
});
