import { expect, it, vi } from 'vitest';

vi.mock('../../../agent-island/service.js', () => ({ getAgentIslandService: () => null }));
vi.mock('../../../maker-ipc/botRemoteResourceInvalidation.js', () => ({ scheduleBotRemoteResourceChangedForSession: vi.fn() }));
vi.mock('../../../maker-ipc/workingStatus.js', () => ({ getWorkingStatusCopy: vi.fn() }));
vi.mock('../../client/current.js', () => ({ getDbClient: () => null }));
vi.mock('../../../device-link/broadcast-tap.js', () => ({ captureDataOwnerBroadcastScope: () => ({}), isDataOwnerBroadcastScopeCurrent: () => true }));
const source = vi.hoisted(() => ({ id: 'bot-1', name: 'Sora', description: '', avatar: '', avatarColor: 'teal', status: 'active',
  canonicalSessionId: 'session-1', lastMessagePreview: null, lastMessageAt: null, lastMessageRole: null, needsAttention: false,
  hiddenAt: null, pinnedAt: null, activityAt: 1, currentVersion: 1, updatedAt: 1 }));
vi.mock('../bots.js', () => ({ getBotRemoteResourceSource: async () => ({ ...source }), listBotRemoteResourceSources: async () => [{ ...source }] }));

import { remoteResourceRegistry } from '../../../device-link/remoteResourceRegistry.js';
import { registerBotRemoteResourceProvider } from '../botRemoteResourceProvider.js';
import type { botRemoteManagement } from '../botRemoteManagement.js';

const ref = (id: string) => ({ collectionId: 'teammates', kind: 'bot', id });
const management = {
  get: vi.fn(async (_context: unknown, id: string) => ({ ref: ref(id), revision: 'r1', display: { title: 'Sora' }, links: [],
    blocks: [{ id: 'memory', primitive: 'form', fallbackMarkdown: 'Memory', data: { actionId: 'grant', values: { memory: true, userContext: '' } } }] })),
  getEditor: vi.fn(async (_context: unknown, id: string) => ({ ref: ref(id), revision: 'list', display: { title: 'Saved Memories' }, links: [], blocks: [] })),
  getInvitation: vi.fn(), invoke: vi.fn(), bindResource: vi.fn(),
};
registerBotRemoteResourceProvider(management as unknown as typeof botRemoteManagement);
const context = { controllerDeviceId: 'phone' };

it('adds a saved-memories page beside the memory toggle form only for form-capable controllers', async () => {
  const settings = await remoteResourceRegistry.get(context, { client: { protocolVersion: 1, primitives: ['form', 'list'] }, ref: ref('bot-1') });
  expect(settings.blocks?.find(block => block.id === 'memory')).toMatchObject({ primitive: 'form' });
  expect(settings.blocks?.find(block => block.id === 'memories')).toMatchObject({ primitive: 'list',
    data: { entries: [{ id: 'memories', resourceId: 'settings:bot-1/memory', title: { fallback: 'Saved Memories' } }] } });
  const readOnly = await remoteResourceRegistry.get(context, { client: { protocolVersion: 1, primitives: ['markdown'] }, ref: ref('bot-1') });
  expect(readOnly.blocks?.some(block => block.id === 'memories') ?? false).toBe(false);
});

it('forwards the optional query and the declared primitives to the memory page', async () => {
  const client = { protocolVersion: 1, primitives: ['form', 'search'], locale: 'zh-CN' };
  await remoteResourceRegistry.get(context, { client, ref: ref('settings:bot-1/memory'), query: '咖啡' });
  expect(management.getEditor).toHaveBeenLastCalledWith(context, 'settings:bot-1/memory', 'zh-CN', { query: '咖啡', primitives: ['form', 'search'] });
  await remoteResourceRegistry.get(context, { client, ref: ref('settings:bot-1/memory') });
  expect(management.getEditor).toHaveBeenLastCalledWith(context, 'settings:bot-1/memory', 'zh-CN', { query: undefined, primitives: ['form', 'search'] });
});
