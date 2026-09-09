import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../../../../packages/maker-core/src/interfaces/logger.js';
import { AppServerHost } from '../../../../../../packages/maker-core/src/agents/codex/app-server/host.js';
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
  it.each(['A', 'B', 'C', 'initialize', 'capability', 'resume'].flatMap((window) => [false, true].map((reviewMode) => ({ window, reviewMode }))))('waits for Desktop window $window with Review=$reviewMode before start and switch', async ({ window, reviewMode }) => {
    const releases: Array<() => void> = [];
    const beginMutation = () => { const finish = beginProviderRouteMutation('cprov-fixture'); releases.push(finish); return finish; };
    const lateWindow = ['initialize', 'capability', 'resume'].includes(window);
    const revoked = !lateWindow;
    const root = await mkdtemp(path.join(tmpdir(), 'cindy-codex-host-auth-'));
    const home = path.join(root, 'codex');
    const workingDir = path.join(root, 'work');
    await mkdir(home);
    await mkdir(workingDir);
    const calls: string[] = [];
    const server = createServer(async (req, res) => {
      for await (const chunk of req) void chunk;
      calls.push(`${req.method} ${req.url}`);
      if (req.url === '/provider/responses') {
        expect(req.headers.authorization).toBe('Bearer synthetic-invalid-api-key');
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
    let delaySecondPreparation = false;
    const preparationEntered = vi.fn();
    let latePreparation: (() => Promise<void>) | undefined;
    const agent = new CodexAgent({
      binaryPath: binaryPath!, logger, runtimeConfig: {},
      resolveCodexLocalAuthPolicy: captureCodexLocalAuthPolicy,
      resolveCapabilityRouting: async () => { if (window === 'capability') await latePreparation?.(); return undefined; },
      prepareCodexResumeSession: async () => { preparationEntered(); if (window === 'resume') await latePreparation?.(); if (!delaySecondPreparation || preparationEntered.mock.calls.length >= 2) await preparationGate; return undefined; },
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
      if (lateWindow) {
        // Start a shared sibling first; the target will initially select that host
        // from an unknown route, then the real Desktop transaction installs API auth.
        setCustomProviders([]);
        const sibling = await agent.startSession({ sessionId: 'sibling', model: 'fixture-model', providerId: 'cprov-fixture', workingDir });
        if (window === 'resume') {
          const done = (async () => { for await (const event of sibling.events()) { if (event.type === 'error') throw new Error(JSON.stringify(event)); if (event.type === 'done') return; } })();
          await sibling.send({ type: 'user', content: 'persist fixture' }, { throwOnStartFailure: true });
          await done;
        }
        const hostMap = (agent as unknown as { hosts: Map<string, AppServerHost> }).hosts;
        const siblingHost = hostMap.get('local')!;
        const siblingConnection = siblingHost.getConnectionId();
        const accepted: Array<{ host: AppServerHost; method: string }> = [];
        const request = AppServerHost.prototype.request;
        spies.push(vi.spyOn(AppServerHost.prototype, 'request').mockImplementation(function (this: AppServerHost, method, params, opts) {
          return request.call(this, method, params, { ...opts, beforeDispatch: () => {
            opts?.beforeDispatch?.();
            if (['thread/start', 'thread/resume'].includes(method)) accepted.push({ host: this, method });
          } });
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
        const target = agent.startSession({ sessionId: 'late-target', providerId: 'cprov-fixture', model: 'fixture-model', workingDir,
          ...(reviewMode ? { reviewMode: true as const } : {}), ...(window === 'resume' ? { resumeSessionId: sibling.id } : {}),
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
          expect(accepted).toHaveLength(1);
          expect(spawnConfigs.at(-1)).toBe('isolated');
          // No forced retirement or cleanup of the live sibling on the shared host.
          expect(hostMap.get('local')).toBe(siblingHost);
          expect(siblingHost.getConnectionId()).toBe(siblingConnection);
          await handle.close();
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
        const acceptedForks: AppServerHost[] = [];
        const forkRequest = AppServerHost.prototype.request;
        spies.push(vi.spyOn(AppServerHost.prototype, 'request').mockImplementation(function (this: AppServerHost, method, params, opts) {
          return forkRequest.call(this, method, params, { ...opts, beforeDispatch: () => {
            opts?.beforeDispatch?.();
            if (method === 'thread/fork') acceptedForks.push(this);
          } });
        }));
        for (const delay of ['none', 'first', 'second']) {
          const acceptedBefore = acceptedForks.length;
          const delayPreparation = delay !== 'none';
          delaySecondPreparation = delay === 'second';
          let releasePreparation: () => void = () => {};
          if (delayPreparation) preparationGate = new Promise<void>((resolve) => { releasePreparation = resolve; });
          preparationEntered.mockClear();
          let finishFork = delayPreparation ? undefined : beginMutation();
          let forkSettled = false;
          const forking = agent.forkSdkSession({ sourceSdkSessionId: handle.id, upToMessageId: undefined, providerId: 'cprov-fixture', model: 'fixture-model', stripEncryptedReasoning: true })
            .then((result) => { forkSettled = true; return result; });
          try {
            await expect.poll(() => preparationEntered.mock.calls.length).toBeGreaterThanOrEqual(delaySecondPreparation ? 2 : 1);
            const pausedForkHost = delaySecondPreparation
              ? [...(agent as unknown as { hosts: Map<string, AppServerHost> }).hosts].find(([key]) => key.startsWith('local-fork:'))?.[1]
              : undefined;
            if (delaySecondPreparation) expect(pausedForkHost).toBeDefined();
            if (delayPreparation) finishFork = beginMutation();
            releasePreparation();
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(forkSettled).toBe(false);
            finishFork?.();
            const fork = await forking;
            expect(fork.newSdkSessionId).not.toBe(handle.id);
            expect(acceptedForks).toHaveLength(acceptedBefore + 1);
            if (delaySecondPreparation) expect(acceptedForks.at(-1)).not.toBe(pausedForkHost);
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
      for (const spy of spies) spy.mockRestore();
      for (const release of releases) release();
      setCustomProviders([]);
      await agent.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});
