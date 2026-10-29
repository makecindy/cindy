/**
 * #7677: real Codex + an isolated execution environment + a local Images API.
 * The old guest feature filter hides image_gen even when the provider supports it.
 * This integration fixture also proves that reference reads use the execution
 * environment and cannot fall back to a provider-local file after a read denial.
 * No real account, model service, or paid image request is used.
 * Run explicitly with CINDY_CODEX_TEST_BINARY pointing to the pinned runtime.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { WebSocket, WebSocketServer } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CodexAgent, type AgentEvent, type Logger } from '@cindy/maker-core';
import { createCodexImageModelRewrite } from '../codex-image-model-rewrite.js';

const binary = process.env.CINDY_CODEX_TEST_BINARY;
const logger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child: () => logger,
};

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

type ImageArgs = { prompt: string; referenced_image_paths?: string[]; num_last_images_to_include?: number };

describe.skipIf(!binary)('shared image generation through the native execution environment', () => {
  let root = '';
  let taskDir = '';
  let shadowDir = '';
  let taskImage = '';
  let providerImage = '';
  let png: Buffer;
  let agent: CodexAgent | undefined;
  let execServer: ChildProcess | undefined;
  let api: Server | undefined;
  let proxy: WebSocketServer | undefined;
  let endpoint = '';
  let environmentUrl = '';
  let actions: ImageArgs[] = [];
  let actionIndex = 0;
  let imageModelAllowed = true;
  let revokeBeforeImageCall = false;
  let seedLegacyDisabledThread = false;
  let dropReferenceConnection = false;
  let lastThreadId = '';
  const modelRequests: Array<Record<string, unknown>> = [];
  const imageRequests: Array<{ path: string; model: unknown; references: number }> = [];
  const readRequests: string[] = [];
  const deniedReads = new Set<string>();
  const upstreams = new Set<WebSocket>();

  beforeAll(async () => {
    root = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), 'cindy-shared-image-')));
    taskDir = path.join(root, 'task-computer', 'project');
    shadowDir = path.join(root, 'provider-computer', 'workspaces', 'task', 'fs', 'workspace');
    taskImage = path.join(taskDir, 'reference.png');
    providerImage = path.join(root, 'provider-computer', 'private.png');
    const taskHome = path.join(root, 'task-codex');
    const providerHome = path.join(root, 'provider-codex');
    for (const dir of [taskDir, shadowDir, taskHome, providerHome]) await mkdir(dir, { recursive: true });
    png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#1256ab' } }).png().toBuffer();
    await writeFile(taskImage, png);
    await writeFile(providerImage, await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fa2110' } }).png().toBuffer());
    deniedReads.add(providerImage);

    api = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        void (async () => {
          const body = Buffer.concat(chunks);
          if (req.url?.includes('/images/')) {
            const contentType = String(req.headers['content-type'] ?? '');
            // The real outbound proxy transform checks the image model's live
            // grant, separately from the allowed Responses model (#7677).
            const rewrite = createCodexImageModelRewrite(undefined, model => imageModelAllowed && model === 'gpt-image-2');
            try {
              await rewrite(body, { reqId: 1, method: 'POST', url: req.url, headers: { 'content-type': contentType } });
            } catch {
              res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Image model is not available for this remote task' } }));
              return;
            }
            let model: unknown;
            let references = 0;
            if (contentType.startsWith('multipart/form-data')) {
              const form = await new Response(new Uint8Array(body), { headers: { 'content-type': contentType } }).formData();
              model = form.get('model');
              references = [...form.values()].filter(value => typeof value !== 'string').length;
            } else {
              const parsed = JSON.parse(body.toString('utf8'));
              model = parsed.model;
              references = parsed.images?.length ?? 0;
            }
            imageRequests.push({ path: req.url, model, references });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ created: 1, data: [{ b64_json: png.toString('base64') }], background: 'opaque' }));
            return;
          }
          if (!req.url?.includes('/responses')) { res.writeHead(404).end('{}'); return; }
          modelRequests.push(JSON.parse(body.toString('utf8')));
          const action = actions[actionIndex++];
          if (action && revokeBeforeImageCall) imageModelAllowed = false;
          const item = action
            ? { type: 'function_call', id: `fc-${actionIndex}`, call_id: `image-${actionIndex}`, namespace: 'image_gen', name: 'imagegen', arguments: JSON.stringify(action), status: 'completed' }
            : { type: 'message', id: 'answer', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'DONE', annotations: [] }] };
          const events = [
            { type: 'response.created', response: { id: `r-${actionIndex}`, status: 'in_progress', output: [] } },
            { type: 'response.output_item.done', output_index: 0, item },
            { type: 'response.completed', response: { id: `r-${actionIndex}`, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
          ];
          res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
          res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
        })().catch(() => res.writeHead(500).end('{}'));
      });
    });
    api.listen(0, '127.0.0.1');
    await once(api, 'listening');
    endpoint = `http://127.0.0.1:${(api.address() as net.AddressInfo).port}/v1`;

    const execPort = await unusedPort();
    execServer = spawn(binary!, ['exec-server', '--listen', `ws://127.0.0.1:${execPort}`], {
      env: { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: taskHome }, stdio: 'ignore',
    });
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const probe = () => {
        const socket = net.connect(execPort, '127.0.0.1');
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('error', () => {
          socket.destroy();
          if (execServer?.exitCode !== null || Date.now() > deadline) reject(new Error('test execution environment did not start'));
          else setTimeout(probe, 25);
        });
      };
      probe();
    });
    proxy = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(proxy, 'listening');
    environmentUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
    proxy.on('connection', client => {
      const upstream = new WebSocket(`ws://127.0.0.1:${execPort}`);
      upstreams.add(upstream);
      const queued: Buffer[] = [];
      upstream.on('open', () => { for (const data of queued.splice(0)) upstream.send(data, { binary: false }); });
      client.on('message', raw => {
        const data = Buffer.from(raw as Buffer);
        const request = JSON.parse(data.toString('utf8'));
        if (['fs/readFile', 'fs/open'].includes(request.method) && typeof request.params?.path === 'string') {
          const target = request.params.path.startsWith('file:') ? fileURLToPath(request.params.path) : request.params.path;
          readRequests.push(target);
          if (deniedReads.has(target)) {
            if (dropReferenceConnection) {
              client.terminate();
              upstream.terminate();
              return;
            }
            client.send(JSON.stringify({ id: request.id, error: { code: -32003, message: 'Reference file is not available in the task execution environment' } }));
            return;
          }
        }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: false });
        else queued.push(data);
      });
      upstream.on('message', data => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary: false }); });
      upstream.on('error', () => client.close());
      upstream.on('close', () => { upstreams.delete(upstream); client.close(); });
      client.on('close', () => upstream.close());
    });

    agent = new CodexAgent({
      binaryPath: binary!, logger, runtimeConfig: {},
      prepareCodexExtraSpawnConfig: async () => ({
        extraArgs: [
          '-c', 'model_provider="fixture"',
          // Match Cindy's native image-capable custom-provider declaration; the
          // actor header is a fixture marker accepted only by the loopback API.
          '-c', `model_providers.fixture={name="Fixture",base_url="${endpoint}",wire_api="responses",requires_openai_auth=false,request_max_retries=0,supports_websockets=false,http_headers={x-openai-actor-authorization="fixture"}}`,
          '-c', 'features.image_generation=true',
          '-c', 'features.enable_request_compression=false',
          '-c', 'check_for_update_on_startup=false',
          '-c', 'analytics.enabled=false',
        ],
        extraEnv: {}, codexProxyActive: true,
      }),
      auth: {
        getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }), logout: async () => {},
        getAuthEnv: async () => ({ HOME: root, USERPROFILE: root, CODEX_HOME: providerHome, OPENAI_API_KEY: '', CODEX_API_KEY: '', NO_PROXY: '127.0.0.1,localhost' }),
      },
    });
    // Seed a real thread with the previous Cindy release's per-thread override.
    // Resuming it still goes through the current production startSession path.
    type TestHost = { request(method: string, params: unknown, ...options: unknown[]): Promise<unknown> };
    const access = agent as unknown as { getHost(...args: unknown[]): Promise<TestHost> };
    const getHost = access.getHost.bind(agent);
    const instrumented = new WeakSet<TestHost>();
    access.getHost = async (...args) => {
      const host = await getHost(...args);
      if (!instrumented.has(host)) {
        instrumented.add(host);
        const request = host.request.bind(host);
        host.request = (method, params, ...options) => {
          if (seedLegacyDisabledThread && method === 'thread/start') {
            const input = params as Record<string, unknown> & { config?: Record<string, unknown> };
            params = { ...input, config: { ...input.config, 'features.image_generation': false } };
          }
          return request(method, params, ...options);
        };
      }
      return host;
    };
  }, 30_000);

  afterAll(async () => {
    await agent?.dispose();
    for (const client of proxy?.clients ?? []) client.terminate();
    for (const upstream of upstreams) upstream.terminate();
    if (proxy) await new Promise<void>(resolve => proxy!.close(() => resolve()));
    if (execServer && execServer.exitCode === null && execServer.signalCode === null) {
      const exited = once(execServer, 'exit');
      execServer.kill();
      await exited;
    }
    api?.closeAllConnections();
    if (api) await new Promise<void>(resolve => api!.close(() => resolve()));
    if (root && path.dirname(root) === realpathSync.native(os.tmpdir()) && path.basename(root).startsWith('cindy-shared-image-')) {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 30_000);

  async function run(next: ImageArgs[], revokeImageGrant = false, resumeSessionId?: string): Promise<AgentEvent[]> {
    actions = next;
    actionIndex = 0;
    imageModelAllowed = true;
    revokeBeforeImageCall = revokeImageGrant;
    modelRequests.length = 0;
    imageRequests.length = 0;
    readRequests.length = 0;
    const handle = await agent!.startSession({
      sessionId: 'shared-image-fixture', model: 'gpt-5.5', providerId: 'xd', workingDir: shadowDir,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      permissionMode: 'bypassPermissions', makerMemoryEnabled: false,
      deviceHosted: {
        workingDir: taskDir, extraDirs: [], writableDirs: [], platform: process.platform,
        shell: process.platform === 'win32' ? 'powershell' : 'sh', isGitRepo: false,
        tunnelUrl: environmentUrl, tunnelToken: 'fixture', mcpServers: [],
        mirrorRoot: path.dirname(shadowDir), guest: true, guestHome: path.join(root, 'guest-home'),
        guestProvider: { providerId: 'xd', modelIds: ['gpt-5.5', 'gpt-image-2'], routeToken: 'fixture' },
      },
    });
    try {
      const events: AgentEvent[] = [];
      const done = (async () => {
        for await (const event of handle.events()) {
          events.push(event);
          if (event.type === 'error' && (event.data as { isTerminal?: boolean }).isTerminal !== false) throw new Error(JSON.stringify(event.data));
          if (event.type === 'done') return;
        }
      })();
      await handle.send({ type: 'user', content: 'Run the scripted image operation.' }, { throwOnStartFailure: true });
      await done;
      expect(JSON.stringify(modelRequests[0]?.tools).includes('image_gen')).toBe(!seedLegacyDisabledThread);
      // Runtime system skills still reside on the provider computer; no model should try to open them.
      expect(/guest-home[\\/]+codex[\\/]+skills[\\/]+\.system/.test(JSON.stringify(modelRequests))).toBe(false);
      lastThreadId = handle.id;
      return events;
    } finally { await handle.close(); }
  }

  it('generates an image and preserves its bytes for the existing remote delivery pipeline', async () => {
    const events = await run([{ prompt: 'fixture generation' }]);
    expect(imageRequests).toEqual([{ path: '/v1/images/generations', model: 'gpt-image-2', references: 0 }]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'image', data: expect.objectContaining({ status: 'completed', data: png.toString('base64') }) }));
  }, 60_000);

  it('reads explicit edit references through the task execution environment', async () => {
    await run([{ prompt: 'fixture edit', referenced_image_paths: [taskImage] }]);
    expect(readRequests).toContain(taskImage);
    expect(imageRequests).toEqual([{ path: '/v1/images/edits', model: 'gpt-image-2', references: 1 }]);
  }, 60_000);

  it('does not read a provider-local reference after the execution environment refuses it', async () => {
    const events = await run([{ prompt: 'fixture denied reference', referenced_image_paths: [providerImage] }]);
    expect(readRequests).toContain(providerImage);
    expect(imageRequests).toEqual([]);
    expect(events.filter(event => event.type === 'image')).toEqual([]);
  }, 60_000);

  it('edits the previous generated image from conversation bytes without reading a provider file', async () => {
    await run([{ prompt: 'fixture first image' }, { prompt: 'fixture follow-up edit', num_last_images_to_include: 1 }]);
    expect(imageRequests.map(request => request.path)).toEqual(['/v1/images/generations', '/v1/images/edits']);
    expect(imageRequests[1]?.references).toBe(1);
    expect(readRequests).not.toContain(providerImage);
  }, 60_000);

  it('rejects a revoked image-model grant before paid dispatch even while chat remains allowed', async () => {
    const events = await run([{ prompt: 'fixture revoked image grant' }], true);
    expect(imageRequests).toEqual([]);
    expect(events.some(event => event.type === 'image' && (event.data as { status?: string }).status === 'completed')).toBe(false);
  }, 60_000);

  it('restores image generation when resuming a thread created with the old guest override', async () => {
    seedLegacyDisabledThread = true;
    try { await run([]); } finally { seedLegacyDisabledThread = false; }
    const events = await run([{ prompt: 'fixture resumed generation' }], false, lastThreadId);
    expect(imageRequests).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'image', data: expect.objectContaining({ status: 'completed', data: png.toString('base64') }) }));
  }, 60_000);

  it('does not fall back to a provider file when the reference-read connection drops', async () => {
    dropReferenceConnection = true;
    try {
      // Either a tool error or a terminal connection error is acceptable here;
      // the remote read must happen and no Images API dispatch may follow it.
      await run([{ prompt: 'fixture disconnected reference', referenced_image_paths: [providerImage] }]).catch(() => undefined);
      expect(readRequests).toContain(providerImage);
      expect(imageRequests).toEqual([]);
    } finally { dropReferenceConnection = false; }
  }, 60_000);
});
