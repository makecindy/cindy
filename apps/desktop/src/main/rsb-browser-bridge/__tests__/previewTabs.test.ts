// PreviewTabIndex 契约:
//  - 签发 / 过期 / 伪造 / 跨 session / 用后作废 / origin 不符
//  - 普通网页标签(无 previewRequestId)不进索引
//  - 失效:registry release(destroyed)、guest 重建、插件停用 / 卸载
//  - 暂停:导航离开 origin 暂停、回到同 origin 恢复、超时作废
//  - grant 复绑:同 tab 同 id 在 guest 重建 / 回收后重新 report 可复绑,换源后不可

import { describe, expect, it, vi } from 'vitest';

import { PREVIEW_REQUEST_ID_RE } from '../../../shared/rsbBrowserBridge';
import {
  PREVIEW_PAUSE_LIMIT_MS,
  PREVIEW_REQUEST_TTL_MS,
  PreviewTabIndex,
  type PreviewTabEnded,
} from '../previewTabs';

const ORIGIN = 'https://preview.example.dev';
const URL_OK = `${ORIGIN}/app/index.html`;

function setup() {
  let clock = 1_000_000;
  let seq = 0;
  const warn = vi.fn();
  const ghosts = new Map<string, { available: boolean; name: string; revision?: string }>([
    ['ghost-a', { available: true, name: 'Ghost A' }],
    ['ghost-b', { available: true, name: 'Ghost B' }],
  ]);
  /** wcId → 当前 URL('' = 尚未提交首个导航)。 */
  const guestUrls = new Map<number, string>();
  const navListeners = new Map<number, Set<(url: string) => void>>();
  const deps = {
    getGhost: (id: string) => ghosts.get(id) ?? null,
    getGuestUrl: (wcId: number) => guestUrls.get(wcId) ?? null,
    watchNavigation: (wcId: number, cb: (url: string) => void) => {
      const set = navListeners.get(wcId) ?? new Set();
      set.add(cb);
      navListeners.set(wcId, set);
      return () => set.delete(cb);
    },
    now: () => clock,
    // 43 字符 base64url,满足 PREVIEW_REQUEST_ID_RE
    randomId: () => `id${String(++seq).padStart(41, '0')}`,
    logger: { info: vi.fn(), warn },
  };
  const index = new PreviewTabIndex(deps);
  const ended: PreviewTabEnded[] = [];
  index.onEnded((e) => ended.push(e));
  return {
    index,
    ended,
    warn,
    ghosts,
    guestUrls,
    advance: (ms: number) => {
      clock += ms;
    },
    navigate: (wcId: number, url: string) => {
      guestUrls.set(wcId, url);
      for (const cb of [...(navListeners.get(wcId) ?? [])]) cb(url);
    },
    watcherCount: (wcId: number) => navListeners.get(wcId)?.size ?? 0,
  };
}

const rec = (tabId: string, wcId: number, sessionId = 's1') => ({
  sessionId,
  tabId,
  webContentsId: wcId,
});

