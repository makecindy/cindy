import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const executePreRunHookMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock('../pre-run-hook', () => ({
  executePreRunHook: executePreRunHookMock,
  buildSkipResultText: (hook: { exitCode?: number | null }) => `exit ${hook.exitCode ?? '?'}`,
  formatPreRunHookFailure: (hook: { error?: string; exitCode?: number | null }) =>
    hook.error
      ? `pre-run hook failed: ${hook.error}`
      : `pre-run hook failed with exit code ${hook.exitCode ?? 'unknown'}`,
}));

vi.mock('../../localDb/schema', () => ({
  sessions: { id: 'id' },
}));


// killProcessTree 的 OS 级树杀机制(taskkill 重试/进程组信号/后代兜底)由
// proc-util.test.ts / procUtilRetry.test.ts 单独覆盖;这里只关心 script-runner
// "何时该杀"的决策,换成直接调用 child.kill 的轻量替身,避免依赖 taskkill 子
// 进程在本文件 spawn mock 下的复杂交互。默认同步调 onSettled(模拟"杀的动作
// 已经做完")——个别测试需要模拟"kill 后一直不 settle"时用 mockImplementationOnce
// 覆盖,不调 onSettled。
const killProcessTreeMock = vi.hoisted(() =>
  vi.fn(
    (
      _pid: number | undefined,
      child: { kill: (signal: string) => void },
      onSettled?: () => void,
    ) => {
      child.kill('SIGKILL');
      onSettled?.();
    },
  ),
);
vi.mock('../proc-util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../proc-util')>();
  return { ...actual, killProcessTree: killProcessTreeMock };
});

import { ScriptScheduleRunner, buildScriptEnv } from '../script-runner';

function childProcess() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 123;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

