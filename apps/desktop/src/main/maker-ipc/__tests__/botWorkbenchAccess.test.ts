/**
 * 测试价值
 * - 生产入口与可观察结果:createBotWorkbenchAccess 的 read / continueTask / setResponsibility / get /
 *   readForOwner 对模型与主人界面返回的结果,以及是否真的投递、写入责任。
 * - 规则依据:2026-10-17 放弃「项目」——总调度伙伴可读全部任务(含在线电脑),但别的伙伴开的任务
 *   默认只看不跟:只有无创建者、自己开的,或宿主已把跟进人落到它身上的任务才能继续
 *   (TASK_FOLLOWED_BY_OTHER_BOT);观察层读不到时只放行确定不是伙伴开的本机任务。其它伙伴只碰
 *   自己开的或明确接手的任务;目录不授予任何权限;总调度身份查不到时 fail closed。
 * - 现有覆盖缺口:旧用例按项目目录授权,规则已整体替换;新授权矩阵此前没有任何覆盖。
 * - 最小失败输入:总调度 / 开任务的伙伴 / 无关伙伴 × 普通任务、伙伴专线、后台任务、归档任务、
 *   另一台电脑上的任务;别的伙伴开的任务(跟进人是它 / 已交给总调度);观察层没有这一行;
 *   共享给访客的任务(访客的话不能借伙伴之手推动主人账号里的事)。
 * - tier:unit(依赖全部注入,无数据库与 Electron)。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createBotWorkbenchAccess,
  parseWorkbenchTaskRef,
  type BotWorkbenchAccessDeps,
  type WorkbenchTargetFacts,
} from '../botWorkbenchAccess.js';

const BOTS: Record<string, string> = { 'main-scheduler': 'cindy-default', 'main-creator': 'writer', 'main-other': 'other' };

const ordinary = (id: string, extra: Partial<WorkbenchTargetFacts> = {}): WorkbenchTargetFacts => ({
  id, status: 'active', source: 'desktop', orcaRole: null, botLinked: false, delegationChild: false, ...extra,
});
const TARGETS: Record<string, WorkbenchTargetFacts> = {
  'owner-task': ordinary('owner-task'),
  'taken-task': ordinary('taken-task'),
  'im-task': ordinary('im-task', { source: 'feishu' }),
  'writer-child': ordinary('writer-child', { delegationChild: true }),
  'bot-lane': ordinary('bot-lane', { source: 'bot', botLinked: true }),
  'archived-task': ordinary('archived-task', { status: 'archived' }),
  'review-task': ordinary('review-task', { source: 'review' }),
  'writer-created': ordinary('writer-created'),
  'writer-handed': ordinary('writer-handed'),
  'scheduler-created': ordinary('scheduler-created'),
  'shared-task': ordinary('shared-task', { source: 'shared' }),
};
/** 观察层状态行:creator / follower 由宿主按伙伴设置推导。im-task 与 laptop::s-3 故意没有行。 */
const WATCHED: Record<string, { creatorBotId: string | null; followerBotId: string | null; shared?: boolean }> = {
  'owner-task': { creatorBotId: null, followerBotId: 'cindy-default' },
  'writer-child': { creatorBotId: 'writer', followerBotId: 'writer' },
  'writer-created': { creatorBotId: 'writer', followerBotId: 'writer' },
  'writer-handed': { creatorBotId: 'writer', followerBotId: 'cindy-default' },
  'scheduler-created': { creatorBotId: 'cindy-default', followerBotId: 'cindy-default' },
  'laptop::s-1': { creatorBotId: null, followerBotId: 'cindy-default' },
  'laptop::s-2': { creatorBotId: 'writer', followerBotId: 'writer' },
  'laptop::s-4': { creatorBotId: null, followerBotId: null, shared: true },
};