describe('PreviewTabIndex · 签发与绑定', () => {
  it('签发的 id 满足 43 字符 base64url 形状,默认随机源同样合规', () => {
    const { index } = setup();
    expect(index.issue({ ghostId: 'ghost-a', sessionId: 's1', url: URL_OK })).toMatch(
      PREVIEW_REQUEST_ID_RE,
    );
    const real = new PreviewTabIndex({
      getGhost: () => ({ available: true, name: 'x' }),
      getGuestUrl: () => null,
      watchNavigation: () => () => undefined,
    });
    const id = real.issue({ ghostId: 'g', sessionId: 's', url: URL_OK });
    expect(id).toMatch(PREVIEW_REQUEST_ID_RE);
    expect(real.issue({ ghostId: 'g', sessionId: 's', url: URL_OK })).not.toBe(id);
  });

  it('非 http(s) 或无法解析 origin 的 URL 不签发', () => {
    const { index } = setup();
    expect(index.issue({ ghostId: 'ghost-a', sessionId: 's1', url: 'file:///tmp/a.html' })).toBeNull();
    expect(index.issue({ ghostId: 'ghost-a', sessionId: 's1', url: 'not a url' })).toBeNull();
  });

  it('report 携带有效 id → 绑定插件身份,查询 API 可见', () => {
    const { index } = setup();
    const id = index.issue({ ghostId: 'ghost-a', sessionId: 's1', url: URL_OK })!;
    index.bind(rec('tab-1', 11), id);
    const binding = index.get('tab-1');
    expect(binding).toMatchObject({
      tabId: 'tab-1',
      sessionId: 's1',
      webContentsId: 11,
      ghostId: 'ghost-a',
      pluginName: 'Ghost A',
      origin: ORIGIN,
    });
    expect(index.list()).toHaveLength(1);
    expect(index.list('s1')).toHaveLength(1);
    expect(index.list('other')).toHaveLength(0);
    expect(index.current('tab-1', 11)).toEqual(binding);
    expect(index.current('tab-1', 12)).toBeNull();
    expect(index.current('nope', 11)).toBeNull();
  });

  it('普通网页标签(无 id / 形状非法)不进索引', () => {
    const { index } = setup();
    index.bind(rec('tab-1', 11));
    index.bind(rec('tab-2', 12), 'short');
    index.bind(rec('tab-3', 13), 12345);
    expect(index.list()).toEqual([]);
  });

  it('伪造 / 未签发的 id 不绑定', () => {
    const { index } = setup();
    index.bind(rec('tab-1', 11), 'x'.repeat(43));
    expect(index.list()).toEqual([]);
  });

  it('标签不可见时晚很多才 report 仍能绑定(5 分钟 / 1 小时 / 接近 TTL 上限)', () => {
    for (const delayMs of [5 * 60_000, 60 * 60_000, PREVIEW_REQUEST_TTL_MS - 1]) {
      const { index, advance } = setup();
      const id = index.issue({ ghostId: 'ghost-a', sessionId: 's1', url: URL_OK })!;
      advance(delayMs);
      index.bind(rec('tab-1', 11), id);
      expect(index.get('tab-1')).toMatchObject({ ghostId: 'ghost-a' });
    }
  });

  it('超出长 TTL(12 小时)后不可绑定,并记原因码', () => {
    const { index, advance, warn } = setup();
    expect(PREVIEW_REQUEST_TTL_MS).toBe(12 * 60 * 60 * 1000);
    const id = index.issue({ ghostId: 'ghost-a', sessionId: 's1', url: URL_OK })!;
    advance(PREVIEW_REQUEST_TTL_MS + 1);
    index.bind(rec('tab-1', 11), id);
    expect(index.list()).toEqual([]);
    expect(warn).toHaveBeenCalledWith('preview tab bind rejected', {
      tabId: 'tab-1',
      sessionId: 's1',
      reason: 'unknown-or-expired-request',
    });
  });

  it('绑定被拒时 warn 只带原因码,不带 previewRequestId 值;普通标签不产生日志', () => {
    const { index, warn, ghosts, guestUrls } = setup();
    index.bind(rec('plain', 1)); // 普通网页标签
    expect(warn).not.toHaveBeenCalled();

    index.bind(rec('t-bad', 2), 'short');
    const sessionMismatch = index.issue({ ghostId: 'ghost-a', sessionId: 's1', url: URL_OK })!;
    index.bind(rec('t-sess', 3, 's2'), sessionMismatch);
    const originMismatch = index.issue({ ghostId: 'ghost-a', sessionId: 's1', url: URL_OK })!;
    guestUrls.set(4, 'https://evil.example/');
    index.bind(rec('t-origin', 4), originMismatch);
    const pluginGone = index.issue({ ghostId: 'ghost-b', sessionId: 's1', url: URL_OK })!;
    ghosts.set('ghost-b', { available: false, name: 'Ghost B' });
    index.bind(rec('t-plugin', 5), pluginGone);

    expect(warn.mock.calls.map((c) => (c[1] as { reason: string }).reason)).toEqual([
      'invalid-request-id',
      'session-mismatch',
      'origin-mismatch',
      'plugin-unavailable',
    ]);
    const logged = JSON.stringify(warn.mock.calls);
    for (const secret of [sessionMismatch, originMismatch, pluginGone, 'short']) {
      expect(logged).not.toContain(secret);
    }
  });

  it('跨 session 的 report 不绑定,且 id 作废', () => {
    const { index } = setup();
    const id = index.issue({ ghostId: 'ghost-a', sessionId: 's1', url: URL_OK })!;
    index.bind(rec('tab-1', 11, 's2'), id);
    expect(index.list()).toEqual([]);
    index.bind(rec('tab-1', 11, 's1'), id);
    expect(index.list()).toEqual([]);
  });

  it('用后作废:同一个 id 不能再绑到别的标签', () => {
    const { index } = setup();
    const id = index.issue({ ghostId: 'ghost-a', sessionId: 's1', url: URL_OK })!;
    index.bind(rec('tab-1', 11), id);
    index.bind(rec('tab-2', 12), id);
    expect(index.list().map((b) => b.tabId)).toEqual(['tab-1']);
  });

  it('同一 guest 的重复 report(did-attach + dom-ready)幂等,不重复订阅导航', () => {
    const { index, watcherCount } = setup();
    const id = index.issue({ ghostId: 'ghost-a', sessionId: 's1', url: URL_OK })!;
    index.bind(rec('tab-1', 11), id);
    const generation = index.get('tab-1')!.generation;
    index.bind(rec('tab-1', 11), id);
    expect(index.get('tab-1')!.generation).toBe(generation);
    expect(watcherCount(11)).toBe(1);
  });

  it('guest 已提交的页面 origin 与签发不符 → 拒绝绑定;空白页(早期上报)放行', () => {
    const { index, guestUrls } = setup();
    const bad = index.issue({ ghostId: 'ghost-a', sessionId: 's1', url: URL_OK })!;
    guestUrls.set(11, 'https://evil.example/');
    index.bind(rec('tab-1', 11), bad);
    expect(index.list()).toEqual([]);

    const early = index.issue({ ghostId: 'ghost-a', sessionId: 's1', url: URL_OK })!;
    guestUrls.set(12, 'about:blank');
    index.bind(rec('tab-2', 12), early);
    expect(index.get('tab-2')).not.toBeNull();

    const committed = index.issue({ ghostId: 'ghost-a', sessionId: 's1', url: URL_OK })!;
    guestUrls.set(13, `${ORIGIN}/other`);
    index.bind(rec('tab-3', 13), committed);
    expect(index.get('tab-3')).not.toBeNull();
  });

  it('签发时插件已不可用 → 不绑定', () => {
    const { index, ghosts } = setup();
    const id = index.issue({ ghostId: 'ghost-a', sessionId: 's1', url: URL_OK })!;
    ghosts.set('ghost-a', { available: false, name: 'Ghost A' });
    index.bind(rec('tab-1', 11), id);
    expect(index.list()).toEqual([]);
  });
});

