import { expect, it, vi } from 'vitest';
import type { BotRemoteResourceSource } from '../bots.js';

const db = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), current: true }));
vi.mock('../../../device-link/broadcast-tap.js', () => ({ captureDataOwnerBroadcastScope: () => ({}), isDataOwnerBroadcastScopeCurrent: () => db.current }));
vi.mock('../bots.js', () => ({
  getBotRemoteResourceSource: db.get,
  listBotRemoteResourceSources: db.list,
}));

import { remoteResourceRegistry } from '../../../device-link/remoteResourceRegistry.js';
import { setBotRemoteMessageService } from '../../../maker-ipc/botRemoteMessageReceiver.js';
import { registerBotRemoteResourceProvider } from '../botRemoteResourceProvider.js';

it('rejects a previously discovered hidden companion and allows it again after restoration', async () => {
  const source: BotRemoteResourceSource = {
    id: 'bot-1', name: 'Sora', description: 'Designer',
    avatar: '', avatarColor: 'teal', status: 'active',
    canonicalSessionId: 'session-1', lastMessagePreview: 'Private work',
    lastMessageAt: 100, lastMessageRole: 'assistant', needsAttention: false,
    hiddenAt: null, pinnedAt: null, activityAt: 100, currentVersion: 1, updatedAt: 100,
  };
  db.get.mockImplementation(async () => ({ ...source }));
  db.list.mockImplementation(async () => [{ ...source }]);
  registerBotRemoteResourceProvider();
  const context = { controllerDeviceId: 'remote-mac' };
  const client = { protocolVersion: 1, primitives: ['markdown'] };
  const list = () => remoteResourceRegistry.list(context, { client, collectionId: 'teammates' });
  const discovered = (await list()).items[0];
  const get = () => remoteResourceRegistry.get(context, { client, ref: discovered.ref });

  await expect(get()).resolves.toMatchObject({
    display: { title: 'Sora' },
    links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'session-1' } }],
  });
  const receiveRemote = vi.fn(async () => ({ ok: false as const, errorCode: 'TEST_RECEIPT', message: 'test' }));
  const verifyRemoteMessage = vi.fn(async () => true);
  const readRemoteReceipt = vi.fn(async () => ({ messageId: 'delivery-1', accepted: true as const }));
  setBotRemoteMessageService({ receiveRemote, verifyRemoteMessage, readRemoteReceipt });
  await expect(remoteResourceRegistry.invoke(context, { client, collectionId: 'teammates',
    actionId: 'message-receipt', resourceRef: discovered.ref,
    input: { senderBotId: 'sender', messageId: 'delivery-1', controllerDeviceId: 'spoofed' } }))
    .resolves.toMatchObject({ effects: [], messageId: 'delivery-1', accepted: true });
  expect(readRemoteReceipt).toHaveBeenCalledWith({ controllerDeviceId: 'remote-mac', senderBotId: 'sender', targetBotId: 'bot-1', messageId: 'delivery-1' });
  const invoke = () => remoteResourceRegistry.invoke(context, { client, collectionId: 'teammates',
    actionId: 'send-message', resourceRef: discovered.ref,
    input: { senderBotId: 'sender', messageId: 'delivery-1', message: 'hello', controllerDeviceId: 'spoofed' } });
  await expect(invoke()).resolves.toMatchObject({ effects: [], teammateMessage: { errorCode: 'TEST_RECEIPT' } });
  expect(receiveRemote).toHaveBeenCalledWith({ controllerDeviceId: 'remote-mac', senderBotId: 'sender',
    targetBotId: 'bot-1', messageId: 'delivery-1', message: 'hello' });
  await expect(remoteResourceRegistry.invoke(context, { client, collectionId: 'teammates',
    actionId: 'verify-message', resourceRef: discovered.ref,
    input: { targetBotId: 'target', messageId: 'delivery-1', message: 'hello', controllerDeviceId: 'spoofed' } }))
    .resolves.toMatchObject({ effects: [], verified: true });
  expect(verifyRemoteMessage).toHaveBeenCalledWith({ controllerDeviceId: 'remote-mac', senderBotId: 'bot-1',
    targetBotId: 'target', messageId: 'delivery-1', message: 'hello' });
  const longBotId = 'b'.repeat(128);
  for (const actionId of ['send-message', 'verify-message', 'message-receipt']) {
    const request = { client, collectionId: 'teammates', actionId,
      resourceRef: { ...discovered.ref, id: longBotId },
      input: { senderBotId: longBotId, targetBotId: longBotId, messageId: 'delivery-1', message: 'hello' } };
    await expect(remoteResourceRegistry.invoke(context, request)).resolves.toMatchObject({ effects: [] });
    await expect(remoteResourceRegistry.invoke(context, { ...request, resourceRef: { ...request.resourceRef, id: longBotId + 'b' } }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(remoteResourceRegistry.invoke(context, { ...request,
      input: { ...request.input, senderBotId: longBotId + 'b', targetBotId: longBotId + 'b' } }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(remoteResourceRegistry.invoke(context, { ...request, input: { ...request.input, messageId: 'm'.repeat(81) } }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  }
  expect(receiveRemote).toHaveBeenLastCalledWith(expect.objectContaining({ senderBotId: longBotId, targetBotId: longBotId }));
  expect(verifyRemoteMessage).toHaveBeenLastCalledWith(expect.objectContaining({ senderBotId: longBotId, targetBotId: longBotId }));
  expect(readRemoteReceipt).toHaveBeenLastCalledWith(expect.objectContaining({ senderBotId: longBotId, targetBotId: longBotId }));
  db.current = false;
  await expect(invoke()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  db.current = true;
  source.hiddenAt = 200;
  await expect(invoke()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(receiveRemote).toHaveBeenCalledTimes(2);
  expect((await list()).items).toEqual([]);
  await expect(get()).rejects.toMatchObject({
    code: 'NOT_FOUND', message: 'remote resource does not exist',
  });
  expect(db.get).toHaveBeenLastCalledWith('bot-1');

  source.hiddenAt = null;
  source.status = 'archived';
  expect((await list()).items).toEqual([]);
  await expect(get()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  source.status = 'active';
  expect((await list()).items).toHaveLength(1);
  await expect(get()).resolves.toMatchObject({ display: { title: 'Sora' } });
});
