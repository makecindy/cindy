import { afterEach, describe, expect, it, vi } from 'vitest';
import { sharedTaskHostPeer } from '@cindy/device-link';
import { buildGhostToolsJson, expandGhostCommand } from '@cindy/maker-shared/ghost-command';
import { createMobileMakerTransport, type RemoteInvoke } from '@/device-link/mobileMakerTransport';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import type { QueuedRemoteMessage } from '@/session/types';

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
