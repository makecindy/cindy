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
 * 两条腿:
 *   1) 「stub daemon」腿:远端 cc-mgr 是测试替身,只讲最小 NDJSON。用来证明
 *      通道标识到了远端进程、dispose/detach 之后远端进程确实被收掉。
 *   2) 「真实 daemon」腿:远端跑的是**生产 cc-mgr 二进制**(esbuild 打包
 *      packages/maker-cc-manager/src/bin/cc-mgr.ts,只把 SDK 换成打桩实现)。
 *      daemon 由 desktop 走生产路径经 SSH 拉起(--detach 自脱离),桥接走生产
 *      `cc-mgr bridge` 子命令。这一腿证明「打开 → 一回合结束 → detach」在
 *      真实协议/真实 registry 上成立,且 detach 后 daemon 侧会话仍在,
 *      dispose 则会终止会话。
 *
 * 最小失败输入: 若 handle.kill() 遗漏, bridge 进程仍存活;若 export 前缀
 * 丢掉/拼错, stub 自报的 trace 环境变量与客户端命令里的 id 对不上;若 detach
 * 误发 query/close, daemon 侧 session 会被终止(alive=false)。
 *
 * tier: integration(真实子进程和环回 SSH 服务);当前 harness 仅支持 Linux。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { build as esbuildBuild } from 'esbuild';
import { Client as SshClient, Server as SshServer, utils, type Connection, type ParsedKey, type ServerChannel, type Session } from 'ssh2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { METHODS, RpcClient } from '@cindy/maker-cc-manager';
import { RemoteHost } from '@cindy/maker-remote-ssh';
import type { HostConfig, HostKeyStore } from '@cindy/maker-remote-ssh';

// cc-manager-client 的唯一重依赖:messagePersistBroadcaster.desktop 拉
// DB/electron 链。closeTransport 里的 drainPersistQueue 与本测试断言无关,隔离掉。
vi.mock('../../messagePersistBroadcaster.desktop.js', () => ({
  drainPersistQueue: async (): Promise<void> => {},
}));

import { openCcManagerSession } from '../cc-manager-client';
import { SSH_CHANNEL_TRACE_ENV } from '../sshChannelTrace';

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
    'PROC_READY pid=' + process.pid + ' trace=' + (process.env.CINDY_SSH_CHANNEL_ID || '') + '\n',
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

/* ============================== real cc-mgr bundle ============================== */

/**
 * 「真实 daemon」腿的远端二进制:直接打包生产入口
 * packages/maker-cc-manager/src/bin/cc-mgr.ts,只把
 * `@anthropic-ai/claude-agent-sdk` 换成打桩实现(见 fixtures/fakeClaudeAgentSdk.ts)。
 * 于是 daemon 主循环、SessionRegistry、NDJSON 协议、`cc-mgr bridge` 子命令、
 * --detach 自脱离全是生产代码,唯一被替掉的是「会 spawn claude CLI 并联网」的 SDK。
 */
const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const CC_MGR_BIN_ENTRY = path.join(REPO_ROOT, 'packages/maker-cc-manager/src/bin/cc-mgr.ts');
const FAKE_SDK_ENTRY = path.join(__dirname, 'fixtures/fakeClaudeAgentSdk.ts');

/**
 * banner 是本测试对生产包体唯一的改动:进程启动时自报 pid + 通道标识,
 * 让测试能把「远端进程」和「本地日志里的通道记录」对回一起
 * (生产 bundle 没有这行,也不需要 —— 生产靠 pidfile + 通道日志排查)。
 */
const PROC_READY_BANNER = [
  '#!/usr/bin/env node',
  `process.stderr.write('PROC_READY pid=' + process.pid + ' trace=' + (process.env.${SSH_CHANNEL_TRACE_ENV} || '') + '\\n');`,
].join('\n');

