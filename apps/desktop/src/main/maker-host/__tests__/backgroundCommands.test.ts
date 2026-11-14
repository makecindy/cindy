/**
 * backgroundCommands.test.ts —— 后台命令服务的完成回注契约。
 *
 * 测试价值
 * - 生产入口与可观察结果:createBackgroundCommandService.start 用真实子进程跑
 *   shell 命令;命令退出后宿主通过 enqueueReport(scheduler 撞忙排队桥)收到
 *   「后台命令完成」报告 —— 退出码语义、日志尾部、投递 origin 是本功能的
 *   核心对外契约,坏了等于回调通道静默失灵。
 * - Bug/规则依据:新能力(工程规则 docs/dev-rules/engineering-conventions.md
 *   §3.2);契约 = 完成必报、退出码正确、每 run 只报一次。
 * - 现有覆盖缺口:新模块,无既有覆盖。
 * - 最小失败输入:退出码非 0 且带输出的短命令;启动参数缺失;不存在 cwd。
 * - tier:unit(真实短命子进程 + 临时目录,无网络/DB)。
 * - 最小失败输入还包括：持续输出超过 5MB 上限的命令（验体量巡检杀树 + 文件有界）、
 *   输出超过 64KB 尾窗的命令（验报告尾部取自文件末尾，长输出的结论不丢）；
 *   日志目录不可建（验拒绝启动不静默无日志）；命令退出后名额立即让出（2026-11-13
 *   事故：win32 名额占到硬顶，秒死命令堵满全局 8 槽），治理计时器不随名额失效。
 * - 最小失败输入还包括：默认 bash 在 Windows 上必须落 Git Bash 而非 WSL（2026-11-14
 *   口径事故回归：旧实现 spawn(shell:true) 落 cmd，裸 bash 解析到 WSL，前台能跑的
 *   命令后台必死）；shell=powershell 时命令由 PowerShell 解释（EncodedCommand 免
 *   转义）。shell 菜单与前台 bash/powershell 工具同源。
 * - 最小失败输入还包括：受理宽限窗内退出的命令（秒败/短命令）——结果作为工具结果
 *   同步返回且不再回注（2026-11-14 回投时机收口：病态短尾巴走前台语义，秒败不占
 *   轮次），窗口后仍运行的转后台照旧回注。
 * - 实测耗时：本机 < 30s（16 用例，含 5MB 输出用例、名额让出等待、宽限窗（同步完成/超限/超时）与两个 shell 用例）。
 */

import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  BACKGROUND_COMMAND_LOG_CAP_BYTES,
  BACKGROUND_COMMAND_MAX_CONCURRENT,
  createBackgroundCommandService,
  type BackgroundCommandServiceDeps,
} from '../background-commands.js';

const noopLogger = { info: () => {}, warn: () => {} };

let logDir: string;

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'bg-cmd-test-'));
});

afterEach(async () => {
  await rm(logDir, { recursive: true, force: true });
});

function buildService(
  capture: ReturnType<typeof vi.fn>,
  resolveLogDir?: () => string,
  depsOverride?: Partial<BackgroundCommandServiceDeps>,
) {
  // 用例自带实现时不覆盖(如 retry 序列);裸 vi.fn() 才兑默认成功实现。
  if (capture.getMockImplementation() === undefined) {
    capture.mockImplementation(async () => ({ clientId: 'c1' }));
  }
  // 服务实例终身绑定创建时的目录:生产里一个实例就是一个账号的目录,孤儿巡检
  // 不能随模块级可变变量漂移到别的目录(否则会截掉在其它用例中在册的日志)。
  const boundLogDir = resolveLogDir ? null : logDir;
  const deps: BackgroundCommandServiceDeps = {
    // 排队桥的最小形状:成功受理即返 clientId。
    enqueueReport: capture,
    resolveLogDir: resolveLogDir ?? (boundLogDir ? () => boundLogDir : () => logDir),
    logger: noopLogger,
    // 默认窄宽限窗：绝大多数用例走「仍运行的转后台」路径；宽限窗同步路径由
    // 专门用例注入大窗验证。
    startGraceMs: 60,
    ...depsOverride,
  };
  return createBackgroundCommandService(deps);
}

function firstReport(capture: ReturnType<typeof vi.fn>) {
  expect(capture).toHaveBeenCalledTimes(1);
  return capture.mock.calls[0][0] as {
    sessionId: string;
    text: string;
    persistedContent: string;
    origin: { kind: string; scheduleId: string; scheduleName: string };
    inheritTargetPlanMode?: boolean;
  };
}

