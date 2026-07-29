/**
 * hook-control bindings 单测: os.tmpdir 临时文件(规则 23: 测试路径一律走系统
 * 临时目录, 收尾清理)。重点是「只存 externalKey -> sessionId」这条不变量 ——
 * 绑定里不留任何授权状态, 能否复用每次由 dispatcher 现场按工作目录映射判定。
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
const readFile = (): Record<string, Record<string, Record<string, unknown>>> =>
  JSON.parse(fs.readFileSync(filePath(), 'utf-8')) as Record<
    string,
    Record<string, Record<string, unknown>>
  >;

describe('hook binding store', () => {
  it('落绑定后 get 读得回, 未知 key 为 null', () => {
    const store = makeStore();
    store.set('conn-1', 'slack:C1:1.1', 'sess-1');

    expect(store.get('conn-1', 'slack:C1:1.1')).toBe('sess-1');
    expect(store.get('conn-1', 'missing')).toBeNull();
    expect(store.get('conn-2', 'slack:C1:1.1')).toBeNull();
  });

  it('跨实例持久化(app 重启后同 key 仍指同一 session)', () => {
    makeStore().set('conn-1', 'k', 'sess-1');

    expect(makeStore().get('conn-1', 'k')).toBe('sess-1');
  });

  it('行里只写 sessionId + updatedAt, 不写任何授权状态', () => {
    makeStore().set('conn-1', 'k', 'sess-2');

    expect(Object.keys(readFile()['conn-1']['k']).sort()).toEqual(['sessionId', 'updatedAt']);
  });

  it('早期版本残留的 workingDir / authority 读取时忽略, 下次写入清掉', () => {
    fs.writeFileSync(
      filePath(),
      JSON.stringify({
        'conn-1': {
          k: {
            sessionId: 'legacy',
            workingDir: '/repos/demo',
            authority: 'local-move',
            updatedAt: 1,
          },
        },
      }),
      'utf-8',
    );
    const store = makeStore();

    expect(store.get('conn-1', 'k')).toBe('legacy');
    store.set('conn-1', 'k', 'legacy');
    expect(readFile()['conn-1']['k']).not.toHaveProperty('workingDir');
    expect(readFile()['conn-1']['k']).not.toHaveProperty('authority');
  });

  it('命名空间被损坏成非对象时不卡死写入(换成空命名空间重建)', () => {
    fs.writeFileSync(filePath(), JSON.stringify({ 'conn-1': 'oops', 'conn-2': [1, 2] }), 'utf-8');
    const store = makeStore();

    expect(store.get('conn-1', 'k')).toBeNull();
    expect(store.get('conn-2', 'k')).toBeNull();
    expect(() => store.remove('conn-1', 'k')).not.toThrow();

    store.set('conn-1', 'k', 'sess-1');
    expect(store.get('conn-1', 'k')).toBe('sess-1');
    // 另一个坏命名空间不受影响, 直到它自己被写入时才重建
    store.set('conn-2', 'k', 'sess-2');
    expect(store.get('conn-2', 'k')).toBe('sess-2');
  });

  it('externalKey 是 __proto__ 之类的键时不污染原型', () => {
    const store = makeStore();
    store.set('conn-1', '__proto__', 'sess-evil');

    // 写进去的是自有键, 不是原型
    expect(({} as Record<string, unknown>).sessionId).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(store.get('conn-1', '__proto__')).toBe('sess-evil');
    // 普通键不受影响, 且没被原型上的东西串味
    expect(store.get('conn-1', 'constructor')).toBeNull();

    store.set('conn-1', 'normal', 'sess-1');
    expect(store.get('conn-1', 'normal')).toBe('sess-1');
    expect(store.get('conn-1', '__proto__')).toBe('sess-evil');
  });

  it('remove 清掉整条绑定', () => {
    const store = makeStore();
    store.set('conn-1', 'k', 'sess-1');
    store.remove('conn-1', 'k');

    expect(store.get('conn-1', 'k')).toBeNull();
  });
});
