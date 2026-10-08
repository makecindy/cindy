import Database from 'better-sqlite3';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sqlite: null as import('better-sqlite3').Database | null, ownerCurrent: (): boolean => true }));

vi.mock('../../localDb/client/current.js', async () => {
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  return { getDbClient: () => ({ drizzle: drizzle(h.sqlite!) }) };
});
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({ owner: 'a' }),
  isDataOwnerBroadcastScopeCurrent: () => h.ownerCurrent(),
}));

import { remoteResourceRegistry } from '../../device-link/remoteResourceRegistry.js';
import {
  botGroupMembersVisibleRemotely,
  botGroupRemoteChatData,
  botGroupRemoteItem,
  botGroupRemotePreview,
  registerBotGroupRemoteResourceProvider,
} from '../botGroupRemoteResourceProvider.js';
import type { BotGroupChatService } from '../botGroupChatService.js';
import {
  BOT_GROUP_CHAT_PRIMITIVE,
  BOT_GROUP_REMOTE_COLLECTION_ID,
  BOT_GROUP_REMOTE_RESOURCE_KIND,
  type BotGroupDetail,
  type BotGroupSummary,
} from '../../../shared/botGroupChat.js';

const context = { controllerDeviceId: 'phone-1' };
const client = (primitives: string[] = []) => ({ protocolVersion: 1, primitives, locale: 'zh-CN' });
const ref = (id: string) => ({ collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, kind: BOT_GROUP_REMOTE_RESOURCE_KIND, id });

function summary(overrides: Partial<BotGroupSummary> = {}): BotGroupSummary {
  return {
    id: 'g1',
    name: '官网介绍页',
    replyMode: 'all',
    speakingMode: 'auto',
    members: [
      { botId: 'mimi', name: '咪咪', avatar: '🐱', avatarColor: 'red', status: 'active' },
      { botId: 'abu', name: '阿布', avatar: '🦉', avatarColor: 'blue', status: 'active' },
    ],
    organizerBotId: 'mimi',
    projectDir: '/Users/me/site',
    lastMessage: { authorKind: 'bot', authorName: '阿布', preview: '写好了', createdAt: 50 },
    speakingBotIds: [],
    planningBotId: null,
    openPlan: null,
    createdAt: 1,
    updatedAt: 40,
    ...overrides,
  };
}

function detail(overrides: Partial<BotGroupDetail> = {}): BotGroupDetail {
  return {
    ...summary(),
    messages: [
      {
        id: 'm1', sequence: 1, kind: 'message', authorKind: 'user', authorBotId: null, authorName: '',
        content: '做个页面', mentions: { all: false, botIds: [] }, noticeCode: null, planId: null, files: [], attachments: [], createdAt: 10,
      },
      {
        id: 'm2', sequence: 2, kind: 'message', authorKind: 'bot', authorBotId: 'abu', authorName: '阿布',
        content: '写好了', mentions: { all: false, botIds: [] }, noticeCode: null, planId: 'p1', files: ['index.html'], attachments: [], createdAt: 50,
      },
    ],
    hasMoreBefore: false,
    round: { status: 'idle', speakers: [], canContinue: false },
    plans: [{
      id: 'p1', status: 'done', organizerBotId: 'mimi', organizerName: '咪咪',
      steps: [{ position: 0, botId: 'abu', botName: '阿布', task: '写代码', status: 'done' }],
      currentStep: 0, workDir: '/Users/me/site/.cindy-worktrees/brave', branch: 'cindy/brave', createdAt: 1, updatedAt: 2,
    }],
    ...overrides,
  };
}

const service = {
  listGroups: vi.fn(),
  getGroup: vi.fn(),
  createGroup: vi.fn(),
  updateGroup: vi.fn(),
  setMembers: vi.fn(),
  deleteGroup: vi.fn(),
  sendMessage: vi.fn(),
  continueRound: vi.fn(),
  stopRound: vi.fn(),
  startPlan: vi.fn(),
  dismissPlan: vi.fn(),
  continuePlan: vi.fn(),
  retryPlan: vi.fn(),
  editPlanStep: vi.fn(),
};