it('命令退出后回注一次完成报告:退出码、日志尾部、scheduler origin', async () => {
  const capture = vi.fn();
  const service = buildService(capture);
  const result = await service.start({
    sessionId: 'sess-1',
    // 活过宽限窗（buildService 默认 60ms）：走后台路径，报告照旧回注。
    command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => { console.log('gate-output-line'); process.exit(3) }, 500)"`,
    cwd: logDir,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('start should succeed');
  expect(result.completed).toBeUndefined();

  await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  const report = firstReport(capture);
  expect(report.sessionId).toBe('sess-1');
  expect(report.text).toContain('失败（exit 3）');
  expect(report.text).toContain('gate-output-line');
  expect(report.text).toContain('完整日志：');
  expect(report.persistedContent).toContain('后台命令完成');
  expect(report.origin).toMatchObject({ kind: 'scheduler', scheduleName: '后台命令' });
  expect(report.origin.scheduleId).toMatch(/^bgcmd:bg-/);
  expect(report.inheritTargetPlanMode).toBe(true);
  // 日志文件真实存在且含命令输出。
  const logText = await readFile((result as { ok: true; logPath: string }).logPath, 'utf8');
  expect(logText).toContain('gate-output-line');
  // 报告即名额让出：命令退出后并发名额立即回收，秒死命令不再堵住新命令
  // （2026-11-13 事故回归：旧口径 win32 名额占到硬顶，全局 8 槽被死命令堵满）。
  // 治理不随名额走：POSIX 组探测照旧等树死透，win32 硬顶计时器照旧到点留痕。
  expect(service.runningCount()).toBe(0);
});

it('受理宽限窗：窗口内退出的命令结果同步返回，不再回注（秒败不占轮次）', async () => {
  const capture = vi.fn();
  // 大宽限窗：node 启动远快于窗口，必走同步路径。
  const service = buildService(capture, undefined, { startGraceMs: 2_000 });
  const failed = await service.start({
    sessionId: 'sess-grace',
    command: `${JSON.stringify(process.execPath)} -e "console.log('grace-out'); process.exit(3)"`,
    cwd: logDir,
  });
  if (!failed.ok || !failed.completed) throw new Error('expected in-grace completion');
  expect(failed.completed.code).toBe(3);
  expect(failed.completed.tail).toContain('grace-out');
  expect(failed.completed.timedOut).toBe(false);
  // 工具结果即报告：不再有「后台命令完成」回注；名额随 exit 即时让出。
  expect(capture).not.toHaveBeenCalled();
  expect(service.runningCount()).toBe(0);
});

it('受理宽限窗内被体量巡检杀树：同步结果带 outputCapped，不回注', async () => {
  const capture = vi.fn();
  const service = buildService(capture, undefined, { startGraceMs: 2_000 });
  // 写 6MB 后挂住:capPoll(500ms)看到超限杀树,exit 落在宽限窗内。
  const result = await service.start({
    sessionId: 'sess-grace-cap',
    command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(6 * 1024 * 1024)); setInterval(() => {}, 10_000)"`,
    cwd: logDir,
  });
  if (!result.ok || !result.completed) throw new Error('expected in-grace completion');
  expect(result.completed.outputCapped).toBe(true);
  expect(result.completed.code === 0).toBe(false);
  expect(result.completed.tail.length).toBeGreaterThan(0);
  // 同步消费即报告：不再回注。
  expect(capture).not.toHaveBeenCalled();
});

it('受理宽限窗内被超时硬顶杀树：timedOut 原因随同步结果带回，不回注', async () => {
  const capture = vi.fn();
  const service = buildService(capture, undefined, { startGraceMs: 2_000 });
  const result = await service.start({
    sessionId: 'sess-grace-timeout',
    command: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 10_000)"`,
    cwd: logDir,
    timeoutMs: 300,
  });
  // 最小失败输入：超时硬顶的 exit 也走同一条 settle 通道——
  // timedOut 硬编码 false 会把超时原因吞成普通失败（2026-11-14 review 回归）。
  if (!result.ok || !result.completed) throw new Error('expected in-grace completion');
  expect(result.completed.timedOut).toBe(true);
  expect(result.completed.outputCapped).toBe(false);
  expect(result.completed.code === 0).toBe(false);
  // 同步消费即报告：不再回注。
  expect(capture).not.toHaveBeenCalled();
});

