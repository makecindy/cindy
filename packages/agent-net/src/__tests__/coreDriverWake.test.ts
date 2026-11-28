/**
 * 生产入口：`@cindy/agent-net-core/node` 的 `wakePlan`，Node 驱动 `Endpoint.armTimer` 每一轮都用它决定怎么等核心的下一次唤醒
 * （Desktop 的 Agent-Net 线程、Node Host、压测都跑这个驱动）。
 * 可观察结果：到点的等待立刻处理；长的等待交给计时器并提前一个精度醒来；短于计时器精度又等不起的等待，在不断有包到达时
 * 交给 1 毫秒的兜底计时器（不占 CPU），到达停了才每轮事件循环看一次时间。
 * Bug：2026-11-21 剖面，有连接在快速发送时驱动线程整段时间占满一个 CPU 核（每 MiB 的 CPU 是 Device Link 的 4–6 倍）：
 * 短等待一律每轮看时间，而稳定传输时确认包每不到 1 毫秒就到一个，本身就带着核心走一轮。
 * 现有覆盖缺口：驱动的计时此前没有测试，`socket.integration.test.ts` 只看收发结果，看不出线程有没有空转。
 * 最小失败输入：等待 300 微秒、等不起、0.5 毫秒前刚收到过包——旧逻辑返回「每轮看时间」。
 * tier：unit，纯函数，不建端点、不加载 WebAssembly。只有一个表：驱动没有别的单测文件可并入，集成测试文件要绑真实 UDP 端口。
 */
import { expect, it } from 'vitest';
import { INBOUND_CLOCK_US, wakePlan } from '@cindy/agent-net-core/node';

it.each([
  { name: 'a wake that is already due', delayUs: 0, granularityUs: 16_000, fine: true, sinceInboundUs: 0, plan: 'now' },
  { name: 'a long wait: the timer, one granularity early', delayUs: 50_000, granularityUs: 16_000, fine: true, sinceInboundUs: Infinity, plan: 35 },
  { name: 'a short wait the connection can afford to miss: the timer', delayUs: 300, granularityUs: 16_000, fine: false, sinceInboundUs: Infinity, plan: 1 },
  { name: 'a short wait it cannot miss, no packets arriving (start of a burst)', delayUs: 300, granularityUs: 16_000, fine: true, sinceInboundUs: Infinity, plan: 'poll' },
  { name: 'the same wait while packets keep arriving: their arrival drives the core', delayUs: 300, granularityUs: 16_000, fine: true, sinceInboundUs: 500, plan: 1 },
  { name: 'arrivals stopped for the clock window: back to polling', delayUs: 300, granularityUs: 16_000, fine: true, sinceInboundUs: INBOUND_CLOCK_US, plan: 'poll' },
  { name: 'an accurate timer (macOS, Linux) with packets arriving', delayUs: 300, granularityUs: 1_000, fine: true, sinceInboundUs: 500, plan: 1 },
])('waits for the core\'s next wake: $name', ({ delayUs, granularityUs, fine, sinceInboundUs, plan }) => {
  expect(wakePlan(delayUs, granularityUs, () => fine, sinceInboundUs)).toBe(plan);
});