function setup(options: { scheduler?: string | null; watched?: boolean; authorized?: boolean } = {}) {
  const deps: BotWorkbenchAccessDeps = {
    hasActionAuthorization: () => options.authorized !== false,
    resolveCaller: async (callerSessionId) => (BOTS[callerSessionId]
      ? { ok: true, botId: BOTS[callerSessionId] }
      : { ok: false, errorCode: 'NOT_A_BOT_SESSION', message: 'no' }),
    schedulerBotId: async () => (options.scheduler === undefined ? 'cindy-default' : options.scheduler),
    readWatched: (taskKey) => (options.watched === false ? null : WATCHED[taskKey] ?? null),
    readResponsibleSessionIds: async (botId) => (botId === 'writer' ? ['taken-task', 'archived-task'] : []),
    saveResponsibility: vi.fn(async () => {}),
    listDelegations: async (botId) => new Map(botId === 'writer' ? [['writer-child', 'completed' as const]] : []),
    readTarget: async (sessionId) => TARGETS[sessionId] ?? null,
    readGlance: vi.fn(async (botId: string) => ({
      botId, scope: 'own' as const, waiting: [], working: [], lastSweepAt: 1, doneToday: 0, offlineDevices: [],
    })),
    readSessionTranscript: async () => ({ items: [{ role: 'user' as const, text: 'hi', at: 1 }], truncated: false }),
    readRemoteTranscript: vi.fn(async () => ({ ok: true as const, transcript: { items: [], truncated: false } })),
    sendToSession: vi.fn(async () => ({ ok: true as const, wakeKind: 'queued', queuedMessageId: 'q1' })),
    sendToRemoteSession: vi.fn(async () => ({ ok: true as const, wakeKind: 'resumed' })),
    notifyChanged: vi.fn(),
  };
  return { access: createBotWorkbenchAccess(deps), deps };
}

const code = (result: { ok: boolean; errorCode?: string }) => (result.ok ? 'ok' : result.errorCode);