it('秒死命令不堵名额：满额退出后第 9 条立即起得来（2026-11-13 事故回归）', async () => {
  const capture = vi.fn();
  const service = buildService(capture);
  // 活过宽限窗的命令：运行期占名额，退出即让出。
  const start = () =>
    service.start({
      sessionId: 'sess-1',
      command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => process.exit(0), 1500)"`,
      cwd: logDir,
    });
  const receipts = await Promise.all(
    Array.from({ length: BACKGROUND_COMMAND_MAX_CONCURRENT }, () => start()),
  );
  for (const receipt of receipts) {
    if (!receipt.ok) throw new Error('start should succeed');
    expect(receipt.completed).toBeUndefined();
  }
  // 满额运行中：第 9 条 TOO_MANY_RUNS（旧口径在这里也会拒绝，但名额要到硬顶才释放）。
  const ninth = await start();
  expect(ninth).toMatchObject({ ok: false, errorCode: 'TOO_MANY_RUNS' });
  // 满额全部退出回注后，名额应全部让出：下一条立即起得来
  // （旧口径 win32 在这里仍直接拒绝）。
  await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(BACKGROUND_COMMAND_MAX_CONCURRENT), {
    timeout: 15_000,
  });
  const next = await start();
  expect(next.ok).toBe(true);
  // 第 9 条也等它退出回注:子进程 cwd 在临时目录里,不等会让 afterEach 清目录时
  // 撞 win32 的 EBUSY。
  await vi.waitFor(
    () => expect(capture).toHaveBeenCalledTimes(BACKGROUND_COMMAND_MAX_CONCURRENT + 1),
    { timeout: 15_000 },
  );
});

it('名额让出后治理仍在：win32 硬顶到点留痕，POSIX 组探测等树死透', async () => {
  const warn = vi.fn();
  const capture = vi.fn();
  const service = buildService(capture, undefined, { logger: { info: () => {}, warn } });
  await service.start({
    sessionId: 'sess-1',
    command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => process.exit(0), 500)"`,
    cwd: logDir,
    timeoutMs: 1_000,
  });
  await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  // 名额已让出；治理条目仍在：win32 到硬顶留痕（杀树对已退出命令是空操作，
  // 只做日志与整体移除）；POSIX 探测到树死透后整体移除，不再有到点留痕。
  expect(service.runningCount()).toBe(0);
  if (process.platform === 'win32') {
    await vi.waitFor(
      () => expect(warn).toHaveBeenCalledWith(expect.stringContaining('hard cap reached'), expect.anything()),
      { timeout: 10_000 },
    );
  }
});

it('队列暂停 retry 不按次数丢弃:退避轮询直到投递成功', async () => {
  // 前 12 次返回 retry(超过旧上限 10 次 = 暂停超 10 分钟),之后恢复受理:
  // 回归 Greptile P1——暂停中的队列会持续 retry,报告必须等恢复后投出去。
  // 注入恒定 1ms 间隔(首间隔与封顶配套),13 次调用总真实等待 <100ms。
  let calls = 0;
  const capture = vi.fn(async () => {
    calls += 1;
    return calls <= 12 ? ({ retry: true } as const) : { clientId: 'c1' };
  });
  const service = buildService(capture, undefined, {
    reportRetryDelayMs: 1,
    reportRetryMaxDelayMs: 1,
  });
  const result = await service.start({
    sessionId: 'sess-1',
    command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => process.exit(0), 500)"`,
    cwd: logDir,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('start should succeed');
  expect(result.completed).toBeUndefined();
  await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(13), { timeout: 10_000 });
  const last = capture.mock.settledResults[12];
  expect(last.type).toBe('fulfilled');
  expect((last.value as { clientId?: string }).clientId).toBe('c1');
});

it('exit 0 报成功;空命令直接拒绝且不回注', async () => {
  const capture = vi.fn();
  const service = buildService(capture);

  const okRun = await service.start({
    sessionId: 'sess-2',
    command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => process.exit(0), 500)"`,
    cwd: logDir,
  });
  expect(okRun.ok).toBe(true);
  await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  expect(firstReport(capture).text).toContain('成功（exit 0）');

  await expect(service.start({ sessionId: 's', command: '   ', cwd: logDir })).resolves.toMatchObject({
    ok: false,
    errorCode: 'INVALID_ARGS',
  });
  // 拒绝路径不产生任何回注。
  expect(capture).toHaveBeenCalledTimes(1);
});

