/** Explicit runtime contract: CINDY_CODEX_TEST_BINARY=<absolute binary> vitest run <this file>. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AppServerHost } from './host.js';
import { createStdioTransport } from './stdioTransport.js';
import { useCodexHistoryHome, type CodexExternalAuth } from './external-auth.js';
import type { Logger } from '../../../interfaces/logger.js';

const binaryPath = process.env.CINDY_CODEX_TEST_BINARY;
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };
const roots: string[] = [];
const hosts: AppServerHost[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.retire('native contract test complete')));
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function fakeTokens(account: string, revision = 'initial') {
  const payload = Buffer.from(JSON.stringify({ email: `${account}@example.invalid`, revision, exp: 4102444800,
    'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_plan_type: 'pro' } })).toString('base64url');
  return { accessToken: `test.${payload}.not-a-signature`, chatgptAccountId: account, chatgptPlanType: 'pro' };
}

async function fixture(archivedParent = false, testRefresh = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-codex-history-contract-'));
  roots.push(root);
  const historyHome = path.join(root, 'history-a');
  const credentialHome = path.join(root, 'account-b');
  await fs.mkdir(credentialHome);
  const wireRequests: Array<{ authorization: string | undefined; account: string | string[] | undefined }> = [];
  const refreshRequests: unknown[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/oauth/token') {
      let body = '';
      for await (const chunk of request) body += chunk;
      refreshRequests.push(JSON.parse(body));
      const token = fakeTokens('account-b', 'refreshed').accessToken;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id_token: token, access_token: token, refresh_token: 'fixture-refresh-b2' }));
      return;
    }
    if (request.method === 'POST' && request.url?.endsWith('/responses')) {
      wireRequests.push({ authorization: request.headers.authorization, account: request.headers['chatgpt-account-id'] });
      request.resume();
      if (testRefresh && wireRequests.length === 1) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'expired fixture credential' } }));
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
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test listener');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  async function rollout(base?: { thread_id: string; end_ordinal_exclusive: number; end_byte_offset: number }, archived = false) {
    const id = randomUUID();
    const directory = path.join(historyHome, archived ? 'archived_sessions' : 'sessions/2026/09/12');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `rollout-2026-09-12T00-00-00-${id}.jsonl`);
    const ordinal = base?.end_ordinal_exclusive ?? 0;
    const meta = { session_id: id, id, timestamp: '2026-09-12T00:00:00.000Z', cwd: root,
      originator: 'cindy-contract-test', cli_version: '0.153.4', source: 'cli',
      history_mode: 'paginated', model_provider: 'probe',
      ...(base ? { history_base: base, forked_from_id: base.thread_id } : {}) };
    const text = [
      { ordinal, type: 'session_meta', payload: meta },
      { ordinal: ordinal + 1, type: 'response_item', payload: { type: 'message', role: 'user',
        content: [{ type: 'input_text', text: `history marker ${id}` }] } },
    ].map(item => JSON.stringify({ timestamp: '2026-09-12T00:00:00.000Z', ...item })).join('\n') + '\n';
    await fs.writeFile(file, text);
    return { id, file, text, base: { thread_id: id, end_ordinal_exclusive: ordinal + 2, end_byte_offset: Buffer.byteLength(text) } };
  }
  const parent = await rollout(undefined, archivedParent);
  const child = await rollout(parent.base);
  // Deliberately invalid persisted auth proves ephemeral startup never needs it.
  const oldAuth = 'history owner credential sentinel -- never read or replace';
  await fs.writeFile(path.join(historyHome, 'auth.json'), oldAuth);
  const authStat = await fs.stat(path.join(historyHome, 'auth.json'));
  function host(home: string, account?: string, managed = false, externalAuth?: CodexExternalAuth) {
    const env = useCodexHistoryHome({ PATH: process.env.PATH ?? '',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: root, USERPROFILE: root, TMPDIR: root,
      CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${baseUrl}/oauth/token` }, home);
    const instance = new AppServerHost({
      logger, clientInfo: { name: 'cindy-contract-test', version: '0.0.0' },
      ...(!managed && account ? { externalAuth: externalAuth ?? { readTokens: async (refresh: boolean) => fakeTokens(account, refresh ? 'refreshed' : 'initial') } } : {}),
      createTransport: () => createStdioTransport({ binaryPath: binaryPath!, cwd: root, env,
        extraArgs: ['--disable', 'plugins', '--disable', 'remote_plugin',
          '-c', `sqlite_home=${JSON.stringify(historyHome)}`,
          '-c', `cli_auth_credentials_store="${managed ? 'file' : 'ephemeral'}"`, '-c', 'model_provider="probe"',
          '-c', 'model_providers.probe.name="Probe"', '-c', `model_providers.probe.base_url=${JSON.stringify(baseUrl)}`,
          '-c', 'model_providers.probe.wire_api="responses"', '-c', `model_providers.probe.requires_openai_auth=${Boolean(account)}`,
          '-c', `chatgpt_base_url=${JSON.stringify(baseUrl)}`],
      }),
    });
    hosts.push(instance);
    return instance;
  }
  async function resume(instance: AppServerHost, thread: { id: string; file: string } = child) {
    return instance.request<{ thread: { id: string; path: string } }>('thread/resume', {
      threadId: thread.id, path: thread.file, model: 'gpt-6-astra', cwd: root,
      approvalPolicy: 'never', sandbox: 'read-only',
    }, { timeoutMs: 15_000 });
  }
  async function assertOriginals(managed = false) {
    expect(await fs.readFile(parent.file, 'utf8')).toBe(parent.text);
    expect(await fs.readFile(path.join(historyHome, 'auth.json'), 'utf8')).toBe(oldAuth);
    expect((await fs.stat(path.join(historyHome, 'auth.json'))).mtimeMs).toBe(authStat.mtimeMs);
    if (!managed) await expect(fs.stat(path.join(credentialHome, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  }
  return { root, historyHome, credentialHome, parent, child, rollout, host, resume, assertOriginals, wireRequests, refreshRequests };
}

describe.skipIf(!binaryPath)('real Codex history/account isolation contract', () => {
  it('reproduces the old split-home defect with a complete source rollout still on disk', async () => {
    const f = await fixture();
    const original = f.host(f.historyHome);
    await expect(f.resume(original)).resolves.toMatchObject({ thread: { id: f.child.id } });
    await original.retire();
    await expect(f.resume(f.host(f.credentialHome))).rejects.toThrow('missing source rollout');
    await f.assertOriginals();
  }, 30_000);

  it.each([false, true])('preserves full ancestry, account identity and restart (archived ancestor: %s)', async archived => {
    const f = await fixture(archived);
    const grandchild = await f.rollout(f.child.base);
    for (const account of ['account-a', 'account-b', 'account-a']) {
      const host = f.host(f.historyHome, account);
      await expect(f.resume(host, grandchild)).resolves.toMatchObject({ thread: { id: grandchild.id } });
      const status = await host.request('account/read', { refreshToken: false });
      expect(status).toMatchObject({ account: { type: 'chatgpt', email: `${account}@example.invalid`, planType: 'pro' } });
      await host.shutdown('simulate transport replacement');
      await expect(f.resume(host, grandchild)).resolves.toMatchObject({ thread: { id: grandchild.id } });
      expect(await host.request('account/read', { refreshToken: false })).toMatchObject({
        account: { email: `${account}@example.invalid` },
      });
      await host.retire();
    }
    await f.assertOriginals();
  }, 60_000);

  it('keeps native forks in the original history domain', async () => {
    const f = await fixture();
    const host = f.host(f.historyHome, 'account-b');
    await f.resume(host);
    const fork = await host.request<{ thread: { id: string; path: string } }>('thread/fork', {
      threadId: f.child.id, path: f.child.file, cwd: f.root, model: 'gpt-6-astra',
    }, { timeoutMs: 15_000 });
    expect((await fs.realpath(fork.thread.path)).startsWith((await fs.realpath(path.join(f.historyHome, 'sessions'))) + path.sep)).toBe(true);
    await host.retire();
    await expect(f.resume(f.host(f.historyHome, 'account-a'), {
      id: fork.thread.id, file: fork.thread.path })).resolves.toMatchObject({ thread: { id: fork.thread.id } });
    await f.assertOriginals();
  }, 30_000);

  it('rejects the old cross-home native fork path without changing source history', async () => {
    const f = await fixture();
    const original = f.host(f.historyHome, 'account-a');
    await f.resume(original, f.parent);
    await original.retire();
    const oldForkHost = f.host(f.credentialHome, 'account-b');
    await expect(oldForkHost.request('thread/fork', {
      threadId: f.parent.id, path: f.parent.file, cwd: f.root, model: 'gpt-6-astra',
    }, { timeoutMs: 15_000 })).rejects.toThrow('must be in Codex home directory');
    await f.assertOriginals();
  }, 30_000);

  it('refreshes managed credentials on disk after a native 401 even before natural expiry', async () => {
    const f = await fixture(false, true);
    const authPath = path.join(f.credentialHome, 'auth.json');
    const initial = fakeTokens('account-b').accessToken;
    // A freshly written managed login must still force-refresh after a rejected request.
    await fs.writeFile(authPath, JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null,
      tokens: { id_token: initial, access_token: initial, refresh_token: 'fixture-refresh-b', account_id: 'account-b' },
      last_refresh: new Date().toISOString() }));
    const accountHost = f.host(f.credentialHome, 'account-b', true);
    const host = f.host(f.historyHome, 'account-b', false, { readTokens: async refresh => {
      if (refresh) await accountHost.request('account/read', { refreshToken: true }, { timeoutMs: 8_000 });
      const credentials = JSON.parse(await fs.readFile(authPath, 'utf8'));
      return { accessToken: credentials.tokens.access_token, chatgptAccountId: credentials.tokens.account_id };
    } });
    await f.resume(host);
    let completed!: (value: unknown) => void;
    const completion = new Promise(resolve => { completed = resolve; });
    const subscription = host.subscribeThread(f.child.id, { turnCompleted: completed });
    try {
      await host.request('turn/start', { threadId: f.child.id, input: [{ type: 'text', text: 'fixture request' }] }, { timeoutMs: 15_000 });
      await expect(completion).resolves.toMatchObject({ turn: { status: 'completed' } });
      expect(f.wireRequests).toEqual([
        { authorization: `Bearer ${fakeTokens('account-b').accessToken}`, account: 'account-b' },
        { authorization: `Bearer ${fakeTokens('account-b', 'refreshed').accessToken}`, account: 'account-b' },
      ]);
      expect(f.refreshRequests).toEqual([expect.objectContaining({ grant_type: 'refresh_token', refresh_token: 'fixture-refresh-b' })]);
      expect(JSON.parse(await fs.readFile(authPath, 'utf8')).tokens).toMatchObject({
        access_token: fakeTokens('account-b', 'refreshed').accessToken, refresh_token: 'fixture-refresh-b2', account_id: 'account-b',
      });
      await f.assertOriginals(true);
    } finally {
      await subscription.release();
    }
  }, 30_000);
});
