import { beforeAll, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import {
  buildSessionActionMenu,
  createLatestWriteGuard,
  createPendingWriteTracker,
  createSessionWriteQueue,
  createSwipeRowRegistry,
  pickWriteFields,
  pinToggleAction,
  retryPatchWhileLatest,
  swipeActionPatch,
  writeGuardFields,
} from '@/session/swipeRowRegistry';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('createSwipeRowRegistry', () => {
  it('打开新行时自动关掉上一行', () => {
    const registry = createSwipeRowRegistry();
    let closedA = 0;
    registry.onRowOpen('a', () => { closedA += 1; });
    registry.onRowOpen('b', () => undefined);
    expect(closedA).toBe(1);
  });

  it('同一行重复上报不会自己关自己', () => {
    const registry = createSwipeRowRegistry();
    let closedA = 0;
    registry.onRowOpen('a', () => { closedA += 1; });
    registry.onRowOpen('a', () => { closedA += 1; });
    expect(closedA).toBe(0);
  });

  it('迟到的 onRowClose 不抹掉新行记录', () => {
    const registry = createSwipeRowRegistry();
    let closedB = 0;
    registry.onRowOpen('a', () => undefined);
    registry.onRowOpen('b', () => { closedB += 1; });
    // A 的关闭动画回调此刻才到:不应清掉 B 的记录。
    registry.onRowClose('a');
    expect(registry.closeOpenRow()).toBe(true);
    expect(closedB).toBe(1);
  });

  it('closeOpenRow 空注册表返回 false,关闭后再关也是 false', () => {
    const registry = createSwipeRowRegistry();
    expect(registry.closeOpenRow()).toBe(false);
    let closed = 0;
    registry.onRowOpen('a', () => { closed += 1; });
    expect(registry.closeOpenRow()).toBe(true);
    expect(closed).toBe(1);
    expect(registry.closeOpenRow()).toBe(false);
  });

  it('onRowClose 之后 closeOpenRow 不再触发旧 close', () => {
    const registry = createSwipeRowRegistry();
    let closed = 0;
    registry.onRowOpen('a', () => { closed += 1; });
    registry.onRowClose('a');
    expect(registry.closeOpenRow()).toBe(false);
    expect(closed).toBe(0);
  });
});

describe('createLatestWriteGuard', () => {
  it('同 key 同字段后发的写使先发的写过期(置顶在途时取消置顶)', () => {
    const guard = createLatestWriteGuard();
    const pin = guard.begin('s1', ['pinnedAt']);
    const unpin = guard.begin('s1', ['pinnedAt']);
    expect(pin.isLatest()).toBe(false);
    expect(unpin.isLatest()).toBe(true);
  });

  it('同 key 无交集字段的写互不取代(review P1:重命名退避中用户置顶,重命名不得被丢弃)', () => {
    const guard = createLatestWriteGuard();
    const rename = guard.begin('s1', ['title']);
    const pin = guard.begin('s1', ['pinnedAt']);
    expect(rename.isLatest()).toBe(true);
    expect(pin.isLatest()).toBe(true);
  });

  it('部分交集即取代:归档(status+pinnedAt)使在途置顶(pinnedAt)过期,但不动重命名(title)', () => {
    const guard = createLatestWriteGuard();
    const rename = guard.begin('s1', ['title']);
    const pin = guard.begin('s1', ['pinnedAt']);
    const archive = guard.begin('s1', ['status', 'pinnedAt']);
    expect(pin.isLatest()).toBe(false);
    expect(rename.isLatest()).toBe(true);
    expect(archive.isLatest()).toBe(true);
  });

  it('不同 key 互不影响', () => {
    const guard = createLatestWriteGuard();
    const a = guard.begin('a', ['title']);
    const b = guard.begin('b', ['title']);
    expect(a.isLatest()).toBe(true);
    expect(b.isLatest()).toBe(true);
  });

  it('序号单调不回收:新笔终结后再开一笔,不与仍在途的旧笔撞号(review P2 场景)', () => {
    const guard = createLatestWriteGuard();
    // slow pin(seq 1)在途 → unpin(seq 2)成功终结 → archive 开始:
    // archive 必须是最新,pin 绝不能因序号重用被误判为最新(否则迟到回滚复活旧置顶态)。
    const pin = guard.begin('s1', ['pinnedAt']);
    guard.begin('s1', ['pinnedAt']); // unpin,成功并终结(不存在显式清理,登记常驻)
    const archive = guard.begin('s1', ['status', 'pinnedAt']);
    expect(archive.isLatest()).toBe(true);
    expect(pin.isLatest()).toBe(false);
  });
});

describe('pickWriteFields', () => {
  it('只挑本笔字段 + updatedAt,不整对象覆盖', () => {
    const updated = { id: 's1', title: '新名字', pinnedAt: '2026-01-01T00:00:00Z', status: 'active', updatedAt: 'ts' };
    expect(pickWriteFields(updated, ['title'])).toEqual({ title: '新名字', updatedAt: 'ts' });
  });

  it('source 缺字段时跳过,不产出 undefined 键', () => {
    expect(pickWriteFields({ title: 'x' } as { title: string }, ['pinnedAt'])).toEqual({});
  });

  it('updatedAt 单调不回退:旧回包时间戳不高于 floor 时不带 updatedAt(review P2 场景)', () => {
    const staleReply = { title: '新名字', updatedAt: '2026-07-14T00:00:01Z' };
    expect(pickWriteFields(staleReply, ['title'], '2026-07-14T00:00:02Z'))
      .toEqual({ title: '新名字' });
    expect(pickWriteFields(staleReply, ['title'], '2026-07-14T00:00:01Z'))
      .toEqual({ title: '新名字' });
  });

  it('updatedAt 比 floor 新(或无 floor)时正常带上', () => {
    const reply = { title: 'x', updatedAt: '2026-07-14T00:00:03Z' };
    expect(pickWriteFields(reply, ['title'], '2026-07-14T00:00:02Z'))
      .toEqual({ title: 'x', updatedAt: '2026-07-14T00:00:03Z' });
    expect(pickWriteFields(reply, ['title'], null))
      .toEqual({ title: 'x', updatedAt: '2026-07-14T00:00:03Z' });
  });
});

describe('createSessionWriteQueue', () => {
  it('同 key 同字段严格串行:下一笔等上一笔 settle 后才执行', async () => {
    const queue = createSessionWriteQueue();
    const order: string[] = [];
    let releaseA!: () => void;
    const blockedA = new Promise<void>((resolve) => { releaseA = resolve; });
    const p1 = queue.enqueue('s1', ['pinnedAt'], async () => {
      order.push('a-start');
      await blockedA;
      order.push('a-end');
      return 'a';
    });
    const p2 = queue.enqueue('s1', ['pinnedAt'], async () => {
      order.push('b');
      return 'b';
    });
    await vi.waitFor(() => expect(order).toEqual(['a-start']));
    releaseA();
    await expect(p1).resolves.toBe('a');
    await expect(p2).resolves.toBe('b');
    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });

  it('上一笔失败不阻断下一笔,失败原样抛给自己的调用方', async () => {
    const queue = createSessionWriteQueue();
    const p1 = queue.enqueue('s1', ['pinnedAt'], () => Promise.reject(new Error('boom')));
    const p2 = queue.enqueue('s1', ['pinnedAt'], () => Promise.resolve('ok'));
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe('ok');
  });

  it('不同 key 互不排队', async () => {
    const queue = createSessionWriteQueue();
    let releaseA!: () => void;
    const blockedA = new Promise<void>((resolve) => { releaseA = resolve; });
    const order: string[] = [];
    const p1 = queue.enqueue('s1', ['title'], async () => { await blockedA; order.push('s1'); });
    const p2 = queue.enqueue('s2', ['title'], async () => { order.push('s2'); });
    await p2;
    expect(order).toEqual(['s2']);
    releaseA();
    await p1;
  });

  it('同 key 无交集字段并行出网:归档不被在途重命名拖住(review P2 场景)', async () => {
    const queue = createSessionWriteQueue();
    let releaseRename!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseRename = resolve; });
    const order: string[] = [];
    const pRename = queue.enqueue('s1', ['title'], async () => { await blocked; order.push('rename'); });
    const pArchive = queue.enqueue('s1', ['status', 'pinnedAt'], async () => { order.push('archive'); });
    // 归档(status+pinnedAt)与重命名(title)无交集:不等重命名,立即执行
    await pArchive;
    expect(order).toEqual(['archive']);
    releaseRename();
    await pRename;
  });

  it('部分交集仍排队:置顶在途时归档(共享 pinnedAt 道)等它 settle', async () => {
    const queue = createSessionWriteQueue();
    let releasePin!: () => void;
    const blocked = new Promise<void>((resolve) => { releasePin = resolve; });
    const order: string[] = [];
    const pPin = queue.enqueue('s1', ['pinnedAt'], async () => { await blocked; order.push('pin'); });
    const pArchive = queue.enqueue('s1', ['status', 'pinnedAt'], async () => { order.push('archive'); });
    await Promise.resolve();
    expect(order).toEqual([]);
    releasePin();
    await pPin;
    await pArchive;
    expect(order).toEqual(['pin', 'archive']);
  });

  it('组合场景(review P1):同字段旧笔退避中被取代 → 让位,新笔随后出网,发出序 = 操作序', async () => {
    const guard = createLatestWriteGuard();
    const queue = createSessionWriteQueue();
    const sent: string[] = [];
    // 置顶 A:首发失败进退避
    const pin = guard.begin('s1', ['pinnedAt']);
    const sendPin = vi.fn().mockImplementation(() => {
      sent.push('pin');
      return Promise.reject(Object.assign(new Error('not connected'), { code: 'NOT_CONNECTED' }));
    });
    const pA = queue.enqueue('s1', ['pinnedAt'], () => retryPatchWhileLatest(pin.isLatest, sendPin));
    // 等 A 的首发真实出网(用户点击当刻队列为空,首发立即发生)
    await vi.waitFor(() => expect(sendPin).toHaveBeenCalledTimes(1));
    // 用户随即取消置顶 B:同字段新写登记(A 过期),排到 A 之后
    const unpin = guard.begin('s1', ['pinnedAt']);
    const sendUnpin = vi.fn().mockImplementation(() => {
      sent.push('unpin');
      return Promise.resolve('ok');
    });
    const pB = queue.enqueue('s1', ['pinnedAt'], () => retryPatchWhileLatest(unpin.isLatest, sendUnpin));
    // A 在下一次重发前因 isLatest 屏障让位;B 等 A settle 后出网并成功
    await expect(pA).resolves.toBeNull();
    await expect(pB).resolves.toBe('ok');
    expect(sent).toEqual(['pin', 'unpin']);
    expect(sendPin).toHaveBeenCalledTimes(1);
  });

  it('组合场景(review P1 二连):无交集字段互不取代——重命名退避中置顶,两笔都落地', async () => {
    const guard = createLatestWriteGuard();
    const queue = createSessionWriteQueue();
    const sent: string[] = [];
    // 重命名 A:首发失败进退避,随后重试成功
    const rename = guard.begin('s1', ['title']);
    const sendRename = vi.fn()
      .mockImplementationOnce(() => {
        sent.push('rename-1');
        return Promise.reject(Object.assign(new Error('not connected'), { code: 'NOT_CONNECTED' }));
      })
      .mockImplementationOnce(() => {
        sent.push('rename-2');
        return Promise.resolve('renamed');
      });
    const pA = queue.enqueue('s1', ['title'], () => retryPatchWhileLatest(rename.isLatest, sendRename));
    await vi.waitFor(() => expect(sendRename).toHaveBeenCalledTimes(1));
    // 用户在重命名退避期间置顶:字段无交集,重命名不得被丢弃;置顶并行出网不等重命名
    const pin = guard.begin('s1', ['pinnedAt']);
    const sendPin = vi.fn().mockImplementation(() => {
      sent.push('pin');
      return Promise.resolve('pinned');
    });
    const pB = queue.enqueue('s1', ['pinnedAt'], () => retryPatchWhileLatest(pin.isLatest, sendPin));
    await expect(pB).resolves.toBe('pinned');
    await expect(pA).resolves.toBe('renamed');
    // 分道后置顶不等重命名的退避,先出网;重命名随后重试成功,两笔都落地
    expect(sent).toEqual(['rename-1', 'pin', 'rename-2']);
  });

  it('组合场景(review P2):删除取代全字段写序——退避中的重命名让位,删除并行出网', async () => {
    const guard = createLatestWriteGuard();
    const queue = createSessionWriteQueue();
    const sent: string[] = [];
    // 重命名 A:首发失败进退避
    const rename = guard.begin('s1', writeGuardFields({ title: '新名' }));
    const sendRename = vi.fn().mockImplementation(() => {
      sent.push('rename');
      return Promise.reject(Object.assign(new Error('not connected'), { code: 'NOT_CONNECTED' }));
    });
    const pA = queue.enqueue('s1', ['title'], () => retryPatchWhileLatest(rename.isLatest, sendRename));
    await vi.waitFor(() => expect(sendRename).toHaveBeenCalledTimes(1));
    // 用户删除该会话:终态取代全字段,重命名立即过期;删除走 status 道并行出网
    const del = guard.begin('s1', writeGuardFields({ status: 'deleted' }));
    const sendDelete = vi.fn().mockImplementation(() => {
      sent.push('delete');
      return Promise.resolve('deleted');
    });
    const pB = queue.enqueue('s1', ['status'], () => retryPatchWhileLatest(del.isLatest, sendDelete));
    await expect(pB).resolves.toBe('deleted');
    // 重命名在下一次重发前发现已被终态取代,让位返回 null,不再重发、不弹「重命名失败」
    await expect(pA).resolves.toBeNull();
    expect(sendRename).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(['rename', 'delete']);
  });
});

