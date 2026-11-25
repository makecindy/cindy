/**
 * sshChannelLifecycle — #12571 SSH 通道生命周期的真实入口验证。
 *
 * 依据(为什么存在): 现场看到同一条 SSH 连接下挂着多条 cc-mgr bridge 进程,
 * 无法回答「通道标识是否真到远端进程环境、客户端 dispose/detach 是否真把
 * 远端进程收掉」。structural 断言(remoteCcQueryFactory.test.ts)只能锁住
 * 源码形态,证明不了跨进程行为。
 *
 * 生产入口: desktop main 的 openCcManagerSession(cc-manager-client.ts),
 * 经真实 RemoteHost(ssh2 Client)连到本测试内嵌的 ssh2 Server
 * (127.0.0.1 环回)。远端命令**原样**经 /bin/sh -c 执行 —— $HOME 指向测试
 * 临时目录, REMOTE_XDT_NODE_PATH 是指向 process.execPath 的 symlink,
 * cc-mgr.mjs 是本测试写入的 stub(daemon 模式开真 unix socket;bridge 模式
 * 讲 NDJSON RPC)。不碰用户 SSH 凭据/known_hosts/家目录任何文件。
 *
 * 清理证明的归因(评审要求「不得用服务端人为杀进程作为证明」):
 * fake sshd 只做真实 sshd 的两件事 —— 把客户端经 SSH wire 发来的 signal
 * 请求原样投递给被 exec 的进程(session 'signal' → child.kill(name)),
 * 通道关闭时给子进程 stdin 送 EOF;它**从不主动 kill**。因此远端进程退出
 * 当且仅当由客户端动作(handle.kill 的 TERM / channel close 的 EOF)引起。
 * 断言落在 stub 自报的 bridge **node 进程** pid 上,而不是 sshd 直接 exec
 * 的 sh 包装进程 —— sh 先死而 node 苟活正是 #12571 的孤儿形态。
 * 每个用例在清理动作前先断言 bridge 存活(control),排除 fixture 提前杀
 * 进程的可能;TERM 到达与否由 sshd 侧的 signal 记录佐证。
 *
 * 覆盖缺口: codex app-server proxy 通道(codex-remote-transport)与 pi 通道
 * 未在本文件覆盖 —— 它们共用同一个 withSshChannelTrace/ExecStreamHandle
 * kill 语义,但各自的 transport close 路径未在此验证。
 *
 * 最小失败输入: 若 handle.kill() 遗漏, bridge 进程仍存活;若 export 前缀
 * 丢掉/拼错, stub 自报的 trace 环境变量与客户端命令里的 id 对不上。
 *
 * tier: integration(真实子进程和环回 SSH 服务);当前 harness 仅支持 Linux。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { Server as SshServer, type ServerChannel, type Session } from 'ssh2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteHost } from '@cindy/maker-remote-ssh';
import type { HostConfig, HostKeyStore } from '@cindy/maker-remote-ssh';

// cc-manager-client 的唯一重依赖:messagePersistBroadcaster.desktop 拉
// DB/electron 链。closeTransport 里的 drainPersistQueue 与本测试断言无关,隔离掉。
vi.mock('../../messagePersistBroadcaster.desktop.js', () => ({
  drainPersistQueue: async (): Promise<void> => {},
}));

import { openCcManagerSession } from '../cc-manager-client';

/* ============================== stub bundle ============================== */

/**
 * 写入 fake $HOME/.xdt-server/v1/cc-manager/cc-mgr.mjs 的 stub。
 * daemon 模式: 真 listen unix socket(探活命令的 [ -S sock ] 靠它)。
 * bridge 模式: stdin/stdout NDJSON RPC;自报 pid + 进程环境里的 trace id;
 * 收到的方法名追加到 CINDY_STUB_LOG_FILE(detach 不得出现 query/close 的判据);
 * hello 在 CINDY_STUB_FAIL_HELLO_FILE 存在时回 error(open-failed 路径的注入)。
 */
