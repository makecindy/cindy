/**
 * ripgrep 退出码处理回归测试。
 *
 * 覆盖:
 * - listAllFiles 在 rg 致命退出(非零 exit)时应 reject
 * - RipgrepSearcher 在 rg 退出码 2 时应 emit type:'error'
 * - 退出码 1(无匹配)在 RipgrepSearcher 中仍应正常 end
 *
 * 使用 vi.mock 模拟 child_process.spawn,避免跨平台可执行文件问题。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/* ------------------------------------------------------------------ */
/* Mock child_process.spawn                                           */
/* ------------------------------------------------------------------ */

type SpawnHandler = (
  command: string,
  args?: readonly string[],
  options?: Record<string, unknown>,
) => ChildProcessWithoutNullStreams;

let spawnHandler: SpawnHandler = () => {
  throw new Error('spawnHandler not set');
};

vi.mock('node:child_process', () => ({
  spawn: (...args: Parameters<SpawnHandler>) => spawnHandler(...args),
}));

function createFakeChild(exitCode: number, stdoutLines: string[] = []): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  (child as any).stdout = stdout;
  (child as any).stderr = new PassThrough();
  (child as any).killed = false;
  (child as any).exitCode = null;

  // Simulate async process lifecycle: write lines, then close stdout, then emit close
  let ended = false;
  process.nextTick(() => {
    if (ended) return;
    for (const line of stdoutLines) {
      if (ended) break;
      stdout.write(line + '\n');
    }
    if (!ended) {
      ended = true;
      stdout.end();
    }
    (child as any).exitCode = exitCode;
    child.emit('close', exitCode, null);
  });

  child.kill = vi.fn(() => {
    (child as any).killed = true;
    if (!ended) {
      ended = true;
      stdout.end();
    }
    return true;
  }) as any;

  return child;
}

/* ------------------------------------------------------------------ */
/* listAllFiles tests                                                 */
/* ------------------------------------------------------------------ */

describe('listAllFiles error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects when rg exits with non-zero code', async () => {
    spawnHandler = () => createFakeChild(2);

    const { listAllFiles } = await import('../listAllFiles.js');
    await expect(
      listAllFiles({ rgPath: '/fake/rg', workdir: '/tmp/work' }),
    ).rejects.toThrow(/ripgrep exited with code 2/);
  });

  it('resolves when rg exits with code 0', async () => {
    spawnHandler = () => createFakeChild(0, ['file1.ts', 'file2.js']);

    const { listAllFiles } = await import('../listAllFiles.js');
    const result = await listAllFiles({ rgPath: '/fake/rg', workdir: '/tmp/work' });
    expect(result.truncated).toBe(false);
    expect(result.files).toEqual(['file1.ts', 'file2.js']);
  });

  it('resolves when truncated (rg killed by us, exit code non-zero is OK)', async () => {
    // When we kill rg after cap, it exits non-zero — should still resolve
    spawnHandler = () => createFakeChild(1, ['a.ts', 'b.ts']);

    const { listAllFiles } = await import('../listAllFiles.js');
    const result = await listAllFiles({ rgPath: '/fake/rg', workdir: '/tmp/work', cap: 1 });
    expect(result.files.length).toBe(1);
    expect(result.truncated).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* RipgrepSearcher tests                                              */
/* ------------------------------------------------------------------ */

describe('RipgrepSearcher fatal exit handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeLogger() {
    return {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  }

  async function importSearcher() {
    const mod = await import('../search/RipgrepSearcher.js');
    return mod.RipgrepSearcher;
  }

  function waitForSearch(
    searcher: InstanceType<ReturnType<typeof importSearcher>> extends Promise<infer P> ? P : never,
    searchId: string,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const handler = (ev: any) => {
        if (ev.searchId === searchId && (ev.type === 'end' || ev.type === 'error')) {
          searcher.removeListener('event', handler);
          resolve();
        }
      };
      searcher.on('event', handler);
    });
  }

  it('emits type:error when rg exits with code 2', async () => {
    spawnHandler = () => createFakeChild(2);

    const RipgrepSearcher = await importSearcher();
    const logger = makeLogger();
    const searcher = new RipgrepSearcher({ rgPath: '/fake/rg', logger });

    const events: unknown[] = [];
    searcher.on('event', (ev) => events.push(ev));

    const searchId = searcher.start({ query: 'needle', workdir: '/tmp/work' });
    await waitForSearch(searcher, searchId);

    const errorEvents = events.filter(
      (e: any) => e.type === 'error' && e.searchId === searchId,
    );
    expect(errorEvents.length).toBe(1);
    expect((errorEvents[0] as any).message).toMatch(/fatal error/);

    const endEvents = events.filter(
      (e: any) => e.type === 'end' && e.searchId === searchId,
    );
    expect(endEvents.length).toBe(0);
  });

  it('emits type:end when rg exits with code 1 (no matches)', async () => {
    spawnHandler = () => createFakeChild(1);

    const RipgrepSearcher = await importSearcher();
    const logger = makeLogger();
    const searcher = new RipgrepSearcher({ rgPath: '/fake/rg', logger });

    const events: unknown[] = [];
    searcher.on('event', (ev) => events.push(ev));

    const searchId = searcher.start({ query: 'needle', workdir: '/tmp/work' });
    await waitForSearch(searcher, searchId);

    const errorEvents = events.filter(
      (e: any) => e.type === 'error' && e.searchId === searchId,
    );
    expect(errorEvents.length).toBe(0);

    const endEvents = events.filter(
      (e: any) => e.type === 'end' && e.searchId === searchId,
    );
    expect(endEvents.length).toBe(1);
    expect((endEvents[0] as any).truncated).toBe(false);
  });

  it('emits type:end when rg exits with code 0', async () => {
    spawnHandler = () =>
      createFakeChild(0, [
        JSON.stringify({ type: 'match', data: { path: { text: 'a.ts' }, lines: { text: 'needle' }, line_number: 1, submatches: [] } }),
        JSON.stringify({ type: 'summary', data: { stats: { matches: 1 }, elapsed_total: { human: '0.01s' } } }),
      ]);

    const RipgrepSearcher = await importSearcher();
    const logger = makeLogger();
    const searcher = new RipgrepSearcher({ rgPath: '/fake/rg', logger });

    const events: unknown[] = [];
    searcher.on('event', (ev) => events.push(ev));

    const searchId = searcher.start({ query: 'needle', workdir: '/tmp/work' });
    await waitForSearch(searcher, searchId);

    const errorEvents = events.filter(
      (e: any) => e.type === 'error' && e.searchId === searchId,
    );
    expect(errorEvents.length).toBe(0);

    const endEvents = events.filter(
      (e: any) => e.type === 'end' && e.searchId === searchId,
    );
    expect(endEvents.length).toBe(1);
    expect((endEvents[0] as any).totalMatches).toBe(1);
  });
});
