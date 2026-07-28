// @vitest-environment jsdom

/**
 * browserWebviewPool 单测 —— 验证 LRU 行为 + automation pin + listener API:
 *   1) acquire 同 tabId 多次返回同一 entry(同 wrapper / 同 webview 引用)
 *   2) 超 K=5 容量时,最久未访问的被淘汰(wrapper 从 DOM 移除 + entries map 清掉)
 *   3) touch 显式更新 lastAccess,影响下一轮 LRU 选择
 *   4) release 显式销毁
 *   5) pinForAutomation 让 LRU 跳过被 pin 的 tab(Phase 2 bridge 用)
 *   6) release 自动 unpin + 触发 release listener
 *
 * 测试环境是 jsdom(vitest 默认)—— `<webview>` 在 jsdom 里是普通 HTMLElement,
 * 没有 Electron 的 attach / webContents 语义。这里只断言 pool 的 LRU / 容量
 * 逻辑,不测真实 webContents 行为(那要起 Electron app,集成测,Phase 7 范围)。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BROWSER_WEBVIEW_POOL_CAPACITY,
  browserWebviewPool,
} from '../browserWebviewPool';

describe('browserWebviewPool', () => {
  // 每个 test 跑完清掉 pool entries(container 留着,pool 模块内部缓存的引用
  // 仍 healthy attach 到 document.body,下一个 test 继续用同一个 container 没问题)。
  afterEach(() => {
    for (const tabId of browserWebviewPool.inspectTabIds()) {
      browserWebviewPool.release(tabId);
    }
  });

  // sanity:容量 5(plan 写死的 K)
  it('has capacity 5', () => {
    expect(BROWSER_WEBVIEW_POOL_CAPACITY).toBe(5);
  });

  it('acquire returns same entry on repeated tabId', () => {
    const a1 = browserWebviewPool.acquire('tab-a');
    const a2 = browserWebviewPool.acquire('tab-a');
    expect(a2).toBe(a1);
    expect(a2.wrapper).toBe(a1.wrapper);
    expect(a2.webview).toBe(a1.webview);
  });

  it('notifies only when a new entry is created', () => {
    const onEntryCreated = vi.fn();
    const unsub = browserWebviewPool.onEntryCreated(onEntryCreated);

    browserWebviewPool.acquire('tab-a');
    browserWebviewPool.acquire('tab-a');

    expect(onEntryCreated).toHaveBeenCalledOnce();
    expect(onEntryCreated).toHaveBeenCalledWith('tab-a');
    unsub();
  });

  it('captures guest failure before hook listeners bind and clears it on recovery', () => {
    const entry = browserWebviewPool.acquire('tab-a');
    const gone = new Event('render-process-gone');
    Object.defineProperty(gone, 'details', { value: { reason: 'crashed' } });

    entry.webview.dispatchEvent(gone);
    expect(entry.guestFailure).toEqual({ kind: 'render-process-gone', reason: 'crashed' });

    entry.webview.dispatchEvent(new Event('did-start-loading'));
    expect(entry.guestFailure).toBeNull();

    entry.webview.dispatchEvent(new Event('unresponsive'));
    expect(entry.guestFailure).toEqual({ kind: 'unresponsive', reason: 'unresponsive' });

    entry.webview.dispatchEvent(new Event('responsive'));
    expect(entry.guestFailure).toBeNull();
  });

  it('creates webviews with allowpopups so main can route popups into tabs', () => {
    const entry = browserWebviewPool.acquire('tab-a');
    expect(entry.webview.getAttribute('allowpopups')).toBe('true');
  });

  it('LRU evicts the oldest entry when capacity exceeded', () => {
    // 填到容量上限
    browserWebviewPool.acquire('tab-1');
    browserWebviewPool.acquire('tab-2');
    browserWebviewPool.acquire('tab-3');
    browserWebviewPool.acquire('tab-4');
    browserWebviewPool.acquire('tab-5');
    expect(browserWebviewPool.inspectTabIds()).toEqual([
      'tab-1', 'tab-2', 'tab-3', 'tab-4', 'tab-5',
    ]);
    // 第 6 个 → 淘汰 tab-1(最旧)
    browserWebviewPool.acquire('tab-6');
    expect(browserWebviewPool.inspectTabIds()).toEqual([
      'tab-2', 'tab-3', 'tab-4', 'tab-5', 'tab-6',
    ]);
    expect(browserWebviewPool.peek('tab-1')).toBeNull();
  });

  it('touch updates lastAccess and changes eviction order', () => {
    browserWebviewPool.acquire('tab-1');
    browserWebviewPool.acquire('tab-2');
    browserWebviewPool.acquire('tab-3');
    browserWebviewPool.acquire('tab-4');
    browserWebviewPool.acquire('tab-5');
    // 把 tab-1 touch 一下,它变成最新
    browserWebviewPool.touch('tab-1');
    browserWebviewPool.acquire('tab-6');
    // 此时最旧的是 tab-2(原本第二旧,但 tab-1 已经被 touch 到最新)
    expect(browserWebviewPool.peek('tab-1')).not.toBeNull();
    expect(browserWebviewPool.peek('tab-2')).toBeNull();
  });

  it('release removes entry and wrapper from DOM', () => {
    const entry = browserWebviewPool.acquire('tab-a');
    expect(entry.wrapper.isConnected).toBe(true);
    browserWebviewPool.release('tab-a');
    expect(entry.wrapper.isConnected).toBe(false);
    expect(browserWebviewPool.peek('tab-a')).toBeNull();
  });

  it('release on unknown tabId is a no-op', () => {
    expect(() => browserWebviewPool.release('does-not-exist')).not.toThrow();
  });

  it('repeated acquire after release re-creates entry', () => {
    const first = browserWebviewPool.acquire('tab-a');
    browserWebviewPool.release('tab-a');
    const second = browserWebviewPool.acquire('tab-a');
    // 是不同 entry(不同 wrapper / webview),因为旧的已经被销毁
    expect(second).not.toBe(first);
    expect(second.wrapper).not.toBe(first.wrapper);
  });

  // ── Phase 2: automation pin + release listener ─────────────────────────────

  it('pinForAutomation makes LRU skip the pinned tab', () => {
    // Fill to capacity, pin the oldest, then add one more — LRU should
    // evict the next-oldest unpinned tab, NOT the pinned one.
    browserWebviewPool.acquire('tab-1');
    browserWebviewPool.acquire('tab-2');
    browserWebviewPool.acquire('tab-3');
    browserWebviewPool.acquire('tab-4');
    browserWebviewPool.acquire('tab-5');
    expect(browserWebviewPool.pinForAutomation('tab-1')).toBe(true);
    browserWebviewPool.acquire('tab-6');
    // tab-1 is pinned → skip; next-oldest tab-2 evicted instead.
    expect(browserWebviewPool.peek('tab-1')).not.toBeNull();
    expect(browserWebviewPool.peek('tab-2')).toBeNull();
  });

  it('pinForAutomation is idempotent (repeat returns false)', () => {
    expect(browserWebviewPool.pinForAutomation('tab-1')).toBe(true);
    expect(browserWebviewPool.pinForAutomation('tab-1')).toBe(false);
    expect(browserWebviewPool.isPinnedForAutomation('tab-1')).toBe(true);
  });

  it('unpinForAutomation drops the pin and returns true on transition', () => {
    browserWebviewPool.pinForAutomation('tab-1');
    expect(browserWebviewPool.unpinForAutomation('tab-1')).toBe(true);
    expect(browserWebviewPool.unpinForAutomation('tab-1')).toBe(false);
    expect(browserWebviewPool.isPinnedForAutomation('tab-1')).toBe(false);
  });

  it('release auto-unpins and fires both release + pin listeners', () => {
    const onRelease = vi.fn();
    const onPin = vi.fn();
    const unsubRelease = browserWebviewPool.onRelease(onRelease);
    const unsubPin = browserWebviewPool.onPinChange(onPin);

    browserWebviewPool.acquire('tab-a');
    browserWebviewPool.pinForAutomation('tab-a');
    onPin.mockClear();

    browserWebviewPool.release('tab-a');

    expect(onRelease).toHaveBeenCalledWith('tab-a');
    expect(onPin).toHaveBeenCalledWith('tab-a', false);
    expect(browserWebviewPool.isPinnedForAutomation('tab-a')).toBe(false);

    unsubRelease();
    unsubPin();
  });

  it('LRU evict fires release listener (caller can sync state to main)', () => {
    const onRelease = vi.fn();
    const unsub = browserWebviewPool.onRelease(onRelease);

    browserWebviewPool.acquire('tab-1');
    browserWebviewPool.acquire('tab-2');
    browserWebviewPool.acquire('tab-3');
    browserWebviewPool.acquire('tab-4');
    browserWebviewPool.acquire('tab-5');
    browserWebviewPool.acquire('tab-6'); // evicts tab-1

    expect(onRelease).toHaveBeenCalledWith('tab-1');
    unsub();
  });

  it('LRU fallback evicts oldest pinned tab when every entry is pinned', () => {
    // Defensive: pool capacity is 5 and we expect pin count << capacity in
    // practice. If every tab is pinned, the pool MUST still evict to keep
    // size bounded — automation will fail visibly rather than the pool
    // growing forever.
    browserWebviewPool.acquire('tab-1');
    browserWebviewPool.acquire('tab-2');
    browserWebviewPool.acquire('tab-3');
    browserWebviewPool.acquire('tab-4');
    browserWebviewPool.acquire('tab-5');
    browserWebviewPool.pinForAutomation('tab-1');
    browserWebviewPool.pinForAutomation('tab-2');
    browserWebviewPool.pinForAutomation('tab-3');
    browserWebviewPool.pinForAutomation('tab-4');
    browserWebviewPool.pinForAutomation('tab-5');

    browserWebviewPool.acquire('tab-6');

    // tab-1 is the oldest pinned → evicted as fallback.
    expect(browserWebviewPool.peek('tab-1')).toBeNull();
    expect(browserWebviewPool.peek('tab-6')).not.toBeNull();
  });

  it('listener throw does not break pool mutation', () => {
    browserWebviewPool.onRelease(() => {
      throw new Error('release listener exploded');
    });
    browserWebviewPool.onPinChange(() => {
      throw new Error('pin listener exploded');
    });
    browserWebviewPool.onEntryCreated(() => {
      throw new Error('entry-created listener exploded');
    });

    expect(() => browserWebviewPool.acquire('tab-a')).not.toThrow();
    expect(() => browserWebviewPool.pinForAutomation('tab-a')).not.toThrow();
    expect(() => browserWebviewPool.release('tab-a')).not.toThrow();
    expect(browserWebviewPool.peek('tab-a')).toBeNull();
  });

  it('unsubscribe removes the listener', () => {
    const onRelease = vi.fn();
    const onEntryCreated = vi.fn();
    const unsubRelease = browserWebviewPool.onRelease(onRelease);
    const unsubEntryCreated = browserWebviewPool.onEntryCreated(onEntryCreated);
    unsubRelease();
    unsubEntryCreated();

    browserWebviewPool.acquire('tab-a');
    browserWebviewPool.release('tab-a');

    expect(onRelease).not.toHaveBeenCalled();
    expect(onEntryCreated).not.toHaveBeenCalled();
  });
});
