/**
 * Manual E2E for #7393. A real sshd and the Desktop transport carry a native
 * Codex turn. The smallest failing input is an acknowledged turn and a short
 * TCP disconnect while the daemon stays up. Unit tests cannot establish what
 * an actual SSH channel close reports or whether the original turn survives.
 *
 * From the repository root (use Codex 0.167+ and an unprivileged SSH user):
 *   CINDY_TEST_CODEX_BINARY="$(command -v codex)" \
 *     pnpm --dir apps/desktop exec vitest run --pool=forks \
 *     src/main/maker-host/__tests__/codexSshReconnect.e2e.test.ts
 * CINDY_TEST_SSHD_BINARY overrides /usr/sbin/sshd.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type ServerResponse } from 'node:http';
import { createConnection, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';

import { RemoteHost, hostKeyFingerprint } from '@cindy/maker-remote-ssh';
import { AppServerClient } from '../../../../../../packages/maker-core/src/agents/codex/app-server/client.js';
import type { Transport } from '../../../../../../packages/maker-core/src/agents/codex/app-server/transport.js';
import type { Logger } from '../../../../../../packages/maker-core/src/interfaces/logger.js';
import { createSshDaemonTransport, shellQuote } from '../codex-remote-transport.js';

const codexBinary = process.env.CINDY_TEST_CODEX_BINARY;
const sshdBinary = process.env.CINDY_TEST_SSHD_BINARY ?? '/usr/sbin/sshd';
const loopback = '127.0.0.1';
const model = 'ssh-reconnect-test';
const output = 'Recovered the original SSH test turn.';
const requestTimeoutMs = 6000;

async function listen(server: Server): Promise<number> {
  server.listen(0, loopback);
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function startProcess(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = '';
  child.stderr.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-4000); });
  const exited = new Promise<void>((resolve) => {
    child.once('error', (error) => { diagnostics += error.message; });
    child.once('close', () => resolve());
  });
  return { child, exited, diagnostics: () => diagnostics };
}

async function stopProcess(process: ReturnType<typeof startProcess> | undefined) {
  if (!process) return;
  process.child.kill();
  const force = setTimeout(() => process.child.kill('SIGKILL'), 1000);
  try { await process.exited; } finally { clearTimeout(force); }
}

async function waitFor<T>(description: string, value: () => T | undefined, process?: ChildProcess, timeoutMs = requestTimeoutMs): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = value();
    if (result !== undefined) return result;
    if (process && (process.exitCode !== null || process.signalCode !== null)) break;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}

function sendEvent(response: ServerResponse, type: string, data: object) {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

function completeModelRequest(response: ServerResponse) {
  const item = {
    id: 'msg_ssh_test',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: output, annotations: [] }],
  };
  sendEvent(response, 'response.output_item.added', {
    output_index: 0, item: { ...item, status: 'in_progress', content: [] },
  });
  sendEvent(response, 'response.output_text.delta', {
    output_index: 0, content_index: 0, item_id: item.id, delta: output,
  });
  sendEvent(response, 'response.output_item.done', { output_index: 0, item });
  sendEvent(response, 'response.completed', {
    response: {
      id: 'resp_ssh_test', object: 'response', model, status: 'completed', output: [item],
      usage: {
        input_tokens: 1, output_tokens: 1, total_tokens: 2,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  });
  response.end();
}

it.skipIf(!codexBinary).each([
  'active after reconnect',
  'finished during disconnect',
  'first three SSH reconnects fail',
  'stop requested during disconnect',
  'new task waits for Codex recovery',
  'only the turn/start response arrives',
  'only the turn/started notification arrives',
  'neither start signal arrives',
] as const)('recovers the original turn over a real sshd (%s)', async (mode) => {
  const finishWhileDisconnected = mode === 'finished during disconnect';
  const lateReconnect = mode === 'first three SSH reconnects fail';
  const stopWhileDisconnected = mode === 'stop requested during disconnect';
  const queueNewTask = mode === 'new task waits for Codex recovery';
  const missingAck = mode === 'neither start signal arrives';
  const filterStartSignals = missingAck || mode === 'only the turn/start response arrives' ||
    mode === 'only the turn/started notification arrives';
  // A short path also fits macOS's Unix-domain socket path limit.
  const root = await mkdtemp('/tmp/cindy-ssh-e2e-');
  const home = join(root, 'codex-home');
  const socket = join(root, 'codex.sock');
  const serverKey = join(root, 'server-key');
  const clientKey = join(root, 'client-key');
  const sshConfig = join(root, 'sshd_config');
  const username = userInfo().username;
  const statuses: string[] = [];
  const logs: string[] = [];
  const proxyDiagnostics: string[] = [];
  const logger: Logger = {
    trace() {}, debug() {}, info(message) { logs.push(message); },
    warn(message, context) {
      if (message === 'proxy stderr' && typeof context?.line === 'string') proxyDiagnostics.push(context.line);
    },
    error() {}, fatal() {},
    child: () => logger,
  };
  let sshd: ReturnType<typeof startProcess> | undefined;
  let daemon: ReturnType<typeof startProcess> | undefined;
  let remoteHost: RemoteHost | undefined;
  let client: AppServerClient | undefined;
  let tunnel: Server | undefined;
  const sockets = new Set<Socket>();
  const modelRequests: ServerResponse[] = [];
  const provider = createHttpServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    request.once('end', () => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sendEvent(response, 'response.created', {
        response: { id: 'resp_ssh_test', object: 'response', model, status: 'in_progress', output: [] },
      });
      modelRequests.push(response);
    });
  });

  try {
    const executable = await realpath(codexBinary!);
    const providerPort = await listen(provider);
    const standalone = join(home, 'packages', 'standalone', 'current');
    await mkdir(standalone, { recursive: true });
    // sshd uses a minimal PATH. Preserve the interpreter for npm-installed Codex.
    const binPath = process.env.PATH ?? '/usr/bin:/bin';
    await writeFile(join(standalone, 'codex'), [
      '#!/bin/sh', `export PATH=${shellQuote(binPath)}`, `export HOME=${shellQuote(root)}`,
      `exec ${shellQuote(executable)} "$@"`, '',
    ].join('\n'), { mode: 0o700 });
    await writeFile(join(home, 'config.toml'), [
      `model = "${model}"`, 'model_provider = "ssh_test"', 'approval_policy = "never"',
      '[model_providers.ssh_test]', 'name = "Local SSH test"', 'wire_api = "responses"',
      `base_url = "http://${loopback}:${providerPort}/v1"`, 'requires_openai_auth = false',
    ].join('\n'));
    daemon = startProcess(executable, ['app-server', '--listen', `unix://${socket}`], {
      cwd: root, env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, TMPDIR: root },
    });

    for (const key of [serverKey, clientKey]) {
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { stdio: 'ignore', timeout: requestTimeoutMs });
    }
    const portReservation = createServer();
    const sshdPort = await listen(portReservation);
    await closeServer(portReservation);
    await writeFile(sshConfig, [
      `Port ${sshdPort}`, `ListenAddress ${loopback}`, `PidFile ${join(root, 'sshd.pid')}`,
      `HostKey ${serverKey}`, `AuthorizedKeysFile ${clientKey}.pub`,
      `AllowUsers ${username}`, 'AuthenticationMethods publickey', 'PasswordAuthentication no',
      'KbdInteractiveAuthentication no', 'UsePAM no', 'StrictModes no', 'PermitUserRC no',
      'PrintMotd no',
    ].join('\n') + '\n');
    sshd = startProcess(sshdBinary, ['-D', '-e', '-f', sshConfig]);
    await waitFor('sshd to listen', () => sshd?.diagnostics().includes('Server listening') || undefined, sshd.child);

    // The relay only cuts TCP sockets. It does not implement SSH or reconnect.
    let offline = false;
    let acceptedConnections = 0;
    tunnel = createServer((incoming) => {
      if (offline) { incoming.destroy(); return; }
      acceptedConnections++;
      const upstream = createConnection(sshdPort, loopback);
      for (const [current, peer] of [[incoming, upstream], [upstream, incoming]]) {
        sockets.add(current);
        current.on('error', () => peer.destroy());
        current.once('close', () => { sockets.delete(current); peer.destroy(); });
        current.pipe(peer);
      }
    });
    const tunnelPort = await listen(tunnel);
    const hostPublicKey = (await readFile(serverKey + '.pub', 'utf8')).split(/\s+/)[1];
    const expectedFingerprint = hostKeyFingerprint(Buffer.from(hostPublicKey, 'base64'));
    remoteHost = new RemoteHost({
      id: 'sshd-reconnect-test', hostname: loopback, port: tunnelPort, user: username,
      authMethod: 'key', identityFile: clientKey, source: 'manual', managedByCindy: false,
    }, {
      logger,
      hostKeys: {
        async get() { return expectedFingerprint; },
        async set() { throw new Error('Test server key must already be pinned'); },
        reload() {},
      },
    });
    remoteHost.onStatus(({ status }) => { statuses.push(status); });
    await remoteHost.connect();

    // Wait for the separately managed app-server before invoking the production proxy.
    await waitFor('Codex Unix socket', () => statSync(socket, { throwIfNoEntry: false })?.isSocket() || undefined, daemon.child);
    const host = remoteHost;
    let threadId: string | undefined;
    let rawTurnId: string | undefined;
    let startRequestId: number | undefined;
    const startSignals = new Set<string>();
    const deliveredStartSignals = new Set<string>();
    const requestsWritten: string[] = [];
    const snapshotGate = Promise.withResolvers<void>();
    let snapshotHeld = false;
    // Control JSON-RPC delivery at the client boundary while keeping the
    // actual daemon, SSH transport, and TCP disconnect in the test.
    const instrument = (transport: Transport, replacement = false): Transport => ({
      ...transport,
      async writeLine(line) {
        const { id, method } = JSON.parse(line) as { id: number; method: string };
        if (!replacement && method === 'turn/start') startRequestId = id;
        if (replacement && queueNewTask && method === 'thread/turns/list') {
          snapshotHeld = true;
          await snapshotGate.promise;
        }
        requestsWritten.push(method);
        return transport.writeLine(line);
      },
      onLine(handler) {
        return transport.onLine((line) => {
          if (!replacement && filterStartSignals) {
            const msg = JSON.parse(line);
            const isResponse = startRequestId !== undefined && msg.id === startRequestId && msg.result?.turn;
            const isNotification = msg.method === 'turn/started' && msg.params?.threadId === threadId;
            if (isResponse || isNotification) {
              const signal = isResponse ? 'response' : 'notification';
              rawTurnId = (isResponse ? msg.result.turn : msg.params.turn).id;
              startSignals.add(signal);
              if (missingAck || (isResponse && mode === 'only the turn/started notification arrives') ||
                  (isNotification && mode === 'only the turn/start response arrives')) return;
              deliveredStartSignals.add(signal);
            }
          }
          handler(line);
        });
      },
      reconnect: async (signal) => instrument(await transport.reconnect!(signal), true),
      async close(reason) {
        snapshotGate.resolve();
        await transport.close(reason);
      },
    });
    let failure: Error | undefined;
    const completed: Array<{ threadId: string; turn: { id: string; status: string } }> = [];
    const finalMessages: string[] = [];
    client = new AppServerClient({
      createTransport: () => instrument(createSshDaemonTransport({ remoteHost: host, socketPath: socket, installRoot: root, logger })),
      logger,
      getSubscribedThreadIds: () => threadId ? [threadId] : [],
      onTransportError: (error) => { failure = error; },
    });
    client.onNotification('item/completed', (params) => {
      const { item } = params as { item: { type: string; text: string } };
      if (item.type === 'agentMessage') finalMessages.push(item.text);
    });
    client.onNotification('turn/completed', (params) => {
      completed.push(params as (typeof completed)[number]);
    });
    client.start();
    const initialization = client.initialize({ name: 'cindy_ssh_reconnect_test', version: '1' }, { experimentalApi: true });
    await Promise.race([initialization, delay(requestTimeoutMs, undefined, { ref: false }).then(() => {
      throw new Error('Timed out initializing Codex over SSH');
    })]);
    const started = await client.request<{ thread: { id: string } }>('thread/start', {
      cwd: root, model, modelProvider: 'ssh_test',
    }, { timeoutMs: requestTimeoutMs });
    threadId = started.thread.id;
    const startTurn = (id: string) => client!.request<{ turn: { id: string } }>('turn/start', {
      threadId: id, input: [{ type: 'text', text: 'SSH reconnect test only.', text_elements: [] }],
    }, { timeoutMs: requestTimeoutMs });
    const originalStart = startTurn(threadId).then(
      ({ turn }) => ({ turn, error: undefined }),
      (error: Error) => ({ turn: undefined, error }),
    );
    if (filterStartSignals) {
      await waitFor('both daemon start signals at the transport boundary', () => startSignals.size === 2 || undefined);
      expect([...deliveredStartSignals]).toEqual(missingAck ? [] :
        [mode === 'only the turn/start response arrives' ? 'response' : 'notification']);
    } else {
      const result = await originalStart;
      if (!result.turn) throw result.error;
      rawTurnId = result.turn.id;
    }
    const response = await waitFor('original model request', () => modelRequests[0]);
    expect(acceptedConnections).toBe(1);

    offline = true;
    for (const active of sockets) active.destroy();
    await waitFor('SSH reconnecting', () => statuses.includes('reconnecting') || undefined);
    if (missingAck) {
      expect((await originalStart).error?.message).toContain('transport failure');
      expect(failure).toBeDefined();
      expect(requestsWritten.filter((method) => method === 'turn/start')).toHaveLength(1);
      expect(requestsWritten).not.toContain('thread/turns/list');
      return;
    }
    // A second task on the same host joins the outstanding reconnect round.
    const newTaskConnection = lateReconnect
      ? remoteHost.connect().then(() => ({}), (error: unknown) => ({ error }))
      : undefined;
    if (finishWhileDisconnected) completeModelRequest(response);
    let stop: Promise<{ error?: unknown }> | undefined;
    if (stopWhileDisconnected) {
      // Capture both outcomes immediately so an early rejection cannot become
      // an unhandled promise while the fixture waits for the SSH reconnect.
      stop = client.request('turn/interrupt', { threadId, turnId: rawTurnId }).then(() => ({}), (error) => ({ error }));
    }
    if (lateReconnect) {
      await waitFor('three SSH reconnects to fail',
        () => statuses.filter((status) => status === 'failed').length === 3 || undefined, undefined, 10_000);
    } else {
      await delay(750);
    }
    offline = false;
    await waitFor('SSH ready again',
      () => statuses.filter((status) => status === 'ready').length === 2 || undefined, undefined, 10_000);
    expect(acceptedConnections).toBe(2);
    if (newTaskConnection) expect(await newTaskConnection).toEqual({});

    let secondTask: Promise<{ threadId: string; turnId: string } | Error> | undefined;
    if (queueNewTask) {
      await waitFor('Codex recovery snapshot to be held', () => snapshotHeld || undefined);
      const writes = requestsWritten.length;
      const params = { cwd: root, model, modelProvider: 'ssh_test' };
      secondTask = client.request<{ thread: { id: string } }>('thread/start', params, { timeoutMs: requestTimeoutMs })
        .then(async ({ thread }) => ({ threadId: thread.id, turnId: (await startTurn(thread.id)).turn.id }))
        .catch((error: Error) => error);
      const controller = new AbortController();
      const cancelled = client.request('thread/start', params, { signal: controller.signal })
        .catch((error: Error) => error);
      controller.abort(new Error('new task cancelled'));
      expect(await cancelled).toEqual(new Error('new task cancelled'));
      expect(requestsWritten).toHaveLength(writes);
      snapshotGate.resolve();
    }

    await waitFor('original Codex client to recover', () => {
      if (failure) throw failure;
      return logs.includes('Codex SSH transport recovered') || undefined;
    });
    expect(failure).toBeUndefined();
    const start = await originalStart;
    if (!start.turn) throw start.error;
    expect(start.turn.id).toBe(rawTurnId);
    if (stopWhileDisconnected) {
      expect(await stop).toEqual({});
    } else if (finishWhileDisconnected) {
      expect(completed).toHaveLength(1);
    } else {
      expect(completed).toHaveLength(0);
      completeModelRequest(response);
    }
    await waitFor('original turn completion', () => completed.find((event) => event.threadId === threadId));
    const expected = [{
      threadId,
      turn: expect.objectContaining({ id: rawTurnId, status: stopWhileDisconnected ? 'interrupted' : 'completed' }),
    }];
    if (secondTask) {
      // A separate SSH channel can still access files on the same host.
      const probe = join(root, 'ssh-reconnect-probe');
      await writeFile(probe, 'file available after reconnect');
      expect(await host.exec(`cat ${shellQuote(probe)}`)).toMatchObject({
        exitCode: 0, stdout: 'file available after reconnect',
      });
      const second = await secondTask;
      if (second instanceof Error) throw second;
      const secondResponse = await waitFor('second model request', () => modelRequests[1]);
      completeModelRequest(secondResponse);
      await waitFor('second turn completion', () => completed.find((event) => event.threadId === second.threadId));
      expected.push({ threadId: second.threadId, turn: expect.objectContaining({ id: second.turnId, status: 'completed' }) });
    }
    expect(completed).toEqual(expected);
    expect(finalMessages).toEqual(stopWhileDisconnected ? [] : secondTask ? [output, output] : [output]);
    expect(modelRequests).toHaveLength(secondTask ? 2 : 1);
    expect(requestsWritten.filter((method) => method === 'turn/start')).toHaveLength(secondTask ? 2 : 1);
    expect(requestsWritten.filter((method) => method === 'thread/start')).toHaveLength(secondTask ? 2 : 1);
    expect(daemon.child.exitCode).toBeNull();
  } catch (error) {
    throw new Error(
      `${String(error)}\nSSH states: ${statuses.join(' → ')}\nsshd: ${sshd?.diagnostics() ?? ''}\nCodex: ${daemon?.diagnostics() ?? ''}\nCodex proxy: ${proxyDiagnostics.join('\n')}`,
      { cause: error },
    );
  } finally {
    await client?.close();
    await remoteHost?.disconnect();
    for (const active of sockets) active.destroy();
    provider.closeAllConnections();
    await Promise.all([
      ...(tunnel ? [closeServer(tunnel)] : []), closeServer(provider), stopProcess(sshd), stopProcess(daemon),
    ]);
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);
