// Unit: verify Android native background-work registration, bounded lease lifecycle,
// iOS safety-margin preservation, and graceful fallback on old builds without the module.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DurableOutboxRecord } from '@/session/durableOutbox';
import { beginOutboxBackgroundSend, endOutboxBackgroundSend } from '@/session/outboxBackgroundSend';

type HeadlessTaskFactory = () => (data: { id: number }) => Promise<void>;

const moduleFixtures = vi.hoisted(() => ({
  native: {
    begin: vi.fn(async () => ({ id: 4, remainingMs: 20_000 })),
    end: vi.fn(async (_id: number): Promise<void> => {}),
    waitUntilEnded: vi.fn(async (_id: number): Promise<void> => {}),
  },
  registeredKey: null as string | null,
  registeredTask: null as HeadlessTaskFactory | null,
}));

vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: vi.fn(() => moduleFixtures.native),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppRegistry: {
    registerHeadlessTask: vi.fn((key: string, task: HeadlessTaskFactory) => {
      moduleFixtures.registeredKey = key;
      moduleFixtures.registeredTask = task;
    }),
  },
}));

import {
  beginBackgroundWork,
  createBackgroundWorkAdapter,
  type NativeBackgroundWork,
} from '@/notifications/backgroundWork';

interface MockNativeModule extends NativeBackgroundWork {
  begin: ReturnType<typeof vi.fn<() => Promise<{ id: number; remainingMs: number }>>>;
  end: ReturnType<typeof vi.fn<(id: number) => Promise<void>>>;
  waitUntilEnded?: ReturnType<typeof vi.fn<(id: number) => Promise<void>>>;
}

function createTestAdapter(options: {
  platform: 'android' | 'ios';
  native: MockNativeModule | null;
}) {
  let registeredKey: string | null = null;
  let registeredTask: HeadlessTaskFactory | null = null;
  const registerHeadlessTask = vi.fn((key: string, task: HeadlessTaskFactory) => {
    registeredKey = key;
    registeredTask = task;
  });
  const adapter = createBackgroundWorkAdapter({
    platform: options.platform,
    native: options.native,
    registerHeadlessTask,
  });
  return {
    beginBackgroundWork: adapter.beginBackgroundWork,
    registerHeadlessTask,
    getRegisteredHeadlessTask: () => ({ key: registeredKey, task: registeredTask }),
  };
}

afterEach(() => {
  moduleFixtures.native.begin.mockReset().mockResolvedValue({ id: 4, remainingMs: 20_000 });
  moduleFixtures.native.end.mockReset().mockResolvedValue(undefined);
  moduleFixtures.native.waitUntilEnded.mockReset().mockResolvedValue(undefined);
  vi.useRealTimers();
});

describe('backgroundWork native adapter', () => {
  it('registers the Android headless task on module load and keeps it pending until native release', async () => {
    expect(moduleFixtures.registeredKey).toBe('CindyBackgroundWork');
    expect(moduleFixtures.registeredTask).toBeTypeOf('function');

    let finish!: () => void;
    moduleFixtures.native.waitUntilEnded.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));

    const settled = vi.fn();
    const run = moduleFixtures.registeredTask!()({ id: 4 }).then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(moduleFixtures.native.waitUntilEnded).toHaveBeenCalledExactlyOnceWith(4);

    finish();
    await run;
    expect(settled).toHaveBeenCalledOnce();

    const work = await beginBackgroundWork(20_000);
    expect(work.budgetMs).toBe(20_000);
    work.end();
    expect(moduleFixtures.native.end).toHaveBeenCalledExactlyOnceWith(4);
  });

  it('uses the full Android native lease up to maxMs and ends overlapping leases independently', async () => {
    const native: MockNativeModule = {
      begin: vi.fn<() => Promise<{ id: number; remainingMs: number }>>()
        .mockResolvedValueOnce({ id: 1, remainingMs: 20_000 })
        .mockResolvedValueOnce({ id: 2, remainingMs: 20_000 }),
      end: vi.fn(async () => undefined),
      waitUntilEnded: vi.fn(async () => undefined),
    };

    const adapter = createTestAdapter({ platform: 'android', native });
    const first = await adapter.beginBackgroundWork(20_000);
    const second = await adapter.beginBackgroundWork(8_000);
    expect(first.budgetMs).toBe(20_000);
    expect(second.budgetMs).toBe(8_000);

    first.end();
    first.end();
    expect(native.end).toHaveBeenCalledExactlyOnceWith(1);

    second.end();
    expect(native.end.mock.calls).toEqual([[1], [2]]);
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
  ] as const)('falls back cleanly to the short ungranted budget on Android when %s', async (_label, native) => {
    const adapter = createTestAdapter({ platform: 'android', native });
    if (!native) {
      expect(adapter.registerHeadlessTask).not.toHaveBeenCalled();
    }

    const work = await adapter.beginBackgroundWork(20_000);
    expect(work.budgetMs).toBe(8_000);
    work.end();
    if (native) {
      expect(native.end).not.toHaveBeenCalled();
    }
  });

  it('preserves iOS safety margin and skips Android headless task registration on iOS', async () => {
    const native: MockNativeModule = {
      begin: vi.fn<() => Promise<{ id: number; remainingMs: number }>>()
        .mockResolvedValueOnce({ id: 9, remainingMs: 20_000 })
        .mockResolvedValueOnce({ id: 10, remainingMs: -1 }),
      end: vi.fn(async () => undefined),
    };

    const adapter = createTestAdapter({ platform: 'ios', native });
    expect(adapter.registerHeadlessTask).not.toHaveBeenCalled();

    const bounded = await adapter.beginBackgroundWork(25_000);
    expect(bounded.budgetMs).toBe(17_000);
    bounded.end();

    const foreground = await adapter.beginBackgroundWork(25_000);
    expect(foreground.budgetMs).toBe(25_000);
    foreground.end();
    expect(native.end.mock.calls).toEqual([[9], [10]]);
  });

  it('releases a late Android native grant when outbox background send already finished', async () => {
    vi.useFakeTimers();
    let grant!: (value: { id: number; remainingMs: number }) => void;
    const native: MockNativeModule = {
      begin: vi.fn(() => new Promise<{ id: number; remainingMs: number }>((resolve) => { grant = resolve; })),
      end: vi.fn(async () => undefined),
      waitUntilEnded: vi.fn(async () => undefined),
    };

    const adapter = createTestAdapter({ platform: 'android', native });
    const release = vi.fn();
    const record = {
      accountId: 'alice:cn',
      deviceId: 'desktop',
      state: 'queued',
      uploads: [],
      item: { sessionId: 'session-1', clientId: 'client-1', attachmentSlots: [] },
    } as unknown as DurableOutboxRecord;

    beginOutboxBackgroundSend(record, () => release, adapter.beginBackgroundWork);
    endOutboxBackgroundSend(record);
    expect(release).toHaveBeenCalledOnce();

    grant({ id: 11, remainingMs: 20_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(native.end).toHaveBeenCalledExactlyOnceWith(11);
  });
});
