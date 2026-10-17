/**
 * 伙伴任务在侧栏里怎么归组。
 *
 * 两条硬要求:
 *   1. **一个伙伴的任务聚在一起**,不按工作目录散进项目组 —— 同一个伙伴可以在
 *      多个项目里干活,按目录分会把它的对话切碎。
 *   2. **归属表还没到的时候,任务不能消失**。会话行本身不带 botId,归属只有伙伴
 *      档案知道;档案迟到的那一瞬间宁可落到未分类,也不能整个不见。
 */

import { describe, expect, it, vi } from 'vitest';

import { groupSessions } from '@/features/cc-agent/lib/projectGrouping';
import type { Session } from '@/lib/ccAgent.types';
import {
  botRouteForOwnedSession,
  buildBotSessionOwners,
  createSessionEntryNavigator,
  findBotProfileForSession,
  resolveBotRouteForSessionEntry,
  type BotSessionEntryTarget,
} from '../botSessionOwners';
import type { BotProfile } from '../botStore';

function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    source: 'bot',
    workingDir: '/w/project-a',
    status: 'active',
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
    userSendAt: '2026-08-22T00:00:00.000Z',
    pinnedAt: null,
    workspaceKind: 'project',
    _count: { messages: 3 },
    ...over,
  } as unknown as Session;
}

function profile(over: Partial<BotProfile> = {}): BotProfile {
  return {
    id: 'bot-a',
    name: '小柴',
    avatar: 'shiba',
    avatarColor: 'violet',
    canonicalSessionId: 's-main',
    sessions: [
      { id: 's-main', role: 'canonical' },
      { id: 's-telegram', role: 'route' },
      { id: 's-old', role: 'history' },
    ],
    ...over,
  } as unknown as BotProfile;
}

