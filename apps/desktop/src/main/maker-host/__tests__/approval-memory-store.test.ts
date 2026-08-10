import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/unused' } }));
vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({ warn: vi.fn() }),
  },
}));

import { createApprovalMemoryFileStore } from '../approval-memory-store.js';

const directories: string[] = [];
const digest = (text: string): string =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;

async function fixture(options: {
  now?: () => number;
  processIncarnation?: (pid: number) => string | null | Promise<string | null>;
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cindy-approval-memory-'));
  directories.push(directory);
  const target = path.join(directory, 'auto-review-approvals.json');
  const logger = { warn: vi.fn() };
  const memory = createApprovalMemoryFileStore(() => target, {
    flushDelayMs: 60_000,
    logger,
    processIncarnation: options.processIncarnation ?? (() => 'test-process'),
    ...(options.now ? { now: options.now } : {}),
  });
  return { directory, target, logger, memory };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('approval-memory-store', () => {
  it('只落盘摘要，不复制工作区路径或命令明文', async () => {
    const { target, memory } = await fixture();
    const workspace = '/Users/example/private-project';
    const signature = digest('pnpm test:unit');
    memory.store.add(workspace, signature, 'user');
    await memory.flush();

    const raw = await readFile(target, 'utf8');
    expect(raw).not.toContain(workspace);
    expect(raw).not.toContain('pnpm test:unit');
    expect(raw).toContain(signature);

    const reopened = createApprovalMemoryFileStore(() => target, { flushDelayMs: 60_000 });
    expect(await reopened.store.load(workspace)).toEqual(new Set([signature]));
  });

  it('用户批准优先于审阅器来源，且可按工作区清除', async () => {
    const { memory } = await fixture();
    const signature = digest('same-action');
    memory.store.add('/repo', signature, 'reviewer');
    memory.store.add('/repo', signature, 'user');
    memory.store.add('/repo', signature, 'reviewer');
    await memory.flush();

    expect((await memory.list('/repo'))[0]?.origin).toBe('user');
    expect(await memory.clear('/repo')).toBe(1);
    expect(await memory.store.load('/repo')).toEqual(new Set());
  });

  it('清除成功后通知活动会话，取消订阅后不再通知', async () => {
    const { memory } = await fixture();
    const listener = vi.fn();
    const unsubscribe = memory.store.subscribeClear?.(listener);
    const signature = digest('clear-notification');
    memory.store.add('/repo', signature, 'reviewer');
    await memory.flush();

    expect(await memory.clear('/repo')).toBe(1);
    expect(listener).toHaveBeenCalledWith('/repo');

    unsubscribe?.();
    memory.store.add('/repo', signature, 'reviewer');
    await memory.flush();
    await memory.clear();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('clear 会撤销一次 flush 失败后回队的目标批次，不让已清批准复活', async () => {
    const { target, logger, memory } = await fixture();
    const clearedSignature = digest('cleared-after-failed-flush');
    const retainedSignature = digest('other-workspace-after-failed-flush');
    memory.store.add('/repo-a', clearedSignature, 'reviewer');
    memory.store.add('/repo-b', retainedSignature, 'reviewer');

    const realLink = fs.promises.link.bind(fs.promises);
    const linkSpy = vi.spyOn(fs.promises, 'link')
      .mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EACCES' }))
      .mockImplementation(realLink);
    try {
      expect(await memory.clear('/repo-a')).toBe(0);
    } finally {
      linkSpy.mockRestore();
    }

    await memory.flush();
    expect(await memory.store.load('/repo-a')).toEqual(new Set());
    expect(await memory.store.load('/repo-b')).toEqual(new Set([retainedSignature]));
    expect(logger.warn).toHaveBeenCalledWith(
      'approval memory flush failed',
      expect.objectContaining({ message: 'locked' }),
    );
    expect(fs.existsSync(target)).toBe(true);
  });

  it('clear 覆盖等待文件锁期间新入队的批准', async () => {
    const { target, memory } = await fixture();
    await writeFile(
      `${target}.lock`,
      JSON.stringify({ pid: process.pid, ownerId: randomUUID() }),
      'utf8',
    );

    const clearPromise = memory.clear('/repo');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const racedSignature = digest('added-while-clear-waits');
    memory.store.add('/repo', racedSignature, 'reviewer');
    await rm(`${target}.lock`, { force: true });

    await expect(clearPromise).resolves.toBe(0);
    await memory.flush();
    expect(await memory.store.load('/repo')).toEqual(new Set());
  });

  it('clear 等锁失败后仍会重新调度等待期间的新批准', async () => {
    const { memory } = await fixture();
    const realLink = fs.promises.link.bind(fs.promises);
    let rejectLink: ((error: Error) => void) | undefined;
    const blockedLink = new Promise<void>((_resolve, reject) => {
      rejectLink = reject;
    });
    const linkSpy = vi.spyOn(fs.promises, 'link')
      .mockImplementationOnce(() => blockedLink)
      .mockImplementation(realLink);

    const clearPromise = memory.clear('/repo');
    await vi.waitFor(() => expect(linkSpy).toHaveBeenCalledTimes(1));
    const racedSignature = digest('added-while-failed-clear-waits');
    memory.store.add('/repo', racedSignature, 'reviewer');
    rejectLink?.(Object.assign(new Error('locked'), { code: 'EACCES' }));

    await expect(clearPromise).rejects.toThrow('locked');
    linkSpy.mockRestore();
    await memory.flush();
    expect(await memory.store.load('/repo')).toEqual(new Set([racedSignature]));
  });

  it('clear 成功通知期间产生的新批准不会被遗失', async () => {
    const { memory } = await fixture();
    const beforeClear = digest('before-clear-notify');
    const afterClear = digest('after-clear-notify');
    memory.store.add('/repo', beforeClear, 'reviewer');
    await memory.flush();
    memory.store.subscribeClear?.(() => {
      memory.store.add('/repo', afterClear, 'reviewer');
    });

    await expect(memory.clear('/repo')).resolves.toBe(1);
    await memory.flush();
    expect(await memory.store.load('/repo')).toEqual(new Set([afterClear]));
  });

  it('持久化清除代次使另一实例的活动批次和重启读取一起失效', async () => {
    const { target } = await fixture();
    const first = createApprovalMemoryFileStore(() => target, { flushDelayMs: 60_000 });
    const second = createApprovalMemoryFileStore(() => target, { flushDelayMs: 60_000 });
    const persistedSignature = digest('persisted-before-cross-process-clear');
    const pendingSignature = digest('pending-before-cross-process-clear');

    first.store.add('/repo', persistedSignature, 'reviewer');
    await first.flush();
    const before = second.getClearGeneration('/repo');
    second.store.add('/repo', pendingSignature, 'reviewer');

    expect(await first.clear('/repo')).toBe(1);
    expect(second.getClearGeneration('/repo')).not.toBe(before);
    await second.flush();
    expect(await second.store.load('/repo')).toEqual(new Set());

    const reopened = createApprovalMemoryFileStore(() => target, { flushDelayMs: 60_000 });
    expect(await reopened.store.load('/repo')).toEqual(new Set());
  });

  it('代次 sidecar 让热路径不必解析完整批准账本', async () => {
    const { target, memory } = await fixture();
    const signature = digest('sidecar-generation');
    memory.store.add('/repo', signature, 'reviewer');
    await memory.flush();

    const generationPath = `${target}.generation`;
    const generationRaw = await readFile(generationPath, 'utf8');
    expect(generationRaw).not.toContain(signature);
    expect(memory.getClearGeneration('/repo')).toBe('0:0');

    // A fresh reader can still observe the token from the tiny sidecar even if the large ledger
    // is unavailable; getClearGeneration must not parse/normalize the approval payload here.
    const reader = createApprovalMemoryFileStore(() => target, { flushDelayMs: 60_000 });
    await writeFile(target, '{broken ledger', 'utf8');
    expect(reader.getClearGeneration('/repo')).toBe('0:0');
  });

  it('主账本交换中断时，较新的 sidecar 代次不会被旧 flush 覆盖', async () => {
    const { target, memory } = await fixture();
    const oldSignature = digest('sidecar-crash-old');
    const newSignature = digest('sidecar-crash-new');
    memory.store.add('/repo', oldSignature, 'reviewer');
    await memory.flush();
    const oldLedger = await readFile(target, 'utf8');

    await expect(memory.clear('/repo')).resolves.toBe(1);
    await writeFile(target, oldLedger, 'utf8');

    const reopened = createApprovalMemoryFileStore(() => target, { flushDelayMs: 60_000 });
    expect(await reopened.store.load('/repo')).toEqual(new Set());
    reopened.store.add('/repo', newSignature, 'reviewer');
    await reopened.flush();
    expect(await reopened.store.load('/repo')).toEqual(new Set([newSignature]));
  });

  it('两个实例并发写同一文件不会互相覆盖', async () => {
    const { target } = await fixture();
    const first = createApprovalMemoryFileStore(() => target, { flushDelayMs: 60_000 });
    const second = createApprovalMemoryFileStore(() => target, { flushDelayMs: 60_000 });
    const firstSignature = digest('first');
    const secondSignature = digest('second');
    first.store.add('/repo', firstSignature, 'reviewer');
    second.store.add('/repo', secondSignature, 'user');

    await Promise.all([first.flush(), second.flush()]);
    expect(await first.store.load('/repo')).toEqual(new Set([firstSignature, secondSignature]));
  });

  it('切换 data owner 后，节流中的批准仍写回原 owner 且互不可见', async () => {
    const { directory } = await fixture();
    const ownerAPath = path.join(directory, 'owner-a', 'auto-review-approvals.json');
    const ownerBPath = path.join(directory, 'owner-b', 'auto-review-approvals.json');
    let activePath = ownerAPath;
    const scoped = createApprovalMemoryFileStore(() => activePath, { flushDelayMs: 60_000 });
    const ownerASignature = digest('owner-a-action');
    const ownerBSignature = digest('owner-b-action');

    scoped.store.add('/repo', ownerASignature, 'reviewer');
    activePath = ownerBPath;
    scoped.store.add('/repo', ownerBSignature, 'reviewer');
    await scoped.flush();

    expect(await scoped.store.load('/repo')).toEqual(new Set([ownerBSignature]));
    activePath = ownerAPath;
    expect(await scoped.store.load('/repo')).toEqual(new Set([ownerASignature]));
    expect(await scoped.list('/repo')).toEqual([
      expect.objectContaining({ signature: ownerASignature }),
    ]);
  });

  it.each(['load', 'list'] as const)(
    '%s 等待 live writer 释放锁，不在 Windows 备份交换窗口抢先恢复 .bak',
    async (operation) => {
      const { target, memory } = await fixture();
      const signature = digest(`locked-${operation}`);
      memory.store.add('/repo', signature, 'reviewer');
      await memory.flush();

      await writeFile(
        `${target}.lock`,
        JSON.stringify({ pid: process.pid, ownerId: randomUUID() }),
        'utf8',
      );
      fs.renameSync(target, `${target}.bak`);

      const readPromise = operation === 'load'
        ? memory.store.load('/repo')
        : memory.list('/repo');
      const inspectedSwapWindow = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          try {
            expect(fs.existsSync(target)).toBe(false);
            expect(fs.existsSync(`${target}.bak`)).toBe(true);
            fs.renameSync(`${target}.bak`, target);
            fs.unlinkSync(`${target}.lock`);
            resolve();
          } catch (error) {
            reject(error);
          }
        }, 30);
      });

      await inspectedSwapWindow;
      const result = await readPromise;
      if (operation === 'load') {
        expect(result).toEqual(new Set([signature]));
      } else {
        expect(result).toEqual([expect.objectContaining({ signature })]);
      }
    },
  );

  it('writer 崩溃后只剩 .bak 时，持锁读取仍能恢复最后快照', async () => {
    const { target, memory } = await fixture();
    const signature = digest('recover-after-writer-crash');
    memory.store.add('/repo', signature, 'reviewer');
    await memory.flush();
    fs.renameSync(target, `${target}.bak`);

    expect(await memory.store.load('/repo')).toEqual(new Set([signature]));
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(`${target}.bak`)).toBe(false);
  });

  it.each(['EPERM', 'EEXIST'] as const)(
    'Windows 覆盖 rename 返回 %s 时走备份交换且保留新旧记忆',
    async (code) => {
      const { target, memory } = await fixture();
      const firstSignature = digest('before-windows-replace');
      const secondSignature = digest('after-windows-replace');
      memory.store.add('/repo', firstSignature, 'reviewer');
      await memory.flush();

      const realRename = fs.renameSync;
      let rejectFirstReplacement = true;
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((
        (from: string, to: string) => {
          if (
            rejectFirstReplacement
            && String(from).endsWith('.tmp')
            && String(to) === target
          ) {
            rejectFirstReplacement = false;
            throw Object.assign(new Error(code), { code });
          }
          return realRename(from as never, to as never);
        }
      ) as typeof fs.renameSync);
      try {
        memory.store.add('/repo', secondSignature, 'user');
        await memory.flush();
      } finally {
        renameSpy.mockRestore();
      }

      expect(rejectFirstReplacement).toBe(false);
      const reopened = createApprovalMemoryFileStore(() => target, { flushDelayMs: 60_000 });
      expect(await reopened.store.load('/repo')).toEqual(
        new Set([firstSignature, secondSignature]),
      );
      expect(fs.existsSync(`${target}.bak`)).toBe(false);
      expect(fs.readdirSync(path.dirname(target)).some((name) => name.endsWith('.tmp'))).toBe(false);
    },
  );

  it('只回收已确认死亡进程留下的锁', async () => {
    const { target, memory } = await fixture();
    await writeFile(
      `${target}.lock`,
      JSON.stringify({ pid: 2_147_483_647, ownerId: randomUUID() }),
      'utf8',
    );
    const signature = digest('after-crash');
    memory.store.add('/repo', signature, 'reviewer');
    await memory.flush();
    expect(await memory.store.load('/repo')).toEqual(new Set([signature]));
  });

  it.each(['flush', 'load', 'list', 'clear'] as const)(
    '%s 在 PID 复用时回收不同 incarnation 的陈旧锁',
    async (operation) => {
      const currentIncarnation = 'current-process-incarnation';
      const { target, memory } = await fixture({
        processIncarnation: () => currentIncarnation,
      });
      const signature = digest(`after-pid-reuse-${operation}`);
      if (operation !== 'flush') {
        memory.store.add('/repo', signature, 'reviewer');
        await memory.flush();
      }

      await writeFile(
        `${target}.lock`,
        JSON.stringify({
          pid: process.pid,
          ownerId: randomUUID(),
          incarnation: 'crashed-process-incarnation',
        }),
        'utf8',
      );

      if (operation === 'flush') {
        memory.store.add('/repo', signature, 'reviewer');
        await memory.flush();
        expect(await memory.store.load('/repo')).toEqual(new Set([signature]));
      } else if (operation === 'load') {
        expect(await memory.store.load('/repo')).toEqual(new Set([signature]));
      } else if (operation === 'list') {
        expect(await memory.list('/repo')).toEqual([
          expect.objectContaining({ signature }),
        ]);
      } else {
        expect(await memory.clear('/repo')).toBe(1);
      }
    },
  );

  it.each([
    ['相同 incarnation', { incarnation: 'current-process-incarnation' }],
    ['未知 incarnation', {}],
  ] as const)(
    '%s 的 live PID 锁保持 fail-closed 并超时',
    async (_label, ownerFields) => {
      const { target, memory } = await fixture({
        processIncarnation: () => 'current-process-incarnation',
      });
      const lockPath = `${target}.lock`;
      await writeFile(lockPath, JSON.stringify({
        pid: process.pid,
        ownerId: randomUUID(),
        ...ownerFields,
      }), 'utf8');

      await expect(memory.store.load('/repo')).rejects.toThrow(
        'approval memory lock timed out',
      );
      expect(fs.existsSync(lockPath)).toBe(true);
    },
    5_000,
  );

  it('锁竞争中的 incarnation 查询走异步 reader，并按同一 owner 缓存重试', async () => {
    const reader = vi.fn(async () => 'current-process-incarnation');
    const { target, memory } = await fixture({ processIncarnation: reader });
    const lockPath = `${target}.lock`;
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      ownerId: randomUUID(),
      incarnation: 'current-process-incarnation',
    }), 'utf8');

    const loadPromise = memory.store.load('/repo');
    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(2));
    // Let several retry intervals elapse while the lock bytes stay unchanged. The owner lookup
    // is asynchronous and must be reused, rather than spawning one process probe per retry.
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(reader).toHaveBeenCalledTimes(2);

    await rm(lockPath, { force: true });
    await expect(loadPromise).resolves.toEqual(new Set());
  }, 5_000);

  it('陈旧锁检查后换主时恢复新 owner，不被回收者删除', async () => {
    const currentIncarnation = 'current-process-incarnation';
    const { directory, target, memory } = await fixture({
      processIncarnation: () => currentIncarnation,
    });
    const lockPath = `${target}.lock`;
    const staleRaw = JSON.stringify({
      pid: process.pid,
      ownerId: randomUUID(),
      incarnation: 'crashed-process-incarnation',
    });
    const replacementRaw = JSON.stringify({
      pid: process.pid,
      ownerId: randomUUID(),
      incarnation: currentIncarnation,
    });
    await writeFile(lockPath, staleRaw, 'utf8');

    const realRename = fs.promises.rename.bind(fs.promises);
    const renameSpy = vi.spyOn(fs.promises, 'rename')
      .mockImplementationOnce(async (from, to) => {
        expect(String(from)).toBe(lockPath);
        await writeFile(lockPath, replacementRaw, 'utf8');
        return realRename(from, to);
      })
      .mockImplementation(realRename);
    try {
      const loadPromise = memory.store.load('/repo');
      await vi.waitFor(async () => {
        const raw = await readFile(lockPath, 'utf8').catch(() => '');
        expect(raw).toBe(replacementRaw);
      });
      expect(renameSpy).toHaveBeenCalled();
      await rm(lockPath, { force: true });
      await expect(loadPromise).resolves.toEqual(new Set());
    } finally {
      renameSpy.mockRestore();
    }

    expect(fs.readdirSync(directory).some((name) => name.endsWith('.reclaim'))).toBe(false);
  });

  it('无 owner 的旧锁即使超过旧版时限也不穿透仍可能存活的持锁实例', async () => {
    const { target, memory } = await fixture();
    const lockPath = `${target}.lock`;
    await writeFile(lockPath, '', 'utf8');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);

    const signature = digest('after-incomplete-lock');
    memory.store.add('/repo', signature, 'reviewer');
    const flush = memory.flush();
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      await rm(lockPath, { force: true });
      await flush;
    }

    expect(await memory.store.load('/repo')).toEqual(new Set([signature]));
  });

  it('单工作区最多保留 500 条，淘汰最旧记录', async () => {
    let timestamp = 0;
    const { memory } = await fixture({ now: () => timestamp++ });
    const signatures = Array.from({ length: 505 }, (_, index) => digest(String(index)));
    for (const signature of signatures) memory.store.add('/repo', signature, 'reviewer');
    await memory.flush();

    const entries = await memory.list('/repo');
    expect(entries).toHaveLength(500);
    expect(entries.map((entry) => entry.signature)).not.toContain(signatures[0]);
    expect(entries.map((entry) => entry.signature)).toContain(signatures.at(-1));
  });

  it('坏文件和非法键按空集处理，不扩大批准面', async () => {
    const { target, logger, memory } = await fixture();
    await writeFile(target, '{broken', 'utf8');
    expect(await memory.store.load('/repo')).toEqual(new Set());
    expect(logger.warn).toHaveBeenCalled();

    memory.store.add('/repo', 'pnpm publish', 'user');
    await memory.flush();
    expect(await memory.store.load('/repo')).toEqual(new Set());
  });

  it('显式 flush 不等待 unref 节流 timer，供退出生命周期刷写 pending 批次', async () => {
    const { target, memory } = await fixture();
    const signature = digest('approved-before-quit');
    memory.store.add('/repo', signature, 'user');

    await memory.flush();

    const reopened = createApprovalMemoryFileStore(() => target, { flushDelayMs: 60_000 });
    expect(await reopened.store.load('/repo')).toEqual(new Set([signature]));
  });

  it('Desktop 在统一退出链的 post-async 阶段注册批准记忆 flush', () => {
    const bootstrap = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'bootstrap-electron.ts'),
      'utf8',
    );
    const makerShutdown = bootstrap.indexOf("onQuit('shutdown-maker'");
    const approvalFlush = bootstrap.indexOf("onQuit('approval-memory-store'");
    const installHandler = bootstrap.indexOf('installQuitHandler(6000)');

    expect(makerShutdown).toBeGreaterThan(-1);
    expect(approvalFlush).toBeGreaterThan(makerShutdown);
    expect(installHandler).toBeGreaterThan(approvalFlush);
    expect(bootstrap.slice(approvalFlush, installHandler)).toContain(
      'flushApprovalMemoryStore()',
    );
    expect(bootstrap.slice(approvalFlush, installHandler)).toContain("'post-async'");
  });
});
