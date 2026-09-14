import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { buildClaudeEnv, applyClaudeContextWindow } from '../env-builder.js';
import { createAsyncQueue } from '../../shared/async-queue.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const binary = path.join(root, 'apps/claude-code-bin', `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'claude.exe' : 'claude');

describe.skipIf(!existsSync(binary))('Claude native context policy (isolated home, fake upstream)', () => {
  it.each([{ window: 1_000, compact: true, resume: false }, { window: 128_000, compact: false, resume: false },
    { window: 1_000, compact: true, resume: true }])(
    'uses the configured $window budget for native compaction (resume: $resume)', { timeout: 60_000 }, async ({ window, compact, resume }) => {
    const home = mkdtempSync(path.join(tmpdir(), 'claude-native-compact-'));
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        if (req.url?.includes('count_tokens')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ input_tokens: 100 }));
          return;
        }
        bodies.push(body);
        const mainRequest = body.includes('messages') && !body.includes('Write the title');
        const events = [
          { type: 'message_start', message: { id: `msg_${bodies.length}`, type: 'message', role: 'assistant',
            model: 'claude-opus-4-6', content: [], stop_reason: null,
            usage: { input_tokens: mainRequest ? 10_000 : 100, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'CONTEXT_HISTORY_CANARY preserved.' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } },
          { type: 'message_stop' },
        ];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const env = await buildClaudeEnv({
      getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }),
      logout: async () => {}, getAuthEnv: async () => ({ ANTHROPIC_API_KEY: 'fake-test-key' }),
    }, { endpoint: `http://127.0.0.1:${port}`, autoCompactThresholdPct: 90 }, {
      activeModel: 'claude-opus-4-6[1m]',
      modelContextWindows: [{ id: 'claude-opus-4-6[1m]', contextWindow: resume ? 128_000 : window }],
    });
    let input = createAsyncQueue<SDKUserMessage>();
    const options = {
      pathToClaudeCodeExecutable: binary, cwd: home, model: 'claude-opus-4-6[1m]',
      tools: [], mcpServers: {}, settingSources: [], systemPrompt: 'Context control test.',
      maxTurns: 3, env: { ...env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: home,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'fake-test-key', CLAUDE_CODE_OAUTH_TOKEN: undefined },
    };
    let q = query({ prompt: input, options });
    try {
      let results = 0;
      let compacted = false;
      let nativeSessionId: string | undefined;
      let requestsBeforeResume = 0;
      input.push({ type: 'user', message: { role: 'user', content: 'Remember USER_HISTORY_CANARY.' }, parent_tool_use_id: null, session_id: '' });
      while (results < 3) {
        const previousResults = results;
        for await (const event of q) {
          if (event.type === 'system' && event.subtype === 'init') {
            if (nativeSessionId) expect(event.session_id).toBe(nativeSessionId);
            nativeSessionId = event.session_id;
          }
          if (event.type === 'system' && event.subtype === 'compact_boundary') compacted = true;
          if (event.type !== 'result') continue;
          expect(event.subtype).toBe('success');
          if (++results === 3) break;
          if (resume && results === 2) {
            expect(compacted).toBe(false);
            q.close(); input.end();
            requestsBeforeResume = bodies.length;
            const resumedEnv: Record<string, string> = { ...env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: home };
            applyClaudeContextWindow(resumedEnv, window, 90);
            input = createAsyncQueue<SDKUserMessage>();
            q = query({ prompt: input, options: { ...options, env: { ...options.env, ...resumedEnv }, resume: nativeSessionId } });
            input.push({ type: 'user', message: { role: 'user', content: 'Continue after the budget change.' }, parent_tool_use_id: null, session_id: '' });
            break;
          }
          input.push({ type: 'user', message: { role: 'user', content: 'Continue with the remembered marker.' }, parent_tool_use_id: null, session_id: '' });
        }
        expect(results).toBeGreaterThan(previousResults);
      }
      if (resume) expect(bodies.slice(requestsBeforeResume).some((body) => body.includes('USER_HISTORY_CANARY'))).toBe(true);
      expect(results).toBe(3);
      expect(compacted).toBe(compact);
      expect(bodies.length).toBeGreaterThanOrEqual(3);
      expect(bodies.at(-1)).toContain('CONTEXT_HISTORY_CANARY');
    } finally {
      q.close(); input.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reads the native working window and its documented minimum for known models', { timeout: 60_000 }, async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'claude-context-policy-'));
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 100 }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    try {
      for (const window of [1_000, 80_000, 500_000, 140_000, 1_000_000]) {
        const model = 'claude-opus-4-6[1m]';
        const env = await buildClaudeEnv({
          getState: async () => ({ authenticated: true }),
          triggerLogin: async () => ({ authenticated: true }), logout: async () => {},
          getAuthEnv: async () => ({ ANTHROPIC_API_KEY: 'fake-context-test-key' }),
        }, { endpoint: `http://127.0.0.1:${address.port}`, autoCompactThresholdPct: 90 }, {
          activeModel: model, modelContextWindows: [{ id: model, contextWindow: window }],
        });
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        async function* prompt(): AsyncGenerator<SDKUserMessage> { await pending; }
        const q = query({ prompt: prompt(), options: {
          pathToClaudeCodeExecutable: binary, cwd: home, model,
          tools: [], mcpServers: {}, settingSources: [], systemPrompt: 'Context control test.',
          env: { ...env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: home,
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
            ANTHROPIC_API_KEY: 'fake-context-test-key', CLAUDE_CODE_OAUTH_TOKEN: undefined },
        } });
        try {
          const usage = await q.getContextUsage();
          // /context's rawMaxTokens is the working window, not model capacity.
          // This CLI does not include PCT_OVERRIDE in its displayed threshold;
          // small-budget enforcement is covered separately by the native turn test.
          expect(usage.rawMaxTokens).toBe(Math.max(100_000, window));
          expect(usage.maxTokens).toBe(Math.max(100_000, window));
          expect(usage.isAutoCompactEnabled).toBe(true);
        } finally { q.close(); release(); }
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  });
});