describe('伙伴归属表', () => {
  it('主对话、渠道任务、归档历史三种都收', () => {
    const owners = buildBotSessionOwners([profile()]);
    expect([...owners.keys()].sort()).toEqual(['s-main', 's-old', 's-telegram']);
    expect(owners.get('s-telegram')).toEqual({
      botId: 'bot-a',
      displayName: '小柴',
      avatar: 'shiba',
      avatarColor: 'violet',
    });
  });

  it('没有注册表投影时不使用兼容镜像认领任务', () => {
    const owners = buildBotSessionOwners([profile({ sessions: [] })]);
    expect(owners.has('s-main')).toBe(false);
    expect(findBotProfileForSession([profile({ sessions: [] })], 's-main')).toBeUndefined();
  });

  it('右侧栏等单任务入口也只认注册表投影', () => {
    const bot = profile({ canonicalSessionId: 'stale-mirror' });
    expect(findBotProfileForSession([bot], 's-main')).toBe(bot);
    expect(findBotProfileForSession([bot], 'stale-mirror')).toBeUndefined();
  });

  it('同一个任务只有一个地址：主任务回伙伴页，历史走历史页，后台任务走普通任务页', () => {
    const bot = profile({
      id: 'bot/a',
      sessions: [
        { id: 's-main', role: 'canonical', kind: 'chat' },
        { id: 's-telegram', role: 'route' },
        { id: 's-old', role: 'history', kind: 'history' },
        { id: 's-task', role: 'delegation', kind: 'worker' },
        { id: 's-worker', kind: 'worker' },
        { id: 's-lane', role: 'group', kind: 'group' },
      ] as unknown as BotProfile['sessions'],
    });
    expect(botRouteForOwnedSession([bot], 's-main')).toEqual({ route: '/bots/bot%2Fa', consumesAlert: false });
    expect(botRouteForOwnedSession([bot], 's-telegram')).toEqual({ route: '/bots/bot%2Fa/session/s-telegram', consumesAlert: false });
    expect(botRouteForOwnedSession([bot], 's-old')).toEqual({ route: '/bots/bot%2Fa/history/s-old', consumesAlert: false, gateConsumesAlert: true });
    expect(botRouteForOwnedSession([bot], 's-task')).toEqual({ route: '/cc-agent/s-task', consumesAlert: false });
    expect(botRouteForOwnedSession([bot], 's-worker')).toEqual({ route: '/cc-agent/s-worker', consumesAlert: false });
    expect(botRouteForOwnedSession([bot], 's-lane')).toEqual({ route: '/bots/bot%2Fa', consumesAlert: true });
    expect(botRouteForOwnedSession([bot], 'not-owned')).toBeNull();
  });

  it('通知点击把主任务送回伙伴页，子任务保留自己的任务地址', () => {
    const bot = profile({ id: 'bot/a' });
    expect(botRouteForOwnedSession([bot], 's-main')).toEqual({ route: '/bots/bot%2Fa', consumesAlert: false });
    expect(botRouteForOwnedSession([bot], 's-telegram')).toEqual({
      route: '/bots/bot%2Fa/session/s-telegram',
      consumesAlert: false,
    });
    expect(botRouteForOwnedSession([bot], 'not-owned')).toBeNull();
  });

  // 伙伴任务页只挂活的主对话;其它角色送过去只会落到「这个伙伴任务已不可用」,
  // 那里没有能处置报错的横幅,灵动岛上的报错卡就永远消不掉。
  it('历史任务走只读历史路由，由历史页自己的归属门禁处置它的提醒', () => {
    expect(botRouteForOwnedSession([profile()], 's-old')).toEqual({
      route: '/bots/bot-a/history/s-old',
      consumesAlert: false,
      gateConsumesAlert: true,
    });
  });

  // 普通任务页有自己的报错控件，入口不代为消除。
  it('委派执行任务进入普通任务页，保留页面自己的报错处理', () => {
    const bot = profile({
      sessions: [
        { id: 's-main', role: 'canonical', kind: 'chat' },
        { id: 's-delegated', role: 'delegation', kind: 'worker' },
      ] as unknown as BotProfile['sessions'],
    });
    expect(botRouteForOwnedSession([bot], 's-delegated')).toEqual({
      route: '/cc-agent/s-delegated',
      consumesAlert: false,
    });
  });

  it('群专线回到它所在的群，点击即处置；缺群 id 的旧投影回伙伴主页', () => {
    const bot = profile({
      sessions: [
        { id: 's-main', role: 'canonical', kind: 'chat' },
        { id: 's-lane', role: 'group', kind: 'group', groupId: 'g/1' },
        { id: 's-plan', role: 'group', kind: 'group', groupId: 'g-2' },
        { id: 's-legacy-lane', role: 'group', kind: 'group' },
      ] as unknown as BotProfile['sessions'],
    });
    expect(botRouteForOwnedSession([bot], 's-lane')).toEqual({ route: '/bots/groups/g%2F1', consumesAlert: true });
    expect(botRouteForOwnedSession([bot], 's-plan')).toEqual({ route: '/bots/groups/g-2', consumesAlert: true });
    expect(botRouteForOwnedSession([bot], 's-legacy-lane')).toEqual({ route: '/bots/bot-a', consumesAlert: true });
  });

});

