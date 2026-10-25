/**
 * 测试价值：createLocalAgentServer 的真实 loopback 授权、MCP、恢复与撤销协议。
 * 依据：本机接入必须独立授权、不重放副作用、不跨授权恢复；既有 device-link 测试不经过此接口。
 * 最小失败输入：无凭据 models、同 id 不同 payload、另一 grant 的 resume、超过批次大小的单事件。
 * tier: integration（真实临时文件与 socket）；单文件实测 1.43s（含 750ms 握手超时边界）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
const grantWrites = vi.hoisted(() => ({ fail: false }));
vi.mock('../../utils/atomicWriteFile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/atomicWriteFile.js')>();
  return {
    ...actual,
    atomicWriteFileSync: (file: string, contents: string) => {
      if (grantWrites.fail && file.endsWith('grants.json')) throw new Error('disk rejected write');
      actual.atomicWriteFileSync(file, contents);
    },
  };
});
import { createLocalAgentServer, type LocalAgentServerDeps } from '../server.js';
import type { LocalAgentModel } from '../catalog.js';
import { formatLocalAgentConnectionCode } from '../../../shared/localAgent.js';
const { LocalAgentClient, parseConnectionCode } = await import(
  new URL('../../../../../../scripts/examples/local-agent-client.mjs', import.meta.url).href
);

const model: LocalAgentModel = {
  id: 'source-model-engine',
  provider: 'custom',
  engine: 'pi',
  model: 'same',
  label: 'Custom · Same · pi',
  efforts: [],
  images: false,
  isDefault: true,
};
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  grantWrites.fail = false;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(overrides: Partial<LocalAgentServerDeps> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-local-agent-test-'));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const call = vi.fn(async () => ({})),
    close = vi.fn(async () => {});
  let bridge: Parameters<LocalAgentServerDeps['open']>[1];
  const open = vi.fn(async (_input, value) => {
    bridge = value;
    return { id: 'native-session', resumed: Boolean(_input.resume), call, close };
  });
  const deps: LocalAgentServerDeps = {
    directory,
    version: 'test',
    scope: () => 'owner',
    models: async () => [model],
    approve: async () => true,
    open,
    warn: () => {},
    ...overrides,
  };
  let server = await createLocalAgentServer(deps);
  cleanups.push(() => server.close());
  let sequence = 0;
  const rpc = async (
    method: string,
    params: unknown = {},
    secret?: string,
    id = `client123:${++sequence}`,
  ) => {
    const response = await fetch(`${server.base}/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify({ version: 1, id, method, params }),
    });
    return response.json() as Promise<any>;
  };
  const pair = async (client: unknown = 'HHH') => {
    const { result } = await rpc('connect/start', { client });
    if (!result) throw new Error('client pairing rejected');
    await fetch(result.url);
    return { result, response: await rpc('connect/poll', { id: result.id, claim: result.claim }) };
  };
  const connect = async (client: unknown = 'HHH') =>
    (await pair(client)).response.result.token as string;
  const start = (secret: string, sessionId = 'run', extra = {}) =>
    rpc(
      'session/open',
      {
        sessionId,
        cwd: directory,
        model: model.id,
        tools: [{ name: 'send', description: '', parameters: { type: 'object' } }],
        access: 'none',
        ...extra,
      },
      secret,
    );
  return {
    directory,
    rpc,
    pair,
    connect,
    start,
    call,
    close,
    open,
    bridge: () => bridge!,
    server: () => server,
    async restart() {
      await server.close();
      server = await createLocalAgentServer(deps);
    },
  };
}

describe('local application authorization and lifecycle', () => {
  it('bounds untrusted connection-code handshakes without following redirects or hanging on a reused port', async () => {
    let mode = 'redirect';
    let requests = 0;
    const endpoint = createServer((_request, response) => {
      requests++;
      if (mode === 'redirect') {
        response.writeHead(302, { Location: '/other' }).end();
      } else if (mode === 'oversize') {
        response.end('x'.repeat(32 * 1024 + 1));
      } else if (mode === 'malformed') {
        response.end('{');
      }
      // A stalled non-Cindy endpoint must hit the client's handshake timeout.
    });
    cleanups.push(async () => {
      endpoint.closeAllConnections();
      await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    });
    endpoint.listen(0, '127.0.0.1');
    await once(endpoint, 'listening');
    const address = endpoint.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback port');
    const client = LocalAgentClient.fromConnectionCode(
      formatLocalAgentConnectionCode({ port: address.port, instance: 'n'.repeat(43) }),
      { id: 'org.example.handshake', name: 'Handshake test' },
    );
    for (const [next, code] of [
      ['redirect', 'CONNECTION_UNAVAILABLE'],
      ['oversize', 'TOO_LARGE'],
      ['malformed', 'CONNECTION_UNAVAILABLE'],
      ['stall', 'CONNECTION_UNAVAILABLE'],
    ]) {
      mode = next;
      await expect(client.connect()).rejects.toMatchObject({ code });
    }
    expect(requests).toBe(4);
  });
  // Connection codes replace public registration: test independent parsing against a real endpoint.
  it('accepts only bounded versioned loopback codes without creating a mapping or scanning profiles', async () => {
    const f = await fixture({ instanceInfo: { kind: 'development', region: 'cn' } });
    const code = formatLocalAgentConnectionCode(f.server().rpc);
    expect(parseConnectionCode(` \n${code}\t`)).toEqual(f.server().rpc);
    for (const port of [1, 65535])
      expect(
        parseConnectionCode(formatLocalAgentConnectionCode({ ...f.server().rpc, port })).port,
      ).toBe(port);
    for (const bad of [
      '',
      code.repeat(5),
      code.replace(':v1:', ':v01:'),
      code.replace(/:\d+:/, ':0:'),
      code.replace(/:\d+:/, ':65536:'),
      code.replace(/:\d+:/, ':0123:'),
      code + '?token=x',
      'http://localhost/rpc',
      code.replace(':v1:', ':v1:\n'),
      code.slice(0, -1),
    ])
      expect(() => parseConnectionCode(bad)).toThrow();
    expect(() => parseConnectionCode(code.replace(':v1:', ':v2:'))).toThrow('Unsupported');
    expect((await f.rpc('capabilities')).result.instanceInfo).toEqual({
      kind: 'development',
      region: 'cn',
    });
    expect((await fs.readdir(f.directory)).sort()).toEqual(['discovery.json']);
  });
  it('verifies code identity without a token, keeps separate target grants, and rejects expired codes', async () => {
    const approveA = vi.fn(async () => true),
      approveB = vi.fn(async () => true);
    const a = await fixture({
      approve: approveA,
      instanceInfo: { kind: 'development', region: 'cn' },
    });
    const b = await fixture({
      approve: approveB,
      instanceInfo: { kind: 'development', region: 'global' },
    });
    const identity = { id: 'org.example.code', name: 'Code client' };
    const ca = LocalAgentClient.fromConnectionCode(
      formatLocalAgentConnectionCode(a.server().rpc),
      identity,
    );
    const cb = LocalAgentClient.fromConnectionCode(
      formatLocalAgentConnectionCode(b.server().rpc),
      identity,
    );
    const spy = vi.spyOn(globalThis, 'fetch');
    try {
      await ca.request('capabilities');
      expect(approveA).not.toHaveBeenCalled();
      await expect(ca.request('models')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await ca.connect();
      await cb.connect();
      await ca.request('models');
      const auth = spy.mock.calls.find(
        ([url, options]) =>
          String(url) === `${a.server().base}/rpc` && (options?.headers as any)?.Authorization,
      )?.[1]?.headers as any;
      expect((await b.rpc('models', {}, auth.Authorization.slice(7))).error.code).toBe(
        'UNAUTHORIZED',
      );
      await ca.request('capabilities');
      for (const [, options] of spy.mock.calls)
        if (JSON.parse(String(options?.body)).method === 'capabilities')
          expect((options?.headers as any)?.Authorization).toBeUndefined();
      await ca.disconnect();
      expect((await cb.request('models')).models).toHaveLength(1);
      await cb.disconnect();
      const old = a.server().rpc;
      await a.restart();
      const reused = LocalAgentClient.fromConnectionCode(
        formatLocalAgentConnectionCode({ ...old, port: a.server().rpc.port }),
        identity,
      );
      await expect(reused.connect()).rejects.toMatchObject({ code: 'INSTANCE_CHANGED' });
      expect(approveA).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
  it('does not treat an installed or unknown old endpoint as development, preserving explicit legacy access', async () => {
    for (const instanceInfo of [undefined, { kind: 'installed' as const, region: 'cn' as const }]) {
      const approve = vi.fn(async () => true);
      const f = await fixture({ instanceInfo, approve });
      const client = LocalAgentClient.fromConnectionCode(
        formatLocalAgentConnectionCode(f.server().rpc),
        { id: 'test', name: 'Test' },
      );
      await expect(client.connect()).rejects.toMatchObject({
        code: instanceInfo ? 'INSTANCE_METADATA_MISMATCH' : 'INSTANCE_METADATA_UNSUPPORTED',
      });
      expect(approve).not.toHaveBeenCalled();
      const legacy = await LocalAgentClient.discover(f.server().discoveryFile, {
        id: 'legacy',
        name: 'Legacy',
      });
      await legacy.connect();
      await legacy.disconnect();
    }
  });
  // Revoking the token is immediate; unconfirmed native shutdown must be reported
  // and retained for cleanup, rather than claiming that an executor has stopped.
  it('reports an unconfirmed close and retries cleanup without restoring revoked authority', async () => {
    const f = await fixture(),
      secret = await f.connect();
    await f.start(secret);
    f.close.mockRejectedValueOnce(new Error('native process exit unconfirmed'));
    await expect(f.server().revoke(f.server().connections()[0].id)).rejects.toMatchObject({
      code: 'RUNTIME_CLOSE_UNCONFIRMED',
    });
    expect((await f.rpc('models', {}, secret)).error.code).toBe('UNAUTHORIZED');
    await f.server().close();
    expect(f.close).toHaveBeenCalledTimes(2);
  });
  it('fails close instead of silently keeping a revoked grant on disk', async () => {
    const f = await fixture(),
      secret = await f.connect(),
      file = path.join(f.directory, 'grants.json');
    grantWrites.fail = true;
    await expect(f.server().revoke(f.server().connections()[0].id)).rejects.toBeDefined();
    expect((await f.rpc('models', {}, secret)).error.code).toBe('UNAUTHORIZED');
    await expect(f.server().close()).rejects.toMatchObject({ code: 'GRANT_PERSIST_FAILED' });
    grantWrites.fail = false;
    expect(JSON.parse(await fs.readFile(file, 'utf8')).grants).toHaveLength(1);
  });
  it('rolls back a resume binding whose open could not be persisted', async () => {
    const f = await fixture(),
      secret = await f.connect();
    grantWrites.fail = true;
    expect((await f.start(secret, 'lost')).error).toBeDefined();
    grantWrites.fail = false;
    expect((await f.start(secret, 'kept')).error).toBeUndefined();
    const stored = JSON.parse(await fs.readFile(path.join(f.directory, 'grants.json'), 'utf8'));
    expect(Object.keys(stored.bindings)).toHaveLength(1);
  });
  it('keeps revoke pending until an engine still starting is closed, and reports a failed late close', async () => {
    let release!: () => void, began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = vi.fn(async () => {});
    close.mockRejectedValueOnce(new Error('native process exit unconfirmed'));
    const f = await fixture({
      open: async () => {
        began();
        await held;
        return { id: 'late', resumed: false, call: async () => ({}), close };
      },
    });
    const secret = await f.connect();
    const opening = f.start(secret);
    await started;
    let settled = false;
    const revoking = f.server().revoke(f.server().connections()[0].id);
    void revoking.catch(() => {}).finally(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    release();
    await expect(revoking).rejects.toMatchObject({ code: 'RUNTIME_CLOSE_UNCONFIRMED' });
    expect((await opening).error).toBeDefined();
    await f.server().close();
    expect(close).toHaveBeenCalledTimes(2);
  });
  it('keeps concurrent opens within the persisted resume limit so the service can restart', async () => {
    const releases: Array<() => void> = [];
    const f = await fixture({
      open: async () => {
        await new Promise<void>((resolve) => releases.push(resolve));
        return { id: 'native', resumed: false, call: async () => ({}), close: async () => {} };
      },
    });
    const secret = await f.connect();
    const file = path.join(f.directory, 'grants.json');
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    stored.bindings = Object.fromEntries(
      Array.from({ length: 4095 }, (_, i) => [
        `resume-${i}`,
        { owner: stored.grants[0].id, model: model.id, native: 'native' },
      ]),
    );
    await fs.writeFile(file, JSON.stringify(stored));
    await f.restart();
    const a = f.start(secret, 'a'),
      b = f.start(secret, 'b');
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    for (const release of releases) release();
    const results = await Promise.all([a, b]);
    expect(results.filter((result) => result.result)).toHaveLength(1);
    expect(results.find((result) => result.error)?.error.code).toBe('RESUME_LIMIT');
    expect(Object.keys(JSON.parse(await fs.readFile(file, 'utf8')).bindings)).toHaveLength(4096);
    await f.restart();
    expect((await f.rpc('models', {}, secret)).result.models).toEqual([model]);
  });
  it('does not let a late failed open close the newer run reusing its public session ID', async () => {
    let release!: () => void, began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const oldClose = vi.fn(async () => {}),
      newClose = vi.fn(async () => {});
    let opens = 0;
    const f = await fixture({
      open: async () => {
        if (++opens === 1) {
          began();
          await held;
          return { id: 'old', resumed: false, call: async () => ({}), close: oldClose };
        }
        return { id: 'new', resumed: false, call: async () => ({}), close: newClose };
      },
    });
    const secret = await f.connect();
    const old = f.start(secret);
    await started;
    await f.rpc('session/close', { sessionId: 'run' }, secret);
    expect((await f.start(secret)).error).toBeUndefined();
    release();
    expect((await old).error).toBeDefined();
    expect(oldClose).toHaveBeenCalledTimes(1);
    expect(newClose).not.toHaveBeenCalled();
    expect((await f.rpc('interrupt', { sessionId: 'run' }, secret)).error).toBeUndefined();
  });

  it('rejects an MCP request whose body completes only after its application is revoked', async () => {
    const f = await fixture(),
      secret = await f.connect();
    await f.start(secret);
    const bridge = f.bridge();
    const connection = f.server().connections()[0];
    const req = request(bridge.url, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
      headers: {
        Authorization: `Bearer ${bridge.token}`,
        'Content-Type': 'application/json',
        Expect: '100-continue',
      },
    });
    const response = new Promise<number>((resolve, reject) => {
      req.once('response', (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.once('error', reject);
    });
    req.flushHeaders();
    await once(req, 'continue');
    await f.server().revoke(connection.id);
    req.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'send', arguments: {} },
      }),
    );
    expect(await response).toBe(403);
  });

  it('runs code and legacy discovery clients in unrelated Node processes with isolated tools', async () => {
    const f = await fixture({
      instanceInfo: { kind: 'development', region: 'cn' },
      open: async (input, bridge) => {
        let completion = Promise.resolve();
        return {
          id: `native-${input.isolationKey}`,
          resumed: false,
          async call(method, params) {
            if (method === 'send')
              completion = (async () => {
                const response = await fetch(bridge.url, {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${bridge.token}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: {
                      name: 'client_echo',
                      arguments: { text: (params.parts as any[])[0].text },
                    },
                  }),
                });
                const answer = (await response.json()) as any;
                bridge.emit({ type: 'text', data: answer.result.content[0].text });
                bridge.emit({ type: 'turn_end', data: { status: 'completed' } });
              })();
            return {};
          },
          async close() {
            await completion;
          },
        };
      },
    });
    const example = fileURLToPath(
      new URL('../../../../../../scripts/examples/local-agent-client.mjs', import.meta.url),
    );
    const results = await Promise.all(
      ['notes', 'board'].map((app) =>
        promisify(execFile)(
          process.execPath,
          [
            example,
            ...(app === 'notes'
              ? ['--connection-code', formatLocalAgentConnectionCode(f.server().rpc)]
              : ['--discovery', f.server().discoveryFile]),
            '--cwd',
            f.directory,
            '--client-id',
            `org.example.${app}`,
            '--client-name',
            app,
            '--prompt',
            `${app}-only`,
          ],
          { timeout: 5000 },
        ),
      ),
    );
    expect(results[0].stdout).toContain('notes-only');
    expect(results[0].stdout).not.toContain('board-only');
    expect(results[1].stdout).toContain('board-only');
    expect(results[1].stdout).not.toContain('notes-only');
    expect(f.server().connections()).toEqual([]);
  });

  it('migrates v1 grant hashes and native resume bindings without changing the credential or overwriting its backup', async () => {
    const f = await fixture(),
      secret = await f.connect();
    const first = (await f.start(secret)).result;
    const file = path.join(f.directory, 'grants.json');
    const current = JSON.parse(await fs.readFile(file, 'utf8'));
    const original = JSON.stringify({
      version: 1,
      grants: current.grants.map(({ id, name, hash, scope }: any) => ({ id, name, hash, scope })),
      bindings: current.bindings,
    });
    await fs.writeFile(file, original);
    await f.restart();
    expect((await f.start(secret, 'migrated', { resume: first.id })).result.resumed).toBe(true);
    expect(f.open.mock.calls.at(-1)?.[0]).toMatchObject({
      mcpName: 'hhh',
      legacyRuntime: true,
      resume: 'native-session',
    });
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(saved.version).toBe(2);
    expect(saved.grants[0].hash).toBe(current.grants[0].hash);
    expect(await fs.readFile(`${file}.v1.bak`, 'utf8')).toBe(original);
    await f.connect({ id: 'org.example.notes', name: 'Notes' });
    expect(await fs.readFile(`${file}.v1.bak`, 'utf8')).toBe(original);
    await f.restart();
    expect((await f.start(secret, 'again', { resume: first.id })).result.resumed).toBe(true);
    expect(
      f
        .server()
        .connections()
        .map((item) => item.name),
    ).toEqual(['HHH', 'Notes']);
  });

  it('rejects invalid client identities and conflicting tool policies without granting or executing anything', async () => {
    const f = await fixture();
    for (const client of [
      { id: '../other', name: 'Notes' },
      { id: 'notes', name: '\u202eCindy' },
      { id: 'notes', name: ' ' },
    ]) {
      expect((await f.rpc('connect/start', { client })).error).toBeDefined();
    }
    expect(f.server().connections()).toEqual([]);
    const secret = await f.connect({ id: 'notes', name: 'Notes' });
    expect(
      (await f.start(secret, 'bad', { toolPolicy: 'native', access: 'none' })).error.code,
    ).toBe('UNSUPPORTED_ACCESS');
    expect(
      (await f.start(secret, 'generic', { toolPolicy: 'client-only', access: undefined })).error,
    ).toBeUndefined();
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.open.mock.calls[0][0]).toMatchObject({
      access: 'none',
      mcpName: 'client',
      legacyRuntime: false,
    });
  });

  // 通用 API 契约：任意应用独立授权、相同会话/请求编号不串线，名称不是认证身份。
  // 原覆盖只有 HHH 且会话名不同，无法发现全局 sessionId 冲突；最小输入为两个应用的 run。
  it('authorizes unrelated clients and namespaces identical session and request IDs by grant', async () => {
    const approve = vi.fn(async () => true);
    const f = await fixture({ approve });
    const alpha = await f.connect({ id: 'org.example.notes', name: 'Notes' });
    const beta = await f.connect({ id: 'org.example.board', name: 'Board', version: '1.2' });
    expect(approve.mock.calls.map((args: any[]) => args[1].name)).toEqual(['Notes', 'Board']);
    expect(
      f
        .server()
        .connections()
        .map((item) => item.name),
    ).toEqual(['Notes', 'Board']);
    expect((await f.start(alpha)).error).toBeUndefined();
    const alphaBridge = f.bridge();
    expect((await f.start(beta)).error).toBeUndefined();
    const betaBridge = f.bridge();
    expect(betaBridge.url).not.toBe(alphaBridge.url);
    expect(betaBridge.token).not.toBe(alphaBridge.token);
    expect(f.open.mock.calls[0][0].isolationKey).not.toBe(f.open.mock.calls[1][0].isolationKey);
    await f.rpc('interrupt', { sessionId: 'run' }, alpha, 'sameclient:1');
    await f.rpc('interrupt', { sessionId: 'run' }, beta, 'sameclient:1');
    expect(f.call).toHaveBeenCalledTimes(2);
    alphaBridge.emit({ type: 'text', data: 'notes-private' });
    betaBridge.emit({ type: 'text', data: 'board-private' });
    expect(
      (await f.rpc('events', { sessionId: 'run', cursor: 0 }, alpha)).result.events[0].event.data,
    ).toBe('notes-private');
    expect(
      (await f.rpc('events', { sessionId: 'run', cursor: 0 }, beta)).result.events[0].event.data,
    ).toBe('board-private');
    await f.server().revokeAll();
    expect(f.close).toHaveBeenCalledTimes(2);
  });

  it('rejects foreign controls, resume handles, MCP tokens and tool replies without changing the owner run', async () => {
    const f = await fixture();
    const alpha = await f.connect({ id: 'org.example.notes', name: 'Same name' });
    const beta = await f.connect({ id: 'org.example.board', name: 'Same name' });
    const opened = (await f.start(alpha, 'private')).result;
    const bridge = f.bridge();
    await f.start(beta);
    const betaBridge = f.bridge();
    for (const method of [
      'events',
      'send',
      'steer',
      'interrupt',
      'instructions',
      'session/close',
    ]) {
      expect((await f.rpc(method, { sessionId: 'private', cursor: 0 }, beta)).error.code).toBe(
        'SESSION_UNAVAILABLE',
      );
    }
    expect((await f.start(beta, 'foreign', { resume: opened.id })).error.code).toBe(
      'RESUME_UNAVAILABLE',
    );
    const mcp = (token: string) =>
      fetch(bridge.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'send', arguments: {} },
        }),
      });
    expect((await mcp(betaBridge.token)).status).toBe(403);
    const pending = mcp(bridge.token).then((response) => response.json());
    const call = (await f.rpc('events', { sessionId: 'private', cursor: 0 }, alpha)).result
      .events[0].event.data;
    expect(
      (await f.rpc('tool/reply', { sessionId: 'run', callId: call.id, text: 'foreign' }, beta))
        .error.code,
    ).toBe('TOOL_UNAVAILABLE');
    await f.rpc('tool/reply', { sessionId: 'private', callId: call.id, text: 'owner' }, alpha);
    expect(((await pending) as any).result.content[0].text).toBe('owner');
    expect(f.call).not.toHaveBeenCalled();
  });

  it('revokes one application while another keeps its credential, tool call and durable resume binding', async () => {
    const f = await fixture();
    const alpha = await f.connect({ id: 'org.example.notes', name: 'Notes' });
    const beta = await f.connect({ id: 'org.example.board', name: 'Board' });
    const first = (await f.start(alpha)).result;
    const alphaBridge = f.bridge();
    const second = (await f.start(beta)).result;
    const betaBridge = f.bridge();
    const callTool = (bridge: typeof alphaBridge) =>
      fetch(bridge.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'send', arguments: {} },
        }),
      }).then((response) => response.json()) as Promise<any>;
    const alphaPending = callTool(alphaBridge),
      betaPending = callTool(betaBridge);
    const alphaEvents = (await f.rpc('events', { sessionId: 'run', cursor: 0 }, alpha)).result;
    const betaEvents = (await f.rpc('events', { sessionId: 'run', cursor: 0 }, beta)).result;
    const waiting = f.rpc('events', { sessionId: 'run', cursor: alphaEvents.cursor }, alpha);
    const connection = f
      .server()
      .connections()
      .find((item) => item.name === 'Notes')!;
    await f.server().revoke(connection.id);
    expect((await waiting).error).toBeDefined();
    expect((await alphaPending).result.isError).toBe(true);
    expect((await f.rpc('models', {}, alpha)).error.code).toBe('UNAUTHORIZED');
    expect((await f.rpc('models', {}, beta)).result.models).toEqual([model]);
    await f.rpc(
      'tool/reply',
      { sessionId: 'run', callId: betaEvents.events[0].event.data.id, text: 'board survives' },
      beta,
    );
    expect((await betaPending).result.content[0].text).toBe('board survives');
    expect(
      f
        .server()
        .connections()
        .map((item) => item.name),
    ).toEqual(['Board']);
    await f.restart();
    expect((await f.start(beta, 'restored', { resume: second.id })).result.resumed).toBe(true);
    expect((await f.start(beta, 'stolen', { resume: first.id })).error.code).toBe(
      'RESUME_UNAVAILABLE',
    );
  });
  it('serves a warm 500-model catalog and control framing within the local bridge budget', async () => {
    const f = await fixture({
      models: async () =>
        Array.from({ length: 500 }, (_, i) => ({
          ...model,
          id: i === 0 ? model.id : 'route-' + i,
          label: 'Supplier ' + i,
        })),
    });
    const secret = await f.connect();
    expect((await f.start(secret)).error).toBeUndefined();
    const catalog: number[] = [],
      control: number[] = [];
    for (let i = 0; i < 20; i++) {
      let at = performance.now();
      const result = await f.rpc('models', {}, secret);
      catalog.push(performance.now() - at);
      expect(result.result.models).toHaveLength(500);
      at = performance.now();
      const reply = await f.rpc('interrupt', { sessionId: 'run' }, secret);
      control.push(performance.now() - at);
      expect(reply.error).toBeUndefined();
    }
    const p95 = (values: number[]) => values.sort((a, b) => a - b)[18];
    expect(f.call).toHaveBeenCalledTimes(20);
    expect(p95(catalog)).toBeLessThan(2000);
    expect(p95(control)).toBeLessThan(100);
    console.log(
      JSON.stringify({
        localBridgeMilliseconds: { catalog500P95: p95(catalog), controlP95: p95(control) },
        samples: 20,
        nativeEngine: 'scripted; framing overhead only',
      }),
    );
  });
  it('requires native consent, stores only the grant hash, and rejects browser-origin RPCs', async () => {
    const f = await fixture();
    expect((await f.rpc('models')).error.code).toBe('UNAUTHORIZED');
    const secret = await f.connect();
    expect((await f.rpc('models', {}, secret)).result.models).toEqual([model]);
    expect(await fs.readFile(path.join(f.directory, 'grants.json'), 'utf8')).not.toContain(secret);
    const response = await fetch(`${f.server().base}/rpc`, {
      method: 'POST',
      headers: { Origin: 'https://untrusted.invalid', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(403);
    await f.server().revokeAll();
    expect((await f.rpc('models', {}, secret)).error.code).toBe('UNAUTHORIZED');
  });
  it('denial and an account switch during consent never mint a usable credential', async () => {
    const denied = await fixture({ approve: async () => false });
    expect((await denied.pair()).response.result).toEqual({ state: 'denied' });
    let scope = 'before';
    const changed = await fixture({
      scope: () => scope,
      approve: async () => {
        scope = 'after';
        return true;
      },
    });
    expect((await changed.pair()).response.result.token).toBeUndefined();
    expect(changed.server().connections()).toEqual([]);
  });
  it('cancels the native consent when HHH abandons pairing without creating a grant', async () => {
    let signal: AbortSignal | undefined;
    const f = await fixture({
      approve: async (value) => {
        signal = value;
        return new Promise<boolean>((resolve) =>
          value.addEventListener('abort', () => resolve(false), { once: true }),
        );
      },
    });
    const pair = (await f.rpc('connect/start', { client: 'HHH' })).result;
    await f.rpc('connect/cancel', { id: pair.id, claim: pair.claim });
    expect(signal?.aborted).toBe(true);
    expect(f.server().connections()).toEqual([]);
    expect((await f.rpc('connect/poll', { id: pair.id, claim: pair.claim })).error).toBeDefined();
  });
  it('deduplicates side effects, rejects changed payloads, and bounds replay history without replaying old operations', async () => {
    const f = await fixture(),
      secret = await f.connect();
    await f.start(secret);
    const id = 'replayclient:1';
    await Promise.all([
      f.rpc('interrupt', { sessionId: 'run' }, secret, id),
      f.rpc('interrupt', { sessionId: 'run' }, secret, id),
    ]);
    expect(f.call).toHaveBeenCalledTimes(1);
    expect((await f.rpc('send', { sessionId: 'run' }, secret, id)).error.code).toBe('ID_REUSED');
    await f.rpc('interrupt', { sessionId: 'run' }, secret, 'replayclient:300');
    expect((await f.rpc('interrupt', { sessionId: 'run' }, secret, id)).error.code).toBe(
      'REQUEST_EXPIRED',
    );
    expect(f.call).toHaveBeenCalledTimes(2);
  });
  it('reclaims quiet process nonces per grant and refuses their late requests instead of replaying', async () => {
    const f = await fixture(),
      secret = await f.connect();
    await f.start(secret);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const interrupt = (nonce: string) =>
        f.rpc('interrupt', { sessionId: 'run' }, secret, `${nonce}:1`);
      // session/open above already holds one of the grant's 32 process slots.
      for (let i = 0; i < 31; i++) await interrupt(`process${String(i).padStart(3, '0')}`);
      expect((await interrupt('restarted')).error.code).toBe('CLIENT_LIMIT');
      vi.setSystemTime(Date.now() + 10 * 60_000);
      expect((await interrupt('restarted')).error).toBeUndefined();
      expect((await interrupt('process000')).error.code).toBe('REQUEST_EXPIRED');
      expect(f.call).toHaveBeenCalledTimes(32);
    } finally {
      vi.useRealTimers();
    }
  });
  it('round trips actual MCP calls through ordered events and resolves exactly one host answer', async () => {
    const f = await fixture(),
      secret = await f.connect();
    await f.start(secret);
    const bridge = f.bridge();
    const pending = fetch(bridge.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'send', arguments: { text: 'hello' } },
      }),
    }).then((r) => r.json());
    const events = (await f.rpc('events', { sessionId: 'run', cursor: 0 }, secret)).result.events;
    expect(events[0].event.type).toBe('host_tool');
    expect(events[0].event.data.arguments).toEqual({ text: 'hello' });
    const answer = {
      sessionId: 'run',
      callId: events[0].event.data.id,
      text: 'sent',
      isError: false,
    };
    expect((await f.rpc('tool/reply', { ...answer, text: 42 }, secret)).error.code).toBe(
      'INVALID_REQUEST',
    );
    expect((await f.rpc('tool/reply', answer, secret)).error).toBeUndefined();
    expect(((await pending) as any).result).toEqual({
      content: [{ type: 'text', text: 'sent' }],
      isError: false,
    });
    expect((await f.rpc('tool/reply', answer, secret)).error.code).toBe('TOOL_UNAVAILABLE');
  });
  it('persists an opaque owned resume handle across desktop restarts and refuses another grant', async () => {
    const f = await fixture(),
      secret = await f.connect();
    const opened = (await f.start(secret)).result;
    expect(opened.id).not.toBe('native-session');
    await f.restart();
    const second = await f.start(secret, 'after', { resume: opened.id });
    expect(second.result.resumed).toBe(true);
    expect(f.open.mock.calls.at(-1)?.[0].resume).toBe('native-session');
    const foreign = await f.connect();
    expect((await f.start(foreign, 'foreign', { resume: opened.id })).error.code).toBe(
      'RESUME_UNAVAILABLE',
    );
    await f.server().revokeAll();
    expect(f.close).toHaveBeenCalledTimes(2);
  });
  it('starts a new model with an explicit context handoff while keeping the original model resume binding', async () => {
    const other = { ...model, id: 'other-supplier-model' };
    const f = await fixture({ models: async () => [model, other] });
    const secret = await f.connect();
    const first = (await f.start(secret)).result;
    const changed = await f.start(secret, 'changed', { model: other.id, resume: first.id });
    expect(changed.error).toBeUndefined();
    expect(changed.result.resumed).toBe(false);
    expect(changed.result.id).not.toBe(first.id);
    expect(f.open.mock.calls.at(-1)?.[0].resume).toBeUndefined();
    const original = await f.start(secret, 'original', { resume: first.id });
    expect(original.result.resumed).toBe(true);
    expect(f.open.mock.calls.at(-1)?.[0].resume).toBe('native-session');
  });
  it('persists a durable engine ID learned only after sending the first message', async () => {
    let nativeId = 'pending';
    const f = await fixture({
      open: async () => ({
        get id() {
          return nativeId;
        },
        resumed: false,
        call: async () => {
          nativeId = 'durable-thread';
          return {};
        },
        close: async () => {},
      }),
    });
    const secret = await f.connect();
    const opened = (await f.start(secret)).result;
    await f.rpc('send', { sessionId: 'run', parts: [{ type: 'text', text: 'hello' }] }, secret);
    await f.restart();
    const resumed = await f.start(secret, 'again', { resume: opened.id });
    expect(resumed.error).toBeUndefined();
    const stored = JSON.parse(await fs.readFile(path.join(f.directory, 'grants.json'), 'utf8'));
    expect(JSON.stringify(stored)).toContain('durable-thread');
    expect(JSON.stringify(stored)).not.toContain('pending');
  });
  it('delivers a single large event without a cursor gap and wakes a poll on revoke', async () => {
    const f = await fixture(),
      secret = await f.connect();
    await f.start(secret);
    f.bridge().emit({ type: 'text', data: 'x'.repeat(1100 * 1024) });
    f.bridge().emit({ type: 'text', data: 'tail' });
    const first = (await f.rpc('events', { sessionId: 'run', cursor: 0 }, secret)).result;
    expect(first.cursor).toBe(1);
    expect(first.events).toHaveLength(1);
    const second = (await f.rpc('events', { sessionId: 'run', cursor: 1 }, secret)).result;
    expect(second.cursor).toBe(2);
    expect(second.events[0].event.data).toBe('tail');
    const poll = f.rpc('events', { sessionId: 'run', cursor: 2 }, secret);
    await f.server().revokeAll();
    expect((await poll).error).toBeDefined();
  });
});
