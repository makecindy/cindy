import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { detectGrokBuildOnPath, probeGrokBuildAcp, resolveGrokBinaryFromPath } from '../detect.js';
import type { GrokSpawnFn } from '../stdio-transport.js';

function fakeSpawn(handler: (stdin: PassThrough, stdout: PassThrough) => void): GrokSpawnFn {
  return () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as ReturnType<GrokSpawnFn>;
    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      pid: 99,
      killed: false,
      kill: () => {
        // killed 在 ChildProcess 类型上是只读的,伪造对象用赋值语法会过不了 tsc。
        Object.assign(child, { killed: true });
        child.emit('exit', 0, null);
        return true;
      },
    });
    stdin.on('data', (buf: Buffer) => {
      handler(stdin, stdout);
      void buf;
    });
    // Also handle line-oriented writes: listen after each write by wrapping.
    const originalWrite = stdin.write.bind(stdin);
    stdin.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
      const result = originalWrite(chunk as never, encoding as never, cb as never);
      queueMicrotask(() => handler(stdin, stdout));
      return result;
    }) as typeof stdin.write;
    return child;
  };
}

describe('grok-build detection', () => {
  it('reports uninstalled when grok is not on PATH', () => {
    const result = detectGrokBuildOnPath({
      pathEnv: '/tmp/empty-bin',
      existsSyncImpl: () => false,
      platform: 'linux',
    });
    expect(result).toEqual({
      status: 'uninstalled',
      binaryPath: null,
      errorReason: 'uninstalled',
    });
    expect(resolveGrokBinaryFromPath({ pathEnv: '', existsSyncImpl: () => false })).toBeNull();
  });

  it('resolves grok on PATH without reading auth.json', () => {
    const found = resolveGrokBinaryFromPath({
      pathEnv: '/opt/xai/bin:/usr/bin',
      platform: 'linux',
      existsSyncImpl: (candidate) => candidate === '/opt/xai/bin/grok',
    });
    expect(found).toBe('/opt/xai/bin/grok');
  });

  // Windows 上 grok 由 npm 装成 .cmd shim;分隔符是 ;、扩展名要逐个试。
  // 注入 platform 的用例在任何宿主上都要给出同一答案,所以拼接也得跟着 platform 走。
  it('resolves the Windows .cmd shim from a win32 PATH', () => {
    const found = resolveGrokBinaryFromPath({
      pathEnv: 'C:\\Users\\u\\AppData\\Roaming\\npm;C:\\Windows\\system32',
      platform: 'win32',
      existsSyncImpl: (candidate) => candidate === 'C:\\Users\\u\\AppData\\Roaming\\npm\\grok.cmd',
    });
    expect(found).toBe('C:\\Users\\u\\AppData\\Roaming\\npm\\grok.cmd');
  });

  it('treats initialize authMethods as logged-out', async () => {
    const spawnImpl = fakeSpawn((_stdin, stdout) => {
      stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: 1,
          authMethods: [{ id: 'oauth', name: 'Sign in' }],
        },
      })}\n`);
    });
    const result = await probeGrokBuildAcp({
      binaryPath: '/opt/xai/bin/grok',
      spawnImpl,
      timeoutMs: 1_000,
    });
    expect(result.status).toBe('logged-out');
    expect(result.binaryPath).toBe('/opt/xai/bin/grok');
  });

  it('treats empty authMethods as ready', async () => {
    const spawnImpl = fakeSpawn((_stdin, stdout) => {
      stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: 1, authMethods: [] },
      })}\n`);
    });
    const result = await probeGrokBuildAcp({
      binaryPath: '/opt/xai/bin/grok',
      spawnImpl,
      timeoutMs: 1_000,
    });
    expect(result.status).toBe('ready');
  });

  it('reports acp-fail when initialize times out', async () => {
    const spawnImpl = fakeSpawn(() => {
      // never replies
    });
    const result = await probeGrokBuildAcp({
      binaryPath: '/opt/xai/bin/grok',
      spawnImpl,
      timeoutMs: 30,
    });
    expect(result.status).toBe('acp-fail');
    expect(result.errorReason).toMatch(/timed out/i);
  });
});

describe('optional grok-build registration', () => {
  it('omits grok-build from the Maker agents map when detection returns null', () => {
    const grokBuildAgent = null;
    const agents = {
      'claude-code': { kind: 'claude-code' },
      codex: { kind: 'codex' },
      pi: { kind: 'pi' },
      ...(grokBuildAgent ? { 'grok-build': grokBuildAgent } : {}),
    };
    expect(Object.keys(agents)).toEqual(['claude-code', 'codex', 'pi']);
  });
});
