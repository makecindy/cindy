/**
 * 测试价值
 * - 生产入口与可观察结果：hasOwnerActivitySince（例行任务 requireOwnerActivity 的判定）只把主人本人发起、
 *   伙伴已答完的轮次算作新对话；自动输入、私下回复、群专线、IM 里非主人的消息和合成触发都不算，
 *   结果直接决定这次定时运行是否调用模型。
 * - Bug／规则依据：docs/product-rules/bot-routines.md「只在主人有新对话时运行」；口径沿用旧版夜间学习计数器
 *   （随专用实现一起删除，原测试不再覆盖）。
 * - 现有覆盖缺口：routines/service 的测试替换了这个模块，只验证跳过与派发两条分支。
 * - 最小失败输入：一页里只有自动续跑、任务回执、非主人 IM 消息时误判为有新对话；满页后漏看下一页的主人轮次。
 * - tier：unit（数据库查询为内存替身，按真实查询的游标参数返回分页结果）。
 */
import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, queries: [] as unknown[][] }));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    query: vi.fn(async (_sql: string, params: unknown[]) => {
      h.queries.push(params);
      return h.rows.filter((row) => (row.createdAt as number) > (params[1] as number)).slice(0, 200);
    }),
  }),
}));

import { hasOwnerActivitySince } from '../ownerActivity.js';

const reply = (createdAt: number, input: { text?: string; meta?: object }, extra: { role?: string; meta?: object } = {}) => ({
  createdAt,
  role: extra.role ?? 'canonical',
  meta: JSON.stringify({ turnCompleted: true, ...extra.meta }),
  inputId: `u-${createdAt}`,
  inputContent: JSON.stringify({ text: input.text ?? 'hello' }),
  inputMeta: JSON.stringify(input.meta ?? {}),
});

beforeEach(() => { h.rows = []; h.queries = []; });

it.each([
  ['an automatic continuation', reply(1, { meta: { origin: { kind: 'scheduler' } } })],
  ['a host task receipt', reply(1, { text: '[UI_ACTION_TRIGGER][任务回执] 后台任务已完成。' })],
  ['a private reply', reply(1, {}, { meta: { botPrivateReply: true } })],
  ['a group lane reply', reply(1, {}, { meta: { botGroupLane: true } })],
  ['an IM message from someone other than the owner', reply(1, { meta: { imSource: { userText: 'hi', origin: { sender: { isOwner: false } } } } }, { role: 'channel' })],
  ['an empty input', reply(1, { text: '   ' })],
])('does not count %s as owner activity', async (_label, row) => {
  h.rows = [row];
  expect(await hasOwnerActivitySince('bot', 0)).toBe(false);
});

it('finds an owner turn on a later page after a full page of automatic input', async () => {
  h.rows = [
    ...Array.from({ length: 200 }, (_, i) => reply(i + 1, { meta: { origin: { kind: 'scheduler' } } })),
    reply(500, { text: 'please remember this' }),
  ];
  expect(await hasOwnerActivitySince('bot', 0)).toBe(true);
  expect(h.queries.map((params) => params[1])).toEqual([0, 200]);
});
