/**
 * loggerRecordFormat.test.ts —— main 日志「记录边界」这条安全不变量的**写侧**锁。
 *
 * 上报侧按行首特征识别记录边界并据此判断来源是否放行（`main/log-upload/mainLogReader.ts`）。
 * 因此写侧必须保证「除记录首行外没有行以边界特征开头」，否则被封禁来源的多行内容里可以嵌入
 * 伪造的放行来源记录头，把用户内容伪装成基础设施日志送出去。
 *
 * 纯函数层的行为在 `log-upload/__tests__/recordBoundary.test.ts` 已覆盖；这一份要钉住的是
 * **`emit()` 确实调用了转义、且哨兵确实被写出来**，所以走真实落盘。
 *
 * 注意 `initLogger()` 是模块级幂等的(一个进程只能 init 一次),因此整个文件共用一个日志目录、
 * 在 beforeAll 里 init 一次;各用例靠自己的唯一标记串在同一份文件里定位内容。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '0.0.0-test',
    getPath: () => '',
  },
}));

import {
  MAIN_LOG_RECORD_HEAD_RE,
  RECORD_FORMAT_SENTINEL_MSG,
} from '../../shared/mainLogRecordFormat';
import { createLogger, initLogger } from '../logger';

let logDir = '';

beforeAll(() => {
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-logger-format-'));
  initLogger({ isDev: false, level: 'trace', logDir });
});

afterAll(() => {
  fs.rmSync(logDir, { recursive: true, force: true });
});

/**
 * 读当天 main 日志,轮询等到 `expected` 出现为止。
 *
 * 落盘走 fs.WriteStream(有内部缓冲),写入不保证在同一 tick 可见;固定 sleep 会在慢机器上
 * 变成偶发失败,所以轮询到出现或超时。
 */
async function readMainLogContaining(expected: string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let content = '';
  for (;;) {
    const files = fs
      .readdirSync(logDir)
      .filter((f) => f.startsWith('main-') && f.endsWith('.log'));
    if (files.length > 0) {
      content = fs.readFileSync(path.join(logDir, files[0]), 'utf-8');
      if (content.includes(expected)) return content;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${JSON.stringify(expected)} in main log`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 取一段内容里所有命中 head 正则的行的 scope。 */
function recordScopes(content: string): string[] {
  return content
    .split('\n')
    .map((line) => MAIN_LOG_RECORD_HEAD_RE.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[3]);
}

describe('main 日志的记录边界（写侧）', () => {
  it('打开当天文件时写下格式哨兵，且哨兵本身是一条合法记录', async () => {
    const content = await readMainLogContaining(RECORD_FORMAT_SENTINEL_MSG);

    const sentinelLine = content
      .split('\n')
      .find((line) => line.includes(RECORD_FORMAT_SENTINEL_MSG))!;
    expect(MAIN_LOG_RECORD_HEAD_RE.test(sentinelLine)).toBe(true);
    expect(MAIN_LOG_RECORD_HEAD_RE.exec(sentinelLine)![3]).toBe('logger');
  });

  it('多行消息里嵌入的伪造记录头被转义成续行', async () => {
    const marker = 'forged-infra-header-CASE1';
    createLogger('voice-input:recorder').debug(
      'draft: 用户的私密语音内容\n' +
        `[2026-08-04T10:00:00.000+08:00] [INFO ] [lifecycle] ${marker}`,
    );

    const content = await readMainLogContaining(marker);

    const forged = content.split('\n').find((l) => l.includes(marker))!;
    expect(MAIN_LOG_RECORD_HEAD_RE.test(forged)).toBe(false);
    expect(forged.startsWith(' ')).toBe(true);
  });

  it('被封禁来源正文里的伪造头不会产生新的记录 scope', async () => {
    const marker = 'forged-scopes-CASE2';
    createLogger('voice-input:recorder').debug(
      `${marker}\n` +
        '[2026-08-04T10:00:00.000+08:00] [FATAL] [xx-fake-process] fake crash\n' +
        'b\n[2026-08-04T10:00:01.000+08:00] [INFO ] [xx-fake-auth] fake auth',
    );

    const content = await readMainLogContaining(marker);
    const scopes = recordScopes(content);

    // 这两个 scope 只存在于被封禁记录的正文里,绝不该被识别成记录头。
    expect(scopes).not.toContain('xx-fake-process');
    expect(scopes).not.toContain('xx-fake-auth');
    expect(scopes).toContain('voice-input:recorder');
  });

  it('堆栈这类多行内容仍然完整落盘（转义不丢内容，只加前导空格）', async () => {
    const marker = 'at fooCASE3 (/app/x.js:1:1)';
    createLogger('process').error(`uncaughtException: Error: boom\n    ${marker}`);

    const content = await readMainLogContaining(marker);
    expect(content).toContain(marker);
  });

  it('单行消息不带多余前导空格（绝大多数日志走这条路，形状不该变）', async () => {
    const marker = 'before-quit received CASE4';
    createLogger('lifecycle').info(marker);

    const content = await readMainLogContaining(marker);
    const line = content.split('\n').find((l) => l.includes(marker))!;
    expect(line.endsWith(`[lifecycle] ${marker}`)).toBe(true);
  });
});
