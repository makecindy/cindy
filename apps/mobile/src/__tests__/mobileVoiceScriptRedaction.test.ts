import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const startedServers: Server[] = [];

afterEach(async () => {
  await Promise.all(startedServers.splice(0).map((server) => closeServer(server)));
});

describe('mobile voice script redaction', () => {
  // credentials-and-local-storage.md: checking configuration must not send
  // credentials or audio to a cloud endpoint until the explicit --run action.
  // The failure-redaction test below runs with --run and cannot protect this gate.
  it('keeps cloud preflight dry-run offline and hides its configured key', async () => {
    const source = readFileSync(resolve(process.cwd(), 'scripts/mobile-voice-cloud-preflight.mjs'), 'utf8');
    const start = source.indexOf('const DEFAULT_ASR_ENDPOINT =');
    if (start < 0) throw new Error('Cloud preflight workflow entry was not found');
    const secret = 'sk-preflight/dry run secret';
    const fetch = vi.fn(() => { throw new Error('Unexpected cloud HTTP request'); });
    const WebSocket = vi.fn(function () { throw new Error('Unexpected cloud WebSocket request'); });
    const log = vi.fn();
    const execution = runInNewContext('(async () => { ' + source.slice(start) + ' })()', {
      mobileRoot: '/fixture/mobile', resolve, URL, fetch, WebSocket,
      existsSync: () => false,
      readFileSync: () => { throw new Error('Unexpected credential or environment file read'); },
      console: { log, warn: log, error: log },
      process: {
        argv: ['node', 'mobile-voice-cloud-preflight.mjs'],
        env: { XDT_MOBILE_VOICE_PROXY_BASE_URL: 'https://voice.invalid', XDT_MOBILE_VOICE_PROXY_API_KEY: secret },
        exit: (code: number) => { throw new Error('preflight-exit:' + code); },
      },
    });
    await expect(execution).rejects.toThrow('preflight-exit:0');
    expect(fetch).not.toHaveBeenCalled();
    expect(WebSocket).not.toHaveBeenCalled();
    const output = log.mock.calls.map(call => call.join(' ')).join(String.fromCharCode(10));
    expect(output).toContain('dry run passed; add --run to call the cloud endpoints');
    expect(output).not.toContain(secret);
    expect(output).not.toContain(encodeURIComponent(secret));
  });

  it('redacts synced voice keys from cloud preflight failure output', async () => {
    const secret = 'sk-script/redact secret';
    const server = createServer((_request, response) => {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        error: {
          message: `upstream rejected Authorization Bearer ${secret}`,
        },
      }));
    });
    startedServers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not expose a TCP port');

    const result = await runNodeScript('scripts/mobile-voice-cloud-preflight.mjs', ['--run', '--refine-only'], {
      XDT_MOBILE_VOICE_CREDENTIAL_JSON: JSON.stringify({
        temporary: true,
        credentialVersion: 1,
        issuedAt: '2026-06-20T00:00:00.000Z',
        proxyBaseUrl: `http://127.0.0.1:${address.port}`,
        proxyApiKey: secret,
        asr: {
          provider: 'litellm-gpt-realtime-whisper',
          model: 'gpt-realtime-whisper',
          auth: 'api-key',
          mode: 'realtime-websocket',
          endpointPath: '/openai/passthrough/v1/realtime?intent=transcription',
          protocolProfile: 'openai-transcription-manual',
        },
        refiner: {
          provider: 'litellm-gpt-5.4-mini',
          model: 'gpt-5.4-mini',
          auth: 'api-key',
          transport: 'litellm-chat-completions',
          endpointPath: '/v1/chat/completions',
        },
        settings: {
          language: 'zh-CN',
          refinementEnabled: true,
          playInteractionSound: false,
        },
      }),
    });

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.code).not.toBe(0);
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain(secret);
    expect(output).not.toContain(encodeURIComponent(secret));
  });
});

function runNodeScript(
  script: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
