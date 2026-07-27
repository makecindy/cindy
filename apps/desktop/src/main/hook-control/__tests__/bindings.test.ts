/**
 * hook-control bindings 单测: os.tmpdir 临时文件(规则 23: 测试路径一律走系统
 * 临时目录, 收尾清理)。重点是工作目录快照的写入与老文件兼容 —— dispatcher 靠
 * 它区分「会话被用户移动」与「工作目录映射被改」。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHookBindingStore } from '../bindings';

const noopLog = { warn: () => {} };

let dir: string;
const filePath = (): string => path.join(dir, 'hook-bindings.json');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-bindings-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const makeStore = () => createHookBindingStore({ filePath: filePath(), log: noopLog });

describe('hook binding store', () => {
  it('落绑定时记下工作目录快照与授权来源, get / getEntry 都能读回', () => {
    const store = makeStore();
    store.set('conn-1', 'slack:C1:1.1', 'sess-1', '/repos/demo', 'workspace');

    expect(store.get('conn-1', 'slack:C1:1.1')).toBe('sess-1');
    expect(store.getEntry('conn-1', 'slack:C1:1.1')).toEqual({
      sessionId: 'sess-1',
      workingDir: '/repos/demo',
      authority: 'workspace',
    });
    expect(store.getEntry('conn-1', 'missing')).toBeNull();
  });

  it('local-move 授权跨实例持久化(重启后跟随不能退回撤权)', () => {
    makeStore().set('conn-1', 'k', 'sess-1', '/repos/moved', 'local-move');

    expect(makeStore().getEntry('conn-1', 'k')).toEqual({
      sessionId: 'sess-1',
      workingDir: '/repos/moved',
      authority: 'local-move',
    });
  });

  it('未传目录 / 授权时不写这两个字段', () => {
    makeStore().set('conn-1', 'k', 'sess-2');
    const row = JSON.parse(fs.readFileSync(filePath(), 'utf-8')) as Record<
      string,
      Record<string, Record<string, unknown>>
    >;

    expect(row['conn-1']['k']).not.toHaveProperty('workingDir');
    expect(row['conn-1']['k']).not.toHaveProperty('authority');
    expect(makeStore().getEntry('conn-1', 'k')).toEqual({
      sessionId: 'sess-2',
      workingDir: null,
      authority: null,
    });
  });

  it('老文件(无 workingDir / authority)读成 null, 不当成"目录变过"或"已授权"', () => {
    fs.writeFileSync(
      filePath(),
      JSON.stringify({ 'conn-1': { 'slack:C1:1.1': { sessionId: 'legacy', updatedAt: 1 } } }),
      'utf-8',
    );
    const store = makeStore();

    expect(store.get('conn-1', 'slack:C1:1.1')).toBe('legacy');
    expect(store.getEntry('conn-1', 'slack:C1:1.1')).toEqual({
      sessionId: 'legacy',
      workingDir: null,
      authority: null,
    });
  });

  it('authority 是未知字面量时按"没有授权记录"读(fail closed)', () => {
    fs.writeFileSync(
      filePath(),
      JSON.stringify({
        'conn-1': {
          k: {
            sessionId: 'sess-1',
            workingDir: '/repos/demo',
            authority: 'anything',
            updatedAt: 1,
          },
        },
      }),
      'utf-8',
    );

    expect(makeStore().getEntry('conn-1', 'k')?.authority).toBeNull();
  });

  it('remove 清掉整条绑定(含快照与授权)', () => {
    const store = makeStore();
    store.set('conn-1', 'k', 'sess-1', '/repos/demo', 'local-move');
    store.remove('conn-1', 'k');

    expect(store.getEntry('conn-1', 'k')).toBeNull();
  });
});
