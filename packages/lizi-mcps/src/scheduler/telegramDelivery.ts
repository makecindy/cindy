/** Official Telegram delivery for scheduled results and explicitly authorized tests. */
import { z } from 'zod';
import { buildJsonResult } from './_shared.js';
import type { SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';

export function registerTelegramDeliveryTools(registry: SchedulerToolRegistry, deps: SchedulerMcpDeps): void {
  if (!deps.telegramDelivery) return;
  const target = z.object({
    bindingId: z.string().min(1), principalId: z.string().min(1),
    principalName: z.string().nullable(), externalKey: z.string().min(1), botId: z.string().min(1), botName: z.string().nullable(),
  }).strict();
  const invoke = async (fn: (bridge: NonNullable<ReturnType<NonNullable<SchedulerMcpDeps['telegramDelivery']>['getBridge']>>) => unknown) => {
    const bridge = deps.telegramDelivery?.getBridge();
    if (!bridge) return buildJsonResult({ ok: false, code: 'TELEGRAM_DELIVERY_NOT_READY' }, true);
    try { return buildJsonResult(await fn(bridge)); }
    catch (error) {
      // Host supplies stable codes, never credentials or raw transport errors.
      const code = error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message : 'DELIVERY_FAILED';
      return buildJsonResult({ ok: false, code }, true);
    }
  };
  registry.register({
    name: 'schedule_telegram_status', category: 'scheduler',
    description: '查询官方 Telegram 直接投递能力与当前已绑定本人的私聊目标。只返回已有目标；不绑定账号、不猜 chat_id。supported=true 才能发送。',
    inputShape: {},
    handler: async () => invoke(bridge => bridge.status()),
  });
  registry.register({
    name: 'schedule_telegram_send', category: 'scheduler',
    description: '经官方 Telegram IM 直接发送定时结果或用户明确授权的测试；发送遵循 Host 逐次授权策略，不因属于 scheduler 而免审。先查 status，完整复用 target；按分段持久保存唯一 idempotencyKey 和原文/展示哈希。text 是最终 HTML 或纯文本。started/unknown 不得换 key 重发；sent 表示真实消息 ID 与绑定目标匹配；result.sentMessage 包含实际正文/entities，调用者应对照预期展示稿验真。formatVerified=false 表示 Host 未代替调用者比较格式。',
    inputShape: {
      idempotencyKey: z.string().min(1).max(200), target,
      text: z.string().min(1).max(16000), tier: z.enum(['html', 'plain']),
      sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
      presentationSha256: z.string().regex(/^[a-f0-9]{64}$/),
    },
    handler: async input => invoke(bridge => bridge.send(input)),
  });
  registry.register({
    name: 'schedule_telegram_receipt', category: 'scheduler',
    description: '只读查询原幂等键的持久 IM 发送记录，不发送、不重试。started/unknown 表示结果未确认，不能当未发送；sent 包含真实消息 ID 与 result.sentMessage 的实际正文/entities；缺这些字段的旧回执不能当作格式证据。',
    inputShape: { idempotencyKey: z.string().min(1).max(200) },
    handler: async ({ idempotencyKey }) => invoke(bridge => bridge.receipt(idempotencyKey)),
  });
}
