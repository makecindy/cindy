import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => 'test', getPath: () => '' },
}));

import { RECORD_FORMAT_SENTINEL_MSG } from '../../shared/mainLogRecordFormat';

// #10790: 跨天后当天的日志文件 0 字节一整天,原因是落盘失败被整段吞掉 ——
// 流被置空后再没人开新的,谁也看不出是磁盘满了还是文件被锁。
// 这里钉住三件事:失败原因要留下(健康自检 + stderr)、失败期间不要每条日志都重开流、
// 退避窗口之后要能自己恢复,并把格式哨兵补回当天文件的最前面(读侧只看第 0 字节)。
it('surfaces why the daily log stopped writing and recovers on the next retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-log-failure-'));
  const stderr: string[] = [];
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
    fs.rmSync(root, { recursive: true, force: true });
  }
});
