/** Real Claude CLI -> production routing -> local Art fixture; no account access. */
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicCompatProxy } from '@cindy/anthropic-compat-proxy';
import { buildUserProvider } from '@cindy/model-providers';
import { ClaudeCodeAgent } from '../../../../../../packages/maker-core/src/agents/claude-code/index.js';
import { Session } from '../../../../../../packages/maker-core/src/session.js';
import type { Logger } from '../../../../../../packages/maker-core/src/interfaces/logger.js';
import type { AgentEvent } from '../../../../../../packages/maker-core/src/types/events.js';

const bridge = vi.hoisted(() => ({ get: vi.fn(() => ({ handle: vi.fn() })) }));
vi.mock('../anthropic-responses-bridge-host.js', () => ({
  getResponsesBridgeHandler: bridge.get, getPiNativeSubscriptionHandler: vi.fn(),
}));
vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseCindyGateway: true }) }));
vi.mock('../logger-adapter', () => ({
  createMakerLogger: () => ({ trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this; } }),
  desktopMakerLogger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
}));
vi.mock('../runtime-configs', () => ({ claudeUpstreamEndpoint: () => 'http://127.0.0.1:1' }));
vi.mock('../silent-encrypted-retry-store', () => ({ readSilentEncryptedRetrySettings: () => ({ enabled: false }) }));
vi.mock('../claude-fast-mode-log', () => ({
  createClaudeFastModeRequestTransform: () => () => null,
  createClaudeFastModeResponseObserver: () => () => undefined,
}));

import { setCustomProviders } from '../active-catalog';
import { setCustomProviderKeyReader } from '../provider-route';
import { setSessionProvider, clearSessionProvider } from '../session-provider-store';
import { createModelRoutingTransform, setClaudeProxySessionIdResolver } from '../anthropic-compat-proxy-host';

const binary = process.env.CINDY_TEST_CLAUDE_BINARY;
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };

afterEach(() => {
  setCustomProviders([]);
  setCustomProviderKeyReader(() => null);
  setClaudeProxySessionIdResolver(() => null);
  bridge.get.mockClear();
});

