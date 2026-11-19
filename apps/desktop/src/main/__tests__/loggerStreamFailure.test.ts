import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => 'test', getPath: () => '' },
}));

import { RECORD_FORMAT_SENTINEL_MSG } from '../../shared/mainLogRecordFormat';

// logger 在模块顶层就把 origStderr 绑成了「当时那个 process.stderr.write」(第一个用例挂上的
// spy),之后的用例再 spyOn 只会包在它外面,拿不到它的输出。所以共用一个收集数组,
// 每个用例开头清空,按用例隔离。
const stderr: string[] = [];

// 文件级 fixture(#10907 review P1):initLogger 是一次性入口(`if (initialized) return`),
// 同一文件的用例共享同一个 logger 实例与同一个 logDir —— 逐用例 mkdtemp 再传进 initLogger
// 只会静默 no-op,还会让 sessionAgentSlot 的 mkdir 把第一个用例删掉的根目录**重建**出来,
// 每跑一次泄漏一份 `cindy-log-*/sessions/{s-stale-ts,s-backoff}`。
// 因此:根目录只建一次,由 initLogger(第一个用例,见下)使用,afterAll 统一删;用例之间用
// 不同 sessionId 与清空 stderr 数组隔离,谁也不再各自 rmSync。
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-log-failure-'));
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// #10790: 跨天后当天的日志文件 0 字节一整天,原因是落盘失败被整段吞掉 ——
// 流被置空后再没人开新的,谁也看不出是磁盘满了还是文件被锁。
// 这里钉住三件事:失败原因要留下(健康自检 + stderr)、失败期间不要每条日志都重开流、
// 退避窗口之后要能自己恢复,并把格式哨兵补回当天文件的最前面(读侧只看第 0 字节)。
it('surfaces why the daily log stopped writing and recovers on the next retry', async () => {
  stderr.length = 0;
  // 必须在 logger 模块加载前挂上:logger 在模块顶层就绑定了原始 stderr.write。
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  const mainWritten: string[] = [];
  let failing = true;
  const open = vi.spyOn(fs, 'createWriteStream').mockImplementation((file) => {
    const isMain = String(file).endsWith('.log');
    const stream = new Writable({
      write(chunk, _encoding, done) {
        if (isMain && failing) {
          done(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
          return;
        }
        if (isMain) mainWritten.push(String(chunk));
        done();
      },
    });
    process.nextTick(() => stream.emit('open'));
    return stream as fs.WriteStream;
  });
  try {
    const { createLogger, getLogStreamHealth, initLogger } = await import('../logger.js');
    // 本文件唯一一次 initLogger(一次性入口):main/agent 流在这一步就被打开,所以它必须留在
    // **第一个**用例里、排在本用例的 failing mock 之后 —— 放进文件级 beforeAll 会让初始流
    // 落到默认 mock 上,后面的 ENOSPC 失败就再也触发不了。后续用例共享这个实例与这个 logDir。
    initLogger({ isDev: false, level: 'trace', logDir: root });
    await vi.waitFor(() => expect(getLogStreamHealth().main.lastFailure?.code).toBe('ENOSPC'));

    // 失败原因要看得见:根因(ENOSPC)进 stderr,健康自检能查到。
    expect(stderr.join('')).toContain('ENOSPC');
    expect(getLogStreamHealth().main.active).toBe(false);

    // 失败期间不要每条日志都重开一次流(失败机器上会把 open 系统调用刷爆)。
    const opensAfterFailure = open.mock.calls.length;
    for (let i = 0; i < 5; i++) createLogger('probe').info(`dropped ${i}`);
    expect(open.mock.calls.length).toBe(opensAfterFailure);

    // 退避窗口之后自己恢复:重开流、把哨兵补回第 0 字节、日志继续落盘。
    failing = false;
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(1_100);
      createLogger('probe').info('after recovery');
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
    expect(open.mock.calls.length).toBe(opensAfterFailure + 1);
    expect(getLogStreamHealth().main.active).toBe(true);
    expect(getLogStreamHealth().main.lastFailure).toBeNull();
    expect(mainWritten[0]).toContain(RECORD_FORMAT_SENTINEL_MSG);
    expect(mainWritten.some((line) => line.includes('after recovery'))).toBe(true);
  } finally {
    open.mockRestore();
    // 根目录交给文件级 afterAll 统一删:在用例里删会让后续用例的 sessionAgentSlot mkdir
    // 把它重建出来(#10907 review P1 的泄漏路径)。
  }
});

// #10907 评审意见(1): ensureDailySlot 拿记录自带的时间戳去比重试窗口,而 nextRetryAt 是按
// 墙上时钟设的。cc-debug 的原始行带的是它自己的时刻,tailer 重试同一批旧行时时间戳停在原地 ——
// 即使磁盘已经恢复,那一行也永远越不过重试期限,还会挡住后面的日志。
//
// 测试价值
// - 生产入口与可观察结果:writeCcDebugLine(cc 子进程 debug 行汇入 agent 流的入口)重试一条
//   时间戳停在「今天本地 00:00」的旧行时,退避窗口一过就要重新开流、把内容写进去。
//   可观察结果 = createWriteStream 调用次数 +1 且内容进入文件。
// - Bug/规则依据:上游 #10907 的 P1 —— nextRetryAt(墙上时钟)与 now.getTime()(记录时刻)混用。
// - 现有覆盖缺口:本文件只覆盖 main 纯文本流,且所有写入都用「当前时刻」,没有任何用例让
//   记录自带一个早于 nextRetryAt 的时间戳。
// - 最小失败输入:ENOSPC 失败一次 → 等过 1s 退避窗口 → 用同一行(时间戳不动)重试。
// - tier:unit(fs / electron mock + 假时钟)。
it('lets a record that carries an old timestamp past the retry window', async () => {
  const SESSION = 's-stale-ts';
  stderr.length = 0;
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  const written: string[] = [];
  let failing = true;
  const open = vi.spyOn(fs, 'createWriteStream').mockImplementation((file) => {
    const stream = new Writable({
      write(chunk, _encoding, done) {
        if (String(file).endsWith('.ndjson') && failing) {
          done(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
          return;
        }
        written.push(String(chunk));
        done();
      },
    });
    process.nextTick(() => stream.emit('open'));
    return stream as fs.WriteStream;
  });
  try {
    const { writeCcDebugLine } = await import('../logger.js');
    // 不再各自 initLogger(一次性入口,这里是静默 no-op)也不再各自 mkdtemp:共享第一个用例
    // 的根目录与实例,隔离靠 sessionId = s-stale-ts。

    // 今天本地 00:00 —— 保证与 slot 的 dateKey 同一天(只按日期取 key),但远早于 nextRetryAt。
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const staleLine = `${midnight.toISOString()} [debug] [cc] stale line\n`;

    writeCcDebugLine(staleLine, SESSION);
    await vi.waitFor(() => expect(stderr.join('')).toContain('ENOSPC'));
    const opensAfterFailure = open.mock.calls.length;
    expect(written.join('')).not.toContain('stale line');

    failing = false;
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(1_100);
      writeCcDebugLine(staleLine, SESSION);
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
    expect(open.mock.calls.length).toBe(opensAfterFailure + 1);
    expect(written.join('')).toContain('stale line');
  } finally {
    open.mockRestore();
    // 根目录由文件级 afterAll 统一删(见文件头注释)。
  }
});

// #10907 评审意见(2): 退避与失败去重状态在 stream 的 'open' 上复位。ENOSPC 时 open 照样
// 成功、写才失败,于是持续写失败期间退避永远停在 1 秒、同一个错误每一轮重刷一遍 stderr,
// 健康自检还会把「写不进去」报成健康。
//
// 测试价值
// - 生产入口与可观察结果:writeCcDebugLine 连续多轮写失败时,可观察结果是
//   (a) 重开流的次数由退避窗口决定(而不是每条日志一次),(b) 失败原因按签名去重、不随重开
//   重复上报,(c) 第一轮失败排定的 2s 窗口在只过了 1.5s 时不放行。
// - Bug/规则依据:上游 #10907 的 P2 —— 复位判据用错事件。
// - 现有覆盖缺口:本文件只验证「失败期间不重开」与「窗口过后恢复一次」,没有验证多轮连续
//   失败之间退避是否真的在增长、失败原因是否被重复上报。
// - 最小失败输入:ENOSPC 持续三轮,每轮之间只推进各自的退避窗口。
// - tier:unit(fs / electron mock + 假时钟)。
it('keeps growing the backoff and reports a persistent failure only once', async () => {
  const SESSION = 's-backoff';
  stderr.length = 0;
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  const written: string[] = [];
  // open 永远成功、写永远失败:ENOSPC 的典型形态(磁盘满了文件照样打得开)。
  const open = vi.spyOn(fs, 'createWriteStream').mockImplementation((file) => {
    const stream = new Writable({
      write(_chunk, _encoding, done) {
        if (String(file).endsWith('.ndjson')) {
          done(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
          return;
        }
        done();
      },
    });
    process.nextTick(() => stream.emit('open'));
    return stream as fs.WriteStream;
  });
  try {
    const { writeCcDebugLine } = await import('../logger.js');
    // 共享第一个用例的根目录与实例,隔离靠 sessionId = s-backoff。
    const round = async (text: string): Promise<void> => {
      writeCcDebugLine(text, SESSION);
      await vi.advanceTimersByTimeAsync(0);
    };

    const line = `${new Date().toISOString()} [debug] [cc] never lands\n`;
    writeCcDebugLine(line, SESSION);
    await vi.waitFor(() => expect(stderr.join('')).toContain('ENOSPC'));
    const opensAfterFirst = open.mock.calls.length;
    expect(written.join('')).not.toContain('never lands');

    vi.useFakeTimers();
    try {
      // 第一轮失败排定 1s 窗口;过窗口后重开流、写仍失败,窗口翻倍到 2s。
      await vi.advanceTimersByTimeAsync(1_100);
      await round(line);
      expect(open.mock.calls.length).toBe(opensAfterFirst + 1);

      // 只过了 1.5s:旧实现在 open 成功时把退避复位成 1s,这里就会放行重开。
      await vi.advanceTimersByTimeAsync(1_500);
      await round(line);
      expect(open.mock.calls.length).toBe(opensAfterFirst + 1);

      // 满 2s 后才放行,于是再失败时窗口翻倍到 4s。
      await vi.advanceTimersByTimeAsync(600);
      await round(line);
      expect(open.mock.calls.length).toBe(opensAfterFirst + 2);
    } finally {
      vi.useRealTimers();
    }

    // 三轮下来只重开了两次流(退避说了算,不是每条日志一次);失败原因按「阶段+错误码+消息」
    // 去重,所以只有两行:第一次错误早于 'open' 事件到达,记成 open 阶段;重开成功后写仍失败,
    // 记成 write 阶段。第三轮起同一个签名不再重复 —— 旧实现在 open 上清空去重状态,这里会刷出 4 行。
    expect(open.mock.calls.length).toBe(opensAfterFirst + 2);
    expect(stderr.join('').match(/ENOSPC/g)?.length ?? 0).toBe(2);
  } finally {
    open.mockRestore();
    // 根目录由文件级 afterAll 统一删(见文件头注释)。
  }
});
