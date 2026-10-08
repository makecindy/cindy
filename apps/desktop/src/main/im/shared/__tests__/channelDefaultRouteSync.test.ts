/**
 * 渠道默认跟随(channelDefaultRouteSync)在真 SQLite 上的读写:
 * 何时切、切完记录落什么、失败怎么回退、老任务怎么补记录。
 * 切换本身(register.ts 的路由选择)在这里是替身 —— 它的语义由伙伴模型对齐覆盖。
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fingerprint: vi.fn(() => 'fp-new'),
  resolveDefaults: vi.fn(),
  rawDefault: vi.fn(),
  listProviders: vi.fn(async (): Promise<unknown[] | null> => []),
  applyRoute: vi.fn(),
  readPendingRoute: vi.fn(() => undefined as unknown),
  cancelPending: vi.fn(),
  ownerScopeKey: vi.fn((): string => 'owner-1'),
  boundaryPending: vi.fn((): boolean => false),
}));

// 新任务经公共入口 openSession(模型准入)—— 准入本身由 sessionOpening 的测试覆盖, 这里
// 只把准入前的路由原样透传给建行回调。
vi.mock('../../../localDb/sessionOpening', () => ({
  openSession: vi.fn(
    async (
      input: { body: Record<string, unknown> },
      commit?: (row: Record<string, unknown>, assertCurrent: () => void) => Promise<unknown>,
    ) => {
      const row = {
        ...input.body,
        providerId: input.body.providerId ?? null,
        fastMode: !!input.body.fastMode,
      };
      return { row, value: commit ? await commit(row, () => undefined) : undefined };
    },
  ),
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '/tmp/never-used-here' },
}));
vi.mock('../../../device-link/broadcast-tap', () => ({
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: vi.fn(),
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  maskPath: (p: string) => p,
}));
vi.mock('../../../maker-host/session-provider-store', () => ({
  setSessionProvider: vi.fn(),
}));
vi.mock('../../../maker-host/createDesktopProviderService', () => ({
  getDesktopProviderService: () => ({ listProviders: mocks.listProviders }),
}));
vi.mock('@cindy/model-providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cindy/model-providers')>()),
  // 隐式来源一律落到 'xd' —— 足够验证「隐式 == 钉住的 xd」归一化。
  effectiveSourceIdForModel: vi.fn(() => 'xd'),
}));
vi.mock('../../defaultSessionSettings', () => ({
  getImDefaultEffortFor: vi.fn(() => 'high'),
  readImDefaultSettingsFingerprint: mocks.fingerprint,
  readImRawDefaultRoute: mocks.rawDefault,
  resolveImSessionDefaults: mocks.resolveDefaults,
}));
vi.mock('../../../maker-ipc/register', () => ({
  acquirePendingAgentSwitchForImSend: vi.fn(async (_id: string, sync: () => Promise<void>) => {
    await sync();
    return () => {};
  }),
  applySessionRouteUnderSendLock: mocks.applyRoute,
  readPendingAgentSwitchRoute: mocks.readPendingRoute,
  cancelPendingAgentSwitchForSession: mocks.cancelPending,
}));
vi.mock('../../../maker-ipc/sendToSessionLock', () => ({
  withSendToSessionLock: async <T>(_id: string, run: () => Promise<T>) => run(),
}));
vi.mock('../../../appSessionState.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../appSessionState.js')>()),
  activeOwnerScopeKey: mocks.ownerScopeKey,
  isAppSessionBoundaryPending: mocks.boundaryPending,
}));

let db: ReturnType<typeof drizzle>;
vi.mock('../../../localDb/client/current', () => {
  const account = {};
  return { getDbClient: () => ({ drizzle: db }), getCurrentDbClientSnapshot: () => account };
});

const { sessions } = await import('../../../localDb/schema');
const {
  backfillLegacyImDefaultRoutes,
  backfillLegacyImDefaultRoutesAtStartup,
  createImChannelDefaultRouteSync,
  resetImSessionToChannelDefaults,
} = await import('../channelDefaultRouteSync');
const { markImSessionManualRouteOverride } = await import('../manualRouteOverride');
const { buildImDefaultRouteRecord, buildImManualRouteOverrideRecord, parseImDefaultRouteRecord } = await import('../channelDefaultRoute');
import type { ImDefaultRoute } from '../channelDefaultRoute';
import type { ImOrchestratorConfig } from '../types';

const CONFIG = { agentKind: 'claude-code' } as ImOrchestratorConfig;
const OLD: ImDefaultRoute = { agentKind: 'claude-code', model: 'claude-opus-4-8', providerId: null, effort: 'xhigh' };
const NEW: ImDefaultRoute = { agentKind: 'codex', model: 'gpt-5.5', providerId: 'openai', effort: 'high' };

function createTableSql(): string {
  const config = getTableConfig(sessions);
  const cols = config.columns.map((col) => {
    const parts = [`"${col.name}"`, col.getSQLType()];
    if (col.primary) parts.push('PRIMARY KEY');
    if (col.notNull) parts.push('NOT NULL');
    const dflt = col.default;
    if (dflt !== undefined && typeof dflt !== 'object') {
      parts.push(`DEFAULT ${typeof dflt === 'string' ? `'${dflt}'` : Number(dflt)}`);
    }
    return parts.join(' ');
  });
  return `CREATE TABLE "${config.name}" (${cols.join(', ')})`;
}

function dbAgentKind(kind: ImDefaultRoute['agentKind']): string {
  return kind === 'claude-code' ? 'cc' : kind;
}

async function insertTask(
  id: string,
  route: ImDefaultRoute,
  opts: {
    source?: string;
    record?: string | null;
    remoteHostId?: string | null;
    marker?: boolean;
    status?: 'active' | 'archived' | 'deleted';
    fastMode?: boolean;
  } = {},
): Promise<void> {
  const source = opts.source ?? 'feishu';
  const marker = opts.marker !== false;
  await db.insert(sessions).values({
    id,
    title: id,
    status: opts.status ?? 'active',
    agentKind: dbAgentKind(route.agentKind),
    model: route.model,
    providerId: route.providerId,
    effort: route.effort,
    fastMode: opts.fastMode === true,
    permissionMode: 'auto',
    workingDir: '/tmp/im',
    source,
    remoteHostId: opts.remoteHostId ?? null,
    imDefaultRoute: opts.record === undefined ? buildImDefaultRouteRecord('fp-old', OLD) : opts.record,
    ...(source === 'feishu'
      ? marker ? { feishuBotAppId: 'cli_bot', feishuOpenId: 'ou_user' } : {}
      : marker ? { imBotContextId: 'bot', imUserId: 'user' } : {}),
    createdAt: 1,
    updatedAt: 1,
  } as typeof sessions.$inferInsert);
}

async function rowOf(id: string) {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
  return row!;
}

async function setRoute(id: string, route: ImDefaultRoute): Promise<void> {
  await db
    .update(sessions)
    .set({
      agentKind: dbAgentKind(route.agentKind),
      model: route.model,
      providerId: route.providerId,
      effort: route.effort as typeof sessions.$inferInsert.effort,
    })
    .where(eq(sessions.id, id));
}

function sync(isRouteUsable = vi.fn(async () => true)) {
  return createImChannelDefaultRouteSync({ source: 'feishu', config: CONFIG, isRouteUsable });
}

beforeEach(() => {
  vi.clearAllMocks();
  const raw = new Database(':memory:');
  raw.exec(createTableSql());
  db = drizzle(raw);
  // clearAllMocks 不清实现、也不清 mockResolvedValueOnce 队列: 默认实现必须每次
  // 重设, 排队后未被消费的 Once(如「无候选行就不碰目录」的用例)会泄漏进下一个
  // 用例 —— 逐个 mockReset 清干净再重设。
  mocks.fingerprint.mockReset().mockReturnValue('fp-new');
  mocks.rawDefault.mockReset().mockReturnValue(OLD);
  mocks.readPendingRoute.mockReset().mockReturnValue(undefined);
  mocks.listProviders.mockReset().mockResolvedValue([]);
  mocks.resolveDefaults.mockReset().mockResolvedValue({ ...NEW, permissionMode: 'auto', fastMode: false, fingerprint: 'fp-new' });
  mocks.ownerScopeKey.mockReset().mockReturnValue('owner-1');
  mocks.boundaryPending.mockReset().mockReturnValue(false);
  mocks.applyRoute.mockReset();
  mocks.cancelPending.mockReset();
  mocks.applyRoute.mockImplementation(async (id: string, route: ImDefaultRoute) => {
    await setRoute(id, route);
    return 'applied';
  });
});

describe('syncUnderLock', () => {
  it('switches a following task and records the read-back route under the new fingerprint', async () => {
    await insertTask('t1', OLD);
    await expect(sync().syncUnderLock('t1')).resolves.toBe(false);

    expect(mocks.applyRoute).toHaveBeenCalledWith('t1', { ...NEW, fastMode: false }, 'claude-code');
    const record = parseImDefaultRouteRecord((await rowOf('t1')).imDefaultRoute);
    expect(record).toEqual({ v: 1, fp: 'fp-new', route: NEW });
  });

  it('records what actually landed when the switch re-routed the provider', async () => {
    await insertTask('t1', OLD);
    mocks.applyRoute.mockImplementation(async (id: string, route: ImDefaultRoute) => {
      await setRoute(id, { ...route, providerId: 'openai-copy' });
      return 'applied';
    });
    await sync().syncUnderLock('t1');

    const record = parseImDefaultRouteRecord((await rowOf('t1')).imDefaultRoute);
    expect(record?.route.providerId).toBe('openai-copy');
  });

  it('keeps the old fingerprint and remembers the pending target while the runtime is busy', async () => {
    await insertTask('t1', OLD);
    mocks.applyRoute.mockResolvedValue('staged');
    // true = 跟随切换被暂缓, 调用方本次不得再走通用意图应用(PR #5155 review P1)。
    await expect(sync().syncUnderLock('t1')).resolves.toBe(true);

    const record = parseImDefaultRouteRecord((await rowOf('t1')).imDefaultRoute);
    expect(record).toEqual({ v: 1, fp: 'fp-old', route: OLD, pendingRoute: NEW, pendingFp: 'fp-new' });
  });

  it('keeps the task\'s own Fast setting when following the new default', async () => {
    // 渠道默认不存 Fast —— 跟随切换只换路由, 任务单独开过的 Fast 不能被清掉
    // (chatgpt-codex-connector P2, PR #5155)。
    await insertTask('t1', OLD, { fastMode: true });
    await sync().syncUnderLock('t1');

    expect(mocks.applyRoute).toHaveBeenCalledWith('t1', { ...NEW, fastMode: true }, 'claude-code');
  });

  it('still defers the generic apply when the staged claim write fails', async () => {
    // 登记后声称的落库瞬时失败不能丢「暂缓」信号, 否则外层通用意图应用会把刚登记
    // 的意图应用到仍在承载后台工作的会话上(PR #5155 review P1)。
    await insertTask('t1', OLD);
    mocks.readPendingRoute.mockReturnValueOnce(undefined).mockReturnValue(NEW);
    mocks.applyRoute.mockImplementation(async () => {
      db = { update: () => { throw new Error('db closed') } } as never;
      return 'staged';
    });

    await expect(sync().syncUnderLock('t1')).resolves.toBe(true);
  });

  it('remembers the staged intent as registered, then does not re-register it', async () => {
    await insertTask('t1', OLD);
    const rerouted: ImDefaultRoute = { ...NEW, providerId: 'openai-copy' };
    mocks.applyRoute.mockResolvedValue('staged');
    mocks.readPendingRoute
      .mockReturnValueOnce(undefined)
      .mockReturnValue({ ...rerouted, rev: 5 });
    await sync().syncUnderLock('t1');

    expect(parseImDefaultRouteRecord((await rowOf('t1')).imDefaultRoute)).toEqual({
      v: 1,
      fp: 'fp-old',
      route: OLD,
      pendingRoute: rerouted,
      pendingFp: 'fp-new',
      pendingRev: 5,
    });
    // 下一条消息: 不重新登记, 只尝试应用自己登记的意图(仍忙 → 继续等)。
    mocks.applyRoute.mockClear();
    await sync().syncUnderLock('t1');
    expect(mocks.applyRoute).toHaveBeenCalledTimes(1);
    expect(mocks.applyRoute).toHaveBeenCalledWith('t1', null, 'claude-code');
    expect(parseImDefaultRouteRecord((await rowOf('t1')).imDefaultRoute)?.pendingRoute).toEqual(rerouted);

    // 再下一条: 空闲了, 意图应用成功 → 记录读回的路由与新指纹。
    mocks.applyRoute.mockImplementationOnce(async (id: string) => {
      await setRoute(id, rerouted);
      return 'applied';
    });
    await sync().syncUnderLock('t1');
    expect(parseImDefaultRouteRecord((await rowOf('t1')).imDefaultRoute)).toEqual({
      v: 1,
      fp: 'fp-new',
      route: rerouted,
    });
  });

  it('clears its stale claim but leaves the intent alone when the user re-picked the same route', async () => {
    // 自动切换未生效时用户又明确挑了同值: 注册修订号变了, 这是用户的选择
    // (greptile P1, PR #5155) —— 不登记不应用, 只清掉自己的过时声称。
    await insertTask('t1', OLD, {
      record: buildImDefaultRouteRecord('fp-old', OLD, { route: NEW, fp: 'fp-new', rev: 3 }),
    });
    mocks.readPendingRoute.mockReturnValue({ ...NEW, rev: 4 });
    await sync().syncUnderLock('t1');

    expect(mocks.applyRoute).not.toHaveBeenCalled();
    expect(mocks.cancelPending).not.toHaveBeenCalled();
    expect((await rowOf('t1')).imDefaultRoute).toBe(buildImDefaultRouteRecord('fp-old', OLD));
  });

  it('withdraws its intent and restores the claim when the staged claim rewrite fails', async () => {
    // 暂缓声称(pendingRev 补写)失败时不能留「无修订号声称 + 带修订号意图」—— 下一条
    // 消息会把系统意图误判成用户选择, 走 manual 后被通用 apply 用更宽的忙判定应用掉
    // (chatgpt-codex-connector P2, PR #5155)。撤回意图、恢复原声称, 下一条消息重试。
    await insertTask('t1', OLD);
    mocks.readPendingRoute.mockReturnValueOnce(undefined).mockReturnValue({ ...NEW, rev: 5 });
    mocks.applyRoute.mockResolvedValue('staged');
    const real = db;
    let updates = 0;
    db = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'update') {
          return (...args: unknown[]) => {
            updates += 1;
            // 第 1 次 = 预写声称(成功); 第 2 次 = 补 pendingRev 的声称(故障); 第 3 次 = 恢复。
            if (updates === 2) throw new Error('database is locked');
            return (target.update as unknown as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;

    await expect(sync().syncUnderLock('t1')).resolves.toBe(true);
    db = real;

    expect(mocks.cancelPending).toHaveBeenCalledWith('t1');
    expect((await rowOf('t1')).imDefaultRoute).toBe(buildImDefaultRouteRecord('fp-old', OLD));
  });

  it('withdraws its staged intent without blocking when applying it fails', async () => {
    await insertTask('t1', OLD, {
      record: buildImDefaultRouteRecord('fp-old', OLD, { route: NEW, fp: 'fp-new' }),
    });
    mocks.readPendingRoute.mockReturnValue(NEW);
    mocks.applyRoute.mockRejectedValue(new Error('model window confirmation required'));
    await expect(sync().syncUnderLock('t1')).resolves.toBe(false);

    expect(mocks.applyRoute).toHaveBeenCalledWith('t1', null, 'claude-code');
    expect((await rowOf('t1')).imDefaultRoute).toBe(buildImDefaultRouteRecord('fp-old', OLD));
  });

  it('defers the generic apply when the catalog is unreadable and a system claim is live', async () => {
    // 上一条消息已把默认切换登记为 staged; 下一条消息目录暂不可读时不能丢「暂缓」
    // 信号 —— 通用 apply 的忙判定只看 isTurnRunning(PR #5155 review P2)。
    await insertTask('t1', OLD, {
      record: buildImDefaultRouteRecord('fp-old', OLD, { route: NEW, fp: 'fp-new', rev: 5 }),
    });
    mocks.readPendingRoute.mockReturnValue({ ...NEW, rev: 5 });
    mocks.listProviders.mockResolvedValueOnce(null);

    await expect(sync().syncUnderLock('t1')).resolves.toBe(true);
    expect(mocks.resolveDefaults).not.toHaveBeenCalled();
    expect(mocks.applyRoute).not.toHaveBeenCalled();
  });

  it('does not defer on catalog failure when the live intent is not its own claim', async () => {
    await insertTask('t1', OLD, {
      record: buildImDefaultRouteRecord('fp-old', OLD, { route: NEW, fp: 'fp-new', rev: 5 }),
    });
    // 用户重挑的同值意图(修订号不同)—— 不挡通用应用。
    mocks.readPendingRoute.mockReturnValue({ ...NEW, rev: 6 });
    mocks.listProviders.mockResolvedValueOnce(null);

    await expect(sync().syncUnderLock('t1')).resolves.toBe(false);
  });

  it('leaves a task the user changed alone', async () => {
    await insertTask('t1', { ...OLD, model: 'claude-sonnet-5' });
    await sync().syncUnderLock('t1');

    expect(mocks.applyRoute).not.toHaveBeenCalled();
    expect((await rowOf('t1')).imDefaultRoute).toBe(buildImDefaultRouteRecord('fp-old', OLD));
  });

  it('never touches a task carrying the manual override marker', async () => {
    // 同值重选落地时立的墓碑: 不再跟随, 也不必解析新默认(greptile P1 补充, PR #5155)。
    const tombstone = buildImManualRouteOverrideRecord(OLD);
    await insertTask('t1', OLD, { record: tombstone });
    await sync().syncUnderLock('t1');

    expect(mocks.resolveDefaults).not.toHaveBeenCalled();
    expect(mocks.applyRoute).not.toHaveBeenCalled();
    expect((await rowOf('t1')).imDefaultRoute).toBe(tombstone);
  });

  it('treats a pinned native source as the recorded implicit default', async () => {
    await insertTask('t1', { ...OLD, providerId: 'xd' });
    await sync().syncUnderLock('t1');

    expect(mocks.applyRoute).toHaveBeenCalled();
  });

  it('never blocks the message and restores the record when the switch fails', async () => {
    await insertTask('t1', OLD);
    mocks.applyRoute.mockRejectedValue(new Error('model window unknown'));
    await expect(sync().syncUnderLock('t1')).resolves.toBe(false);

    expect((await rowOf('t1')).imDefaultRoute).toBe(buildImDefaultRouteRecord('fp-old', OLD));
    expect((await rowOf('t1')).model).toBe(OLD.model);
  });

  it('keeps the current route when the new default is not usable', async () => {
    await insertTask('t1', OLD);
    await sync(vi.fn(async () => false)).syncUnderLock('t1');

    expect(mocks.applyRoute).not.toHaveBeenCalled();
    expect((await rowOf('t1')).imDefaultRoute).toBe(buildImDefaultRouteRecord('fp-old', OLD));
  });

  it('adopts the new fingerprint only when the task still runs the recorded route', async () => {
    await insertTask('t1', NEW, { record: buildImDefaultRouteRecord('fp-old', NEW) });
    await sync().syncUnderLock('t1');

    expect(mocks.applyRoute).not.toHaveBeenCalled();
    expect(parseImDefaultRouteRecord((await rowOf('t1')).imDefaultRoute)).toEqual({ v: 1, fp: 'fp-new', route: NEW });
  });

  it('does not re-adopt a manual pick that happens to equal the new default', async () => {
    // 记录的路由是 OLD, 任务当前跑 NEW(用户单独挑的, 恰好与新默认一致): 不能洗成跟随。
    await insertTask('t1', NEW);
    await sync().syncUnderLock('t1');

    expect(mocks.applyRoute).not.toHaveBeenCalled();
    expect((await rowOf('t1')).imDefaultRoute).toBe(buildImDefaultRouteRecord('fp-old', OLD));
  });

  it('does nothing while the settings fingerprint is unchanged', async () => {
    await insertTask('t1', OLD);
    mocks.fingerprint.mockReturnValue('fp-old');
    await sync().syncUnderLock('t1');

    expect(mocks.resolveDefaults).not.toHaveBeenCalled();
    expect(mocks.applyRoute).not.toHaveBeenCalled();
  });

  it.each([
    ['another channel', { source: 'telegram' }],
    ['a desktop task', { source: 'desktop' }],
    ['a remote task', { remoteHostId: 'ssh-1' }],
    ['a task without channel markers (official hook)', { marker: false }],
    ['an archived task', { status: 'archived' as const }],
    ['a task without a record', { record: null }],
  ])('ignores %s', async (_label, opts) => {
    await insertTask('t1', OLD, opts);
    await sync().syncUnderLock('t1');

    expect(mocks.applyRoute).not.toHaveBeenCalled();
  });
});

describe('previewSwitchTarget', () => {
  it('returns the new default only when this message will switch to it', async () => {
    await insertTask('follow', OLD);
    await insertTask('manual', { ...OLD, model: 'claude-sonnet-5' });
    const s = sync();

    await expect(s.previewSwitchTarget('follow')).resolves.toEqual(NEW);
    await expect(s.previewSwitchTarget('manual')).resolves.toBeNull();
    await expect(sync(vi.fn(async () => false)).previewSwitchTarget('follow')).resolves.toBeNull();
    expect(mocks.applyRoute).not.toHaveBeenCalled();
    expect((await rowOf('follow')).imDefaultRoute).toBe(buildImDefaultRouteRecord('fp-old', OLD));
  });
});

describe('backfillLegacyImDefaultRoutes', () => {
  it('records only legacy tasks of this channel that still run the old default', async () => {
    mocks.resolveDefaults.mockResolvedValue({ ...OLD, permissionMode: 'auto', fastMode: false, fingerprint: 'fp-old' });
    mocks.fingerprint.mockReturnValue('fp-old');
    await insertTask('legacy-default', OLD, { record: null });
    await insertTask('legacy-pinned', { ...OLD, providerId: 'xd' }, { record: null });
    await insertTask('legacy-changed', { ...OLD, model: 'claude-sonnet-5' }, { record: null });
    await insertTask('legacy-other-channel', OLD, { record: null, source: 'telegram' });
    await insertTask('recorded', { ...OLD, model: 'claude-sonnet-5' });

    await expect(backfillLegacyImDefaultRoutes('feishu', CONFIG)).resolves.toBe(2);

    expect(parseImDefaultRouteRecord((await rowOf('legacy-default')).imDefaultRoute)).toEqual({
      v: 1,
      fp: 'fp-old',
      route: OLD,
    });
    expect(parseImDefaultRouteRecord((await rowOf('legacy-pinned')).imDefaultRoute)?.route.providerId).toBe('xd');
    expect((await rowOf('legacy-changed')).imDefaultRoute).toBeNull();
    expect((await rowOf('legacy-other-channel')).imDefaultRoute).toBeNull();
    expect((await rowOf('recorded')).imDefaultRoute).toBe(buildImDefaultRouteRecord('fp-old', OLD));
  });

  it('keeps an effort-only manual change out when the old default still resolves to its own route', async () => {
    mocks.resolveDefaults.mockResolvedValue({ ...OLD, permissionMode: 'auto', fastMode: false, fingerprint: 'fp-old' });
    mocks.fingerprint.mockReturnValue('fp-old');
    await insertTask('legacy-effort-changed', { ...OLD, effort: 'low' }, { record: null });

    await expect(backfillLegacyImDefaultRoutes('feishu', CONFIG)).resolves.toBe(0);
    expect((await rowOf('legacy-effort-changed')).imDefaultRoute).toBeNull();
  });

  it('matches by the saved raw default when the old default fell back to another route', async () => {
    // 旧默认的来源断开/模型下架后解析会回落到别的路由, 拿回落值匹配历史任务永远
    // 匹配不到, 它们会永久失去跟随资格(chatgpt-codex-connector P2, PR #5155)。
    mocks.fingerprint.mockReturnValue('fp-old');
    mocks.rawDefault.mockReturnValue({ ...OLD, providerId: 'openai', effort: 'xhigh' });
    mocks.resolveDefaults.mockResolvedValue({ ...NEW, permissionMode: 'auto', fastMode: false, fingerprint: 'fp-old' });
    await insertTask('legacy-broken-default', { ...OLD, providerId: 'openai' }, { record: null });
    await insertTask('legacy-on-fallback', NEW, { record: null });
    await insertTask('legacy-off-raw', { ...OLD, providerId: 'other' }, { record: null });
    // 只改过 effort 的历史任务也是「单独改过」, 不能被认领(PR #5155 review P1)。
    await insertTask('legacy-effort-only', { ...OLD, providerId: 'openai', effort: 'low' }, { record: null });

    await expect(backfillLegacyImDefaultRoutes('feishu', CONFIG)).resolves.toBe(2);

    expect(parseImDefaultRouteRecord((await rowOf('legacy-broken-default')).imDefaultRoute)).toEqual({
      v: 1,
      fp: 'fp-old',
      route: { ...OLD, providerId: 'openai' },
    });
    expect((await rowOf('legacy-on-fallback')).imDefaultRoute).not.toBeNull();
    expect((await rowOf('legacy-off-raw')).imDefaultRoute).toBeNull();
    expect((await rowOf('legacy-effort-only')).imDefaultRoute).toBeNull();
  });

  it('matches by the saved raw default when the old default cannot be resolved at all', async () => {
    // 旧默认坏到解析不出来(如全部模型被停用): 不能把保存也堵死, 按原始默认认领。
    mocks.fingerprint.mockReturnValue('fp-old');
    mocks.resolveDefaults.mockRejectedValue(new Error('im default session has no enabled chat model'));
    await insertTask('legacy-default', OLD, { record: null });

    await expect(backfillLegacyImDefaultRoutes('feishu', CONFIG)).resolves.toBe(1);
    expect(parseImDefaultRouteRecord((await rowOf('legacy-default')).imDefaultRoute)).toEqual({
      v: 1,
      fp: 'fp-old',
      route: OLD,
    });
  });

  it('leaves explicitly pinned historical landings alone even when the source later died', async () => {
    // 隐式默认(null)建任务时可能被系统钉成当时的有效来源 A, 也可能本来就是用户
    // 手动钉的 —— 断开的来源证明不了出身, 无法区分时保守不认领, 不拿脏数据误切
    // 用户单独改过的任务(PR #5155 review P2 后续裁决)。
    mocks.fingerprint.mockReturnValue('fp-old');
    mocks.rawDefault.mockReturnValue(OLD);
    mocks.resolveDefaults.mockResolvedValue({ ...OLD, permissionMode: 'auto', fastMode: false, fingerprint: 'fp-old' });
    await insertTask('legacy-pinned-dead', { ...OLD, providerId: 'dead-source' }, { record: null });
    await insertTask('legacy-pinned-live', { ...OLD, providerId: 'live-source' }, { record: null });

    await expect(backfillLegacyImDefaultRoutes('feishu', CONFIG)).resolves.toBe(0);

    expect((await rowOf('legacy-pinned-dead')).imDefaultRoute).toBeNull();
    expect((await rowOf('legacy-pinned-live')).imDefaultRoute).toBeNull();
  });

  it('reads and writes through the client captured at entry (owner boundary)', async () => {
    // 回填跨多个 await, 期间登出/换号会让全局 getDbClient 指向新 owner —— 必须全程
    // 复用进入时捕获的客户端, 不能在 await 间隙重读全局(PR #5155 review P1)。
    mocks.resolveDefaults.mockResolvedValue({ ...OLD, permissionMode: 'auto', fastMode: false, fingerprint: 'fp-old' });
    mocks.fingerprint.mockReturnValue('fp-old');
    await insertTask('legacy-default', OLD, { record: null });
    const realDb = db;
    const captured = { drizzle: realDb } as never;
    // 全局客户端在回填中途被换/销毁(owner 切换)。
    db = { select: () => { throw new Error('owner switched') }, update: () => { throw new Error('owner switched') } } as never;

    await expect(backfillLegacyImDefaultRoutes('feishu', CONFIG, captured)).resolves.toBe(1);
    db = realDb;

    expect(parseImDefaultRouteRecord((await rowOf('legacy-default')).imDefaultRoute)).not.toBeNull();
  });

  it('claims revivable archived tasks that still run the old default', async () => {
    // 归档/软删的可复活任务: findActiveSession 会原地复活且不补记录, 保存前不认领
    // 就永久错过(PR #5155 review P2)。
    mocks.resolveDefaults.mockResolvedValue({ ...OLD, permissionMode: 'auto', fastMode: false, fingerprint: 'fp-old' });
    mocks.fingerprint.mockReturnValue('fp-old');
    await insertTask('legacy-archived', OLD, { record: null, status: 'archived' });
    await insertTask('legacy-deleted', OLD, { record: null, status: 'deleted' });

    await expect(backfillLegacyImDefaultRoutes('feishu', CONFIG)).resolves.toBe(2);

    expect((await rowOf('legacy-archived')).imDefaultRoute).not.toBeNull();
    expect((await rowOf('legacy-deleted')).imDefaultRoute).not.toBeNull();
  });

  it('fails instead of reporting done when the provider catalog is unavailable', async () => {
    // 返回 0 会被调用方当成「补完了」照常提交新默认, 还停在旧默认上的老任务之后只
    // 能按新默认匹配, 永久失去跟随资格 —— 必须抛错让本次保存失败重试(PR #5155 P2)。
    await insertTask('legacy-default', OLD, { record: null });
    mocks.listProviders.mockResolvedValueOnce(null);

    await expect(backfillLegacyImDefaultRoutes('feishu', CONFIG)).rejects.toThrow(/provider catalog unavailable/);
    expect((await rowOf('legacy-default')).imDefaultRoute).toBeNull();
  });

  it('does not need the catalog when no legacy task is left', async () => {
    await insertTask('recorded', OLD);
    mocks.listProviders.mockResolvedValueOnce(null);

    await expect(backfillLegacyImDefaultRoutes('feishu', CONFIG)).resolves.toBe(0);
  });
});

describe('backfillLegacyImDefaultRoutesAtStartup', () => {
  it('claims legacy rows for every configured channel at startup', async () => {
    // 回填只由设置保存/重置触发的话, 从未动过设置的升级老任务永远拿不到记录 ——
    // 后续版本改内置默认后会永久固定在旧默认(PR #5155 review P2)。
    mocks.fingerprint.mockReturnValue('fp-old');
    await insertTask('legacy-feishu', OLD, { record: null });
    await insertTask('legacy-telegram', OLD, { record: null, source: 'telegram' });

    await expect(
      backfillLegacyImDefaultRoutesAtStartup([
        { source: 'feishu', config: CONFIG },
        { source: 'telegram', config: CONFIG },
      ]),
    ).resolves.toBeUndefined();

    expect(parseImDefaultRouteRecord((await rowOf('legacy-feishu')).imDefaultRoute)).toEqual({
      v: 1,
      fp: 'fp-old',
      route: OLD,
    });
    expect(parseImDefaultRouteRecord((await rowOf('legacy-telegram')).imDefaultRoute)).toEqual({
      v: 1,
      fp: 'fp-old',
      route: OLD,
    });
  });

  it('keeps sweeping the remaining channels when one startup backfill fails', async () => {
    // 启动补齐 best-effort: 单个渠道失败只告警不抛错(下次启动重试), 不能把其余
    // 渠道也带掉, 更不能挡连接启动(PR #5155 review P2)。
    mocks.fingerprint.mockReturnValue('fp-old');
    await insertTask('legacy-feishu', OLD, { record: null });
    await insertTask('legacy-telegram', OLD, { record: null, source: 'telegram' });
    // 第一个渠道拿不到供应商目录 → 该渠道报错; 不影响第二个渠道。
    mocks.listProviders.mockResolvedValueOnce(null);

    await expect(
      backfillLegacyImDefaultRoutesAtStartup([
        { source: 'feishu', config: CONFIG },
        { source: 'telegram', config: CONFIG },
      ]),
    ).resolves.toBeUndefined();

    expect((await rowOf('legacy-feishu')).imDefaultRoute).toBeNull();
    expect(parseImDefaultRouteRecord((await rowOf('legacy-telegram')).imDefaultRoute)).toEqual({
      v: 1,
      fp: 'fp-old',
      route: OLD,
    });
  });
});

describe('markImSessionManualRouteOverride', () => {
  it('marks a channel-owned task so it stops following for good', async () => {
    await insertTask('t1', OLD);
    await markImSessionManualRouteOverride('t1');

    expect(parseImDefaultRouteRecord((await rowOf('t1')).imDefaultRoute)).toEqual({
      v: 1,
      fp: '',
      route: OLD,
      manual: true,
    });
  });

  it('reads and writes through the client captured at entry (owner boundary)', async () => {
    // 墓碑读写跨 await, 期间登出/切号会让全局 getDbClient 指向新 owner —— 必须全程
    // 复用进入时捕获的客户端, 不能在 await 间隙重读全局(PR #5155 review P1)。
    await insertTask('t1', OLD);
    const realDb = db;
    const write = markImSessionManualRouteOverride('t1');
    // 全局客户端在中途被换成别的 owner(必炸)。
    db = {
      select: () => { throw new Error('owner switched'); },
      update: () => { throw new Error('owner switched'); },
    } as never;
    await write;
    db = realDb;

    expect(parseImDefaultRouteRecord((await rowOf('t1')).imDefaultRoute)?.manual).toBe(true);
  });

  it('refuses to write the marker when the owner scope changed mid-flight', async () => {
    // owner 换了还写 = 把 A 的墓碑写进 B 的同 ID 任务; 不写又假装成功 = A 的手动
    // 选择没有墓碑、会被渠道默认覆盖 —— 写入前复核 owner scope, 变了就抛错让上层
    // 按选择失败重试(PR #5155 review P1)。
    await insertTask('t1', OLD);
    mocks.ownerScopeKey.mockReturnValueOnce('owner-1').mockReturnValueOnce('owner-2');

    await expect(markImSessionManualRouteOverride('t1')).rejects.toThrow(/retry the selection/);
    expect((await rowOf('t1')).imDefaultRoute).toBe(buildImDefaultRouteRecord('fp-old', OLD));
  });

  it('refuses to write the marker while an account boundary is in flight', async () => {
    await insertTask('t1', OLD);
    mocks.boundaryPending.mockReturnValueOnce(true);

    await expect(markImSessionManualRouteOverride('t1')).rejects.toThrow(/retry the selection/);
    expect((await rowOf('t1')).imDefaultRoute).toBe(buildImDefaultRouteRecord('fp-old', OLD));
  });

  it('does not touch tasks outside the channel follow surface', async () => {
    await insertTask('desktop', OLD, { source: 'desktop', record: null });
    await insertTask('remote', OLD, { remoteHostId: 'ssh-1' });
    await markImSessionManualRouteOverride('desktop');
    await markImSessionManualRouteOverride('remote');

    expect((await rowOf('desktop')).imDefaultRoute).toBeNull();
    expect((await rowOf('remote')).imDefaultRoute).toBe(buildImDefaultRouteRecord('fp-old', OLD));
  });
});

describe('resetImSessionToChannelDefaults', () => {
  it('writes the new route with its record and drops a stale pending switch', async () => {
    await insertTask('t1', { ...OLD, model: 'claude-sonnet-5' });
    mocks.readPendingRoute.mockReturnValue(NEW);
    await resetImSessionToChannelDefaults(
      't1',
      CONFIG,
      {
        id: 't1',
        agentKind: 'codex',
        workingDir: '/tmp/im',
        model: 'gpt-5.5',
        effort: 'high',
        permissionMode: 'auto',
        fastMode: false,
        sdkSessionId: null,
        providerId: 'openai',
        defaultRouteFingerprint: 'fp-new',
      },
      'feishu',
    );

    const row = await rowOf('t1');
    expect(row.model).toBe('gpt-5.5');
    expect(parseImDefaultRouteRecord(row.imDefaultRoute)).toEqual({ v: 1, fp: 'fp-new', route: NEW });
    expect(mocks.cancelPending).toHaveBeenCalledWith('t1');
  });
});

describe('createSession', () => {
  it('records the channel default it created the task from, and keeps a revived row as is', async () => {
    const { createImSessionRepo } = await import('../sessionRepo');
    mocks.resolveDefaults.mockResolvedValue({ ...NEW, permissionMode: 'auto', fastMode: false, fingerprint: 'fp-new' });
    const ns = {
      source: 'feishu',
      sessionIdFor: (bot: string, user: string) => `feishu_${bot}_${user}`,
      defaultTitle: () => 'Feishu',
      ensureWorkingDir: () => '/tmp/im',
      extraInsertColumns: (bot: string, user: string) => ({ feishuBotAppId: bot, feishuOpenId: user }),
    } as unknown as Parameters<typeof createImSessionRepo>[1];
    const repo = createImSessionRepo(CONFIG, ns);

    const created = await repo.createSession('cli_bot', 'ou_user');
    expect(parseImDefaultRouteRecord((await rowOf(created.id)).imDefaultRoute)).toEqual({
      v: 1,
      fp: 'fp-new',
      route: NEW,
    });

    // 冲突(复活)分支不碰路由与记录 —— 残留行保留自己的设置。
    await db.update(sessions).set({ status: 'archived', imDefaultRoute: 'kept' }).where(eq(sessions.id, created.id));
    await repo.createSession('cli_bot', 'ou_user');
    expect((await rowOf(created.id)).imDefaultRoute).toBe('kept');
  });
});