it('桌面键鼠模拟命令直接拒绝且不 spawn（与 Bash PreToolUse 守卫同一判定）', async () => {
  const capture = vi.fn();
  const service = buildService(capture);

  const blocked = await service.start({
    sessionId: 'sess-desktop-input',
    command: "osascript -e 'tell application \"System Events\" to keystroke \"x\"'",
    cwd: logDir,
  });
  expect(blocked).toMatchObject({ ok: false, errorCode: 'DESKTOP_INPUT_BLOCKED' });
  // 拒绝发生在 spawn 之前:同步断言即可。
  expect(capture).not.toHaveBeenCalled();
});

it('超上限的输出:体量巡检杀树,文件有界,报告标记超限(fd 直写后无转写截断)', async () => {
  const capture = vi.fn();
  const service = buildService(capture);
  const result = await service.start({
    sessionId: 'sess-3',
    // 每 20ms 写 256KB:一个 500ms 巡检周期内越限,杀树后文件有界。
    command: `${JSON.stringify(process.execPath)} -e "setInterval(() => process.stdout.write('x'.repeat(256 * 1024)), 20)"`,
    cwd: logDir,
  });
  expect(result.ok).toBe(true);

  await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1), { timeout: 30_000 });
  const report = firstReport(capture);
  // 杀树不是成功退出:报告必须说明超限被终止。
  expect(report.text).toContain('输出超过');
  expect(report.text).toContain('终止');
  expect(report.text).not.toContain('成功（exit 0）');
  const logPath = (result as { ok: true; logPath: string }).logPath;
  const { stat: statFile } = await import('node:fs/promises');
  const info = await statFile(logPath);
  // 杀树时越限写仍在途:巡检间隔 + kill 落地延迟内的在途写入都算越冲。CI 上
  // 实测过 3×cap(调度抖动让 500ms 巡检晚到),上界给 5×cap —— 体量上限是护栏,
  // 只保证「写不穿磁盘」的量级,不是字节级合同。
  expect(info.size).toBeGreaterThan(BACKGROUND_COMMAND_LOG_CAP_BYTES);
  expect(info.size).toBeLessThan(BACKGROUND_COMMAND_LOG_CAP_BYTES * 5);
});

it('长输出命令:报告尾部取自文件末尾,结论行不丢(fd 直写后无内存尾部)', async () => {
  const capture = vi.fn();
  const service = buildService(capture);
  const result = await service.start({
    sessionId: 'sess-tail',
    // 10000 行 ≈ 110KB,超过 64KB 尾窗:验证尾部读的是文件末尾而非开头。
    // 显式延后输出:命令活过 60ms 宽限窗,确定走后台回注路径(不依赖子进程快慢)。
    command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => { for(let i=1;i<=10000;i++)console.log('line-'+String(i).padStart(5,'0'));console.log('final-tail-line') }, 300)"`,
    cwd: logDir,
  });
  expect(result.ok).toBe(true);

  await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1), { timeout: 30_000 });
  const report = firstReport(capture);
  expect(report.text).toContain('final-tail-line');
  expect(report.text).toContain('line-10000');
  // 头部行已被尾窗裁掉:报告里不该再出现第一行。
  expect(report.text).not.toContain('line-00001');
});

it('日志目录建不出来:拒绝启动且不回注', async () => {
  const capture = vi.fn();
  // resolveLogDir 指向一个已存在的「文件」:mkdirSync(recursive) 必抛,服务应拒绝
  // 启动而不是静默跑一条无日志的命令。
  const blocker = path.join(logDir, 'not-a-dir');
  await writeFile(blocker, 'x');
  const service = buildService(capture, () => blocker);

  const result = await service.start({
    sessionId: 'sess-log-fail',
    command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
    cwd: logDir,
  });
  expect(result).toMatchObject({ ok: false, errorCode: 'LOG_FAILED' });
  // 拒绝发生在 spawn 之前,回注不可能被触发;同步断言即可,无需真实等待。
  expect(capture).not.toHaveBeenCalled();
});