describe('workbench authorization matrix', () => {
  it.each(['owner-task', 'taken-task', 'writer-handed', 'laptop::s-1'])(
    'observation responsibility never authorizes writing %s', async taskId => {
      const { access, deps } = setup({ authorized: false });
      expect((await access.read({ callerSessionId: 'main-scheduler', taskId })).ok).toBe(true);
      expect(await access.continueTask({ callerSessionId: 'main-scheduler', taskId, message: 'continue' }))
        .toMatchObject({ ok: false, errorCode: 'TASK_ACTION_AUTHORIZATION_REQUIRED' });
      expect(deps.sendToSession).not.toHaveBeenCalled();
      expect(deps.sendToRemoteSession).not.toHaveBeenCalled();
    },
  );
  it.each([
    // caller, task, read, continue
    ['main-scheduler', 'owner-task', 'ok', 'ok'],
    ['main-scheduler', 'im-task', 'ok', 'ok'],
    ['main-scheduler', 'laptop::s-1', 'ok', 'ok'],
    ['main-scheduler', 'writer-child', 'ok', 'TASK_FOLLOWED_BY_OTHER_BOT'],
    ['main-scheduler', 'writer-created', 'ok', 'TASK_FOLLOWED_BY_OTHER_BOT'],
    ['main-scheduler', 'writer-handed', 'ok', 'ok'],
    ['main-scheduler', 'scheduler-created', 'ok', 'ok'],
    ['main-scheduler', 'laptop::s-2', 'ok', 'TASK_FOLLOWED_BY_OTHER_BOT'],
    ['main-scheduler', 'laptop::s-3', 'ok', 'TASK_FOLLOWED_BY_OTHER_BOT'],
    // 共享给访客的任务里有账号外的人发的话:可以看,不能经工作台推动(本机与另一台电脑)。
    ['main-scheduler', 'shared-task', 'ok', 'TASK_SHARED_WITH_GUESTS'],
    ['main-scheduler', 'laptop::s-4', 'ok', 'TASK_SHARED_WITH_GUESTS'],
    ['main-scheduler', 'bot-lane', 'TASK_NOT_ACCESSIBLE', 'TASK_NOT_ACCESSIBLE'],
    ['main-scheduler', 'archived-task', 'ok', 'TASK_ARCHIVED'],
    ['main-scheduler', 'review-task', 'TASK_NOT_SUPPORTED', 'TASK_NOT_SUPPORTED'],
    ['main-scheduler', 'missing', 'TASK_NOT_FOUND', 'TASK_NOT_FOUND'],
    ['main-creator', 'taken-task', 'ok', 'ok'],
    ['main-creator', 'writer-child', 'ok', 'TASK_IS_BACKGROUND_TASK'],
    ['main-creator', 'owner-task', 'TASK_NOT_RESPONSIBLE', 'TASK_NOT_RESPONSIBLE'],
    ['main-creator', 'laptop::s-1', 'TASK_NOT_RESPONSIBLE', 'TASK_NOT_RESPONSIBLE'],
    ['main-other', 'writer-child', 'TASK_NOT_RESPONSIBLE', 'TASK_NOT_RESPONSIBLE'],
    ['main-other', 'taken-task', 'TASK_NOT_RESPONSIBLE', 'TASK_NOT_RESPONSIBLE'],
    ['owner-task', 'owner-task', 'NOT_A_BOT_SESSION', 'NOT_A_BOT_SESSION'],
  ])('%s on %s: read=%s continue=%s', async (caller, taskId, readCode, continueCode) => {
    const { access, deps } = setup();
    expect(code(await access.read({ callerSessionId: caller, taskId }))).toBe(readCode);
    expect(code(await access.continueTask({ callerSessionId: caller, taskId, message: '汇报当前进展并继续' }))).toBe(continueCode);
    const sent = vi.mocked(deps.sendToSession).mock.calls.length + vi.mocked(deps.sendToRemoteSession).mock.calls.length;
    expect(sent).toBe(continueCode === 'ok' ? 1 : 0);
  });

  it('fails closed when the scheduler is unknown, and routes remote continues to that computer', async () => {
    const closed = setup({ scheduler: null });
    expect(code(await closed.access.read({ callerSessionId: 'main-scheduler', taskId: 'owner-task' }))).toBe('TASK_NOT_RESPONSIBLE');
    expect(code(await closed.access.read({ callerSessionId: 'main-scheduler', taskId: 'laptop::s-1' }))).toBe('TASK_NOT_RESPONSIBLE');
    const open = setup();
    expect(await open.access.continueTask({ callerSessionId: 'main-scheduler', taskId: 'laptop::s-1', message: '继续' }))
      .toEqual({ ok: true, taskId: 'laptop::s-1', delivery: 'started' });
    expect(open.deps.sendToRemoteSession).toHaveBeenCalledWith({
      deviceId: 'laptop', sessionId: 's-1', message: '继续', dispatcherSessionId: 'main-scheduler',
    });
    // Following a task never silently records responsibility.
    expect(open.deps.saveResponsibility).not.toHaveBeenCalled();
  });

  it('without the watch table, the scheduler continues only local tasks known not to be opened by another companion', async () => {
    const { access, deps } = setup({ watched: false });
    const cont = (taskId: string) => access.continueTask({ callerSessionId: 'main-scheduler', taskId, message: '继续' });
    expect(code(await cont('owner-task'))).toBe('ok');
    expect(code(await cont('writer-handed'))).toBe('ok');
    expect(code(await cont('writer-child'))).toBe('TASK_FOLLOWED_BY_OTHER_BOT');
    expect(code(await cont('laptop::s-1'))).toBe('TASK_FOLLOWED_BY_OTHER_BOT');
    expect(code(await access.read({ callerSessionId: 'main-scheduler', taskId: 'laptop::s-1' }))).toBe('ok');
    const denied = await cont('writer-child');
    expect(denied).toMatchObject({ ok: false, message: expect.stringContaining('它开的任务也交给你跟进') });
    expect(deps.sendToRemoteSession).not.toHaveBeenCalled();
  });

  it('serves the owner detail view with the same rule and reports the glance only when ready', async () => {
    const { access, deps } = setup();
    expect(code(await access.readForOwner({ botId: 'writer', taskId: 'writer-child' }))).toBe('ok');
    expect(code(await access.readForOwner({ botId: 'writer', taskId: 'owner-task' }))).toBe('TASK_NOT_RESPONSIBLE');
    expect(await access.get({ callerSessionId: 'main-creator' })).toMatchObject({ ok: true, workbench: { botId: 'writer' } });
    vi.mocked(deps.readGlance).mockResolvedValueOnce(null);
    expect(code(await access.get({ callerSessionId: 'main-creator' }))).toBe('HOST_NOT_READY');
  });

  it('takes any followable local task without a directory, and releases only its own', async () => {
    const { access, deps } = setup();
    expect(await access.setResponsibility({ callerSessionId: 'main-other', taskId: 'owner-task', responsible: true }))
      .toEqual({ ok: true, taskId: 'owner-task', responsible: true });
    expect(deps.saveResponsibility).toHaveBeenCalledWith('other', 'owner-task', true);
    expect(code(await access.setResponsibility({ callerSessionId: 'main-other', taskId: 'bot-lane', responsible: true }))).toBe('TASK_NOT_ACCESSIBLE');
    expect(code(await access.setResponsibility({ callerSessionId: 'main-other', taskId: 'laptop::s-1', responsible: true }))).toBe('INVALID_ARGS');
    expect(code(await access.setResponsibility({ callerSessionId: 'main-other', taskId: 'taken-task', responsible: false }))).toBe('TASK_NOT_RESPONSIBLE');
  });

  it('parses only local ids and a single deviceId::sessionId', () => {
    expect(parseWorkbenchTaskRef('abc-1')).toEqual({ kind: 'local', sessionId: 'abc-1' });
    expect(parseWorkbenchTaskRef('dev::s')).toEqual({ kind: 'remote', deviceId: 'dev', sessionId: 's' });
    for (const bad of ['', 'a::b::c', '::s', 'claude:abc', 'pr:o/r#1', 42]) expect(parseWorkbenchTaskRef(bad)).toBeNull();
  });
});
