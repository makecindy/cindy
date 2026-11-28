// Unit: verify Android native background-work registration, bounded lease lifecycle,
// iOS safety-margin preservation, and graceful fallback on old builds without the module.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DurableOutboxRecord } from '@/session/durableOutbox';
import { beginOutboxBackgroundSend, endOutboxBackgroundSend } from '@/session/outboxBackgroundSend';

type HeadlessTaskFactory = () => (data: { id: number }) => Promise<void>;

interface MockNativeModule {
  begin: ReturnType<typeof vi.fn<() => Promise<{ id: number; remainingMs: number }>>>;
  end: ReturnType<typeof vi.fn<(id: number) => Promise<void>>>;
  waitUntilEnded?: ReturnType<typeof vi.fn<(id: number) => Promise<void>>>;
}

async function loadBackgroundWork(options: {
  os: 'android' | 'ios';
  nativeModule: MockNativeModule | null;
}) {
  // reset-modules: backgroundWork.ts binds Platform.OS, requireOptionalNativeModule, and AppRegistry.registerHeadlessTask at module load
  vi.resetModules();
  let registeredKey: string | null = null;
  let registeredTask: HeadlessTaskFactory | null = null;
  const registerHeadlessTask = vi.fn((key: string, task: HeadlessTaskFactory) => {
    registeredKey = key;
    registeredTask = task;
  });
  const requireOptionalNativeModule = vi.fn(() => options.nativeModule);

  vi.doMock('expo-modules-core', () => ({ requireOptionalNativeModule }));
  vi.doMock('react-native', () => ({
    Platform: { OS: options.os },
    AppRegistry: { registerHeadlessTask },
  }));

  const mod = await import('@/notifications/backgroundWork');
  return {
    beginBackgroundWork: mod.beginBackgroundWork,
    registerHeadlessTask,
    requireOptionalNativeModule,
    getRegisteredHeadlessTask: () => ({ key: registeredKey, task: registeredTask }),
  };
}

afterEach(() => {
  vi.doUnmock('expo-modules-core');
  vi.doUnmock('react-native');
  vi.useRealTimers();
});

describe('backgroundWork native adapter', () => {
  it('registers the Android headless task and keeps it pending until native release', async () => {
    let finish!: () => void;
    const waitUntilEnded = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const nativeModule: MockNativeModule = {
      begin: vi.fn(async () => ({ id: 4, remainingMs: 20_000 })),
      end: vi.fn(async () => undefined),
      waitUntilEnded,
    };

    const { getRegisteredHeadlessTask } = await loadBackgroundWork({ os: 'android', nativeModule });
    const registered = getRegisteredHeadlessTask();
    expect(registered.key).toBe('CindyBackgroundWork');
    expect(registered.task).toBeTypeOf('function');

    const settled = vi.fn();
    const run = registered.task!()({ id: 4 }).then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(waitUntilEnded).toHaveBeenCalledExactlyOnceWith(4);

    finish();
    await run;
    expect(settled).toHaveBeenCalledOnce();
  });

  it('uses the full Android native lease up to maxMs and ends overlapping leases independently', async () => {
    const nativeModule: MockNativeModule = {
      begin: vi.fn<() => Promise<{ id: number; remainingMs: number }>>()
        .mockResolvedValueOnce({ id: 1, remainingMs: 20_000 })
        .mockResolvedValueOnce({ id: 2, remainingMs: 20_000 }),
      end: vi.fn(async () => undefined),
      waitUntilEnded: vi.fn(async () => undefined),
    };

    const { beginBackgroundWork } = await loadBackgroundWork({ os: 'android', nativeModule });
    const first = await beginBackgroundWork(20_000);
    const second = await beginBackgroundWork(8_000);
    expect(first.budgetMs).toBe(20_000);
    expect(second.budgetMs).toBe(8_000);

    first.end();
    first.end();
    expect(nativeModule.end).toHaveBeenCalledExactlyOnceWith(1);

    second.end();
    expect(nativeModule.end.mock.calls).toEqual([[1], [2]]);
  });

  it.each([
    ['missing native module (old Android binary)', null],
    ['denied native lease (id=0)', {
      begin: vi.fn(async () => ({ id: 0, remainingMs: 0 })),
      end: vi.fn(async () => undefined),
      waitUntilEnded: vi.fn(async () => undefined),
    }],
    ['rejected native begin', {
      begin: vi.fn(async () => { throw new Error('service restricted'); }),
      end: vi.fn(async () => undefined),
      waitUntilEnded: vi.fn(async () => undefined),
    }],
  ] as const)('falls back cleanly to the short ungranted budget on Android when %s', async (_label, nativeModule) => {
    const { beginBackgroundWork, registerHeadlessTask } = await loadBackgroundWork({
      os: 'android',
      nativeModule,
    });
    if (!nativeModule) {
      expect(registerHeadlessTask).not.toHaveBeenCalled();
    }

    const work = await beginBackgroundWork(20_000);
    expect(work.budgetMs).toBe(8_000);
    work.end();
    if (nativeModule) {
      expect(nativeModule.end).not.toHaveBeenCalled();
    }
  });

  it('preserves iOS safety margin and skips Android headless task registration on iOS', async () => {
    const nativeModule: MockNativeModule = {
      begin: vi.fn<() => Promise<{ id: number; remainingMs: number }>>()
        .mockResolvedValueOnce({ id: 9, remainingMs: 20_000 })
        .mockResolvedValueOnce({ id: 10, remainingMs: -1 }),
      end: vi.fn(async () => undefined),
    };

    const { beginBackgroundWork, registerHeadlessTask } = await loadBackgroundWork({
      os: 'ios',
      nativeModule,
    });
    expect(registerHeadlessTask).not.toHaveBeenCalled();

    const bounded = await beginBackgroundWork(25_000);
    expect(bounded.budgetMs).toBe(17_000);
    bounded.end();

    const foreground = await beginBackgroundWork(25_000);
    expect(foreground.budgetMs).toBe(25_000);
    foreground.end();
    expect(nativeModule.end.mock.calls).toEqual([[9], [10]]);
  });

  it('releases a late Android native grant when outbox background send already finished', async () => {
    vi.useFakeTimers();
    let grant!: (value: { id: number; remainingMs: number }) => void;
    const nativeModule: MockNativeModule = {
      begin: vi.fn(() => new Promise<{ id: number; remainingMs: number }>((resolve) => { grant = resolve; })),
      end: vi.fn(async () => undefined),
      waitUntilEnded: vi.fn(async () => undefined),
    };

    const { beginBackgroundWork } = await loadBackgroundWork({ os: 'android', nativeModule });
    const release = vi.fn();
    const record = {
      accountId: 'alice:cn',
      deviceId: 'desktop',
      state: 'queued',
      uploads: [],
      item: { sessionId: 'session-1', clientId: 'client-1', attachmentSlots: [] },
    } as unknown as DurableOutboxRecord;

    beginOutboxBackgroundSend(record, () => release, beginBackgroundWork);
    endOutboxBackgroundSend(record);
    expect(release).toHaveBeenCalledOnce();

    grant({ id: 11, remainingMs: 20_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(nativeModule.end).toHaveBeenCalledExactlyOnceWith(11);
  });
});
