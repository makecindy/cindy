/** #6412: unit coverage of the native delivery entry, real blob/ledger/journal and restart recovery.
 * Existing materializer tests do not cross transport ACK, durable publication or owner/clear fences.
 * Real main-process translations also cover the misplaced locale namespace reported on PR #6420.
 * The native generator and message writer are boundaries; retries never receive a generator API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { AgentEvent, GeneratedImageEventData } from '@cindy/maker-core';
import { providerShareHostPeer } from '@cindy/device-link';
import type { DbClient } from '../../localDb/client/DbClient';
import * as schema from '../../localDb/schema';
import { clearCurrentDbClient, setCurrentDbClient } from '../../localDb/client/current';
import { setMainLocale } from '../../i18n';
import { createGeneratedImageDelivery } from '../generatedImageDelivery';
import {
  captureGeneratedImageStorage,
  handleGeneratedImageArtifacts,
  prepareGeneratedImageTransport,
  readGeneratedImageEpoch,
} from '../generatedImageStorage';
import { generatedImageId, initialGeneratedImageRecord } from '../generatedImageJournal';
import { resolveSafe } from '../blobStore';
import * as ledger from '../ledger';

const state = vi.hoisted(() => ({
  root: '',
  generation: 1,
  failResult: false,
  beforeResult: undefined as (() => void) | undefined,
  insert: undefined as ((sessionId: string, body: Record<string, unknown>) => void) | undefined,
  read: undefined as ((clientId: string) => { content: string; created_at: number }) | undefined,
  broadcast: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../../appSessionState', () => ({
  getActiveAppSession: () => ({ dataOwnerId: 'owner', generation: state.generation }),
  isAppSessionBoundaryPending: () => false,
  activeOwnerScopeKey: () => `owner:${state.generation}`,
  dataOwnerStorageKey: () => 'a'.repeat(20),
  ownerScopedUserDataPath: (...parts: string[]) =>
    path.join(state.root, 'owners', 'a'.repeat(20), ...parts),
}));
vi.mock('../../device-link/broadcast-tap', () => ({ captureDataOwnerBroadcastScope: () => ({}) }));
vi.mock('../../localDb/ipc/messages', () => ({
  broadcastMessageRow: state.broadcast,
  createMessage: async (
    sid: string,
    body: Record<string, unknown>,
    options: { beforePublish(): Promise<void> },
  ) => {
    if (body.role === 'tool_result') {
      state.beforeResult?.();
      if (state.failResult) throw new Error('disk unavailable');
    }
    await options.beforePublish();
    state.insert!(sid, body);
    const row = state.read!(body.clientId as string);
    return {
      ...body,
      id: body.clientId,
      sessionId: sid,
      content: JSON.parse(row.content),
      createdAt: new Date(row.created_at).toISOString(),
    };
  },
}));

const image: GeneratedImageEventData = {
  kind: 'generation',
  threadId: 'thread',
  turnId: 'turn',
  blockId: 'image',
  status: 'completed',
};
const id = generatedImageId(image);
const event = (data: Partial<GeneratedImageEventData> = {}): AgentEvent => ({
  type: 'image',
  source: 'codex',
  data: { ...image, ...data },
});
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 42]);
let raw: Database.Database;
beforeEach(async () => {
  setMainLocale('en');
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-native-image-'));
  state.generation = 1;
  state.failResult = false;
  state.beforeResult = undefined;
  state.broadcast.mockClear();
  raw = new Database(':memory:');
  raw.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT, cleared_at INTEGER, agent_device_id TEXT, remote_host_id TEXT, working_dir TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, client_id TEXT, role TEXT, content TEXT, rewind_at INTEGER, created_at INTEGER, UNIQUE(session_id, client_id));
    INSERT INTO sessions VALUES ('task', 'active', NULL, NULL, NULL, NULL);`);
  raw.exec(
    await fs.readFile(
      path.resolve(__dirname, '../../../../drizzle/0070_woozy_harpoon.sql'),
      'utf8',
    ),
  );
  raw.exec('ALTER TABLE media_refs ADD COLUMN label TEXT');
  const client = {
    drizzle: drizzle(raw, { schema }),
    exec: async (sql: string, params: unknown[]) => raw.prepare(sql).run(...params),
    queryOne: async (sql: string, params: unknown[]) => raw.prepare(sql).get(...params),
  } as unknown as DbClient;
  setCurrentDbClient(client, 'owner');
  state.insert = (sid, body) =>
    raw
      .prepare('INSERT OR IGNORE INTO messages VALUES (?, ?, ?, ?, ?, NULL, ?)')
      .run(
        body.clientId,
        sid,
        body.clientId,
        body.role,
        JSON.stringify(body.content),
        body.createdAt,
      );
  state.read = (clientId) =>
    raw.prepare('SELECT content, created_at FROM messages WHERE client_id = ?').get(clientId) as {
      content: string;
      created_at: number;
    };
});
afterEach(async () => {
  vi.restoreAllMocks();
  clearCurrentDbClient();
  raw.close();
  await fs.rm(state.root, { recursive: true, force: true });
});

function prepareTransport(
  scope: string,
  imageEvent: AgentEvent,
  options: Partial<Parameters<typeof prepareGeneratedImageTransport>[2]> = {},
) {
  return prepareGeneratedImageTransport(scope, imageEvent, { retainForRecovery: true, ...options });
}

function controller() {
  const invoke = vi.fn(async (_device: string, _channel: string, args: unknown[]) => {
    const request = args[0] as Parameters<typeof handleGeneratedImageArtifacts>[1];
    return {
      ok: true,
      result:
        request.op === 'images'
          ? await handleGeneratedImageArtifacts('host-task', request)
          : { imageRecovery: true },
    };
  });
  const publish = vi.fn();
  return { ...createGeneratedImageDelivery({ invoke, publish }), invoke, publish };
}
function result() {
  const row = raw.prepare("SELECT content FROM messages WHERE role = 'tool_result'").get() as {
    content: string;
  };
  return JSON.parse(JSON.parse(row.content));
}

describe('native image delivery', () => {
  // Legacy journals used share:<id> exclusively for O. A later clear/direct assignment
  // must not reinterpret that historical source, including release-only cleanup receipts.
  it.each(['cleanup', 'recover', 'reconcile'] as const)(
    'keeps a legacy O alias on O after a later M assignment via %s',
    async (entry) => {
      raw.exec("UPDATE sessions SET agent_device_id = 'share:shared'");
      await prepareTransport('remote:owner-task', event({ data: png.toString('base64') }));
      const storage = captureGeneratedImageStorage();
      if (entry === 'reconcile') {
        raw.exec("UPDATE sessions SET status = 'deleted'");
        const scope = 'cleanup:task:share:shared';
        await storage.journal.updateCleanup(scope, () => ({
          version: 1,
          scope,
          sessionId: 'task',
          agentDeviceId: 'share:shared',
          clearedAt: null,
          deleted: true,
        }));
      } else {
        await storage.journal.update('task:task', id, () => ({
          ...initialGeneratedImageRecord('task:task', image),
          agentDeviceId: 'share:shared',
          clearedAt: null,
        }));
        if (entry === 'cleanup') raw.exec('UPDATE sessions SET cleared_at = 100');
      }
      const owner = providerShareHostPeer('shared', 'owner');
      const member = providerShareHostPeer('shared', 'member');
      let currentOwner = owner;
      let releaseOffline = entry === 'recover';
      const invoke = vi.fn(async (device: string, _channel: string, args: unknown[]) => {
        const request = args[0] as Parameters<typeof handleGeneratedImageArtifacts>[1];
        if (
          releaseOffline &&
          device === owner &&
          request.op === 'images' &&
          request.action === 'release'
        )
          throw new Error('owner offline');
        return {
          ok: true,
          result:
            request.op === 'images'
              ? await handleGeneratedImageArtifacts(
                  device === owner ? 'owner-task' : 'empty-member-task',
                  request,
                )
              : { imageRecovery: true },
        };
      });
      const host = createGeneratedImageDelivery({
        invoke,
        publish: vi.fn(),
        authorizeSharedTaskHistory: async () => member,
        resolveSharedOwnerTarget: async () => currentOwner,
      });
      if (entry === 'reconcile') await host.reconcile();
      else await host[entry]('task');
      if (entry === 'recover') {
        expect((await storage.journal.read('task:task', id))?.sourceReleased).not.toBe(true);
        currentOwner = providerShareHostPeer('shared', 'replacement-owner');
        invoke.mockClear();
        await host.recover('task', id);
        expect(invoke).not.toHaveBeenCalled();
        expect((await storage.journal.read('task:task', id))?.sourceReleased).not.toBe(true);
        currentOwner = owner;
        releaseOffline = false;
        await host.recover('task', id);
      }
      expect((await storage.journal.read('remote:owner-task', id))?.state).toBe('released');
      const knownRequests = invoke.mock.calls.filter(
        ([, , args]) => (args[0] as { imageId?: string }).imageId === id,
      );
      expect(knownRequests.length).toBeGreaterThan(0);
      expect(knownRequests.every(([device]) => device === owner)).toBe(true);
      if (entry !== 'reconcile')
        expect(await storage.journal.read('task:task', id)).toMatchObject({
          agentDeviceId: owner,
          legacyOwnerRoute: 'share:shared',
          sourceReleased: true,
        });
    },
  );

  it.each([false, true])(
    'locates an early M event before creating its journal (initially offline=%s)',
    async (offline) => {
      raw.exec("UPDATE sessions SET agent_device_id = 'share:shared'");
      const transported = await prepareTransport(
        'remote:host-task',
        event({ data: png.toString('base64') }),
      );
      const target = providerShareHostPeer('shared', 'member');
      const original = controller();
      let firstAuthorization = true;
      const host = createGeneratedImageDelivery({
        invoke: original.invoke,
        publish: original.publish,
        liveSharedTaskTarget: () => null,
        authorizeSharedTaskHistory: async () => {
          if (firstAuthorization)
            expect(await captureGeneratedImageStorage().journal.read('task:task', id)).toBeNull();
          if (offline) throw new Error('owner offline');
          firstAuthorization = false;
          return target;
        },
      });
      if (offline) {
        await expect(host.deliver('task', transported)).rejects.toThrow('owner offline');
        expect(await captureGeneratedImageStorage().journal.read('task:task', id)).toBeNull();
        expect(
          (await captureGeneratedImageStorage().journal.read('remote:host-task', id))?.state,
        ).not.toBe('released');
        offline = false;
      }
      await host.deliver('task', transported);
      expect(await captureGeneratedImageStorage().journal.read('task:task', id)).toMatchObject({
        agentDeviceId: target,
        sourceReleased: true,
      });
      expect(original.invoke.mock.calls.every(([device]) => device === target)).toBe(true);
    },
  );

  // Direct sharing regression (unit): real delivery/journal/blob entry, with transport and
  // task authorization at the boundary. Existing restart tests use one machine and cannot
  // detect O's successful empty release ACK for an artifact that exists only on M.
  it.each([true, false])(
    'keeps the direct image source across an O outage and restart (inline=%s)',
    async (inline) => {
      raw.exec("UPDATE sessions SET agent_device_id = 'share:shared'");
      const target = providerShareHostPeer('shared', 'member');
      const transported = await prepareTransport(
        'remote:member-task',
        event({ data: png.toString('base64') }),
      );
      let online = false;
      let live = true;
      let leaseClock = Date.now();
      let authorizedUntil = 0;
      const authorizeSharedTaskHistory = vi.fn(async (sessionId: string, ownerRoute: string) => {
        expect([sessionId, ownerRoute]).toEqual(['task', 'share:shared']);
        if (!online) throw new Error('owner offline');
        authorizedUntil = leaseClock + 60_000;
        return target;
      });
      const invoke = vi.fn(async (device: string, _channel: string, args: unknown[]) => {
        const request = args[0] as Parameters<typeof handleGeneratedImageArtifacts>[1];
        // O legitimately acknowledges release of its empty journal; it must never be selected.
        if (device === 'share:shared')
          return {
            ok: true,
            result:
              request.op === 'images'
                ? await handleGeneratedImageArtifacts('empty-owner-task', request)
                : { imageRecovery: true },
          };
        expect(device).toBe(target);
        expect(authorizedUntil).toBeGreaterThan(leaseClock);
        return {
          ok: true,
          result:
            request.op === 'images'
              ? await handleGeneratedImageArtifacts('member-task', request)
              : { imageRecovery: true },
        };
      });
      const controller = () =>
        createGeneratedImageDelivery({
          invoke,
          publish: vi.fn(),
          authorizeSharedTaskHistory,
          liveSharedTaskTarget: () => (live ? target : null),
        });
      await controller().deliver(
        'task',
        inline ? transported : event({ pathOrigin: 'remote-agent' }),
      );
      expect(await captureGeneratedImageStorage().journal.read('task:task', id)).toMatchObject({
        agentDeviceId: target,
        state: inline ? 'stored' : 'failed',
      });
      expect(
        (await captureGeneratedImageStorage().journal.read('task:task', id))?.sourceReleased,
      ).not.toBe(true);
      expect(
        (await captureGeneratedImageStorage().journal.read('remote:member-task', id))?.state,
      ).not.toBe('released');
      expect(invoke).not.toHaveBeenCalled();
      live = false;
      // Advance only the authorization clock: filesystem locks use actual file mtimes.
      leaseClock += 31 * 60_000;
      await controller().recover('task', id);
      expect(
        (await captureGeneratedImageStorage().journal.read('task:task', id))?.sourceReleased,
      ).not.toBe(true);
      online = true;
      const unknown = { ...image, blockId: 'missing-after-restart' };
      await prepareTransport(
        'remote:member-task',
        event({ ...unknown, data: png.toString('base64') }),
      );
      await controller().recover('task');
      expect(
        (await captureGeneratedImageStorage().journal.read('task:task', id))?.sourceReleased,
      ).toBe(true);
      expect(
        (await captureGeneratedImageStorage().journal.read('remote:member-task', id))?.state,
      ).toBe('released');
      expect(
        await captureGeneratedImageStorage().journal.read('task:task', generatedImageId(unknown)),
      ).toMatchObject({
        agentDeviceId: target,
        state: 'stored',
        sourceReleased: true,
      });
      expect(invoke.mock.calls.every(([device]) => device === target)).toBe(true);
      expect(
        invoke.mock.calls.map(([, , args]) => (args[0] as { action?: string }).action),
      ).toEqual(expect.arrayContaining(['list', 'read', 'release']));
      expect(authorizeSharedTaskHistory).toHaveBeenCalled();
    },
  );

  it('retains a direct release receipt when historical authorization names a different source', async () => {
    raw.exec("UPDATE sessions SET agent_device_id = 'share:shared'");
    const target = providerShareHostPeer('shared', 'member');
    const invoke = vi.fn(async () => ({ ok: true, result: { ok: true } }));
    const controller = () =>
      createGeneratedImageDelivery({
        invoke,
        publish: vi.fn(),
        liveSharedTaskTarget: () => target,
        authorizeSharedTaskHistory: async () => providerShareHostPeer('shared', 'different-member'),
      });
    await controller().deliver('task', event({ data: png.toString('base64') }));
    await controller().recover('task', id);
    expect(
      (await captureGeneratedImageStorage().journal.read('task:task', id))?.sourceReleased,
    ).not.toBe(true);
    await expect(controller().recover('task')).rejects.toThrow('REMOTE_SOURCE_REQUIRED');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('continues to recover legacy shared images through their authorized owner route', async () => {
    raw.exec("UPDATE sessions SET agent_device_id = 'share:shared'");
    await prepareTransport('remote:host-task', event({ data: png.toString('base64') }));
    const original = controller();
    const owner = providerShareHostPeer('shared', 'owner');
    const authorizeSharedTaskHistory = vi.fn(async () => owner);
    const legacy = createGeneratedImageDelivery({
      invoke: original.invoke,
      publish: original.publish,
      authorizeSharedTaskHistory,
      liveSharedTaskTarget: () => null,
    });
    await legacy.recover('task');
    expect(result().ok).toBe(true);
    expect(authorizeSharedTaskHistory).toHaveBeenCalledWith('task', 'share:shared');
    expect(original.invoke.mock.calls.every(([device]) => device === owner)).toBe(true);
    expect(
      (await captureGeneratedImageStorage().journal.read('task:task', id))?.agentDeviceId,
    ).toBe(owner);
    expect(
      (await captureGeneratedImageStorage().journal.read('task:task', id))?.sourceReleased,
    ).toBe(true);
  });

  it('reconciles a direct cleanup receipt after an offline deletion without contacting O for images', async () => {
    raw.exec("UPDATE sessions SET agent_device_id = 'share:shared', status = 'deleted'");
    await prepareTransport('remote:host-task', event({ data: png.toString('base64') }));
    const target = providerShareHostPeer('shared', 'member');
    let online = false;
    const original = controller();
    const authorizeSharedTaskHistory = vi.fn(async (sessionId: string, ownerRoute: string) => {
      expect([sessionId, ownerRoute]).toEqual(['task', 'share:shared']);
      if (!online) throw new Error('owner offline');
      return target;
    });
    const deps = { invoke: original.invoke, publish: original.publish, authorizeSharedTaskHistory };
    await createGeneratedImageDelivery({ ...deps, liveSharedTaskTarget: () => target }).cleanup(
      'task',
    );
    expect(await captureGeneratedImageStorage().journal.listCleanups()).toEqual([
      expect.objectContaining({ agentDeviceId: target, deleted: true }),
    ]);
    expect(original.invoke).not.toHaveBeenCalled();
    online = true;
    await createGeneratedImageDelivery(deps).reconcile();
    expect(original.invoke.mock.calls.every(([device]) => device === target)).toBe(true);
    expect((await captureGeneratedImageStorage().journal.read('remote:host-task', id))?.state).toBe(
      'released',
    );
    expect(original.publish).not.toHaveBeenCalled();
    expect(raw.prepare('SELECT * FROM messages').all()).toHaveLength(0);
  });

  it('delivers bytes ahead of an unrelated remote path, persists one result and one attachment on duplicate completion', async () => {
    const host = controller();
    await Promise.all([
      host.deliver(
        'task',
        event({
          data: png.toString('base64'),
          path: '/linux/missing.png',
          pathOrigin: 'remote-agent',
        }),
      ),
      host.deliver('task', event({ data: png.toString('base64') })),
    ]);
    await host.deliver('task', event({ data: png.toString('base64') }));
    expect(result()).toMatchObject({ ok: true, native_image_delivery: { id, state: 'stored' } });
    expect(result().text).toBe('Image delivered');
    expect(await fs.readFile(resolveSafe(result().xdt_image_url).absPath)).toEqual(png);
    expect(raw.prepare('SELECT * FROM messages').all()).toHaveLength(2);
    expect(raw.prepare('SELECT ref_kind FROM media_refs').all()).toEqual([
      { ref_kind: 'session-attachment' },
    ]);
    expect(host.invoke).not.toHaveBeenCalled();
  });

  // #6420: legacy controllers never send images/release, so they must not own durable source pins.
  it('delivers a source-only file to a legacy controller without retaining recovery ownership', async () => {
    const file = path.join(state.root, 'legacy-native.png');
    await fs.writeFile(file, png);
    const transported = await prepareTransport('remote:legacy-task', event({ path: file }), {
      retainForRecovery: false,
    });
    await fs.unlink(file);
    expect(transported.data).toMatchObject({
      url: `data:image/png;base64,${png.toString('base64')}`,
    });
    expect(transported.data).not.toHaveProperty('path');
    expect(await captureGeneratedImageStorage().journal.list('remote:legacy-task')).toEqual([]);
    expect(raw.prepare('SELECT * FROM media_refs').all()).toHaveLength(0);
    expect(raw.prepare('SELECT * FROM media_blobs').all()).toHaveLength(0);
  });

  it('recovers a source-only file after native file deletion and controller restart, then releases the source pin', async () => {
    const file = path.join(state.root, 'native.png');
    const large = Buffer.concat([png, Buffer.alloc(3_200_000)]);
    await fs.writeFile(file, large);
    const transported = await prepareTransport('remote:host-task', event({ path: file }));
    expect(transported.data).not.toHaveProperty('path');
    expect((transported.data as GeneratedImageEventData).url).toMatch(/^data:image\/png;base64,/);
    await fs.unlink(file);
    raw.exec("UPDATE sessions SET agent_device_id = 'source'");
    // The event was ACKed but never reached the controller's durable writer.
    const restarted = controller();
    await restarted.recover('task');
    expect(result().ok).toBe(true);
    expect((await fs.readFile(resolveSafe(result().xdt_image_url).absPath)).equals(large)).toBe(
      true,
    );
    expect(
      restarted.invoke.mock.calls.filter(
        (call) => (call[2][0] as { action?: string }).action === 'read',
      ).length,
    ).toBeGreaterThan(1);
    expect((await captureGeneratedImageStorage().journal.read('remote:host-task', id))?.state).toBe(
      'released',
    );
    expect(raw.prepare('SELECT ref_kind FROM media_refs').all()).toEqual([
      { ref_kind: 'session-attachment' },
    ]);
  });

  it('keeps paid bytes across a message-writer failure and retries the same artifact without source access', async () => {
    state.failResult = true;
    await expect(
      controller().deliver('task', event({ data: png.toString('base64') })),
    ).rejects.toThrow('disk unavailable');
    expect((await captureGeneratedImageStorage().journal.read('task:task', id))?.state).toBe(
      'failed',
    );
    state.failResult = false;
    const restarted = controller();
    await restarted.recover('task', id);
    expect(result().ok).toBe(true);
    expect(restarted.invoke).not.toHaveBeenCalled();
  });

  it('persists a delivery failure separately from native generation success without interpreting a remote path locally', async () => {
    const file = path.join(state.root, 'native.png');
    await fs.writeFile(file, png);
    const readSource = vi.fn(async () => ({ buffer: png, mimeType: 'image/png' }));
    const host = createGeneratedImageDelivery({ invoke: vi.fn(), publish: vi.fn(), readSource });
    await host.deliver('task', event({ path: file, pathOrigin: 'remote-agent' }));
    expect(readSource).not.toHaveBeenCalled();
    expect(result()).toMatchObject({
      ok: false,
      text: 'Image delivery failed. Retry transferring the existing image.',
      generation_status: 'completed',
      native_image_delivery: { state: 'failed', errorCode: 'REMOTE_SOURCE_REQUIRED' },
    });
    expect(raw.prepare('SELECT * FROM media_blobs').all()).toHaveLength(0);
  });

  it.each(['clear', 'delete', 'owner'])(
    'does not publish after %s during delivery',
    async (boundary) => {
      state.beforeResult = () => {
        if (boundary === 'owner') state.generation++;
        else
          raw.exec(
            boundary === 'clear'
              ? 'UPDATE sessions SET cleared_at = 10'
              : "UPDATE sessions SET status = 'deleted'",
          );
      };
      const host = controller();
      if (boundary === 'owner')
        await expect(host.deliver('task', event({ data: png.toString('base64') }))).rejects.toThrow(
          'SCOPE_CHANGED',
        );
      else await host.deliver('task', event({ data: png.toString('base64') }));
      expect(raw.prepare("SELECT * FROM messages WHERE role = 'tool_result'").all()).toHaveLength(
        0,
      );
      expect(host.publish).not.toHaveBeenCalled();
      expect(state.broadcast).not.toHaveBeenCalled();
      if (boundary !== 'owner')
        expect(raw.prepare('SELECT * FROM media_refs').all()).toHaveLength(0);
    },
  );

  it('keeps the generation origin when the task changes its SSH location before retry', async () => {
    raw.exec("UPDATE sessions SET remote_host_id = 'original-ssh', working_dir = '/original'");
    const readSource = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ buffer: png, mimeType: 'image/png' });
    const host = createGeneratedImageDelivery({ invoke: vi.fn(), publish: vi.fn(), readSource });
    await host.deliver('task', event({ path: '/original/image.png' }));
    const failedRow = raw
      .prepare("SELECT id, client_id AS clientId FROM messages WHERE role = 'tool_result'")
      .get() as { id: string; clientId: string };
    expect(result().native_image_delivery.state).toBe('failed');
    state.broadcast.mockClear();
    raw.exec("UPDATE sessions SET remote_host_id = NULL, working_dir = '/local'");
    await host.recover('task', id);
    expect(readSource.mock.calls.map((call) => call[2])).toEqual([
      { remoteHostId: 'original-ssh', workingDir: '/original' },
      { remoteHostId: 'original-ssh', workingDir: '/original' },
    ]);
    expect(result().ok).toBe(true);
    // #6420: maker:event alone leaves Mobile's persisted result unchanged. Reuse the row ID.
    const storedRow = state.broadcast.mock.lastCall?.[1];
    expect(storedRow).toBeDefined();
    expect(storedRow).toMatchObject({ id: failedRow.id, clientId: failedRow.clientId });
    expect(JSON.parse(storedRow.content)).toMatchObject({
      ok: true,
      xdt_image_url: result().xdt_image_url,
      native_image_delivery: { id, state: 'stored' },
    });
    expect(state.broadcast.mock.lastCall?.[2]).toBeDefined();
  });

  // PR #6420: upstream pins and unknown artifacts had no durable release path.
  it('retains a relay receipt while the member is offline, then releases only its upstream copy after restart', async () => {
    const source = await prepareTransport(
      'remote:member-task',
      event({ data: png.toString('base64') }),
    );
    const upstream = { agentDeviceId: 'member', sessionId: 'member-task', relay: 'r'.repeat(16) };
    let online = false;
    let relayCapable = false;
    const invoke = vi.fn(
      async (
        _device: string,
        _channel: string,
        args: unknown[],
        options?: { preSend?: () => void },
      ) => {
        options?.preSend?.();
        if (!online) throw new Error('offline');
        const request = args[0] as Parameters<typeof handleGeneratedImageArtifacts>[1];
        if (request.op !== 'images')
          return { ok: true, result: { imageRecoveryRelay: relayCapable } };
        expect(request).toMatchObject({
          sessionId: upstream.sessionId,
          relay: upstream.relay,
          action: 'release',
          imageId: id,
        });
        return { ok: true, result: await handleGeneratedImageArtifacts('member-task', request) };
      },
    );
    await prepareTransport('remote:relay-task', source, { upstream, invoke });
    expect(raw.prepare('SELECT * FROM media_refs').all()).toHaveLength(2);
    expect(
      (await captureGeneratedImageStorage().journal.read('remote:relay-task', id))
        ?.upstreamReleased,
    ).not.toBe(true);
    online = true;
    await createGeneratedImageDelivery({ invoke, publish: vi.fn() }).reconcile();
    expect(raw.prepare('SELECT * FROM media_refs').all()).toHaveLength(2);
    relayCapable = true;
    await createGeneratedImageDelivery({ invoke, publish: vi.fn() }).reconcile();
    expect(
      (await captureGeneratedImageStorage().journal.read('remote:member-task', id))?.state,
    ).toBe('released');
    const relay = (await captureGeneratedImageStorage().journal.read('remote:relay-task', id))!;
    expect(relay.upstreamReleased).toBe(true);
    expect((await captureGeneratedImageStorage().read(relay)).buffer).toEqual(png);
    expect(raw.prepare('SELECT * FROM media_refs').all()).toHaveLength(1);
  });

  it.each(['clear', 'delete'])(
    'releases unknown source artifacts after an offline %s and restart without publishing messages',
    async (boundary) => {
      await prepareTransport(
        'remote:host-task',
        event({ data: png.toString('base64'), deliveryEpoch: 0 }),
      );
      raw.exec("UPDATE sessions SET agent_device_id = 'source', cleared_at = 100");
      if (boundary === 'delete') raw.exec("UPDATE sessions SET status = 'deleted'");
      expect(await readGeneratedImageEpoch('task')).toBe(100);
      const offline = createGeneratedImageDelivery({
        invoke: vi.fn(async () => {
          throw new Error('offline');
        }),
        publish: vi.fn(),
      });
      await offline.cleanup('task');
      expect(await captureGeneratedImageStorage().journal.list('task:task')).toHaveLength(0);
      expect(await captureGeneratedImageStorage().journal.listCleanups()).toHaveLength(1);
      const newImage = { ...image, blockId: 'new-generation', deliveryEpoch: 100 };
      await prepareTransport(
        'remote:host-task',
        event({ ...newImage, data: png.toString('base64') }),
      );
      if (boundary === 'delete') raw.exec('DELETE FROM sessions'); // The receipt outlives task-row purging.
      const restarted = controller();
      await restarted.reconcile();
      expect(
        (await captureGeneratedImageStorage().journal.read('remote:host-task', id))?.state,
      ).toBe('released');
      const newer = await captureGeneratedImageStorage().journal.read(
        'remote:host-task',
        generatedImageId(newImage),
      );
      expect(newer?.state === 'released').toBe(boundary === 'delete');
      const remaining = raw.prepare('SELECT * FROM media_refs').all();
      expect(remaining).toHaveLength(boundary === 'clear' ? 1 : 0);
      expect(raw.prepare('SELECT * FROM messages').all()).toHaveLength(0);
      expect(restarted.publish).not.toHaveBeenCalled();
      expect(state.broadcast).not.toHaveBeenCalled();
      await restarted.deliver('task', event({ data: png.toString('base64'), deliveryEpoch: 0 }));
      expect(raw.prepare('SELECT * FROM messages').all()).toHaveLength(0);
    },
  );

  it('finds a cleared task with no local image or cleanup journal after a crash', async () => {
    await prepareTransport(
      'remote:host-task',
      event({ data: png.toString('base64'), deliveryEpoch: 0 }),
    );
    raw.exec("UPDATE sessions SET agent_device_id = 'source', cleared_at = 100");
    await controller().reconcile();
    expect(raw.prepare('SELECT * FROM media_refs').all()).toHaveLength(0);
    expect(raw.prepare('SELECT * FROM messages').all()).toHaveLength(0);
  });

  it('recovers an unknown image from the new clear generation without reviving the old generation', async () => {
    await prepareTransport(
      'remote:host-task',
      event({ data: png.toString('base64'), deliveryEpoch: 0 }),
    );
    raw.exec("UPDATE sessions SET agent_device_id = 'source', cleared_at = 100");
    const newer = { blockId: 'after-clear', data: png.toString('base64'), deliveryEpoch: 100 };
    await prepareTransport('remote:host-task', event(newer));
    await controller().recover('task');
    expect(result()).toMatchObject({
      ok: true,
      native_image_delivery: { id: generatedImageId({ ...image, ...newer }) },
    });
    expect(raw.prepare('SELECT * FROM messages').all()).toHaveLength(2);
    expect((await captureGeneratedImageStorage().journal.read('remote:host-task', id))?.state).toBe(
      'released',
    );
    expect(raw.prepare('SELECT ref_kind FROM media_refs').all()).toEqual([
      { ref_kind: 'session-attachment' },
    ]);
  });

  it.each(['message_tombstone', 'rewound'])(
    'recovers a later unknown image despite an unrelated %s row',
    async (removed) => {
      await prepareTransport('remote:host-task', event({ data: png.toString('base64') }));
      const removedImage = { ...image, blockId: 'removed-image' };
      await prepareTransport(
        'remote:host-task',
        event({ ...removedImage, data: png.toString('base64') }),
      );
      const removedId = generatedImageId(removedImage);
      const removedClientId = `codex-image-${removedId}-result`;
      raw.exec("UPDATE sessions SET agent_device_id = 'source'");
      raw
        .prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(
          removedClientId,
          'task',
          removedClientId,
          removed === 'rewound' ? 'assistant' : removed,
          '"old"',
          removed === 'rewound' ? 10 : null,
          1,
        );
      await controller().recover('task');
      expect(result().ok).toBe(true);
      expect(
        (await captureGeneratedImageStorage().journal.read('remote:host-task', id))?.state,
      ).toBe('released');
      expect(
        raw.prepare('SELECT role, rewind_at FROM messages WHERE id = ?').get(removedClientId),
      ).toMatchObject({
        role: removed === 'rewound' ? 'assistant' : removed,
        rewind_at: removed === 'rewound' ? 10 : null,
      });
      expect(
        (await captureGeneratedImageStorage().journal.read('remote:host-task', removedId))?.state,
      ).toBe('released');
      expect(
        await captureGeneratedImageStorage().journal.read('task:task', removedId),
      ).toMatchObject({ state: 'released' });
    },
  );

  // #6420: clearing while pin/lookup/INSERT is awaiting must not retain a hidden attachment.
  it.each(['pin', 'lookup', 'insert', 'restart', 'borrowed'] as const)(
    'compensates a clear racing attachment %s while preserving unrelated references',
    async (boundary) => {
      const pin = ledger.pinBlob,
        lookup = ledger.hasRef,
        add = ledger.addRef;
      let cleared = false;
      const clear = async (hash: string) => {
        if (cleared) return;
        cleared = true;
        const at = Date.now() + 1000;
        raw.prepare('UPDATE sessions SET cleared_at = ?').run(at);
        await add(
          {
            hash,
            refKind: 'session-attachment',
            refId: 'other-task',
            originSessionId: 'other-task',
          },
          captureGeneratedImageStorage().db,
        );
        if (boundary === 'borrowed')
          raw
            .prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, NULL, ?)')
            .run(
              'new-message',
              'task',
              'new-message',
              'assistant',
              JSON.stringify(`cindy-media://blobs/${hash}.png`),
              at + 1,
            );
      };
      vi.spyOn(ledger, 'pinBlob').mockImplementation(async (hash, db) => {
        await pin(hash, db);
        if (boundary === 'pin') await clear(hash);
      });
      vi.spyOn(ledger, 'hasRef').mockImplementation(async (params, db) => {
        const exists = await lookup(params, db);
        if (boundary === 'lookup' && params.refKind === 'session-attachment')
          await clear(params.hash);
        return exists;
      });
      vi.spyOn(ledger, 'addRef').mockImplementation(async (params, db) => {
        const added = await add(params, db);
        if (
          ['insert', 'restart', 'borrowed'].includes(boundary) &&
          params.refKind === 'session-attachment'
        )
          await clear(params.hash);
        return added;
      });
      const cleanup = vi.spyOn(ledger, 'removeSessionAttachmentRefIfUnreferencedByLiveMessage');
      if (boundary === 'restart') cleanup.mockRejectedValueOnce(new Error('cleanup unavailable'));
      const host = controller();
      const delivery = host.deliver('task', event({ data: png.toString('base64') }));
      if (boundary === 'restart') {
        await expect(delivery).rejects.toThrow('cleanup unavailable');
        const released = await captureGeneratedImageStorage().journal.read('task:task', id);
        expect(released).toMatchObject({
          state: 'released',
          blobUrl: expect.stringMatching(/^cindy-media:/),
        });
        await controller().reconcile();
      } else await delivery;
      expect(cleared).toBe(true);
      const refs = raw.prepare('SELECT ref_id FROM media_refs ORDER BY ref_id').all();
      expect(refs).toEqual(
        boundary === 'borrowed'
          ? [{ ref_id: 'other-task' }, { ref_id: 'task' }]
          : [{ ref_id: 'other-task' }],
      );
      expect(host.publish).not.toHaveBeenCalled();
      expect(state.broadcast).not.toHaveBeenCalled();
    },
  );

  it('does not resurrect a removed result during retry', async () => {
    const host = controller();
    await host.deliver('task', event({ pathOrigin: 'remote-agent' }));
    raw.exec("UPDATE messages SET role = 'message_tombstone' WHERE role = 'tool_result'");
    host.publish.mockClear();
    state.broadcast.mockClear();
    await host.recover('task', id);
    expect(host.publish).not.toHaveBeenCalled();
    expect(state.broadcast).not.toHaveBeenCalled();
    expect((await captureGeneratedImageStorage().journal.read('task:task', id))?.state).toBe(
      'released',
    );
  });
});
