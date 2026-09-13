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
import { queueBotInvitation as enqueueBotInvitation, setBotInvitationWelcomeDispatch } from '../botInvitation.js';
import { readBotSkill, seedBotSkillIfMissing } from '../botSkillStore.js';
import { readBotProfileFolder } from '../botProfileFolder.js';
import { parseBotInvitationDraft, botInvitationPrompt } from '../botInvitationDraft.js';
import { getSelectedNewMakerRoute, setNewMakerDraftCache } from '../../maker-host/newMakerDefaultsCache.js';
import { createIpcError } from '../../../shared/ipc-errors.js';

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
  h.welcome.mockResolvedValue({ ok: true });
  setBotInvitationWelcomeDispatch(h.welcome);
  h.prepareAvatar.mockResolvedValue(null);
});
afterEach(async () => {
  // All tests await a terminal checkpoint before disposing the database and files.
  await new Promise((resolve) => setTimeout(resolve, 0));
  sqlite.close();
  await fs.rm(h.root, { recursive: true, force: true });
});

describe('companion invitation with SQLite and real skill files', () => {
  it('resumes a waiting welcome on the user default mirror without another roster read', async () => {
    const mirror = (selectedRoute?: NonNullable<ReturnType<typeof getSelectedNewMakerRoute>>) =>
      setNewMakerDraftCache({ selectedRoute, lastByVendor: {}, fastModeByModel: {}, effortByModel: {} }, h.owner);
    mirror();
    seed({ stage: 'welcome' });
    const createCanonicalSession = vi.fn(async () => ({ canonicalSessionId: 'chat-1' }));
    const canStartWelcome = vi.fn(async () => Boolean(getSelectedNewMakerRoute(h.owner)));
    enqueueBotInvitation('bot-1', { canStartWelcome, createCanonicalSession, broadcastProfileChanged: h.broadcast });
    await vi.waitFor(() => expect(canStartWelcome).toHaveBeenCalledOnce());
    expect(state().stage).toBe('welcome');
    expect(createCanonicalSession).not.toHaveBeenCalled();
    expect(h.welcome).not.toHaveBeenCalled();
    const selected = { harness: 'codex' as const, providerId: 'user-provider', model: 'user-selected-model', effort: 'low', fastMode: true };
    mirror(selected);
    await vi.waitFor(() => expect(state().stage).toBe('ready'));
    mirror(selected);
    expect(getSelectedNewMakerRoute(h.owner)).toEqual(selected);
    expect(createCanonicalSession).toHaveBeenCalledOnce();
    expect(h.welcome).toHaveBeenCalledOnce();
    expect(h.generate).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'mirror pending'])('retains %s readiness until it changes without a default notification', async reason => {
    vi.useFakeTimers();
    try {
      seed({ stage: 'welcome' });
      let ready = false;
      const canStartWelcome = vi.fn(async () => {
        if (!ready && reason === 'mirror pending') throw createIpcError('MODEL_VISIBILITY_NOT_READY', 'pending');
        return ready;
      });
      const createCanonicalSession = vi.fn(async () => ({ canonicalSessionId: 'chat-1' }));
      enqueueBotInvitation('bot-1', { canStartWelcome, createCanonicalSession, broadcastProfileChanged: h.broadcast });
      await vi.advanceTimersByTimeAsync(0);
      expect(canStartWelcome).toHaveBeenCalledOnce();
      expect(state().stage).toBe('welcome');
      await vi.advanceTimersByTimeAsync(4999);
      expect(canStartWelcome).toHaveBeenCalledOnce();
      expect(createCanonicalSession).not.toHaveBeenCalled();
      ready = true;
      await vi.advanceTimersByTimeAsync(1);
      expect(state().stage).toBe('ready');
      expect(h.welcome).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('does not lose readiness changes arriving during the asynchronous check', async () => {
    vi.useFakeTimers();
    try {
      seed({ stage: 'welcome' });
      let finish!: (ready: boolean) => void;
      const canStartWelcome = vi.fn().mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }))
        .mockResolvedValue(true);
      enqueueBotInvitation('bot-1', { canStartWelcome, createCanonicalSession: async () => ({ canonicalSessionId: 'chat-1' }), broadcastProfileChanged: h.broadcast });
      await vi.advanceTimersByTimeAsync(0);
      setNewMakerDraftCache({ lastByVendor: {}, fastModeByModel: {}, effortByModel: {} }, h.owner);
      finish(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(state().stage).toBe('welcome');
      await vi.advanceTimersByTimeAsync(5000);
      expect(state().stage).toBe('ready');
      expect(h.welcome).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(['owner changed', 'archived'])('drops a model waiter when its profile is %s', async reason => {
    vi.useFakeTimers();
    try {
      seed({ stage: 'welcome' });
      const createCanonicalSession = vi.fn(async () => ({ canonicalSessionId: 'chat-1' }));
      const canStartWelcome = vi.fn(async () => false);
      enqueueBotInvitation('bot-1', { canStartWelcome, createCanonicalSession, broadcastProfileChanged: h.broadcast });
      await vi.advanceTimersByTimeAsync(0);
      if (reason === 'owner changed') h.owner = 'owner-b';
      else sqlite.prepare("UPDATE bot_profiles SET status = 'archived'").run();
      await vi.advanceTimersByTimeAsync(5000);
      expect(createCanonicalSession).not.toHaveBeenCalled();
      expect(h.welcome).not.toHaveBeenCalled();
      expect(state().stage).toBe('welcome');
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('releases worker slots while other invitations are waiting for a model', async () => {
    vi.useFakeTimers();
    try {
      seed({ stage: 'welcome' });
      for (const id of ['bot-2', 'bot-3']) {
        sqlite.prepare("INSERT INTO bot_profiles (id,status,current_version) VALUES (?,'active',1)").run(id);
        sqlite.prepare("INSERT INTO bot_profile_versions SELECT ?,?,1,identity_source,capabilities_json,1 FROM bot_profile_versions WHERE bot_id='bot-1'").run(`${id}:v1`, id);
      }
      for (const id of ['bot-1', 'bot-2', 'bot-3']) {
        enqueueBotInvitation(id, { canStartWelcome: async () => id === 'bot-3',
          createCanonicalSession: async () => ({ canonicalSessionId: 'chat-3' }), broadcastProfileChanged: h.broadcast });
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(h.welcome).toHaveBeenCalledOnce();
      expect(h.welcome).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'bot-welcome:bot-3' }));
      sqlite.prepare("UPDATE bot_profiles SET status='archived' WHERE id != 'bot-3'").run();
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.welcome).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('keeps cold-start recovery pending until the welcome dispatcher is registered', async () => {
    vi.resetModules();
    const cold = await import('../botInvitation.js');
    seed({ stage: 'welcome' }, { modelChain: [{ harness: 'codex', providerId: 'user-provider', model: 'user-model' }] });
    const createCanonicalSession = vi.fn(async () => ({ canonicalSessionId: 'chat-1' }));
    cold.queueBotInvitation('bot-1', { canStartWelcome: async () => true, createCanonicalSession, broadcastProfileChanged: h.broadcast });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(state().stage).toBe('welcome');
    expect(createCanonicalSession).not.toHaveBeenCalled();
    cold.setBotInvitationWelcomeDispatch(h.welcome);
    await vi.waitFor(() => expect(state().stage).toBe('ready'));
    expect(createCanonicalSession).toHaveBeenCalledOnce();
    expect(h.welcome).toHaveBeenCalledOnce();
  });

  it('preserves a saved draft on upgrade, then greets through the actual runtime', async () => {
    seed({ draft });
    queueBotInvitation('bot-1');
    queueBotInvitation('bot-1');
    await vi.waitFor(() => expect(state().stage).toBe('ready'));
    expect(h.generate).not.toHaveBeenCalled();
    expect(await readBotSkill(h.root, 'bot-1', 'develop-characters')).toMatchObject(
      draft.skills[0],
    );
    expect((await readBotProfileFolder(h.root, 'bot-1')).identitySource).toContain(
      draft.conversationStyle,
    );
    expect(h.welcome).toHaveBeenCalledWith(
      expect.objectContaining({ targetSessionId: 'chat-1', clientId: 'bot-welcome:bot-1', message: expect.stringContaining('current identity and memory') }),
    );
    expect(h.welcome.mock.calls[0][0].persistedContent).not.toContain(draft.greeting);
    expect(state().draft).toBeUndefined();
    queueBotInvitation('bot-1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.generate).not.toHaveBeenCalled();
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
    h.welcome.mockResolvedValueOnce({ ok: false });
    queueBotInvitation('bot-1');
    await vi.waitFor(() => expect(state().stage).toBe('failed'));
    expect(h.welcome).toHaveBeenCalledTimes(1);
    queueBotInvitation('bot-1', true);
    await vi.waitFor(() => expect(state().stage).toBe('ready'));
    expect(sqlite.prepare('SELECT count(*) AS n FROM bot_profiles').get()).toEqual({ n: 1 });
  });

  it.each(['cindy', 'dash', 'lizi'])(
    'resumes a saved %s invitation without replacing its identity or installing a template',
    async (templateId) => {
      seed({}, { templateId });
      sqlite.prepare('UPDATE bot_profile_versions SET identity_source = ?').run('用户已经修改的人设');
      queueBotInvitation('bot-1');
      await vi.waitFor(() => expect(state().stage).toBe('ready'));
      expect(h.generate).not.toHaveBeenCalled();
      const folder = await readBotProfileFolder(h.root, 'bot-1');
      expect(folder.identitySource).toBe('用户已经修改的人设');
      expect((await fs.readdir(path.join(h.root, 'bots', 'bot-1', 'skills'))).length).toBe(0);
    },
  );

  it('does not lose a prepared character when optional image generation is unavailable', async () => {
    seed({ avatarRequested: true, avatarPrompt: draft.avatarPrompt });
    queueBotInvitation('bot-1');
    await vi.waitFor(() => expect(state()).toMatchObject({ stage: 'ready', avatarSkipped: true }));
    expect(sqlite.prepare('SELECT avatar FROM bot_profiles').get()).toEqual({ avatar: '✦' });
    expect(h.welcome).toHaveBeenCalledTimes(1);
  });

  it('retries an optional portrait without regenerating the character or greeting again', async () => {
    seed({ avatarRequested: true, avatarPrompt: draft.avatarPrompt });
    queueBotInvitation('bot-1');
    await vi.waitFor(() => expect(state().stage).toBe('ready'));
    expect(state().avatarSkipped).toBe(true);
    queueBotInvitation('bot-1', true);
    await vi.waitFor(() => expect(h.prepareAvatar).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state().stage).toBe('ready'));
    expect(h.generate).not.toHaveBeenCalled();
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
    seed({ avatarRequested: true, avatarPrompt: draft.avatarPrompt });
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

  it('creates from a name without generating a profile or padding Skills', async () => {
    seed();
    queueBotInvitation('bot-1');
    await vi.waitFor(() => expect(state().stage).toBe('ready'));
    expect(h.generate).not.toHaveBeenCalled();
    expect(await readBotSkill(h.root, 'bot-1', 'develop-characters')).toBeNull();
    expect((await readBotProfileFolder(h.root, 'bot-1')).identitySource).toContain('original');
    expect(h.welcome).toHaveBeenCalledTimes(1);
  });

  it('discards artwork after an account switch without greeting the new account', async () => {
    seed({ stage: 'avatar', avatarRequested: true, avatarPrompt: draft.avatarPrompt, avatarInvocationId: 'image-1' });
    let finish!: (value: unknown) => void;
    h.finishAvatar.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    queueBotInvitation('bot-1');
    await vi.waitFor(() => expect(h.finishAvatar).toHaveBeenCalled());
    h.owner = 'owner-b';
    finish({ url: 'ai-portrait', hash: 'a'.repeat(64) });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(state().stage).toBe('avatar');
    expect(h.welcome).not.toHaveBeenCalled();
  });
});

describe('generated character validation', () => {
  it.each([{ skills: [] }, { skills: [draft.skills[0]] }])('accepts only the methods the character needs', ({ skills }) => {
    const { greeting, ...withoutGreeting } = draft;
    expect(parseBotInvitationDraft(JSON.stringify({ ...withoutGreeting, skills })).skills).toEqual(skills);
  });
  it('keeps the sketch as quoted input and accepts a complete role-specific draft', () => {
    expect(botInvitationPrompt('阿橙', '一个热爱写网文的小说家', 'zh-CN')).toContain(
      JSON.stringify({ name: '阿橙', introduction: '一个热爱写网文的小说家' }),
    );
    expect(parseBotInvitationDraft(JSON.stringify(draft))).toEqual(draft);
  });
  it.each([
    { ...draft, skills: [{ ...draft.skills[0], slug: '../../other' }, draft.skills[1]] },
    { ...draft, skills: [draft.skills[0], draft.skills[0]] },
    { ...draft, conversationStyle: '' },
  ])('rejects incomplete or unsafe drafts before installing anything', (value) => {
    expect(() => parseBotInvitationDraft(JSON.stringify(value))).toThrow();
  });
});
