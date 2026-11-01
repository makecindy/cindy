import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetRememberedModelEndpointsForTest, resolveModelRoute } from '../model-route-resolver.js';
import { preflightModelRoute } from '../route-preflight.js';

const servers: http.Server[] = [];
let harnessDir: string;

async function serveModels(ids: string[]): Promise<string> {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A port that was bound and released: connecting to it is refused (LM Studio quit). */
async function deadBaseUrl(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

function writeProviders(baseUrl: string): void {
  fs.writeFileSync(
    path.join(harnessDir, 'providers.yaml'),
    `providers:\n  - id: lmstudio-local\n    kind: lmstudio\n    baseUrl: ${baseUrl}\n`,
  );
}

const GEMMA = 'google/gemma-4-26b-a4b-qat:2';

beforeEach(() => {
  harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-preflight-'));
  resetRememberedModelEndpointsForTest();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  fs.rmSync(harnessDir, { recursive: true, force: true });
});

describe('remembered endpoint for discovered models (ROADMAP 2.4c)', () => {
  it('keeps resolving a discovered model to its endpoint after discovery forgets it', () => {
    writeProviders('http://127.0.0.1:1234');
    const seen = resolveModelRoute(GEMMA, {
      harnessDir,
      endpointModels: new Map([['lmstudio-local', [GEMMA]]]),
    });
    expect(seen?.providerId).toBe('lmstudio-local');
    // LM Studio went offline: discovery now lists nothing. The model must not fall through
    // to the Hermes home provider (null route) and be sent to a different, paid endpoint.
    const later = resolveModelRoute(GEMMA, { harnessDir, endpointModels: new Map() });
    expect(later).toEqual({
      model: GEMMA,
      provider: 'custom',
      baseUrl: 'http://127.0.0.1:1234/v1',
      providerId: 'lmstudio-local',
    });
    // A model never seen on an endpoint still resolves to the home route.
    expect(resolveModelRoute('deepseek-flash', { harnessDir, endpointModels: new Map() })).toBeNull();
  });
});

describe('preflightModelRoute (ROADMAP 2.4c)', () => {
  it('passes when the endpoint answers and has the model loaded', async () => {
    writeProviders(await serveModels([GEMMA, 'qwen3-8b']));
    await expect(preflightModelRoute(GEMMA, { harnessDir, endpointModels: new Map([['lmstudio-local', [GEMMA]]]) }))
      .resolves.toEqual({ ok: true });
  });

  it('names the model and the loaded list when the model is not loaded', async () => {
    writeProviders(await serveModels([]));
    resolveModelRoute(GEMMA, { harnessDir, endpointModels: new Map([['lmstudio-local', [GEMMA]]]) });
    const result = await preflightModelRoute(GEMMA, { harnessDir, endpointModels: new Map() });
    expect(result).toMatchObject({ ok: false, reason: 'model-not-loaded', providerId: 'lmstudio-local' });
    expect(result.ok === false && result.message).toContain(`"${GEMMA}" is not loaded in lmstudio-local`);
    expect(result.ok === false && result.message).toContain('No models are loaded.');
  });

  it('reports the endpoint as offline within the timeout when nothing listens', async () => {
    writeProviders(await deadBaseUrl());
    resolveModelRoute(GEMMA, { harnessDir, endpointModels: new Map([['lmstudio-local', [GEMMA]]]) });
    const started = Date.now();
    const result = await preflightModelRoute(GEMMA, { harnessDir, endpointModels: new Map() });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result).toMatchObject({ ok: false, reason: 'offline', providerId: 'lmstudio-local' });
    expect(result.ok === false && result.message).toContain('is not reachable');
  });

  it('does nothing for the Hermes home route', async () => {
    writeProviders(await deadBaseUrl());
    await expect(preflightModelRoute('hermes-default', { harnessDir })).resolves.toEqual({ ok: true });
    await expect(preflightModelRoute('deepseek-flash', { harnessDir, endpointModels: new Map() }))
      .resolves.toEqual({ ok: true });
  });
});