describe('createPendingWriteTracker', () => {
  it('在途字段的 push 回流被遮蔽,release 后恢复透传(review P2:pin 在途时 unpin,旧 push 不滚回)', () => {
    const tracker = createPendingWriteTracker();
    const release = tracker.track('s1', ['pinnedAt']);
    // 旧写(pin)的 push 回流:pinnedAt 在途 → 被遮;无关字段照常透传
    expect(tracker.filterPatch('s1', { pinnedAt: '2026-01-01T00:00:00Z', title: 'x' }))
      .toEqual({ title: 'x' });
    // 全部字段都在途 → 空对象(调用方跳过应用)
    expect(tracker.filterPatch('s1', { pinnedAt: null })).toEqual({});
    release();
    expect(tracker.filterPatch('s1', { pinnedAt: null })).toEqual({ pinnedAt: null });
  });

  it('被遮蔽的外部 push 留痕:失败回滚方可 consume 判定 reseed(review P1 场景)', () => {
    const tracker = createPendingWriteTracker();
    const release = tracker.track('s1', ['title']);
    // 手机重命名在途,桌面端并发改名的 push 被遮
    expect(tracker.filterPatch('s1', { title: 'B' })).toEqual({});
    // 本机写失败回滚:consume 命中 → 调用方 reseed;读后即清,不重复触发
    expect(tracker.consumeMaskedPush('s1', ['title'])).toBe(true);
    expect(tracker.consumeMaskedPush('s1', ['title'])).toBe(false);
    release();
  });

  it('echo push(值与本机乐观值相同)遮蔽但不留痕:成功写不误触发 reseed(review P2)', () => {
    const tracker = createPendingWriteTracker();
    const release = tracker.track('s1', ['title']);
    // 本笔自己的 echo push 先于回包到达:值 = 本机乐观值 → 遮蔽但零信息
    expect(tracker.filterPatch('s1', { title: '新名' }, { title: '新名' })).toEqual({});
    expect(tracker.consumeMaskedPush('s1', ['title'])).toBe(false);
    // 外部并发写(不同值)→ 留痕
    expect(tracker.filterPatch('s1', { title: '外部改名' }, { title: '新名' })).toEqual({});
    expect(tracker.consumeMaskedPush('s1', ['title'])).toBe(true);
    release();
  });

  it('noteMaskedValue(全量对账 overlay 留痕):同值不记,异值记', () => {
    const tracker = createPendingWriteTracker();
    const release = tracker.track('s1', ['title']);
    tracker.noteMaskedValue('s1', 'title', '新名', '新名');
    expect(tracker.consumeMaskedPush('s1', ['title'])).toBe(false);
    tracker.noteMaskedValue('s1', 'title', '外部改名', '新名');
    expect(tracker.consumeMaskedPush('s1', ['title'])).toBe(true);
    release();
  });

  it('遮蔽标记随计数归零清除,不污染下一笔写;无遮蔽时 consume 为 false', () => {
    const tracker = createPendingWriteTracker();
    const r1 = tracker.track('s1', ['title']);
    tracker.filterPatch('s1', { title: 'B' });
    r1(); // 成功分支不 consume,release 归零清残留
    const r2 = tracker.track('s1', ['title']);
    expect(tracker.consumeMaskedPush('s1', ['title'])).toBe(false);
    r2();
  });

  it('同字段多笔在途按计数释放;release 幂等;不同 key 互不影响', () => {
    const tracker = createPendingWriteTracker();
    const r1 = tracker.track('s1', ['pinnedAt']);
    const r2 = tracker.track('s1', ['pinnedAt']);
    r1();
    r1(); // 幂等:重复调用不把 r2 的登记也放掉
    expect(tracker.filterPatch('s1', { pinnedAt: null })).toEqual({});
    expect(tracker.filterPatch('s2', { pinnedAt: null })).toEqual({ pinnedAt: null });
    r2();
    expect(tracker.filterPatch('s1', { pinnedAt: null })).toEqual({ pinnedAt: null });
  });
});

