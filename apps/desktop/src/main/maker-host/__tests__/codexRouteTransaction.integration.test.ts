import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { sessions } from '../../localDb/schema.js';
import { commitCodexThreadTransfer, relinkCodexProviderThread, type CodexThreadTransferSnapshot } from '../../maker-ipc/codexProviderThreadRelink.js';
import { applyRuntimeSetModelChange } from '../../maker-ipc/runtimeSetModel.js';
import { clearSessionProvider, setSessionProvider } from '../session-provider-store.js';
import type { Logger } from '../../../../../../packages/maker-core/src/interfaces/logger.js';
import { AppServerHost } from '../../../../../../packages/maker-core/src/agents/codex/app-server/host.js';
import { Maker } from '../../../../../../packages/maker-core/src/maker.js';
import type { SessionMeta, SessionStorage } from '../../../../../../packages/maker-core/src/interfaces/session-storage.js';
import { CodexAgent } from '../../../../../../packages/maker-core/src/agents/codex/index.js';
import { buildUserProvider } from '@cindy/model-providers';
import { setCustomProviders } from '../active-catalog.js';
import { beginProviderRouteMutation, captureCodexLocalAuthPolicy } from '../provider-route.js';
vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseCindyGateway: true }) }));

// Explicit opt-in: never discover a user's installed runtime or credentials.
const binaryPath = process.env.CINDY_TEST_CODEX_BINARY;
const logger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child: () => logger,
};

