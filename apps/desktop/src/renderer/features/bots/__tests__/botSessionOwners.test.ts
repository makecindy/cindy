/** 伙伴任务的归属查找与入口路由。 */

import { describe, expect, it, vi } from 'vitest';

import {
  botRouteForOwnedSession,
  createSessionEntryNavigator,
  findBotProfileForSession,
  remoteBotRouteForSession,
  resolveBotRouteForSessionEntry,
  type BotSessionEntryTarget,
} from '../botSessionOwners';
import type { BotProfile } from '../botStore';

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
  // 测试价值: 灵动岛/通知统一入口遇到 IM channel 原先落入不可用的可写页。
  // 最小失败输入: 只有一条 channel 投影; unit, 直接验证生产路由结果。
  it('opens hidden IM tasks in the ordinary task page', () => {
    const bot = profile({ sessions: [
      { id: 's/feishu', role: 'channel', kind: 'channel', status: 'active' },
    ] as BotProfile['sessions'] });
    expect(botRouteForOwnedSession([bot], 's/feishu')).toEqual({
      route: '/cc-agent/s%2Ffeishu', consumesAlert: false,
    });
  });

  // Regression: kind=chat used to win over the unique durable canonical role.
  // Unit, production route; the older fixture put canonical first and missed this ordering.
  it('keeps old chat links and ambiguous canonical projections on their original task', () => {
    const bot = profile({ sessions: [
      { id: 'old', kind: 'chat', role: 'history' },
      { id: 'current', kind: 'chat', role: 'canonical' },
    ] as BotProfile['sessions'] });
    expect(botRouteForOwnedSession([bot], 'old')?.route).toBe('/cc-agent/old');
    expect(botRouteForOwnedSession([bot], 'current')?.route).toBe('/bots/bot-a/session/current');
    bot.sessions.push({ id: 'duplicate', role: 'canonical' } as BotProfile['sessions'][number]);
    expect(botRouteForOwnedSession([bot], 'current')?.route).toBe('/cc-agent/current');
  });

  it('没有注册表投影时不使用兼容镜像认领任务', () => {
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
    expect(botRouteForOwnedSession([bot], 's-main')).toEqual({ route: '/bots/bot%2Fa/session/s-main', consumesAlert: false });
    expect(botRouteForOwnedSession([bot], 's-telegram')).toEqual({ route: '/cc-agent/s-telegram', consumesAlert: false });
    expect(botRouteForOwnedSession([bot], 's-old')).toEqual({ route: '/cc-agent/s-old', consumesAlert: false });
    expect(botRouteForOwnedSession([bot], 's-task')).toEqual({ route: '/cc-agent/s-task', consumesAlert: false });
    expect(botRouteForOwnedSession([bot], 's-worker')).toEqual({ route: '/cc-agent/s-worker', consumesAlert: false });
    expect(botRouteForOwnedSession([bot], 's-lane')).toEqual({ route: '/cc-agent/s-lane', consumesAlert: false });
    expect(botRouteForOwnedSession([bot], 'not-owned')).toBeNull();
  });

  it('通知点击把主任务送回伙伴页，子任务保留自己的任务地址', () => {
    const bot = profile({ id: 'bot/a' });
    expect(botRouteForOwnedSession([bot], 's-main')).toEqual({ route: '/bots/bot%2Fa/session/s-main', consumesAlert: false });
    expect(botRouteForOwnedSession([bot], 's-telegram')).toEqual({
      route: '/cc-agent/s-telegram',
      consumesAlert: false,
    });
    expect(botRouteForOwnedSession([bot], 'not-owned')).toBeNull();
  });

  // 伙伴任务页只挂活的主对话;其它角色送过去只会落到「这个伙伴任务已不可用」,
  // 那里没有能处置报错的横幅,灵动岛上的报错卡就永远消不掉。
  it('历史任务走普通任务路由，由任务页处理提醒', () => {
    expect(botRouteForOwnedSession([profile()], 's-old')).toEqual({
      route: '/cc-agent/s-old',
      consumesAlert: false,
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

  // 主力电脑在另一台设备的伙伴不在本机投影里：此前灵动岛点击只能落到普通任务页。
  it('主力电脑在别的设备上的伙伴，点击回到那台设备的伙伴页', () => {
    const remote = [{ id: 'opus', deviceId: 'mac studio', sessionId: 's-remote' }];
    expect(remoteBotRouteForSession(remote, 's-remote')).toEqual({
      route: '/bots/remote/mac%20studio/opus/session/s-remote',
      consumesAlert: false,
    });
    expect(remoteBotRouteForSession(remote, 's-other')).toBeNull();
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
    expect(botRouteForOwnedSession([bot], 's-lane')).toEqual({ route: '/cc-agent/s-lane', consumesAlert: false });
    expect(botRouteForOwnedSession([bot], 's-plan')).toEqual({ route: '/cc-agent/s-plan', consumesAlert: false });
    expect(botRouteForOwnedSession([bot], 's-legacy-lane')).toEqual({ route: '/cc-agent/s-legacy-lane', consumesAlert: false });
  });

});

describe('通知入口在伙伴投影未加载时的路由', () => {
  // External task links carry a device, including this computer's own id. Resolve
  // it within the existing latest-entry guard before consulting local Bot ownership.
  it.each([true, false])('routes an explicit device without letting a same-id local Bot win (remote=%s)', async (remote) => {
    const openOrdinary = vi.fn();
    const openBotRoute = vi.fn();
    const readKnownBotRoute = vi.fn(() => ({ route: '/bots/local', consumesAlert: false }));
    const open = createSessionEntryNavigator({
      isRemoteDevice: async () => remote,
      readKnownBotRoute,
      resolveBotRoute: vi.fn(),
      openBotRoute, consumeAlert: vi.fn(), openOrdinary,
    });
    open('same', 'message-1', undefined, 'device-1');
    await Promise.resolve();
    if (remote) {
      expect(openOrdinary).toHaveBeenCalledWith('same', 'message-1', expect.any(Function), 'device-1');
      expect(readKnownBotRoute).not.toHaveBeenCalled();
      expect(openBotRoute).not.toHaveBeenCalled();
    } else {
      expect(openBotRoute).toHaveBeenCalledWith('/bots/local', undefined, 'message-1', 'same');
      expect(openOrdinary).not.toHaveBeenCalled();
    }
  });

  it('drops a delayed device lookup after a newer entry has opened', async () => {
    let resolveDevice!: (remote: boolean) => void;
    const openOrdinary = vi.fn();
    const open = createSessionEntryNavigator({
      isRemoteDevice: () => new Promise((resolve) => { resolveDevice = resolve; }),
      readKnownBotRoute: () => null, resolveBotRoute: async () => null,
      openBotRoute: vi.fn(), consumeAlert: vi.fn(), openOrdinary,
    });
    open('old', undefined, undefined, 'other-mac');
    open('new');
    resolveDevice(true);
    await Promise.resolve();
    expect(openOrdinary).toHaveBeenCalledTimes(1);
    expect(openOrdinary).toHaveBeenCalledWith('new', undefined, expect.any(Function));
  });

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
      route: '/bots/bot-a/session/s-main',
      consumesAlert: false,
    });
    expect(loadProfiles).not.toHaveBeenCalled();
  });

  it('启动后从未进过伙伴页时先加载投影，再打开原历史任务', async () => {
    const { deps: d, loadProfiles } = deps({ loaded: [profile()] });
    await expect(resolveBotRouteForSessionEntry('s-old', d)).resolves.toEqual({
      route: '/cc-agent/s-old',
      consumesAlert: false,
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

  // 灵动岛 / 通知点进普通任务曾要先等整份伙伴列表重读完（实测 0.1–7 秒）才开始跳转。
  it('投影不认识的任务立刻打开普通任务页，不等伙伴投影重读', () => {
    const openOrdinary = vi.fn();
    const resolveBotRoute = vi.fn(() => new Promise<BotSessionEntryTarget | null>(() => undefined));
    const open = createSessionEntryNavigator({
      readKnownBotRoute: () => null,
      resolveBotRoute,
      openBotRoute: vi.fn(),
      consumeAlert: vi.fn(),
      openOrdinary,
    });
    open('plain', 'message-1', 'entry-1');
    expect(openOrdinary).toHaveBeenCalledWith('plain', 'message-1', expect.any(Function));
    expect(resolveBotRoute).toHaveBeenCalledWith('plain');
  });

  it('连续点击时，先点的慢查询不会覆盖后点的导航', async () => {
    const pending = new Map<string, (target: BotSessionEntryTarget | null) => void>();
    const openBotRoute = vi.fn();
    const openOrdinary = vi.fn();
    const consumeAlert = vi.fn();
    const open = createSessionEntryNavigator({
      readKnownBotRoute: () => null,
      resolveBotRoute: (sessionId) => new Promise((resolve) => pending.set(sessionId, resolve)),
      openBotRoute,
      consumeAlert,
      openOrdinary,
    });
    open('first');
    open('second', 'message-1');
    // A superseded click's late re-read neither navigates nor disposes its Session's alert.
    pending.get('first')!({ route: '/bots/groups/g-1', consumesAlert: true });
    await Promise.resolve();
    expect(openBotRoute).not.toHaveBeenCalled();
    expect(consumeAlert).not.toHaveBeenCalled();
    // The ordinary path's own late async route checks the same latest gate.
    const isFirstLatest = openOrdinary.mock.calls[0]![2] as () => boolean;
    const isSecondLatest = openOrdinary.mock.calls[1]![2] as () => boolean;
    expect(isFirstLatest()).toBe(false);
    expect(isSecondLatest()).toBe(true);
    open('third');
    expect(isSecondLatest()).toBe(false);
  });

  it('preserves message anchors through a late companion correction and cancels on owner change or manual navigation', async () => {
    let currentOwner = true;
    let resolve!: (value: BotSessionEntryTarget | null) => void;
    const openOrdinary = vi.fn();
    const openBotRoute = vi.fn();
    const open = createSessionEntryNavigator({
      captureOwner: () => () => currentOwner,
      readKnownBotRoute: () => null,
      resolveBotRoute: () => new Promise(done => { resolve = done; }),
      openOrdinary, openBotRoute, consumeAlert: vi.fn(),
    });
    open('original', 'reply');
    resolve({ route: '/bots/b/session/original', consumesAlert: false });
    await Promise.resolve();
    expect(openBotRoute).toHaveBeenLastCalledWith('/bots/b/session/original', undefined, 'reply', 'original');
    openBotRoute.mockClear();
    open('old-owner', 'reply');
    currentOwner = false;
    resolve({ route: '/bots/b/session/old-owner', consumesAlert: false });
    await Promise.resolve();
    expect(openBotRoute).not.toHaveBeenCalled();
    expect(openOrdinary.mock.lastCall![2]()).toBe(false);
    currentOwner = true;
    open('slow');
    open.locationCommitted('/settings');
    expect(openOrdinary.mock.lastCall![2]()).toBe(false);
  });

  it('后台任务走普通任务入口，保留消息锚点与灵动岛上报，也不重读投影', async () => {
    const openBotRoute = vi.fn();
    const openOrdinary = vi.fn();
    const consumeAlert = vi.fn();
    const resolveBotRoute = vi.fn(async () => null);
    const open = createSessionEntryNavigator({
      readKnownBotRoute: () => ({ route: '/cc-agent/s-task', consumesAlert: false }),
      resolveBotRoute,
      consumeAlert,
      openBotRoute,
      openOrdinary,
    });
    open('s-task', 'message-9', 'entry-task');
    open.locationCommitted('/cc-agent/s-task');
    expect(consumeAlert).not.toHaveBeenCalled();
    expect(openBotRoute).not.toHaveBeenCalled();
    expect(resolveBotRoute).not.toHaveBeenCalled();
    expect(openOrdinary).toHaveBeenCalledWith('s-task', 'message-9', expect.any(Function));
  });

  describe('投影尚未认识的伙伴任务：先开普通任务页，重读后转到伙伴页（§6.2）', () => {
    function setup() {
      let resolveTarget!: (target: BotSessionEntryTarget | null) => void;
      const openBotRoute = vi.fn();
      const openOrdinary = vi.fn();
      const consumeAlert = vi.fn();
      const open = createSessionEntryNavigator({
        readKnownBotRoute: () => null,
        resolveBotRoute: () => new Promise((resolve) => { resolveTarget = resolve; }),
        openBotRoute,
        consumeAlert,
        openOrdinary,
      });
      const isOrdinaryLatest = () => (openOrdinary.mock.lastCall![2] as () => boolean)();
      return { open, openBotRoute, consumeAlert, resolve: (t: BotSessionEntryTarget | null) => resolveTarget(t), isOrdinaryLatest };
    }
    const lane: BotSessionEntryTarget = { route: '/bots/groups/g-1', consumesAlert: true };

    it('已落在该任务的普通页时转到伙伴页，并照常处置这次点击', async () => {
      const { open, openBotRoute, consumeAlert, resolve } = setup();
      open.locationCommitted('/cc-agent/new');
      open('s-lane', undefined, 'entry-1');
      open.locationCommitted('/cc-agent/s-lane');
      resolve(lane);
      await Promise.resolve();
      expect(openBotRoute).toHaveBeenCalledWith('/bots/groups/g-1', undefined, undefined, 's-lane');
      open.locationCommitted('/bots/groups/g-1');
      expect(consumeAlert).toHaveBeenCalledWith('s-lane', 'entry-1');
    });

    it('普通页还没落地就重读完成：取消普通页导航，直接去伙伴页', async () => {
      const { open, openBotRoute, resolve, isOrdinaryLatest } = setup();
      open.locationCommitted('/cc-agent/new');
      open('s-lane');
      resolve(lane);
      await Promise.resolve();
      expect(openBotRoute).toHaveBeenCalledWith('/bots/groups/g-1', undefined, undefined, 's-lane');
      expect(isOrdinaryLatest()).toBe(false);
    });

    it('离开后又回到普通页也算去过别处：不再拉回伙伴页，也不处置', async () => {
      const { open, openBotRoute, consumeAlert, resolve } = setup();
      open.locationCommitted('/cc-agent/new');
      open('s-lane', undefined, 'entry-3');
      open.locationCommitted('/cc-agent/s-lane');
      open.locationCommitted('/elsewhere');
      open.locationCommitted('/cc-agent/s-lane');
      resolve(lane);
      await Promise.resolve();
      expect(openBotRoute).not.toHaveBeenCalled();
      expect(consumeAlert).not.toHaveBeenCalled();
    });

    it('普通页导航因投影已更新直接落到伙伴页时，照常处置这次点击', async () => {
      const { open, consumeAlert, resolve } = setup();
      open.locationCommitted('/cc-agent/new');
      open('s-lane', undefined, 'entry-4');
      open.locationCommitted('/bots/groups/g-1');
      resolve(lane);
      await Promise.resolve();
      expect(consumeAlert).toHaveBeenCalledExactlyOnceWith('s-lane', 'entry-4');
    });

    it('用户已去了别处时不再拉回伙伴页，也不处置', async () => {
      const { open, openBotRoute, consumeAlert, resolve } = setup();
      open.locationCommitted('/cc-agent/new');
      open('s-lane', undefined, 'entry-2');
      open.locationCommitted('/elsewhere');
      resolve(lane);
      await Promise.resolve();
      open.locationCommitted('/bots/groups/g-1');
      expect(openBotRoute).not.toHaveBeenCalled();
      expect(consumeAlert).not.toHaveBeenCalled();
    });
  });

  describe('灵动岛点击的处置等目标地址提交后才发', () => {
    const targets: Record<string, BotSessionEntryTarget> = {
      's-lane': { route: '/bots/groups/g-1', consumesAlert: true },
      's-main': { route: '/bots/bot-a/session/s-main', consumesAlert: false },
      's-old': { route: '/cc-agent/s-old', consumesAlert: false },
    };
    function setup(over: { openBotRoute?: (route: string, islandEntryId?: string) => void } = {}) {
      const openBotRoute = vi.fn(over.openBotRoute ?? (() => undefined));
      const consumeAlert = vi.fn();
      const openOrdinary = vi.fn();
      const open = createSessionEntryNavigator({
        readKnownBotRoute: (sessionId) => targets[sessionId] ?? null,
        resolveBotRoute: async () => null,
        openBotRoute,
        consumeAlert,
        openOrdinary,
      });
      return { open, openBotRoute, consumeAlert, openOrdinary };
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
      expect(openBotRoute).toHaveBeenCalledWith('/bots/groups/g-1', undefined, undefined, 's-lane');
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

    it('历史任务交给普通任务页处理错误，不提前消除提醒', async () => {
      const { open, openOrdinary, consumeAlert } = setup();
      open.locationCommitted('/cc-agent/new');
      open('s-old', undefined, 'entry-6');
      await settle();
      expect(openOrdinary).toHaveBeenCalledWith('s-old', undefined, expect.any(Function));
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

    it('导航抛错时丢弃待处置，之后到达同一地址也不处置', async () => {
      const { open, consumeAlert } = setup({ openBotRoute: () => { throw new Error('blocked'); } });
      open.locationCommitted('/cc-agent/new');
      expect(() => open('s-lane', undefined, 'entry-4')).toThrow('blocked');
      open.locationCommitted('/bots/groups/g-1');
      expect(consumeAlert).not.toHaveBeenCalled();
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
