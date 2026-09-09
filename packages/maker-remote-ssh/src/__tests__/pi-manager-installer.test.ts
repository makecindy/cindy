import { describe, expect, it, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import type { ExecResult, RemoteHost } from '../RemoteHost.js';
import {
  parsePiManagerProbeOutput,
  probePiManager,
  installPiManagerBundle,
  ensurePiManagerDaemon,
  uninstallPiManager,
  resetPiManagerEnsureInFlight,
} from '../bootstrap/pi-manager-installer.js';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

const mockReadFile = vi.mocked(fs.readFile);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type ExecFn = RemoteHost['exec'];

function makeHost(id: string, execFn: ExecFn): RemoteHost {
  return { id, exec: execFn } as Pick<RemoteHost, 'id' | 'exec'> as RemoteHost;
}

/** ExecResult mock 工厂:补全 signal 字段满足类型(ExecResult 要求)。 */
function res(exitCode: number, stdout: string, stderr = ''): ExecResult {
  return { exitCode, stdout, stderr, signal: null };
}

const FULL_PROBE = [
  'INSTALL_DIR /home/u/.xdt-server/v1',
  'NODE_BIN /home/u/.xdt-server/v1/node/bin/node',
  'MGR_BIN /home/u/.xdt-server/v1/pi-manager/pi-manager.mjs',
  'MGR_SOCK /home/u/.xdt-server/v1/pi-manager/pi-manager.sock',
  'NODE_READY 22.13.0',
  'MGR_READY {"managerVersion":"0.1.0","protocolVersion":1}',
].join('\n');

// probe stdout without MGR_READY
const PROBE_NO_MGR = FULL_PROBE.replace(/^MGR_READY.*\n?/m, '');

// probe stdout without NODE_READY
const PROBE_NO_NODE = FULL_PROBE.replace(/^NODE_READY.*\n?/m, '');

// ---------------------------------------------------------------------------
// parsePiManagerProbeOutput
// ---------------------------------------------------------------------------

describe('parsePiManagerProbeOutput', () => {
  it('parses full valid output with all fields', () => {
    const r = parsePiManagerProbeOutput(FULL_PROBE);

    expect(r.nodeReady).toBe(true);
    expect(r.piManagerInstalled).toBe(true);
    expect(r.piManagerProtocolVersion).toBe(1);
    expect(r.piManagerVersion).toBe('0.1.0');
    expect(r.installDir).toBe('/home/u/.xdt-server/v1');
    expect(r.nodeBinaryPath).toBe('/home/u/.xdt-server/v1/node/bin/node');
    expect(r.piManagerBinaryPath).toBe(
      '/home/u/.xdt-server/v1/pi-manager/pi-manager.mjs',
    );
    expect(r.piManagerSockPath).toBe(
      '/home/u/.xdt-server/v1/pi-manager/pi-manager.sock',
    );
  });

  it('sets piManagerInstalled=false when MGR_READY is missing', () => {
    const r = parsePiManagerProbeOutput(PROBE_NO_MGR);

    expect(r.nodeReady).toBe(true);
    expect(r.piManagerInstalled).toBe(false);
    expect(r.piManagerProtocolVersion).toBeNull();
    expect(r.piManagerVersion).toBeNull();
  });

  it('sets piManagerInstalled=false when MGR_READY contains bad JSON (no throw)', () => {
    const out = FULL_PROBE.replace(
      'MGR_READY {"managerVersion":"0.1.0","protocolVersion":1}',
      'MGR_READY {bad json!!!}',
    );
    const r = parsePiManagerProbeOutput(out);

    expect(r.nodeReady).toBe(true);
    expect(r.piManagerInstalled).toBe(false);
    expect(r.piManagerProtocolVersion).toBeNull();
    expect(r.piManagerVersion).toBeNull();
  });

  it('sets piManagerInstalled=false when JSON is valid but missing protocolVersion', () => {
    const out = FULL_PROBE.replace(
      'MGR_READY {"managerVersion":"0.1.0","protocolVersion":1}',
      'MGR_READY {"managerVersion":"0.2.0"}',
    );
    const r = parsePiManagerProbeOutput(out);

    expect(r.nodeReady).toBe(true);
    expect(r.piManagerInstalled).toBe(false);
    expect(r.piManagerVersion).toBe('0.2.0');
    expect(r.piManagerProtocolVersion).toBeNull();
  });

  it('sets piManagerInstalled=false when protocolVersion is a string not a number', () => {
    const out = FULL_PROBE.replace(
      'MGR_READY {"managerVersion":"0.1.0","protocolVersion":1}',
      'MGR_READY {"managerVersion":"0.1.0","protocolVersion":"1"}',
    );
    const r = parsePiManagerProbeOutput(out);

    expect(r.piManagerInstalled).toBe(false);
    expect(r.piManagerProtocolVersion).toBeNull();
  });

  it('accepts protocolVersion=0 as a valid installed state', () => {
    const out = FULL_PROBE.replace(
      'MGR_READY {"managerVersion":"0.1.0","protocolVersion":1}',
      'MGR_READY {"managerVersion":"0.1.0","protocolVersion":0}',
    );
    const r = parsePiManagerProbeOutput(out);

    expect(r.piManagerInstalled).toBe(true);
    expect(r.piManagerProtocolVersion).toBe(0);
  });

  it('sets nodeReady=false when NODE_READY is missing', () => {
    const r = parsePiManagerProbeOutput(PROBE_NO_NODE);

    expect(r.nodeReady).toBe(false);
    expect(r.piManagerInstalled).toBe(true); // MGR_READY still present
    expect(r.piManagerProtocolVersion).toBe(1);
  });

  it('falls back to default $HOME/.xdt-server/v1 when all path lines are missing', () => {
    const out = FULL_PROBE
      .replace(/^INSTALL_DIR.*\n?/m, '')
      .replace(/^NODE_BIN.*\n?/m, '')
      .replace(/^MGR_BIN.*\n?/m, '')
      .replace(/^MGR_SOCK.*\n?/m, '');
    const r = parsePiManagerProbeOutput(out);

    expect(r.installDir).toBe('$HOME/.xdt-server/v1');
    // derived paths fall back to the default installDir when their lines are also missing
    expect(r.nodeBinaryPath).toBe('$HOME/.xdt-server/v1/node/bin/node');
    expect(r.piManagerBinaryPath).toBe('$HOME/.xdt-server/v1/pi-manager/pi-manager.mjs');
    expect(r.piManagerSockPath).toBe('$HOME/.xdt-server/v1/pi-manager/pi-manager.sock');
  });

  it('falls back derived paths when NODE_BIN / MGR_BIN / MGR_SOCK are missing', () => {
    const out = FULL_PROBE
      .replace(/^NODE_BIN.*\n?/m, '')
      .replace(/^MGR_BIN.*\n?/m, '')
      .replace(/^MGR_SOCK.*\n?/m, '');
    const r = parsePiManagerProbeOutput(out);

    expect(r.installDir).toBe('/home/u/.xdt-server/v1');
    expect(r.nodeBinaryPath).toBe('/home/u/.xdt-server/v1/node/bin/node');
    expect(r.piManagerBinaryPath).toBe('/home/u/.xdt-server/v1/pi-manager/pi-manager.mjs');
    expect(r.piManagerSockPath).toBe('/home/u/.xdt-server/v1/pi-manager/pi-manager.sock');
  });

  it('handles empty stdout gracefully (all defaults)', () => {
    const r = parsePiManagerProbeOutput('');

    expect(r.nodeReady).toBe(false);
    expect(r.piManagerInstalled).toBe(false);
    expect(r.piManagerProtocolVersion).toBeNull();
    expect(r.piManagerVersion).toBeNull();
    expect(r.installDir).toBe('$HOME/.xdt-server/v1');
  });

  it('handles CRLF line endings', () => {
    const out = FULL_PROBE.replace(/\n/g, '\r\n');
    const r = parsePiManagerProbeOutput(out);

    expect(r.nodeReady).toBe(true);
    expect(r.piManagerInstalled).toBe(true);
    expect(r.piManagerProtocolVersion).toBe(1);
  });

  it('handles lines with prefix but no value (exact prefix match returns empty string)', () => {
    // get('NODE_READY') returns '' when line === 'NODE_READY' (exact match)
    // '' !== null → nodeReady = true
    // get('MGR_READY') returns '' → JSON.parse('') throws → installed = false
    const out = 'INSTALL_DIR /home/u/.xdt-server/v1\nNODE_READY\nMGR_READY\n';
    const r = parsePiManagerProbeOutput(out);

    expect(r.nodeReady).toBe(true);
    expect(r.piManagerInstalled).toBe(false);
    expect(r.installDir).toBe('/home/u/.xdt-server/v1');
  });
});

// ---------------------------------------------------------------------------
// probePiManager
// ---------------------------------------------------------------------------

describe('probePiManager', () => {
  it('calls exec with correct command "bash -l -s -- v1" and probe script input', async () => {
    const calls: Array<{ cmd: string; opts: any }> = [];
    const host = makeHost('h1', async (cmd, opts) => {
      calls.push({ cmd, opts });
      return res(0, FULL_PROBE);
    });

    const result = await probePiManager(host);

    expect(result.nodeReady).toBe(true);
    expect(result.piManagerInstalled).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('bash -l -s -- v1');
    expect(calls[0].opts?.label).toBe('pi-manager-probe');
    expect(calls[0].opts?.timeoutMs).toBe(15_000);
    // input is the probe script
    expect(calls[0].opts?.input).toContain('#!/usr/bin/env bash');
    expect(calls[0].opts?.input).toContain('NODE_READY');
    expect(calls[0].opts?.input).toContain('MGR_READY');
  });
});

// ---------------------------------------------------------------------------
// installPiManagerBundle
// ---------------------------------------------------------------------------

describe('installPiManagerBundle', () => {
  const FAKE_BUNDLE = Buffer.alloc(12345, 0x41);

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockResolvedValue(FAKE_BUNDLE);
  });

  it('aborts when bundled node is not ready (probe1.nodeReady=false)', async () => {
    const events: any[] = [];
    const host = makeHost('h1', async (_cmd, opts) => {
      if (opts?.label === 'pi-manager-probe') {
        return res(0, PROBE_NO_NODE);
      }
      return res(0, '');
    });

    const result = await installPiManagerBundle(host, {
      piManagerBundlePath: '/fake/pi-manager.mjs',
      onEvent: (e) => events.push(e),
    });

    expect(result.ready).toBe(false);
    expect(result.error).toContain('bundled node not installed');
    expect(events.some((e) => e.kind === 'error')).toBe(true);
    // never reached upload — readFile was not called
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('successfully uploads, size-checks, and re-probes', async () => {
    const events: any[] = [];
    const execCalls: Array<{ label: string; input: any; cmd: string }> = [];

    const host = makeHost('h1', async (cmd, opts) => {
      execCalls.push({ label: opts?.label ?? '', input: opts?.input, cmd });
      if (opts?.label === 'pi-manager-probe') {
        return res(0, FULL_PROBE);
      }
      if (opts?.label === 'pi-manager-upload') {
        return res(0, '');
      }
      if (opts?.label === 'pi-manager-upload-size-check') {
        return res(0, '12345');
      }
      return res(0, '');
    });

    const result = await installPiManagerBundle(host, {
      piManagerBundlePath: '/fake/pi-manager.mjs',
      onEvent: (e) => events.push(e),
    });

    expect(result.ready).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.probe.piManagerInstalled).toBe(true);
    expect(mockReadFile).toHaveBeenCalledWith('/fake/pi-manager.mjs');

    // Event order
    expect(events.map((e) => e.kind)).toEqual([
      'probe',
      'install-start',
      'install-upload',
      'install-done',
      'ready',
    ]);
    expect(events.find((e) => e.kind === 'install-upload')?.bytes).toBe(12345);

    // Exec call order
    const labels = execCalls.map((c) => c.label);
    expect(labels).toEqual([
      'pi-manager-probe',
      'pi-manager-upload',
      'pi-manager-upload-size-check',
      'pi-manager-probe',
    ]);

    // Upload call carries binary input
    const uploadCall = execCalls.find((c) => c.label === 'pi-manager-upload');
    expect(Buffer.isBuffer(uploadCall?.input)).toBe(true);
    expect(uploadCall?.input.length).toBe(12345);

    // 轮 40-w4-t5 MEDIUM-4:upload 脚本的原子性安全属性必须被断言 —— 否则
    // 退回 `cat > "$REMOTE_PATH"` 直写后测试仍通过(SSH 中断截断旧 bundle)。
    const uploadCmd = uploadCall?.cmd ?? '';
    expect(uploadCmd).toContain('TMP_PATH=');
    // trap 被 shellQuote 转义成 \'rm -f —— 断言 trap 与 rm -f 即可。
    expect(uploadCmd).toContain('trap ');
    expect(uploadCmd).toContain('rm -f');
    expect(uploadCmd).toContain('EXPECTED=');
    expect(uploadCmd).toContain('wc -c <');
    expect(uploadCmd).toContain('mv -f');
    expect(uploadCmd).not.toMatch(/cat > "\$REMOTE_PATH"\)/);
    // 轮 18-U3 MEDIUM:mv 必须出现在 size check 之后 —— 若顺序回归(mv 提前),
    // size mismatch 也会覆盖正式路径, 旧 bundle 被破坏;这里断言行序,
    // 行为级保证「校验失败 → exit 1 → 不 mv → 旧 bundle 保留」。
    const sizeCheckIdx = uploadCmd.indexOf('ACTUAL=$(wc -c <');
    const mismatchIdx = uploadCmd.indexOf('size mismatch');
    const mvIdx = uploadCmd.indexOf('mv -f');
    expect(sizeCheckIdx).toBeGreaterThan(0);
    expect(mismatchIdx).toBeGreaterThan(sizeCheckIdx);
    expect(mvIdx).toBeGreaterThan(mismatchIdx);
  });

  it('aborts on upload size mismatch', async () => {
    const events: any[] = [];
    const host = makeHost('h1', async (_cmd, opts) => {
      if (opts?.label === 'pi-manager-probe') {
        return res(0, FULL_PROBE);
      }
      if (opts?.label === 'pi-manager-upload') {
        return res(0, '');
      }
      if (opts?.label === 'pi-manager-upload-size-check') {
        return res(0, '12344');
      }
      return res(0, '');
    });

    const result = await installPiManagerBundle(host, {
      piManagerBundlePath: '/fake/pi-manager.mjs',
      onEvent: (e) => events.push(e),
    });

    expect(result.ready).toBe(false);
    expect(result.error).toContain('size mismatch');
    expect(result.error).toContain('12345');
    expect(result.error).toContain('12344');
    expect(events.some((e) => e.kind === 'error')).toBe(true);
    // error comes after install-done
    const kinds = events.map((e) => e.kind);
    expect(kinds[kinds.length - 1]).toBe('error');
  });

  it('aborts when upload exec returns non-zero', async () => {
    const events: any[] = [];
    const host = makeHost('h1', async (_cmd, opts) => {
      if (opts?.label === 'pi-manager-probe') {
        return res(0, FULL_PROBE);
      }
      if (opts?.label === 'pi-manager-upload') {
        return res(1, '', 'disk full');
      }
      return res(0, '');
    });

    const result = await installPiManagerBundle(host, {
      piManagerBundlePath: '/fake/pi-manager.mjs',
      onEvent: (e) => events.push(e),
    });

    expect(result.ready).toBe(false);
    expect(result.error).toContain('failed to upload');
    expect(result.error).toContain('disk full');
  });

  it('aborts when re-probe after upload shows piManagerInstalled=false', async () => {
    const events: any[] = [];
    let probeCall = 0;
    const host = makeHost('h1', async (_cmd, opts) => {
      if (opts?.label === 'pi-manager-probe') {
        probeCall++;
        if (probeCall === 1) {
          return res(0, FULL_PROBE);
        }
        // re-probe: MGR_READY missing
        return res(0, PROBE_NO_MGR);
      }
      if (opts?.label === 'pi-manager-upload') {
        return res(0, '');
      }
      if (opts?.label === 'pi-manager-upload-size-check') {
        return res(0, '12345');
      }
      return res(0, '');
    });

    const result = await installPiManagerBundle(host, {
      piManagerBundlePath: '/fake/pi-manager.mjs',
      onEvent: (e) => events.push(e),
    });

    expect(probeCall).toBe(2);
    expect(result.ready).toBe(false);
    expect(result.error).toContain('--version probe failed');
  });

  it('emits event with bytes in install-upload', async () => {
    const events: any[] = [];
    const host = makeHost('h1', async (_cmd, opts) => {
      if (opts?.label === 'pi-manager-probe') {
        return res(0, FULL_PROBE);
      }
      if (opts?.label === 'pi-manager-upload') {
        return res(0, '');
      }
      if (opts?.label === 'pi-manager-upload-size-check') {
        return res(0, '12345');
      }
      return res(0, '');
    });

    await installPiManagerBundle(host, {
      piManagerBundlePath: '/fake/pi-manager.mjs',
      onEvent: (e) => events.push(e),
    });

    expect(events).toHaveLength(5);
    expect(events[0]).toEqual({ kind: 'probe' });
    expect(events[1]).toEqual({ kind: 'install-start' });
    expect(events[2]).toEqual({ kind: 'install-upload', bytes: 12345 });
    expect(events[3]).toEqual({ kind: 'install-done' });
    expect(events[4]).toEqual({ kind: 'ready' });
  });

  it('emits probe event from onEvent when onEvent is provided', async () => {
    const events: any[] = [];
    const host = makeHost('h1', async (_cmd, opts) => {
      if (opts?.label === 'pi-manager-probe') {
        // node not ready → early abort
        return res(0, PROBE_NO_NODE);
      }
      return res(0, '');
    });

    await installPiManagerBundle(host, {
      piManagerBundlePath: '/fake/pi-manager.mjs',
      onEvent: (e) => events.push(e),
    });

    expect(events[0]).toEqual({ kind: 'probe' });
    expect(events[events.length - 1].kind).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// ensurePiManagerDaemon
// ---------------------------------------------------------------------------

describe('ensurePiManagerDaemon', () => {
  beforeEach(() => {
    resetPiManagerEnsureInFlight();
  });

  it('throws when bundled node is not ready', async () => {
    const host = makeHost('h1', async (_cmd, opts) => {
      if (opts?.label === 'pi-manager-probe') {
        return res(0, PROBE_NO_NODE);
      }
      return res(0, '');
    });

    await expect(ensurePiManagerDaemon(host)).rejects.toThrow(
      'bundled node not installed',
    );
  });

  it('throws when pi-manager bundle is not installed', async () => {
    const host = makeHost('h1', async (_cmd, opts) => {
      if (opts?.label === 'pi-manager-probe') {
        return res(0, PROBE_NO_MGR);
      }
      return res(0, '');
    });

    await expect(ensurePiManagerDaemon(host)).rejects.toThrow(
      'pi-manager bundle not installed',
    );
  });

  it('fast path: returns immediately when daemon check returns ALIVE (no spawn)', async () => {
    const callLabels: string[] = [];
    const host = makeHost('h1', async (_cmd, opts) => {
      callLabels.push(opts?.label ?? '');
      if (opts?.label === 'pi-manager-probe') {
        return res(0, FULL_PROBE);
      }
      if (opts?.label === 'pi-manager-daemon-check') {
        return res(0, 'ALIVE\n');
      }
      return res(0, '');
    });

    await ensurePiManagerDaemon(host);

    // Only probe + check; no spawn / wait
    expect(callLabels).toEqual([
      'pi-manager-probe',
      'pi-manager-daemon-check',
    ]);
  });

  it('fast path with protocolVersion: separate protocol check after connect test (round 40-w4-t3 HIGH)', async () => {
    const checkLabels: string[] = [];
    const host = makeHost('h1', async (cmd, opts) => {
      if (opts?.label === 'pi-manager-probe') {
        return res(0, FULL_PROBE);
      }
      if (opts?.label === 'pi-manager-daemon-check') {
        checkLabels.push(opts.label);
        return res(0, 'ALIVE\n');
      }
      if (opts?.label === 'pi-manager-protocol-check') {
        checkLabels.push(opts.label);
        return res(0, 'PROTOCOL_OK\n');
      }
      return res(0, '');
    });

    await ensurePiManagerDaemon(host, { protocolVersion: 7 });

    // 两步:先 connect test(ALIVE), 再独立 protocol check(PROTOCOL_OK)
    expect(checkLabels).toEqual([
      'pi-manager-daemon-check',
      'pi-manager-protocol-check',
    ]);
  });

  it('protocolVersion hello mismatch → DEAD → daemon re-spawn (round 18-U3 HIGH behavior)', async () => {
    // 行为级:check 脚本返回 DEAD(运行中 daemon 协议不匹配 / 不可连)时,
    // ensurePiManagerDaemon 必须走 spawn 路径(而非静默当作已就绪)。
    const labels: string[] = [];
    const host = makeHost('h1', async (_cmd, opts) => {
      labels.push(opts?.label ?? '');
      if (opts?.label === 'pi-manager-probe') {
        return res(0, FULL_PROBE);
      }
      if (opts?.label === 'pi-manager-daemon-check') {
        // DEAD(旧 daemon 协议不匹配 / 不可连)→ 必须触发 spawn
        return res(0, 'DEAD\n');
      }
      if (opts?.label === 'pi-manager-daemon-spawn') {
        return res(0, 'STARTED\n');
      }
      if (opts?.label === 'pi-manager-daemon-wait') {
        return res(0, 'READY\n');
      }
      return res(0, '');
    });

    await ensurePiManagerDaemon(host, { protocolVersion: 7 });

    // probe → check(DEAD)→ spawn(STARTED)→ wait(READY)
    expect(labels.filter((l) => l !== '')).toEqual([
      'pi-manager-probe',
      'pi-manager-daemon-check',
      'pi-manager-daemon-spawn',
      'pi-manager-daemon-wait',
    ]);
  });

  it('fast path without protocolVersion keeps plain connect check (backward compat)', async () => {
    const checkCmds: string[] = [];
    const host = makeHost('h1', async (cmd, opts) => {
      if (opts?.label === 'pi-manager-probe') {
        return res(0, FULL_PROBE);
      }
      if (opts?.label === 'pi-manager-daemon-check') {
        checkCmds.push(cmd);
        return res(0, 'ALIVE\n');
      }
      return res(0, '');
    });

    await ensurePiManagerDaemon(host);

    expect(checkCmds).toHaveLength(1);
    // 无期望协议:不生成 EXPECTED_PROTOCOL= 赋值行(node -e 内 argv[2] 引用
    // 和注释里的字符串仍存在, 但变量未定义 → 空值 → 运行时走纯连接分支)。
    expect(checkCmds[0]).not.toContain('EXPECTED_PROTOCOL=');
  });

  it('DEAD path: spawns daemon then waits for READY', async () => {
    const callLabels: string[] = [];
    const spawnCmds: string[] = [];
    const host = makeHost('h1', async (cmd, opts) => {
      callLabels.push(opts?.label ?? '');
      if (opts?.label === 'pi-manager-probe') {
        return res(0, FULL_PROBE);
      }
      if (opts?.label === 'pi-manager-daemon-check') {
        return res(0, 'DEAD\n');
      }
      if (opts?.label === 'pi-manager-daemon-spawn') {
        spawnCmds.push(cmd);
        return res(0, 'STARTED\n');
      }
      if (opts?.label === 'pi-manager-daemon-wait') {
        return res(0, 'READY\n');
      }
      return res(0, '');
    });

    await ensurePiManagerDaemon(host);

    expect(callLabels).toEqual([
      'pi-manager-probe',
      'pi-manager-daemon-check',
      'pi-manager-daemon-spawn',
      'pi-manager-daemon-wait',
    ]);
    // 轮 40-w2 LOW:daemon spawn 的 node/pi-manager 路径必须 shellQuote
    // (路径含单引号时转义为 '\'' 序列, 不出现裸双引号包裹)。
    const spawnCmd = spawnCmds[0];
    expect(spawnCmd).toContain(`'\\''`); // 单引号转义序列
    expect(spawnCmd).not.toMatch(/"\$\{probe/); // 不再手写双引号模板
  });

  it('throws when daemon spawn fails (non-zero exit or no STARTED)', async () => {
    const host = makeHost('h1', async (_cmd, opts) => {
      if (opts?.label === 'pi-manager-probe') {
        return res(0, FULL_PROBE);
      }
      if (opts?.label === 'pi-manager-daemon-check') {
        return res(0, 'DEAD\n');
      }
      if (opts?.label === 'pi-manager-daemon-spawn') {
        return res(1, '', 'spawn error: port in use');
      }
      return res(0, '');
    });

    await expect(ensurePiManagerDaemon(host)).rejects.toThrow(
      'pi-manager daemon spawn failed',
    );
  });

  it('throws when daemon wait times out (no READY)', async () => {
    const host = makeHost('h1', async (_cmd, opts) => {
      if (opts?.label === 'pi-manager-probe') {
        return res(0, FULL_PROBE);
      }
      if (opts?.label === 'pi-manager-daemon-check') {
        return res(0, 'DEAD\n');
      }
      if (opts?.label === 'pi-manager-daemon-spawn') {
        return res(0, 'STARTED\n');
      }
      if (opts?.label === 'pi-manager-daemon-wait') {
        return res(1, 'TIMEOUT\n');
      }
      if (opts?.label === 'pi-manager-daemon-log') {
        return res(0, 'Error: something went wrong during boot\n');
      }
      return res(0, '');
    });

    await expect(ensurePiManagerDaemon(host)).rejects.toThrow(
      'pi-manager daemon did not become ready',
    );
  });

  // ── concurrency dedup ────────────────────────────────────────────────

  it('deduplicates concurrent calls for the same host (only one inner execution)', async () => {
    let probeCount = 0;
    let resolveProbe!: () => void;
    const probeBlocker = new Promise<void>((r) => {
      resolveProbe = r;
    });

    const host = makeHost('dedup-1', async (_cmd, opts) => {
      if (opts?.label === 'pi-manager-probe') {
        probeCount++;
        if (probeCount === 1) {
          await probeBlocker;
        }
        return res(0, FULL_PROBE);
      }
      if (opts?.label === 'pi-manager-daemon-check') {
        return res(0, 'ALIVE\n');
      }
      return res(0, '');
    });

    const p1 = ensurePiManagerDaemon(host);
    const p2 = ensurePiManagerDaemon(host);

    resolveProbe();

    await Promise.all([p1, p2]);

    // Only one probe call — the second concurrent call was deduped
    expect(probeCount).toBe(1);
  });

  it('does NOT deduplicate calls for different hosts', async () => {
    let probeCount = 0;

    const makeExec = (): ExecFn => async (_cmd, opts) => {
      if (opts?.label === 'pi-manager-probe') {
        probeCount++;
        return res(0, FULL_PROBE);
      }
      if (opts?.label === 'pi-manager-daemon-check') {
        return res(0, 'ALIVE\n');
      }
      return res(0, '');
    };

    const host1 = makeHost('host-a', makeExec());
    const host2 = makeHost('host-b', makeExec());

    await Promise.all([
      ensurePiManagerDaemon(host1),
      ensurePiManagerDaemon(host2),
    ]);

    // Two different hosts → two independent probe calls
    expect(probeCount).toBe(2);
  });

  it('clears in-flight map after completion so re-entry works', async () => {
    const host = makeHost('reentry', async (_cmd, opts) => {
      if (opts?.label === 'pi-manager-probe') {
        return res(0, FULL_PROBE);
      }
      if (opts?.label === 'pi-manager-daemon-check') {
        return res(0, 'ALIVE\n');
      }
      return res(0, '');
    });

    // First call
    await ensurePiManagerDaemon(host);
    // Second call — must succeed (map was cleaned after first)
    await ensurePiManagerDaemon(host);
    // Reaching here = pass (no hang, no throw)
  });
});

// ---------------------------------------------------------------------------
// uninstallPiManager
// ---------------------------------------------------------------------------

describe('uninstallPiManager', () => {
  it('probes then removes the pi-manager directory', async () => {
    const calls: Array<{ cmd: string; opts: any }> = [];
    const host = makeHost('h1', async (cmd, opts) => {
      calls.push({ cmd, opts });
      return res(0, FULL_PROBE);
    });

    await uninstallPiManager(host);

    expect(calls).toHaveLength(2);
    // First call: probe
    expect(calls[0].opts?.label).toBe('pi-manager-probe');
    // Second call: rm -rf
    expect(calls[1].cmd).toContain('rm -rf');
    expect(calls[1].cmd).toContain('/pi-manager');
    expect(calls[1].opts?.label).toBe('pi-manager-uninstall');
  });

  it('shellQuotes the installDir-derived path (round 11 HIGH-1 — no injection via probe output)', async () => {
    // probe.installDir 来自远端输出, 进 bash -c 必须 shellQuote —— 路径含
    // 单引号/空格时引用结构正确, 无法破出引号执行额外命令。
    const calls: Array<{ cmd: string }> = [];
    const sneakyProbe = FULL_PROBE.replace(
      'INSTALL_DIR /home/u/.xdt-server/v1',
      "INSTALL_DIR /home/u/x's dir",
    );
    const host = makeHost('h2', async (cmd) => {
      calls.push({ cmd });
      return res(0, sneakyProbe);
    });

    await uninstallPiManager(host);

    const rmCmd = calls[1].cmd;
    // 整段脚本经 shellQuote 包裹(bash -c '...'), 路径内单引号被 POSIX 转义
    // 序列 '\'' 包裹 —— 无法破出引号执行额外命令(轮 11 HIGH-1 修复验证)。
    expect(rmCmd).toMatch(/^bash -c '/);
    // 单引号被转义(出现 '\'' 序列), 且裸的未引用路径(内含裸单引号)不出现
    expect(rmCmd).toContain(`'\\''`);
    expect(rmCmd).not.toContain(`x's dir`); // 裸单引号路径不存在
  });
});