describe.skipIf(!binaryPath)('Desktop route transactions with real Codex app-server', () => {
  it.each([...['A', 'B', 'C', 'initialize', 'capability', 'resume', 'transfer'].flatMap((window) => [false, true].map((reviewMode) => ({ window, reviewMode }))), ...['skills', 'config'].map((window) => ({ window, reviewMode: true })), ...['restricted', 'bot', 'local-skill', 'transfer-fork-failure', 'transfer-cas-failure', 'transfer-resume-failure', 'transfer-busy'].map((window) => ({ window, reviewMode: false }))])('waits for Desktop window $window with Review=$reviewMode before start and switch', async ({ window, reviewMode }) => {
    const releases: Array<() => void> = [];
    const beginMutation = () => { const finish = beginProviderRouteMutation('cprov-fixture'); releases.push(finish); return finish; };
    const lateWindow = ['initialize', 'capability', 'resume', 'skills', 'config', 'restricted', 'bot', 'local-skill'].includes(window);
    const revoked = !lateWindow && !window.startsWith('transfer');
    const root = await mkdtemp(path.join(tmpdir(), 'cindy-codex-host-auth-'));
    const home = path.join(root, 'codex');
    const workingDir = path.join(root, 'work');
    await mkdir(home);
    await mkdir(workingDir);
    const calls: string[] = [];
    let responseGate: Promise<void> | undefined;
    let releaseResponse = () => {};
    const server = createServer(async (req, res) => {
      for await (const chunk of req) void chunk;
      calls.push(`${req.method} ${req.url}`);
      if (req.url === '/provider/responses') {
        expect(req.headers.authorization).toBe('Bearer synthetic-invalid-api-key');
        await responseGate;
        res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
        const events = [
          { type: 'response.created', response: { id: 'response-fixture' } },
          { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'message-fixture', content: [{ type: 'output_text', text: 'fixture complete' }] } },
          { type: 'response.completed', response: { id: 'response-fixture', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ];
        res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      } else {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: req.url === '/oauth/token' ? 'refresh_token_invalidated' : 'unauthorized', message: 'synthetic revoked token' } }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const authPath = path.join(home, 'auth.json');
    let authFixture: string | undefined;
    if (revoked) {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      authFixture = JSON.stringify({
        auth_mode: 'chatgpt', OPENAI_API_KEY: null,
        tokens: {
          id_token: `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ email: 'fixture@example.invalid', 'https://api.openai.com/auth': { chatgpt_plan_type: 'business', chatgpt_user_id: 'fixture-user', chatgpt_account_id: 'fixture-account' } })}.c3ludGhldGlj`,
          access_token: 'synthetic-invalid-access-token', refresh_token: 'synthetic-invalid-refresh-token', account_id: 'fixture-account',
        }, last_refresh: new Date().toISOString(),
      });
      await writeFile(authPath, authFixture, { mode: 0o600 });
    }
    await writeFile(path.join(home, 'config.toml'), [
      'model="fixture-model"', 'model_provider="fixture"', 'cli_auth_credentials_store="file"',
      `chatgpt_base_url="${endpoint}"`, 'check_for_update_on_startup=false',
      '[analytics]', 'enabled=false',
      '[mcp_servers.cindy_memory]', 'command="/usr/bin/false"', 'enabled=false',
      '[model_providers.fixture]', 'name="Fixture"', `base_url="${endpoint}/provider"`,
      'wire_api="responses"', 'env_key="FIXTURE_API_KEY"', 'requires_openai_auth=false', 'supports_websockets=false', 'request_max_retries=0',
    ].join('\n'));
    setCustomProviders([buildUserProvider({ id: 'cprov-fixture', name: 'Fixture', runtimes: { codex: { baseUrl: `${endpoint}/provider`, wireProtocol: 'openai-responses', models: [{ id: 'fixture-model', name: 'Fixture' }] } } })]);
    const spawnConfigs: string[] = [];
    let preparationGate: Promise<void> | undefined;
    const preparationEntered = vi.fn();
    let latePreparation: (() => Promise<void>) | undefined;
    let rejectResumeRequest = false;
    const agent = new CodexAgent({
      binaryPath: binaryPath!, logger, runtimeConfig: {},
      resolveCodexLocalAuthPolicy: captureCodexLocalAuthPolicy,
      ...(window === 'restricted' ? { capabilityRouting: { overrides: [{ capabilityId: 'computer-use', source: { kind: 'harness-plugin' as const, harness: 'codex' as const, surface: 'skill' as const, id: 'computer-use:computer-use', artifactId: 'computer-use', containerId: 'computer-use@openai-bundled' }, invocation: 'disabled' as const }] } } : {}),
      ...(window === 'local-skill' ? { getDisabledSkillPaths: () => [path.join(root, 'disabled-skill')] } : {}),
      resolveCapabilityRouting: async () => { if (window === 'capability') await latePreparation?.(); return undefined; },
      prepareCodexResumeSession: async () => { preparationEntered(); if (window === 'resume') await latePreparation?.(); await preparationGate; return undefined; },
      prepareCodexExtraSpawnConfig: async (_providers, ctx) => { spawnConfigs.push(ctx?.localAuthPolicy ?? 'legacy-shared'); return { extraArgs: [], extraEnv: {}, codexProxyActive: true }; },
      auth: {
        getState: async () => ({ authenticated: true }),
        triggerLogin: async () => ({ authenticated: true }), logout: async () => {},
        getAuthEnv: async () => ({
          HOME: root, CODEX_HOME: home, TMPDIR: root, FIXTURE_API_KEY: 'synthetic-invalid-api-key',
          OPENAI_API_KEY: '', CODEX_API_KEY: '',
          CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${endpoint}/oauth/token`,
          HTTP_PROXY: endpoint, HTTPS_PROXY: endpoint, ALL_PROXY: endpoint, NO_PROXY: '127.0.0.1,localhost',
        }),
      },
    });
    const spies: Array<{ mockRestore: () => void }> = [];
    try {
      if (window.startsWith('transfer')) {
        const sqlite = new Database(':memory:');
        sqlite.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT, agent_kind TEXT, remote_host_id TEXT, sdk_session_id TEXT, model TEXT, provider_id TEXT, effort TEXT, fast_mode INTEGER, updated_at INTEGER)');
        const db = { drizzle: drizzle(sqlite) } as unknown as Pick<DbClient, 'drizzle'>;
        const rows = new Map<string, SessionMeta>();
        const storage: SessionStorage = {
          create: async (meta) => {
            const row = { ...meta, createdAt: 1, updatedAt: 1 }; rows.set(row.id, row);
            sqlite.prepare('INSERT INTO sessions VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)').run(row.id, 'active', 'codex', row.sdkSessionId ?? null, row.model, 'openai', 'high', 0, 1);
            return row;
          },
          get: async (id) => {
            const persisted = sqlite.prepare('SELECT sdk_session_id AS sdkSessionId, model FROM sessions WHERE id = ?').get(id) as { sdkSessionId: string; model: string } | undefined;
            return rows.has(id) ? { ...rows.get(id)!, ...persisted } : null;
          },
          list: async () => [...rows.values()],
          update: async (id, patch) => {
            const row = { ...rows.get(id)!, ...patch }; rows.set(id, row);
            if (patch.sdkSessionId) sqlite.prepare('UPDATE sessions SET sdk_session_id = ? WHERE id = ?').run(patch.sdkSessionId, id);
            return row;
          },
          compareAndClearSdkSessionId: async () => false,
          delete: async (id) => { rows.delete(id); },
        };
        const maker = new Maker({ agents: { codex: agent }, storage, logger });
        const send = async (session: NonNullable<ReturnType<Maker['getSession']>>) => {
          let off: () => void = () => {};
          const done = new Promise<void>((resolve, reject) => {
            off = session.onEvent((event) => {
              if (event.type === 'error') { off(); reject(new Error(JSON.stringify(event))); }
              if (event.type === 'done') { off(); resolve(); }
            });
          });
          const result = await session.send('fixture transfer');
          if (!result.accepted) { off(); return; }
          await done;
        };
        const acceptedForks: AppServerHost[] = [];
        const request = AppServerHost.prototype.request;
        spies.push(vi.spyOn(AppServerHost.prototype, 'request').mockImplementation(function (this: AppServerHost, method, params, opts) {
          if (method === 'thread/resume' && rejectResumeRequest) {
            rejectResumeRequest = false;
            params = { ...params as object, modelProvider: 'missing-fixture-provider' };
          }
          return request.call(this, method, params, { ...opts, beforeDispatch: () => {
            opts?.beforeDispatch?.(); if (method === 'thread/fork') acceptedForks.push(this);
          } });
        }));
        try {
          setSessionProvider('source', 'openai');
          const sibling = await maker.createSession({ id: 'unrelated', agentKind: 'codex', providerId: 'openai', model: 'fixture-model', workingDir });
          let source = await maker.createSession({ id: 'source', agentKind: 'codex', providerId: 'openai', model: 'fixture-model', workingDir, ...(reviewMode ? { reviewMode: true as const } : {}) });
          await send(source);
          const hostMap = (agent as unknown as { hosts: Map<string, AppServerHost> }).hosts;
          const siblingHost = hostMap.get('local')!;
          const connection = siblingHost.getConnectionId();
          if (window === 'transfer-busy') {
            responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
            const inFlight = send(source);
            await expect.poll(() => source.isTurnRunning()).toBe(true);
            await expect.poll(() => calls.filter((call) => call === 'POST /provider/responses').length).toBe(2);
            const relink = vi.fn(async () => {});
            await expect(applyRuntimeSetModelChange({
              maker, sessionId: 'source', model: 'fixture-model', providerId: 'cprov-fixture',
              requiresCodexThreadRelink: true, relinkCodexThread: relink,
            })).rejects.toThrow(/busy/);
            expect(relink).not.toHaveBeenCalled();
            expect(maker.getSession('source')).toBe(source);
            expect(acceptedForks).toHaveLength(0);
            await source.abort();
            releaseResponse();
            await inFlight;
            expect(siblingHost.getConnectionId()).toBe(connection);
            await send(sibling);
            return;
          }
          for (const providerId of ['cprov-fixture', 'openai']) {
            const sourceRow = (await db.drizzle.select({ id: sessions.id, sdkSessionId: sessions.sdkSessionId, model: sessions.model, providerId: sessions.providerId, effort: sessions.effort, fastMode: sessions.fastMode, updatedAt: sessions.updatedAt }).from(sessions)).find((row) => row.id === 'source')!;
            const original = sourceRow.sdkSessionId!;
            const rolloutPath = await (agent as unknown as { findRolloutPath(id: string): Promise<string> }).findRolloutPath(original);
            const history = await readFile(rolloutPath, 'utf8');
            const target = { sessionId: 'source', model: 'fixture-model', providerId, ...(reviewMode ? { reviewMode: true as const } : {}) };
            const required = await maker.requiresCodexThreadHostTransfer({ ...target, threadId: original });
            expect(required).toBe(true);
            const before = acceptedForks.length;
            const switching = applyRuntimeSetModelChange({
              maker, sessionId: 'source', model: target.model, providerId,
              requiresCodexThreadRelink: () => maker.requiresCodexThreadHostTransfer({ ...target, threadId: original }),
              relinkCodexThread: async () => {
                await relinkCodexProviderThread({
                  readSource: async () => ({ ...sourceRow, model: sourceRow.model!, workingDir }),
                  needsFork: (threadId) => maker.requiresCodexThreadHostTransfer({ ...target, threadId }),
                  fork: ({ sourceSdkSessionId }) => maker.forkSdkSession('codex', { sourceSdkSessionId: window === 'transfer-fork-failure' ? '00000000-0000-4000-8000-000000000000' : sourceSdkSessionId, model: target.model, providerId, workingDir, stripEncryptedReasoning: false, upToMessageId: undefined }),
                  commit: ({ newSdkSessionId }) => {
                    if (window === 'transfer-cas-failure') sqlite.exec("UPDATE sessions SET model = 'newer', updated_at = 2 WHERE id = 'source'");
                    return commitCodexThreadTransfer(db, sourceRow as CodexThreadTransferSnapshot, { sdkSessionId: newSdkSessionId, model: target.model, providerId, effort: 'high', fastMode: false });
                  },
                }, { sessionId: 'source', target: { model: target.model, providerId, effort: 'high', fastMode: false } });
              },
            });
            if (window === 'transfer-fork-failure' || window === 'transfer-cas-failure') {
              await expect(switching).rejects.toThrow();
              expect((await storage.get('source'))!.sdkSessionId).toBe(original);
              if (window === 'transfer-cas-failure') expect((await storage.get('source'))!.model).toBe('newer');
              expect(acceptedForks.length - before).toBeLessThanOrEqual(1);
              expect([...hostMap.keys()].some((key) => key.startsWith('local-fork:'))).toBe(false);
              expect(await readFile(rolloutPath, 'utf8')).toBe(history);
              expect(siblingHost.getConnectionId()).toBe(connection);
              await send(sibling);
              return;
            }
            expect(await switching).toEqual({ status: 'applied', persistedRoute: true });
            const replacement = (await storage.get('source'))!.sdkSessionId!;
            // Review's dedicated host may exit at close, so no fork is needed then.
            expect(acceptedForks.length - before).toBe(reviewMode ? 0 : 1);
            if (!reviewMode) expect(replacement).not.toBe(original);
            expect(await readFile(rolloutPath, 'utf8')).toBe(history);
            expect([...hostMap.keys()].some((key) => key.startsWith('local-fork:'))).toBe(false);
            const resumeOptions = { id: 'source', agentKind: 'codex' as const, providerId, model: target.model, workingDir, resumeSessionId: replacement, ...(reviewMode ? { reviewMode: true as const } : {}) };
            if (window === 'transfer-resume-failure') {
              rejectResumeRequest = true;
              await expect(maker.createSession(resumeOptions)).rejects.toThrow(/provider/i);
              expect((await storage.get('source'))!.sdkSessionId).toBe(replacement);
              expect(acceptedForks.length - before).toBe(1);
            }
            source = await maker.createSession(resumeOptions);
            expect(source.codexHostKey?.includes('external-auth')).toBe(providerId === 'cprov-fixture');
            await send(source);
            expect(hostMap.get('local')).toBe(siblingHost);
            expect(siblingHost.getConnectionId()).toBe(connection);
            await send(sibling);
          }
        } finally {
          await maker.shutdown();
          clearSessionProvider('source');
          sqlite.close();
        }
        return;
      }
      if (lateWindow) {
        // Start a shared sibling first; the target will initially select that host
        // from an unknown route, then the real Desktop transaction installs API auth.
        setCustomProviders([]);
        const sibling = await agent.startSession({ sessionId: 'sibling', model: 'fixture-model', providerId: 'cprov-fixture', workingDir });
        let resumeThreadId: string | undefined;
        if (window === 'resume') {
          const source = await agent.startSession({ sessionId: 'source', model: 'fixture-model', providerId: 'cprov-fixture', workingDir });
          const done = (async () => { for await (const event of source.events()) { if (event.type === 'error') throw new Error(JSON.stringify(event)); if (event.type === 'done') return; } })();
          await source.send({ type: 'user', content: 'persist fixture' }, { throwOnStartFailure: true });
          await done;
          await source.close();
          // 0.153 retains source's writer after unsubscribe. Resume preparation
          // starts with a released native child; the unrelated sibling stays live.
          resumeThreadId = (await agent.forkSdkSession({ sourceSdkSessionId: source.id, upToMessageId: undefined, model: 'fixture-model', providerId: 'cprov-fixture', stripEncryptedReasoning: false })).newSdkSessionId;
        }
        const hostMap = (agent as unknown as { hosts: Map<string, AppServerHost> }).hosts;
        const siblingHost = hostMap.get('local')!;
        const siblingConnection = siblingHost.getConnectionId();
        const accepted: Array<{ host: AppServerHost; method: string }> = [];
        const request = AppServerHost.prototype.request;
        spies.push(vi.spyOn(AppServerHost.prototype, 'request').mockImplementation(function (this: AppServerHost, method, params, opts) {
          const result = request.call(this, method, params, { ...opts, beforeDispatch: () => {
            opts?.beforeDispatch?.();
            if (['thread/start', 'thread/resume'].includes(method)) accepted.push({ host: this, method });
          } });
          const pauseMethod = ['skills', 'restricted'].includes(window) ? 'skills/list'
            : ['config', 'bot', 'local-skill'].includes(window) ? 'config/read' : undefined;
          return pauseMethod === method ? result.then(async (response) => { await latePreparation?.(); return response; }) : result;
        }));
        let entered!: () => void;
        let release!: () => void;
        const waiting = new Promise<void>((resolve) => { entered = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let once = false;
        latePreparation = async () => { if (!once) { once = true; entered(); await gate; } };
        const initialize = AppServerHost.prototype.ensureStartedWithTimeout;
        if (window === 'initialize') spies.push(vi.spyOn(AppServerHost.prototype, 'ensureStartedWithTimeout').mockImplementation(async function (this: AppServerHost, ...args) {
          const result = await initialize.apply(this, args);
          await latePreparation?.();
          return result;
        }));
        const rows = new Map<string, SessionMeta>();
        const storage: SessionStorage = {
          create: async (meta) => { const row = { ...meta, createdAt: 0, updatedAt: 0 }; rows.set(row.id, row); return row; },
          get: async (id) => rows.get(id) ?? null,
          list: async () => [...rows.values()],
          update: async (id, patch) => { const row = { ...rows.get(id)!, ...patch }; rows.set(id, row); return row; },
          compareAndClearSdkSessionId: async () => false,
          delete: async (id) => { rows.delete(id); },
        };
        let startupGuard = false;
        const failed = vi.fn();
        const maker = new Maker({ agents: { codex: agent }, storage, logger, lifecycleHooks: {
          onBeforeStart: async () => { startupGuard = true; },
          onStartSucceeded: async () => { startupGuard = false; }, onStartFailed: failed,
        } });
        const target = maker.createSession({ id: 'late-target', agentKind: 'codex', providerId: 'cprov-fixture', model: 'fixture-model', workingDir,
          ...(window === 'bot' ? { botRuntimeProfile: { botId: 'fixture', profileVersion: 1, skillPolicy: { mode: 'allowlist' as const, configured: [], catalog: [] }, toolsetPolicy: { mode: 'allowlist' as const, configured: [], catalog: [] }, mcpPolicy: { mode: 'allowlist' as const, configured: [], catalog: [] } } } : {}),
          ...(reviewMode ? { reviewMode: true as const } : {}), ...(resumeThreadId ? { resumeSessionId: resumeThreadId } : {}),
        });
        try {
          await waiting;
          const finish = beginMutation();
          setCustomProviders([buildUserProvider({ id: 'cprov-fixture', name: 'Fixture', runtimes: { codex: { baseUrl: `${endpoint}/provider`, wireProtocol: 'openai-responses', models: [{ id: 'fixture-model', name: 'Fixture' }] } } })]);
          release();
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(accepted).toEqual([]);
          finish.commit(); finish();
          const handle = await target;
          expect(handle.codexHostKey).toContain('external-auth');
          expect(startupGuard).toBe(false);
          expect(failed).not.toHaveBeenCalled();
          expect(accepted).toHaveLength(1);
          expect(accepted[0].host).not.toBe(siblingHost);
          if (reviewMode) expect(hostMap.has('local-review:late-target')).toBe(false);
          expect(spawnConfigs.at(-1)).toBe('isolated');
          // No forced retirement or cleanup of the live sibling on the shared host.
          expect(hostMap.get('local')).toBe(siblingHost);
          expect(siblingHost.getConnectionId()).toBe(siblingConnection);
          await maker.closeSession('late-target');
          await sibling.close();
        } finally { release(); }
        return;
      }
      const finish = beginMutation();
      let guard: Awaited<ReturnType<typeof agent.beginLocalHostCredentialChange>> | undefined;
      if (window === 'C') { guard = await agent.beginLocalHostCredentialChange(); await guard.finalize(); }
      let settled = false;
      const pending = agent.startSession({ sessionId: `fixture-${window}`, ...(reviewMode ? { reviewMode: true as const } : {}), providerId: 'cprov-fixture', model: 'fixture-model', workingDir })
        .then((handle) => { settled = true; return handle; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);
      expect(spawnConfigs).toEqual([]);
      if (window === 'A') { guard = await agent.beginLocalHostCredentialChange(); await guard.finalize(); }
      finish.commit(); finish();
      const handle = await pending;
      expect(handle.codexHostKey).toBe(reviewMode ? `local-review:fixture-${window}:external-auth` : 'local:external-auth');
      expect(spawnConfigs.every((policy) => policy === 'isolated')).toBe(true);
      const switchFinish = beginMutation();
      let switchSettled = false;
      const switching = Promise.resolve(handle.requiresModelSwitchRebuild!('fixture-model', { providerId: 'cprov-fixture' }))
        .then((result) => { switchSettled = true; return result; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(switchSettled).toBe(false);
      switchFinish();
      expect(await switching).toBe(false);
      const cloudCallsBeforeCustom: string[] = [];
      const events = (async () => {
        for await (const event of handle.events()) {
          if (event.type === 'error') throw new Error(JSON.stringify(event));
          if (event.type === 'done') return;
        }
      })();
      await handle.send({ type: 'user', content: 'return fixture complete' }, { throwOnStartFailure: true });
      await expect.poll(() => calls.filter((call) => call === 'POST /provider/responses').length, { timeout: 10_000 }).toBe(1);
      expect(calls.filter((call) => call.includes('/oauth/token') || call.includes('/config/bundle'))).toEqual(cloudCallsBeforeCustom);
      if (authFixture) expect(await readFile(authPath, 'utf8')).toBe(authFixture);
      await events;
      await handle.close();
      if (!reviewMode && window === 'B') {
        const rolloutPath = await (agent as unknown as { findRolloutPath(id: string): Promise<string> }).findRolloutPath(handle.id);
        const originalRollout = await readFile(rolloutPath, 'utf8');
        await expect(agent.forkSdkSession({ sourceSdkSessionId: handle.id, upToMessageId: undefined, providerId: 'cprov-fixture', model: 'fixture-model', stripEncryptedReasoning: true })).rejects.toMatchObject({ name: 'CodexHistoryRecoveryRequiredError' });
        expect(await readFile(rolloutPath, 'utf8')).toBe(originalRollout);
        const acceptedForks: AppServerHost[] = [];
        const forkRequest = AppServerHost.prototype.request;
        spies.push(vi.spyOn(AppServerHost.prototype, 'request').mockImplementation(function (this: AppServerHost, method, params, opts) {
          return forkRequest.call(this, method, params, { ...opts, beforeDispatch: () => {
            opts?.beforeDispatch?.();
            if (method === 'thread/fork') acceptedForks.push(this);
          } });
        }));
        for (const delay of ['none', 'after-start']) {
          const acceptedBefore = acceptedForks.length;
          const delayPreparation = delay !== 'none';
          let releasePreparation: () => void = () => {};
          if (delayPreparation) preparationGate = new Promise<void>((resolve) => { releasePreparation = resolve; });
          preparationEntered.mockClear();
          let finishFork = delayPreparation ? undefined : beginMutation();
          let forkSettled = false;
          const forking = agent.forkSdkSession({ sourceSdkSessionId: handle.id, upToMessageId: undefined, providerId: 'cprov-fixture', model: 'fixture-model', stripEncryptedReasoning: false })
            .then((result) => { forkSettled = true; return result; });
          try {
            if (delayPreparation) await expect.poll(() => preparationEntered.mock.calls.length).toBeGreaterThanOrEqual(1);
            const pausedForkHost = delayPreparation
              ? [...(agent as unknown as { hosts: Map<string, AppServerHost> }).hosts].find(([key]) => key.startsWith('local-fork:'))?.[1]
              : undefined;
            if (delayPreparation) expect(pausedForkHost).toBeDefined();
            if (delayPreparation) finishFork = beginMutation();
            releasePreparation();
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(forkSettled).toBe(false);
            finishFork?.();
            const fork = await forking;
            expect(fork.newSdkSessionId).not.toBe(handle.id);
            expect(acceptedForks).toHaveLength(acceptedBefore + 1);
            if (delayPreparation) expect(acceptedForks.at(-1)).not.toBe(pausedForkHost);
            expect(await readFile(rolloutPath, 'utf8')).toBe(originalRollout);
            expect(spawnConfigs.every((policy) => policy === 'isolated')).toBe(true);
          } finally { releasePreparation(); finishFork?.(); }
        }
      }
      if (!reviewMode && window === 'B') {
        const finishCancel = beginMutation();
        const cancelled = agent.startSession({ sessionId: 'cancelled-route', providerId: 'cprov-fixture', model: 'fixture-model', workingDir });
        const rejection = expect(cancelled).rejects.toThrow(/cancelled/);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await agent.dispose();
        await rejection;
        finishCancel();
      }
    } finally {
      releaseResponse();
      for (const spy of spies) spy.mockRestore();
      for (const release of releases) release();
      setCustomProviders([]);
      await agent.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});
