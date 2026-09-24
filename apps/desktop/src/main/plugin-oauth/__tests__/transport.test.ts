import { testOauthIdentityStore } from './fixtures.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveOauthPeerIdentity } from '../identityResolver.js';
import { createHash } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { expect, it, vi } from 'vitest';
import { DeviceLinkClient, PLUGIN_OAUTH_CHANNEL, type Envelope } from '@cindy/device-link';
import type { GhostSetupAssessment } from '../../../shared/ghost.js';
import { GhostOauthAccountManager } from '../../cindy-brain/ghostOauthAccounts.js';
import { GhostSetupChangeBus } from '../../cindy-brain/ghostSetupChangeBus.js';
import { GhostSetupCoordinator } from '../../cindy-brain/ghostSetupCoordinator.js';
import { GhostSetupInteractionBridge } from '../../cindy-brain/ghostSetupInteractionBridge.js';
import { getRemoteOauthContext } from '../context.js';
import { initializePluginOauthCards } from '../cards.js';
import { handleAssistPluginOauth } from '../localIpc.js';
import { invalidatePluginOauth, requestPluginOauth } from '../runtime.js';

it('carries a real setup card through DeviceLinkClient/WebSocket, loopback and cloud vault commit', async ({
  onTestFinished,
}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-oauth-transport-'));
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const identityStore = testOauthIdentityStore(directory);
  const controllerScope = {
    realm: 'global' as const,
    deviceId: 'desktop',
    membershipId: 'synthetic-member',
  };
  // Real transport clients and sockets; only relay identity and provider HTTP are synthetic.
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => relay.once('listening', resolve));
  const port = (relay.address() as { port: number }).port;
  const sockets = new Map<string, WebSocket>();
  const frames: unknown[] = [];
  relay.on('connection', (socket, req) => {
    const peer = req.url!.slice(1);
    sockets.set(peer, socket);
    socket.on('message', (bytes) => {
      const env = JSON.parse(bytes.toString()) as Envelope;
      frames.push(env);
      if (env.kind === 'hello') {
        socket.send(
          JSON.stringify({
            v: 1,
            kind: 'hello-ack',
            payload: {
              serverProtocolVersion: 1,
              deviceId: peer,
              userId: 'synthetic-member',
            },
          }),
        );
      } else if (env.kind === 'ping') {
        socket.send(JSON.stringify({ v: 1, kind: 'pong', id: env.id }));
      } else if (env.dst) {
        const routed = { ...env, src: peer };
        frames.push(routed);
        sockets.get(env.dst)?.send(JSON.stringify(routed));
      }
    });
  });
  const clients: DeviceLinkClient[] = [];
  function client(peer: string) {
    const c = new DeviceLinkClient({
      getWsUrl: () => `ws://127.0.0.1:${port}/${peer}`,
      getToken: async () => 'synthetic-relay-identity',
      getHello: () => ({
        deviceName: peer,
        platform: 'test',
        appVersion: '1',
        remoteControlEnabled: true,
        busy: false,
      }),
      createWebSocket: (url, headers) => new WebSocket(url, { headers }),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    clients.push(c);
    return c;
  }
  const cloud = client('cloud');
  const desktop = client('desktop');
  const other = client('other-desktop');
  const vault = new Map<string, string>();
  const broadcasts: unknown[] = [];
  const bus = new GhostSetupChangeBus();
  const bridge = new GhostSetupInteractionBridge({
    broadcast: (...args) => {
      broadcasts.push(args);
    },
  });
  let connected = false;
  let challenge = '';
  let codeState = '';
  let verifier = '';
  let exchangeCount = 0;
  let transactionId = '';
  const account = new GhostOauthAccountManager({
    vault: {
      read: (g, k) => vault.get(`${g}/${k}`) ?? null,
      store: (g, k, value) => {
        vault.set(`${g}/${k}`, value);
        return true;
      },
      remove: (g, k) => {
        vault.delete(`${g}/${k}`);
      },
    },
    openExternal: () => {
      throw new Error('Cloud browser forbidden');
    },
    fetchImpl: async (_url, init) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('code')).toBe('synthetic-provider-code');
      verifier = body.get('code_verifier')!;
      expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
      exchangeCount++;
      return new Response(
        JSON.stringify({
          access_token: 'synthetic-access',
          refresh_token: 'synthetic-refresh',
          expires_in: 3600,
        }),
      );
    },
    onAccountConnected: () => {
      connected = true;
      // Exercises card close/readiness racing with the controller's next status poll.
      bus.emit('test-plugin', { source: 'oauth', ref: 'account' });
    },
  });
  const assessment = (): GhostSetupAssessment => ({
    revision: connected ? 2 : 1,
    state: connected ? 'ready' : 'required',
    groups: connected
      ? []
      : [
          {
            id: 'account',
            mode: 'any_of',
            items: [
              {
                ref: 'secret:account',
                kind: 'oauth',
                label: 'Provider',
                state: 'missing',
                actions: [{ id: 'oauth_connect:secret:account', kind: 'oauth_connect' }],
              },
            ],
          },
        ],
  });
  const coordinator = new GhostSetupCoordinator({
    bridge,
    changeBus: bus,
    assess: assessment,
    validateTarget: () => ({ ok: true }),
    getGhostIdentity: () => ({ id: 'test-plugin', name: 'Provider' }),
    executeAction: async () => {
      const result = await account.connectAccount(
        'test-plugin',
        'account',
        {
          authorizeUrl: 'https://provider.example/authorize',
          tokenUrl: 'https://provider.example/token',
          clientId: 'synthetic-client',
          scopes: ['read'],
        },
        { remote: getRemoteOauthContext() },
      );
      return result.ok ? { ok: true } : { ok: false, errorCode: 'ACTION_FAILED' };
    },
    terminalGraceMs: 0,
  });
  initializePluginOauthCards({
    loadKey: (scope, check) => identityStore.store.load(scope, check),
    identity: () => ({
      deviceId: 'cloud',
      realm: 'global' as const,
      membershipId: 'synthetic-member',
    }),
    bridge,
    bots: () => null,
    owner: () => 'synthetic-member:g1',
    available: (peer) => ['desktop', 'other-desktop'].includes(peer),
  });
  cloud.onFrame(async (env) => {
    if (env.kind === 'link-open')
      cloud.sendLinkAccept(env.src!, env.id!, { appVersion: '1', allowlistHash: 'synthetic' });
    if (env.kind === 'invoke') {
      const payload = env.payload as { channel: string; args: unknown[] };
      try {
        if (payload.channel !== PLUGIN_OAUTH_CHANNEL || payload.args.length !== 1)
          throw new Error('denied');
        const result = await requestPluginOauth(env.src!, payload.args[0]);
        if ((payload.args[0] as { op: string }).op === 'hello')
          transactionId = (result as { id: string }).id;
        cloud.sendInvokeResult(env.src!, env.id!, { ok: true, result });
      } catch {
        cloud.sendInvokeResult(env.src!, env.id!, {
          ok: false,
          error: { code: 'IPC_ERROR', message: 'unavailable' },
        });
      }
    }
  });
  const setup = coordinator.ensureReady({
    sessionId: 'cloud-session',
    ghostId: 'test-plugin',
    tool: 'read',
  });
  try {
    for (const c of clients) c.start();
    await vi.waitFor(() => expect(clients.every((c) => c.getSelfDeviceId())).toBe(true));
    for (const c of [desktop, other])
      await c.openLink('cloud', { controllerName: 'test', appVersion: '1', protocolVersion: 1 });
    await vi.waitFor(() => expect(bridge.pendingSnapshots()).toHaveLength(1));
    const snapshot = bridge.pendingSnapshots()[0].request;
    const callbackResponses: number[] = [];
    const result = await handleAssistPluginOauth(
      {
        owner: () => 'synthetic-member:g1',
        localDeviceId: () => 'desktop',
        trustIdentity: (id, check) =>
          identityStore.store.trustPeer(controllerScope, id.deviceId, id.publicKey, check),
        identity: (id, check) =>
          resolveOauthPeerIdentity(
            {
              scope: () => controllerScope,
              invoke: (dst, channel, args) => desktop.invoke(dst, { channel, args }),
            },
            id,
            check,
          ),
        assertTarget: (id) => {
          expect(id).toBe('cloud');
        },
        invoke: (dst, channel, args) => desktop.invoke(dst, { channel, args }),
        openExternal: async (raw) => {
          const url = new URL(raw);
          challenge = url.searchParams.get('code_challenge')!;
          codeState = url.searchParams.get('state')!;
          const stolen = await other.invoke('cloud', {
            channel: PLUGIN_OAUTH_CHANNEL,
            args: [{ op: 'status', id: transactionId }],
          });
          expect(stolen.ok).toBe(false);
          const callback = new URL(url.searchParams.get('redirect_uri')!);
          callback.searchParams.set('state', codeState);
          callback.searchParams.set('code', 'synthetic-provider-code');
          const response = await fetch(callback);
          callbackResponses.push(response.status);
          expect(await response.text()).toContain('callback received');
        },
      },
      {
        deviceId: 'cloud',
        ghostId: 'test-plugin',
        requestId: snapshot.requestId,
        actionId: snapshot.steps[0].action!.id,
        expectedRevision: snapshot.revision,
      },
    );
    expect(result).toEqual({ accepted: true });
    expect(callbackResponses).toEqual([200]);
    await expect(setup).resolves.toMatchObject({ ok: true });
    expect(exchangeCount).toBe(1);
    expect([...vault.values()]).toContain('synthetic-refresh');
    const projected = JSON.stringify({ frames, broadcasts, result });
    for (const secret of [
      codeState,
      verifier,
      challenge,
      'synthetic-provider-code',
      'synthetic-access',
      'synthetic-refresh',
      'provider.example',
    ]) {
      expect(projected).not.toContain(secret);
    }
  } finally {
    invalidatePluginOauth();
    bridge.cleanupAll('session_aborted');
    await setup;
    await coordinator.waitForActionsIdle();
    for (const c of clients) c.stop();
    for (const socket of relay.clients) socket.terminate();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  }
}, 10_000);