async function buildRealCcMgrBundle(outFile: string): Promise<void> {
  await esbuildBuild({
    entryPoints: [CC_MGR_BIN_ENTRY],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile: outFile,
    banner: { js: PROC_READY_BANNER },
    plugins: [
      {
        name: 'fake-claude-agent-sdk',
        setup(build) {
          build.onResolve({ filter: /^@anthropic-ai\/claude-agent-sdk$/ }, () => ({ path: FAKE_SDK_ENTRY }));
        },
      },
    ],
  });
}

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
  allowedKey: ParsedKey;
  stubEnv: Record<string, string>;
}): Promise<FakeSshd> {
  const execs: ExecRecord[] = [];
  const connections = new Set<Connection>();
  const server = new SshServer({ hostKeys: [opts.hostKeyPem] }, (client) => {
    client.on('authentication', (ctx) => {
      // 只允许本次 fixture 的临时密钥,并验证签名。环回端口也不能向其他
      // 本地进程开放任意命令执行。
      if (ctx.method !== 'publickey' || ctx.key.algo !== opts.allowedKey.type
        || !ctx.key.data.equals(opts.allowedKey.getPublicSSH())
        || (ctx.signature && (!ctx.blob || opts.allowedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true))) {
        ctx.reject(['publickey']);
        return;
      }
      ctx.accept();
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
          // stdout / stderr 手动转发:pipe() 会在子进程退出时先 end() 通道,
          // 而 ssh2 的 exit() 只在通道还是 open 时才发得出 exit-status
          // (Channel.js: exit → outgoing.state === 'open')。真实 sshd 的顺序是
          // exit-status → EOF → close,这里照做,否则客户端只看到 code=undefined。
          let stdoutEnded = false;
          let exited = false;
          let exitCode = 0;
          const finishChannel = (): void => {
            if (!stdoutEnded || !exited) return;
            try { channel.exit(exitCode); } catch { /* gone */ }
            try { channel.end(); } catch { /* gone */ }
            try { channel.close(); } catch { /* gone */ }
          };
          child.stdout.on('data', (d: Buffer) => {
            try { channel.write(d); } catch { /* gone */ }
          });
          child.stdout.on('end', () => {
            stdoutEnded = true;
            finishChannel();
          });
          child.stderr.on('data', (d: Buffer) => {
            try { channel.stderr.write(d); } catch { /* gone */ }
          });
          child.stderr.on('end', () => {
            try { channel.stderr.end(); } catch { /* gone */ }
          });
          child.on('exit', (code) => {
            exited = true;
            exitCode = code ?? 0;
            finishChannel();
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
  server.on('connection', (connection) => {
    connections.add(connection);
    connection.on('close', () => connections.delete(connection));
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
      for (const connection of connections) connection.end();
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

/**
 * 远端 daemon 的两种形态:
 * - 'stub':测试替身,只讲最小 NDJSON;由测试自己预启动(daemon 存活可断言)。
 * - 'real':生产 cc-mgr 二进制(SDK 打桩);**不由测试预启动** —— 让 desktop 走
 *   生产路径经 SSH 拉起它(--detach 自脱离 + 写 pidfile + 等 sock),这样
 *   ensureDaemonRunning / probe / spawn 脚本这条链也是生产代码。
 */
type DaemonFlavor = 'stub' | 'real';

interface Fixture {
  tmp: string;
  fakeHome: string;
  sshd: FakeSshd;
  host: RemoteHost;
  flavor: DaemonFlavor;
  /** 'stub' 腿:测试预启动的替身 daemon。'real' 腿:null(daemon 由 desktop 拉起)。 */
  daemon: ChildProcess | null;
  /** daemon pid 文件路径;real 腿由 desktop 的 spawn 脚本写入。 */
  daemonPidFile: string;
  sockPath: string;
  stubLogFile: string;
  failHelloFile: string;
}

/**
 * fixture 目录必须够短:daemon 的 unix socket 路径是
 * `<fakeHome>/.xdt-server/v1/cc-manager/cc-mgr.sock`,而 unix socket 路径上限
 * ~108 字节 —— 目录太长时 daemon listen 直接 ENAMETOOLONG,表现为「sock 永远
 * 不出现」,而不是明显的报错。TMPDIR 指向仓库内长路径时尤其容易踩到。
 */
const SOCK_PATH_BUDGET = 100;

function mkdtempShort(): string {
  const errors: unknown[] = [];
  for (const base of [os.tmpdir(), '/tmp']) {
    if (!base) continue;
    let dir: string;
    try {
      dir = fs.mkdtempSync(path.join(base, 'cindy-ssh-'));
    } catch (err) {
      errors.push(err);
      continue;
    }
    const sockPath = path.join(dir, 'home/.xdt-server/v1/cc-manager/cc-mgr.sock');
    if (sockPath.length <= SOCK_PATH_BUDGET) return dir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  throw new Error(
    `no temp dir short enough for a unix socket path (<= ${SOCK_PATH_BUDGET} chars); tried: ${errors.length} candidate(s)`,
  );
}

async function startFixture(flavor: DaemonFlavor = 'stub'): Promise<Fixture> {
  const tmp = mkdtempShort();
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
    const bundlePath = path.join(ccMgrDir, 'cc-mgr.mjs');
    if (flavor === 'stub') {
      fs.writeFileSync(bundlePath, STUB_BUNDLE, { mode: 0o755 });
    } else {
      await buildRealCcMgrBundle(bundlePath);
    }

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
    const allowedKey = utils.parseKey(clientKeyPem);
    if (allowedKey instanceof Error) throw allowedKey;
    const identityFile = path.join(tmp, 'id_test');
    fs.writeFileSync(identityFile, clientKeyPem, { mode: 0o600 });

    const sockPath = path.join(ccMgrDir, 'cc-mgr.sock');
    const stubLogFile = path.join(tmp, 'stub-rpc.log');
    const failHelloFile = path.join(tmp, 'fail-hello');

    sshd = await startFakeSshd({
      fakeHome,
      hostKeyPem,
      allowedKey,
      stubEnv: {
        CINDY_STUB_LOG_FILE: stubLogFile,
        CINDY_STUB_FAIL_HELLO_FILE: failHelloFile,
      },
    });

    // 'stub' 腿预启动替身 daemon:probe 命令(bash 原样执行)需要真 sock 文件 +
    // pid 文件 + 活着的、cmdline 含 cc-mgr.mjs 的进程,三者都真实满足。
    // 'real' 腿不预启动 —— desktop 会走生产 spawn 路径把它拉起来。
    if (flavor === 'stub') {
      daemon = spawn(
        process.execPath,
        [bundlePath, 'daemon', '--socket', sockPath],
        { env: { HOME: fakeHome, PATH: process.env.PATH ?? '', CINDY_STUB_LOG_FILE: stubLogFile }, stdio: 'ignore' },
      );
      fs.writeFileSync(path.join(ccMgrDir, 'cc-mgr.pid'), String(daemon.pid));
      await waitForFile(sockPath, 5_000);
    }

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

    return {
      tmp,
      fakeHome,
      sshd,
      host,
      flavor,
      daemon: daemon ?? null,
      daemonPidFile: path.join(ccMgrDir, 'cc-mgr.pid'),
      sockPath,
      stubLogFile,
      failHelloFile,
    };
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
  if (f.daemon && f.daemon.exitCode === null) f.daemon.kill('SIGKILL');
  // 'real' 腿的 daemon 是 desktop 经 SSH 用 --detach 拉起的自脱离进程:
  // 它不会随本测试退出,必须按 pidfile 里的 PID 收掉,否则会在机器上留孤儿。
  const detachedPid = readPidFile(f.daemonPidFile);
  if (detachedPid && processAlive(detachedPid)) {
    try {
      process.kill(detachedPid, 'SIGKILL');
    } catch {
      /* 已经没了 */
    }
  }
  fs.rmSync(f.tmp, { recursive: true, force: true });
}

/** 读 daemon pid 文件;不存在或非法时返回 null。 */
function readPidFile(pidFile: string): number | null {
  try {
    const raw = fs.readFileSync(pidFile, 'utf8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
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

/** 远端进程自报的 pid(PROC_READY 行;stub 与真实 bundle 用同一格式)。 */
function bridgeNodePid(rec: ExecRecord): number {
  const m = rec.stderrText().match(/PROC_READY pid=(\d+)/);
  expect(m, `remote bridge should announce its pid, stderr so far: ${rec.stderrText()}`).not.toBeNull();
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

  // The loopback server runs shell commands as the test user: an unrelated key
  // must not authenticate. Previously any local public key was accepted.
  it('rejects clients with a different ephemeral key', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    const client = new SshClient();
    try {
      const result = await withDeadline(new Promise<string>((resolve) => {
        client.once('ready', () => resolve('accepted'));
        client.once('error', () => resolve('rejected'));
        client.connect({ host: '127.0.0.1', port: f.sshd.port, username: 'tester', privateKey });
      }), 10_000, 'unauthorized SSH client');
      expect(result).toBe('rejected');
      expect(f.sshd.execs).toHaveLength(0);
    } finally {
      client.end();
    }
  }, 30_000);

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
    expect(processAlive(f.daemon!.pid!)).toBe(true);
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
    expect(processAlive(f.daemon!.pid!)).toBe(true);
  }, 30_000);

  it('open failure (hello rejected) still reaps the remote bridge — no orphan', async () => {
    fs.writeFileSync(f.failHelloFile, '1');
    await expect(openCcManagerSession(openOpts(f))).rejects.toThrow(/stub hello failure/);

    const { rec } = bridgeRecord(f.sshd);
    await expectRemoteBridgeReaped(rec, bridgeNodePid(rec));
  }, 30_000);
});

/* ============================== 真实 daemon 腿 ============================== */

describe.skipIf(process.platform !== 'linux')(
  'ssh channel lifecycle over the real cc-mgr daemon (#12571, loopback real ssh)',
  () => {
    let f: Fixture;
    beforeEach(async () => {
      f = undefined!;
      // 'real' 腿:远端跑生产 cc-mgr 二进制(SDK 打桩),daemon 由 desktop
      // 经 SSH 走生产 spawn 路径拉起 —— ensureDaemonRunning/probe/spawn
      // 脚本这条链也是生产代码。
      f = await startFixture('real');
    }, 60_000);
    afterEach(async () => {
      if (f) await stopFixture(f);
    });

    it('opens, completes a turn, and detaches while the daemon keeps the session', async () => {
      const { remoteQuery, detach } = await openCcManagerSession(openOpts(f));
      const events = remoteQuery[Symbol.asyncIterator]();

      // 一轮真实回合:init → 用户消息 → assistant + result。
      const init = await collectEvents(events, 1);
      expect(init[0]).toMatchObject({ type: 'system', subtype: 'init' });

      await remoteQuery.send({ type: 'user', text: 'turn-one' });
      const turn = await collectEvents(events, 2);
      expect((turn[0] as { type: string }).type).toBe('assistant');
      expect((turn[1] as { type: string }).type).toBe('result');

      // 通道与远端进程的配对:命令里的 trace id == 远端进程环境里的 id。
      const { rec, traceId } = bridgeRecord(f.sshd);
      const nodePid = bridgeNodePid(rec);
      expect(processAlive(nodePid)).toBe(true);
      expect(rec.stderrText()).toContain(`trace=${traceId}`);

      await detach();
      await expectRemoteBridgeReaped(rec, nodePid);

      // detach = 断传输保会话:daemon 侧 session 仍 alive,daemon 进程也在。
      const sessions = await daemonSessions(f.sockPath);
      expect(sessions.find((s) => s.sessionId === 'lc-test')).toMatchObject({ alive: true });
      const daemonPid = readPidFile(f.daemonPidFile);
      expect(daemonPid).not.toBeNull();
      expect(processAlive(daemonPid!)).toBe(true);
    }, 60_000);

    it('dispose ends the daemon session while the bridge process is reaped', async () => {
      const { remoteQuery, dispose } = await openCcManagerSession(openOpts(f));
      const events = remoteQuery[Symbol.asyncIterator]();
      await collectEvents(events, 1);
      await remoteQuery.send({ type: 'user', text: 'turn-two' });
      const turn = await collectEvents(events, 2);
      expect((turn[1] as { type: string }).type).toBe('result');

      const { rec } = bridgeRecord(f.sshd);
      const nodePid = bridgeNodePid(rec);
      expect(processAlive(nodePid)).toBe(true);

      await dispose();
      await expectRemoteBridgeReaped(rec, nodePid);

      // dispose 走 query/close:daemon 侧 session 被终止(与 detach 的区别)。
      const sessions = await daemonSessions(f.sockPath);
      expect(sessions.find((s) => s.sessionId === 'lc-test')).toMatchObject({ alive: false });
    }, 60_000);
  },
);

/* ============================== 真实 daemon 腿 helpers ============================== */

/**
 * 从同一条 RemoteQuery 迭代器上取 count 个事件。
 * 必须复用同一个迭代器:RemoteQuery 每次取 [Symbol.asyncIterator]() 都会
 * 新建一个生成器,换迭代器会丢掉已入队但未消费的事件。
 */
async function collectEvents(
  events: AsyncIterator<unknown>,
  count: number,
  timeoutMs = 15_000,
): Promise<unknown[]> {
  const out: unknown[] = [];
  while (out.length < count) {
    const next = await withDeadline(events.next(), timeoutMs, 'remote query event');
    if (next.done) break;
    out.push(next.value);
  }
  return out;
}

/**
 * 直连 daemon 的 unix socket,用真协议查 session 列表 —— detach / dispose 的
 * 语义差异判据(session 是否仍 alive)只能从 daemon 侧读。
 */
async function daemonSessions(
  sockPath: string,
): Promise<Array<{ sessionId: string; alive: boolean }>> {
  const socket = net.connect(sockPath);
  await withDeadline(
    new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    }),
    10_000,
    'daemon socket connect',
  );
  const client = new RpcClient(socket);
  try {
    await withDeadline(client.hello(), 10_000, 'daemon hello');
    const list = await withDeadline(
      client.request<{ sessions: Array<{ sessionId: string; alive: boolean }> }>(
        METHODS.SESSION_LIST,
        {},
      ),
      10_000,
      'daemon session/list',
    );
    return list.sessions;
  } finally {
    client.dispose();
    socket.destroy();
  }
}
