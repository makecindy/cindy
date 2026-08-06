/**
 * 崩溃判定与上传编号的锁。
 *
 * 崩溃判定的两条要点：
 *  - 「可恢复异常不算崩溃、渲染进程崩溃算」这条判据必须与 `lifecycle` 的 reason 口径一致
 *    ——所以这里同时对 `lifecycle.isFatalShutdownReason` 做等价性断言，两处判据漂移会红。
 *  - 尸检只认「无任何退出记录」两类；`crash-exit` / `shutdown-incomplete` 在崩溃当时已由
 *    lifecycle 写过标记，重复补会造成同一次崩溃上报两遍。
 */
import { describe, expect, it } from 'vitest';

import { isFatalShutdownReason } from '../../lifecycle';
import type { PreviousRunReportKind } from '../../startup-diagnostics';
import { UPLOAD_CODE_ALPHABET, isFormattedUploadCode } from '../../../shared/logUpload';
import {
  crashAtFromMarker,
  isFatalCrashReason,
  selectBackfillGrouping,
  shouldBackfillForReportKind,
} from '../crashTriggers';
import { generateUploadCode } from '../uploadCode';

describe('isFatalCrashReason', () => {
  it.each([
    ['uncaughtException', 'main 进程未捕获异常'],
    ['render-process-gone:crashed', '渲染进程崩溃（白屏）'],
    ['render-process-gone:oom', '渲染进程 OOM'],
  ])('%s 算崩溃（%s）', (reason) => {
    expect(isFatalCrashReason(reason)).toBe(true);
  });

  it.each([
    ['before-quit', '用户主动退出'],
    ['signal:SIGINT', 'Ctrl+C'],
    ['signal:SIGTERM', 'kill PID'],
    ['update-relaunch', '更新重启'],
    ['unhandledRejection', '悬空 promise —— 可恢复，绝不能误报'],
    ['some-future-exit-path', '未知 reason 一律不算崩溃'],
    ['', '空 reason'],
  ])('%s 不算崩溃（%s）', (reason) => {
    expect(isFatalCrashReason(reason)).toBe(false);
  });

  it('与 lifecycle 的判据逐条一致（两处漂移会让崩溃上报与退出尸检对不上）', () => {
    const reasons = [
      'uncaughtException',
      'render-process-gone:crashed',
      'render-process-gone:oom',
      'before-quit',
      'signal:SIGINT',
      'signal:SIGTERM',
      'update-relaunch',
      'unhandledRejection',
      'unknown',
      '',
    ];
    for (const reason of reasons) {
      expect(isFatalCrashReason(reason)).toBe(isFatalShutdownReason(reason));
    }
  });
});

describe('shouldBackfillForReportKind', () => {
  it.each<[PreviousRunReportKind, boolean, string]>([
    ['abnormal', true, 'run marker 停在 running = native crash / 外部 kill / hang'],
    ['corrupt', true, '标记写坏 = 进程死在写标记的瞬间'],
    ['crash-exit', false, '经过 lifecycle，崩溃当时已写过标记，重复补会上报两遍'],
    ['shutdown-incomplete', false, '同上'],
    ['clean', false, '正常退出'],
    ['still-running', false, '并存实例'],
  ])('%s → %s（%s）', (kind, expected) => {
    expect(shouldBackfillForReportKind(kind)).toBe(expected);
  });
});

describe('crashAtFromMarker', () => {
  it('优先 heartbeatAt（心跳冻结的时刻就是进程最后一次还活着）', () => {
    const ms = crashAtFromMarker({
      startedAt: '2026-08-04T10:00:00.000Z',
      heartbeatAt: '2026-08-04T12:34:56.000Z',
    });
    expect(ms).toBe(Date.parse('2026-08-04T12:34:56.000Z'));
  });

  it('没有 heartbeatAt 时退回 startedAt', () => {
    const ms = crashAtFromMarker({ startedAt: '2026-08-04T10:00:00.000Z' });
    expect(ms).toBe(Date.parse('2026-08-04T10:00:00.000Z'));
  });

  it('两者都取不到（或不可解析）返回 null，由调用方兜底', () => {
    expect(crashAtFromMarker(undefined)).toBeNull();
    expect(crashAtFromMarker({})).toBeNull();
    expect(crashAtFromMarker({ heartbeatAt: 'not-a-date' })).toBeNull();
  });
});