describe('通知入口在伙伴投影未加载时的路由', () => {
  function deps(over: {
    current?: BotProfile[];
    loaded?: BotProfile[];
  }) {
    const loadProfiles = vi.fn<(refresh: boolean) => Promise<BotProfile[]>>(async () => over.loaded ?? []);
    return {
      loadProfiles,
      deps: {
        readProfiles: () => over.current ?? [],
        loadProfiles,
      },
    };
  }

  it('投影已含该任务时直接回伙伴页，不重载', async () => {
    const { deps: d, loadProfiles } = deps({ current: [profile()] });
    await expect(resolveBotRouteForSessionEntry('s-main', d)).resolves.toEqual({
      route: '/bots/bot-a',
      consumesAlert: false,
    });
    expect(loadProfiles).not.toHaveBeenCalled();
  });

  it('启动后从未进过伙伴页时先加载投影，再回伙伴页', async () => {
    const { deps: d, loadProfiles } = deps({ loaded: [profile()] });
    await expect(resolveBotRouteForSessionEntry('s-old', d)).resolves.toEqual({
      route: '/bots/bot-a/history/s-old',
      consumesAlert: false,
      gateConsumesAlert: true,
    });
    expect(loadProfiles).toHaveBeenCalledWith(true);
  });

  it('投影已加载后新委派出去的任务（行上仍是 desktop）也会重读投影，回到接手伙伴', async () => {
    const stale = profile();
    const delegated = profile({
      id: 'bot-b',
      canonicalSessionId: 's-b-main',
      sessions: [
        { id: 's-b-main', role: 'canonical' },
        { id: 's-delegated', role: 'delegation' },
      ] as unknown as BotProfile['sessions'],
    });
    const { deps: d, loadProfiles } = deps({ current: [stale], loaded: [stale, delegated] });
    await expect(resolveBotRouteForSessionEntry('s-delegated', d)).resolves.toEqual({
      route: '/cc-agent/s-delegated',
      consumesAlert: false,
    });
    expect(loadProfiles).toHaveBeenCalledWith(true);
  });

  it('不属于任何伙伴的任务重读后仍回普通任务路由', async () => {
    const { deps: d, loadProfiles } = deps({ current: [profile()], loaded: [profile()] });
    await expect(resolveBotRouteForSessionEntry('plain', d)).resolves.toBeNull();
    expect(loadProfiles).toHaveBeenCalledTimes(1);
  });

  it('连续点击时，先点的慢查询不会覆盖后点的导航', async () => {
    const pending = new Map<string, (target: BotSessionEntryTarget | null) => void>();
    const openBotRoute = vi.fn();
    const openOrdinary = vi.fn();
    const consumeAlert = vi.fn();
    const open = createSessionEntryNavigator({
      resolveBotRoute: (sessionId) => new Promise((resolve) => pending.set(sessionId, resolve)),
      openBotRoute,
      consumeAlert,
      openOrdinary,
    });
    open('first');
    open('second', 'message-1');
    pending.get('second')!(null);
    await Promise.resolve();
    expect(openOrdinary).toHaveBeenCalledWith('second', 'message-1', expect.any(Function));
    // A superseded click neither navigates nor disposes its Session's alert.
    pending.get('first')!({ route: '/bots/groups/g-1', consumesAlert: true });
    await Promise.resolve();
    expect(openBotRoute).not.toHaveBeenCalled();
    expect(consumeAlert).not.toHaveBeenCalled();
    // The ordinary path's own late async route checks the same latest gate.
    const isLatest = openOrdinary.mock.calls[0]![2] as () => boolean;
    expect(isLatest()).toBe(true);
    open('third');
    expect(isLatest()).toBe(false);
  });

  it('后台任务走普通任务入口，保留消息锚点与灵动岛上报', async () => {
    const openBotRoute = vi.fn();
    const openOrdinary = vi.fn();
    const consumeAlert = vi.fn();
    const open = createSessionEntryNavigator({
      resolveBotRoute: async () => ({ route: '/cc-agent/s-task', consumesAlert: false }),
      consumeAlert,
      openBotRoute,
      openOrdinary,
    });
    open('s-task', 'message-9', 'entry-task');
    await Promise.resolve();
    await Promise.resolve();
    open.locationCommitted('/cc-agent/s-task');
    expect(consumeAlert).not.toHaveBeenCalled();
    expect(openBotRoute).not.toHaveBeenCalled();
    expect(openOrdinary).toHaveBeenCalledWith('s-task', 'message-9', expect.any(Function));
  });

  describe('灵动岛点击的处置等目标地址提交后才发', () => {
    const targets: Record<string, BotSessionEntryTarget> = {
      's-lane': { route: '/bots/groups/g-1', consumesAlert: true },
      's-main': { route: '/bots/bot-a', consumesAlert: false },
      's-old': { route: '/bots/bot-a/history/s-old', consumesAlert: false, gateConsumesAlert: true },
    };
    function setup(over: { openBotRoute?: (route: string, islandEntryId?: string) => void } = {}) {
      const openBotRoute = vi.fn(over.openBotRoute ?? (() => undefined));
      const consumeAlert = vi.fn();
      const open = createSessionEntryNavigator({
        resolveBotRoute: async (sessionId) => targets[sessionId] ?? null,
        openBotRoute,
        consumeAlert,
        openOrdinary: vi.fn(),
      });
      return { open, openBotRoute, consumeAlert };
    }
    const settle = async () => {
      await Promise.resolve();
      await Promise.resolve();
    };

    it('navigate 返回不算落地：目标地址提交后才处置这次点击', async () => {
      const { open, openBotRoute, consumeAlert } = setup();
      open.locationCommitted('/cc-agent/new');
      open('s-lane', undefined, 'entry-1');
      await settle();
      expect(openBotRoute).toHaveBeenCalledWith('/bots/groups/g-1', undefined);
      expect(consumeAlert).not.toHaveBeenCalled();
      open.locationCommitted('/bots/groups/g-1');
      expect(consumeAlert).toHaveBeenCalledTimes(1);
      expect(consumeAlert).toHaveBeenCalledWith('s-lane', 'entry-1');
      // A later commit (e.g. coming back to the group) never re-sends it.
      open.locationCommitted('/cc-agent/new');
      open.locationCommitted('/bots/groups/g-1');
      expect(consumeAlert).toHaveBeenCalledTimes(1);
    });

    it('迟迟未提交、被重定向或改去别处时不处置', async () => {
      const { open, consumeAlert } = setup();
      open.locationCommitted('/cc-agent/new');
      open('s-lane', undefined, 'entry-1');
      await settle();
      // Delayed: nothing committed yet, nothing sent.
      expect(consumeAlert).not.toHaveBeenCalled();
      // The next commit is somewhere else: this click is done without disposal.
      open.locationCommitted('/bots/bot-a');
      open.locationCommitted('/bots/groups/g-1');
      expect(consumeAlert).not.toHaveBeenCalled();
    });

    it('落地前被新的入口取代时，旧点击即使随后提交到它的目标也不处置', async () => {
      const { open, consumeAlert } = setup();
      open.locationCommitted('/cc-agent/new');
      open('s-lane', undefined, 'entry-1');
      await settle();
      open('s-main');
      open.locationCommitted('/bots/groups/g-1');
      await settle();
      open.locationCommitted('/bots/bot-a');
      expect(consumeAlert).not.toHaveBeenCalled();
    });

    it('历史目标把点击编号交给历史页的归属门禁，导航器自己不处置', async () => {
      const { open, openBotRoute, consumeAlert } = setup();
      open.locationCommitted('/cc-agent/new');
      open('s-old', undefined, 'entry-6');
      await settle();
      expect(openBotRoute).toHaveBeenLastCalledWith('/bots/bot-a/history/s-old', 'entry-6');
      open.locationCommitted('/bots/bot-a/history/s-old');
      // Already open: the click id is handed over again rather than consumed here.
      open('s-old', undefined, 'entry-7');
      await settle();
      expect(openBotRoute).toHaveBeenLastCalledWith('/bots/bot-a/history/s-old', 'entry-7');
      // Entries without a click id, and other targets, hand nothing over.
      open('s-old');
      await settle();
      expect(openBotRoute).toHaveBeenLastCalledWith('/bots/bot-a/history/s-old', undefined);
      open('s-lane', undefined, 'entry-8');
      await settle();
      expect(openBotRoute).toHaveBeenLastCalledWith('/bots/groups/g-1', undefined);
      expect(consumeAlert).not.toHaveBeenCalled();
    });

    it('目标本已打开时 navigate 不会再提交，直接处置这次点击', async () => {
      const { open, consumeAlert } = setup();
      open.locationCommitted('/bots/groups/g-1');
      open('s-lane', undefined, 'entry-2');
      await settle();
      expect(consumeAlert).toHaveBeenCalledWith('s-lane', 'entry-2');
    });

    it('没有灵动岛点击编号的入口(系统通知、深链)和活的主对话都不处置', async () => {
      const { open, consumeAlert } = setup();
      open.locationCommitted('/cc-agent/new');
      open('s-lane');
      await settle();
      open.locationCommitted('/bots/groups/g-1');
      open('s-main', undefined, 'entry-3');
      await settle();
      open.locationCommitted('/bots/bot-a');
      expect(consumeAlert).not.toHaveBeenCalled();
    });

    it('解析尚未完成时地址已提交（改去别处或自己打开了目标）：照常导航但不代为处置', async () => {
      let resolveTarget!: (target: BotSessionEntryTarget | null) => void;
      const openBotRoute = vi.fn();
      const consumeAlert = vi.fn();
      const open = createSessionEntryNavigator({
        resolveBotRoute: () => new Promise((resolve) => { resolveTarget = resolve; }),
        openBotRoute,
        consumeAlert,
        openOrdinary: vi.fn(),
      });
      open.locationCommitted('/cc-agent/new');
      // The user moves elsewhere while the Bot projection is still loading.
      open('s-lane', undefined, 'entry-5');
      open.locationCommitted('/elsewhere');
      resolveTarget(targets['s-lane']!);
      await settle();
      expect(openBotRoute).toHaveBeenCalledWith('/bots/groups/g-1', undefined);
      open.locationCommitted('/bots/groups/g-1');
      expect(consumeAlert).not.toHaveBeenCalled();

      // The user opens the target address themselves before the lookup returns.
      open('s-lane', undefined, 'entry-6');
      open.locationCommitted('/cc-agent/new');
      open.locationCommitted('/bots/groups/g-1');
      resolveTarget(targets['s-lane']!);
      await settle();
      open.locationCommitted('/bots/groups/g-1');
      expect(consumeAlert).not.toHaveBeenCalled();

      // A history target does not get the click id handed to its gate either.
      open('s-old', undefined, 'entry-9');
      open.locationCommitted('/elsewhere');
      resolveTarget(targets['s-old']!);
      await settle();
      expect(openBotRoute).toHaveBeenLastCalledWith('/bots/bot-a/history/s-old', undefined);
    });

    it('导航抛错时丢弃待处置，之后到达同一地址也不处置', async () => {
      const failures: unknown[] = [];
      const onRejection = (reason: unknown) => failures.push(reason);
      process.on('unhandledRejection', onRejection);
      try {
        const { open, consumeAlert } = setup({ openBotRoute: () => { throw new Error('blocked'); } });
        open.locationCommitted('/cc-agent/new');
        open('s-lane', undefined, 'entry-4');
        await settle();
        await new Promise((resolve) => setTimeout(resolve, 0));
        open.locationCommitted('/bots/groups/g-1');
        expect(consumeAlert).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', onRejection);
      }
      expect(failures).toHaveLength(1);
    });
  });

  it('加载投影失败时退回普通任务路由，不吞掉这次点击', async () => {
    const d = {
      readProfiles: () => [],
      loadProfiles: vi.fn(async () => { throw new Error('not ready'); }),
    };
    await expect(resolveBotRouteForSessionEntry('s-main', d)).resolves.toBeNull();
  });
});

