/**
 * 测试价值
 * - 生产入口与可观察结果：lastOwnerActivityAt（伙伴例行任务前置检查 stdin 的 ownerActiveAt）只把主人本人发起、
 *   伙伴已答完的轮次算作对话；自动输入、任务回执、私下回复、群专线、IM 里非主人的消息都不算。它决定默认夜间学习
 *   这次是否调用模型。
 * - Bug／规则依据：docs/product-rules/bot-routines.md「夜间学习例行任务」；口径沿用旧版夜间学习计数器
 *   （随专用实现一起删除，原测试不再覆盖）。
 * - 现有覆盖缺口：前置检查测试只验证比较脚本，不验证这个时间怎么来。
 * - 最小失败输入：最近一页全是自动续跑时返回了它们的时间；满页后漏看更早一页的主人轮次；不是伙伴专线却返回时间。
 * - tier：unit（数据库查询为内存替身，按真实查询的游标参数倒序分页返回）。
 */
import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ botId: 'bot' as string | null, rows: [] as Array<Record<string, unknown>>, cursors: [] as unknown[] }));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('routine-owner-activity-lane')) return h.botId ? [{ botId: h.botId }] : [];
      h.cursors.push(params[1]);
      return h.rows.filter((row) => (row.createdAt as number) < (params[1] as number))
        .sort((a, b) => (b.createdAt as number) - (a.createdAt as number)).slice(0, 200);
    }),
  }),
}));

import { lastOwnerActivityAt } from '../ownerActivity.js';

const reply = (createdAt: number, input: { text?: string; meta?: object }, extra: { role?: string; meta?: object } = {}) => ({
  createdAt,
  role: extra.role ?? 'canonical',
  meta: JSON.stringify({ turnCompleted: true, ...extra.meta }),
  inputId: `u-${createdAt}`,
  inputContent: JSON.stringify({ text: input.text ?? 'hello' }),
  inputMeta: JSON.stringify(input.meta ?? {}),
});

beforeEach(() => { h.botId = 'bot'; h.rows = []; h.cursors = []; });

it.each([
  ['an automatic continuation', reply(1, { meta: { origin: { kind: 'scheduler' } } })],
  ['a host task receipt', reply(1, { text: '[UI_ACTION_TRIGGER][任务回执] 后台任务已完成。' })],
  ['a private reply', reply(1, {}, { meta: { botPrivateReply: true } })],
  ['a group lane reply', reply(1, {}, { meta: { botGroupLane: true } })],
  ['an IM message from someone other than the owner', reply(1, { meta: { imSource: { userText: 'hi', origin: { sender: { isOwner: false } } } } }, { role: 'channel' })],
  ['an empty input', reply(1, { text: '   ' })],
])('does not count %s as owner activity', async (_label, row) => {
  h.rows = [row];
  expect(await lastOwnerActivityAt('lane')).toBeUndefined();
});

it('returns the latest owner turn, reading past a full page of automatic input', async () => {
  h.rows = [
    reply(10, { text: 'please remember this' }),
    ...Array.from({ length: 200 }, (_, i) => reply(100 + i, { meta: { origin: { kind: 'scheduler' } } })),
  ];
  expect(await lastOwnerActivityAt('lane')).toBe(10);
  expect(h.cursors).toEqual([Number.MAX_SAFE_INTEGER, 100]);
});

it('gives no time for a session that is not a teammate lane', async () => {
  h.botId = null;
  h.rows = [reply(10, {})];
  expect(await lastOwnerActivityAt('task')).toBeUndefined();
});
