import { beforeEach, expect, it, vi } from 'vitest';
import { REMOTE_RESOURCE_GET_CHANNEL } from '@cindy/device-link';
import { validateOutboxResourceBinding } from '@/session/outboxResourceBinding';
const ref = { collectionId: 'teammates', kind: 'bot', id: 'writer' };
const resource = (stage = 'ready', sessionId = 'canonical') => ({ ref, revision: '1', display: { title: 'Writer' },
  links: [{ rel: 'conversation', target: { kind: 'session', sessionId } }],
  blocks: [{ id: 'invitation', primitive: 'status', fallbackMarkdown: '', data: { stage } }],
});
const invoke = vi.fn();
beforeEach(() => { invoke.mockReset(); invoke.mockImplementation(async (_device, channel) => channel === REMOTE_RESOURCE_GET_CHANNEL
  ? resource() : { id: 'canonical', source: 'bot', status: 'active' }); });
it('reads current resource and source-owned canonical metadata without creating or sending anything', async () => {
  await validateOutboxResourceBinding(invoke, 'mac', 'canonical', ref, 'en');
  expect(invoke.mock.calls.map(([, channel]) => channel)).toEqual([REMOTE_RESOURCE_GET_CHANNEL, 'local-db:sessions:get']);
  expect(invoke.mock.calls.every(([device]) => device === 'mac')).toBe(true);
});
it.each(['ACCESS_REVOKED', 'NOT_FOUND', 'REMOTE_DISABLED'])('propagates host rejection %s', async code => {
  invoke.mockRejectedValue(new Error(code));
  await expect(validateOutboxResourceBinding(invoke, 'mac', 'canonical', ref, 'en')).rejects.toThrow(code);
  expect(invoke).toHaveBeenCalledTimes(1);
});
it.each(['skills', 'failed'])('does not dispatch while initialization is %s', async stage => {
  invoke.mockResolvedValue(resource(stage));
  await expect(validateOutboxResourceBinding(invoke, 'mac', 'canonical', ref, 'en')).rejects.toThrow(stage === 'failed' ? 'PRECONDITION_FAILED' : 'DEVICE_LINK_BUSY');
  expect(invoke).toHaveBeenCalledTimes(1);
});
it('rejects a changed canonical target without redirecting or manufacturing another task', async () => {
  invoke.mockResolvedValue(resource('ready', 'different-canonical'));
  await expect(validateOutboxResourceBinding(invoke, 'mac', 'canonical', ref, 'en')).rejects.toThrow('PRECONDITION_FAILED');
  expect(invoke).toHaveBeenCalledTimes(1);
});
it.each([{ id: 'canonical', source: 'user', status: 'active' }, { id: 'canonical', source: 'bot', status: 'deleted' }, null])('rejects unavailable or unrelated task metadata %s', async session => {
  invoke.mockImplementation(async (_device, channel) => channel === REMOTE_RESOURCE_GET_CHANNEL ? resource() : session);
  await expect(validateOutboxResourceBinding(invoke, 'mac', 'canonical', ref, 'en')).rejects.toThrow('PRECONDITION_FAILED');
});