describe('侧栏按伙伴分组', () => {
  it('同一个伙伴在不同项目里的任务聚在一组,不按目录切碎', () => {
    const owners = buildBotSessionOwners([profile()]);
    const result = groupSessions(
      [
        session('s-main', { workingDir: '/w/project-a' }),
        session('s-telegram', { workingDir: '/w/project-b' }),
        session('s-other', { workingDir: '/w/project-a', source: 'desktop' }),
      ],
      { botOwnerBySessionId: owners },
    );
    expect(result.bots).toHaveLength(1);
    expect(result.bots[0]!.displayName).toBe('小柴');
    expect(result.bots[0]!.sessions.map((s) => s.id).sort()).toEqual(['s-main', 's-telegram']);
    // 普通会话照旧按目录进项目组,一点没受影响。
    expect(result.projects.flatMap((p) => p.sessions.map((s) => s.id))).toEqual(['s-other']);
  });

  it('归属表还没到时任务不消失 —— 走原来的分组,宁可落到别处也不能不见', () => {
    const result = groupSessions([session('s-main')], {});
    const seen = [
      ...result.bots.flatMap((b) => b.sessions.map((s) => s.id)),
      ...result.projects.flatMap((p) => p.sessions.map((s) => s.id)),
      ...result.unclassified.map((s) => s.id),
      ...result.dialogues.map((s) => s.id),
    ];
    expect(seen).toContain('s-main');
  });

  it('用户 pin 过的伙伴任务仍然只出现在置顶区', () => {
    const owners = buildBotSessionOwners([profile()]);
    const result = groupSessions(
      [session('s-main', { pinnedAt: '2026-08-22T01:00:00.000Z' }), session('s-telegram')],
      { botOwnerBySessionId: owners },
    );
    expect(result.pinned.map((s) => s.id)).toEqual(['s-main']);
    expect(result.bots[0]!.sessions.map((s) => s.id)).toEqual(['s-telegram']);
  });

  it('多个伙伴按最近活动倒序', () => {
    const owners = buildBotSessionOwners([
      profile(),
      profile({ id: 'bot-b', name: '林律', canonicalSessionId: 's-b', sessions: [{ id: 's-b' }] as never }),
    ]);
    const result = groupSessions(
      [
        session('s-main', { updatedAt: '2026-08-22T00:00:00.000Z', userSendAt: '2026-08-22T00:00:00.000Z' }),
        session('s-b', { updatedAt: '2026-08-22T09:00:00.000Z', userSendAt: '2026-08-22T09:00:00.000Z' }),
      ],
      { botOwnerBySessionId: owners },
    );
    expect(result.bots.map((b) => b.displayName)).toEqual(['林律', '小柴']);
  });
});
