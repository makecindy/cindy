import { describe, expect, it } from 'vitest';
import { PLUGIN_EVENT_LIMITS, subscribedEventPlugins, toPluginWebhookEvent } from '../plugin-events.js';

// 测试价值
// - 生产入口与可观察结果：toPluginWebhookEvent 生成落盘并注入提示词的门铃记录；subscribedEventPlugins 决定哪些插件保持监听。
// - 规则依据：docs/product-rules/plugin-event-triggers.md「事件只是门铃」与「常驻只在有人订阅时」。
// - 现有覆盖缺口：新模块；队列与调度器测试只覆盖匹配和范围，不覆盖字段预算与来源命名。
// - 最小失败输入：两个插件用同一上游 ID；超出预算的字段；暂停或过期的自动化。
// - tier：unit，纯函数。
describe('plugin events', () => {
  it('namespaces delivery ids by plugin and bounds persisted fields', () => {
    const big = 'x'.repeat(PLUGIN_EVENT_LIMITS.persistedFieldValueChars + 50);
    const a = toPluginWebhookEvent('public/chat', { id: 'm1', type: 'message.received', occurredAt: 5, subject: '  hi  ',
      data: { chatId: 'c1', fromSelf: false, body: big, a: big, b: big, c: big } }, 10);
    const b = toPluginWebhookEvent('public/mail', { id: 'm1', type: 'message.received', occurredAt: 5, data: {} }, 10);
    expect(a.deliveryId).not.toBe(b.deliveryId);
    expect(a).toMatchObject({ source: 'plugin:public/chat', event: 'message.received', occurredAt: 5, subject: 'hi', fieldsTruncated: true });
    expect(a.fields).toMatchObject({ chatId: 'c1', fromSelf: false });
    expect((a.fields!.body as string).length).toBe(PLUGIN_EVENT_LIMITS.persistedFieldValueChars);
    expect(JSON.stringify(a.fields).length).toBeLessThan(PLUGIN_EVENT_LIMITS.persistedFieldChars + 200);
    expect(b.fields).toBeUndefined();
  });

  it('lists plugins chosen by active, unexpired automations only', () => {
    const trigger = (plugin: string) => ({ source: { preset: 'plugin', sources: [{ plugin }] } });
    expect([...subscribedEventPlugins([
      { status: 'active', webhookTrigger: trigger('public/chat') },
      { status: 'paused', webhookTrigger: trigger('public/paused') },
      { status: 'active', expireAt: 1, webhookTrigger: trigger('public/expired') },
      { status: 'active', webhookTrigger: { source: { preset: 'github-app' } } },
    ], 100)]).toEqual(['public/chat']);
  });
});
