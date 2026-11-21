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
 * 最小失败输入：在发送 / 派发 / 唤醒 / 队列模块里读 `workerHardLimit` / `workerSoftLimit`。
 * tier: guard（跨文件契约）。
 */

/** 创建闸：上限判定与快照唯一合法的落点，整个文件放行。 */
const GATE_FILE = 'orcaWorkerCreationService.ts';

/**
 * `register.ts` 是发送 / 派发 / 唤醒的接线中心，不能整文件放行，只允许这几行形态的读取：
 * 设置 key 白名单、两条 soft/hard 大小关系校验。容量投影（占用数 → 剩余）已收进创建闸的
 * `workerCapacitySnapshot`，所以这里连 `readCollaborationSettings().workerHardLimit` 都不再放行：
 * 任何新形态（尤其是拿占用数与上限比大小后拒绝发送）都会落到白名单外。
 */
const HUB_FILE = 'register.ts';
const HUB_ALLOWED_LINE = [
  /^\s*'worker(?:Soft|Hard)Limit',\s*$/,
  /worker(?:Soft|Hard)Limit(?: must be (?:<=|>=) worker(?:Hard|Soft)Limit|' && next [<>] current\.worker(?:Hard|Soft)Limit)/,
];

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
  it('reads the worker limits only in the creation gate', () => {
    const readers = sourceFiles(MAKER_IPC_DIR)
      .filter((file) => LIMIT_REFERENCE.test(readFileSync(file, 'utf8')))
      .map((file) => relative(MAKER_IPC_DIR, file))
      .sort();

    expect(readers).toEqual([HUB_FILE, GATE_FILE].sort());
  });

  it('confines the hub to settings projection and validation lines', () => {
    const offending = readFileSync(join(MAKER_IPC_DIR, HUB_FILE), 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        LIMIT_REFERENCE.test(line) && !HUB_ALLOWED_LINE.some((allowed) => allowed.test(line))
          ? [`${HUB_FILE}:${index + 1}: ${line.trim()}`]
          : [],
      );

    expect(offending).toEqual([]);
  });
});
