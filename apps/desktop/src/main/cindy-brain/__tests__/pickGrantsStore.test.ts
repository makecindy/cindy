/**
 * pickGrantsStore.test.ts — 亲选目录台账的 normalize 单测。
 * 存储真身经 createOverrideSettingsFile 落 userData,依赖 electron;这里
 * 只测纯函数(坏形态清洗/归一化/去重/条数上限),记账与对账链路由
 * pickSlot 与 ghostErrandRunner 的测试覆盖。
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/never-used-here' } }));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

const { __testing, GRANTS_PER_GHOST } = await import('../pickGrantsStore');

describe('normalize(台账清洗)', () => {
  // §21 unit: the production storage normalizer must retain the native IO path
  // while comparing it with the existing slash-normalized pick record on Windows.
  it('保留 Windows 新目录引用，旧路径记录不自动生成引用', () => {
    const root = { ref: '00000000-0000-4000-8000-000000000001', path: 'C:\\projects\\chosen', dev: '1', ino: '2' };
    expect(__testing.normalize({ grants: { g1: ['C:/projects/chosen'] }, roots: { g1: [root] } }))
      .toEqual({ grants: { g1: ['C:/projects/chosen'] }, roots: { g1: [root] } });
    expect(__testing.normalize({ grants: { g1: ['C:/projects/chosen'] } })).toEqual({ grants: { g1: ['C:/projects/chosen'] } });
  });
  it('路径统一归一化存取:尾斜杠去掉,同目录不重复', () => {
    expect(
      __testing.normalize({
        grants: { g1: ['/proj/demo/', '/proj/demo', '/proj/other'] },
      }),
    ).toEqual({ grants: { g1: ['/proj/demo', '/proj/other'] } });
  });

  it('坏形态逐项丢弃:非字符串/空串/超长/整列表非数组', () => {
    expect(
      __testing.normalize({
        grants: {
          g1: ['', 42, 'x'.repeat(1025), '/ok'],
          g2: 'not-a-list',
          g3: [],
        },
      }),
    ).toEqual({ grants: { g1: ['/ok'] } });
    expect(__testing.normalize(null)).toEqual({ grants: {} });
    expect(__testing.normalize({ grants: 7 })).toEqual({ grants: {} });
  });

  it('每插件最多保留 GRANTS_PER_GHOST 条(读入时截断)', () => {
    const many = Array.from({ length: GRANTS_PER_GHOST + 3 }, (_, i) => `/proj/p${i}`);
    const out = __testing.normalize({ grants: { g1: many } });
    expect(out.grants.g1).toHaveLength(GRANTS_PER_GHOST);
    expect(out.grants.g1[0]).toBe('/proj/p0');
  });
});
