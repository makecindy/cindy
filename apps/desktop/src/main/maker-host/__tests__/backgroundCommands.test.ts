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
 * - 实测耗时:见 PR 描述(本机 < 5s)。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  BACKGROUND_COMMAND_LOG_CAP_BYTES,
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

function buildService(capture: ReturnType<typeof vi.fn>) {
  const deps: BackgroundCommandServiceDeps = {
    // 排队桥的最小形状:成功受理即返 clientId。
    enqueueReport: capture.mockImplementation(async () => ({ clientId: 'c1' })),
    resolveLogDir: () => logDir,
    logger: noopLogger,
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
  const result = service.start({
    sessionId: 'sess-1',
    command: `${JSON.stringify(process.execPath)} -e "console.log('gate-output-line'); process.exit(3)"`,
    cwd: logDir,
  });
  expect(result.ok).toBe(true);

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
  expect(service.runningCount()).toBe(0);
});

it('exit 0 报成功;空命令直接拒绝且不回注', async () => {
  const capture = vi.fn();
  const service = buildService(capture);

  const okRun = service.start({
    sessionId: 'sess-2',
    command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
    cwd: logDir,
  });
  expect(okRun.ok).toBe(true);
  await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  expect(firstReport(capture).text).toContain('成功（exit 0）');

  expect(service.start({ sessionId: 's', command: '   ', cwd: logDir })).toMatchObject({
    ok: false,
    errorCode: 'INVALID_ARGS',
  });
  // 拒绝路径不产生任何回注。
  expect(capture).toHaveBeenCalledTimes(1);
});

it('超上限的输出:文件截断到上限,完成报告仍带最后的输出(内存尾部)', async () => {
  const capture = vi.fn();
  const service = buildService(capture);
  const overshoot = BACKGROUND_COMMAND_LOG_CAP_BYTES + 1024;
  const result = service.start({
    sessionId: 'sess-3',
    // 分两段写:先写满超限的垃圾,再写结论行 —— 验证内存尾部保留的是最后的输出。
    command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(${overshoot})); console.log('final-line-after-cap')"`,
    cwd: logDir,
  });
  expect(result.ok).toBe(true);

  await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1), { timeout: 30_000 });
  const report = firstReport(capture);
  expect(report.text).toContain('final-line-after-cap');
  const logPath = (result as { ok: true; logPath: string }).logPath;
  const { stat: statFile } = await import('node:fs/promises');
  const info = await statFile(logPath);
  // 头部保留 + 截断标记行,不能超过上限太多。
  expect(info.size).toBeLessThanOrEqual(BACKGROUND_COMMAND_LOG_CAP_BYTES + 256);
  const head = await readFile(logPath, 'utf8');
  expect(head.startsWith('x')).toBe(true);
  expect(head).toContain('[log truncated at');
}, 60_000);
