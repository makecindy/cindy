import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type Envelope, type InvokeResultPayload, type LinkAcceptPayload } from '@cindy/device-link';
import { HeadlessConfigStore } from './config.js';
import { HeadlessControlService } from './control-service.js';
import { HeadlessDeviceLinkBridge, type HeadlessDeviceLinkClient } from './device-link-bridge.js';
import type { HeadlessSessionRuntime } from './session-runtime.js';
import { HeadlessSessionStorage } from './session-storage.js';
import { HeadlessOrcaService } from './orca-service.js';
import { HeadlessScheduleStorage } from './schedule-storage.js';
import { HeadlessSchedulerService } from './scheduler-service.js';
import { Scheduler } from '@cindy/maker-scheduler';
import { HeadlessGoalService } from './goal-service.js';
import { HeadlessHistoryService } from './history-service.js';
import { HeadlessMediaService } from './media-service.js';

const dirs: string[] = [];

class FakeDeviceLinkClient implements HeadlessDeviceLinkClient {
  private listener: ((frame: Envelope) => void) | null = null;
  readonly invokeResults: Array<{ dst: string; id: string; payload: InvokeResultPayload }> = [];
  readonly accepts: Array<{ dst: string; id: string; payload: LinkAcceptPayload }> = [];
  readonly pushes: Array<{ dst: string; channel: string; payload: unknown }> = [];

  onFrame(listener: (frame: Envelope) => void): () => void {
    this.listener = listener;
    return () => { this.listener = null; };
  }
  sendInvokeResult(dst: string, id: string, payload: InvokeResultPayload): void { this.invokeResults.push({ dst, id, payload }); }
  sendLinkAccept(dst: string, id: string, payload: LinkAcceptPayload): void { this.accepts.push({ dst, id, payload }); }
  sendPush(dst: string, channel: string, payload: unknown): void { this.pushes.push({ dst, channel, payload }); }
  emit(frame: Envelope): void { this.listener?.(frame); }
}

function invoke(src: string, id: string, channel: string, args: unknown[]): Envelope {
  return { v: PROTOCOL_VERSION, kind: 'invoke', id, src, payload: { channel, args } } as Envelope;
}

function fixture(options: { isWorkdirAllowed?: (workdir: string) => Promise<boolean>; media?: HeadlessMediaService } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-link-'));
  dirs.push(dir);
  const storage = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
  const sent: string[] = [];
  const steered: string[] = [];
  const runtime: HeadlessSessionRuntime = {
      send: async (_session, content) => { sent.push(typeof content === 'string' ? content : JSON.stringify(content)); },
      steer: async (_session, content) => { steered.push(typeof content === 'string' ? content : JSON.stringify(content)); },
      abort: async () => undefined,
      closeSession: async () => undefined,
      resolveInteraction: async () => false,
      reconfigure: async () => undefined,
      setOrcaRole: async () => undefined,
      listAgentCommands: (agentKind) => [{ kind: 'agent-builtin', name: agentKind === 'claude-code' ? 'compact' : 'status', description: 'built in' }],
      listAgentSkills: async (_agentKind, options) => ({ skills: [{ kind: 'agent-skill', name: 'deploy', source: 'skill', path: `${options.workingDir}/SKILL.md` }] }),
      scanAtResources: async (_agentKind, options) => ({ items: [{ type: 'file', name: 'README.md', relPath: 'README.md', description: options.query }] }),
      forkNativeSession: async () => ({ newSdkSessionId: 'fork-thread', uuidMap: new Map() }),
      previewNativeRewind: async () => ({ canRewind: true, filesChanged: [], insertions: 0, deletions: 0 }),
      commitNativeRewind: async () => undefined,
      isSessionBusy: () => false,
      isAnySessionBusy: () => false,
      close: async () => undefined,
  };
  const orca = new HeadlessOrcaService(path.join(dir, 'sessions.db'), storage, runtime);
  const config = new HeadlessConfigStore(path.join(dir, 'config.json'));
  const scheduleStorage = new HeadlessScheduleStorage(path.join(dir, 'sessions.db'));
  const scheduler = new HeadlessSchedulerService(new Scheduler({
    storage: scheduleStorage,
    runner: { fire: async () => ({ sessionId: 'scheduled-session', resultText: 'done' }) },
  }), scheduleStorage);
  const control = new HeadlessControlService(storage, config, runtime, undefined, undefined, undefined, undefined, undefined, scheduler, orca);
  const goal = new HeadlessGoalService(path.join(dir, 'sessions.db'), storage, runtime);
  control.setGoalService(goal);
  control.setHistoryService(new HeadlessHistoryService(storage, runtime));
  const client = new FakeDeviceLinkClient();
  const bridge = new HeadlessDeviceLinkBridge({
    client, control, storage,
    remoteControlEnabled: async () => true,
    isWorkdirAllowed: options.isWorkdirAllowed,
    appVersion: 'test-version',
    ...(options.media ? { media: options.media } : {}),
  });
  bridge.start();
  return { storage, config, sent, steered, client, bridge, orca, scheduler, scheduleStorage, goal };
}

afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('HeadlessDeviceLinkBridge', () => {
  it('serves a stable headless media reference through the shared media fetch channel', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-link-media-'));
    dirs.push(dir);
    const media = new HeadlessMediaService(path.join(dir, 'blobs'), {
      deviceLinkApiBase: () => 'https://relay.example.test',
      getAccessToken: async () => 'token',
      fetch: async (input) => String(input).endsWith('/presign-put')
        ? Response.json({ putUrl: 'https://oss.example.test/object', key: 'cindy/device-link/u/photo.png' })
        : new Response(null, { status: 200 }),
    });
    const image = await media.ingestBytes(Buffer.from([1, 2]), 'image/png');
    const { client } = fixture({ media });
    client.emit(invoke('phone-a', 'image', 'device-link:media:fetch', [{ url: image.url }]));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'image')).toBe(true));
    expect(client.invokeResults.find((item) => item.id === 'image')).toMatchObject({
      payload: { ok: true, result: { ossKey: 'cindy/device-link/u/photo.png', mimeType: 'image/png', size: 2 } },
    });
  });

  it('accepts direct writes from multiple linked clients using legacy Device Link semantics', async () => {
    const { client, storage, sent } = fixture();
    await storage.create({ id: 's1', agentKind: 'codex', workDir: '/srv/a', title: 'A', model: 'gpt-5.6' });
    client.emit(invoke('phone-a', 'view', 'device-link:subscribe', [{ topics: ['session:s1'], controllerName: 'Phone' }]));
    client.emit(invoke('phone-a', 'send', 'maker:send', ['s1', 'hello']));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'send')).toBe(true));
    expect(sent).toEqual(['hello']);

    client.emit(invoke('mac-a', 'readonly', 'maker:send', ['s1', 'from mac']));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'readonly')).toBe(true));
    expect(client.invokeResults.find((item) => item.id === 'readonly')).toMatchObject({
      payload: { ok: true, result: { accepted: true } },
    });
    expect(sent).toEqual(['hello', 'from mac']);
  });

  it('returns durable session spend and context usage to mobile after a host restart', async () => {
    const { client, storage } = fixture();
    await storage.create({ id: 's1', agentKind: 'codex', workDir: '/srv/a', title: 'A', model: 'gpt-5.6' });
    await storage.appendEvent('s1', 'agent_event', {
      type: 'status',
      data: { contextTokens: 12_500, contextWindow: 200_000, tokenUsage: 0, isRunning: false },
      source: 'codex',
    });
    await storage.appendEvent('s1', 'agent_event', {
      type: 'done',
      data: { usage: { promptTokens: 800, completionTokens: 120, reasoningTokens: 40, cachedTokens: 500 } },
      source: 'codex',
    });

    client.emit(invoke('phone-a', 'session', 'local-db:sessions:get', ['s1']));
    client.emit(invoke('phone-a', 'context', 'maker:get-context-usage', ['s1', { agentKind: 'codex' }]));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'context')).toBe(true));

    expect(client.invokeResults.find((item) => item.id === 'session')).toMatchObject({
      payload: { ok: true, result: { contextTokens: 12_500, contextWindow: 200_000, totalTokenUsage: 1_460 } },
    });
    expect(client.invokeResults.find((item) => item.id === 'context')).toMatchObject({
      payload: { ok: true, result: { totalTokens: 12_500, rawMaxTokens: 200_000, percentage: 0.0625, totalTokenUsage: 1_460 } },
    });
  });

  it('persists an error-tail dismissal so mobile does not see the error again after reload', async () => {
    const { client, storage } = fixture();
    await storage.create({ id: 's1', agentKind: 'codex', workDir: '/srv/a', title: 'A', model: 'gpt-5.6' });
    await storage.appendEvent('s1', 'agent_event', {
      type: 'error', data: { message: 'temporary failure', isTerminal: true }, source: 'codex',
    });
    client.emit(invoke('phone-a', 'dismiss', 'local-db:messages:dismiss-error', ['s1', 'headless-event-1']));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'dismiss')).toBe(true));
    expect(client.invokeResults.find((item) => item.id === 'dismiss')).toMatchObject({ payload: { ok: true, result: { dismissed: true } } });

    client.emit(invoke('phone-a', 'messages', 'local-db:messages:list', ['s1', {}]));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'messages')).toBe(true));
    expect(client.invokeResults.find((item) => item.id === 'messages')).toMatchObject({ payload: { ok: true, result: [] } });
  });

  it('records an interrupted-turn acknowledgement from mobile', async () => {
    const { client, storage } = fixture();
    await storage.create({ id: 's1', agentKind: 'codex', workDir: '/srv/a', title: 'A', model: 'gpt-5.6' });
    client.emit(invoke('phone-a', 'ack', 'local-db:sessions:ack-interrupted', ['s1']));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'ack')).toBe(true));
    expect(client.invokeResults.find((item) => item.id === 'ack')).toMatchObject({ payload: { ok: true, result: { acknowledged: true } } });
    await expect(storage.listEvents('s1', 0, 10)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'session_interrupted_acknowledged' }),
    ]));
  });

  it('persists mobile-selected extra directories for a Claude session', async () => {
    const { client, config, storage } = fixture();
    await config.write({ ...await config.read(), workdirRoots: ['/tmp'] });
    await storage.create({ id: 's1', agentKind: 'claude-code', workDir: '/tmp', title: 'A', model: 'claude-test' });
    client.emit(invoke('phone-a', 'extra', 'maker:set-extra-dirs', ['s1', ['/tmp', '/tmp']]));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'extra')).toBe(true));
    expect(client.invokeResults.find((item) => item.id === 'extra')).toMatchObject({ payload: { ok: true } });
    await expect(storage.get('s1')).resolves.toMatchObject({ extraDirs: ['/tmp'] });
  });

  it('uses the existing allowlist and sends the shared allowlist fingerprint in link accept', async () => {
    const { client } = fixture();
    client.emit({
      v: PROTOCOL_VERSION, kind: 'link-open', id: 'open-1', src: 'phone-a',
      payload: { controllerName: 'My phone', protocolVersion: PROTOCOL_VERSION, appVersion: 'mobile' },
    } as Envelope);
    await tick();
    expect(client.accepts).toEqual([expect.objectContaining({
      dst: 'phone-a', id: 'open-1', payload: expect.objectContaining({ appVersion: 'test-version', allowlistHash: expect.any(String) }),
    })]);

    client.emit(invoke('phone-a', 'blocked', 'config.set', [{}]));
    await tick();
    expect(client.invokeResults.at(-1)).toMatchObject({
      id: 'blocked', payload: { ok: false, error: { code: 'CHANNEL_NOT_ALLOWED' } },
    });
  });

  it('fans persisted events out only to controllers subscribed to the matching session topic', async () => {
    const { client, storage } = fixture();
    client.emit(invoke('phone-a', 'sub-a', 'device-link:subscribe', [{ topics: ['session:s1'] }]));
    client.emit(invoke('phone-b', 'sub-b', 'device-link:subscribe', [{ topics: ['session:s2'] }]));
    await tick();
    await storage.create({ id: 's1', agentKind: 'codex', workDir: '/srv/a', title: 'A', model: 'gpt-5.6' });
    await storage.appendEvent('s1', 'agent_event', {
      type: 'text', data: { text: 'hello', isFinal: true },
    });
    expect(client.pushes).toEqual([
      expect.objectContaining({
        dst: 'phone-a', channel: 'maker:event', payload: {
          sessionId: 's1', event: { type: 'text', data: { text: 'hello', isFinal: true } }, persistId: 'headless-event-1',
        },
      }),
      expect.objectContaining({
        dst: 'phone-a', channel: 'local-db:messages:created', payload: {
          sessionId: 's1', message: expect.objectContaining({ id: 'headless-event-1', role: 'assistant', content: 'hello' }),
        },
      }),
    ]);
  });

  it('accepts mobile input while a terminal has already queued input for the same session', async () => {
    const { client, storage, sent } = fixture();
    await storage.create({ id: 's1', agentKind: 'codex', workDir: '/srv/a', title: 'A', model: 'gpt-5.6' });
    await storage.appendEvent('s1', 'user_message', { content: 'terminal input' });
    client.emit(invoke('phone-a', 'send-ok', 'maker:send', ['s1', 'hello']));
    await tick();
    expect(client.invokeResults.at(-1)).toMatchObject({ id: 'send-ok', payload: { ok: true, result: { accepted: true } } });
    expect(sent).toEqual(['hello']);
  });

  it('preserves a mobile user message client ID in its echoed message', async () => {
    const { client, storage } = fixture();
    await storage.create({ id: 's1', agentKind: 'codex', workDir: '/srv/a', title: 'A', model: 'gpt-5.6' });
    client.emit(invoke('phone-a', 'sub-a', 'device-link:subscribe', [{ topics: ['session:s1'] }]));
    await tick();
    await storage.appendEvent('s1', 'user_message', { content: 'from phone', clientId: 'phone-message-1' });
    expect(client.pushes.at(-1)).toMatchObject({
      dst: 'phone-a', channel: 'local-db:messages:created', payload: {
        sessionId: 's1', message: { id: 'phone-message-1', clientId: 'phone-message-1', role: 'user', content: 'from phone' },
      },
    });
  });

  it('adapts mobile input projections and normalizes structured text history', async () => {
    const { client, storage, sent } = fixture();
    await storage.create({ id: 's1', agentKind: 'codex', workDir: '/srv/a', title: 'A', model: 'gpt-5.6' });
    await storage.appendEvent('s1', 'agent_event', {
      type: 'text', data: { text: 'Linux reply', isFinal: true }, source: 'codex',
    });
    await storage.appendEvent('s1', 'agent_event', {
      type: 'status', data: { status: 'Generating...', isRunning: true }, source: 'codex',
    });
    await storage.appendEvent('s1', 'agent_event', {
      type: 'done', data: { type: 'codex/event/task_complete' }, source: 'codex',
    });
    await storage.appendEvent('s1', 'agent_event', {
      type: 'account_usage', data: { limitId: 'codex' }, source: 'codex',
    });

    client.emit(invoke('phone-a', 'projection', 'maker:input:get-projection', ['s1']));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'projection')).toBe(true));
    expect(client.invokeResults.at(-1)).toMatchObject({
      payload: { ok: true, result: { sessionId: 's1', pendingQueue: [], error: null } },
    });

    client.emit(invoke('phone-a', 'enqueue', 'maker:input:enqueue', ['s1', {
      clientId: 'phone-message', text: 'Sent from phone', persistedContent: '{"text":"Sent from phone"}',
      chatMessage: { content: 'Sent from phone' }, createOpts: { agentKind: 'codex' },
    }]));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'enqueue')).toBe(true));
    expect(sent).toEqual(['Sent from phone']);

    client.emit(invoke('phone-a', 'history', 'local-db:messages:list', ['s1']));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'history')).toBe(true));
    expect(client.invokeResults.at(-1)).toMatchObject({
      payload: { ok: true, result: [expect.objectContaining({ role: 'assistant', content: 'Linux reply' })] },
    });
    const history = client.invokeResults.at(-1)?.payload;
    expect(history).toMatchObject({ ok: true });
    expect((history as { result: Array<{ role: string }> }).result.map((message) => message.role))
      .toEqual(['assistant']);
  });

  it('matches Desktop history paging and anchor lookup semantics for a remote phone', async () => {
    const { client, storage } = fixture();
    await storage.create({ id: 's1', agentKind: 'codex', workDir: '/srv/a', title: 'A', model: 'gpt-5.6' });
    await storage.appendEvent('s1', 'user_message', { content: 'first' });
    await storage.appendEvent('s1', 'agent_event', { type: 'text', data: { text: 'second' } });
    await storage.appendEvent('s1', 'agent_event', { type: 'text', data: { text: 'third' } });

    client.emit(invoke('phone-a', 'page', 'local-db:messages:list', ['s1', { limit: 2 }]));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'page')).toBe(true));
    expect(client.invokeResults.find((item) => item.id === 'page')).toMatchObject({
      payload: { ok: true, result: [
        { id: 'headless-event-3', content: 'third' },
        { id: 'headless-event-2', content: 'second' },
      ] },
    });

    client.emit(invoke('phone-a', 'around', 'local-db:messages:around-client-id', ['s1', 'headless-event-2', { radius: 1 }]));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'around')).toBe(true));
    expect(client.invokeResults.find((item) => item.id === 'around')).toMatchObject({
      payload: { ok: true, result: [
        { id: 'headless-event-1', content: 'first' },
        { id: 'headless-event-2', content: 'second' },
        { id: 'headless-event-3', content: 'third' },
      ] },
    });

    client.emit(invoke('phone-a', 'title', 'maker:regenerate-title', [{ sessionId: 's1' }]));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'title')).toBe(true));
    expect(client.invokeResults.find((item) => item.id === 'title')).toMatchObject({
      payload: { ok: true, result: { title: 'first' } },
    });
  });

  it('routes message deletion, fork, and rewind through the structured Linux history host', async () => {
    const { client, storage } = fixture();
    await storage.create({ id: 's1', agentKind: 'codex', workDir: '/srv/a', title: 'A', model: 'gpt-5.6', sdkSessionId: 'thread-1' });
    await storage.appendEvent('s1', 'user_message', { clientId: 'u1', content: 'first' });
    await storage.appendEvent('s1', 'agent_event', { type: 'text', data: { text: 'answer', isFinal: true } });
    await storage.appendEvent('s1', 'user_message', { clientId: 'u2', content: 'second' });
    await storage.appendEvent('s1', 'agent_event', { type: 'text', data: { text: 'answer two', isFinal: true } });

    client.emit(invoke('phone-a', 'sub', 'device-link:subscribe', [{ topics: ['session:s1'] }]));
    client.emit(invoke('phone-a', 'preview', 'maker:rewind:preview', ['s1', 'u2']));
    client.emit(invoke('phone-a', 'fork', 'maker:fork', ['s1', 'headless-event-2']));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'fork')).toBe(true));
    expect(client.invokeResults.find((item) => item.id === 'preview')).toMatchObject({ payload: { ok: true, result: { canRewind: true } } });
    expect(client.invokeResults.find((item) => item.id === 'fork')).toMatchObject({ payload: { ok: true, result: { title: '[Fork] A' } } });

    client.emit(invoke('phone-a', 'rewind', 'maker:rewind:commit', ['s1', 'u2']));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'rewind')).toBe(true));
    expect(client.invokeResults.find((item) => item.id === 'rewind')).toMatchObject({ payload: { ok: true } });
    expect(client.pushes.some((push) => push.channel === 'local-db:messages:deleted' && (push.payload as { sessionId?: string }).sessionId === 's1')).toBe(true);
  });

  it('claims an unowned session for remote archive metadata and excludes it from the active list', async () => {
    const { client, storage } = fixture();
    await storage.create({ id: 's1', agentKind: 'codex', workDir: '/srv/a', title: 'Archive me', model: 'gpt-5.6' });
    client.emit(invoke('phone-a', 'sub-sessions', 'device-link:subscribe', [{ topics: ['sessions'] }]));
    await tick();

    client.emit(invoke('phone-a', 'archive', 'local-db:sessions:patch-meta', ['s1', {
      status: 'archived', pinnedAt: null,
    }]));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'archive')).toBe(true));
    expect(client.invokeResults.at(-1)).toMatchObject({
      payload: { ok: true, result: { id: 's1', status: 'archived', pinnedAt: null } },
    });
    await expect(storage.get('s1')).resolves.toMatchObject({ status: 'archived', pinnedAt: null });
    expect(client.pushes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        dst: 'phone-a', channel: 'local-db:sessions:patched',
        payload: { sessionId: 's1', patch: { status: 'archived', pinnedAt: null } },
      }),
    ]));

    client.emit(invoke('phone-a', 'active', 'local-db:sessions:list', [20, 'active']));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'active')).toBe(true));
    expect(client.invokeResults.at(-1)).toMatchObject({ payload: { ok: true, result: [] } });

    client.emit(invoke('phone-a', 'archived', 'local-db:sessions:list', [20, 'archived']));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'archived')).toBe(true));
    expect(client.invokeResults.at(-1)).toMatchObject({
      payload: { ok: true, result: [expect.objectContaining({ id: 's1', status: 'archived' })] },
    });
  });

  it('reports the actual runtime directory for a dialogue session without a project', async () => {
    const { client, storage } = fixture();
    await storage.create({ id: 'dialogue', agentKind: 'codex', workDir: '', workspaceKind: 'dialogue', title: 'Chat', model: 'gpt-5.6' });

    client.emit(invoke('phone-a', 'dialogue-get', 'local-db:sessions:get', ['dialogue']));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'dialogue-get')).toBe(true));
    expect(client.invokeResults.find((item) => item.id === 'dialogue-get')).toMatchObject({
      payload: { ok: true, result: { workingDir: process.env.HOME } },
    });
  });

  it('reports visible message activity so project sessions are not treated as empty drafts', async () => {
    const { client, storage } = fixture();
    await storage.create({
      id: 'loveping', agentKind: 'codex', workDir: '/home/admin/project/loveping',
      workspaceKind: 'project', title: 'Review loveping', model: 'gpt-5.6',
    });
    await storage.appendEvent('loveping', 'user_message', { clientId: 'user-1', content: '看下这个项目' });
    await storage.appendEvent('loveping', 'agent_event', {
      type: 'text', data: { text: '好的', isFinal: true }, source: 'codex',
    });

    client.emit(invoke('mac-a', 'projects', 'local-db:sessions:list', [20, 'active']));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'projects')).toBe(true));

    expect(client.invokeResults.find((item) => item.id === 'projects')).toMatchObject({
      payload: {
        ok: true,
        result: [expect.objectContaining({
          id: 'loveping',
          workingDir: '/home/admin/project/loveping',
          workspaceKind: 'project',
          userSendAt: expect.any(String),
          _count: { messages: 2 },
        })],
      },
    });
  });

  it('does not let a phone select a project outside the host workdir allowlist', async () => {
    const { client } = fixture({ isWorkdirAllowed: async () => false });
    client.emit(invoke('phone-a', 'create-denied', 'maker:create-session', [{
      agentKind: 'codex', model: 'gpt-5.6', workingDir: '/etc',
    }]));
    await tick();
    expect(client.invokeResults.at(-1)).toMatchObject({
      id: 'create-denied', payload: { ok: false, error: { message: expect.stringContaining('allowed remote project root') } },
    });
  });

  it('lets a mobile controller update model controls only while the session is idle', async () => {
    const { client, storage } = fixture();
    await storage.create({ id: 's1', agentKind: 'codex', workDir: '/srv/a', title: 'A', model: 'gpt-5.6', effort: 'high', permissionMode: 'ask' });
    client.emit(invoke('phone-a', 'set-effort', 'maker:set-effort', ['s1', 'low']));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'set-effort')).toBe(true));
    expect(client.invokeResults.at(-1)).toMatchObject({ id: 'set-effort', payload: { ok: true, result: { effort: 'low' } } });

    client.emit(invoke('phone-a', 'set-fast', 'maker:set-fast-mode', ['s1', true]));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'set-fast')).toBe(true));
    expect(client.invokeResults.at(-1)).toMatchObject({ id: 'set-fast', payload: { ok: true, result: { fastMode: true } } });
  });

  it('routes a mobile steer through the shared session runtime', async () => {
    const { client, storage, steered } = fixture();
    await storage.create({ id: 's1', agentKind: 'codex', workDir: '/srv/a', title: 'A', model: 'gpt-5.6' });
    client.emit(invoke('phone-a', 'steer', 'maker:steer', ['s1', 'change direction']));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'steer')).toBe(true));
    expect(client.invokeResults.at(-1)).toMatchObject({ id: 'steer', payload: { ok: true, result: { steered: true } } });
    expect(steered).toEqual(['change direction']);
  });

  it('lists host agent palette commands, skills, and @ resources inside allowed roots', async () => {
    const { client, config } = fixture();
    await config.write({ ...await config.read(), workdirRoots: ['/tmp'] });
    client.emit(invoke('phone-a', 'commands', 'maker:list-agent-commands', ['codex']));
    client.emit(invoke('phone-a', 'skills', 'maker:list-agent-skills', ['codex', { workingDir: '/tmp' }]));
    client.emit(invoke('phone-a', 'resources', 'maker:scan-at-resources', ['codex', { workingDir: '/tmp', cap: 30, query: 'read' }]));
    await vi.waitFor(() => expect(client.invokeResults.filter((item) => ['commands', 'skills', 'resources'].includes(item.id))).toHaveLength(3));
    expect(client.invokeResults.find((item) => item.id === 'commands')).toMatchObject({
      payload: { ok: true, result: { success: true, commands: [expect.objectContaining({ name: 'status' })] } },
    });
    expect(client.invokeResults.find((item) => item.id === 'skills')).toMatchObject({
      payload: { ok: true, result: { success: true, skills: [expect.objectContaining({ name: 'deploy' })] } },
    });
    expect(client.invokeResults.find((item) => item.id === 'resources')).toMatchObject({
      payload: { ok: true, result: { success: true, items: [expect.objectContaining({ name: 'README.md', description: 'read' })] } },
    });
  });

  it('returns headless-compatible account, switch, attention, and project-automation responses', async () => {
    const { client, storage, config, scheduler } = fixture();
    await storage.create({ id: 's1', agentKind: 'codex', workDir: '/tmp', title: 'A', model: 'gpt-5.6' });
    await config.write({ ...await config.read(), workdirRoots: ['/tmp'] });
    const schedule = await scheduler.create({
      name: 'project task', prompt: 'check', kind: 'cron', cronExpr: '0 * * * *', timezone: 'UTC', recurring: true,
      agentKind: 'codex', model: 'gpt-5.6', workingDir: '/tmp', useWorktree: false, notify: { desktop: false, feishu: false },
    }) as { id: string };

    client.emit(invoke('phone-a', 'intent', 'maker:get-session-agent-switch-intent', ['s1']));
    client.emit(invoke('phone-a', 'api-key', 'maker:api-key:present', []));
    client.emit(invoke('phone-a', 'pricing', 'maker:usage:model-pricing', []));
    client.emit(invoke('phone-a', 'attention', 'notification:clear-session-attention', ['s1']));
    client.emit(invoke('phone-a', 'remove-project-schedule', 'maker:project-automation:remove-schedule', [{ workingDir: '/tmp', id: schedule.id }]));
    await vi.waitFor(() => expect(client.invokeResults.filter((item) => ['intent', 'api-key', 'pricing', 'attention', 'remove-project-schedule'].includes(item.id))).toHaveLength(5));
    expect(client.invokeResults.find((item) => item.id === 'intent')).toMatchObject({ payload: { ok: true, result: null } });
    expect(client.invokeResults.find((item) => item.id === 'api-key')).toMatchObject({ payload: { ok: true, result: { present: false } } });
    expect(client.invokeResults.find((item) => item.id === 'pricing')).toMatchObject({ payload: { ok: true, result: null } });
    expect(client.invokeResults.find((item) => item.id === 'attention')).toMatchObject({ payload: { ok: true, result: { cleared: true } } });
    expect(client.invokeResults.find((item) => item.id === 'remove-project-schedule')).toMatchObject({ payload: { ok: true } });
    await expect(scheduler.get(schedule.id)).resolves.toBeNull();
  });

  it('persists model-specific effort and fast preferences for session and draft selection', async () => {
    const { client, storage, config } = fixture();
    await storage.create({ id: 's1', agentKind: 'codex', workDir: '/tmp', title: 'A', model: 'gpt-5.6', effort: 'low', fastMode: false });
    client.emit(invoke('phone-a', 'session-pref', 'maker:set-session-model-pref', [{
      sessionId: 's1', agent: 'codex', providerId: null, model: 'gpt-5.6', effort: 'high', fast: true,
    }]));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'session-pref')).toBe(true));
    client.emit(invoke('phone-a', 'select-model', 'maker:set-model', ['s1', 'gpt-5.6']));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'select-model')).toBe(true));
    await expect(storage.get('s1')).resolves.toMatchObject({ effort: 'high', fastMode: true });

    client.emit(invoke('phone-a', 'draft-pref', 'maker:apply-new-maker-draft-pref', [{
      agent: 'codex', providerId: null, modelId: 'gpt-5.6', effort: 'medium', fast: false, active: true,
    }]));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'draft-pref')).toBe(true));
    await expect(config.read()).resolves.toMatchObject({
      defaults: { agentKind: 'codex', providerId: null, model: 'gpt-5.6', effort: 'medium' },
      modelPreferences: { [JSON.stringify(['codex', null, 'gpt-5.6'])]: { effort: 'medium', fastMode: false } },
    });
  });

  it('routes all six Goal controls through the Linux goal host', async () => {
    const { client, storage } = fixture();
    await storage.create({ id: 's1', agentKind: 'codex', workDir: '/tmp', title: 'Goal', model: 'gpt-5.6' });
    client.emit(invoke('phone-a', 'goal-set', 'maker:goal:set', [{
      sessionId: 's1', objective: 'finish tests', limits: { maxTurns: null, budgetTokens: null, noProgressLimit: null },
    }]));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'goal-set')).toBe(true));
    expect(client.invokeResults.find((item) => item.id === 'goal-set')).toMatchObject({ payload: { ok: true, result: { ok: true } } });

    client.emit(invoke('phone-a', 'goal-status', 'maker:goal:get-status', ['s1']));
    client.emit(invoke('phone-a', 'goal-update', 'maker:goal:update', [{ sessionId: 's1', patch: { objective: 'finish all tests', maxTurns: 3 } }]));
    await vi.waitFor(() => expect(client.invokeResults.filter((item) => ['goal-status', 'goal-update'].includes(item.id))).toHaveLength(2));
    expect(client.invokeResults.find((item) => item.id === 'goal-status')).toMatchObject({ payload: { ok: true, result: { status: 'active', objective: 'finish tests' } } });

    client.emit(invoke('phone-a', 'goal-pause', 'maker:goal:pause', ['s1']));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'goal-pause')).toBe(true));
    client.emit(invoke('phone-a', 'goal-resume', 'maker:goal:resume', ['s1']));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'goal-resume')).toBe(true));
    client.emit(invoke('phone-a', 'goal-clear', 'maker:goal:clear', ['s1']));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'goal-clear')).toBe(true));
    client.emit(invoke('phone-a', 'goal-empty', 'maker:goal:get-status', ['s1']));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'goal-empty')).toBe(true));
    expect(client.invokeResults.find((item) => item.id === 'goal-empty')).toMatchObject({ payload: { ok: true, result: null } });
  });

  it('exposes shared automation templates, creation, runtime counts, and durable read markers', async () => {
    const { client, scheduler, scheduleStorage } = fixture();
    client.emit(invoke('phone-a', 'templates', 'maker:schedule:list-templates', []));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'templates')).toBe(true));
    expect(client.invokeResults.find((item) => item.id === 'templates')).toMatchObject({
      payload: { ok: true, result: expect.arrayContaining([expect.objectContaining({ id: 'domain-radar' })]) },
    });

    client.emit(invoke('phone-a', 'create-template', 'maker:schedule:create-from-template', [{
      templateId: 'domain-radar', paramValues: { topic: 'Linux' }, overrides: {
        agentKind: 'codex', model: 'gpt-5.6', name: 'Linux radar', workingDir: '/srv/a',
      },
    }]));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'create-template')).toBe(true));
    const created = client.invokeResults.find((item) => item.id === 'create-template')?.payload;
    expect(created).toMatchObject({ ok: true, result: { name: 'Linux radar', prompt: expect.stringContaining('Linux') } });
    const scheduleId = (created as { result: { id: string } }).result.id;

    client.emit(invoke('phone-a', 'inflight', 'maker:schedule:get-inflight-count', [scheduleId]));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'inflight')).toBe(true));
    expect(client.invokeResults.find((item) => item.id === 'inflight')).toMatchObject({ payload: { ok: true, result: 0 } });

    await scheduleStorage.insertRun({ id: 'read-me', scheduleId, firedAt: Date.now(), status: 'success' });
    client.emit(invoke('phone-a', 'mark-read', 'maker:schedule:mark-run-read', ['read-me']));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'mark-read')).toBe(true));
    await expect(scheduleStorage.listRuns(scheduleId)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'read-me', readAt: expect.any(Number) }),
    ]));
    await scheduleStorage.insertRun({ id: 'read-all', scheduleId, firedAt: Date.now() + 1, status: 'success' });
    client.emit(invoke('phone-a', 'mark-all-read', 'maker:schedule:mark-schedule-runs-read', [scheduleId]));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'mark-all-read')).toBe(true));
    expect(client.invokeResults.find((item) => item.id === 'mark-all-read')).toMatchObject({ payload: { ok: true, result: 1 } });
    await expect(scheduleStorage.listRuns(scheduleId)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'read-all', readAt: expect.any(Number) }),
    ]));
    expect(await scheduler.get(scheduleId)).toMatchObject({ name: 'Linux radar' });
  });

  it('adapts existing Orca allowlist channels through the shared session control surface', async () => {
    const { client, storage } = fixture();
    await storage.create({ id: 'lead', agentKind: 'codex', workDir: '/srv/a', title: 'Lead', model: 'gpt-5.6' });
    client.emit(invoke('phone-a', 'orca-start', 'maker:session:enable-orca', ['lead']));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'orca-start')).toBe(true));
    expect(client.invokeResults.at(-1)).toMatchObject({ payload: { ok: true, result: { leadSessionId: 'lead', status: 'active' } } });

    client.emit(invoke('phone-a', 'orca-create', 'maker:worker:create', [{ sessionId: 'lead', label: 'api', role: 'developer' }]));
    await vi.waitFor(() => expect(client.invokeResults.some((item) => item.id === 'orca-create')).toBe(true));
    expect(client.invokeResults.at(-1)).toMatchObject({ payload: { ok: true, result: { label: 'api', role: 'developer' } } });
  });
});

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
