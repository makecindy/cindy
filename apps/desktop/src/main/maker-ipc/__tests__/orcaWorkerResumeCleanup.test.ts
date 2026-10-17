import { readFileSync } from 'node:fs';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

/**
 * `resumeOrcaWorkerSessionIfMissing` 的运行期行为（不是源码文本断言）。
 *
 * 背景：worker 冷启（focus / 派活）在 `bootstrapSession` 之后还有多条失败出口 ——
 * 插件 authority 复核（assertCurrent 抛错）、关闭协同 / 归档 / 显式 idle 的取消标记、
 * 会话已不是 active。任何一条失败都必须把刚拉起的 runtime 关掉，否则已归档 worker
 * 会留在运行态（review P1 + Security）。
 *
 * 该函数闭合在 registerMakerIpc 里，依赖 15 个符号；这里沿用仓库既有的
 * 「切源码 + new Function 注入依赖」手法真实执行它，覆盖三条失败出口与成功出口。
 */
describe('resumeOrcaWorkerSessionIfMissing runtime cleanup', () => {
  const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
  const fnSource = source.slice(
    source.indexOf('  async function resumeOrcaWorkerSessionIfMissing('),
    source.indexOf('  // focus 切换是纯 UI 操作,不再同步等待冷启动'),
  );

  interface Overrides {
    /** isCancelled 返回 true 的时机：'pre' | 'post' | null。 */
    cancelledAt?: 'pre' | 'post' | null;
    /** 冷启动前读到的会话状态。 */
    sessionStatus?: string;
    /** 冷启动后（post-bootstrap 复核）读到的会话状态；缺省与冷启动前相同。 */
    sessionStatusAfterBoot?: string;
  }

  function createRuntime(overrides: Overrides = {}) {
    const { cancelledAt = null, sessionStatus = 'active', sessionStatusAfterBoot } = overrides;
    const closeSession = vi.fn(async () => undefined);
    const bootstrapSession = vi.fn(async (opts: { id: string }) => {
      booted = true;
      return { session: { id: opts.id } };
    });
    const markOrcaRoleIfNeeded = vi.fn(async () => undefined);
    // cancelAt='pre' 表示任何时候都 true；'post' 表示只在 bootstrap 拉起 runtime 之后 true，
    // 对应「冷启动过程中关闭协同 / 归档 / 显式 idle」。
    let booted = false;
    const isCancelled = vi.fn(() => {
      if (cancelledAt === 'pre') return true;
      return cancelledAt === 'post' && booted;
    });
    // 预检查读一次、post-bootstrap 复核再读一次：支持“冷启动过程中被归档”。
    let statusReads = 0;
    const readStatus = () => {
      statusReads += 1;
      if (statusReads === 1) return sessionStatus;
      return sessionStatusAfterBoot ?? sessionStatus;
    };
    const bindings = {
      maker: { getSession: () => undefined, closeSession },
      getDbClient: () => ({
        drizzle: {
          select: () => ({
            from: () => ({
              where: () => ({
                limit: async () => [
                  { id: 'worker-session-1', status: readStatus(), orcaRole: 'worker' },
                ],
              }),
            }),
          }),
        },
      }),
      sessions: { status: 'status' },
      eq: () => ({}),
      readSessionExtraDirsFromDb: async () => [],
      readSessionWritableDirsFromDb: async () => [],
      buildCreateOptsWithStderr: (opts: Record<string, unknown>) => opts,
      dbToMakerAgentKind: (value: unknown) => value,
      permissionModeOrAsk: (value: unknown) => value,
      directoryGrantsForRuntime: () => ({}),
      ensureRemoteReadyForSessionStart: async () => undefined,
      bootstrapSession,
      markOrcaRoleIfNeeded,
      log: { info: vi.fn(), warn: vi.fn() },
    };
    const js = ts.transpileModule(`${fnSource}\nreturn resumeOrcaWorkerSessionIfMissing;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const resume = new Function(...Object.keys(bindings), js)(...Object.values(bindings)) as (
      target: { id: string; teamId: string; leadSessionId: string; sessionId: string },
      assertCurrentFn?: () => Promise<void>,
      isCancelledFn?: () => boolean,
    ) => Promise<boolean>;
    const target = {
      id: 'worker-1',
      teamId: 'team-1',
      leadSessionId: 'lead-1',
      sessionId: 'worker-session-1',
    };
    return { resume, target, closeSession, bootstrapSession, markOrcaRoleIfNeeded, isCancelled };
  }

  it('closes the freshly booted session and rethrows when authority is revoked mid-boot', async () => {
    const { resume, target, closeSession, bootstrapSession, markOrcaRoleIfNeeded } =
      createRuntime();
    // assertCurrent 调用序：ensure 前(1)、ensure 后(2)、bootstrap 后(3)。
    const assertCurrent = vi.fn(async () => {
      if (assertCurrent.mock.calls.length === 3) throw new Error('Revoked');
    });

    await expect(resume(target, assertCurrent)).rejects.toThrow('Revoked');

    expect(bootstrapSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledWith('worker-session-1');
    expect(markOrcaRoleIfNeeded).not.toHaveBeenCalled();
  });

  it('closes the freshly booted session and returns false when cancelled after bootstrap', async () => {
    const { resume, target, closeSession, markOrcaRoleIfNeeded, isCancelled } = createRuntime({
      cancelledAt: 'post',
    });

    await expect(resume(target, undefined, isCancelled)).resolves.toBe(false);

    expect(closeSession).toHaveBeenCalledWith('worker-session-1');
    expect(markOrcaRoleIfNeeded).not.toHaveBeenCalled();
  });

  it('never boots when the resume is cancelled before the cold start', async () => {
    const { resume, target, closeSession, bootstrapSession, isCancelled } = createRuntime({
      cancelledAt: 'pre',
    });

    await expect(resume(target, undefined, isCancelled)).resolves.toBe(false);

    expect(bootstrapSession).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('closes the freshly booted session and returns false when the session was archived mid-boot', async () => {
    const { resume, target, closeSession, markOrcaRoleIfNeeded } = createRuntime({
      sessionStatus: 'active',
      sessionStatusAfterBoot: 'archived',
    });

    await expect(resume(target)).resolves.toBe(false);

    expect(closeSession).toHaveBeenCalledWith('worker-session-1');
    expect(markOrcaRoleIfNeeded).not.toHaveBeenCalled();
  });

  it('never boots when the session is already archived before the cold start', async () => {
    const { resume, target, closeSession, bootstrapSession } = createRuntime({
      sessionStatus: 'archived',
    });

    await expect(resume(target)).resolves.toBe(false);

    expect(bootstrapSession).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('keeps the runtime on the healthy path', async () => {
    const { resume, target, closeSession, markOrcaRoleIfNeeded } = createRuntime();

    await expect(
      resume(
        target,
        async () => undefined,
        () => false,
      ),
    ).resolves.toBe(true);

    expect(markOrcaRoleIfNeeded).toHaveBeenCalledWith('worker-session-1', 'worker');
    expect(closeSession).not.toHaveBeenCalled();
  });
});