describe('writeGuardFields', () => {
  it('delete / archive(移行写)取代全部元数据字段(review P2:归档后在途重命名让位)', () => {
    expect(writeGuardFields({ status: 'deleted' }).sort()).toEqual(['pinnedAt', 'status', 'title']);
    expect(writeGuardFields({ status: 'archived', pinnedAt: null } as { status: string }).sort())
      .toEqual(['pinnedAt', 'status', 'title']);
  });

  it('restore / 置顶 / 重命名(不移行)按 patch 自身字段', () => {
    expect(writeGuardFields({ status: 'active' })).toEqual(['status']);
    expect(writeGuardFields({ pinnedAt: null })).toEqual(['pinnedAt']);
    expect(writeGuardFields({ title: 'x' })).toEqual(['title']);
  });
});

describe('retryPatchWhileLatest', () => {
  it('始终最新:瞬时失败后重试直到成功,返回结果', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('not online within 1500ms'), { code: 'NOT_CONNECTED' }))
      .mockResolvedValueOnce('ok');
    await expect(retryPatchWhileLatest(() => true, send)).resolves.toBe('ok');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('退避期间被同字段后续写取代:不再重发旧 patch,返回 null 让位(review P1 场景)', async () => {
    const guard = createLatestWriteGuard();
    const pin = guard.begin('s1', ['pinnedAt']);
    const send = vi.fn().mockImplementation(() => {
      // 首发失败;失败后用户在同会话执行了取消置顶(同字段新写登记,旧笔过期)
      guard.begin('s1', ['pinnedAt']);
      return Promise.reject(Object.assign(new Error('not connected'), { code: 'NOT_CONNECTED' }));
    });
    await expect(retryPatchWhileLatest(pin.isLatest, send)).resolves.toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('发起前就已过期:一次都不发,返回 null', async () => {
    const send = vi.fn();
    await expect(retryPatchWhileLatest(() => false, send)).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('非瞬时错误照常抛出,不吞', async () => {
    const send = vi.fn().mockRejectedValue(new Error('[REMOTE_DISABLED] disabled'));
    await expect(retryPatchWhileLatest(() => true, send)).rejects.toThrow('disabled');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('发送点断言(preSend 语义):重连等待期间被取代 → 等待后就地让位,不真正出网(review P2 场景)', async () => {
    const guard = createLatestWriteGuard();
    const pin = guard.begin('s1', ['pinnedAt']);
    let reallySent = 0;
    // 模拟 sendInvoke:先经历重连等待(此期间同字段新写登记),再到发送点调用断言
    const send = vi.fn().mockImplementation(async (assertStillLatest: () => void) => {
      await new Promise((resolve) => setTimeout(resolve, 10)); // ensureOnlineForRequest 等待
      guard.begin('s1', ['pinnedAt']); // 等待期间用户取消置顶
      assertStillLatest(); // preSend:应在此抛让位哨兵
      reallySent += 1;
      return 'ok';
    });
    await expect(retryPatchWhileLatest(pin.isLatest, send)).resolves.toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    expect(reallySent).toBe(0);
  });
});

describe('pinToggleAction', () => {
  it('未置顶 → 置顶', () => {
    expect(pinToggleAction(null)).toEqual({ action: 'pin', label: '置顶' });
    expect(pinToggleAction(undefined)).toEqual({ action: 'pin', label: '置顶' });
  });

  it('已置顶 → 取消置顶', () => {
    expect(pinToggleAction('2026-07-07T00:00:00.000Z')).toEqual({ action: 'unpin', label: '取消置顶' });
  });
});

describe('buildSessionActionMenu', () => {
  it('菜单顺序固定:重命名 → 置顶切换 → 归档 → 删除,删除标 destructive', () => {
    const menu = buildSessionActionMenu(null);
    expect(menu.map((item) => item.action)).toEqual(['rename', 'pin', 'archive', 'delete']);
    expect(menu[3]).toMatchObject({ label: '删除任务', destructive: true });
    expect(menu.filter((item) => item.destructive)).toHaveLength(1);
  });

  it('已置顶会话的第二项是取消置顶', () => {
    const menu = buildSessionActionMenu('2026-07-07T00:00:00.000Z');
    expect(menu[1]).toEqual({ action: 'unpin', label: '取消置顶' });
  });
});

describe('swipeActionPatch', () => {
  it('pin 产出 ISO pinnedAt', () => {
    const now = Date.UTC(2026, 6, 7, 12, 0, 0);
    expect(swipeActionPatch('pin', now)).toEqual({ pinnedAt: new Date(now).toISOString() });
  });

  it('unpin 清空 pinnedAt', () => {
    expect(swipeActionPatch('unpin')).toEqual({ pinnedAt: null });
  });

  it('archive 同时清置顶(归档置顶会话不得遗留置顶态)', () => {
    expect(swipeActionPatch('archive')).toEqual({ status: 'archived', pinnedAt: null });
  });

  it('delete 是软删标记', () => {
    expect(swipeActionPatch('delete')).toEqual({ status: 'deleted' });
  });
});
