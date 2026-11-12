import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BURN_IN_TIMEOUT_MS,
  MAX_CONSECUTIVE_CRASH_REMOUNTS,
  WEBVIEW_READY_TIMEOUT_MS,
  createAnnotationBurnInQueue,
  type AnnotationBurnInQueue,
} from '@/session/annotationBurnInQueue';

interface FakeHost {
  mounted: number | null;
  mounts: number[];
  unmounts: number;
  injected: Array<{ key: number; request: Record<string, unknown> }>;
  injectOk: boolean;
}

function setup(): { queue: AnnotationBurnInQueue; host: FakeHost } {
  const host: FakeHost = { mounted: null, mounts: [], unmounts: 0, injected: [], injectOk: true };
  const queue = createAnnotationBurnInQueue({
    mount: (key) => {
      host.mounted = key;
      host.mounts.push(key);
    },
    unmount: () => {
      host.mounted = null;
      host.unmounts += 1;
    },
    inject: (key, script) => {
      if (!host.injectOk || host.mounted !== key) return false;
      const json = script.slice('window.__xdtBurnIn('.length, script.lastIndexOf('); true;'));
      host.injected.push({ key, request: JSON.parse(json) as Record<string, unknown> });
      return true;
    },
  });
  return { queue, host };
}

const input = { base64: 'QUJD', mimeType: 'image/png', strokes: [{ points: [{ x: 0.1, y: 0.2 }] }] };
const ready = (queue: AnnotationBurnInQueue, key: number) =>
  queue.handleMessage(key, JSON.stringify({ ready: true }));
const reply = (queue: AnnotationBurnInQueue, key: number, id: unknown, extra: Record<string, unknown> = {}) =>
  queue.handleMessage(key, JSON.stringify({
    id, ok: true, base64: 'b3V0', mimeType: 'image/png', width: 10, height: 20, ...extra,
  }));

