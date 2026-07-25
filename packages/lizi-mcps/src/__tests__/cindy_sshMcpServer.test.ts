/**
 * cindy_ssh MCP server tests
 * ---------------------------------------------------------------------------
 * 两种风格（照 cindy_schedulerMcpServer.test.ts）：
 *  1. 直测：fake SshPoolLike + registry.call()，覆盖名字解析 / exec 行为 /
 *     错误分类 / 截断 / cwd 包装 / 红线（error payload 不含 command 原文）。
 *  2. e2e smoke：真 McpServer + InMemoryTransport，走通 list_tools → call_tool。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createSshMcpServer } from '../cindy_sshMcpServer.js';
import { SshToolRegistry } from '../ssh/registry.js';
import {
  registerSshExecTool,
  registerSshHostStatusTool,
  registerSshListHostsTool,
} from '../ssh/index.js';
import { OUTPUT_CAP_CHARS } from '../ssh/_shared.js';
import type { SshHostSnapshotLike, SshMcpDeps, SshPoolLike } from '../types.js';

// ── Fakes ───────────────────────────────────────────────────────────────────

function snapshot(partial: {
  id: string;
  hostname?: string;
  status?: SshHostSnapshotLike['status'];
  lastError?: string;
}): SshHostSnapshotLike {
  return {
    config: {
      id: partial.id,
      hostname: partial.hostname ?? `${partial.id}.example.com`,
      port: 22,
      user: 'deploy',
      authMethod: 'agent',
      source: 'manual',
    },
    status: partial.status ?? 'ready',
    ...(partial.lastError ? { lastError: partial.lastError } : {}),
    lastAuthLabel: 'ssh-agent',
    statusChangedAt: 1_700_000_000_000,
  };
}

interface FakeExecCall {
  cmd: string;
  opts?: { input?: string; timeoutMs?: number; label?: string; maxOutputBytes?: number };
}

function makeFakePool(
  snapshots: SshHostSnapshotLike[],
  execImpl?: (cmd: string) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: string | null;
    truncated?: boolean;
  }>,
): { pool: SshPoolLike; execCalls: FakeExecCall[] } {
  const execCalls: FakeExecCall[] = [];
  const pool: SshPoolLike = {
    list: () => snapshots,
    get: (id) => {
      if (!snapshots.some((s) => s.config.id === id)) return undefined;
      return {
        exec: async (cmd, opts) => {
          execCalls.push({ cmd, opts });
          if (execImpl) return execImpl(cmd);
          return { stdout: 'ok\n', stderr: '', exitCode: 0, signal: null };
        },
      };
    },
  };
  return { pool, execCalls };
}

function makeDeps(
  pool: SshPoolLike,
  overrides?: Partial<SshMcpDeps>,
): { deps: SshMcpDeps; ensureReadyCalls: string[] } {
  const ensureReadyCalls: string[] = [];
  const deps: SshMcpDeps = {
    getPool: async () => pool,
    ensureReady: async (id) => {
      ensureReadyCalls.push(id);
    },
    ...overrides,
  };
  return { deps, ensureReadyCalls };
}

function makeRegistry(deps: SshMcpDeps): SshToolRegistry {
  const registry = new SshToolRegistry();
  registerSshListHostsTool(registry, deps);
  registerSshHostStatusTool(registry, deps);
  registerSshExecTool(registry, deps);
  return registry;
}

async function callParsed(
  registry: SshToolRegistry,
  name: string,
  args: Record<string, unknown>,
): Promise<{ payload: Record<string, unknown>; isError: boolean; rawText: string }> {
  const result = await registry.call(name, args);
  const first = result.content[0];
  expect(first.type).toBe('text');
  return {
    payload: JSON.parse(first.text) as Record<string, unknown>,
    isError: result.isError === true,
    rawText: first.text,
  };
}

// ── ssh_list_hosts ──────────────────────────────────────────────────────────

describe('ssh_list_hosts', () => {
  it('maps pool snapshots to host briefs', async () => {
    const { pool } = makeFakePool([
      snapshot({ id: 'web-1', hostname: '10.0.0.5' }),
      snapshot({ id: 'db-1', status: 'failed', lastError: 'boom' }),
    ]);
    const { deps } = makeDeps(pool);
    const { payload, isError } = await callParsed(makeRegistry(deps), 'ssh_list_hosts', {});

    expect(isError).toBe(false);
    expect(payload.ok).toBe(true);
    const hosts = payload.hosts as Array<Record<string, unknown>>;
    expect(hosts).toHaveLength(2);
    expect(hosts[0]).toMatchObject({
      id: 'web-1',
      hostname: '10.0.0.5',
      port: 22,
      user: 'deploy',
      authMethod: 'agent',
      status: 'ready',
    });
    expect(hosts[1]).toMatchObject({ id: 'db-1', status: 'failed', lastError: 'boom' });
  });

  it('empty pool returns ok with guidance hint', async () => {
    const { pool } = makeFakePool([]);
    const { deps } = makeDeps(pool);
    const { payload, isError } = await callParsed(makeRegistry(deps), 'ssh_list_hosts', {});

    expect(isError).toBe(false);
    expect(payload.ok).toBe(true);
    expect(payload.hosts).toEqual([]);
    expect(String(payload.hint)).toContain('远程连接');
  });
});

// ── host resolution（经 ssh_host_status / ssh_exec 走 resolveHost） ─────────

describe('host resolution', () => {
  const hosts = [
    snapshot({ id: 'web-1', hostname: '10.0.0.5' }),
    snapshot({ id: 'web-2', hostname: '10.0.0.6' }),
    snapshot({ id: 'web-2b', hostname: '10.0.0.6' }),
  ];

  it('resolves by alias (id) exactly', async () => {
    const { pool } = makeFakePool(hosts);
    const { deps } = makeDeps(pool);
    const { payload, isError } = await callParsed(makeRegistry(deps), 'ssh_host_status', {
      host: 'web-1',
    });
    expect(isError).toBe(false);
    expect((payload.host as Record<string, unknown>).id).toBe('web-1');
    expect(payload.statusChangedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('resolves by unique hostname/IP', async () => {
    const { pool } = makeFakePool(hosts);
    const { deps } = makeDeps(pool);
    const { payload, isError } = await callParsed(makeRegistry(deps), 'ssh_host_status', {
      host: '10.0.0.5',
    });
    expect(isError).toBe(false);
    expect((payload.host as Record<string, unknown>).id).toBe('web-1');
  });

  it('unknown name → HOST_NOT_FOUND with configured host list', async () => {
    const { pool } = makeFakePool(hosts);
    const { deps } = makeDeps(pool);
    const { payload, isError } = await callParsed(makeRegistry(deps), 'ssh_host_status', {
      host: 'nope',
    });
    expect(isError).toBe(true);
    expect(payload.errorCode).toBe('HOST_NOT_FOUND');
    const data = payload.data as Record<string, unknown>;
    expect(String(data.hint)).toContain('远程连接');
    const configured = data.configuredHosts as Array<Record<string, unknown>>;
    expect(configured.map((h) => h.id)).toEqual(['web-1', 'web-2', 'web-2b']);
  });

  it('duplicate hostname → AMBIGUOUS_HOST with candidates', async () => {
    const { pool } = makeFakePool(hosts);
    const { deps } = makeDeps(pool);
    const { payload, isError } = await callParsed(makeRegistry(deps), 'ssh_host_status', {
      host: '10.0.0.6',
    });
    expect(isError).toBe(true);
    expect(payload.errorCode).toBe('AMBIGUOUS_HOST');
    const data = payload.data as Record<string, unknown>;
    const candidates = data.candidates as Array<Record<string, unknown>>;
    expect(candidates.map((h) => h.id)).toEqual(['web-2', 'web-2b']);
  });
});

// ── ssh_exec ────────────────────────────────────────────────────────────────

describe('ssh_exec', () => {
  it('runs command via ensureReady + exec, returns stdout/exitCode', async () => {
    const { pool, execCalls } = makeFakePool([snapshot({ id: 'web-1', hostname: '10.0.0.5' })]);
    const { deps, ensureReadyCalls } = makeDeps(pool);
    const { payload, isError } = await callParsed(makeRegistry(deps), 'ssh_exec', {
      host: '10.0.0.5', // hostname 输入也要解析回 alias 再 ensureReady
      command: 'uname -a',
    });

    expect(isError).toBe(false);
    expect(payload).toMatchObject({ ok: true, host: 'web-1', exitCode: 0, stdout: 'ok\n' });
    expect(ensureReadyCalls).toEqual(['web-1']);
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].cmd).toBe('uname -a');
    expect(execCalls[0].opts?.timeoutMs).toBe(60_000);
    expect(execCalls[0].opts?.label).toContain('web-1');
    // 源头字节 cap 必须透传给 RemoteHost.exec(PR #874 review:防无上限输出攒爆内存)。
    expect(execCalls[0].opts?.maxOutputBytes).toBe(512 * 1024);
  });

  it('non-zero exitCode is still ok:true (agent judges semantics)', async () => {
    const { pool } = makeFakePool([snapshot({ id: 'web-1' })], async () => ({
      stdout: '',
      stderr: 'not found\n',
      exitCode: 127,
      signal: null,
    }));
    const { deps } = makeDeps(pool);
    const { payload, isError } = await callParsed(makeRegistry(deps), 'ssh_exec', {
      host: 'web-1',
      command: 'no-such-bin',
    });
    expect(isError).toBe(false);
    expect(payload).toMatchObject({ ok: true, exitCode: 127, stderr: 'not found\n' });
  });

  it('wraps cwd with safe single-quote escaping', async () => {
    const { pool, execCalls } = makeFakePool([snapshot({ id: 'web-1' })]);
    const { deps } = makeDeps(pool);
    await callParsed(makeRegistry(deps), 'ssh_exec', {
      host: 'web-1',
      command: 'ls -la',
      cwd: `/srv/it's dir`,
    });
    expect(execCalls[0].cmd).toBe(`cd '/srv/it'\\''s dir' && (ls -la)`);
  });

  it('truncates oversized stdout head+tail and sets stdoutTruncated', async () => {
    const big = 'a'.repeat(OUTPUT_CAP_CHARS + 10_000);
    const { pool } = makeFakePool([snapshot({ id: 'web-1' })], async () => ({
      stdout: big,
      stderr: '',
      exitCode: 0,
      signal: null,
    }));
    const { deps } = makeDeps(pool);
    const { payload } = await callParsed(makeRegistry(deps), 'ssh_exec', {
      host: 'web-1',
      command: 'cat big.log',
    });
    expect(payload.stdoutTruncated).toBe(true);
    expect(payload.stderrTruncated).toBeUndefined();
    const stdout = payload.stdout as string;
    // 截断后的长度是对外上限契约:含 marker 在内严格不超过 cap。
    expect(stdout.length).toBeLessThanOrEqual(OUTPUT_CAP_CHARS);
    expect(stdout).toContain('[truncated');
  });

  it('source-level byte cap (result.truncated) → remoteOutputCapped + retry hint', async () => {
    const { pool } = makeFakePool([snapshot({ id: 'web-1' })], async () => ({
      stdout: 'partial output',
      stderr: '',
      exitCode: null,
      signal: null,
      truncated: true,
    }));
    const { deps } = makeDeps(pool);
    const { payload, isError } = await callParsed(makeRegistry(deps), 'ssh_exec', {
      host: 'web-1',
      command: 'cat huge.log',
    });
    expect(isError).toBe(false);
    expect(payload.remoteOutputCapped).toBe(true);
    expect(String(payload.hint)).toContain('提前终止');
  });

  it('exec timeout error → EXEC_TIMEOUT with nohup hint', async () => {
    const { pool } = makeFakePool([snapshot({ id: 'web-1' })], async () => {
      throw new Error('cindy_ssh:ssh_exec(web-1) timed out after 60000ms');
    });
    const { deps } = makeDeps(pool);
    const { payload, isError } = await callParsed(makeRegistry(deps), 'ssh_exec', {
      host: 'web-1',
      command: 'sleep 999',
    });
    expect(isError).toBe(true);
    expect(payload.errorCode).toBe('EXEC_TIMEOUT');
    expect(String((payload.data as Record<string, unknown>).hint)).toContain('nohup');
  });

  it('ensureReady auth failure → SSH_AUTH_FAILED, hint passthrough, no command echo', async () => {
    const { pool } = makeFakePool([snapshot({ id: 'web-1' })]);
    const { deps } = makeDeps(pool, {
      ensureReady: async () => {
        throw new Error(
          '[SSH_AUTH_FAILED] All configured authentication methods failed. Try: ssh-copy-id deploy@10.0.0.5',
        );
      },
    });
    const secretCommand = 'MY_SECRET_TOKEN=abc ./deploy.sh';
    const { payload, isError, rawText } = await callParsed(makeRegistry(deps), 'ssh_exec', {
      host: 'web-1',
      command: secretCommand,
    });
    expect(isError).toBe(true);
    expect(payload.errorCode).toBe('SSH_AUTH_FAILED');
    const hint = String((payload.data as Record<string, unknown>).hint);
    expect(hint).toContain('ssh-copy-id');
    expect(hint).toContain('重试无效');
    // 红线:error payload 任何位置都不得携带 command 原文。
    expect(rawText).not.toContain('MY_SECRET_TOKEN');
    expect(rawText).not.toContain('deploy.sh');
  });

  it('ensureReady connect failure → SSH_CONNECT_FAILED', async () => {
    const { pool } = makeFakePool([snapshot({ id: 'web-1' })]);
    const { deps } = makeDeps(pool, {
      ensureReady: async () => {
        throw new Error('[SSH_CONNECT_FAILED] connect ETIMEDOUT 10.0.0.5:22');
      },
    });
    const { payload, isError } = await callParsed(makeRegistry(deps), 'ssh_exec', {
      host: 'web-1',
      command: 'true',
    });
    expect(isError).toBe(true);
    expect(payload.errorCode).toBe('SSH_CONNECT_FAILED');
  });

  it('unprefixed unknown error falls back to SSH_CONNECT_FAILED', async () => {
    const { pool } = makeFakePool([snapshot({ id: 'web-1' })], async () => {
      throw new Error('socket hangup');
    });
    const { deps } = makeDeps(pool);
    const { payload, isError } = await callParsed(makeRegistry(deps), 'ssh_exec', {
      host: 'web-1',
      command: 'true',
    });
    expect(isError).toBe(true);
    expect(payload.errorCode).toBe('SSH_CONNECT_FAILED');
  });
});

// ── registry-level 语义 ─────────────────────────────────────────────────────

describe('registry semantics', () => {
  it('unknown tool → UNKNOWN_TOOL with available list', async () => {
    const { pool } = makeFakePool([]);
    const { deps } = makeDeps(pool);
    const { payload, isError } = await callParsed(makeRegistry(deps), 'ssh_nope', {});
    expect(isError).toBe(true);
    expect(payload.errorCode).toBe('UNKNOWN_TOOL');
    expect((payload.data as Record<string, unknown>).available).toEqual([
      'ssh_list_hosts',
      'ssh_host_status',
      'ssh_exec',
    ]);
  });

  it('strict args: unknown field → INVALID_ARGS with schema', async () => {
    const { pool } = makeFakePool([snapshot({ id: 'web-1' })]);
    const { deps } = makeDeps(pool);
    const { payload, isError } = await callParsed(makeRegistry(deps), 'ssh_exec', {
      host: 'web-1',
      command: 'true',
      cmd: 'typo-field',
    });
    expect(isError).toBe(true);
    expect(payload.errorCode).toBe('INVALID_ARGS');
    expect((payload.data as Record<string, unknown>).schema).toBeDefined();
  });

  it('timeoutMs above cap → INVALID_ARGS', async () => {
    const { pool } = makeFakePool([snapshot({ id: 'web-1' })]);
    const { deps } = makeDeps(pool);
    const { payload, isError } = await callParsed(makeRegistry(deps), 'ssh_exec', {
      host: 'web-1',
      command: 'true',
      timeoutMs: 999_999_999,
    });
    expect(isError).toBe(true);
    expect(payload.errorCode).toBe('INVALID_ARGS');
  });
});

// ── session-stable plugin policy ───────────────────────────────────────────

describe('session-stable plugin policy', () => {
  async function makeServerClient(
    deps: SshMcpDeps,
  ): Promise<{ client: Client; cleanup: () => Promise<void> }> {
    const server = createSshMcpServer(deps);
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'gate-test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
    return {
      client,
      cleanup: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  it('does not re-read host plugin settings after the server is created', async () => {
    const { pool } = makeFakePool([snapshot({ id: 'web-1' })]);
    const { deps } = makeDeps(pool);
    const liveGate = vi.fn(() => false);
    // Simulate the legacy host dependency without adding it back to SshMcpDeps.
    // A running server must rely on the policy frozen by its host runtime.
    const legacyDeps = {
      ...deps,
      isEnabledForWorkdir: liveGate,
    };
    const { client, cleanup } = await makeServerClient(legacyDeps);

    const result = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'ssh_list_hosts', args: {} },
    });
    const payload = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    ) as { ok: boolean };
    expect(payload.ok).toBe(true);
    expect(liveGate).not.toHaveBeenCalled();
    await cleanup();
  });
});

// ── e2e smoke: real MCP server over in-memory transport ────────────────────

describe('cindy_ssh MCP server (in-process smoke)', () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const { pool } = makeFakePool([snapshot({ id: 'web-1', hostname: '10.0.0.5' })]);
    const { deps } = makeDeps(pool);
    const server = createSshMcpServer(deps);

    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'lizi-ssh-smoke-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
    cleanup = async () => {
      await client.close();
      await server.close();
    };
  });

  it('list_tools → call_tool(ssh_list_hosts) round-trips', async () => {
    const listResult = await client.callTool({ name: 'list_tools', arguments: {} });
    const listPayload = JSON.parse(
      (listResult.content as Array<{ type: string; text: string }>)[0].text,
    ) as { ok: boolean; categories: Array<{ name: string; tool_count: number }> };
    expect(listPayload.ok).toBe(true);
    expect(listPayload.categories).toEqual([{ name: 'ssh', tool_count: 3 }]);

    const callResult = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'ssh_list_hosts', args: {} },
    });
    const callPayload = JSON.parse(
      (callResult.content as Array<{ type: string; text: string }>)[0].text,
    ) as { ok: boolean; hosts: Array<{ id: string }> };
    expect(callPayload.ok).toBe(true);
    expect(callPayload.hosts.map((h) => h.id)).toEqual(['web-1']);

    await cleanup();
  });
});
