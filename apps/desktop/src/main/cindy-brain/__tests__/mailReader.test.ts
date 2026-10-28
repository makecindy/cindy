import { describe, expect, it, vi } from 'vitest';
import { createMailReader, mailReaderRemoteProvider, type MailReaderPlugin } from '../mailReader.js';
import type { MailReaderDeclaration } from '@cindy/maker-shared/mail-message';
import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';
import { GhostCardService } from '../cardService.js';
import { installedGhostLogicalIdentity, pluginStoragePart, resolvePluginInstanceQuery } from '../../../shared/pluginIdentity.js';

const productionReader = createGhostProductionCallbacks<{ readMail: ReturnType<typeof createMailReader> }>({ variables: ['readMail'] });

const message = { accountId: 'a', messageId: 'm', from: 'from@test.com', to: 'to@test.com', cc: '', bcc: '', subject: 'Subject', date: '', bodyText: 'Hello', bodyHtml: '<p>Hello</p>', attachments: [] };
const plugin = { id: 'test-mail', namespace: null, enabled: true, reader: { tool: 'read_mail', hosts: ['mail.example.com'] } };
function setup(markRead: unknown = undefined) {
  const call = vi.fn<Parameters<typeof createMailReader>[0]['call']>(async () => ({ ok: true, result: message }));
  const authorize = vi.fn(async () => {});
  let current = true;
  // Raw values also exercise declarations retained from an older manifest validator.
  const reader = createMailReader({ plugins: () => [{ ...plugin, reader: { ...plugin.reader, ...(markRead === undefined ? {} : { markRead }) } as MailReaderDeclaration }], call, authorize, captureScope: () => () => current });
  return { reader, call, authorize, expire: () => { current = false; } };
}
describe('common mailbox reader', () => {
  // Unit: the production native-open callback must close its call-bound Host
  // capability even if scope/approval changes or dispatch rejects. Previous
  // tests mocked card lifecycle away and only covered a successful current read.
  it.each(['owner', 'disabled', 'approval', 'dispatch-error', 'resolve-error'])('finalizes the native call after %s invalidation', async boundary => {
    let ownerCurrent = true, approval = 'v1';
    const ghost = { manifest: { id: plugin.id, mail: true, mailReader: plugin.reader, tools: [{ name: 'read_mail' }] },
      instanceKey: '_root__test-mail', namespace: null, enabled: true, approval: { state: 'approved' } };
    const cards = new GhostCardService({ hasCardSlot: () => true, sanitize: html => ({ ok: true, html }), persist: async () => {}, broadcast: () => {} });
    const { readMail } = productionReader({
      createMailReader, availableGhosts: () => [ghost], getGhostSetupAssessment: () => ({ state: 'ready' }),
      getDeviceLinkInvokeContext: () => null, getSessionRowSnapshot: async () => ({}), assertRemoteBotInvocationAllowed: async () => {},
      captureDataOwnerBroadcastScope: () => ({}), isDataOwnerBroadcastScopeCurrent: () => ownerCurrent,
      findGhostForInstanceId: () => ghost, ghostInstallApprovalToken: () => approval, randomUUID: () => 'native-read',
      pluginStoragePart, installedGhostLogicalIdentity, getGhostCardService: () => cards,
      getMailCardService: () => ({ resolveLink: async () => { throw new Error('resolve failed'); } }),
      getGhostPipeDispatcher: () => ({ callGhostTool: async () => {
        expect(cards.inFlightCallInfoOf('native-read')?.sessionId).toBe('session');
        if (boundary === 'owner') ownerCurrent = false;
        if (boundary === 'disabled') ghost.enabled = false;
        if (boundary === 'approval') approval = 'v2';
        if (boundary === 'dispatch-error') throw new Error('dispatch failed');
        return { ok: true, result: message };
      } }),
    });
    const result = readMail('session', 'https://mail.example.com/m', true, true);
    if (boundary === 'owner') await expect(result).rejects.toThrow('Mail unavailable');
    else if (boundary === 'dispatch-error') await expect(result).rejects.toThrow('dispatch failed');
    else if (boundary === 'resolve-error') await expect(result).rejects.toThrow('resolve failed');
    else expect((await result).message).toEqual(message);
    expect(cards.inFlightCallInfoOf('native-read')).toBeNull();
  });
  // Regression: native reads mixed an exact installation key with a logical
  // namespace query, so new root/organization installs never reached the tool.
  // Exercise the production host adapter; previous tests mocked its call away.
  it('dispatches native reads to the selected physical installation', async () => {
    for (const namespace of [null, 'team']) {
      const instanceKey = namespace === null ? '_root__test-mail' : '_ns__team__test-mail';
      const ghost = { manifest: { id: 'test-mail', name: 'Mail', mail: true, mailReader: plugin.reader, tools: [{ name: 'read_mail' }] },
        instanceKey, namespace, enabled: true, approval: { state: 'approved' } };
      const lookup = (id: string, ns?: string | null) => {
        const result = resolvePluginInstanceQuery([ghost], id, ns);
        return result.status === 'unique' ? result.ghost : null;
      };
      const invoked = vi.fn();
      const { readMail } = productionReader({
        createMailReader, availableGhosts: () => [ghost], getGhostSetupAssessment: () => ({ state: 'ready' }),
        getDeviceLinkInvokeContext: () => null, getSessionRowSnapshot: async () => ({}), assertRemoteBotInvocationAllowed: async () => {},
        captureDataOwnerBroadcastScope: () => ({}), isDataOwnerBroadcastScopeCurrent: () => true,
        findGhostForInstanceId: lookup, ghostInstallApprovalToken: () => 'approved', randomUUID: () => 'read-call',
        pluginStoragePart, installedGhostLogicalIdentity,
        getGhostCardService: () => ({ registerCall: vi.fn(), finalizeCall: vi.fn() }),
        getMailCardService: () => ({ resolveLink: async () => undefined }),
        getGhostPipeDispatcher: () => ({ callGhostTool: async (request: { ghostId: string; namespace?: string | null }) => {
          if (!lookup(request.ghostId, request.namespace)) return { ok: false, errorCode: 'GHOST_NOT_FOUND' };
          invoked(request.ghostId);
          return { ok: true, result: message };
        } }),
      });
      expect((await readMail('session', 'https://mail.example.com/m', true, true)).message).toEqual(message);
      expect(invoked).toHaveBeenCalledWith(instanceKey);
    }
  });
  // Unit regression: probes used to intercept links for an unconfigured plugin.
  // Existing provider-choice tests only covered at least one ready reader.
  it('leaves links to the browser without a ready reader and explains restored tabs without calling tools', async () => {
    const f = setup(), url = 'https://mail.example.com/m';
    let plugins: MailReaderPlugin[] = [];
    const reader = createMailReader({ plugins: () => plugins, call: f.call, authorize: f.authorize, captureScope: () => () => true });
    for (const state of [[], [{ ...plugin, enabled: false }], [{ ...plugin, ready: false }], [{ ...plugin, ready: false }, { ...plugin, namespace: 'team', ready: false }]]) {
      plugins = state;
      expect(await reader('session', url, false)).toEqual({ supported: false });
      const restored = await mailReaderRemoteProvider(reader).get!({ controllerDeviceId: 'phone' }, {
        client: { protocolVersion: 1, primitives: ['mail-message'] },
        ref: { collectionId: 'mail-messages', kind: 'message', id: JSON.stringify(['session', url, true]) }, query: 'open',
      });
      expect(restored.blocks?.[0].data).toEqual(state.some(p => p.enabled)
        ? { supported: true, error: 'MAIL_PROVIDER_NOT_READY' } : { supported: false });
    }
    expect((await reader('session', url, true, true, JSON.stringify([plugin.id, null]))).error).toBe('MAIL_PROVIDER_NOT_READY');
    expect(f.call).not.toHaveBeenCalled();
    plugins = [{ ...plugin, ready: true }];
    expect(await reader('session', url, false)).toEqual({ supported: true });
    expect((await reader('session', url, true)).message).toEqual(message);
  });
  it.each([undefined, true, false, 'false', 'true', 0, 1, null, {}, []].map(markRead => ({ markRead })))('requires literal opt-in across local and remote reads (markRead=$markRead)', async ({ markRead }) => {
    const f = setup(markRead), url = 'https://mail.example.com/m';
    await f.reader('session', url, false, true);
    expect(f.call).not.toHaveBeenCalled();
    await f.reader('session', url, true);
    expect(f.call.mock.calls.at(-1)).toHaveLength(3);
    await f.reader('session', url, true, true);
    expect(f.call.mock.calls.at(-1)).toHaveLength(4);
    const provider = mailReaderRemoteProvider(f.reader);
    const request = { client: { protocolVersion: 1, primitives: ['mail-message'] }, ref: { collectionId: 'mail-messages', kind: 'message', id: JSON.stringify(['session', url, true]) } };
    await provider.get!({ controllerDeviceId: 'controller' }, request);
    expect(f.call.mock.calls.at(-1)).toHaveLength(3);
    await provider.get!({ controllerDeviceId: 'controller' }, { ...request, query: 'open' });
    expect(f.call.mock.calls.at(-1)).toHaveLength(4);
  });
  // Opening may mark read; probing, AI reads and neighboring preloads must not.
  it('passes read intent only for an authorized opening with an opted-in provider', async () => {
    const f = setup(true), url = 'https://mail.example.com/m';
    await f.reader('session', url, false, true);
    expect(f.call).not.toHaveBeenCalled();
    await f.reader('session', url, true);
    expect(f.call.mock.calls.at(-1)).toHaveLength(3);
    await f.reader('session', url, true, true);
    expect(f.call.mock.calls.at(-1)?.[3]).toBe(true);
    const legacy = setup();
    await legacy.reader('session', url, true, true);
    expect(legacy.call.mock.calls.at(-1)).toHaveLength(4);
    await expect(f.reader('session', url, true, 'true')).rejects.toThrow();
  });
  it('carries explicit remote opening intent without changing legacy resource IDs', async () => {
    const f = setup(true), provider = mailReaderRemoteProvider(f.reader);
    const request = { client: { protocolVersion: 1, primitives: ['mail-message'] }, ref: { collectionId: 'mail-messages', kind: 'message', id: JSON.stringify(['session', 'https://mail.example.com/m', true]) } };
    await provider.get!({ controllerDeviceId: 'controller' }, request);
    expect(f.call.mock.calls.at(-1)).toHaveLength(3);
    const result = await provider.get!({ controllerDeviceId: 'controller' }, { ...request, query: 'open' });
    expect(f.call.mock.calls.at(-1)?.[3]).toBe(true);
    expect(result.ref).toEqual(request.ref);
    f.authorize.mockRejectedValue(new Error('Forbidden'));
    f.call.mockClear();
    await expect(f.reader('session', 'https://mail.example.com/m', true, true)).rejects.toThrow('Forbidden');
    expect(f.call).not.toHaveBeenCalled();
  });
  // New optional history must survive IPC without trusting a plugin's foreign-host URL.
  it('validates conversation links while retaining a readable selected message', async () => {
    const f = setup();
    const summary = { messageId: 'm', from: 'A', date: '', subject: 'S', snippet: 'Hi', url: 'https://mail.example.com/message/m' };
    f.call.mockResolvedValue({ ok: true, result: { ...message, conversation: { threadId: 'thread', messages: [summary] } } } as never);
    expect((await f.reader('session', summary.url, true)).message?.conversation?.messages).toEqual([summary]);
    f.call.mockResolvedValue({ ok: true, result: { ...message, conversation: { threadId: 'thread', messages: [{ ...summary, url: 'https://foreign.example.com/m' }] } } } as never);
    const result = await f.reader('session', summary.url, true);
    expect(result.message?.bodyText).toBe('Hello');
    expect(result.message?.conversation).toBeUndefined();
    expect(result.message?.conversationUnavailable).toBe(true);
  });
  it('resolves only exact HTTPS provider hosts without invoking a tool', async () => {
    const f = setup();
    expect(await f.reader('session', 'https://mail.example.com/mail/#inbox/id', false)).toEqual({ supported: true });
    for (const url of ['https://mail.example.com.evil.com/a', 'http://mail.example.com/a', 'https://user@mail.example.com/a', 'https://mail.example.com:444/a'])
      expect(await f.reader('session', url, false)).toEqual({ supported: false });
    expect(f.call).not.toHaveBeenCalled();
  });
  it('uses only the declared read tool and returns validated data without publishing a card', async () => {
    const f = setup();
    expect(await f.reader('session', 'https://mail.example.com/mail/#id', true)).toEqual({ supported: true, message, providerId: JSON.stringify([plugin.id, null]) });
    expect(f.call).toHaveBeenCalledWith(plugin, 'session', 'https://mail.example.com/mail/#id');
  });
  it('does not return mail after account/owner changes', async () => {
    const f = setup();
    f.call.mockImplementation(async () => { f.expire(); return { ok: true, result: message }; });
    await expect(f.reader('session', 'https://mail.example.com/a', true)).rejects.toThrow();
  });
  // A draft link must open the Host-bound editor, while AI/preload reads stay inert.
  it('returns only Host-verified draft cards for explicit openings, including remote transport', async () => {
    const f = setup(), url = 'https://mail.example.com/draft';
    f.call.mockResolvedValue({ ok: true, result: { ...message, draftCallId: 'forged' }, draftCallId: 'owned-card' });
    expect((await f.reader('session', url, true)).draftCallId).toBeUndefined();
    expect((await f.reader('session', url, true, true)).draftCallId).toBe('owned-card');
    const result = await mailReaderRemoteProvider(f.reader).get!({ controllerDeviceId: 'phone' }, {
      client: { protocolVersion: 1, primitives: ['mail-message'] },
      ref: { collectionId: 'mail-messages', kind: 'message', id: JSON.stringify(['session', url, true]) }, query: 'open',
    });
    expect(result.blocks?.[0].data).toMatchObject({ draftCallId: 'owned-card' });
    f.call.mockResolvedValue({ ok: true, result: { ...message, draftCallId: 'forged' } });
    expect((await f.reader('session', url, true, true)).draftCallId).toBeUndefined();
  });
  it('does not read before session authorization', async () => {
    const f = setup(); f.authorize.mockRejectedValue(new Error('Forbidden'));
    await expect(f.reader('session', 'https://mail.example.com/a', true)).rejects.toThrow('Forbidden');
    expect(f.call).not.toHaveBeenCalled();
  });
  // Duplicate namespaces must not block the sole configured reader, and must
  // never cause a chosen thread to switch providers after readiness changes.
  it('uses only the sole ready provider and asks before reading when several are usable', async () => {
    let plugins = [{ ...plugin, name: 'Mail', ready: true }, { ...plugin, namespace: 'team', name: 'Mail', ready: false }];
    const f = setup(), reader = createMailReader({ plugins: () => plugins, call: f.call, authorize: f.authorize, captureScope: () => () => true });
    const url = 'https://mail.example.com/m';
    const initial = await reader('session', url, true);
    expect(f.call.mock.calls[0][0].namespace).toBe(null);
    plugins = plugins.map(p => ({ ...p, ready: true }));
    f.call.mockClear();
    const ambiguous = await reader('session', url, true, true);
    expect(ambiguous.error).toBe('MAIL_PROVIDER_AMBIGUOUS');
    expect(ambiguous.providers?.map(p => p.namespace)).toEqual([null, 'team']);
    expect(f.call).not.toHaveBeenCalled();
    await reader('session', url, true, false, initial.providerId);
    expect(f.call.mock.calls[0][0].namespace).toBe(null);
    f.call.mockClear();
    plugins = plugins.slice(1);
    expect((await reader('session', url, true, true, initial.providerId)).error).toBe('MAIL_PROVIDER_UNAVAILABLE');
    expect(f.call).not.toHaveBeenCalled();
  });
  it('revalidates remote provider choices against current matching instances', async () => {
    const f = setup(true), provider = mailReaderRemoteProvider(f.reader);
    const request = { client: { protocolVersion: 1, primitives: ['mail-message'] }, ref: { collectionId: 'mail-messages', kind: 'message', id: JSON.stringify(['session', 'https://mail.example.com/m', true]) },
      query: JSON.stringify({ opened: true, providerId: JSON.stringify([plugin.id, null]) }) };
    await provider.get!({ controllerDeviceId: 'controller' }, request);
    expect(f.call.mock.calls[0][3]).toBe(true);
    f.call.mockClear();
    const result = await provider.get!({ controllerDeviceId: 'controller' }, { ...request, query: JSON.stringify({ opened: true, providerId: 'foreign-instance' }) });
    expect(result.blocks?.[0]?.data).toMatchObject({ error: 'MAIL_PROVIDER_UNAVAILABLE' });
    expect(f.call).not.toHaveBeenCalled();
    await expect(provider.get!({ controllerDeviceId: 'controller' }, { ...request, query: '{bad' })).rejects.toThrow();
  });
});