it('dispose(账号边界):释放并发名额、丢弃在途报告、拒绝新启动', async () => {
  // 切号后旧账号的运行不能占住名额(新账号 TOO_MANY_RUNS),报告也不能落进新账号。
  const capture = vi.fn();
  const service = buildService(capture);
  const started = await service.start({
    sessionId: 'sess-boundary',
    command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => process.exit(0), 30_000)"`,
    cwd: logDir,
  });
  expect(started).toMatchObject({ ok: true });
  expect(service.runningCount()).toBe(1);

  service.dispose();
  expect(service.runningCount()).toBe(0);
  // 名额已清:同实例再 start 被拒(生产里切号后是重建单例,这里验旧实例不可复用)。
  const again = await service.start({
    sessionId: 'sess-boundary',
    command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
    cwd: logDir,
  });
  expect(again).toMatchObject({ ok: false, errorCode: 'DISPOSED' });

  // 被杀的命令不会再回注报告。这里必须等真实的退出事件传播（kill 是异步的），
  // 用不到 fake timers；报告链自身还有 grace timer，短窗口不可靠。
  // real-wait: 验证「被杀进程的退出回调不再触发投递」需要真实等待窗口。
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(capture).not.toHaveBeenCalled();
}, 10_000);

it('重启后孤儿日志:巡检把不在册的超限日志截回上限(体量兜底随服务存活)', async () => {
  // 模拟重启后的孤儿:fd 直写进程不在任何注册表里(与真实孤儿形态一致)。
  const orphanLog = path.join(logDir, 'bg-orphan-sim.log');
  const fd = openSync(orphanLog, 'a');
  const writer = spawn(
    process.execPath,
    ['-e', "setInterval(() => process.stdout.write('x'.repeat(512 * 1024)), 50)"],
    { stdio: ['ignore', fd, fd] },
  );
  // 新服务实例 = 重启后的空注册表;巡检由本用例 start() 启动(因果必须自建,
  // 不能賍同文件其它用例泄漏的模块级 poll)。
  const service = buildService(vi.fn());
  await service.start({
    sessionId: 'sess-orphan',
    command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
    cwd: logDir,
  });
  // 先让日志真超过上限,否则起步阶段的小文件就能满足下界断言、截断根本没被验证。
  await vi.waitFor(
    async () => {
      const { size } = await stat(orphanLog);
      expect(size).toBeGreaterThan(BACKGROUND_COMMAND_LOG_CAP_BYTES);
    },
    { timeout: 20_000, interval: 500 },
  );
  await vi.waitFor(
    async () => {
      const { size } = await stat(orphanLog);
      // 10MB/s 写者 × 1s 巡检:上界 = cap + 一个巡检周期的越冲,不可能写穿。
      expect(size).toBeLessThan(BACKGROUND_COMMAND_LOG_CAP_BYTES + 15 * 1024 * 1024);
    },
    { timeout: 20_000, interval: 500 },
  );
  writer.kill();
  closeSync(fd);
}, 40_000);

const isWindows = process.platform === 'win32';

(isWindows ? it : it.skip)('默认 bash 落在 Git Bash 而非 WSL(2026-11-14 口径事故回归)', async () => {
  const capture = vi.fn();
  // 大宽限窗：bash 启动远快于窗口，走同步路径——尾部直接可断言，不等回注。
  const service = buildService(capture, undefined, { startGraceMs: 2_000 });
  const result = await service.start({ sessionId: 'sess-bash', command: 'uname -s', cwd: logDir });
  if (!result.ok || !result.completed) throw new Error('expected in-grace completion');
  // Git Bash 的 uname 是 MINGW*；WSL 里是 Linux——这条就是「后台口径与前台 bash
  // 工具同源」的可观察判据。同步消费即报告：不再回注。
  expect(result.completed.tail).toContain('MINGW');
  expect(result.completed.code).toBe(0);
  expect(capture).not.toHaveBeenCalled();
});

(isWindows ? it : it.skip)('shell=powershell:命令由 PowerShell 解释,退出码与输出如实回注', async () => {
  const capture = vi.fn();
  const service = buildService(capture);
  const result = await service.start({
    sessionId: 'sess-ps',
    shell: 'powershell',
    // EncodedCommand 通道:分号/引号不经 Node argv 转义,写什么执行什么。
    command: 'Write-Output ps-shell-line; exit 3',
    cwd: logDir,
  });
  expect(result.ok).toBe(true);

  await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  expect(firstReport(capture).text).toContain('失败（exit 3）');
  const logText = await readFile((result as { ok: true; logPath: string }).logPath, 'utf8');
  expect(logText).toContain('ps-shell-line');
});
