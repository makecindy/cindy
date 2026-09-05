import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  client: {} as { drizzle: unknown; tx: unknown },
  root: '',
  owner: 'owner-a',
  generate: vi.fn(),
  welcome: vi.fn(),
  broadcast: vi.fn(),
  prepareAvatar: vi.fn(),
  finishAvatar: vi.fn(),
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.owner,
  isAppSessionBoundaryPending: () => false,
  ownerScopedUserDataPath: () => h.root,
}));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => h.client }));
vi.mock('../../utility-model/oneShotCandidates.js', () => ({ requestUtilityText: h.generate }));
vi.mock('../../maker-host/index.js', () => ({ getMaker: () => ({}) }));
vi.mock('../../localDb/ipc/messages.js', () => ({ createMessage: h.welcome }));
vi.mock('../botInvitationAvatar.js', () => ({
  prepareBotInvitationAvatar: h.prepareAvatar,
  finishBotInvitationAvatar: h.finishAvatar,
}));
import { tx as runWorkerTx } from '../../localDb/worker/opHandlers/tx.js';
import { queueBotInvitation as enqueueBotInvitation } from '../botInvitation.js';
import { readBotSkill, seedBotSkillIfMissing } from '../botSkillStore.js';
import { readBotProfileFolder } from '../botProfileFolder.js';
import { parseBotInvitationDraft, botInvitationPrompt } from '../botInvitationDraft.js';

function queueBotInvitation(botId: string, retry = false): void {
  enqueueBotInvitation(botId, {
    createCanonicalSession: async () => ({ canonicalSessionId: 'chat-1' }),
    broadcastProfileChanged: h.broadcast,
  }, retry);
}

