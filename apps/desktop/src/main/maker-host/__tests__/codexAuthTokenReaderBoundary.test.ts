import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { CodexExternalAuthSession, useCodexHistoryHome } from '../../../../../../packages/maker-core/src/agents/codex/app-server/external-auth';
import { AppServerHost } from '../../../../../../packages/maker-core/src/agents/codex/app-server/host';
import { createStdioTransport } from '../../../../../../packages/maker-core/src/agents/codex/app-server/stdioTransport';
import type { Logger } from '../../../../../../packages/maker-core/src/interfaces/logger';

// Execute the actual host callback without bootstrapping Electron or real credentials.
const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const callback = source.slice(source.indexOf('createCodexAuthTokenReader:') + 'createCodexAuthTokenReader:'.length,
  source.indexOf('recordCodexThreadLocation:', source.indexOf('createCodexAuthTokenReader:'))).trim().replace(/,$/, '');

describe('Codex token reader owner boundary', () => {
  it.each(['before', 'during', 'stable', 'owner-change'])('handles %s credential reads', async phase => {
    let pending = phase === 'before';
    let owner = 'owner-a';
    const agent = {};
    const readOneShotCreds = vi.fn(() => ({ accessToken: 'fixture-token', accountId: 'account-b' }));
    const getState = vi.fn(async () => {
      if (phase === 'during') pending = true;
      if (phase === 'owner-change') owner = 'owner-b';
      return { authenticated: true };
    });
    const createReader = runInNewContext(`(${callback})`, {
      activeOwnerScopeKey: () => owner,
      getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: owner }),
      getActiveAuthRealm: () => 'global',
      codexAgent: agent,
      _codexAgent: agent,
      isAppSessionBoundaryPending: () => pending,
      desktopCodexAuthAdapter: { getState, readOneShotCreds },
    });
    const reader = createReader('account-b');
    if (phase === 'stable') {
      await expect(reader()).resolves.toEqual({ accessToken: 'fixture-token', chatgptAccountId: 'account-b' });
      expect(readOneShotCreds).toHaveBeenCalledWith('account-b');
    } else {
      await expect(reader()).rejects.toThrow('Codex authentication owner changed');
      expect(readOneShotCreds).not.toHaveBeenCalled();
      if (phase === 'before') expect(getState).not.toHaveBeenCalled();
    }
  });

  function fixture(oldToken = 'fixture-old-token', newToken = 'fixture-new-token', initialRealm = 'global') {
    const owner = { mode: 'cloud', dataOwnerId: 'owner-a', generation: 1 };
    const agent = {};
    let pending = false;
    let realm = initialRealm;
    let accessToken = oldToken;
    const readOneShotCreds = vi.fn(() => ({ accessToken, accountId: 'account-b' }));
    const getState = vi.fn(async () => ({ authenticated: true }));
    const context = {
      activeOwnerScopeKey: () => `${owner.mode}:${owner.dataOwnerId}:${owner.generation}`,
      getActiveAppSession: () => ({ ...owner }),
      getActiveAuthRealm: () => realm,
      isAppSessionBoundaryPending: () => pending,
      codexAgent: agent,
      _codexAgent: agent as object | null,
      desktopCodexAuthAdapter: { getState, readOneShotCreds },
    };
    const createReader = runInNewContext(`(${callback})`, context);
    return { owner, context, getState, readOneShotCreds, reader: createReader('account-b'),
      setPending: (value: boolean) => { pending = value; },
      setRealm: (value: string) => { realm = value; },
      renew: () => { accessToken = newToken; },
    };
  }

  it('refreshes a live cross-account task after a completed same-owner projection repair', async () => {
    const f = fixture();
    const session = new CodexExternalAuthSession({ readTokens: f.reader });
    await expect(session.tokens(false)).resolves.toMatchObject({ accessToken: 'fixture-old-token' });
    // Ghost repair fences in-flight reads, but preserves Maker and the task's native host.
    f.owner.generation++;
    f.renew();
    await expect(session.tokens(true, 'account-b')).resolves.toEqual({
      accessToken: 'fixture-new-token', chatgptAccountId: 'account-b',
    });
    expect(f.readOneShotCreds).toHaveBeenCalledTimes(2);
  });

  it('rejects a read spanning same-owner repair and permits the next stable read', async () => {
    const f = fixture();
    f.getState.mockImplementationOnce(async () => {
      f.owner.generation++;
      return { authenticated: true };
    });
    await expect(f.reader()).rejects.toThrow('Codex authentication owner changed');
    expect(f.readOneShotCreds).not.toHaveBeenCalled();
    f.renew();
    await expect(f.reader()).resolves.toMatchObject({ accessToken: 'fixture-new-token' });
  });

  it('does not latch a temporary owner boundary as a permanent authentication failure', async () => {
    const f = fixture();
    f.setPending(true);
    await expect(f.reader()).rejects.toThrow('Codex authentication owner changed');
    expect(f.getState).not.toHaveBeenCalled();
    f.owner.generation++;
    f.setPending(false);
    await expect(f.reader()).resolves.toMatchObject({ chatgptAccountId: 'account-b' });
  });

  it.each(['owner', 'mode', 'replacement', 'reset'] as const)('rejects %s changes between reads', async change => {
    const f = fixture();
    await f.reader();
    f.readOneShotCreds.mockClear();
    f.getState.mockClear();
    if (change === 'owner') f.owner.dataOwnerId = 'owner-b';
    if (change === 'mode') f.owner.mode = 'local';
    if (change === 'replacement') f.context._codexAgent = {};
    if (change === 'reset') f.context._codexAgent = null;
    f.owner.generation++;
    await expect(f.reader()).rejects.toThrow('Codex authentication owner changed');
    expect(f.getState).not.toHaveBeenCalled();
    expect(f.readOneShotCreds).not.toHaveBeenCalled();
  });

  it('rejects a retired Maker even when the user switches away and back to the same owner', async () => {
    const f = fixture();
    f.context._codexAgent = {};
    f.owner.generation += 2;
    await expect(f.reader()).rejects.toThrow('Codex authentication owner changed');
    expect(f.getState).not.toHaveBeenCalled();
  });

  it('rejects runtime replacement during a credential read even without a scope change', async () => {
    const f = fixture();
    f.getState.mockImplementationOnce(async () => {
      f.context._codexAgent = {};
      return { authenticated: true };
    });
    await expect(f.reader()).rejects.toThrow('Codex authentication owner changed');
    expect(f.readOneShotCreds).not.toHaveBeenCalled();
  });

  it.each(['global', 'cn'])('rejects same-ID realm changes from %s between reads', async realm => {
    const f = fixture('fixture-old-token', 'fixture-new-token', realm);
    await f.reader();
    f.getState.mockClear();
    f.readOneShotCreds.mockClear();
    f.setRealm(realm === 'global' ? 'cn' : 'global');
    f.owner.generation++;
    f.renew();
    // Same membership ID and retained CodexAgent are insufficient across realms.
    await expect(f.reader()).rejects.toThrow('Codex authentication owner changed');
    expect(f.getState).not.toHaveBeenCalled();
    expect(f.readOneShotCreds).not.toHaveBeenCalled();
  });

  it.each(['global', 'cn'])('rejects a realm change from %s during a credential read', async realm => {
    const f = fixture('fixture-old-token', 'fixture-new-token', realm);
    f.getState.mockImplementationOnce(async () => {
      f.setRealm(realm === 'global' ? 'cn' : 'global');
      f.owner.generation++;
      return { authenticated: true };
    });
    await expect(f.reader()).rejects.toThrow('Codex authentication owner changed');
    expect(f.readOneShotCreds).not.toHaveBeenCalled();
    // The new realm remains rejected after its transition has settled.
    await expect(f.reader()).rejects.toThrow('Codex authentication owner changed');
    expect(f.getState).toHaveBeenCalledTimes(1);
  });

  // Explicit opt-in: real binary, fake credentials, temporary home, loopback only.
  it.skipIf(!process.env.CINDY_CODEX_TEST_BINARY)('recovers a native 401 in the same live thread after owner repair', async () => {
    const token = (revision: string) => `test.${Buffer.from(JSON.stringify({
      email: 'fixture@example.invalid', revision, exp: 4102444800,
      'https://api.openai.com/auth': { chatgpt_account_id: 'account-b', chatgpt_plan_type: 'pro' },
    })).toString('base64url')}.not-a-signature`;
    const oldToken = token('old');
    const newToken = token('new');
    const f = fixture(oldToken, newToken);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-auth-owner-repair-'));
    const requests: Array<{ authorization: string | undefined; account: unknown }> = [];
    const server = createServer((request, response) => {
      request.resume();
      if (request.method === 'POST' && request.url?.endsWith('/responses')) {
        requests.push({ authorization: request.headers.authorization, account: request.headers['chatgpt-account-id'] });
        if (request.headers.authorization !== `Bearer ${newToken}`) {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { code: 'token_expired', message: 'Provided authentication token is expired.' } }));
          return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: {
          id: 'resp_fixture', object: 'response', created_at: 1, status: 'completed', model: 'gpt-6-astra', output: [],
          usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
        } })}\n\n`);
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ models: [] }));
    });
    const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };
    let host: AppServerHost | undefined;
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing fixture listener');
      const base = `http://127.0.0.1:${address.port}`;
      host = new AppServerHost({ logger, clientInfo: { name: 'cindy-test', version: '0.0.0' },
        externalAuth: { readTokens: f.reader },
        createTransport: () => createStdioTransport({ binaryPath: process.env.CINDY_CODEX_TEST_BINARY!, cwd: root,
          env: useCodexHistoryHome({ PATH: process.env.PATH ?? '', HOME: root, USERPROFILE: root, TMPDIR: root,
            ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, root),
          extraArgs: ['--disable', 'plugins', '--disable', 'remote_plugin',
            '-c', 'cli_auth_credentials_store="ephemeral"', '-c', 'model_provider="probe"',
            '-c', 'model_providers.probe.name="Probe"', '-c', `model_providers.probe.base_url=${JSON.stringify(base)}`,
            '-c', 'model_providers.probe.wire_api="responses"', '-c', 'model_providers.probe.requires_openai_auth=true',
            '-c', `chatgpt_base_url=${JSON.stringify(base)}`],
        }),
      });
      const { thread } = await host.request<{ thread: { id: string } }>('thread/start', {
        cwd: root, model: 'gpt-6-astra', approvalPolicy: 'never', sandbox: 'read-only',
      });
      // Match the incident: retained native process, same owner, newer disk token.
      f.owner.generation++;
      f.renew();
      let complete!: (value: unknown) => void;
      const completed = new Promise(resolve => { complete = resolve; });
      const subscription = host.subscribeThread(thread.id, { turnCompleted: complete });
      try {
        await host.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'fixture' }] });
        await expect(completed).resolves.toMatchObject({ threadId: thread.id, turn: { status: 'completed' } });
        expect(requests).toEqual([
          { authorization: `Bearer ${oldToken}`, account: 'account-b' },
          { authorization: `Bearer ${newToken}`, account: 'account-b' },
        ]);
        await expect(fs.stat(path.join(root, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally { await subscription.release(); }
    } finally {
      await host?.retire('fixture complete');
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
