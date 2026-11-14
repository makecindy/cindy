import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 上限只约束「新建」。
 *
 * Bug 依据：满载（worker 数达 hard limit）时用户仍必须能与既有 worker 交互——桌面直发 /
 * steer、手机远程、运行设备 agent、Lead 派发、唤醒与预热。这些入口一旦开始查上限，用户消息
 * 会被静默排队或直接失败。
 *
 * 覆盖缺口：没有测试固定「上限判定只在创建闸里被读」。
 * 最小失败输入：在任意发送 / 派发 / 唤醒 / 队列模块里读 `workerHardLimit` / `workerSoftLimit`。
 * tier: guard（跨文件契约）。
 */

// 允许读上限的两处：创建闸本身，以及把设置投影给界面的 IPC 层（只读不判）。
const ALLOWED = new Set(['orcaWorkerCreationService.ts', 'register.ts']);

const MAKER_IPC_DIR = fileURLToPath(new URL('..', import.meta.url));
const LIMIT_REFERENCE = /worker(?:Hard|Soft)Limit/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : sourceFiles(join(dir, entry.name));
    }
    return entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [];
  });
}

describe('worker limit scope', () => {
  it('reads the worker limits only where workers are created', () => {
    const readers = sourceFiles(MAKER_IPC_DIR)
      .filter((file) => LIMIT_REFERENCE.test(readFileSync(file, 'utf8')))
      .map((file) => relative(MAKER_IPC_DIR, file))
      .sort();

    expect(readers).toEqual([...ALLOWED].sort());
  });
});
