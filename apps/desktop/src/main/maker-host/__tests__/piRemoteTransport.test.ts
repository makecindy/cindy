/**
 * Tests for the pure-logic pieces of SshPiTransport / createRemotePiFileOps —
 * the shell-arg escaping and remote file-ops command building that get
 * exercised before any real SSH I/O.
 *
 * Why these tests matter:
 *   The end-to-end transport is hard to unit-test without a real SSH host
 *   (it bridges a remote pi --mode rpc process through ssh exec). But two
 *   pieces of the boot path are pure and their breakage would silently
 *   escape an attacker-controlled path through the shell:
 *
 *   - shellQuote: POSIX single-quote escape used to splice the pi binary
 *     path, workdir, and file paths into `bash -c`. A typo would let paths
 *     containing `'` break out of the quoted argument and run arbitrary
 *     commands on the remote. Cover the round-trip explicitly.
 *   - createRemotePiFileOps: the mkdirp / writeFile / stat / rm commands
 *     are built by string interpolation of remote paths. Assert the shell
 *     commands never interpolate a raw path (always through shellQuote),
 *     and that secrets (file content) never appear on the command line
 *     (writeFile passes content via stdin input, not argv).
 *
 * Post-python-retirement additions:
 *   - killRemotePiManagerSession must go through piManagerKill exclusively
 *     (no python daemon kill fallback).
 */

import type { RemoteHost } from '@cindy/maker-remote-ssh';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  createRemotePiFileOps,
  createSshPiTransport,
  killRemotePiManagerSession,
  shellQuote,
} from '../pi-remote-transport.js';
import type { PiTransportCloseInfo } from '@cindy/maker-core';

// ---------------------------------------------------------------------------
// pi-manager exclusive path: mock pi-manager-client so we can verify
// killRemotePiManagerSession goes through piManagerKill exclusively
// (python daemon kill is fully retired).
// ---------------------------------------------------------------------------
const { mockPiManagerKill } = vi.hoisted(() => ({
  mockPiManagerKill: vi.fn(),
}));

