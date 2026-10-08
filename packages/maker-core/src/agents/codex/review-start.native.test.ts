import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../../interfaces/logger.js';
import { CodexAgent } from './index.js';

// Explicit opt-in; never load the user's Codex home or credentials.
const binaryPath = process.env.CINDY_CODEX_TEST_BINARY;
const legacyBinaryPath = process.env.CINDY_CODEX_LEGACY_TEST_BINARY;
const logger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child: () => logger,
};

describe.skipIf(!binaryPath || process.platform !== 'win32')('Windows Codex Review with real app-server', () => {
  it.each([
    { binary: binaryPath!, configuredMemory: false, compatible: true, providerId: 'cprov-fixture', model: 'fixture-model' },
    { binary: binaryPath!, configuredMemory: true, compatible: true, providerId: 'cprov-fixture', model: 'gpt-5.4' },
    { binary: binaryPath!, configuredMemory: false, compatible: true, providerId: 'xai', model: 'grok-4' },
    { binary: binaryPath!, configuredMemory: false, compatible: true, providerId: undefined, model: 'xai/grok-4' },
    ...(legacyBinaryPath ? [{ binary: legacyBinaryPath, configuredMemory: false, compatible: false, providerId: 'cprov-fixture', model: 'fixture-model' }] : []),
  ])('enforces scoped reads (model: $model, memory: $configuredMemory, compatible: $compatible)', async ({ binary, configuredMemory, compatible, providerId, model }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'cindy-review-start-'));
    const home = path.join(root, 'codex');
    const workingDir = path.join(root, 'work');
    await mkdir(home);
    await mkdir(workingDir);
    await writeFile(path.join(workingDir, 'evidence.md'), 'REVIEW_EVIDENCE');
    await writeFile(path.join(workingDir, 'AGENTS.md'), 'REVIEW_PROJECT_RULE');
    await writeFile(path.join(workingDir, '.env'), 'SYNTHETIC_SECRET');
    await writeFile(path.join(root, 'private.md'), 'SYNTHETIC_PRIVATE');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
    await writeFile(path.join(workingDir, 'evidence.png'), png);
    await writeFile(path.join(root, 'private.png'), png);
    const requests: { tools: { name: string; type: string }[]; input: { type: string; call_id?: string; output?: unknown }[] }[] = [];
    const functionOnly = providerId === 'xai' || model.startsWith('xai/');
    // The scripted local provider exercises tool round trips without a real
    // model, cloud credentials, administrator setup, or the user's Codex home.
    const calls = [
      ['review_read_file', { path: 'evidence.md' }],
      ['review_list_directory', { path: '.' }],
      ['review_read_file', { path: '.env' }],
      ['review_read_file', { path: '../private.md' }],
      ['review_read_file', { path: 'AGENTS.md' }],
      ['review_view_image', { path: 'evidence.png' }],
      // Also send unadvertised native tools: they must not execute.
      ['shell_command', { command: 'echo unsafe > mutated.txt' }],
      ['view_image', { path: path.join(root, 'private.png') }],
      ['apply_patch', { patch: '*** Begin Patch\n*** Add File: mutated.txt\n+unsafe\n*** End Patch' }],
    ] as const;
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      // xAI Responses accepts flat function tools, not Codex namespace tools.
      // Validate the real app-server wire output, not just thread/start input.
      if (functionOnly && requests.at(-1)!.tools.some(tool => tool.type !== 'function')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Only flat function tools are supported' } }));
        return;
      }
      const step = requests.length - 1;
      const call = calls[step];
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      const events = [
        { type: 'response.created', response: { id: 'response-fixture' } },
        { type: 'response.output_item.done', item: call
          ? call[0] === 'apply_patch'
            ? { type: 'custom_tool_call', id: `item-${step}`, call_id: `call-${step}`, name: call[0], input: call[1].patch }
            : { type: 'function_call', id: `item-${step}`, call_id: `call-${step}`, name: call[0], arguments: JSON.stringify(call[1]) }
          : { type: 'message', role: 'assistant', id: 'message-fixture', content: [{ type: 'output_text', text: 'fixture complete' }] } },
        { type: 'response.completed', response: { id: 'response-fixture', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ];
      res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await writeFile(path.join(home, 'config.toml'), [
      `model="${model}"`,
      'model_provider="fixture"',
      'cli_auth_credentials_store="ephemeral"',
      'check_for_update_on_startup=false',
      // Review must override user-enabled execution/visual capabilities.
      '[features]', 'shell_tool=true', 'unified_exec=true', 'view_image=true',
      'code_mode=true', 'code_mode_only=true', 'multi_agent_v2=true',
      '[analytics]', 'enabled=false',
      // A missing transport is the production regression. The configured case
      // also exercises Review's existing transport-aware isolation path.
      ...(configuredMemory ? [
        '[mcp_servers.cindy_memory]', 'command="unused-memory-server"', 'enabled=false',
      ] : []),
      '[model_providers.fixture]', 'name="Fixture"',
      `base_url="${endpoint}"`, 'wire_api="responses"',
      'requires_openai_auth=false', 'request_max_retries=0',
    ].join('\n'));
    const agent = new CodexAgent({
      binaryPath: binary, logger, runtimeConfig: {},
      resolveCodexLocalAuthPolicy: () => 'isolated',
      prepareCodexExtraSpawnConfig: async () => ({
        extraArgs: [], extraEnv: {}, codexProxyActive: true,
      }),
      auth: {
        getState: async () => ({ authenticated: true }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({
          HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
          CODEX_HOME: home, TMPDIR: root,
          OPENAI_API_KEY: '', CODEX_API_KEY: '',
          HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1',
          ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost',
        }),
      },
    });
    try {
      const started = agent.startSession({
        sessionId: `review-${configuredMemory}`, providerId,
        model, workingDir, reviewMode: true,
        makerMemoryEnabled: false,
      });
      if (!compatible) {
        await expect(started).rejects.toThrow('Windows Cindy Review requires Codex app-server 0.156.0');
        expect(requests).toHaveLength(0);
        return;
      }
      const handle = await started;
      expect(handle.id).toBeTruthy();
      expect(handle.codexHostKey).toContain('local-review:');
      expect(handle.getPlanMode?.()).toBe(false);
      const events = (async () => {
        for await (const event of handle.events()) {
          if (event.type === 'error') throw new Error(JSON.stringify(event));
          if (event.type === 'done') return;
        }
      })();
      await handle.send({ type: 'user', content: 'Review the fixture' }, { throwOnStartFailure: true });
      await events;
      expect(requests).toHaveLength(calls.length + 1);
      if (functionOnly) expect(requests.every(request => request.tools.every(tool => tool.type === 'function'))).toBe(true);
      expect(requests[0].tools.map((tool) => tool.name).sort()).toEqual([
        ...(configuredMemory ? ['apply_patch'] : []),
        'request_user_input', 'review_list_directory', 'review_read_file', 'review_view_image',
      ]);
      const output = (step: number) => JSON.stringify(requests[step + 1].input.find((item) => item.type.endsWith('_call_output') && item.call_id === `call-${step}`)?.output);
      expect(output(0)).toContain('REVIEW_EVIDENCE');
      expect(output(1)).toContain('evidence.md');
      expect(output(1)).not.toContain('.env');
      expect(output(2)).toContain('Review refused');
      expect(output(3)).toContain('Review refused');
      expect(output(4)).toContain('REVIEW_PROJECT_RULE');
      expect(output(5)).toContain('data:image/png;base64,');
      expect(output(6)).toMatch(/unknown|unsupported|not found/i);
      expect(output(7)).toMatch(/unknown|unsupported|not found/i);
      expect(output(8)).toMatch(/unknown|unsupported|reject|denied|not permitted/i);
      expect(JSON.stringify(requests)).not.toMatch(/SYNTHETIC_SECRET|SYNTHETIC_PRIVATE/);
      expect(await readFile(path.join(workingDir, 'evidence.md'), 'utf8')).toBe('REVIEW_EVIDENCE');
      await expect(readFile(path.join(workingDir, 'mutated.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      await handle.close();
    } finally {
      await agent.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);
});
