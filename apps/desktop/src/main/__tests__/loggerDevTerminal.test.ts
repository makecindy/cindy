/**
 * loggerDevTerminal.test.ts — dev 终端镜像的限长规则(2026-07 卡顿修复)。
 *
 * 背景:dev 日志级别默认 trace,agent 高并发时超长 debug 行(曾经的每请求
 * 64KiB body dump)会整行镜像到终端,Windows console 消费极慢导致内核缓冲
 * 持续堆积、util.format/拷贝压满 main event loop。修复后镜像行截断到 8KiB
 * (文件日志不受影响),write() 背压时暂停镜像等 drain。
 * 背压状态机依赖真实 stream 的 drain 事件,不适合脱离进程单测;这里锁死
 * 可纯化的截断规则。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '0.0.0-test',
    getPath: () => '',
  },
}));

import { resolveInitialLogLevel, truncateDevTerminalLine } from '../logger';

describe('truncateDevTerminalLine(dev 终端镜像限长)', () => {
  it('短行原样透传(不加任何后缀)', () => {
    const line = '[ts] [INFO ] [scope] hello\n';
    expect(truncateDevTerminalLine(line)).toBe(line);
  });

  it('恰好 8KiB 的行不截断', () => {
    const line = 'x'.repeat(8 * 1024);
    expect(truncateDevTerminalLine(line)).toBe(line);
  });

  it('超长行截断到 8KiB 并追加提示(含原始长度),行尾保住换行', () => {
    const line = 'y'.repeat(64 * 1024) + '\n';
    const out = truncateDevTerminalLine(line);
    expect(out.length).toBeLessThan(9 * 1024);
    expect(out.startsWith('y'.repeat(8 * 1024))).toBe(true);
    expect(out).toContain(`terminal mirror truncated, ${line.length} chars`);
    expect(out.endsWith('\n')).toBe(true);
  });
});

// 测试价值
// - 生产入口与可观察结果：resolveInitialLogLevel 是 initLogger 唯一的级别来源，决定 dev 构建写多少日志。
// - 依据：个人版每次更新换一份新 checkout，只读 checkout 里的 log-config.json 时，用户在数据目录定的
//   info 级别不生效，dev 默认 trace 让一台机器 6 小时写出 30 万行日志并全部镜像到终端。
// - 最小失败输入：dev、checkout 无配置、<userData>/log-config.json = info → 旧实现得到 trace。
// - tier：unit，临时目录。
describe('resolveInitialLogLevel(启动日志级别)', () => {
  const dirs: string[] = [];
  const dirWith = (level?: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-log-level-'));
    dirs.push(dir);
    if (level) fs.writeFileSync(path.join(dir, 'log-config.json'), JSON.stringify({ level }));
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    { name: 'dev 只有数据目录配置 → 用数据目录的', checkout: undefined, userData: 'info', env: undefined, expected: 'info' },
    { name: 'dev checkout 配置优先于数据目录', checkout: 'debug', userData: 'info', env: undefined, expected: 'debug' },
    { name: 'LOG_LEVEL 仍最优先', checkout: 'debug', userData: 'info', env: 'warn', expected: 'warn' },
    { name: 'dev 两处都没有 → trace', checkout: undefined, userData: undefined, env: undefined, expected: 'trace' },
  ])('$name', ({ checkout, userData, env, expected }) => {
    expect(resolveInitialLogLevel({
      envLevel: env,
      isDev: true,
      configDirs: [dirWith(checkout), dirWith(userData)],
    })).toBe(expected);
  });

  it('packaged 只读数据目录，默认 info', () => {
    expect(resolveInitialLogLevel({ envLevel: undefined, isDev: false, configDirs: [dirWith()] })).toBe('info');
  });
});
