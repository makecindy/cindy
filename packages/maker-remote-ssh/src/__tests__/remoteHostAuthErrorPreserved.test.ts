/**
 * RemoteHost concurrent-connect join 保留 resolveAuth 错误 code 的回归 (#1837 P1)。
 *
 * 背景:greptile review 指出,同一主机两个 connect 请求重叠时,后到的请求在
 * waitForTerminal 后从 `lastError` 字符串重新构造 Error,丢失 resolveAuth 打的
 * KEY_FILE_NOT_FOUND_CODE——导致缺失私钥错误回落为 SSH_CONNECT_FAILED,用户
 * 看不到路径修复指引。修复:RemoteHost 在 resolveAuth 失败时保留完整错误对象
 * (lastAuthError),并发 join 时 rethrow 它,让 .code 结构存活。
 */

import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// 字面量而非 import:credentials.js 被 vi.mock 覆盖,import 会取到 mock 的导出。
const KEY_FILE_NOT_FOUND_CODE = 'KEY_FILE_NOT_FOUND';

class FakeClient extends EventEmitter {
  connect(): void {}
  end(): void {
    this.emit('close');
  }
}

const h = vi.hoisted(() => ({ client: null as FakeClient | null }));

vi.mock('ssh2', () => ({
  Client: vi.fn(() => {
    h.client = new FakeClient();
    return h.client;
  }),
}));

// resolveAuth 第一次失败抛带 code 的错误(模拟 identityFile ENOENT)。
const authErr = new Error(`identity file not found: C:\\Users\\someone\\.ssh\\id_ed25519`);
(authErr as { code?: string }).code = KEY_FILE_NOT_FOUND_CODE;
vi.mock('../credentials.js', () => ({
  resolveAuth: vi.fn(async () => {
    throw authErr;
  }),
  defaultAgentEndpoint: vi.fn(() => ''),
}));

import { RemoteHost } from '../RemoteHost.js';
import type { HostConfig } from '../types.js';

const HOST_CONFIG: HostConfig = {
  id: 'auth-err-host',
  hostname: '10.0.0.1',
  port: 22,
  user: 'deploy',
  authMethod: 'key',
  identityFile: String.raw`C:\Users\someone\.ssh\id_ed25519`,
  source: 'manual',
};

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('RemoteHost concurrent connect preserves resolveAuth error code', () => {
  it('the concurrent joiner rethrows the last resolveAuth error with its .code intact', async () => {
    // resolveAuth 抛错(带 code),第一个 connect 让 status 进入 connecting;
    // 立刻发第二个 connect,后者走 waitForTerminal + rethrow lastAuthError。
    const host = new RemoteHost(HOST_CONFIG, { logger: noopLogger });
    const p1 = host.connect();
    const p2 = host.connect(); // 并发 join —— resolveAuth 仍在飞,status=connecting
    const results = await Promise.allSettled([p1, p2]);
    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') {
        // 关键断言:并发 join 者拿到的错误保留了 .code,而不是被 flatten 成字符串。
        expect((r.reason as { code?: string }).code).toBe(KEY_FILE_NOT_FOUND_CODE);
      }
    }
  });
});
