import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PiAgent } from '../index.js';
import { PI_CACHE_RECOVERY_EXPECTATION, type AgentDeps, type AgentSessionHandle } from '../../base-agent.js';
import type { AgentEvent } from '../../../types/events.js';
import type { Logger } from '../../../interfaces/logger.js';
import type { PiCacheCompatibility } from '../cache-compatibility.js';
const binary = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../../apps/pi-bin', process.platform + '-' + process.arch, process.platform === 'win32' ? 'pi.exe' : 'pi');
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };

describe.skipIf(!existsSync(binary))('Pi cache learning over real HTTP and native RPC', () => {
  it.each(['normal', 'api.openai.com', 'retry-failure'].flatMap(suffix => [
    { suffix, errorFormat: 'omitted param', rejection: { message: 'Validation: Unsupported parameter(s): prompt_cache_key', type: 'invalid_request_error' } },
    ...['prompt_cache_key', 'prompt_cache_retention'].map(field => ({
      suffix, errorFormat: `null param (${field})`,
      rejection: { error: { code: null, message: `Validation: Unsupported parameter(s): \`${field}\``, param: null, type: 'invalid_request_error' } },
    })),
  ]))('rebuilds with a learned fix and preserves one active input: $suffix / $errorFormat', async ({ suffix, rejection }) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-cache-integration-'));
    const received: Array<Record<string, unknown>> = [];
    let rejectCacheFields = true;
    const gateway = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body);
      received.push(data);
      if (rejectCacheFields && (data.prompt_cache_key !== undefined || data.prompt_cache_retention !== undefined)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify(rejection));
        return;
      }
      if (suffix === 'retry-failure' && received.length === 2) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Non-cache provider validation failure', type: 'invalid_request_error' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ id: 'one', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] }) + '\n\n'
        + 'data: ' + JSON.stringify({ id: 'one', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\n'
        + 'data: [DONE]\n\n');
    });
    let handle: AgentSessionHandle | undefined;
    try {
      await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
      const address = gateway.address();
      if (!address || typeof address === 'string') throw new Error('missing loopback listener');
      let endpoint = 'http://127.0.0.1:' + address.port + '/' + suffix + '/v1';
      let learned: PiCacheCompatibility | undefined;
      const deps: AgentDeps = {
        binaryPath: binary, logger,
        auth: { getState: async () => ({ authenticated: true, identity: 'fixture', authSource: 'api-key' }), triggerLogin: async () => ({ authenticated: true }), logout: async () => {}, getAuthEnv: async () => ({}) },
        runtimeConfig: { endpoint: 'http://127.0.0.1:0' },
        resolvePiAgentHome: () => path.join(root, 'agent'),
        resolvePiNativeProviders: async () => ({ providers: [{ id: 'strict', sourceProviderId: 'strict', name: 'Strict fixture', baseUrl: endpoint, api: 'openai-completions', modelIdAliases: { 'fixture-alias': 'fixture-public' }, models: [{ id: 'fixture-public', wireId: 'fixture', api: 'openai-completions', contextWindow: 32768, maxTokens: 100 }] }], env: {} }),
        resolvePiNativeCompatOverride: (provider, model, route) => learned && provider === learned.providerId && model === learned.wireModelId && route === learned.routeKey ? { supportsLongCacheRetention: false } : undefined,
        preparePiExtraSpawnConfig: async () => ({ mcpEnv: { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: path.join(root, 'xdg') } }),
      };
      const workingDir = path.join(root, 'work'); mkdirSync(workingDir);
      const opts = { workingDir, model: 'fixture-alias', providerId: 'strict', permissionMode: 'bypassPermissions' as const };
      const run = async (options: Parameters<AgentSessionHandle['send']>[1]) => {
        const events: AgentEvent[] = [];
        const finish = (async () => { for await (const event of handle!.events()) { events.push(event); if (event.type === 'done') break; } })();
        await handle!.send({ type: 'user', content: 'Reply OK' }, options);
        await finish;
        return events;
      };
      const agent = new PiAgent(deps);
      handle = await agent.startSession({ ...opts, sessionId: 'first' });
      let userEntry = '';
      const failed = await run({ onTranscriptUserEntry: async (id) => { userEntry = id; } });
      const error = failed.find((event) => event.type === 'error')?.data as { reason: string; piCacheCompatibility: PiCacheCompatibility; piCacheRecoverySafe: boolean };
      expect(error).toMatchObject({ reason: 'unsupported-request-option', piCacheRecoverySafe: true, piCacheCompatibility: { applied: false, providerId: 'strict', modelId: 'fixture-alias', wireModelId: 'fixture' } });
      expect(userEntry).not.toBe('');
      expect(received).toHaveLength(1);
      learned = error.piCacheCompatibility;
      const resumeSessionId = handle.id;
      await handle.close();
      handle = await agent.startSession({ ...opts, sessionId: 'rebuilt', resumeSessionId });
      await expect(handle.send({ type: 'user', content: 'Reply OK' }, { [PI_CACHE_RECOVERY_EXPECTATION]: { ...learned, routeKey: '0'.repeat(64) }, retryTranscriptUserEntryId: userEntry })).rejects.toThrow(/not applied to the expected route/);
      expect(received).toHaveLength(1);
      const originalUserEntry = userEntry;
      const succeeded = await run({
        [PI_CACHE_RECOVERY_EXPECTATION]: learned, retryTranscriptUserEntryId: userEntry,
        // Desktop relinks the existing user row to this replacement entry.
        onTranscriptUserEntry: async id => { userEntry = id; },
      });
      expect(userEntry).not.toBe(originalUserEntry);
      expect(received).toHaveLength(2);
      expect(received[1]).not.toHaveProperty('prompt_cache_key');
      expect(received[1]).not.toHaveProperty('prompt_cache_retention');
      expect((received[1].messages as Array<{ role: string }>).filter((m) => m.role === 'user')).toHaveLength(1);
      if (suffix === 'retry-failure') {
        expect(succeeded.some(event => event.type === 'error')).toBe(true);
        const manual = await run({ retryTranscriptUserEntryId: userEntry });
        expect(manual.some(event => event.type === 'error')).toBe(false);
        expect(received).toHaveLength(3);
        expect((received[2].messages as Array<{ role: string }>).filter(m => m.role === 'user')).toHaveLength(1);
        return;
      }
      expect(succeeded.some((event) => event.type === 'error')).toBe(false);
      expect(succeeded.find((event) => event.type === 'done')?.data).toMatchObject({ result: 'OK' });
      await handle.close();
      handle = await agent.startSession({ ...opts, sessionId: 'new-task' });
      expect((await run({})).some((event) => event.type === 'error')).toBe(false);
      expect(received).toHaveLength(3);
      expect(received[2]).not.toHaveProperty('prompt_cache_key');
      await handle.close();
      // A different endpoint under the same connection retains native caching.
      endpoint += '/different';
      rejectCacheFields = false;
      handle = await agent.startSession({ ...opts, sessionId: 'working-gateway' });
      expect((await run({})).some((event) => event.type === 'error')).toBe(false);
      expect(received).toHaveLength(4);
      expect(received[3]).toHaveProperty('prompt_cache_key');
      expect(received[3]).toHaveProperty('prompt_cache_retention', '24h');
    } finally {
      await handle?.close();
      gateway.closeAllConnections();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