function schedule() {
  return {
    id: 'script-schedule',
    name: 'script schedule',
    prompt: '',
    executionMode: 'script' as const,
    scriptConfig: {
      command: 'python auto.py',
      capabilities: ['jira.read' as const],
    },
    kind: 'cron' as const,
    cronExpr: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    recurring: true,
    manual: false,
    agentKind: 'codex' as const,
    workspaceKind: 'project' as const,
    workingDir: 'C:\\project',
    useWorktree: false,
    persistentSession: false,
    silentWhenIdle: false,
    notify: { desktop: true, feishu: false },
    status: 'active' as const,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('ScriptScheduleRunner', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    executePreRunHookMock.mockReset();
    killProcessTreeMock.mockClear();
  });

  it('pre-run hook exit 2 skips without creating a session or spawning the script', async () => {
    executePreRunHookMock.mockResolvedValue({
      decision: 'skip',
      exitCode: 2,
      timedOut: false,
      spawnError: undefined,
      durationMs: 5,
      stdout: 'no changes',
      stderr: '',
    });
    const runner = new ScriptScheduleRunner({
      broker: { call: vi.fn() },
      logger: {},
      getDb: vi.fn(),
    });

    await expect(
      runner.fire(
        { ...schedule(), preRunHook: { command: 'node check.mjs' } },
        { runId: 'run-skip', firedAt: 1, signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      sessionId: '',
      skipped: true,
      resultText: expect.stringContaining('exit 2'),
    });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(executePreRunHookMock).toHaveBeenCalledTimes(1);
  });

  it('services host calls and returns the terminal summary without an agent session', async () => {
    const child = childProcess();
    spawnMock.mockReturnValue(child);
    const hostFrames: string[] = [];
    child.stdin.on('data', (chunk) => hostFrames.push(String(chunk)));
    const broker = { call: vi.fn(async () => ({ key: 'DING-1' })) };
    const runner = new ScriptScheduleRunner({ broker, logger: {} });
    const resultPromise = runner.fire(schedule(), {
      runId: 'run-1',
      firedAt: 1,
      signal: new AbortController().signal,
    });

    child.stdout.write(`${JSON.stringify({
      protocol: 'xdt-maker-script/1',
      type: 'call',
      id: 'py-1',
      method: 'jira.get',
      params: { issue_key: 'DING-1' },
    })}\n`);
    await vi.waitFor(() => expect(broker.call).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(hostFrames.join('')).toContain('"type":"call_result"'));
    const legacyResponse = hostFrames
      .flatMap((chunk) => chunk.trim().split('\n'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((frame) => frame.type === 'call_result');
    expect(legacyResponse?.protocol).toBe('xdt-maker-script/1');
    expect(broker.call).toHaveBeenCalledWith(
      { method: 'jira.get', params: { issue_key: 'DING-1' } },
      new Set(['jira.read']),
      { schedule: expect.objectContaining({ id: 'script-schedule' }) },
    );
    child.stdout.write(`${JSON.stringify({
      protocol: 'xdt-maker-script/1',
      type: 'complete',
      resultText: 'done',
      primarySessionId: null,
    })}\n`);
    child.emit('close', 0);

    await expect(resultPromise).resolves.toEqual({ sessionId: '', resultText: 'done' });
    expect(spawnMock).toHaveBeenCalledWith(
      'python auto.py',
      expect.objectContaining({ shell: true, cwd: 'C:\\project' }),
    );
  });

  it('starts with the legacy protocol, then responds with the Cindy protocol selected by a new client', async () => {
    const child = childProcess();
    spawnMock.mockReturnValue(child);
    const hostFrames: string[] = [];
    child.stdin.on('data', (chunk) => hostFrames.push(String(chunk)));
    const broker = { call: vi.fn(async () => ({ key: 'DING-1' })) };
    const runner = new ScriptScheduleRunner({ broker, logger: {} });
    const resultPromise = runner.fire(schedule(), {
      runId: 'run-new-protocol',
      firedAt: 1,
      signal: new AbortController().signal,
    });

    const startFrame = JSON.parse(hostFrames.join('').trim()) as Record<string, unknown>;
    expect(startFrame).toMatchObject({ protocol: 'xdt-maker-script/1', type: 'start' });

    child.stdout.write(`${JSON.stringify({
      protocol: 'cindy-script/1',
      type: 'call',
      id: 'py-1',
      method: 'jira.get',
      params: { issue_key: 'DING-1' },
    })}\n`);
    await vi.waitFor(() => expect(hostFrames.join('')).toContain('"type":"call_result"'));
    const responseFrames = hostFrames
      .flatMap((chunk) => chunk.trim().split('\n'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(responseFrames.find((frame) => frame.type === 'call_result')?.protocol).toBe('cindy-script/1');

    child.stdout.write(`${JSON.stringify({
      protocol: 'cindy-script/1',
      type: 'complete',
      resultText: 'done',
    })}\n`);
    child.emit('close', 0);

    await expect(resultPromise).resolves.toEqual({ sessionId: '', resultText: 'done' });
  });

  it('keeps the legacy protocol in capabilities payloads for legacy clients', async () => {
    const child = childProcess();
    spawnMock.mockReturnValue(child);
    const hostFrames: string[] = [];
    child.stdin.on('data', (chunk) => hostFrames.push(String(chunk)));
    const broker = {
      call: vi.fn(async () => ({ protocol: 'cindy-script/1', granted: ['jira.read'], methods: [] })),
    };
    const runner = new ScriptScheduleRunner({ broker, logger: {} });
    const resultPromise = runner.fire(schedule(), {
      runId: 'run-legacy-protocol',
      firedAt: 1,
      signal: new AbortController().signal,
    });

    child.stdout.write(`${JSON.stringify({
      protocol: 'xdt-maker-script/1',
      type: 'call',
      id: 'py-1',
      method: 'host.capabilities',
      params: {},
    })}\n`);
    await vi.waitFor(() => expect(hostFrames.join('')).toContain('"type":"call_result"'));
    const responseFrames = hostFrames
      .flatMap((chunk) => chunk.trim().split('\n'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const callResult = responseFrames.find((frame) => frame.type === 'call_result');
    expect(callResult).toMatchObject({
      protocol: 'xdt-maker-script/1',
      result: { protocol: 'xdt-maker-script/1' },
    });

    child.stdout.write(`${JSON.stringify({
      protocol: 'xdt-maker-script/1',
      type: 'complete',
      resultText: 'done',
    })}\n`);
    child.emit('close', 0);
    await expect(resultPromise).resolves.toEqual({ sessionId: '', resultText: 'done' });
  });

  it('pre-run hook 失败时保存检查结果、阻止主脚本并发送失败通知', async () => {
    executePreRunHookMock.mockResolvedValue({
      status: 'failed',
      decision: 'block',
      exitCode: 1,
      timedOut: false,
      aborted: false,
      durationMs: 8,
      stdout: '',
      stderr: 'dependency unavailable',
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    const notifier = { notify: vi.fn(async () => undefined) };
    const onPreRunHookCompleted = vi.fn(async () => undefined);
    const runner = new ScriptScheduleRunner({
      broker: { call: vi.fn() },
      logger: {},
      notifier,
    });
    const resultPromise = runner.fire(
      { ...schedule(), preRunHook: { command: 'node check.mjs' } },
      {
        runId: 'run-hook-failed',
        firedAt: 2,
        signal: new AbortController().signal,
        onPreRunHookCompleted,
      },
    );

    await expect(resultPromise).rejects.toThrow('pre-run hook failed with exit code 1');
    expect(onPreRunHookCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        decision: 'block',
        exitCode: 1,
        stderr: 'dependency unavailable',
      }),
    );
    expect(spawnMock).not.toHaveBeenCalled();
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'script-schedule' }),
      expect.objectContaining({
        id: 'run-hook-failed',
        status: 'failed',
        errorMsg: 'pre-run hook failed with exit code 1',
      }),
    );
  });

  it('does not finalize a run while a host call is still in flight (codex review #966)', async () => {
    // sessions.dispatch/jira.add_comment 这类写操作:complete 帧比 broker.call()
    // 的 resolve 先到达时,不能立即视为终态关 stdin——否则写操作真失败会被静默
    // 吞掉(这轮已经报了 success)。必须等 inflight 归零才真正完成。
    const child = childProcess();
    spawnMock.mockReturnValue(child);
    let resolveCall: (value: unknown) => void = () => {};
    const broker = {
      call: vi.fn(() => new Promise((resolve) => { resolveCall = resolve; })),
    };
    const runner = new ScriptScheduleRunner({ broker, logger: {} });
    const resultPromise = runner.fire(schedule(), {
      runId: 'run-1',
      firedAt: 1,
      signal: new AbortController().signal,
    });

    child.stdout.write(`${JSON.stringify({
      protocol: 'xdt-maker-script/1',
      type: 'call',
      id: 'py-1',
      method: 'sessions.dispatch',
      params: { message: 'hi' },
    })}\n`);
    await vi.waitFor(() => expect(broker.call).toHaveBeenCalledTimes(1));

    // 脚本在调用还没返回时就抢发 complete——不该立即结束 stdin。
    child.stdout.write(`${JSON.stringify({
      protocol: 'xdt-maker-script/1',
      type: 'complete',
      resultText: 'done',
    })}\n`);
    // 让出几个 microtask:若实现有 bug 立即 end() 了 stdin,这里就能看出来。
    await Promise.resolve();
    await Promise.resolve();
    expect(child.stdin.writable).toBe(true);

    resolveCall({ ok: true });
    await vi.waitFor(() => expect(child.stdin.writable).toBe(false));
    child.emit('close', 0);

    await expect(resultPromise).resolves.toEqual({ sessionId: '', resultText: 'done' });
  });

  it('waits for a call still in flight when child process exits right after complete (codex review 第三次发现)', async () => {
    // 与上面那条不同:这次脚本发完 call+complete 后**直接退出**(不等 host 关
    // stdin)。child.on('close') 只反映"进程没了",不反映"调用账本清了没"——
    // 若不等 inflight 落地就去检查 completed,会误判成"没发 complete 帧"而
    // 整轮失败,尽管脚本明明发了、调用也终将成功。
    const child = childProcess();
    spawnMock.mockReturnValue(child);
    let resolveCall: (value: unknown) => void = () => {};
    const broker = {
      call: vi.fn(() => new Promise((resolve) => { resolveCall = resolve; })),
    };
    const runner = new ScriptScheduleRunner({ broker, logger: {} });
    const resultPromise = runner.fire(schedule(), {
      runId: 'run-1',
      firedAt: 1,
      signal: new AbortController().signal,
    });

    child.stdout.write(`${JSON.stringify({
      protocol: 'xdt-maker-script/1',
      type: 'call',
      id: 'py-1',
      method: 'sessions.dispatch',
      params: { message: 'hi' },
    })}\n`);
    await vi.waitFor(() => expect(broker.call).toHaveBeenCalledTimes(1));
    child.stdout.write(`${JSON.stringify({
      protocol: 'xdt-maker-script/1',
      type: 'complete',
      resultText: 'done',
    })}\n`);
    // 进程直接退出——此刻 broker.call() 仍未 resolve,inflight 仍是 1。
    child.emit('close', 0);
    await Promise.resolve();
    await Promise.resolve();

    resolveCall({ ok: true });
    await expect(resultPromise).resolves.toEqual({ sessionId: '', resultText: 'done' });
  });

  it('fails the whole run when a call in flight at complete-time later rejects (codex review #966 second pass)', async () => {
    // 脚本在调用结果出来前就抢发 complete、而那个调用最终失败——脚本没机会看到
    // /处理这次失败,不能悄悄用它自己声明的"成功"结论收尾,必须让整轮失败。
    const child = childProcess();
    spawnMock.mockReturnValue(child);
    let rejectCall: (err: unknown) => void = () => {};
    const broker = {
      call: vi.fn(() => new Promise((_resolve, reject) => { rejectCall = reject; })),
    };
    const runner = new ScriptScheduleRunner({ broker, logger: {} });
    const resultPromise = runner.fire(schedule(), {
      runId: 'run-1',
      firedAt: 1,
      signal: new AbortController().signal,
    });

    child.stdout.write(`${JSON.stringify({
      protocol: 'xdt-maker-script/1',
      type: 'call',
      id: 'py-1',
      method: 'sessions.dispatch',
      params: { message: 'hi' },
    })}\n`);
    await vi.waitFor(() => expect(broker.call).toHaveBeenCalledTimes(1));
    child.stdout.write(`${JSON.stringify({
      protocol: 'xdt-maker-script/1',
      type: 'complete',
      resultText: 'done',
    })}\n`);

    rejectCall(Object.assign(new Error('session archived'), { code: 'NOT_FOUND' }));
    await vi.waitFor(() => expect(child.stdin.writable).toBe(false));
    child.emit('close', 0);

    await expect(resultPromise).rejects.toThrow('session archived');
  });

  it('does not hang past pause/delete when a call is still in flight after the child has already exited (codex review 第七轮)', async () => {
    // 子进程已经 close(退出码 0),但 broker.call() 仍未 resolve——这之后若
    // abort,不能让 fire() 永久挂起等一个已经失去意义的等待(此前 timer/abort
    // listener 在进入这段等待前就被清掉,abort 完全够不到这里)。
    const child = childProcess();
    spawnMock.mockReturnValue(child);
    let resolveCall: (value: unknown) => void = () => {};
    const broker = {
      call: vi.fn(() => new Promise((resolve) => { resolveCall = resolve; })),
    };
    const runner = new ScriptScheduleRunner({ broker, logger: {} });
    const controller = new AbortController();
    const resultPromise = runner.fire(schedule(), {
      runId: 'run-1',
      firedAt: 1,
      signal: controller.signal,
    });

    child.stdout.write(`${JSON.stringify({
      protocol: 'xdt-maker-script/1',
      type: 'call',
      id: 'py-1',
      method: 'sessions.dispatch',
      params: { message: 'hi' },
    })}\n`);
    await vi.waitFor(() => expect(broker.call).toHaveBeenCalledTimes(1));
    child.stdout.write(`${JSON.stringify({
      protocol: 'xdt-maker-script/1',
      type: 'complete',
      resultText: 'done',
    })}\n`);
    child.emit('close', 0);
    await Promise.resolve();
    await Promise.resolve();

    controller.abort();
    await expect(resultPromise).rejects.toThrow('script execution aborted');
    // 子进程已经退出,pid 随时可能被 OS 复用——这个 abort 只该打断等待,绝不能
    // 再对旧 pid 发真实的树杀(codex review 第七轮二次发现:误杀无关进程风险)。
    expect(killProcessTreeMock).not.toHaveBeenCalled();

    // dangling 的 broker 调用最终落地不该再产生任何影响(没有监听者关心它了)。
    resolveCall({ ok: true });
  });

  it('does not hang past the configured timeout when a call is still in flight after the child has already exited (codex review 第七轮)', async () => {
    const child = childProcess();
    spawnMock.mockReturnValue(child);
    let resolveCall: (value: unknown) => void = () => {};
    const broker = {
      call: vi.fn(() => new Promise((resolve) => { resolveCall = resolve; })),
    };
    const runner = new ScriptScheduleRunner({ broker, logger: {} });
    const baseSchedule = schedule();
    const resultPromise = runner.fire(
      { ...baseSchedule, scriptConfig: { ...baseSchedule.scriptConfig, timeoutMs: 20 } },
      { runId: 'run-1', firedAt: 1, signal: new AbortController().signal },
    );

    child.stdout.write(`${JSON.stringify({
      protocol: 'xdt-maker-script/1',
      type: 'call',
      id: 'py-1',
      method: 'sessions.dispatch',
      params: { message: 'hi' },
    })}\n`);
    await vi.waitFor(() => expect(broker.call).toHaveBeenCalledTimes(1));
    child.stdout.write(`${JSON.stringify({
      protocol: 'xdt-maker-script/1',
      type: 'complete',
      resultText: 'done',
    })}\n`);
    // 子进程已经正常退出,但 broker.call() 仍未 resolve——配置的 timeoutMs
    // 不该在这一步就失去保护(此前进入这段等待前就 clearTimeout 了)。
    child.emit('close', 0);

    await expect(resultPromise).rejects.toThrow('script execution timed out after 20ms');
    // 同 abort 场景:子进程已退出后超时只打断等待,不对可能已被复用的 pid 树杀。
    expect(killProcessTreeMock).not.toHaveBeenCalled();

    resolveCall({ ok: true });
  });

  it('drains an in-flight side-effecting call before surfacing a timeout terminal state (codex review 第八轮)', async () => {
    // 超时杀进程时脚本可能已发出 sessions.dispatch 这类写操作且 broker 尚未
    // resolve——不等它落地就抛终态,run 已记 failed、schedule 锁已释放,而副作用
    // 还在后台继续,下一轮触发可能与之并发。终态必须等在途调用(有界)收干净。
    const child = childProcess();
    spawnMock.mockReturnValue(child);
    let resolveCall: (value: unknown) => void = () => {};
    const broker = {
      call: vi.fn(() => new Promise((resolve) => { resolveCall = resolve; })),
    };
    const runner = new ScriptScheduleRunner({ broker, logger: {} });
    const baseSchedule = schedule();
    const resultPromise = runner.fire(
      { ...baseSchedule, scriptConfig: { ...baseSchedule.scriptConfig, timeoutMs: 20 } },
      { runId: 'run-1', firedAt: 1, signal: new AbortController().signal },
    );
    // 先挂 rejection handler,防 unhandled rejection 警告。
    const assertion = expect(resultPromise).rejects.toThrow('script execution timed out after 20ms');

    child.stdout.write(`${JSON.stringify({
      protocol: 'xdt-maker-script/1',
      type: 'call',
      id: 'py-1',
      method: 'sessions.dispatch',
      params: { message: 'hi' },
    })}\n`);
    await vi.waitFor(() => expect(broker.call).toHaveBeenCalledTimes(1));
    // 等真实 20ms 超时触发 killTree,再模拟进程被杀死后的 close。
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalled());
    child.emit('close', null);

    // 调用仍在途:终态不许先落。
    let settled = false;
    void resultPromise.catch(() => {}).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);

    resolveCall({ ok: true });
    await assertion;
  });

  it('caps the post-exit in-flight-call wait at a host deadline even without a configured timeoutMs (Greptile 五轮发现)', async () => {
    // timeoutMs 未配置(合法:不限时)时没有整轮 timer——子进程已退出、broker
    // 调用永不落地的话,这段等待若无自带截止时间,fire() 会占死 schedule 锁到
    // 重启(pause/delete 虽能救,但不该依赖人工干预)。
    vi.useFakeTimers();
    try {
      const child = childProcess();
      spawnMock.mockReturnValue(child);
      const broker = { call: vi.fn(() => new Promise(() => {})) }; // 永不落地
      const runner = new ScriptScheduleRunner({ broker, logger: {} });
      const resultPromise = runner.fire(schedule(), {
        runId: 'run-1',
        firedAt: 1,
        signal: new AbortController().signal,
      });

      child.stdout.write(`${JSON.stringify({
        protocol: 'xdt-maker-script/1',
        type: 'call',
        id: 'py-1',
        method: 'sessions.dispatch',
        params: { message: 'hi' },
      })}\n`);
      await vi.waitFor(() => expect(broker.call).toHaveBeenCalledTimes(1));
      child.stdout.write(`${JSON.stringify({
        protocol: 'xdt-maker-script/1',
        type: 'complete',
        resultText: 'done',
      })}\n`);
      child.emit('close', 0);
      const assertion = expect(resultPromise).rejects.toThrow(
        'host call did not settle within 30000ms after script exit',
      );

      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('decodes a multibyte UTF-8 character split across stdout chunks instead of corrupting it (codex review 第七轮)', async () => {
    // 中文字符在 UTF-8 下是 3 字节;故意把 chunk 边界切在字符中间,验证
    // StringDecoder 跨 chunk 维护状态、不产生替换字符(U+FFFD)。
    const child = childProcess();
    spawnMock.mockReturnValue(child);
    const runner = new ScriptScheduleRunner({ broker: { call: vi.fn() }, logger: {} });
    const resultPromise = runner.fire(schedule(), {
      runId: 'run-1',
      firedAt: 1,
      signal: new AbortController().signal,
    });

    const frame = Buffer.from(
      `${JSON.stringify({ protocol: 'xdt-maker-script/1', type: 'complete', resultText: '中文结果' })}\n`,
      'utf8',
    );
    // 切在"结"字(3 字节)中间——第一段含前 1 字节,第二段含剩余 2 字节。
    const splitAt = frame.indexOf(Buffer.from('结', 'utf8')) + 1;
    child.stdout.write(frame.subarray(0, splitAt));
    child.stdout.write(frame.subarray(splitAt));
    child.emit('close', 0);

    await expect(resultPromise).resolves.toEqual({ sessionId: '', resultText: '中文结果' });
  });

  it('rejects a call frame that arrives after complete (protocol violation)', async () => {
    const child = childProcess();
    spawnMock.mockReturnValue(child);
    const broker = { call: vi.fn(async () => ({ ok: true })) };
    const runner = new ScriptScheduleRunner({ broker, logger: {} });
    const resultPromise = runner.fire(schedule(), {
      runId: 'run-1',
      firedAt: 1,
      signal: new AbortController().signal,
    });

    child.stdout.write(`${JSON.stringify({ protocol: 'xdt-maker-script/1', type: 'complete', resultText: 'done' })}\n`);
    await vi.waitFor(() => expect(child.stdin.writable).toBe(false));
    child.stdout.write(`${JSON.stringify({
      protocol: 'xdt-maker-script/1', type: 'call', id: 'py-late', method: 'jira.get', params: {},
    })}\n`);
    child.emit('close', 1);

    await expect(resultPromise).rejects.toThrow('call frame received after complete');
    expect(broker.call).not.toHaveBeenCalled();
    expect(killProcessTreeMock).toHaveBeenCalled();
  });

  it('explains that plain stdout must be JSONL protocol frames and logs belong on stderr', async () => {
    const child = childProcess();
    spawnMock.mockReturnValue(child);
    const runner = new ScriptScheduleRunner({ broker: { call: vi.fn() }, logger: {} });
    const resultPromise = runner.fire(schedule(), {
      runId: 'run-1',
      firedAt: 1,
      signal: new AbortController().signal,
    });

    child.stdout.write('ordinary debug output\n');
    child.emit('close', 0);

    await expect(resultPromise).rejects.toThrow('script stdout must contain JSONL protocol frames only');
    await expect(resultPromise).rejects.toThrow('logs belong on stderr');
    expect(killProcessTreeMock).toHaveBeenCalled();
  });

  it('rejects protocol JSON with an unknown or missing frame type', async () => {
    const child = childProcess();
    spawnMock.mockReturnValue(child);
    const runner = new ScriptScheduleRunner({ broker: { call: vi.fn() }, logger: {} });
    const resultPromise = runner.fire(schedule(), {
      runId: 'run-1',
      firedAt: 1,
      signal: new AbortController().signal,
    });

    child.stdout.write(`${JSON.stringify({ protocol: 'xdt-maker-script/1', type: 'progress' })}\n`);
    child.emit('close', 0);

    await expect(resultPromise).rejects.toThrow(
      'invalid or missing type; expected "call" or "complete"',
    );
    expect(killProcessTreeMock).toHaveBeenCalled();
  });

  it('explains that a successful exit still requires a complete protocol frame', async () => {
    const child = childProcess();
    spawnMock.mockReturnValue(child);
    const runner = new ScriptScheduleRunner({ broker: { call: vi.fn() }, logger: {} });
    const resultPromise = runner.fire(schedule(), {
      runId: 'run-1',
      firedAt: 1,
      signal: new AbortController().signal,
    });

    child.emit('close', 0);

    await expect(resultPromise).rejects.toThrow('script exited without a complete frame');
  });

  it('kills immediately when the abort signal is already aborted before fire() attaches its listener (codex review #966)', async () => {
    const child = childProcess();
    spawnMock.mockReturnValue(child);
    const controller = new AbortController();
    controller.abort();
    const notifier = { notify: vi.fn(async () => {}) };
    const runner = new ScriptScheduleRunner({ broker: { call: vi.fn() }, logger: {}, notifier });
    const resultPromise = runner.fire(schedule(), { runId: 'run-1', firedAt: 1, signal: controller.signal });

    // killTree() → killProcessTree(win32 分支 spawn taskkill,mock 环境下走不到;
    // POSIX 分支 process.kill 大概率对 pid=123 失败)→ 最终回落 child.kill。
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalled());
    child.emit('close', null);
    await expect(resultPromise).rejects.toThrow('script execution aborted');
    // 用户主动 pause/delete 触发的中断不该发"失败"通知(codex review 发现);
    // engine 那侧会把这轮记成 'aborted',不是 runner 自己再发一次误导性通知。
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('arms the real force-settle timer for a pre-aborted signal, not the initial no-op (codex review 第三轮)', async () => {
    // 回归目标:pre-abort 分支曾在 exit-promise 的执行器(它才真正赋值
    // scheduleForceSettle)跑之前就调用了 killTree()——那一刻武装的还是最初的
    // no-op,1.5s 强制 settle 从未被真正挂上。这里模拟"kill 已经做完但平台没有
    // 触发 close"(不 emit 'close'),用假时钟推进 1.5s,只有 wiring 顺序正确、
    // 真实的 scheduleForceSettle 被调用时,resultPromise 才会 settle——否则挂起
    // 直到 vitest 测试超时,清楚地暴露回归。
    vi.useFakeTimers();
    try {
      const child = childProcess();
      spawnMock.mockReturnValue(child);
      const controller = new AbortController();
      controller.abort();
      const runner = new ScriptScheduleRunner({ broker: { call: vi.fn() }, logger: {} });
      const resultPromise = runner.fire(schedule(), { runId: 'run-1', firedAt: 1, signal: controller.signal });
      // 先挂上断言(attach rejection handler),再推进假时钟——避免 resultPromise
      // 在 advanceTimersByTimeAsync 内部就 reject、而此刻还没人 catch 触发
      // unhandled rejection 警告。
      const assertion = expect(resultPromise).rejects.toThrow('script execution aborted');

      await vi.advanceTimersByTimeAsync(1_500);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('still notifies failure for a genuine (non-abort) error', async () => {
    const child = childProcess();
    spawnMock.mockReturnValue(child);
    const notifier = { notify: vi.fn(async () => {}) };
    const runner = new ScriptScheduleRunner({ broker: { call: vi.fn() }, logger: {}, notifier });
    const resultPromise = runner.fire(schedule(), {
      runId: 'run-1',
      firedAt: 1,
      signal: new AbortController().signal,
    });

    child.emit('close', 1);
    await expect(resultPromise).rejects.toThrow('script exited with code 1');
    await vi.waitFor(() => expect(notifier.notify).toHaveBeenCalledTimes(1));
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('still notifies when a genuine failure message happens to contain the word "abort" (codex review 三次发现)', async () => {
    // 只认 ctx.signal.aborted 这个权威信号,不按错误文本猜——脚本自己的失败
    // stderr 恰好含 'abort' 字样(如某工具打印 "operation aborted")不代表这是
    // 我们的取消,按文本猜会把真实失败误吞成"已取消"、不通知用户。
    const child = childProcess();
    spawnMock.mockReturnValue(child);
    const notifier = { notify: vi.fn(async () => {}) };
    const runner = new ScriptScheduleRunner({ broker: { call: vi.fn() }, logger: {}, notifier });
    const resultPromise = runner.fire(schedule(), {
      runId: 'run-1',
      firedAt: 1,
      signal: new AbortController().signal, // 从未 abort
    });

    child.stderr.write('fatal: operation aborted by remote server\n');
    child.emit('close', 1);

    await expect(resultPromise).rejects.toThrow('script exited with code 1');
    await vi.waitFor(() => expect(notifier.notify).toHaveBeenCalledTimes(1));
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('does not crash when the script closes stdin before any frame is written (EPIPE, codex review #966)', async () => {
    // 典型场景:命令打错/脚本起了就死,host 首次 write(start 帧)前 stdin 已关闭。
    // Node 对零监听者的 EventEmitter 'error' 事件同步抛出——没有监听器时这里
    // 会直接炸穿 fire() 的 async 边界,而不是走 close/error 上报正常失败。
    const child = childProcess();
    spawnMock.mockReturnValue(child);
    const runner = new ScriptScheduleRunner({ broker: { call: vi.fn() }, logger: {} });
    const resultPromise = runner.fire(schedule(), {
      runId: 'run-1',
      firedAt: 1,
      signal: new AbortController().signal,
    });

    expect(() => child.stdin.emit('error', new Error('EPIPE'))).not.toThrow();

    child.emit('close', 1);
    await expect(resultPromise).rejects.toThrow('script exited with code 1');
  });

  it('drops an unknown script-reported primarySessionId instead of letting it hit the sessions FK (codex review 第九轮)', async () => {
    // schedule_runs.session_id 对 sessions.id 有外键——脚本笔误/编造的 id 会让
    // 引擎在 run 成功之后的落库环节撞 FK 炸掉整个收尾。查无此会话按"无会话"
    // 降级:run 照常 success,sessionId 为空串。
    const child = childProcess();
    spawnMock.mockReturnValue(child);
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([]) }),
        }),
      }),
    };
    const runner = new ScriptScheduleRunner({
      broker: { call: vi.fn() },
      logger: {},
      getDb: () => fakeDb as never,
    });
    const resultPromise = runner.fire(schedule(), {
      runId: 'run-1',
      firedAt: 1,
      signal: new AbortController().signal,
    });

    child.stdout.write(`${JSON.stringify({
      protocol: 'xdt-maker-script/1',
      type: 'complete',
      resultText: 'done',
      primarySessionId: 'sess-typo-does-not-exist',
    })}\n`);
    child.emit('close', 0);

    await expect(resultPromise).resolves.toEqual({ sessionId: '', resultText: 'done' });
  });

  it('keeps a script-reported primarySessionId that exists in the sessions table', async () => {
    const child = childProcess();
    spawnMock.mockReturnValue(child);
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([{ id: 'sess-real' }]) }),
        }),
      }),
    };
    const notifier = { notify: vi.fn(async () => undefined) };
    const onSessionBound = vi.fn(async () => undefined);
    const runner = new ScriptScheduleRunner({
      broker: { call: vi.fn() },
      logger: {},
      getDb: () => fakeDb as never,
      notifier,
    });
    const resultPromise = runner.fire(schedule(), {
      runId: 'run-1',
      firedAt: 1,
      signal: new AbortController().signal,
      onSessionBound,
    });

    child.stdout.write(`${JSON.stringify({
      protocol: 'xdt-maker-script/1',
      type: 'complete',
      resultText: 'done',
      primarySessionId: 'sess-real',
    })}\n`);
    child.emit('close', 0);

    await expect(resultPromise).resolves.toEqual({ sessionId: 'sess-real', resultText: 'done' });
    expect(onSessionBound).toHaveBeenCalledWith('sess-real');
    expect(onSessionBound.mock.invocationCallOrder[0]).toBeLessThan(
      notifier.notify.mock.invocationCallOrder[0],
    );
  });

  it('passes only a minimal non-secret environment to the script child', async () => {
    const child = childProcess();
    spawnMock.mockReturnValue(child);
    const runner = new ScriptScheduleRunner({ broker: { call: vi.fn() }, logger: {} });
    const resultPromise = runner.fire(schedule(), {
      runId: 'run-1',
      firedAt: 1,
      signal: new AbortController().signal,
    });

    child.stdout.write(`${JSON.stringify({
      protocol: 'xdt-maker-script/1',
      type: 'complete',
      resultText: 'done',
    })}\n`);
    child.emit('close', 0);

    await expect(resultPromise).resolves.toEqual({ sessionId: '', resultText: 'done' });
    const options = spawnMock.mock.calls[0]?.[1] as { env?: NodeJS.ProcessEnv };
    expect(options.env).toBeDefined();
    expect(options.env).not.toBe(process.env);
    expect(Object.keys(options.env ?? {})).not.toEqual(
      expect.arrayContaining(['XDT_TEST_TOKEN', 'ATLASSIAN_SECRET', 'API_KEY', 'AUTH_HEADER']),
    );
  });

  it('filters secret-looking names even if they are otherwise allowlisted env vars', () => {
    const env = buildScriptEnv({
      PATH: '/bin',
      HOME: '/home/user',
      USERPROFILE: 'C:\\Users\\X',
      APPDATA_TOKEN: 'secret',
      PATH_KEY: 'secret',
      XDT_TEST_TOKEN: 'secret',
      ATLASSIAN_SECRET: 'secret',
      API_KEY: 'secret',
      AUTH_HEADER: 'secret',
      RANDOM_SAFE: 'not-allowlisted',
    });

    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/home/user',
      USERPROFILE: 'C:\\Users\\X',
      // 新旧协议标记恒注入:Python 客户端凭它在 import 期做 fd 级 stdout 接管。
      CINDY_SCRIPT_PROTOCOL: '1',
      XDT_MAKER_SCRIPT_PROTOCOL: '1',
      // stdio 编码兜底:中文 Windows 上 Python pipe 默认 cp936,会撕坏 UTF-8 帧。
      PYTHONUTF8: '1',
    });
  });

  it('rejects script schedules without a local project workspace', async () => {
    const runner = new ScriptScheduleRunner({ broker: { call: vi.fn() }, logger: {} });
    await expect(
      runner.fire({ ...schedule(), workspaceKind: 'dialogue', workingDir: undefined }, {
        runId: 'run-1',
        firedAt: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('local project workspace');
    expect(spawnMock).not.toHaveBeenCalled();
  });

});
