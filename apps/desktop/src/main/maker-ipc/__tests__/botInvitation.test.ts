import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// These checkpoints include real filesystem I/O, not a one-second performance contract.
// Use the existing platform test budget; vi.waitFor otherwise defaults to only 1000 ms.
let ioTimeout: number;
function waitForIo(assertion: () => unknown) {
  return vi.waitFor(assertion, { timeout: ioTimeout });
}

const h = vi.hoisted(() => ({
  client: {} as { drizzle: unknown; tx: unknown },
  root: '',
  owner: 'owner-a',
  userName: 'Chris' as string | null | undefined,
  generate: vi.fn(),
  auxiliary: vi.fn(),
  createMessage: vi.fn(),
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
vi.mock('../../maker-host/auxiliary-title-one-shot.js', () => ({ requestAuxiliaryText: h.auxiliary }));
vi.mock('../../maker-host/index.js', () => ({ getMaker: () => ({}) }));
vi.mock('../../localDb/ipc/messages.js', () => ({ createMessage: h.createMessage }));
vi.mock('../../device-link/broadcast-tap.js', () => ({ captureDataOwnerBroadcastScope: () => undefined }));
vi.mock('../botInvitationAvatar.js', () => ({
  prepareBotInvitationAvatar: h.prepareAvatar,
  finishBotInvitationAvatar: h.finishAvatar,
}));
import { tx as runWorkerTx } from '../../localDb/worker/opHandlers/tx.js';
import { buildStaticBotGreeting, queueBotInvitation as enqueueBotInvitation } from '../botInvitation.js';
import { readBotSkill, seedBotSkillIfMissing } from '../botSkillStore.js';
import { readBotProfileFolder } from '../botProfileFolder.js';
import { parseBotInvitationDraft, botInvitationPrompt } from '../botInvitationDraft.js';
import { getSelectedNewMakerRoute, setNewMakerDraftCache } from '../../maker-host/newMakerDefaultsCache.js';
import { createIpcError } from '../../../shared/ipc-errors.js';
import { SUPPORTED_LOCALES } from '../../../shared/locale.js';

function queueBotInvitation(botId: string, retry = false): void {
  enqueueBotInvitation(botId, {
    createCanonicalSession: async () => ({ canonicalSessionId: 'chat-1' }),
    broadcastProfileChanged: h.broadcast,
    getUserName: () => h.userName,
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
function seed(invitation: Record<string, unknown> = {}, config: Record<string, unknown> = {}, displayName = '阿橙') {
  sqlite
    .prepare(
      "INSERT INTO bot_profiles (id,display_name,description,avatar,avatar_color,status,current_version,created_at,updated_at) VALUES ('bot-1',?,'一个热爱写网文的小说家','✦','amber','active',1,1,1)",
    )
    .run(displayName);
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
const written = () => h.createMessage.mock.calls.map(([, body]) => body);

beforeEach(async ({ task }) => {
  ioTimeout = task.timeout;
  vi.clearAllMocks();
  h.createMessage.mockReset().mockResolvedValue(undefined);
  h.owner = 'owner-a';
  h.userName = 'Chris';
  h.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-invitation-'));
  sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE bot_profiles (
    id TEXT PRIMARY KEY, display_name TEXT, description TEXT, avatar TEXT, avatar_color TEXT,
    status TEXT, hidden_at INTEGER, pinned_at INTEGER, attention_reason TEXT, attention_at INTEGER,
    current_version INTEGER, canonical_session_id TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE bot_profile_versions (id TEXT PRIMARY KEY, bot_id TEXT, version INTEGER,
      identity_source TEXT, capabilities_json TEXT, created_at INTEGER, UNIQUE(bot_id,version));
    CREATE TABLE bot_session_links (bot_id TEXT, profile_version INTEGER, role TEXT, archived_at INTEGER);
    CREATE TABLE messages (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_kind TEXT);
    INSERT INTO sessions (id, agent_kind) VALUES ('chat-1', 'codex');
  `);
  h.client = {
    drizzle: drizzle(sqlite),
    tx: async (name: string, args: unknown) => runWorkerTx(sqlite, { name, args }),
  };
  h.generate.mockResolvedValue({ ok: true, text: JSON.stringify(draft) });
  h.prepareAvatar.mockResolvedValue(null);
});
afterEach(async () => {
  // All tests await a terminal checkpoint before disposing the database and files.
  await new Promise((resolve) => setTimeout(resolve, 0));
  sqlite.close();
  await fs.rm(h.root, { recursive: true, force: true });
});

describe('buildStaticBotGreeting', () => {
  it('greets the user by name and introduces the companion across locales with clean CJK-Latin spacing', () => {
    expect(buildStaticBotGreeting({ botName: 'Cindy', userName: 'Chris', locale: 'zh-CN' }))
      .toBe('嗨，Chris，我是 Cindy。有事直接跟我说。');
    expect(buildStaticBotGreeting({ botName: '小满', userName: 'Chris', locale: 'zh-CN' }))
      .toBe('嗨，Chris，我是小满。有事直接跟我说。');
    expect(buildStaticBotGreeting({ botName: 'Cindy', userName: null, locale: 'zh-CN' }))
      .toBe('嗨，我是 Cindy。有事直接跟我说。');
    expect(buildStaticBotGreeting({ botName: 'Cindy', userName: 'Chris', locale: 'en' }))
      .toBe('Hi Chris, I’m Cindy. Just tell me what you need.');
    expect(buildStaticBotGreeting({ botName: 'Cindy', userName: '', locale: 'en' }))
      .toBe('Hi, I’m Cindy. Just tell me what you need.');
    expect(buildStaticBotGreeting({ botName: 'Cindy', userName: 'Chris', locale: 'zh-Hans-x-lzh' }))
      .toBe('Chris 安好，吾乃 Cindy。有事径与吾言。');
    expect(buildStaticBotGreeting({ botName: '小满', userName: '明远', locale: 'zh-Hans-x-lzh' }))
      .toBe('明远安好，吾乃小满。有事径与吾言。');
  });

  it('sanitizes control characters and preserves literal dollar patterns in names', () => {
    expect(buildStaticBotGreeting({ botName: '$&Bot\nTwo', userName: '  A$$B\r\nC  ', locale: 'en' }))
      .toBe('Hi A$$B C, I’m $&Bot Two. Just tell me what you need.');
  });

  it.each([
    ...SUPPORTED_LOCALES.map(locale => [locale] as const),
    [undefined] as const,
    ['not a locale'] as const,
  ])('renders non-empty greeting without unresolved placeholders for locale %s', locale => {
    for (const userName of ['Chris', undefined]) {
      const text = buildStaticBotGreeting({ botName: 'Cindy', userName, locale });
      expect(text.length).toBeGreaterThan(4);
      expect(text).toContain('Cindy');
      if (userName) expect(text).toContain(userName);
      expect(text).not.toMatch(/\{\{.*\}\}/);
    }
  });
});

describe('companion invitation with SQLite and real skill files', () => {
  it('resumes a waiting welcome on the user default mirror without another roster read', async () => {
    const mirror = (selectedRoute?: NonNullable<ReturnType<typeof getSelectedNewMakerRoute>>) =>
      setNewMakerDraftCache({ selectedRoute, lastByVendor: {}, fastModeByModel: {}, effortByModel: {} }, h.owner);
    mirror();
    seed({ stage: 'welcome' });
    const createCanonicalSession = vi.fn(async () => ({ canonicalSessionId: 'chat-1' }));
    const canStartWelcome = vi.fn(async () => Boolean(getSelectedNewMakerRoute(h.owner)));
    enqueueBotInvitation('bot-1', { canStartWelcome, createCanonicalSession, broadcastProfileChanged: h.broadcast, getUserName: () => h.userName });
    await waitForIo(() => expect(canStartWelcome).toHaveBeenCalledOnce());
    expect(state().stage).toBe('welcome');
    expect(createCanonicalSession).not.toHaveBeenCalled();
    expect(h.createMessage).not.toHaveBeenCalled();
    const selected = { harness: 'codex' as const, providerId: 'user-provider', model: 'user-selected-model', effort: 'low', fastMode: true };
    mirror(selected);
    await waitForIo(() => expect(state().stage).toBe('ready'));
    mirror(selected);
    expect(getSelectedNewMakerRoute(h.owner)).toEqual(selected);
    expect(createCanonicalSession).toHaveBeenCalledOnce();
    expect(h.createMessage).toHaveBeenCalledOnce();
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.auxiliary).not.toHaveBeenCalled();
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
      expect(h.createMessage).toHaveBeenCalledOnce();
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
      expect(h.createMessage).toHaveBeenCalledOnce();
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
      expect(h.createMessage).not.toHaveBeenCalled();
      expect(state().stage).toBe('welcome');
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('releases worker slots while other invitations are waiting for a model', async () => {
    vi.useFakeTimers();
    try {
      seed({ stage: 'welcome' });
      for (const id of ['bot-2', 'bot-3']) {
        sqlite.prepare("INSERT INTO bot_profiles (id,display_name,status,current_version) VALUES (?,'Cindy','active',1)").run(id);
        sqlite.prepare("INSERT INTO bot_profile_versions SELECT ?,?,1,identity_source,capabilities_json,1 FROM bot_profile_versions WHERE bot_id='bot-1'").run(`${id}:v1`, id);
      }
      for (const id of ['bot-1', 'bot-2', 'bot-3']) {
        enqueueBotInvitation(id, { canStartWelcome: async () => id === 'bot-3',
          createCanonicalSession: async () => ({ canonicalSessionId: 'chat-3' }), broadcastProfileChanged: h.broadcast, getUserName: () => 'Chris' });
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(h.createMessage).toHaveBeenCalledOnce();
      expect(h.createMessage).toHaveBeenCalledWith('chat-3', {
        clientId: 'bot-opening:invitation-1',
        role: 'assistant',
        agentKind: null,
        content: '嗨，Chris，我是 Cindy。有事直接跟我说。',
      }, expect.objectContaining({ requireNoUserMessage: true }));
      sqlite.prepare("UPDATE bot_profiles SET status='archived' WHERE id != 'bot-3'").run();
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.createMessage).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each([
    ['zh-CN', 'Cindy', 'Chris', '嗨，Chris，我是 Cindy。有事直接跟我说。'],
    ['en', 'Cindy', 'Chris', 'Hi Chris, I’m Cindy. Just tell me what you need.'],
    ['en', 'Cindy', undefined, 'Hi, I’m Cindy. Just tell me what you need.'],
    ['zh-Hans-x-lzh', '小满', '明远', '明远安好，吾乃小满。有事径与吾言。'],
    [undefined, 'Cindy', 'Chris', 'Hi Chris, I’m Cindy. Just tell me what you need.'],
    ['not a locale', 'Cindy', 'Chris', 'Hi Chris, I’m Cindy. Just tell me what you need.'],
  ])('writes static greeting directly in locale %s without calling any model', async (locale, botName, userName, expected) => {
    h.userName = userName;
    seed({ locale }, {}, botName);
    queueBotInvitation('bot-1');
    await waitForIo(() => expect(state().stage).toBe('ready'));
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.auxiliary).not.toHaveBeenCalled();
    expect(h.createMessage).toHaveBeenCalledOnce();
    expect(h.createMessage).toHaveBeenCalledWith('chat-1', {
      clientId: 'bot-opening:invitation-1',
      role: 'assistant',
      agentKind: null,
      content: expected,
    }, expect.objectContaining({ requireNoUserMessage: true }));
    expect(state().welcomeContext).toBeUndefined();
    expect(state().welcomeClientId).toBeUndefined();
  });

  it('preserves a saved draft on upgrade, then writes the static opening without trusting draft.greeting', async () => {
    seed({ draft, welcomeContext: { projects: ['Puzzle Studio'], tasks: [], automations: [] } });
    queueBotInvitation('bot-1');
    queueBotInvitation('bot-1');
    await waitForIo(() => expect(state().stage).toBe('ready'));
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.auxiliary).not.toHaveBeenCalled();
    expect(await readBotSkill(h.root, 'bot-1', 'develop-characters')).toMatchObject(
      draft.skills[0],
    );
    expect((await readBotProfileFolder(h.root, 'bot-1')).identitySource).toContain(
      draft.conversationStyle,
    );
    expect(written()).toEqual([{
      clientId: 'bot-opening:invitation-1',
      role: 'assistant',
      agentKind: null,
      content: '嗨，Chris，我是阿橙。有事直接跟我说。',
    }]);
    expect(written()[0]!.content).not.toContain(draft.greeting);
    expect(state().draft).toBeUndefined();
    expect(state().welcomeContext).toBeUndefined();
    queueBotInvitation('bot-1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('resumes a saved draft without generating again or overwriting an edited skill', async () => {
    seed({ stage: 'skills', draft });
    await seedBotSkillIfMissing(h.root, 'bot-1', { ...draft.skills[0]!, body: '用户自己的方法' });
    queueBotInvitation('bot-1');
    await waitForIo(() => expect(state().stage).toBe('ready'));
    expect(h.generate).not.toHaveBeenCalled();
    expect((await readBotSkill(h.root, 'bot-1', 'develop-characters'))?.body).toBe(
      '用户自己的方法',
    );
  });

  it('retries transient opening write failures and recovers on explicit retry after three failures', async () => {
    vi.useFakeTimers();
    try {
      seed({ stage: 'welcome' });
      h.createMessage.mockRejectedValue(new Error('locked'));
      queueBotInvitation('bot-1');
      await vi.advanceTimersByTimeAsync(0);
      expect(state().stage).toBe('welcome');
      await vi.advanceTimersByTimeAsync(5000);
      expect(state().stage).toBe('welcome');
      await vi.advanceTimersByTimeAsync(5000);
      expect(state().stage).toBe('failed');
      expect(h.createMessage).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }

    h.createMessage.mockResolvedValueOnce(undefined);
    queueBotInvitation('bot-1', true);
    await waitForIo(() => expect(state().stage).toBe('ready'));
    expect(h.createMessage).toHaveBeenCalledTimes(4);
    expect(sqlite.prepare('SELECT count(*) AS n FROM bot_profiles').get()).toEqual({ n: 1 });
  });

  it('skips writing the static greeting when the user wins the write race', async () => {
    h.createMessage.mockImplementationOnce(async (_sessionId, _body, opts) => {
      expect(opts.requireNoUserMessage).toBe(true);
      throw Object.assign(new Error('User already spoke'), { code: 'MESSAGE_USER_ALREADY_SPOKE' });
    });
    seed({ stage: 'welcome' });
    queueBotInvitation('bot-1');
    await waitForIo(() => expect(state().stage).toBe('ready'));
    expect(h.createMessage).toHaveBeenCalledOnce();
  });

  it.each(['cindy', 'dash', 'lizi'])(
    'resumes a saved %s invitation without replacing its identity or installing a template',
    async (templateId) => {
      seed({}, { templateId });
      sqlite.prepare('UPDATE bot_profile_versions SET identity_source = ?').run('用户已经修改的人设');
      queueBotInvitation('bot-1');
      await waitForIo(() => expect(state().stage).toBe('ready'));
      expect(h.generate).not.toHaveBeenCalled();
      const folder = await readBotProfileFolder(h.root, 'bot-1');
      expect(folder.identitySource).toBe('用户已经修改的人设');
      expect((await fs.readdir(path.join(h.root, 'bots', 'bot-1', 'skills'))).length).toBe(0);
    },
  );

  it('does not lose a prepared character when optional image generation is unavailable', async () => {
    seed({ avatarRequested: true, avatarPrompt: draft.avatarPrompt });
    queueBotInvitation('bot-1');
    await waitForIo(() => expect(state()).toMatchObject({ stage: 'ready', avatarSkipped: true }));
    expect(sqlite.prepare('SELECT avatar FROM bot_profiles').get()).toEqual({ avatar: '✦' });
    expect(h.createMessage).toHaveBeenCalledTimes(1);
  });

  it('retries an optional portrait without regenerating the character or greeting again', async () => {
    seed({ avatarRequested: true, avatarPrompt: draft.avatarPrompt });
    queueBotInvitation('bot-1');
    await waitForIo(() => expect(state().stage).toBe('ready'));
    expect(state().avatarSkipped).toBe(true);
    queueBotInvitation('bot-1', true);
    await waitForIo(() => expect(h.prepareAvatar).toHaveBeenCalledTimes(2));
    await waitForIo(() => expect(state().stage).toBe('ready'));
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.createMessage).toHaveBeenCalledTimes(1);
  });

  it('resumes portrait-only preparation without returning to the welcome stage', async () => {
    seed({ stage: 'avatar', avatarRequested: true, avatarPrompt: draft.avatarPrompt });
    sqlite.prepare("UPDATE bot_profiles SET canonical_session_id = 'chat-1' WHERE id = 'bot-1'").run();
    queueBotInvitation('bot-1');
    await waitForIo(() => expect(state().stage).toBe('ready'));
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.createMessage).not.toHaveBeenCalled();
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
    await waitForIo(() => expect(state().stage).toBe('ready'));
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
    await waitForIo(() => expect(state().stage).toBe('ready'));
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
    await waitForIo(() => expect(state().stage).toBe('ready'));
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.auxiliary).not.toHaveBeenCalled();
    expect(await readBotSkill(h.root, 'bot-1', 'develop-characters')).toBeNull();
    expect((await readBotProfileFolder(h.root, 'bot-1')).identitySource).toContain('original');
    expect(h.createMessage).toHaveBeenCalledTimes(1);
  });

  it('discards artwork after an account switch without greeting the new account', async () => {
    seed({ stage: 'avatar', avatarRequested: true, avatarPrompt: draft.avatarPrompt, avatarInvocationId: 'image-1' });
    let finish!: (value: unknown) => void;
    h.finishAvatar.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    queueBotInvitation('bot-1');
    await waitForIo(() => expect(h.finishAvatar).toHaveBeenCalled());
    h.owner = 'owner-b';
    finish({ url: 'ai-portrait', hash: 'a'.repeat(64) });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(state().stage).toBe('avatar');
    expect(h.createMessage).not.toHaveBeenCalled();
  });
});

describe('generated character validation', () => {
  it.each([{ skills: [] }, { skills: [draft.skills[0]] }])('accepts only the methods the character needs', ({ skills }) => {
    expect(parseBotInvitationDraft(JSON.stringify({ ...draft, greeting: undefined, skills })).skills).toEqual(skills);
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

describe('Bot Market package opening', () => {
  const opening = { welcome: '你好，我能帮你跟进代码改动。你现在想推进哪个项目？', capabilities: ['跟进代码进展', '核对检查结果', '整理交付证据'],
    onboardingSkill: 'engineer-bot-getting-started', starterOptions: ['跟进一个进行中的 PR/MR', '拆分一个需求', '检查当前分支能不能交付'] };
  const scripted = '你好，我能帮你跟进代码改动。\n\n- 跟进一个进行中的 PR/MR\n- 拆分一个需求\n- 检查当前分支能不能交付';

  it('writes the authored package opening directly with starter options and no model calls', async () => {
    seed({ id: 'import-welcome:req-1', stage: 'welcome', opening });
    queueBotInvitation('bot-1');
    await waitForIo(() => expect(state().opening).toBeUndefined());
    expect(h.auxiliary).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.createMessage).toHaveBeenCalledOnce();
    expect(h.createMessage).toHaveBeenCalledWith('chat-1', {
      clientId: 'bot-opening:import-welcome:req-1', role: 'assistant', agentKind: null,
      content: scripted,
      agentMeta: { botStarterOptions: opening.starterOptions } }, expect.objectContaining({ requireNoUserMessage: true }));
    expect(state()).toMatchObject({ stage: 'ready' });
  });

  it('writes localized package opening directly without Chinese capsules when invited in English', async () => {
    const localized = { ...opening, welcome: 'Hello! I can follow your code changes. Which project do you want to move forward?',
      starterOptions: ['Follow an open PR/MR', 'Split a requirement', 'Check the branch'] };
    seed({ id: 'import-welcome:req-1', stage: 'welcome', opening: localized, locale: 'en' });
    queueBotInvitation('bot-1');
    await waitForIo(() => expect(state().opening).toBeUndefined());
    expect(h.auxiliary).not.toHaveBeenCalled();
    expect(written()).toEqual([{ clientId: 'bot-opening:import-welcome:req-1', role: 'assistant', agentKind: null,
      content: 'Hello! I can follow your code changes.\n\n- Follow an open PR/MR\n- Split a requirement\n- Check the branch',
      agentMeta: { botStarterOptions: localized.starterOptions } }]);
    expect(written()[0]!.content).not.toMatch(/[\u3400-\u9fff]/);
  });

  it('shows only the greeting when the package has no starter options', async () => {
    seed({ id: 'import-welcome:req-1', stage: 'welcome', opening: { ...opening, starterOptions: undefined } });
    queueBotInvitation('bot-1');
    await waitForIo(() => expect(state().opening).toBeUndefined());
    expect(h.auxiliary).not.toHaveBeenCalled();
    expect(written().map(body => body.content)).toEqual(['你好，我能帮你跟进代码改动。']);
  });

  it('writes nothing once the user has already spoken', async () => {
    seed({ id: 'import-welcome:req-1', stage: 'welcome', opening });
    sqlite.prepare("UPDATE bot_profiles SET canonical_session_id = 'chat-1'").run();
    sqlite.prepare('INSERT INTO messages (id, client_id, session_id, role, content) VALUES (?, ?, ?, ?, ?)').run('u1', 'user-first', 'chat-1', 'user', 'hi');
    queueBotInvitation('bot-1');
    await waitForIo(() => expect(state().opening).toBeUndefined());
    expect(h.createMessage).not.toHaveBeenCalled();
    expect(h.auxiliary).not.toHaveBeenCalled();
  });

  it('finishes cleanly when the user wins the atomic write check on a Market opening', async () => {
    h.createMessage.mockImplementationOnce(async (_sessionId, _body, opts) => {
      expect(opts.requireNoUserMessage).toBe(true);
      throw Object.assign(new Error('User already spoke'), { code: 'MESSAGE_USER_ALREADY_SPOKE' });
    });
    seed({ id: 'import-welcome:req-1', stage: 'welcome', opening });
    queueBotInvitation('bot-1');
    await waitForIo(() => expect(state().stage).toBe('ready'));
    expect(state().opening).toBeUndefined();
    expect(h.createMessage).toHaveBeenCalledOnce();
    expect(h.auxiliary).not.toHaveBeenCalled();
  });
});