describe('bot group remote resources', () => {
  beforeAll(() => {
    registerBotGroupRemoteResourceProvider(() => service as unknown as BotGroupChatService);
  });

  beforeEach(() => {
    h.sqlite = new Database(':memory:');
    h.sqlite.exec(`
      CREATE TABLE bot_profiles (id TEXT PRIMARY KEY, hidden_at INTEGER, status TEXT NOT NULL);
      INSERT INTO bot_profiles VALUES ('mimi', NULL, 'active'), ('abu', NULL, 'active'), ('ghost', 5, 'active');
    `);
    h.ownerCurrent = () => true;
    for (const fn of Object.values(service)) fn.mockReset();
    service.getGroup.mockResolvedValue({ ok: true, group: detail() });
    for (const name of ['updateGroup', 'setMembers', 'deleteGroup', 'continueRound', 'stopRound', 'startPlan', 'dismissPlan', 'continuePlan', 'retryPlan', 'editPlanStep'] as const) {
      service[name].mockResolvedValue({ ok: true });
    }
    service.sendMessage.mockResolvedValue({ ok: true, messageId: 'm3' });
  });

  afterEach(() => h.sqlite?.close());

  it('includes server groups with people and companions on another computer', async () => {
    const group = summary({ serverBacked: true, members: [
      { botId: 'person', actorId: 'person', actorKind: 'human', isOwned: false, name: 'Guest', avatar: '', avatarColor: 'red', status: 'active' },
      { botId: 'remote-bot', actorId: 'remote-bot', actorKind: 'bot', isOwned: true, name: 'Remote', avatar: '', avatarColor: 'blue', status: 'active' },
    ] });
    service.listGroups.mockResolvedValue({ ok: true, groups: [group] });
    const listed = await remoteResourceRegistry.list(context, { client: client(), collectionId: BOT_GROUP_REMOTE_COLLECTION_ID });
    expect(listed.items.map(item => item.ref.id)).toEqual(['g1']);
  });

  it('denies list, detail and actions for a server group containing a hidden paused local companion', async () => {
    h.sqlite!.prepare("UPDATE bot_profiles SET status='paused' WHERE id='ghost'").run();
    const group = detail({ serverBacked: true, members: [{ botId: 'ghost', actorId: 'cloud-ghost', actorKind: 'bot', isOwned: true,
      name: 'Hidden', avatar: '', avatarColor: '', status: 'paused' }] });
    service.listGroups.mockResolvedValue({ ok: true, groups: [group] });
    service.getGroup.mockResolvedValue({ ok: true, group });
    expect((await remoteResourceRegistry.list(context, { client: client(), collectionId: BOT_GROUP_REMOTE_COLLECTION_ID })).items).toEqual([]);
    await expect(remoteResourceRegistry.get(context, { client: client(), ref: ref('g1') })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(remoteResourceRegistry.invoke(context, { client: client(), collectionId: BOT_GROUP_REMOTE_COLLECTION_ID,
      actionId: 'stop', resourceRef: ref('g1') })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(service.stopRound).not.toHaveBeenCalled();
  });
  it('lists only groups whose members are all visible to phones, with member links', async () => {
    const hidden = summary({
      id: 'g2',
      members: [...summary().members, { botId: 'ghost', name: '隐藏', avatar: '', avatarColor: '', status: 'active' }],
    });
    service.listGroups.mockResolvedValue({ ok: true, groups: [summary(), hidden] });
    const listed = await remoteResourceRegistry.list(context, { client: client(), collectionId: BOT_GROUP_REMOTE_COLLECTION_ID });
    expect(listed.items.map((item) => item.ref.id)).toEqual(['g1']);
    expect(listed.items[0]!.links.map((link) => link.target)).toEqual([
      { kind: 'resource', ref: { collectionId: 'teammates', kind: 'bot', id: 'mimi' } },
      { kind: 'resource', ref: { collectionId: 'teammates', kind: 'bot', id: 'abu' } },
    ]);
    expect(JSON.stringify(listed)).not.toContain('/Users/me/site');
  });

  it('previews the same plan states as the desktop sidebar', () => {
    const running = summary({
      openPlan: { id: 'p1', status: 'running', currentStep: 1, stepCount: 3, currentBotName: '阿布', currentStepStatus: 'running' },
    });
    expect(botGroupRemotePreview(running)).toMatchObject({ translations: { 'zh-CN': '分工 2/3 · 阿布正在做' } });
    expect(botGroupRemoteItem(summary({ speakingBotIds: ['abu'] })).display.generation).toEqual({ phase: 'processing', startedAt: null });
    expect(botGroupRemotePreview(summary({ planningBotId: 'mimi' }))).toMatchObject({ translations: { 'zh-CN': '咪咪正在安排…' } });
    const waiting = summary({
      openPlan: { id: 'p1', status: 'waiting', currentStep: 0, stepCount: 3, currentBotName: '咪咪', currentStepStatus: 'failed' },
    });
    expect(botGroupRemotePreview(waiting)).toMatchObject({ translations: { 'zh-CN': '咪咪没做完' } });
    expect(botGroupRemotePreview(summary())).toMatchObject({ translations: { 'zh-CN': '阿布：写好了' } });
  });

  it('localizes join previews for every phone language without an author prefix', () => {
    const preview = botGroupRemotePreview(summary({ openPlan: null, lastMessage: { authorKind: 'system',
      authorName: 'Taylor', noticeCode: 'member-joined', preview: 'Fallback', createdAt: 50 } }));
    expect(preview).toEqual({ fallback: 'Taylor joined the group', translations: {
      'zh-CN': 'Taylor加入了群聊', 'zh-TW': 'Taylor加入了群聊',
      ja: 'Taylorさんがグループに参加しました', ko: 'Taylor 님이 그룹에 참여했습니다',
    } });
  });

  it('sends the chat only to controllers that understand it, without host paths', async () => {
    const rich = await remoteResourceRegistry.get(context, { client: client([BOT_GROUP_CHAT_PRIMITIVE]), ref: ref('g1') });
    expect(rich.blocks?.[0]).toMatchObject({ primitive: BOT_GROUP_CHAT_PRIMITIVE });
    const data = rich.blocks![0]!.data as ReturnType<typeof botGroupRemoteChatData>;
    expect(data.projectDir).toBeNull();
    expect(data.projectDirName).toBe('site');
    expect(data.plans[0]!.workDir).toBeNull();
    expect(data.plans[0]!.branch).toBe('cindy/brave');
    expect(JSON.stringify(rich)).not.toContain('/Users/me');
    const plain = await remoteResourceRegistry.get(context, { client: client(), ref: ref('g1') });
    expect(plain.blocks?.[0]).toMatchObject({ primitive: 'markdown' });
    expect(plain.blocks?.[0]?.data).toBeUndefined();
    expect(plain.blocks?.[0]?.fallbackMarkdown).toContain('**阿布**: 写好了');
  });

  it.each(['member-joined', null] as const)('keeps system notices (%s) visible to old phones through the plain fallback', async noticeCode => {
    const joined = { ...detail().messages[0]!, kind: 'notice' as const, authorKind: 'system' as const,
      noticeCode, authorName: 'Taylor', content: 'Taylor joined the group' };
    service.getGroup.mockResolvedValue({ ok: true, group: detail({ messages: [joined] }) });
    const plain = await remoteResourceRegistry.get(context, { client: client(), ref: ref('g1') });
    expect(plain.blocks?.[0]?.fallbackMarkdown).toBe('Taylor joined the group');
    const rich = botGroupRemoteChatData(detail({ messages: [joined] }));
    expect(rich.messages[0]).toMatchObject({ authorKind: 'system', noticeCode, authorName: 'Taylor' });
  });

  it('forwards actions to the group service and reports its error code when refused', async () => {
    const send = await remoteResourceRegistry.invoke(context, {
      client: client(), collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, actionId: 'send', resourceRef: ref('g1'),
      input: { text: '安排一下', mentions: { all: false, botIds: [] }, clientId: 'c1', division: true },
    });
    expect(service.sendMessage).toHaveBeenCalledWith({
      groupId: 'g1', text: '安排一下', mentions: { all: false, botIds: [] }, clientId: 'c1', division: true,
    }, { controllerDeviceId: 'phone-1' });
    expect(send.effects).toEqual([{ kind: 'refresh-resource', ref: ref('g1') }]);

    await remoteResourceRegistry.invoke(context, {
      client: client(), collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, actionId: 'plan-continue', resourceRef: ref('g1'),
      input: { planId: 'p1' },
    });
    expect(service.continuePlan).toHaveBeenCalledWith({ groupId: 'g1', planId: 'p1' });

    service.startPlan.mockResolvedValue({ ok: false, errorCode: 'PLAN_CLOSED', message: '已经开始了' });
    await expect(remoteResourceRegistry.invoke(context, {
      client: client(), collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, actionId: 'plan-start', resourceRef: ref('g1'),
      input: { planId: 'p1' },
    })).rejects.toMatchObject({ code: 'INVALID_PARAMS', message: 'PLAN_CLOSED' });
  });

  it('never lets a phone set a folder or reach a hidden teammate', async () => {
    await remoteResourceRegistry.invoke(context, {
      client: client(), collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, actionId: 'update', resourceRef: ref('g1'),
      input: { name: '新名字', projectDir: '/etc', organizerBotId: 'abu' },
    });
    expect(service.updateGroup).toHaveBeenCalledWith({ groupId: 'g1', name: '新名字', organizerBotId: 'abu' });
    await expect(remoteResourceRegistry.invoke(context, {
      client: client(), collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, actionId: 'set-members', resourceRef: ref('g1'),
      input: { botIds: ['mimi', 'ghost'] },
    })).rejects.toMatchObject({ message: 'MEMBER_UNAVAILABLE' });
    expect(service.setMembers).not.toHaveBeenCalled();
    await expect(remoteResourceRegistry.invoke(context, {
      client: client(), collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, actionId: 'create',
      input: { name: '新群', botIds: ['mimi', 'ghost'] },
    })).rejects.toMatchObject({ message: 'MEMBER_UNAVAILABLE' });
    service.getGroup.mockResolvedValue({
      ok: true,
      group: detail({ members: [...summary().members, { botId: 'ghost', name: '隐藏', avatar: '', avatarColor: '', status: 'active' }] }),
    });
    await expect(remoteResourceRegistry.invoke(context, {
      client: client(), collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, actionId: 'stop', resourceRef: ref('g1'),
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(service.stopRound).not.toHaveBeenCalled();
  });

  it('passes a phone’s attachments on with the phone that sent them', async () => {
    const attachments = [{ id: 'a1', name: 'photo.jpg', path: 'cindy-peer-attach://x', category: 'image', mimeType: 'image/jpeg' }];
    await remoteResourceRegistry.invoke(context, {
      client: client(), collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, actionId: 'send', resourceRef: ref('g1'),
      input: { text: '', mentions: { all: false, botIds: [] }, clientId: 'c2', attachments },
    });
    expect(service.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'g1', text: '', clientId: 'c2', attachments }),
      { controllerDeviceId: 'phone-1' },
    );
  });

  it('shows attachments without host paths, and names them for older phones', async () => {
    const withAttachments = detail({
      messages: [{
        id: 'm1', sequence: 1, kind: 'message', authorKind: 'user', authorBotId: null, authorName: '', content: '',
        mentions: { all: false, botIds: [] }, noticeCode: null, planId: null, files: [], createdAt: 10,
        attachments: [
          { id: 'a1', name: 'photo.png', category: 'image', mimeType: 'image/png', size: 3, url: `cindy-media://blobs/${'a'.repeat(64)}.png`, path: null },
          { id: 'a2', name: '需求.pdf', category: 'pdf', mimeType: 'application/pdf', size: 4, url: null, path: '/Users/me/Desktop/需求.pdf' },
        ],
      }],
    });
    service.getGroup.mockResolvedValue({ ok: true, group: withAttachments });
    const rich = await remoteResourceRegistry.get(context, { client: client([BOT_GROUP_CHAT_PRIMITIVE]), ref: ref('g1') });
    const data = rich.blocks![0]!.data as ReturnType<typeof botGroupRemoteChatData>;
    expect(data.supportsAttachments).toBe(true);
    expect(data.messages[0]!.attachments.map((attachment) => [attachment.name, attachment.url, attachment.path])).toEqual([
      ['photo.png', `cindy-media://blobs/${'a'.repeat(64)}.png`, null],
      ['需求.pdf', null, null],
    ]);
    expect(JSON.stringify(rich)).not.toContain('/Users/me');
    const plain = await remoteResourceRegistry.get(context, { client: client(), ref: ref('g1') });
    expect(plain.blocks?.[0]?.fallbackMarkdown).toContain('📎 photo.png 📎 需求.pdf');
  });

  it('writes nothing once the computer has switched accounts during the checks', async () => {
    // The first owner check runs after the visibility reads; by then the account has changed.
    h.ownerCurrent = () => false;
    await expect(remoteResourceRegistry.invoke(context, {
      client: client(), collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, actionId: 'create',
      input: { name: '新群', botIds: ['mimi', 'abu'] },
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(service.createGroup).not.toHaveBeenCalled();
    await expect(remoteResourceRegistry.invoke(context, {
      client: client(), collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, actionId: 'set-members', resourceRef: ref('g1'),
      input: { botIds: ['mimi', 'abu'] },
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(service.setMembers).not.toHaveBeenCalled();
  });

  it('applies the same member rule to anything else a phone hears about a group', async () => {
    await expect(botGroupMembersVisibleRemotely(['mimi', 'abu'])).resolves.toBe(true);
    await expect(botGroupMembersVisibleRemotely(['mimi', 'ghost'])).resolves.toBe(false);
    await expect(botGroupMembersVisibleRemotely(['mimi', 'gone'])).resolves.toBe(false);
  });

  it('creates a group and navigates the phone to it', async () => {
    service.createGroup.mockResolvedValue({ ok: true, groupId: 'g9' });
    const created = await remoteResourceRegistry.invoke(context, {
      client: client(), collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, actionId: 'create',
      input: { name: '新群', botIds: ['mimi', 'abu'] },
    });
    expect(service.createGroup).toHaveBeenCalledWith({ name: '新群', botIds: ['mimi', 'abu'] });
    expect(created.effects).toEqual([
      { kind: 'refresh-collection', collectionId: BOT_GROUP_REMOTE_COLLECTION_ID },
      { kind: 'navigate', target: { kind: 'resource', ref: ref('g9') } },
    ]);
  });
});