describe('selectBackfillGrouping', () => {
  const mk = (token: string, crashAtMs: number) => ({ marker: { token, crashAtMs } });

  it('⚠️ token 与 crashAtMs 取自同一个「最早」标记，不受 claimAll 的 readdir 顺序影响', () => {
    // readdir 顺序把较晚那次排在最前(claimed[0]),但最早崩溃是 t-early。
    const claimed = [mk('t-late', 2_000), mk('t-early', 1_000), mk('t-mid', 1_500)];
    const g = selectBackfillGrouping(claimed);
    // 修复前:crashToken 会取 claimed[0] = 't-late',与 crashAtMs=1_000 来自不同崩溃。
    expect(g).toEqual({ crashToken: 't-early', crashAtMs: 1_000 });
  });

  it('单个标记：原样返回它的 token 与 crashAtMs', () => {
    expect(selectBackfillGrouping([mk('only', 42)])).toEqual({
      crashToken: 'only',
      crashAtMs: 42,
    });
  });

  it('并列最早时取先出现的那个（稳定）', () => {
    const g = selectBackfillGrouping([mk('first', 1_000), mk('second', 1_000)]);
    expect(g).toEqual({ crashToken: 'first', crashAtMs: 1_000 });
  });

  it('空数组返回两个 undefined', () => {
    expect(selectBackfillGrouping([])).toEqual({
      crashToken: undefined,
      crashAtMs: undefined,
    });
  });
});

describe('generateUploadCode', () => {
  /** 固定字节序列的随机源，验证映射而不是碰运气。 */
  function fixedBytes(values: number[]): (size: number) => Uint8Array {
    let cursor = 0;
    return (size: number) => {
      const out = new Uint8Array(size);
      for (let i = 0; i < size; i += 1) {
        out[i] = values[cursor % values.length];
        cursor += 1;
      }
      return out;
    };
  }

  it('产出 XXXX-XXXX 形态', () => {
    const code = generateUploadCode(fixedBytes([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(isFormattedUploadCode(code)).toBe(true);
    expect(code).toHaveLength(9); // 8 位 + 一个连字符
  });

  it('只用去掉易混字符的字符集（用户要能口述）', () => {
    const code = generateUploadCode((size) => {
      const out = new Uint8Array(size);
      for (let i = 0; i < size; i += 1) out[i] = i * 7;
      return out;
    });
    for (const ch of code.replace('-', '')) {
      expect(UPLOAD_CODE_ALPHABET).toContain(ch);
    }
  });

  it('字符集里没有 0 / 1 / I / L / O / U', () => {
    for (const ch of '01ILOU') {
      expect(UPLOAD_CODE_ALPHABET).not.toContain(ch);
    }
  });

  it('丢弃越界字节后仍能凑满长度（rejection sampling 不会死循环）', () => {
    // 255 一定越界(limit = floor(256/30)*30 = 240),混入大量越界字节。
    const code = generateUploadCode(fixedBytes([255, 255, 255, 5]));
    expect(isFormattedUploadCode(code)).toBe(true);
  });

  it('真随机源下多次生成不重复（不是常量）', () => {
    const random = (size: number) => {
      const out = new Uint8Array(size);
      for (let i = 0; i < size; i += 1) out[i] = Math.floor(Math.random() * 256);
      return out;
    };
    const codes = new Set(Array.from({ length: 50 }, () => generateUploadCode(random)));
    expect(codes.size).toBeGreaterThan(40);
  });
});