describe('PreviewTabIndex · 失效', () => {
  function bound(tabId = 'tab-1', wcId = 11) {
    const ctx = setup();
    const id = ctx.index.issue({ ghostId: 'ghost-a', sessionId: 's1', url: URL_OK })!;
    ctx.index.bind(rec(tabId, wcId), id);
    return { ...ctx, id };
  }

  it('registry release(含 destroyed)结束绑定并通知', () => {
    const { index, ended, watcherCount } = bound();
    index.onRegistryRelease(rec('tab-1', 11));
    expect(index.get('tab-1')).toBeNull();
    expect(ended).toMatchObject([{ reason: 'released', binding: { tabId: 'tab-1' } }]);
    expect(watcherCount(11)).toBe(0);
  });

  it('release 的 webContentsId 与当前绑定不符(旧 guest 的迟到 release)被忽略', () => {
    const { index, ended } = bound();
    index.onRegistryRelease(rec('tab-1', 99));
    expect(index.get('tab-1')).not.toBeNull();
    expect(ended).toEqual([]);
  });

  it('顶层导航离开 origin → 暂停(通知一次、查询不可见),同 origin 导航保持', () => {
    const { index, ended, navigate } = bound();
    navigate(11, `${ORIGIN}/other-page`);
    expect(index.get('tab-1')).not.toBeNull();
    expect(ended).toEqual([]);
    navigate(11, 'https://login.example/');
    expect(ended).toMatchObject([{ reason: 'origin-changed', binding: { tabId: 'tab-1' } }]);
    expect(index.get('tab-1')).toBeNull();
    expect(index.current('tab-1', 11)).toBeNull();
    expect(index.list()).toEqual([]);
    navigate(11, 'https://login2.example/'); // 暂停中继续跳:不重复通知
    expect(ended).toHaveLength(1);
  });

  it('暂停后回到同一 origin → 恢复(新 generation),经第三个 origin 也一样', () => {
    const { index, ended, navigate } = bound();
    const before = index.get('tab-1')!;
    navigate(11, 'https://login.example/');
    navigate(11, 'https://sso.example/');
    navigate(11, `${ORIGIN}/app/after-login`);
    const after = index.get('tab-1')!;
    expect(after).toMatchObject({ tabId: 'tab-1', webContentsId: 11, boundAt: before.boundAt });
    expect(after.generation).toBeGreaterThan(before.generation);
    expect(index.current('tab-1', 11)).toBe(after);
    expect(index.list()).toEqual([after]);
    expect(ended).toHaveLength(1);
    // 恢复后再次离开仍可暂停
    navigate(11, 'https://login.example/');
    expect(index.get('tab-1')).toBeNull();
    expect(ended).toHaveLength(2);
  });

  it('暂停超过上限 → 作废:回到原 origin 也不恢复,同一个 id 无法复活', () => {
    const { index, ended, navigate, advance, id, watcherCount } = bound();
    navigate(11, 'https://login.example/');
    advance(PREVIEW_PAUSE_LIMIT_MS);
    navigate(11, URL_OK);
    expect(index.get('tab-1')).toBeNull();
    expect(watcherCount(11)).toBe(0);
    expect(ended).toHaveLength(1); // 只有暂停时那一次
    index.bind(rec('tab-1', 11), id);
    expect(index.get('tab-1')).toBeNull();
  });

  it('暂停超过上限且没有再导航:查询时惰性作废并退订', () => {
    const { index, navigate, advance, watcherCount } = bound();
    navigate(11, 'https://login.example/');
    advance(PREVIEW_PAUSE_LIMIT_MS - 1);
    expect(watcherCount(11)).toBe(1);
    advance(1);
    expect(index.list()).toEqual([]);
    expect(watcherCount(11)).toBe(0);
  });

  it('暂停期间 release / guest 重建 / 插件停用仍作废,且不重复通知', () => {
    const a = bound();
    a.navigate(11, 'https://login.example/');
    a.index.onRegistryRelease(rec('tab-1', 11));
    a.navigate(11, URL_OK);
    expect(a.index.get('tab-1')).toBeNull();
    expect(a.ended).toHaveLength(1);

    const b = bound();
    b.navigate(11, 'https://login.example/');
    b.index.bind(rec('tab-1', 22));
    b.navigate(11, URL_OK);
    expect(b.index.get('tab-1')).toBeNull();
    expect(b.ended).toHaveLength(1);

    const c = bound();
    c.navigate(11, 'https://login.example/');
    c.ghosts.set('ghost-a', { available: false, name: 'Ghost A' });
    expect(c.index.list()).toEqual([]);
    c.ghosts.set('ghost-a', { available: true, name: 'Ghost A' });
    c.navigate(11, URL_OK);
    expect(c.index.get('tab-1')).toBeNull();
    expect(c.ended).toHaveLength(1);
  });

  it('插件更新(安装代次变了)→ 旧标签从索引移除并通知,同一个 id 无法复活', () => {
    const ctx = setup();
    ctx.ghosts.set('ghost-a', { available: true, name: 'Ghost A', revision: '0.1.25|r1' });
    const id = ctx.index.issue({ ghostId: 'ghost-a', sessionId: 's1', url: URL_OK })!;
    ctx.index.bind(rec('tab-1', 11), id);
    expect(ctx.index.list()).toHaveLength(1);
    ctx.ghosts.set('ghost-a', { available: true, name: 'Ghost A', revision: '0.1.26|r2' });
    ctx.index.reconcileGhosts();
    expect(ctx.index.list()).toEqual([]);
    expect(ctx.ended).toMatchObject([{ reason: 'plugin-updated', binding: { tabId: 'tab-1' } }]);
    expect(ctx.watcherCount(11)).toBe(0);
    ctx.index.bind(rec('tab-1', 11), id);
    expect(ctx.index.get('tab-1')).toBeNull();
    // 新版本开的预览(新签发)是新标签,正常绑定
    const fresh = ctx.index.issue({ ghostId: 'ghost-a', sessionId: 's1', url: URL_OK })!;
    ctx.index.bind(rec('tab-2', 12), fresh);
    expect(ctx.index.get('tab-2')).not.toBeNull();
  });

  it('插件在签发之后、绑定之前更新 → 绑定被拒;不跟踪代次的插件不受影响', () => {
    const ctx = setup();
    ctx.ghosts.set('ghost-a', { available: true, name: 'Ghost A', revision: 'v1' });
    const id = ctx.index.issue({ ghostId: 'ghost-a', sessionId: 's1', url: URL_OK })!;
    ctx.ghosts.set('ghost-a', { available: true, name: 'Ghost A', revision: 'v2' });
    ctx.index.bind(rec('tab-1', 11), id);
    expect(ctx.index.get('tab-1')).toBeNull();
    // ghost-b 没有 revision:更新与否都不失效
    const idB = ctx.index.issue({ ghostId: 'ghost-b', sessionId: 's1', url: URL_OK })!;
    ctx.index.bind(rec('tab-2', 12), idB);
    ctx.index.reconcileGhosts();
    expect(ctx.index.get('tab-2')).not.toBeNull();
  });

  it('暂停期间插件停用后又启用,回到原 origin 也不恢复(恢复前核对插件)', () => {
    const { index, navigate, ghosts } = bound();
    navigate(11, 'https://login.example/');
    ghosts.set('ghost-a', { available: false, name: 'Ghost A' });
    navigate(11, URL_OK);
    expect(index.get('tab-1')).toBeNull();
  });

  it('guest 重建(webContentsId 变化):旧绑定 replaced,同 id 重新 report 复绑新 guest', () => {
    const { index, ended, id, watcherCount } = bound();
    const first = index.get('tab-1')!;
    index.bind(rec('tab-1', 22), id);
    expect(ended).toMatchObject([{ reason: 'replaced', binding: { webContentsId: 11 } }]);
    const second = index.get('tab-1')!;
    expect(second.webContentsId).toBe(22);
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(index.current('tab-1', 11)).toBeNull();
    expect(watcherCount(11)).toBe(0);
    expect(watcherCount(22)).toBe(1);
  });

  it('guest 重建后不带 id 的 report → 旧绑定结束且不再绑定', () => {
    const { index, ended } = bound();
    index.bind(rec('tab-1', 22));
    expect(ended).toMatchObject([{ reason: 'replaced' }]);
    expect(index.get('tab-1')).toBeNull();
  });

  it('release 后(LRU 回收)同 tab 同 id 重新 report 可复绑;换了 id 不行', () => {
    const { index, id } = bound();
    index.onRegistryRelease(rec('tab-1', 11));
    index.bind(rec('tab-1', 33), 'y'.repeat(43));
    expect(index.get('tab-1')).toBeNull();
    index.bind(rec('tab-1', 33), id);
    expect(index.get('tab-1')).toMatchObject({ webContentsId: 33 });
  });

  it('复绑时 guest 已在别的 origin → 拒绝并作废 grant', () => {
    const { index, id, guestUrls } = bound();
    index.onRegistryRelease(rec('tab-1', 11));
    guestUrls.set(44, 'https://elsewhere.example/');
    index.bind(rec('tab-1', 44), id);
    expect(index.get('tab-1')).toBeNull();
    guestUrls.set(55, URL_OK);
    index.bind(rec('tab-1', 55), id);
    expect(index.get('tab-1')).toBeNull();
  });

  it('插件停用 / 卸载:reconcileGhosts 结束绑定;重新启用也不复活', () => {
    const { index, ended, ghosts, id } = bound();
    ghosts.set('ghost-a', { available: false, name: 'Ghost A' });
    index.reconcileGhosts();
    expect(index.get('tab-1')).toBeNull();
    expect(ended).toMatchObject([{ reason: 'plugin-unavailable' }]);
    ghosts.set('ghost-a', { available: true, name: 'Ghost A' });
    index.bind(rec('tab-1', 11), id);
    expect(index.get('tab-1')).toBeNull();

    const other = bound('tab-2', 12);
    other.ghosts.delete('ghost-a'); // 卸载
    expect(other.index.list()).toEqual([]); // 读取路径同样会对账
    expect(other.ended).toMatchObject([{ reason: 'plugin-unavailable' }]);
  });

  it('只失效受影响插件的标签', () => {
    const { index, ghosts, ended } = setup();
    const a = index.issue({ ghostId: 'ghost-a', sessionId: 's1', url: URL_OK })!;
    const b = index.issue({ ghostId: 'ghost-b', sessionId: 's1', url: URL_OK })!;
    index.bind(rec('tab-a', 11), a);
    index.bind(rec('tab-b', 12), b);
    ghosts.set('ghost-a', { available: false, name: 'Ghost A' });
    index.reconcileGhosts();
    expect(index.list().map((x) => x.tabId)).toEqual(['tab-b']);
    expect(ended).toHaveLength(1);
  });

  it('onEnded 监听器抛错不影响其它监听器;可退订', () => {
    const { index } = bound();
    const good = vi.fn();
    index.onEnded(() => {
      throw new Error('boom');
    });
    const off = index.onEnded(good);
    index.onRegistryRelease(rec('tab-1', 11));
    expect(good).toHaveBeenCalledTimes(1);
    off();
  });

  it('pruneTabs 只清无活绑定且不存活标签的 grant,活绑定不受影响', () => {
    const { index, id } = bound();
    index.pruneTabs([]); // snapshot 来自另一个 renderer,不含该 tab
    expect(index.get('tab-1')).not.toBeNull();
    index.onRegistryRelease(rec('tab-1', 11));
    index.pruneTabs([]);
    index.bind(rec('tab-1', 66), id);
    expect(index.get('tab-1')).toBeNull();
  });

  it('签发表有上限,最旧的先丢', () => {
    const { index } = setup();
    const first = index.issue({ ghostId: 'ghost-a', sessionId: 's1', url: URL_OK })!;
    for (let i = 0; i < 70; i += 1) {
      index.issue({ ghostId: 'ghost-a', sessionId: 's1', url: URL_OK });
    }
    index.bind(rec('tab-1', 11), first);
    expect(index.list()).toEqual([]);
  });
});