/** 让 promise 的落定回调跑完。 */
async function settled<T>(promise: Promise<T>): Promise<{ value?: T; error?: Error }> {
  let outcome: { value?: T; error?: Error } | null = null;
  promise.then((value) => { outcome = { value }; }, (error: Error) => { outcome = { error }; });
  await Promise.resolve();
  await Promise.resolve();
  if (!outcome) throw new Error('promise still pending');
  return outcome;
}
async function isPending(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  await Promise.resolve();
  await Promise.resolve();
  return !done;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('annotation burn-in queue', () => {
  it('mounts on demand, dispatches after ready, and unmounts when idle', async () => {
    const { queue, host } = setup();
    const job = queue.burnIn({ ...input, strokeSpace: { width: 4032, height: 3024 } });
    expect(host.mounts).toEqual([1]);
    expect(host.injected).toHaveLength(0); // 未 ready 不注入
    ready(queue, 1);
    expect(host.injected).toHaveLength(1);
    expect(host.injected[0].request).toMatchObject({
      id: 'burn-1',
      mimeType: 'image/png',
      strokeSpace: { width: 4032, height: 3024 },
    });
    reply(queue, 1, 'burn-1');
    expect((await settled(job)).value).toEqual({
      base64: 'b3V0', mimeType: 'image/png', width: 10, height: 20,
    });
    expect(host.mounted).toBeNull();
    expect(host.unmounts).toBe(1);
  });

  it('remounts with a fresh key after an idle unmount so readiness is always re-established', async () => {
    const { queue, host } = setup();
    const first = queue.burnIn(input);
    ready(queue, 1);
    reply(queue, 1, 'burn-1');
    await settled(first);
    // 卸载后立刻再来一张:宿主可能把 unmount + mount 批处理合并,新 key 保证真实重挂载。
    const second = queue.burnIn(input);
    expect(host.mounts).toEqual([1, 2]);
    expect(host.injected).toHaveLength(1); // 旧 ready 不复用
    ready(queue, 1); // 旧实例的迟到 ready 被丢弃
    expect(host.injected).toHaveLength(1);
    ready(queue, 2);
    expect(host.injected.at(-1)?.key).toBe(2);
    reply(queue, 2, 'burn-2');
    expect((await settled(second)).value?.base64).toBe('b3V0');
  });

  it('fails queued jobs when the webview never becomes ready, then retries on a new mount', async () => {
    const { queue, host } = setup();
    const a = queue.burnIn(input);
    const b = queue.burnIn(input);
    vi.advanceTimersByTime(WEBVIEW_READY_TIMEOUT_MS - 1);
    expect(await isPending(a)).toBe(true);
    vi.advanceTimersByTime(1);
    expect((await settled(a)).error?.message).toMatch(/failed to initialize/);
    expect((await settled(b)).error?.message).toMatch(/failed to initialize/);
    expect(host.mounted).toBeNull();
    const c = queue.burnIn(input);
    expect(host.mounts).toEqual([1, 2]);
    ready(queue, 2);
    reply(queue, 2, 'burn-3');
    expect((await settled(c)).value).toBeDefined();
  });

  it('times out only the running job and continues the queue on a fresh webview', async () => {
    const { queue, host } = setup();
    const a = queue.burnIn(input);
    const b = queue.burnIn(input);
    ready(queue, 1);
    expect(host.injected.map((i) => i.request.id)).toEqual(['burn-1']);
    // 排队任务不计时:第一张跑满预算前 b 仍在等。
    vi.advanceTimersByTime(BURN_IN_TIMEOUT_MS - 1);
    expect(await isPending(b)).toBe(true);
    vi.advanceTimersByTime(1);
    expect((await settled(a)).error?.message).toMatch(/timed out/);
    expect(host.mounts).toEqual([1, 2]); // 卡住的实例被换掉
    reply(queue, 1, 'burn-1'); // 超时后到达的旧回包丢弃
    expect(await isPending(b)).toBe(true);
    ready(queue, 2);
    expect(host.injected.at(-1)).toMatchObject({ key: 2, request: { id: 'burn-2' } });
    reply(queue, 2, 'burn-2');
    expect((await settled(b)).value).toBeDefined();
  });

  it('fails the running job immediately when the webview process dies and remounts for the rest', async () => {
    const { queue, host } = setup();
    const a = queue.burnIn(input);
    const b = queue.burnIn(input);
    ready(queue, 1);
    queue.handleProcessGone(1, 'render process gone');
    expect((await settled(a)).error?.message).toMatch(/terminated: render process gone/);
    expect(await isPending(b)).toBe(true);
    expect(host.mounts).toEqual([1, 2]);
    queue.handleProcessGone(1, 'late event from old instance'); // 旧 key 忽略
    expect(await isPending(b)).toBe(true);
    ready(queue, 2);
    reply(queue, 2, 'burn-2');
    expect((await settled(b)).value).toBeDefined();
    // 没有剩余任务时不再保持挂载。
    expect(host.mounted).toBeNull();
    // 崩溃后仍未派发前的任务也会被消耗,反复崩溃不会无限重挂载。
    const c = queue.burnIn(input);
    queue.handleProcessGone(3, 'crash before ready');
    expect((await settled(c)).error).toBeDefined();
    expect(host.mounted).toBeNull();
  });

  it('treats an unavailable webview at dispatch time like a crash instead of waiting for the timeout', async () => {
    const { queue, host } = setup();
    host.injectOk = false;
    const a = queue.burnIn(input);
    ready(queue, 1);
    expect((await settled(a)).error?.message).toMatch(/webview unavailable/);
  });

  it('ignores stale or foreign responses', async () => {
    const { queue } = setup();
    const a = queue.burnIn(input);
    ready(queue, 1);
    reply(queue, 1, 'burn-999');
    queue.handleMessage(1, 'not json');
    queue.handleMessage(1, JSON.stringify({ foo: 1 }));
    expect(await isPending(a)).toBe(true);
    queue.handleMessage(1, JSON.stringify({ id: 'burn-1', ok: false, error: 'image decode failed' }));
    expect((await settled(a)).error?.message).toMatch(/image decode failed/);
  });

  it('rejects everything on unmount and can be used again afterwards', async () => {
    const { queue, host } = setup();
    const a = queue.burnIn(input);
    const b = queue.burnIn(input);
    ready(queue, 1);
    queue.dispose();
    expect((await settled(a)).error?.message).toMatch(/host unmounted/);
    expect((await settled(b)).error?.message).toMatch(/host unmounted/);
    vi.advanceTimersByTime(BURN_IN_TIMEOUT_MS * 2); // 计时器已清理,不会二次落定
    const c = queue.burnIn(input);
    expect(host.mounts.at(-1)).toBe(2);
    ready(queue, 2);
    reply(queue, 2, 'burn-3');
    expect((await settled(c)).value).toBeDefined();
  });

  it('keeps a prewarmed webview mounted across jobs and unmounts after release', async () => {
    const { queue, host } = setup();
    const release = queue.acquireWarm();
    expect(host.mounts).toEqual([1]);
    // 预热期间不计 ready 超时。
    vi.advanceTimersByTime(WEBVIEW_READY_TIMEOUT_MS * 3);
    expect(host.mounted).toBe(1);
    ready(queue, 1);
    const a = queue.burnIn(input);
    expect(host.injected).toHaveLength(1); // 已 ready,立即派发
    reply(queue, 1, 'burn-1');
    await settled(a);
    expect(host.mounted).toBe(1); // 仍在标注模式:不卸载
    release();
    release(); // 幂等
    expect(host.mounted).toBeNull();
    expect(host.unmounts).toBe(1);
  });

  it('keeps an in-flight job alive when the prewarm holder releases early', async () => {
    const { queue, host } = setup();
    const release = queue.acquireWarm();
    ready(queue, 1);
    const a = queue.burnIn(input);
    release();
    expect(host.mounted).toBe(1);
    reply(queue, 1, 'burn-1');
    expect((await settled(a)).value).toBeDefined();
    expect(host.mounted).toBeNull();
  });

  it('does not remount for a prewarm after a crash, so a crashing webview cannot loop', async () => {
    const { queue, host } = setup();
    const release = queue.acquireWarm();
    expect(host.mounts).toEqual([1]);
    queue.handleProcessGone(1, 'render process gone');
    expect(host.mounted).toBeNull(); // 仅预热持有:崩溃后卸载,不重挂
    queue.handleProcessGone(1, 'duplicate event');
    const again = queue.acquireWarm(); // 同一标注会话里再次预热也不重挂
    expect(host.mounts).toEqual([1]);
    // 用户真正提交时才重新挂载。
    const job = queue.burnIn(input);
    expect(host.mounts).toEqual([1, 2]);
    ready(queue, 2);
    reply(queue, 2, 'burn-1');
    expect((await settled(job)).value).toBeDefined();
    again();
    release();
    expect(host.mounted).toBeNull();
    // 预热全部释放后,下一次标注会话可以重新预热。
    queue.acquireWarm();
    expect(host.mounts).toEqual([1, 2, 3]);
  });

  it('caps consecutive crash remounts and fails the remaining jobs', async () => {
    const { queue, host } = setup();
    queue.acquireWarm();
    const jobs = Array.from({ length: 6 }, () => queue.burnIn(input));
    for (let crash = 0; crash <= MAX_CONSECUTIVE_CRASH_REMOUNTS; crash++) {
      queue.handleProcessGone(host.mounted!, 'render process gone');
    }
    const outcomes = await Promise.all(jobs.map(settled));
    expect(outcomes.every((o) => o.error?.message.includes('terminated'))).toBe(true);
    expect(host.mounts).toHaveLength(MAX_CONSECUTIVE_CRASH_REMOUNTS + 1);
    expect(host.mounted).toBeNull();
  });

  it('does not count idle (prewarm-only) crashes toward the remount cap', async () => {
    const { queue, host } = setup();
    // 切后台被系统回收之类的空闲崩溃,多次也不累计。
    for (let i = 0; i <= MAX_CONSECUTIVE_CRASH_REMOUNTS + 1; i++) {
      const release = queue.acquireWarm();
      queue.handleProcessGone(host.mounted!, 'render process gone');
      release();
    }
    const first = queue.burnIn(input);
    const second = queue.burnIn(input);
    // 一次打断任务的崩溃:队首失败,但仍换新 WebView 继续处理后续任务。
    queue.handleProcessGone(host.mounted!, 'render process gone');
    expect((await settled(first)).error?.message).toContain('terminated');
    const key = host.mounted!;
    ready(queue, key);
    reply(queue, key, 'burn-2');
    expect((await settled(second)).value).toBeDefined();
  });
});
