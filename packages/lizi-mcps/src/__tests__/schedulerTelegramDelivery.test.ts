import { describe, it, expect, vi } from 'vitest';
import { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';
import { registerTelegramDeliveryTools } from '../scheduler/telegramDelivery.js';

describe('scheduler official Telegram tools', () => {
  it('exposes status, send and receipt and resolves the live bridge per call', async () => {
    const registry = new SchedulerToolRegistry();
    const send = vi.fn(async () => ({ state: 'sent', result: { messageId: '42' }, formatVerified: false }));
    const bridge = { status: () => ({ supported: true }), send, receipt: () => ({ state: 'unknown' }) };
    const getBridge = vi.fn<() => typeof bridge | null>(() => bridge);
    registerTelegramDeliveryTools(registry, { getScheduler: () => { throw new Error('unused'); }, telegramDelivery: { getBridge } });
    expect(registry.list().map(t => t.name)).toEqual(['schedule_telegram_status', 'schedule_telegram_send', 'schedule_telegram_receipt']);
    const args = {
      idempotencyKey: 'key', target: { bindingId: 'b', principalId: 'p', principalName: 'P', externalKey: 'existing-key', botId: 'bot', botName: 'test_bot' },
      text: '<b>hello</b>', tier: 'html', sourceSha256: 'a'.repeat(64), presentationSha256: 'b'.repeat(64),
    };
    const result = await registry.call('schedule_telegram_send', args);
    expect(result.isError).not.toBe(true);
    expect(send).toHaveBeenCalledWith(args);
    const invalid = await registry.call('schedule_telegram_send', { ...args, target: { ...args.target, chatId: 'guessed' } });
    expect(invalid.isError).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    getBridge.mockReturnValue(null);
    const unavailable = await registry.call('schedule_telegram_send', args);
    expect(unavailable.isError).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
