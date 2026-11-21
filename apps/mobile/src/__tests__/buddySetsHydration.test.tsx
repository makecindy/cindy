// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果:useBuddySets(真实 hook)+ buddySetsStore 的 AsyncStorage
 *   读写链。断言冷启动快照在唯一挂载实例卸载后仍被应用、再次编辑不整份覆盖磁盘记录;
 *   断言写失败会给出可见重试、重试成功后才落盘;断言两个挂载实例共享读取失败/重试状态。
 * - Bug／规则依据:评审对当前 head 的 P1「在发布 ready 状态前确保已应用读取结果」;
 *   docs/dev-rules/mobile-development.md §「消息缓存与首页偏好」:写失败必须向用户提示,
 *   不能把未落盘的选择当成已保存。
 * - 现有覆盖缺口:buddySetsStore.test.ts 只测存储链,不测 hook 的 hydration 与共享状态。
 * - 最小失败输入:getItem 被挂起时卸载唯一的 hook 实例,释放读取后再挂载并编辑;
 *   setItem 抛错一次;getItem 抛错后只从其中一个实例重试。
 * - tier:unit,AsyncStorage 内存 fake + jsdom,无真实设备等待(单测 5s 预算内)。
 */
const h = vi.hoisted(() => ({
  store: new Map<string, string>(),
  readGate: null as Promise<void> | null,
  failRead: false,
  failWrite: false,
  auth: { accountId: '', accountKey: '', generation: 0 },
}));
vi.mock('@/auth/authOwnerGeneration', () => ({ getMobileAuthOwner: () => h.auth }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => {
      if (h.readGate) await h.readGate;
      if (h.failRead) throw new Error('read failed');
      return h.store.get(key) ?? null;
    }),
    setItem: vi.fn(async (key: string, value: string) => {
      if (h.failWrite) throw new Error('write failed');
      h.store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => { h.store.delete(key); }),
  },
}));
import { act, createElement as el } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBuddySet, emptyBuddySets, serializeBuddySets } from '@cindy/maker-shared/buddy-sets';
import { useBuddySets } from '../session/useBuddySets';
import { __testing } from '../session/buddySetsStore';
import { getHomeViewSession } from '../session/homeViewSession';

function Probe({ owner, label }: { owner: string; label: string }) {
  const [state, update, status, retry, saveFailed, retrySave] = useBuddySets(owner);
  return el('div', { 'data-testid': label },
    el('span', { 'data-testid': `${label}.status` }, status),
    el('span', { 'data-testid': `${label}.sets` }, state.sets.map((set) => set.name).join(',')),
    el('span', { 'data-testid': `${label}.saveFailed` }, String(saveFailed)),
    el('button', { 'data-testid': `${label}.edit`,
      onClick: () => update((current) => createBuddySet(current, 'set-2', 'Second')) }),
    el('button', { 'data-testid': `${label}.retry`, onClick: retry }),
    el('button', { 'data-testid': `${label}.retrySave`, onClick: retrySave }));
}

let roots: Root[] = [];
let containers: HTMLElement[] = [];
let testIndex = 0;
const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });
const keyFor = (owner: string) => __testing.prefix + encodeURIComponent(owner);
const field = (container: HTMLElement, suffix: string) =>
  container.querySelector(`[data-testid$="${suffix}"]`)?.textContent ?? '';
const click = (container: HTMLElement, testId: string) => {
  (container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).click();
};

function mount(owner: string, label: string): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  containers.push(container);
  roots.push(root);
  act(() => { root.render(el(Probe, { owner, label })); });
  return container;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.store.clear();
  h.readGate = null;
  h.failRead = false;
  h.failWrite = false;
  testIndex += 1;
  // A new owner identity gives each case a fresh HomeViewSession / loads map.
  h.auth = { accountId: `owner-${testIndex}`, accountKey: `owner-${testIndex}`, generation: testIndex };
  getHomeViewSession();
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  for (const container of containers) container.remove();
  roots = [];
  containers = [];
});

describe('mobile buddy set hydration and persistence', () => {
  it('applies a snapshot that settled while no hook was mounted before allowing edits', async () => {
    const owner = 'owner-a';
    h.store.set(keyFor(owner), serializeBuddySets(createBuddySet(emptyBuddySets(), 'set-1', 'First')));
    let release!: () => void;
    h.readGate = new Promise<void>((resolve) => { release = resolve; });
    const first = mount(owner, 'a');
    expect(field(first, '.status')).toBe('loading');
    // The only mounted instance goes away before the cold-start read resolves.
    act(() => { roots[0]!.unmount(); });
    roots = [];
    await act(async () => { release(); h.readGate = null; await flush(); });

    const second = mount(owner, 'b');
    expect(field(second, '.status')).toBe('ready');
    expect(field(second, '.sets')).toBe('First');
    await act(async () => { click(second, 'b.edit'); await flush(); });
    expect(field(second, '.sets')).toBe('First,Second');
    expect(h.store.get(keyFor(owner))).toContain('First');
    expect(h.store.get(keyFor(owner))).toContain('Second');
  });

  it('shows a retry when a write fails and clears it only after a successful retry', async () => {
    const owner = 'owner-b';
    const container = mount(owner, 'a');
    await act(async () => { await flush(); });
    expect(field(container, '.status')).toBe('ready');

    h.failWrite = true;
    await act(async () => { click(container, 'a.edit'); await flush(); });
    expect(field(container, '.saveFailed')).toBe('true');
    expect(h.store.has(keyFor(owner))).toBe(false);

    h.failWrite = false;
    await act(async () => { click(container, 'a.retrySave'); await flush(); });
    expect(field(container, '.saveFailed')).toBe('false');
    expect(h.store.get(keyFor(owner))).toContain('Second');
  });

  it('shares the read error and retry state with every mounted instance', async () => {
    const owner = 'owner-c';
    h.failRead = true;
    const first = mount(owner, 'a');
    const second = mount(owner, 'b');
    await act(async () => { await flush(); });
    expect(field(first, '.status')).toBe('error');
    expect(field(second, '.status')).toBe('error');
    await act(async () => { click(first, 'a.edit'); await flush(); });
    expect(field(first, '.sets')).toBe('');

    h.failRead = false;
    await act(async () => { click(second, 'b.retry'); await flush(); });
    expect(field(first, '.status')).toBe('ready');
    expect(field(second, '.status')).toBe('ready');
  });
});