describe.skipIf(!binary)('native Claude custom Grok session affinity', () => {
  it('routes concurrent first requests to their selected Art provider before SDK init', async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-cc-affinity-'));
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(scratch);
    const received: Array<{ model: string; sid: string; key: string | undefined }> = [];
    const routed: Array<{ sid: string; sessionId: string | null }> = [];
    const sessions: Session[] = [];
    const agents: ClaudeCodeAgent[] = [];
    const events: AgentEvent[][] = [[], []];
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      if (!req.url?.startsWith('/v1/messages')) { res.writeHead(200).end('{}'); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (req.url.includes('count_tokens')) { res.writeHead(200).end('{"input_tokens":1}'); return; }
      received.push({ model: body.model, sid: String(req.headers['x-claude-code-session-id']), key: req.headers['x-api-key'] as string });
      const payloads = [
        { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'art fixture success' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(payloads.map(data => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const transform = createModelRoutingTransform();
    const proxy = await createAnthropicCompatProxy({
      upstream: 'http://127.0.0.1:1',
      routingTransform: (body, ctx) => {
        if (ctx.url.startsWith('/v1/messages') && !ctx.url.includes('count_tokens')) {
          const sid = ctx.headers['x-claude-code-session-id'] ?? '';
          routed.push({ sid, sessionId: sessions.find(s => s.requestSessionId === sid)?.id ?? null });
        }
        return transform(body, ctx);
      },
    });
    try {
      setCustomProviders([buildUserProvider({ id: 'art-cindy', name: 'Fixture Art', runtimes: {
        'claude-code': { baseUrl: upstreamUrl, wireProtocol: 'anthropic-messages', models: [{ id: 'grok-4.6', name: 'Grok' }] },
      } })]);
      setCustomProviderKeyReader(() => 'fixture-art-key');
      setClaudeProxySessionIdResolver(sid => sessions.find(s => s.requestSessionId === sid)?.id ?? null);
      for (let i = 0; i < 2; i++) {
        const workingDir = path.join(scratch, `work-${i}`);
        const configDir = path.join(scratch, `config-${i}`);
        await fs.mkdir(workingDir);
        await fs.mkdir(configDir);
        const agent = new ClaudeCodeAgent({
          binaryPath: binary!, logger,
          runtimeConfig: { endpoint: proxy.url, behaviorFlags: {
            CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', DISABLE_NONESSENTIAL_TRAFFIC: '1',
            DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
          } },
          auth: {
            getState: async () => ({ authenticated: true, authSource: 'api-key' as const }),
            triggerLogin: async () => ({ authenticated: true }), logout: async () => {},
            getAuthEnv: async () => ({ ANTHROPIC_API_KEY: 'xdt-provider-auth-placeholder-key', CLAUDE_CONFIG_DIR: configDir, HOME: scratch }),
          },
        });
        const id = `fixture-business-${i}`;
        agents.push(agent);
        setSessionProvider(id, 'art-cindy');
        const handle = await agent.startSession({ sessionId: id, providerId: 'art-cindy', model: 'grok-4.6', workingDir, permissionMode: 'bypassPermissions' });
        expect(handle.id).not.toBe('<pending>');
        const session = new Session({ id, agentKind: 'claude-code', workDir: workingDir, handle, capabilities: agent.capabilities, logger, turnStallMs: 0 });
        sessions.push(session);
        session.onEvent(event => events[i].push(event));
      }
      expect(sessions[0].sdkSessionId).not.toBe(sessions[1].sdkSessionId);
      await Promise.all(sessions.map(s => s.send({ type: 'user', content: 'Reply with one short line. Do not use tools.' })));
      await vi.waitFor(() => expect(events.map(e => e.some(v => v.type === 'done'))).toEqual([true, true]), { timeout: 45_000 });
      expect(events.flat().filter(e => e.type === 'error')).toEqual([]);
      // CLI may also request titles/summaries on the same route.
      expect(received.length).toBeGreaterThanOrEqual(2);
      expect(received.every(r => r.model === 'grok-4.6' && r.key === 'fixture-art-key')).toBe(true);
      expect([...new Set(received.map(r => r.sid))].sort()).toEqual(sessions.map(s => s.sdkSessionId).sort());
      expect(routed.every(r => r.sessionId !== null)).toBe(true);
      expect([...new Set(routed.map(r => r.sessionId))].sort()).toEqual(['fixture-business-0', 'fixture-business-1']);
      expect(bridge.get).not.toHaveBeenCalled();

      const sourceId = sessions[0].sdkSessionId;
      const forkHandle = await agents[0].startSession({
        sessionId: 'fixture-business-fork', providerId: 'art-cindy', model: 'grok-4.6',
        workingDir: path.join(scratch, 'work-0'), permissionMode: 'bypassPermissions',
        resumeSessionId: sourceId, vendorOptions: { forkSession: true },
      });
      const fork = new Session({ id: 'fixture-business-fork', agentKind: 'claude-code',
        workDir: path.join(scratch, 'work-0'), handle: forkHandle,
        capabilities: agents[0].capabilities, logger, turnStallMs: 0 });
      sessions.push(fork);
      const forkEvents: AgentEvent[] = [];
      fork.onEvent(event => forkEvents.push(event));
      setSessionProvider(fork.id, 'art-cindy');
      expect(fork.sdkSessionId).toBe(sourceId);
      expect(fork.requestSessionId).not.toBe(sourceId);
      const requestId = fork.requestSessionId;
      // Route a pre-acceptance bridge request without making that id durable.
      const preAcceptance = await fetch(`${proxy.url}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json',
          'x-api-key': 'xdt-provider-auth-placeholder-key', 'x-claude-code-session-id': requestId },
        body: JSON.stringify({ model: 'grok-4.6', max_tokens: 1, stream: true,
          messages: [{ role: 'user', content: 'pre-acceptance routing fixture' }] }),
      });
      await preAcceptance.text();
      expect(preAcceptance.status).toBe(200);
      expect(fork.sdkSessionId).toBe(sourceId);
      expect(forkEvents.filter(e => e.type === 'session_id')).toEqual([]);
      expect(routed.at(-1)?.sessionId).toBe(fork.id);
      await fork.send({ type: 'user', content: 'Continue with one short line. Do not use tools.' });
      await vi.waitFor(() => expect(forkEvents.some(e => e.type === 'done')).toBe(true), { timeout: 45_000 });
      expect(forkEvents.filter(e => e.type === 'error')).toEqual([]);
      expect(fork.sdkSessionId).toBe(requestId);
      expect(forkEvents.filter(e => e.type === 'session_id')).toHaveLength(1);
      expect(received.filter(r => r.sid === requestId).every(r => r.model === 'grok-4.6' && r.key === 'fixture-art-key')).toBe(true);
      expect(bridge.get).not.toHaveBeenCalled();
    } finally {
      await Promise.all(sessions.map(s => s.close()));
      for (const session of sessions) clearSessionProvider(session.id);
      await proxy.dispose();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      homeSpy.mockRestore();
      await fs.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 60_000);
});
