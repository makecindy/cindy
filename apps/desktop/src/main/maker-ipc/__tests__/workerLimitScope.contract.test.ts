import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
 * 最小失败输入：在发送 / 派发 / 唤醒 / 队列路径里读 `workerHardLimit` / `workerSoftLimit`
 * 并与占用数比较后拒绝发送。
 * tier: guard（跨文件契约）。
 *
 * 扫描边界为何是这三个目录：只有 main 进程能拒绝一次发送（发送锁与 durable 队列都在这里），
 * renderer 只是投影展示，`host-settings` / `shared` 是设置快照与目录声明。所以「读上限并据此
 * 拒绝」只能发生在这三个目录里；它们之外的引用不是发送闸。
 */

const MAIN_DIR = fileURLToPath(new URL('../..', import.meta.url)); // apps/desktop/src/main
const REPO_ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));

/**
 * 允许读取上限的地方，每条都必须写清职责。
 *
 * 新增合法读取时在这里登记理由；如果你只是要「还能建几个」，不要读这两个值，改为调用创建闸的
 * `workerCapacitySnapshot()`——那样不需要动这个清单。下面 `delegatesToSnapshot` 的用例守着
 * 这条替代路径确实有效。
 */
const REGISTRY: Record<string, string> = {
  'maker-ipc/orcaWorkerCreationService.ts': '创建闸：上限判定与容量快照的唯一落点',
  'maker-ipc/register.ts': '接线中心：设置 key 白名单与两条大小关系校验（逐行白名单见下）',
  'maker-host/collaboration-settings-store.ts': '设置存储：默认值、类型校验与上下界钳制',
  'lizi-mcps/src/xdt-helper/create_worker.ts': '只消费快照里的数字用于满载文案，不做判定',
  'lizi-mcps/src/xdt-helper/create_workers.ts': '只消费快照里的数字用于满载文案，不做判定',
};

const SCAN_DIRS = [
  { prefix: 'maker-ipc', dir: join(MAIN_DIR, 'maker-ipc') },
  { prefix: 'maker-host', dir: join(MAIN_DIR, 'maker-host') },
  { prefix: 'lizi-mcps/src/xdt-helper', dir: join(REPO_ROOT, 'packages/lizi-mcps/src/xdt-helper') },
];

/** `register.ts` 不能整文件放行，只允许这几行形态的读取。 */
const HUB_FILE = 'maker-ipc/register.ts';
const HUB_ALLOWED_LINE = [
  /^\s*'worker(?:Soft|Hard)Limit',\s*$/,
  /worker(?:Soft|Hard)Limit(?: must be (?:<=|>=) worker(?:Hard|Soft)Limit|' && next [<>] current\.worker(?:Hard|Soft)Limit)/,
];

const LIMIT_REFERENCE = /\bworker(?:Hard|Soft)Limit\b/;

/**
 * 去掉注释后再匹配：文档、注释里提到这两个名字不算读取。
 * 字符串字面量保留——`'workerHardLimit'` 这种设置 key 是真实引用，由逐行白名单裁决。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : sourceFiles(join(dir, entry.name));
    }
    return entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [];
  });
}

function readers(): string[] {
  return SCAN_DIRS.flatMap(({ prefix, dir }) =>
    sourceFiles(dir)
      .filter((file) => LIMIT_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))))
      .map((file) => `${prefix}/${relative(dir, file).replace(/\\/g, '/')}`),
  ).sort();
}

describe('worker limit scope', () => {
  it('reads the worker limits only in registered places', () => {
    const actual = readers();

    // 失败信息要能直接指导修复：新读者要么登记理由，要么改为消费容量快照。
    const unregistered = actual.filter((file) => !(file in REGISTRY));
    expect(unregistered, `未登记的上限读取：${unregistered.join(', ')}；请说明职责并登记到 REGISTRY，或改为调用 workerCapacitySnapshot()`).toEqual([]);

    const stale = Object.keys(REGISTRY).filter((file) => !actual.includes(file));
    expect(stale, `登记表里的文件已不再读取上限：${stale.join(', ')}；请从 REGISTRY 删除`).toEqual([]);
  });

  it('registers a reason for every reader', () => {
    const missing = Object.entries(REGISTRY)
      .filter(([, reason]) => reason.trim().length === 0)
      .map(([file]) => file);
    expect(missing).toEqual([]);
  });

  it('confines the hub to settings projection and validation lines', () => {
    const offending = readFileSync(join(MAIN_DIR, 'maker-ipc/register.ts'), 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        LIMIT_REFERENCE.test(stripComments(line)) && !HUB_ALLOWED_LINE.some((allowed) => allowed.test(line))
          ? [`${HUB_FILE}:${index + 1}: ${line.trim()}`]
          : [],
      );

    expect(offending).toEqual([]);
  });

  it('offers a way to read capacity without registering a new reader', () => {
    // 创建闸导出的快照函数是唯一替代路径；它不在就不成立，登记表也就没有出路。
    const gate = readFileSync(join(MAIN_DIR, 'maker-ipc/orcaWorkerCreationService.ts'), 'utf8');
    expect(gate).toMatch(/export function workerCapacitySnapshot\b/);
    expect(existsSync(join(MAIN_DIR, 'maker-ipc/orcaWorkerCreationService.ts'))).toBe(true);
  });
});
