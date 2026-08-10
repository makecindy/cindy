/**
 * 回归 #748:飞书/Slack 等 IM 渠道用确定性 session id(同一 bot×用户永远同一行),
 * 该行被桌面端归档/删除(软删,行仍在库里)后,用户从 IM 侧继续发消息曾走
 * "findActiveSession 返 null → 同 id INSERT" 撞 UNIQUE(sessions.id),之后每条
 * 消息都稳定报错。修复:
 *   - findActiveSession 命中软删行时原地复活(status 翻回 active),保留
 *     sdkSessionId(上下文)与模型/权限设置,并广播 created 让 sidebar 重现该会话;
 *   - createSession 的 INSERT 带 onConflictDoUpdate 兜并发竞态,冲突时只翻
 *     status 不碰上下文列。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const updateWhere = vi.fn(async (_where: unknown) => {});
  const updateSet = vi.fn((_set: unknown) => ({ where: updateWhere }));
  const insertConflict = vi.fn(async (_conflict: unknown) => {});
  const insertValues = vi.fn((_values: unknown) => ({ onConflictDoUpdate: insertConflict }));
  const selectLimit = vi.fn(async (): Promise<unknown[]> => []);
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    updateSet,
    updateWhere,
    insertConflict,
    insertValues,
    selectLimit,
    webContentsSend: vi.fn(),
    tapWindowBroadcast: vi.fn(),
  };
});

// 用轻量 eq 让断言能直接核对 WHERE 的列与值(真 eq 返回不可比对的 SQL 对象)。
// `sql` 同理拼成可读字符串: 生产代码用 `sql\`case when ...\`` 组装 workspaceKind
// 的 SET, 这里只看判据的形状 —— 它在真 SQLite 下的语义由
// sessionRepoWorkspaceKind.test.ts 覆盖。
vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    sqlText: strings.raw
      .map((part, i) => part + (i < values.length ? String(values[i]) : ''))
      .join(''),
  }),
}));
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: mocks.webContentsSend } },
    ],
  },
}));
vi.mock('../../../device-link/broadcast-tap', () => ({
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: mocks.tapWindowBroadcast,
}));
vi.mock('../../../logger', () => ({
  createLogger: () => mocks.logger,
  maskPath: (p: string) => p,
}));
vi.mock('../../../localDb/client/current', () => ({
  getDbClient: () => ({
    drizzle: {
      select: () => ({
        from: () => ({ where: () => ({ limit: mocks.selectLimit }) }),
      }),
      update: () => ({ set: mocks.updateSet }),
      insert: () => ({ values: mocks.insertValues }),
    },
  }),
}));
vi.mock('../../../localDb/schema', () => ({
  sessions: {
    id: 'sessions.id',
    workingDir: 'sessions.working_dir',
    workspaceKind: 'sessions.workspace_kind',
  },
}));
vi.mock('../../../maker-host/session-provider-store', () => ({
  setSessionProvider: vi.fn(),
}));
vi.mock('../../defaultSessionSettings', () => ({
  getImDefaultEffortFor: vi.fn(() => 'high'),
  resolveImSessionDefaults: vi.fn(async () => ({
    agentKind: 'claude-code',
    model: 'claude-opus-4-8',
    effort: 'high',
    permissionMode: 'auto',
    fastMode: false,
    providerId: null,
  })),
}));

import { createImSessionRepo, type ImSessionRow } from '../sessionRepo';
import type { ImOrchestratorConfig, ImSessionNamespace } from '../types';

const ns: ImSessionNamespace = {
  source: 'feishu',
  sessionIdFor: (bot: string, user: string) => `feishu_${bot}_${user}`,
  defaultTitle: () => '飞书',
  ensureWorkingDir: () => '/tmp/im-working-dir/bot',
  extraInsertColumns: (bot: string, user: string) => ({
    feishuBotAppId: bot,
    feishuOpenId: user,
  }),
} as unknown as ImSessionNamespace;

function dbRow(status: 'active' | 'archived' | 'deleted') {
  return {
    id: 'feishu_bot_user',
    status,
    agentKind: 'cc',
    workingDir: '/tmp/im-working-dir/bot',
    model: 'claude-opus-4-8',
    effort: 'high',
    permissionMode: 'auto',
    fastMode: false,
    sdkSessionId: 'sdk-ctx-1',
    providerId: null,
  };
}

function makeRepo() {
  return createImSessionRepo({ agentKind: 'claude-code' } as ImOrchestratorConfig, ns);
}

describe('sessionRepo.findActiveSession 软删行复活(#748)', () => {
  beforeEach(() => {
    mocks.updateSet.mockClear();
    mocks.updateWhere.mockClear();
    mocks.insertValues.mockClear();
    mocks.insertConflict.mockClear();
    mocks.webContentsSend.mockClear();
    mocks.tapWindowBroadcast.mockClear();
    mocks.selectLimit.mockReset();
    mocks.selectLimit.mockResolvedValue([]);
  });

  it.each(['archived', 'deleted'] as const)(
    '%s 残留行复活为 active 并返回,保留 sdkSessionId 上下文',
    async (status) => {
      mocks.selectLimit.mockResolvedValue([dbRow(status)]);
      const row = await makeRepo().findActiveSession('bot', 'user');

      expect(row).not.toBeNull();
      expect(row!.id).toBe('feishu_bot_user');
      expect(row!.sdkSessionId).toBe('sdk-ctx-1');
      expect(mocks.updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'active', userSendAt: expect.any(Number) }),
      );
      // 复活的 update 不允许触碰上下文/设置列
      const setArg = mocks.updateSet.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg).not.toHaveProperty('sdkSessionId');
      expect(setArg).not.toHaveProperty('model');
      expect(setArg).not.toHaveProperty('permissionMode');
      // WHERE 必须精确锁定本会话行,防止误写成全表 update
      expect(mocks.updateWhere).toHaveBeenCalledTimes(1);
      expect(mocks.updateWhere).toHaveBeenCalledWith({
        col: 'sessions.id',
        val: 'feishu_bot_user',
      });
      // 广播 created 让 sidebar 重拉列表、会话重新出现
      expect(mocks.webContentsSend).toHaveBeenCalledWith('local-db:sessions:created', {
        sessionId: 'feishu_bot_user',
      });
      expect(mocks.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:created', {
        sessionId: 'feishu_bot_user',
      });
    },
  );

  it('active 行直接返回,不发 update 不广播', async () => {
    mocks.selectLimit.mockResolvedValue([dbRow('active')]);
    const row = await makeRepo().findActiveSession('bot', 'user');

    expect(row).not.toBeNull();
    expect(mocks.updateSet).not.toHaveBeenCalled();
    expect(mocks.webContentsSend).not.toHaveBeenCalled();
  });

  it('无行返回 null,不发 update', async () => {
    const row = await makeRepo().findActiveSession('bot', 'user');

    expect(row).toBeNull();
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });
});

const preparedDefaults: ImSessionRow = {
  id: 'feishu_bot_user',
  agentKind: 'claude-code',
  workingDir: '/tmp/im-working-dir/bot',
  model: 'claude-opus-4-8',
  effort: 'high',
  permissionMode: 'auto',
  fastMode: false,
  sdkSessionId: null,
  providerId: null,
};

describe('sessionRepo.createSession upsert 兜竞态(#748)', () => {
  beforeEach(() => {
    mocks.insertValues.mockClear();
    mocks.insertConflict.mockClear();
    mocks.selectLimit.mockReset();
    mocks.selectLimit.mockResolvedValue([]);
  });

  it('INSERT 带 onConflictDoUpdate:冲突时只翻 status/渠道列,不碰上下文列', async () => {
    await makeRepo().createSession('bot', 'user', undefined, preparedDefaults);

    expect(mocks.insertValues).toHaveBeenCalledTimes(1);
    expect(mocks.insertConflict).toHaveBeenCalledTimes(1);
    const conflictArg = mocks.insertConflict.mock.calls[0][0] as {
      target: unknown;
      set: Record<string, unknown>;
    };
    expect(conflictArg.set).toMatchObject({
      status: 'active',
      source: 'feishu',
      feishuBotAppId: 'bot',
      feishuOpenId: 'user',
    });
    expect(conflictArg.set).not.toHaveProperty('sdkSessionId');
    expect(conflictArg.set).not.toHaveProperty('model');
    expect(conflictArg.set).not.toHaveProperty('effort');
    expect(conflictArg.set).not.toHaveProperty('permissionMode');
    expect(conflictArg.set).not.toHaveProperty('title');
  });

  it('upsert 后以 DB 持久化行为准返回:冲突分支保留的上下文/设置不被 defaults 顶掉', async () => {
    mocks.selectLimit.mockResolvedValue([
      { ...dbRow('active'), model: 'old-model', effort: 'low', sdkSessionId: 'sdk-ctx-1' },
    ]);
    const result = await makeRepo().createSession('bot', 'user', undefined, preparedDefaults);

    expect(result.sdkSessionId).toBe('sdk-ctx-1');
    expect(result.model).toBe('old-model');
    expect(result.effort).toBe('low');
    expect(result.agentKind).toBe('claude-code');
  });

  it('回读为空(极端竞态行被删)时回落 prepared defaults,不抛错', async () => {
    const result = await makeRepo().createSession('bot', 'user', undefined, preparedDefaults);

    expect(result).toEqual(preparedDefaults);
  });
});

describe('sessionRepo workspaceKind(渠道声明 dialogue 归组时)', () => {
  const dialogueNs = { ...ns, workspaceKind: 'dialogue' } as unknown as ImSessionNamespace;

  /** 开着 `/project` 的渠道(个人 Telegram): 归属可以按路径推断。 */
  function makeDialogueRepo() {
    return createImSessionRepo(
      { agentKind: 'claude-code' } as ImOrchestratorConfig,
      dialogueNs,
      { projectSwitching: true },
    );
  }

  /** 没有 `/project` 的渠道(微信这类): 只有托管目录, 且它用户可改。 */
  function makePlainDialogueRepo() {
    return createImSessionRepo(
      { agentKind: 'claude-code' } as ImOrchestratorConfig,
      dialogueNs,
    );
  }

  beforeEach(() => {
    mocks.updateSet.mockClear();
    mocks.insertValues.mockClear();
    mocks.insertConflict.mockClear();
    mocks.selectLimit.mockReset();
    mocks.selectLimit.mockResolvedValue([]);
  });

  it('新行直接落 workspaceKind=dialogue, 冲突分支改成带判据的 CASE', async () => {
    await makeDialogueRepo().createSession('bot', 'user', undefined, preparedDefaults);

    // 新行没有历史可保护, 渠道归属就是它的归属。
    const values = mocks.insertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(values.workspaceKind).toBe('dialogue');

    // 冲突撞的是残留行 —— 无条件写 'dialogue' 会把用户 `/project` 选的项目归属
    // 刷掉。判据必须落在 SET 表达式里(不是先读再改写: 并发下旧值会盖新值)。
    const conflictArg = mocks.insertConflict.mock.calls[0][0] as {
      set: Record<string, { sqlText: string }>;
    };
    const setSql = conflictArg.set.workspaceKind.sqlText;
    expect(setSql).toContain('case when');
    expect(setSql).toContain('sessions.working_dir');
    expect(setSql).toContain('/tmp/im-working-dir/bot');
    expect(setSql).toContain('dialogue');
    // else 分支写死 'project': 老版本刷坏的存量行(dialogue + 项目目录)靠"保留现值"
    // 永远修不好。语义与判据见 sessionRepoWorkspaceKind.test.ts。
    expect(setSql).toContain("else 'project'");
  });

  it('没有 /project 的渠道照旧直写渠道归属, 不按路径判', async () => {
    // 这些渠道的托管目录用户可以在设置页改, 而已有会话保留旧目录 —— 按路径判会把
    // 一条合法的对话会话判成项目, 还会写进库里。
    await makePlainDialogueRepo().createSession('bot', 'user', undefined, preparedDefaults);

    const conflictArg = mocks.insertConflict.mock.calls[0][0] as {
      set: Record<string, unknown>;
    };
    expect(conflictArg.set.workspaceKind).toBe('dialogue');
  });

  it('软删行复活时按同一判据校正 workspaceKind', async () => {
    mocks.selectLimit.mockResolvedValue([dbRow('archived')]);
    await makeDialogueRepo().findActiveSession('bot', 'user');

    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'active',
        workspaceKind: expect.objectContaining({
          sqlText: expect.stringContaining('case when'),
        }),
      }),
    );
  });

  it('渠道未声明 workspaceKind 时不写该列(保持默认 project 语义)', async () => {
    await makeRepo().createSession('bot', 'user', undefined, preparedDefaults);

    const values = mocks.insertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(values).not.toHaveProperty('workspaceKind');
    const conflictArg = mocks.insertConflict.mock.calls[0][0] as {
      set: Record<string, unknown>;
    };
    expect(conflictArg.set).not.toHaveProperty('workspaceKind');
  });
});
