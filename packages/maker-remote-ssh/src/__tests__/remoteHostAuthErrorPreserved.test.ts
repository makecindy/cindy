/**
 * RemoteHost concurrent-connect join 保留 resolveAuth 错误 code 的回归 (#1837 P1)。
 *
 * 背景:greptile review 指出,同一主机两个 connect 请求重叠时,后到的请求在
 * 连接等待者不能从 `lastError` 字符串重新构造 Error,否则会丢失 resolveAuth
 * 打的 KEY_FILE_NOT_FOUND_CODE——导致缺失私钥错误回落为 SSH_CONNECT_FAILED,
 * 用户看不到路径修复指引。RemoteHost 让并发调用共享同一个 in-flight Promise，
 * 并继续保留完整错误对象，让 .code 结构存活。
 */

import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// 字面量而非 import:credentials.js 被 vi.mock 覆盖,import 会取到 mock 的导出。
const KEY_FILE_NOT_FOUND_CODE = 'KEY_FILE_NOT_FOUND';

class FakeClient extends EventEmitter {
  connect(): void {
    if (!h.connectError) return;
    this.emit('error', h.connectError);
    if ((h.connectError as Error & { level?: string }).level === 'agent') {
      // ssh2 continues trying authentication after emitting its agent error,
      // then emits a generic failure and closes the same connection.
      this.emit('error', new Error('All configured authentication methods failed'));
      this.emit('close');
    }
  }
  end(): void {
    this.emit('close');
  }
}

const h = vi.hoisted(() => ({
  client: null as FakeClient | null,
  connectError: null as Error | null,
}));

vi.mock('ssh2', async (importOriginal) => ({
  ...await importOriginal<typeof import('ssh2')>(),
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
import { resolveAuth } from '../credentials.js';
import { resolveAgentEndpoint } from '../sshAuthentication.js';
import type { HostConfig } from '../types.js';

const HOST_CONFIG: HostConfig = {
  id: 'auth-err-host',
  hostname: '10.0.0.1',
  port: 22,
  user: 'deploy',
  authMethod: 'key',
  identityFile: String.raw`C:\Users\someone\.ssh\id_ed25519`,
  source: 'manual',
  managedByCindy: false,
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
    // 立刻发第二个 connect,后者加入同一个 in-flight attempt。
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

  // Test value: RemoteHost.connect() must retain local agent diagnostics in
  // both the host row snapshot and concurrent IPC rejections. Existing tests
  // only exercise preflight key-file failures, not ssh2's Windows pipe failure.
  // Minimal regression input: ssh2 emits Error with level='agent'. Tier: unit,
  // in-memory client; no real agent, network, credentials or service changes.
  // Standalone run: 1.37 s (Vitest), 7 tests.
  it.each(['preflight', 'ssh2'] as const)('preserves %s local agent failure semantics and localized guidance for both callers', async (stage) => {
    const cause = Object.assign(new Error('Failed to connect to agent'),
      stage === 'ssh2' ? { level: 'agent' } : { code: 'SSH_AGENT_UNAVAILABLE' });
    if (stage === 'preflight') vi.mocked(resolveAuth).mockRejectedValueOnce(cause);
    else vi.mocked(resolveAuth).mockResolvedValueOnce({ agent: 'test-agent', label: 'agent' });
    h.connectError = cause;
    const guidance = '本机 SSH 密钥代理（ssh-agent）不可用。请检查 ssh-add -l。';
    const host = new RemoteHost({ ...HOST_CONFIG, authMethod: 'agent' }, {
      logger: noopLogger,
      formatAgentUnavailableError: () => guidance,
    });
    const results = await Promise.allSettled([host.connect(), host.connect()]);
    for (const result of results) {
      expect(result).toMatchObject({
        status: 'rejected',
        reason: { code: 'SSH_AGENT_UNAVAILABLE', message: guidance, cause },
      });
    }
    expect(host.snapshot()).toMatchObject({ status: 'failed', lastError: guidance });
  });

  it('does not treat message text from other SSH failures as a local agent failure', async () => {
    vi.mocked(resolveAuth).mockResolvedValueOnce({ agent: 'test-agent', label: 'agent' });
    h.connectError = new Error('Failed to connect to agent');
    const host = new RemoteHost({ ...HOST_CONFIG, authMethod: 'agent' }, { logger: noopLogger });
    const error = await host.connect().catch((err: unknown) => err);
    expect(error).toMatchObject({ message: h.connectError.message });
    expect(host.snapshot().lastError).toBe(h.connectError.message);
    expect(error).not.toHaveProperty('code', 'SSH_AGENT_UNAVAILABLE');
  });

  // PR #10108: generic agent guidance hid an invalid configured IdentityAgent.
  // Existing coverage only asserted generic copy. Real endpoint resolution for
  // an unset/empty variable is the smallest failing input; connect() must keep
  // its diagnosis in both concurrent rejections and the visible row. Tier: unit.
  it.each(['environment-unset', 'endpoint-empty', 'endpoint-unavailable'] as const)(
    'retains the configured IdentityAgent %s diagnosis', async (reason) => {
      let cause: Error;
      if (reason === 'endpoint-unavailable') {
        // Windows validates a named pipe inside ssh2, after resolveAuth succeeds.
        cause = Object.assign(new Error('Failed to connect to agent'), { level: 'agent' });
        vi.mocked(resolveAuth).mockResolvedValueOnce({ agent: 'test-agent', label: 'agent' });
        h.connectError = cause;
      } else {
        vi.stubEnv('CINDY_TEST_IDENTITY_AGENT', reason === 'environment-unset' ? undefined : '');
        try {
          cause = await resolveAgentEndpoint('$CINDY_TEST_IDENTITY_AGENT').then(
            () => { throw new Error('Expected an invalid IdentityAgent to fail'); },
            (err: Error) => err,
          );
        } finally {
          vi.unstubAllEnvs();
        }
        vi.mocked(resolveAuth).mockRejectedValueOnce(cause);
      }
      const guidance = `IdentityAgent: ${reason}`;
      const host = new RemoteHost({
        ...HOST_CONFIG, authMethod: 'agent',
        sshAuthentication: {
          configuredIdentityFiles: [], identityAgent: '$CINDY_TEST_IDENTITY_AGENT',
          identitiesOnly: false, identityFileDirectiveSeen: false, identityFileNoneSeen: false,
        },
      }, {
        logger: noopLogger,
        formatAgentUnavailableError: (actualReason?: string) => actualReason === reason ? guidance : 'generic guidance',
      });
      const results = await Promise.allSettled([host.connect(), host.connect()]);
      for (const result of results) {
        expect(result).toMatchObject({
          status: 'rejected',
          reason: { code: 'SSH_AGENT_UNAVAILABLE', message: guidance, cause },
        });
      }
      expect(host.snapshot()).toMatchObject({ status: 'failed', lastError: guidance });
    },
  );
});