vi.mock('../pi-manager-client.js', () => ({
  piManagerKill: mockPiManagerKill,
  piManagerEnsure: vi.fn(),
  piManagerList: vi.fn(),
  ensurePiManagerInstalled: vi.fn(),
  resolvePiManagerBundlePath: vi.fn(),
  withPiManagerRpc: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('pi remote transport shellQuote', () => {
  it('round-trips a plain POSIX path', () => {
    const p = '/Users/yan/.xdt-server/v1/pi/pi';
    expect(shellQuote(p)).toBe(`'${p}'`);
  });

  it('escapes embedded single quotes (attacker-controlled path)', () => {
    // `'` inside a path must be closed + escaped + reopened, never allowed
    // to break out of the quoted argument.
    const evil = "/tmp/foo'; touch /tmp/pwned; echo '";
    const quoted = shellQuote(evil);
    // The injection payload must never appear unquoted.
    expect(quoted).not.toMatch(/(^|[^']); touch/);
    expect(quoted).toMatch(/'\''/); // the escape sequence is present
  });

  it('round-trips a path with spaces and $ signs', () => {
    const p = '/tmp/my dir/$HOME/x';
    expect(shellQuote(p)).toBe(`'/tmp/my dir/\$HOME/x'`);
  });
});

describe('pi remote file ops command hygiene', () => {
  interface ExecResult {
    exitCode: number;
    stdout: string;
    stderr: string;
  }
  function fakeHost(stdout = 'FILE\n'): { calls: Array<{ cmd: string; input?: string }>; host: RemoteHost } {
    const calls: Array<{ cmd: string; input?: string }> = [];
    const host = {
      id: 'test-host',
      exec: async (cmd: string, opts?: { input?: string }) => {
        calls.push({ cmd, input: opts?.input });
        return { exitCode: 0, stdout, stderr: '' } satisfies ExecResult;
      },
    } as unknown as RemoteHost;
    return { calls, host };
  }

  function makeHostExec(stdout = '', exitCode = 0, stderr = ''): { calls: Array<{ cmd: string }>; host: RemoteHost } {
    const calls: Array<{ cmd: string }> = [];
    const host = {
      id: 'test-host',
      exec: async (cmd: string) => {
        calls.push({ cmd });
        return { exitCode, stdout, stderr } satisfies ExecResult;
      },
    } as unknown as RemoteHost;
    return { calls, host };
  }

  it('mkdirp uses shellQuote and never raw-interpolates the path', async () => {
    const { calls, host } = fakeHost();
    const ops = createRemotePiFileOps(host);
    const path = "/tmp/pi home; rm -rf /";
    await ops.mkdirp(path);
    const cmd = calls[0].cmd;
    expect(cmd).toContain('mkdir -p');
    // The injection payload must be inside the single-quoted argument —
    // bash -c 'mkdir -p '\''...; rm -rf /...'\''' — i.e. the payload is
    // never a live token. Assert the path is shellQuote'd (embedded `'`
    // escaped) and the `; rm` payload is not a bare token in the command.
    const quotedPath = shellQuote(path);
    expect(cmd).toContain(quotedPath);
    // If shellQuote is correct, the only `; rm -rf /` occurrence is inside
    // the quoted arg — verify by stripping the quoted form and checking the
    // remainder has no bare payload.
    const remainder = cmd.split(quotedPath).join('');
    expect(remainder).not.toContain('; rm -rf /');
    // And the embedded single-quote escape is present (shellQuote('…'→'\'')).
    expect(cmd).toMatch(/\\''/);
  });

  it('writeFile passes content via stdin, never on the command line', async () => {
    const { calls, host } = fakeHost();
    const ops = createRemotePiFileOps(host);
    const content = 'SECRET_VALUE_123';
    await ops.writeFile('/tmp/pi-agent-home/models.json', content);
    expect(calls[0].input).toBe(content);
    expect(calls[0].cmd).not.toContain(content);
    expect(calls[0].cmd).toContain('cat >');
  });

  // 轮 40-w4-t5 MEDIUM-3:writeFile 的安全属性(umask 077 / chmod / 失败传播)
  // 必须被测试直接断言 —— 否则实现退回 `cat >` + 事后 chmod 测试仍通过。
  it('writeFile uses (umask 077 && cat >) for 0600-from-birth, optional chmod, and propagates failure', async () => {
    // umask 077 分支(无 mode 参数)
    const host1 = makeHostExec();
    const ops1 = createRemotePiFileOps(host1.host);
    await ops1.writeFile('/tmp/x.json', 'content');
    expect(host1.calls[0].cmd).toContain('(umask 077 && cat > "$REMOTE_PATH")');
    expect(host1.calls[0].cmd).not.toMatch(/cat > "\$REMOTE_PATH"\)?\s*\n\s*chmod/);
    expect(host1.calls[0].cmd).not.toContain('chmod');

    // 带 mode 参数 → 追加 chmod <octal>
    const host2 = makeHostExec();
    const ops2 = createRemotePiFileOps(host2.host);
    await ops2.writeFile('/tmp/y.json', 'c', 0o600);
    expect(host2.calls[0].cmd).toContain('chmod 600');

    // 非零 exitCode → reject 且错误信息含截断 stderr
    const host3 = makeHostExec('', 1, 'boom');
    const ops3 = createRemotePiFileOps(host3.host);
    await expect(ops3.writeFile('/tmp/z.json', 'c')).rejects.toThrow(/remote write failed \(exit 1\)/);
  });

  it('stat classifies MISSING as null', async () => {
    const { host } = fakeHost('MISSING\n');
    const ops = createRemotePiFileOps(host);
    expect(await ops.stat('/nope')).toBeNull();
  });
});

describe('killRemotePiManagerSession — pi-manager exclusive path (post python retirement)', () => {
  it('delegates to piManagerKill with correct host and sessionId', async () => {
    mockPiManagerKill.mockResolvedValue(undefined);
    const host = { id: 'test-host-42' } as unknown as RemoteHost;

    await killRemotePiManagerSession(host, 'abc123-xyz_456');

    expect(mockPiManagerKill).toHaveBeenCalledTimes(1);
    expect(mockPiManagerKill).toHaveBeenCalledWith(
      host,
      expect.anything(), // logger (remoteHostLogger fallback)
      'abc123-xyz_456',
    );
  });

  it('propagates piManagerKill rejection (no silent swallow)', async () => {
    mockPiManagerKill.mockRejectedValue(new Error('daemon not running'));
    const host = { id: 'test-host' } as unknown as RemoteHost;

    await expect(
      killRemotePiManagerSession(host, 'valid-session'),
    ).rejects.toThrow('daemon not running');
  });

  it('rejects before calling piManagerKill when sessionId is invalid', async () => {
    mockPiManagerKill.mockResolvedValue(undefined);
    const host = { id: 'test' } as unknown as RemoteHost;

    await expect(
      killRemotePiManagerSession(host, 'BAD/../PATH'),
    ).rejects.toThrow(/unsafe sessionId/);

    // piManagerKill must NOT be called — validation failed synchronously
    expect(mockPiManagerKill).not.toHaveBeenCalled();
  });

  it('accepts a valid sessionId and passes through to piManagerKill', async () => {
    mockPiManagerKill.mockResolvedValue(undefined);
    const host = { id: 'test' } as unknown as RemoteHost;

    // With mock active, a valid sessionId should pass validation and call
    // piManagerKill.  The mock resolves, so no error is thrown.
    await killRemotePiManagerSession(host, 'abc123-xyz_456');

    expect(mockPiManagerKill).toHaveBeenCalledWith(
      host,
      expect.anything(),
      'abc123-xyz_456',
    );
  });

  it('passes an explicit logger through to piManagerKill when provided', async () => {
    mockPiManagerKill.mockResolvedValue(undefined);
    const host = { id: 'test' } as unknown as RemoteHost;
    const customLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => customLogger,
    };

    await killRemotePiManagerSession(host, 'session-x', customLogger);

    expect(mockPiManagerKill).toHaveBeenCalledWith(
      host,
      customLogger,
      'session-x',
    );
  });
});

describe('killRemotePiManagerSession sessionId validation (sync rejection)', () => {
  it('rejects an empty sessionId (sync, no piManagerKill call)', async () => {
    const host = { id: 'test' } as unknown as RemoteHost;
    await expect(killRemotePiManagerSession(host, '')).rejects.toThrow(
      /unsafe sessionId/,
    );
    expect(mockPiManagerKill).not.toHaveBeenCalled();
  });

  it('rejects a sessionId with path traversal (../)', async () => {
    const host = { id: 'test' } as unknown as RemoteHost;
    await expect(
      killRemotePiManagerSession(host, 'abc/../etc'),
    ).rejects.toThrow(/unsafe sessionId/);
    expect(mockPiManagerKill).not.toHaveBeenCalled();
  });

  it('rejects a sessionId with spaces', async () => {
    const host = { id: 'test' } as unknown as RemoteHost;
    await expect(
      killRemotePiManagerSession(host, 'abc def'),
    ).rejects.toThrow(/unsafe sessionId/);
    expect(mockPiManagerKill).not.toHaveBeenCalled();
  });

  it('rejects a sessionId with shell metacharacters ($)', async () => {
    const host = { id: 'test' } as unknown as RemoteHost;
    await expect(
      killRemotePiManagerSession(host, 'abc$(whoami)'),
    ).rejects.toThrow(/unsafe sessionId/);
    expect(mockPiManagerKill).not.toHaveBeenCalled();
  });

  it('rejects a sessionId with shell metacharacters (backtick)', async () => {
    const host = { id: 'test' } as unknown as RemoteHost;
    await expect(
      killRemotePiManagerSession(host, 'abc`id`'),
    ).rejects.toThrow(/unsafe sessionId/);
    expect(mockPiManagerKill).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 轮 40-w5 HIGH:SSH stdout 分帧缓冲的 OOM 守卫 —— 远端输出无换行字节流超过
// 16MB(与本地 attachJsonlReader 对齐的硬上限)时必须关闭 transport, 而不是
// 让主进程内存随远端字节流无界增长。用直连模式 + fake ExecStreamHandle 驱动
// onStdoutBytes, 不依赖真实 SSH。
// ---------------------------------------------------------------------------
function fakeLogger() {
  const logger = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

describe('SSH stdout buffer overflow guard', () => {
  function fakeChannel() {
    const handlers: {
      onStderr?: (s: string) => void;
      onClose?: (info: { code: number | null; signal: string | null }) => void;
      onError?: (err: unknown) => void;
      onStdoutBytes?: (chunk: Buffer) => void;
    } = {};
    const handle = {
      write: vi.fn((_s: string) => true),
      kill: vi.fn(),
      onStderr: vi.fn((cb: (s: string) => void) => { handlers.onStderr = cb; }),
      onClose: vi.fn((cb: (info: { code: number | null; signal: string | null }) => void) => { handlers.onClose = cb; }),
      onError: vi.fn((cb: (err: unknown) => void) => { handlers.onError = cb; }),
      onStdoutBytes: vi.fn((cb: (chunk: Buffer) => void) => { handlers.onStdoutBytes = cb; }),
    };
    return { handlers, handle };
  }

  it('closes the transport when remote streams >16MB without a newline', async () => {
    const execStream = vi.fn();
    const host = { id: 'test-host', execStream } as unknown as RemoteHost;
    const { handlers, handle } = fakeChannel();
    execStream.mockResolvedValue(handle);

    const transport = createSshPiTransport({
      remoteHost: host,
      binaryPath: '/remote/pi',
      args: ['--mode', 'rpc'],
      cwd: '/remote/workdir',
      env: {},
      logger: fakeLogger() as never,
    });
    const closed: PiTransportCloseInfo[] = [];
    transport.onClose((info) => closed.push(info));

    // 等 async IIFE 完成 channel 建立并注册 handlers。
    await vi.waitFor(() => expect(handlers.onStdoutBytes).toBeDefined());

    // 单块无换行字节流超过 16MB 上限。
    handlers.onStdoutBytes!(Buffer.alloc(16 * 1024 * 1024 + 1, 0x61));

    await vi.waitFor(() => expect(closed.length).toBe(1));
    expect(closed[0].reason).toMatch(/buffer overflow/);
    expect(handle.kill).toHaveBeenCalled(); // fireClose 关闭 channel
    // transport 已关闭:后续写入必须 reject。
    await expect(transport.writeLine('{"type":"request"}')).rejects.toThrow(/closed/);
  });

  it('does not trip the guard on legitimately large line-framed output', async () => {
    const execStream = vi.fn();
    const host = { id: 'test-host', execStream } as unknown as RemoteHost;
    const { handlers, handle } = fakeChannel();
    execStream.mockResolvedValue(handle);

    const transport = createSshPiTransport({
      remoteHost: host,
      binaryPath: '/remote/pi',
      args: ['--mode', 'rpc'],
      cwd: '/remote/workdir',
      env: {},
      logger: fakeLogger() as never,
    });
    const lines: string[] = [];
    transport.onLine((line) => lines.push(line));
    const closed: PiTransportCloseInfo[] = [];
    transport.onClose((info) => closed.push(info));

    await vi.waitFor(() => expect(handlers.onStdoutBytes).toBeDefined());

    // 多个带换行的大块(总字节超上限但每行都有 \n)不应触发关闭。
    const chunk = Buffer.concat([Buffer.alloc(1024 * 1024, 0x61), Buffer.from('{"type":"event","method":"x"}\n')]);
    for (let i = 0; i < 20; i += 1) handlers.onStdoutBytes!(chunk);

    expect(closed).toHaveLength(0);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain('{"type":"event"');
  });
});

// ---------------------------------------------------------------------------
// 轮 40-w4 MEDIUM-1:写队列(pendingWrites)硬上限 —— SSH channel 建立阶段
// (execStream 挂住)时 writeLine 只能排队, 无上限会无界增长闭包/内存。
// 队列满 → 关闭 transport, 不继续累积。
// ---------------------------------------------------------------------------
describe('SSH write queue overflow guard', () => {
  it('closes transport and rejects writes beyond the cap when channel never establishes', async () => {
    const execStream = vi.fn(() => new Promise(() => { /* never resolves — channel stuck */ }));
    const host = { id: 'test-host', execStream } as unknown as RemoteHost;

    const transport = createSshPiTransport({
      remoteHost: host,
      binaryPath: '/remote/pi',
      args: ['--mode', 'rpc'],
      cwd: '/remote/workdir',
      env: {},
      logger: fakeLogger() as never,
    });
    const closed: PiTransportCloseInfo[] = [];
    transport.onClose((info) => closed.push(info));

    // 256 条排队(都在等 channel)。
    const queued: Array<Promise<void>> = [];
    for (let i = 0; i < 256; i += 1) {
      queued.push(transport.writeLine(`{"type":"request","id":${i}}`));
    }
    // 第 257 条触发上限:fireClose + reject。
    await expect(transport.writeLine('{"type":"request","id":999}')).rejects.toThrow(/queue overflow/);
    expect(closed).toHaveLength(1);
    expect(closed[0].reason).toMatch(/queue overflow/);
    // 队列里已排队的写入也被 reject(fireClose 清理)——必须全部 settle,
    // 否则未 await 的 rejection 在全量并发下被 vitest 记为 unhandled rejection
    // (256 条只 await 1 条会让 desktop 套件被判定失败)。
    const settled = await Promise.allSettled(queued);
    for (const result of settled) {
      expect(result.status).toBe('rejected');
    }
    // 关闭后写入一律 reject。
    await expect(transport.writeLine('{"type":"request"}')).rejects.toThrow(/closed/);
  });
});

// ---------------------------------------------------------------------------
// 轮 40-w4-t3 CRITICAL:handshake timeout 必须覆盖 execStream 建立阶段 ——
// SSH channel 卡住(execStream 永不返回)时 transport 也必须在超时后 fireClose,
// 不能永久半连接。
// ---------------------------------------------------------------------------
describe('SSH handshake timeout covers execStream phase', () => {
  it('fires close when execStream never resolves (channel null) and writes are queued', async () => {
    vi.useFakeTimers();
    try {
      const execStream = vi.fn(() => new Promise(() => { /* never resolves */ }));
      const host = { id: 'test-host', execStream } as unknown as RemoteHost;

      const transport = createSshPiTransport({
        remoteHost: host,
        binaryPath: '/remote/pi',
        args: ['--mode', 'rpc'],
        cwd: '/remote/workdir',
        env: {},
        logger: fakeLogger() as never,
      });
      const closed: PiTransportCloseInfo[] = [];
      transport.onClose((info) => closed.push(info));

      // 有排队写入(等响应)才应触发超时 —— 空闲 transport 不误杀。
      // 超时 fireClose 会 reject 这条 pending write, 必须持有引用并 settle,
      // 否则未 await 的 rejection 在并发下被 vitest 记为 unhandled error。
      const pendingWrite = transport.writeLine('{"type":"request","id":1}');
      // 推进 handshakeTimeoutMs(15s)。
      vi.advanceTimersByTime(15_000);
      await expect(pendingWrite).rejects.toThrow(/closed|timeout/);

      expect(closed).toHaveLength(1);
      expect(closed[0].reason).toMatch(/handshake timeout/);
      // 关闭后写入 reject。
      await expect(transport.writeLine('{"type":"request","id":2}')).rejects.toThrow(/closed/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire close for idle transport (no queued writes) even if execStream hangs', async () => {
    vi.useFakeTimers();
    try {
      const execStream = vi.fn(() => new Promise(() => { /* never resolves */ }));
      const host = { id: 'test-host', execStream } as unknown as RemoteHost;

      const transport = createSshPiTransport({
        remoteHost: host,
        binaryPath: '/remote/pi',
        args: ['--mode', 'rpc'],
        cwd: '/remote/workdir',
        env: {},
        logger: fakeLogger() as never,
      });
      const closed: PiTransportCloseInfo[] = [];
      transport.onClose((info) => closed.push(info));

      // 无排队写入 → 超时保持打开(R2 传输 Bug6 语义, 空闲 transport 不误杀)。
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();

      expect(closed).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