const draft = {
  background: '热爱网文的小说家，喜欢观察日常生活里的细节。',
  conversationStyle: '闲聊通常两三句话，轻松幽默；讨论情节时展开。',
  greeting: '你好，我是阿橙。最近在琢磨一个不肯按大纲走的主角。你喜欢什么样的故事？',
  avatarPrompt: 'A warm illustrated portrait of a novelist, square, simple background.',
  skills: [
    {
      slug: 'develop-characters',
      name: '人物小传',
      description: '构思人物时使用',
      body: '# 人物小传\n先确定欲望和恐惧，再设计矛盾。检查行动是否符合动机。',
    },
    {
      slug: 'outline-serial',
      name: '连载大纲',
      description: '规划连载时使用',
      body: '# 连载大纲\n确定主线与章节目标。检查伏笔回收、节奏和人物选择。',
    },
  ],
};
let sqlite: Database.Database;
function state() {
  const row = sqlite
    .prepare('SELECT capabilities_json FROM bot_profile_versions ORDER BY version DESC LIMIT 1')
    .get() as { capabilities_json: string };
  return JSON.parse(row.capabilities_json).invitation;
}
function seed(invitation: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  sqlite
    .prepare(
      "INSERT INTO bot_profiles (id,display_name,description,avatar,avatar_color,status,current_version,created_at,updated_at) VALUES ('bot-1','阿橙','一个热爱写网文的小说家','✦','amber','active',1,1,1)",
    )
    .run();
  sqlite
    .prepare("INSERT INTO bot_profile_versions VALUES ('bot-1:v1','bot-1',1,'original',?,1)")
    .run(
      JSON.stringify({
        ...config,
        invitation: {
          id: 'invitation-1',
          stage: 'profile',
          locale: 'zh-CN',
          avatarRequested: false,
          ...invitation,
        },
      }),
    );
}
beforeEach(async () => {
  vi.clearAllMocks();
  h.owner = 'owner-a';
  h.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-invitation-'));
  sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE bot_profiles (
    id TEXT PRIMARY KEY, display_name TEXT, description TEXT, avatar TEXT, avatar_color TEXT,
    status TEXT, hidden_at INTEGER, pinned_at INTEGER, attention_reason TEXT, attention_at INTEGER,
    current_version INTEGER, canonical_session_id TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE bot_profile_versions (id TEXT PRIMARY KEY, bot_id TEXT, version INTEGER,
      identity_source TEXT, capabilities_json TEXT, created_at INTEGER, UNIQUE(bot_id,version));
    CREATE TABLE bot_session_links (bot_id TEXT, profile_version INTEGER, role TEXT, archived_at INTEGER);
  `);
  h.client = {
    drizzle: drizzle(sqlite),
    tx: async (name: string, args: unknown) => runWorkerTx(sqlite, { name, args }),
  };
  h.generate.mockResolvedValue({ ok: true, text: JSON.stringify(draft) });
  h.welcome.mockResolvedValue({});
  h.prepareAvatar.mockResolvedValue(null);
});
afterEach(async () => {
  // All tests await a terminal checkpoint before disposing the database and files.
  await new Promise((resolve) => setTimeout(resolve, 0));
  sqlite.close();
  await fs.rm(h.root, { recursive: true, force: true });
});

describe('companion invitation with SQLite and real skill files', () => {
  it('prepares once, persists actual skills and voice, then greets the user', async () => {
    seed();
    queueBotInvitation('bot-1');
    queueBotInvitation('bot-1');
    await vi.waitFor(() => expect(state().stage).toBe('ready'));
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(await readBotSkill(h.root, 'bot-1', 'develop-characters')).toMatchObject(
      draft.skills[0],
    );
    expect((await readBotProfileFolder(h.root, 'bot-1')).identitySource).toContain(
      draft.conversationStyle,
    );
    expect(h.welcome).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ content: draft.greeting, clientId: 'bot-welcome:bot-1' }),
    );
    expect(state().draft).toBeUndefined();
    queueBotInvitation('bot-1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it('resumes a saved draft without generating again or overwriting an edited skill', async () => {
    seed({ stage: 'skills', draft });
    await seedBotSkillIfMissing(h.root, 'bot-1', { ...draft.skills[0]!, body: '用户自己的方法' });
    queueBotInvitation('bot-1');
    await vi.waitFor(() => expect(state().stage).toBe('ready'));
    expect(h.generate).not.toHaveBeenCalled();
    expect((await readBotSkill(h.root, 'bot-1', 'develop-characters'))?.body).toBe(
      '用户自己的方法',
    );
  });

  it('keeps a failed invitation and retries without creating another profile', async () => {
    seed();
    h.generate.mockResolvedValueOnce({ ok: false, reason: 'no_candidate' });
    queueBotInvitation('bot-1');
    await vi.waitFor(() => expect(state().stage).toBe('failed'));
    expect(h.welcome).not.toHaveBeenCalled();
    queueBotInvitation('bot-1', true);
    await vi.waitFor(() => expect(state().stage).toBe('ready'));
    expect(sqlite.prepare('SELECT count(*) AS n FROM bot_profiles').get()).toEqual({ n: 1 });
  });

  it.each(['cindy', 'dash', 'lizi'])(
    'prepares %s from bundled skills without a model request',
    async (templateId) => {
      seed({}, { templateId });
      queueBotInvitation('bot-1');
      await vi.waitFor(() => expect(state().stage).toBe('ready'));
      expect(h.generate).not.toHaveBeenCalled();
      const folder = await readBotProfileFolder(h.root, 'bot-1');
      expect(folder.identitySource).toContain('性格与聊天习惯');
      expect((await fs.readdir(path.join(h.root, 'bots', 'bot-1', 'skills'))).length).toBe(3);
    },
  );

  it('does not lose a prepared character when optional image generation is unavailable', async () => {
    seed({ avatarRequested: true });
    queueBotInvitation('bot-1');
    await vi.waitFor(() => expect(state()).toMatchObject({ stage: 'ready', avatarSkipped: true }));
    expect(sqlite.prepare('SELECT avatar FROM bot_profiles').get()).toEqual({ avatar: '✦' });
    expect(h.welcome).toHaveBeenCalledTimes(1);
  });

  it('retries an optional portrait without regenerating the character or greeting again', async () => {
    seed({ avatarRequested: true });
    queueBotInvitation('bot-1');
    await vi.waitFor(() => expect(state().stage).toBe('ready'));
    expect(state().avatarSkipped).toBe(true);
    queueBotInvitation('bot-1', true);
    await vi.waitFor(() => expect(h.prepareAvatar).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state().stage).toBe('ready'));
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.welcome).toHaveBeenCalledTimes(1);
  });

  it('resumes portrait-only preparation without returning to the welcome stage', async () => {
    seed({ stage: 'avatar', avatarRequested: true, avatarPrompt: draft.avatarPrompt });
    sqlite.prepare("UPDATE bot_profiles SET canonical_session_id = 'chat-1' WHERE id = 'bot-1'").run();
    queueBotInvitation('bot-1');
    await vi.waitFor(() => expect(state().stage).toBe('ready'));
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.welcome).not.toHaveBeenCalled();
    expect(state().avatarSkipped).toBe(true);
  });

  it('keeps an avatar chosen by the user while AI artwork was in flight', async () => {
    seed({ avatarRequested: true });
    h.prepareAvatar.mockResolvedValueOnce('image-1');
    h.finishAvatar.mockImplementationOnce(async () => {
      sqlite.prepare("UPDATE bot_profiles SET avatar = 'user-upload' WHERE id = 'bot-1'").run();
      return { url: 'ai-portrait', hash: 'a'.repeat(64) };
    });
    queueBotInvitation('bot-1');
    await vi.waitFor(() => expect(state().stage).toBe('ready'));
    expect(sqlite.prepare('SELECT avatar FROM bot_profiles').get()).toEqual({
      avatar: 'user-upload',
    });
  });

  it('resumes an interrupted image through its saved Core invocation, never preparing another', async () => {
    seed({
      stage: 'avatar',
      draft,
      avatarRequested: true,
      avatarInvocationId: 'image-1',
    });
    h.finishAvatar.mockRejectedValueOnce(new Error('outcome unknown'));
    queueBotInvitation('bot-1');
    await vi.waitFor(() => expect(state().stage).toBe('ready'));
    expect(h.prepareAvatar).not.toHaveBeenCalled();
    expect(h.finishAvatar).toHaveBeenCalledWith(
      'image-1',
      draft.avatarPrompt,
      expect.any(Function),
      h.client.drizzle,
    );
  });

  it('discards a late model result after account switch', async () => {
    seed();
    let finish!: (value: unknown) => void;
    h.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    queueBotInvitation('bot-1');
    await vi.waitFor(() => expect(h.generate).toHaveBeenCalled());
    h.owner = 'owner-b';
    finish({ ok: true, text: JSON.stringify(draft) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state().stage).toBe('profile');
    expect(h.welcome).not.toHaveBeenCalled();
    expect(await fs.readdir(h.root)).toEqual([]);
  });
});

describe('generated character validation', () => {
  it('keeps the sketch as quoted input and accepts a complete role-specific draft', () => {
    expect(botInvitationPrompt('阿橙', '一个热爱写网文的小说家', 'zh-CN')).toContain(
      JSON.stringify({ name: '阿橙', introduction: '一个热爱写网文的小说家' }),
    );
    expect(parseBotInvitationDraft(JSON.stringify(draft))).toEqual(draft);
  });
  it.each([
    { ...draft, skills: [{ ...draft.skills[0], slug: '../../other' }, draft.skills[1]] },
    { ...draft, skills: [draft.skills[0], draft.skills[0]] },
    { ...draft, skills: [] },
    { ...draft, conversationStyle: '' },
  ])('rejects incomplete or unsafe drafts before installing anything', (value) => {
    expect(() => parseBotInvitationDraft(JSON.stringify(value))).toThrow();
  });
});