const STUB_BUNDLE = String.raw`
import net from 'node:net';
import fs from 'node:fs';

const args = process.argv.slice(2);
const mode = args[0];
const sockIdx = args.indexOf('--socket');
const sock = sockIdx >= 0 ? args[sockIdx + 1] : '';
const logFile = process.env.CINDY_STUB_LOG_FILE || '';
const failHelloFile = process.env.CINDY_STUB_FAIL_HELLO_FILE || '';
function note(line) {
  if (!logFile) return;
  try { fs.appendFileSync(logFile, line + '\n'); } catch { /* best effort */ }
}

if (mode === 'daemon') {
  const srv = net.createServer((c) => { c.on('error', () => {}); c.resume(); });
  srv.on('error', (err) => { process.stderr.write('daemon listen error: ' + err.message + '\n'); process.exit(1); });
  srv.listen(sock, () => note('daemon-listening'));
  // 永不自行退出 — 由测试结束时的 cleanup 显式终止。
} else if (mode === 'bridge') {
  process.stderr.write(
    'BRIDGE_READY pid=' + process.pid + ' trace=' + (process.env.CINDY_SSH_CHANNEL_ID || '') + '\n',
  );
  // 跟真 bridge 一样连 daemon socket — socket 真实被消费,不只是文件存在。
  const conn = net.createConnection(sock);
  conn.on('error', () => {});
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d.toString('utf8');
    for (;;) {
      const idx = buf.indexOf('\n');
      if (idx < 0) break;
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type !== 'request') continue;
      note('rpc ' + msg.method);
      const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
      if (msg.method === 'protocol/hello' && failHelloFile && fs.existsSync(failHelloFile)) {
        send({ type: 'response', id: msg.id, error: { code: 'INTERNAL', message: 'stub hello failure' } });
      } else if (msg.method === 'protocol/hello') {
        send({ type: 'response', id: msg.id, result: { protocolVersion: 5, managerVersion: 'stub' } });
      } else if (msg.method === 'session/list') {
        send({ type: 'response', id: msg.id, result: { sessions: [] } });
      } else if (msg.method === 'query/start') {
        send({ type: 'response', id: msg.id, result: { sessionId: msg.params.sessionId, sdkSessionId: 'sdk-stub' } });
      } else if (msg.method === 'query/close') {
        send({ type: 'response', id: msg.id, result: {} });
      } else {
        send({ type: 'response', id: msg.id, error: { code: 'UNKNOWN_METHOD', message: msg.method } });
      }
    }
  });
  // 真实 bridge 语义: stdin EOF(通道关闭)= 客户端走了,自行退出,不等信号。
  process.stdin.on('end', () => process.exit(0));
}
`;

/* ============================== fake sshd ============================== */

