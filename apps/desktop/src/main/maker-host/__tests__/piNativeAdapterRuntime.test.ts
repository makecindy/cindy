import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { it, expect } from 'vitest';
import { PI_NATIVE_PROVIDER_ADAPTER_SOURCE } from '../../../../../../packages/maker-core/src/agents/pi/native-provider-adapter-source.js';

const binary = resolve('../../apps/pi-bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'pi.exe' : 'pi');
it.skipIf(!existsSync(binary)).each(['github-copilot', 'cloudflare-ai-gateway'])('uses %s native auth with an independent connection ID in the actual Pi runtime', async adapterProvider => {
  const directory = await mkdtemp(join(tmpdir(), 'cindy-pi-provider-test-'));
  const requests: Array<{ authorization?: string; gatewayKey?: string; apiKey?: string; model?: string; maxTokens?: number }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ authorization: req.headers.authorization, gatewayKey: req.headers['cf-aig-authorization'] as string, apiKey: req.headers['x-api-key'] as string,
        model: body.model, maxTokens: body.max_tokens });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        { type: 'message_start', message: { id: 'fixture-message', type: 'message', role: 'assistant', model: 'claude-fixture', content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture-ok' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    await writeFile(join(directory, 'adapter.ts'), PI_NATIVE_PROVIDER_ADAPTER_SOURCE + '\nexport default async function(pi: any) { await registerCindyNativeProviderAdapters(pi); }');
    await writeFile(join(directory, 'auth.json'), '{}');
    await writeFile(join(directory, 'models.json'), JSON.stringify({ providers: { 'fixture-connection': {
      baseUrl, api: 'anthropic-messages', apiKey: '$CINDY_FIXTURE_API_KEY', models: [{ id: 'claude-fixture', name: 'Fixture',
        api: 'anthropic-messages', input: ['text'], contextWindow: 200000, maxTokens: 4096, reasoning: false }],
    } } }));
    child = spawn(binary, ['--print', '--no-session', '--no-extensions', '--extension', join(directory, 'adapter.ts'),
      '--provider', 'fixture-connection', '--model', 'claude-fixture', 'Reply briefly.'], {
      cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: directory, CINDY_FIXTURE_API_KEY: 'fixture-key',
        CINDY_PI_NATIVE_PROVIDER_ADAPTERS: JSON.stringify([{ id: 'fixture-connection', provider: adapterProvider, keyEnv: 'CINDY_FIXTURE_API_KEY' }]),
      }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; let errors = '';
    child.stdout!.on('data', chunk => { output += chunk; });
    child.stderr!.on('data', chunk => { errors += chunk; });
    const timer = setTimeout(() => child?.kill(), 15_000);
    const [exit] = await once(child, 'exit'); clearTimeout(timer);
    expect(exit, errors).toBe(0);
    expect(output).toContain('fixture-ok');
    expect(requests).toEqual([{ authorization: adapterProvider === 'github-copilot' ? 'Bearer fixture-key' : undefined,
      gatewayKey: adapterProvider === 'cloudflare-ai-gateway' ? 'Bearer fixture-key' : undefined, apiKey: undefined, model: 'claude-fixture', maxTokens: 4096 }]);
  } finally { child?.kill(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
}, 20_000);
