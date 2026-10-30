import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { sharedTaskHostPeer } from '@cindy/device-link';
import { buildGhostToolsJson, expandGhostCommand } from '@cindy/maker-shared/ghost-command';
import { createMobileMakerTransport, type RemoteInvoke } from '@/device-link/mobileMakerTransport';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import type { QueuedRemoteMessage } from '@/session/types';
import type { DurableOutboxRecord } from '@/session/durableOutbox';

const bridgeSource = ts.createSourceFile('MobileOutboxBridge.tsx', readFileSync(resolve(
  process.cwd(), 'src/session/MobileOutboxBridge.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let enqueueSource = '';
function findOutboxEnqueue(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(bridgeSource) === 'createDurableOutboxDelivery') {
    const options = node.arguments[0];
    if (ts.isObjectLiteralExpression(options)) {
      const enqueue = options.properties.find((property) => property.name?.getText(bridgeSource) === 'enqueue');
      if (enqueue && ts.isPropertyAssignment(enqueue)) enqueueSource = enqueue.initializer.getText(bridgeSource);
    }
  }
  ts.forEachChild(node, findOutboxEnqueue);
}
findOutboxEnqueue(bridgeSource);
if (!enqueueSource) throw new Error('Missing durable outbox enqueue callback');

function outboxSender(invokeOwned: (record: DurableOutboxRecord) => RemoteInvoke) {
  const maker = (record: DurableOutboxRecord) => createMobileMakerTransport({
    deviceId: record.deviceId, invoke: invokeOwned(record),
  });
  const compiled = ts.transpileModule(`function create(maker, invokeOwned) { return ${enqueueSource}; }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(`${compiled}; return create;`)()(maker, invokeOwned) as
    (record: DurableOutboxRecord) => Promise<unknown>;
}

const plugin = { manifest: { id: 'art', name: 'Art', command: 'art',
  tools: [{ name: 'draw', description: 'Draw an image', parameters: { type: 'object' } }] }, enabled: true };
const item = (): QueuedRemoteMessage => ({
  clientId: 'client-1', text: '$art cat', persistedContent: JSON.stringify({ text: '$art cat', images: [] }),
  workingDir: '/project', model: 'model', effort: '', permissionMode: 'auto',
  createOpts: { agentKind: 'pi', workingDir: '/project', model: 'model', agentDeviceId: 'model-host' },
  chatMessage: { clientId: 'client-1', role: 'user', content: '$art cat', isStreaming: false, createdAt: '2026-10-09T00:00:00Z' },
});
function harness(catalog: unknown = [plugin], deviceId = 'task-host') {
  const invoke = vi.fn(async (_device, channel, _args) => channel === 'ghosts:composer-list' ? catalog : { accepted: true });
  return { invoke, maker: createMobileMakerTransport({ deviceId, invoke: invoke as RemoteInvoke }) };
}
afterEach(() => vi.unstubAllGlobals());

describe('actual durable outbox plugin delivery', () => {
  function record(newTask = false): DurableOutboxRecord {
    return { version: 1, accountId: 'owner', deviceId: 'task-host', createdAt: 1,
      state: 'sending', uploads: [], prepared: item(), sendAtMs: 123, clearBoundaryMs: 100,
      item: { sessionId: newTask ? 'new-task' : 'existing-task' } as DurableOutboxRecord['item'] };
  }
  it.each([[false, 100], [true, null]] as const)('expands the actual send callback for new task = %s without mutating durable drafts', async (newTask, clearBoundaryMs) => {
    const row = record(newTask);
    row.clearBoundaryMs = clearBoundaryMs;
    const original = structuredClone(row);
    const { invoke } = harness();
    await outboxSender(() => invoke as RemoteInvoke)(row);
    expect(invoke.mock.calls[0]).toEqual(['task-host', 'ghosts:composer-list', ['/project']]);
    const [device, channel, args] = invoke.mock.calls.at(-1)!;
    expect([device, channel]).toEqual(['task-host', 'maker:input:enqueue']);
    expect(args).toEqual([row.item.sessionId, { ...row.prepared, text: expandGhostCommand('$art cat', [plugin]) },
      { sendAtMs: 123, expectedClearBoundaryMs: clearBoundaryMs }]);
    expect(row).toEqual(original);
  });
  it('keeps the original dollar text on unsupported hosts and expands only the wire copy on retry', async () => {
    const row = record();
    const { invoke } = harness();
    invoke.mockRejectedValueOnce(Object.assign(new Error('unsupported'), { code: 'CHANNEL_NOT_ALLOWED' }));
    const send = outboxSender(() => invoke as RemoteInvoke);
    await send(row);
    expect((invoke.mock.calls.at(-1)![2][1] as QueuedRemoteMessage).text).toBe('$art cat');
    await send(row);
    expect((invoke.mock.calls.at(-1)![2][1] as QueuedRemoteMessage).text).toBe(expandGhostCommand('$art cat', [plugin]));
    expect(row.prepared!.text).toBe('$art cat');
  });
  it.each(['account', 'record'])('does not dispatch after %s invalidation during catalog reading', async (reason) => {
    setMobileAuthOwner('owner-a');
    let owned = true;
    const invoke = vi.fn(async (_device, channel, _args) => {
      if (channel === 'ghosts:composer-list') {
        if (reason === 'account') setMobileAuthOwner('owner-b');
        else owned = false;
        return [plugin];
      }
      return {};
    });
    const invokeOwned = () => (async (...args: Parameters<RemoteInvoke>) => {
      if (!owned) throw new Error('OUTBOX_STALE_WRITE');
      return invoke(...args);
    }) as RemoteInvoke;
    await expect(outboxSender(invokeOwned)(record())).rejects.toThrow();
    expect(invoke.mock.calls.filter((call) => call[1] === 'maker:input:enqueue')).toHaveLength(0);
  });
});

describe('mobile plugin catalog and send routing', () => {
  it('reads the existing task-host channel and validates its public projection', async () => {
    const { maker, invoke } = harness([{ ...plugin, installationDir: '/private', credentials: 'private' }]);
    expect(await maker.listComposerPlugins('/project')).toEqual([plugin]);
    expect(invoke).toHaveBeenCalledWith('task-host', 'ghosts:composer-list', ['/project']);
    await maker.listComposerPlugins();
    expect(invoke).toHaveBeenLastCalledWith('task-host', 'ghosts:composer-list', []);
  });
  it.each(['enqueue', 'steer', 'updateContent'] as const)('expands %s with the Desktop template while retaining the draft echo', async (method) => {
    const { maker, invoke } = harness();
    const original = item();
    if (method === 'updateContent') await maker.input.updateContent('session', 'client-1', original);
    else await maker.input[method]('session', original);
    const args = invoke.mock.calls.at(-1)![2] as unknown[];
    const sent = args[method === 'updateContent' ? 2 : 1] as QueuedRemoteMessage;
    expect(sent.text).toBe(expandGhostCommand(original.text, [plugin]));
    expect(sent.text).toContain('mcp__cindy__ghost_call');
    expect(sent.persistedContent).toBe(original.persistedContent);
    expect(sent.chatMessage).toBe(original.chatMessage);
    expect(sent.createOpts).toBe(original.createOpts);
    expect(original.text).toBe('$art cat');
    expect(invoke.mock.calls[0]).toEqual(['task-host', 'ghosts:composer-list', ['/project']]);
  });
  it('rejects a plugin edit through the legacy text channel before it can overwrite the draft', async () => {
    const { maker, invoke } = harness();
    await expect(maker.input.updateText('session', 'client-1', '$art cat', undefined, undefined, '/project'))
      .rejects.toMatchObject({ code: 'CHANNEL_NOT_ALLOWED' });
    expect(invoke.mock.calls).toEqual([['task-host', 'ghosts:composer-list', ['/project']]]);
  });
  it.each(['ordinary text', '$unknown cat', '$art cat'])('preserves legacy text edit %s when no plugin expands', async (text) => {
    const { maker, invoke } = harness([{ ...plugin, enabled: false }]);
    await maker.input.updateText('session', 'client-1', text, undefined, undefined, '/project');
    expect(invoke).toHaveBeenLastCalledWith('task-host', 'maker:input:update-text', ['session', 'client-1', text]);
  });
  it('routes a direct multimodal send without altering its image block', async () => {
    const { maker, invoke } = harness();
    const image = { type: 'image', source: { type: 'base64', data: 'image' } };
    await maker.send('session', { type: 'user', content: [{ type: 'text', text: '$art cat' }, image] }, item().createOpts);
    const message = (invoke.mock.calls.at(-1)![2] as unknown[])[1] as { content: unknown[] };
    expect(message.content).toEqual([{ type: 'text', text: expandGhostCommand('$art cat', [plugin]) }, image]);
  });
  it.each(['ordinary text', '$unknown cat', '$art cat'])('preserves %s for an unavailable or unmatched plugin', async (text) => {
    const { maker, invoke } = harness([{ ...plugin, enabled: false }]);
    await maker.input.enqueue('session', { ...item(), text });
    const sent = (invoke.mock.calls.at(-1)![2] as unknown[])[1] as QueuedRemoteMessage;
    expect(sent.text).toBe(text);
    if (text === 'ordinary text') expect(invoke).toHaveBeenCalledOnce();
  });
  it('does not append a second directive on retry', async () => {
    const { maker, invoke } = harness();
    const text = expandGhostCommand('$art cat', [plugin]);
    await maker.input.enqueue('session', { ...item(), text });
    expect(invoke).toHaveBeenCalledOnce();
    expect(((invoke.mock.calls[0][2] as unknown[])[1] as QueuedRemoteMessage).text).toBe(text);
  });
  it.each(['send', 'enqueue', 'steer', 'updateText', 'updateContent'] as const)('preserves ordinary dollar text through %s on an older host', async (method) => {
    const { maker, invoke } = harness();
    invoke.mockImplementation(async (_device, channel) => {
      if (channel === 'ghosts:composer-list') throw Object.assign(new Error('[CHANNEL_NOT_ALLOWED] unsupported channel'), { code: 'CHANNEL_NOT_ALLOWED' });
      return { accepted: true };
    });
    const text = '$100 budget';
    const original = { ...item(), text };
    if (method === 'send') await maker.send('session', text, original.createOpts);
    else if (method === 'updateText') await maker.input.updateText('session', original.clientId, text, undefined, undefined, original.workingDir);
    else if (method === 'updateContent') await maker.input.updateContent('session', original.clientId, original);
    else await maker.input[method]('session', original);
    const [device, channel, args] = invoke.mock.calls.at(-1)!;
    expect(device).toBe('task-host');
    const channels = { send: 'maker:send', enqueue: 'maker:input:enqueue', steer: 'maker:input:steer', updateText: 'maker:input:update-text', updateContent: 'maker:input:update-content' };
    expect(channel).toBe(channels[method]);
    expect(method === 'send' ? args[1] : method === 'updateText' ? args[2] : (args[method === 'updateContent' ? 2 : 1] as QueuedRemoteMessage).text).toBe(text);
  });
  it.each([
    new Error('CHANNEL_NOT_ALLOWED'),
    new Error("Error invoking remote method 'ghosts:composer-list': Error: CHANNEL_NOT_ALLOWED"),
    new Error('[CHANNEL_NOT_ALLOWED] unsupported channel'),
    new Error("Error invoking remote method 'ghosts:composer-list': Error: [CHANNEL_NOT_ALLOWED] unsupported channel"),
    Object.assign(new Error('unsupported channel'), { code: 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' }),
    Object.assign(new Error('[CHANNEL_NOT_ALLOWED] unsupported channel'), { code: 'IPC_ERROR' }),
  ])('recognizes legacy unsupported-channel error %s', async (error) => {
    const { maker, invoke } = harness();
    invoke.mockRejectedValueOnce(error);
    await maker.input.enqueue('session', item());
    expect(invoke.mock.calls.at(-1)![1]).toBe('maker:input:enqueue');
    expect((invoke.mock.calls.at(-1)![2][1] as QueuedRemoteMessage).text).toBe('$art cat');
  });
  it.each(['ACCESS_REVOKED', 'PERMISSION_DENIED', 'NOT_CONNECTED', 'INVOKE_TIMEOUT'])('does not swallow catalog failure %s', async (code) => {
    const { maker, invoke } = harness();
    const error = Object.assign(new Error('[CHANNEL_NOT_ALLOWED] appears in unrelated details'), { code });
    invoke.mockRejectedValueOnce(error);
    await expect(maker.input.enqueue('session', item())).rejects.toBe(error);
    expect(invoke).toHaveBeenCalledOnce();
  });
  it('keeps shared-task visitors on their existing send path without requesting the catalog', async () => {
    const { maker, invoke } = harness([], sharedTaskHostPeer('task-1', 'host-1'));
    await maker.input.enqueue('session', item());
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0][1]).toBe('maker:input:enqueue');
  });
  it('rejects malformed catalogs without sending a plugin request', async () => {
    const { maker, invoke } = harness([{ manifest: { id: 'art', name: 'Art', command: 'bad command' }, enabled: true }]);
    await expect(maker.input.enqueue('session', item())).rejects.toThrow();
    expect(invoke).toHaveBeenCalledOnce();
  });
  it('discards a catalog and cancels the write when the account changes during reading', async () => {
    setMobileAuthOwner('owner-a');
    const invoke = vi.fn(async () => { setMobileAuthOwner('owner-b'); return [plugin]; });
    const maker = createMobileMakerTransport({ deviceId: 'host', invoke: invoke as RemoteInvoke });
    await expect(maker.input.enqueue('session', item())).rejects.toThrow('superseded');
    expect(invoke).toHaveBeenCalledOnce();
  });
  it('keeps UTF-8 tool budgets on Hermes without TextEncoder', () => {
    const exact = [{ name: 'draw', description: '猫😀'.repeat(10) }];
    const huge = [{ name: 'draw', description: '猫😀'.repeat(1500) }];
    vi.stubGlobal('TextEncoder', undefined);
    expect(buildGhostToolsJson(exact)).toBe(JSON.stringify(exact));
    expect(buildGhostToolsJson(huge)).toBeNull();
  });
});