interface ExecRecord {
  command: string;
  child: ChildProcess;
  stderrText: () => string;
  signals: string[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

interface FakeSshd {
  port: number;
  execs: ExecRecord[];
  close: () => Promise<void>;
}

/**
 * 通用 localhost sshd:exec 请求一律 /bin/sh -c 原样跑(HOME 指向测试目录),
 * signal 请求原样投递(与 sshd 一致),通道 close 只送 stdin EOF —— 从不主动
 * kill 子进程。
 */
async function startFakeSshd(opts: {
  fakeHome: string;
  hostKeyPem: string;
  stubEnv: Record<string, string>;
}): Promise<FakeSshd> {
  const execs: ExecRecord[] = [];
  const sockets = new Set<net.Socket>();
  const server = new SshServer({ hostKeys: [opts.hostKeyPem] }, (client) => {
    client.on('authentication', (ctx) => {
      // 只接受 publickey(与生产 agent/key 路径同族),不校验具体 key —— 环回
      // 测试无真实凭据可言,接受即匿名。
      if (ctx.method === 'publickey') ctx.accept();
      else ctx.reject(['publickey']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session: Session = accept();
        let current: ExecRecord | null = null;
        session.on('exec', (acceptExec, _reject, info) => {
          const channel: ServerChannel = acceptExec();
          const child = spawn('/bin/sh', ['-c', info.command], {
            env: {
              HOME: opts.fakeHome,
              PATH: process.env.PATH ?? '/usr/bin:/bin',
              LANG: 'C.UTF-8',
              ...opts.stubEnv,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          let stderrBuf = '';
          child.stderr.on('data', (d: Buffer) => {
            stderrBuf += d.toString('utf8');
          });
          const rec: ExecRecord = {
            command: info.command,
            child,
            stderrText: () => stderrBuf,
            signals: [],
            exited: new Promise((resolveExit) => {
              child.on('exit', (code, signal) => resolveExit({ code, signal }));
            }),
          };
          execs.push(rec);
          current = rec;
          // client → 子进程 stdin;通道 close → EOF(sshd 的管道语义,不是 kill)。
          channel.pipe(child.stdin);
          child.stdout.pipe(channel);
          child.stderr.pipe(channel.stderr);
          child.on('exit', (code) => {
            try { channel.exit(code ?? 0); } catch { /* gone */ }
            try { channel.close(); } catch { /* gone */ }
          });
          channel.on('close', () => {
            try { child.stdin.end(); } catch { /* gone */ }
          });
        });
        session.on('signal', (acceptSig, _reject, info) => {
          // 真实 sshd 语义:把客户端经 SSH wire 发来的信号投递给远端进程。
          // 客户端不带 wantReply 时 accept/reject 为 undefined,不能调。
          if (typeof acceptSig === 'function') acceptSig();
          const name = String(info.name);
          current?.signals.push(name);
          const child = current?.child;
          if (child && child.exitCode === null && !child.killed) {
            child.kill(name as NodeJS.Signals);
          }
        });
      });
    });
    client.on('error', () => { /* client teardown races */ });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('fake sshd has no port');
  return {
    port: addr.port,
    execs,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/* ============================== harness ============================== */

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function memoryHostKeys(): HostKeyStore {
  const map = new Map<string, string>();
  return {
    get: async (key) => map.get(key) ?? null,
    set: async (key, fingerprint) => { map.set(key, fingerprint); },
    reload: () => {},
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_r, reject) => {
    // real-wait: 事件未到的兜底超时 — 这是断言失败的最后防线,不是同步逻辑。
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 等文件出现(小步轮询,25ms 步长低于 real-wait 100ms 门禁)。 */
async function waitForFile(p: string, deadlineMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (fs.existsSync(p)) return;
    if (Date.now() - start > deadlineMs) throw new Error(`timed out waiting for file ${p}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface Fixture {
  tmp: string;
  fakeHome: string;
  sshd: FakeSshd;
  host: RemoteHost;
  daemon: ChildProcess;
  sockPath: string;
  stubLogFile: string;
  failHelloFile: string;
}

async function startFixture(): Promise<Fixture> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-ssh-lifecycle-'));
  let sshd: FakeSshd | undefined;
  let daemon: ChildProcess | undefined;
  let host: RemoteHost | undefined;
  try {
    const fakeHome = path.join(tmp, 'home');
    const ccMgrDir = path.join(fakeHome, '.xdt-server', 'v1', 'cc-manager');
    const nodeBinDir = path.join(fakeHome, '.xdt-server', 'v1', 'node', 'bin');
    fs.mkdirSync(ccMgrDir, { recursive: true });
    fs.mkdirSync(nodeBinDir, { recursive: true });
    fs.symlinkSync(process.execPath, path.join(nodeBinDir, 'node'));
    fs.writeFileSync(path.join(ccMgrDir, 'cc-mgr.mjs'), STUB_BUNDLE, { mode: 0o755 });

    const { privateKey: clientKeyPem } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    const { privateKey: hostKeyPem } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    const identityFile = path.join(tmp, 'id_test');
    fs.writeFileSync(identityFile, clientKeyPem, { mode: 0o600 });

    const sockPath = path.join(ccMgrDir, 'cc-mgr.sock');
    const stubLogFile = path.join(tmp, 'stub-rpc.log');
    const failHelloFile = path.join(tmp, 'fail-hello');

    sshd = await startFakeSshd({
      fakeHome,
      hostKeyPem,
      stubEnv: {
        CINDY_STUB_LOG_FILE: stubLogFile,
        CINDY_STUB_FAIL_HELLO_FILE: failHelloFile,
      },
    });

    // 预启动的 fake daemon:probe 命令(bash 原样执行)需要真 sock 文件 + pid
    // 文件 + 活着的、cmdline 含 cc-mgr.mjs 的进程,三者都真实满足。
    daemon = spawn(
      process.execPath,
      [path.join(ccMgrDir, 'cc-mgr.mjs'), 'daemon', '--socket', sockPath],
      { env: { HOME: fakeHome, PATH: process.env.PATH ?? '', CINDY_STUB_LOG_FILE: stubLogFile }, stdio: 'ignore' },
    );
    fs.writeFileSync(path.join(ccMgrDir, 'cc-mgr.pid'), String(daemon.pid));
    await waitForFile(sockPath, 5_000);

    const cfg: HostConfig = {
      id: 'loopback-test',
      hostname: '127.0.0.1',
      port: sshd.port,
      user: 'tester',
      authMethod: 'key',
      identityFile,
      source: 'manual',
      managedByCindy: false,
    };
    host = new RemoteHost(cfg, { logger: noopLogger, hostKeys: memoryHostKeys() });
    await host.connect({ allowFirstTrust: true });

    return { tmp, fakeHome, sshd, host, daemon, sockPath, stubLogFile, failHelloFile };
  } catch (err) {
    await host?.disconnect().catch(() => {});
    await sshd?.close().catch(() => {});
    if (daemon && daemon.exitCode === null) daemon.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

async function stopFixture(f: Fixture): Promise<void> {
  await f.host.disconnect().catch(() => {});
  await f.sshd.close().catch(() => {});
  if (f.daemon.exitCode === null) f.daemon.kill('SIGKILL');
  fs.rmSync(f.tmp, { recursive: true, force: true });
}

function openOpts(f: Fixture): Parameters<typeof openCcManagerSession>[0] {
  return {
    host: f.host,
    sessionId: 'lc-test',
    startParams: {
      sessionId: 'lc-test',
      cwd: '/tmp',
      model: 'stub-model',
      env: {},
    },
    claudeBinaryPath: '/nonexistent/claude',
  };
}

/** 找到 bridge exec 记录并从命令里解析客户端生成的 trace id。 */
function bridgeRecord(sshd: FakeSshd): { rec: ExecRecord; traceId: string } {
  const rec = sshd.execs.find((e) => e.command.includes('bridge --socket'));
  expect(rec, 'bridge exec command should have reached the sshd').toBeDefined();
  const m = rec!.command.match(/^export CINDY_SSH_CHANNEL_ID=([0-9a-f]{12}); /);
  expect(m, `bridge command should carry the trace export prefix, got: ${rec!.command}`).not.toBeNull();
  return { rec: rec!, traceId: m![1] };
}

/** stub 自报的 bridge node 进程 pid(BRIDGE_READY 行)。 */
function bridgeNodePid(rec: ExecRecord): number {
  const m = rec.stderrText().match(/BRIDGE_READY pid=(\d+)/);
  expect(m, `bridge stub should announce its pid, stderr so far: ${rec.stderrText()}`).not.toBeNull();
  return Number(m![1]);
}

/** 等进程消失(非本进程子进程,不能 wait — 用 kill(pid,0) 轮询)。 */
async function waitProcessGone(pid: number, deadlineMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (!processAlive(pid)) return;
    if (Date.now() - start > deadlineMs) {
      throw new Error(`process ${pid} still alive after ${deadlineMs}ms (orphaned remote process)`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * 远端 bridge(node 进程)在客户端动作后必须消失,且归因于客户端:
 * sshd 侧必须记录到客户端经 wire 发来的 TERM(fake sshd 自己从不发信号);
 * 进程实际退出可能由 TERM 或 stdin EOF 触发(取决于 sh 包装是否 exec),
 * 两者都是客户端动作的结果。
 */
async function expectRemoteBridgeReaped(rec: ExecRecord, nodePid: number): Promise<void> {
  await waitProcessGone(nodePid, 10_000);
  expect(rec.signals).toContain('TERM');
}

function stubLog(f: Fixture): string {
  try {
    return fs.readFileSync(f.stubLogFile, 'utf8');
  } catch {
    return '';
  }
}

/* ============================== tests ============================== */

describe.skipIf(process.platform !== 'linux')('ssh channel lifecycle (#12571, loopback real ssh)', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = undefined!;
    f = await startFixture();
  }, 30_000);
  afterEach(async () => {
    if (f) await stopFixture(f);
  });

  it('open tags the remote bridge env; dispose kills the remote process via client-sent signal', async () => {
    const { dispose } = await openCcManagerSession(openOpts(f));

    const { rec, traceId } = bridgeRecord(f.sshd);
    // 远端进程自报的环境变量 = 客户端命令里的 id(经 /bin/sh -c 的 export 继承)。
    await withDeadline(
      waitForFile(f.stubLogFile, 5_000),
      6_000,
      'stub rpc log',
    );
    expect(rec.stderrText()).toContain(`trace=${traceId}`);
    const nodePid = bridgeNodePid(rec);
    expect(processAlive(nodePid)).toBe(true);

    await dispose();
    await expectRemoteBridgeReaped(rec, nodePid);
    // dispose 走 query/close RPC(session 关闭),daemon 本体不受影响。
    expect(stubLog(f)).toContain('rpc query/close');
    expect(processAlive(f.daemon.pid!)).toBe(true);
  }, 30_000);

  it('detach closes the bridge without sending query/close to the stub', async () => {
    const { detach } = await openCcManagerSession(openOpts(f));
    const { rec } = bridgeRecord(f.sshd);
    const nodePid = bridgeNodePid(rec);
    expect(processAlive(nodePid)).toBe(true);

    await detach();
    await expectRemoteBridgeReaped(rec, nodePid);
    // detach = 断传输保 session:daemon 不得收到 query/close,进程也必须活着。
    expect(stubLog(f)).not.toContain('rpc query/close');
    expect(processAlive(f.daemon.pid!)).toBe(true);
  }, 30_000);

  it('open failure (hello rejected) still reaps the remote bridge — no orphan', async () => {
    fs.writeFileSync(f.failHelloFile, '1');
    await expect(openCcManagerSession(openOpts(f))).rejects.toThrow(/stub hello failure/);

    const { rec } = bridgeRecord(f.sshd);
    await expectRemoteBridgeReaped(rec, bridgeNodePid(rec));
  }, 30_000);
});
