/**
 * Telegram 群准入与设置页「群成员也能提问」是同一个开关(2026-11-24 用户实测: 私聊卡写着「批准后群成员可以
 * 召唤」, 设置页若另存一份, 批准后成员仍被挡住)。
 *
 * 生产入口: TelegramGroupAdmission.setApproval(设置页经 TelegramIM.setGroupApproval 调用)与 handleCallback
 * (私聊里的批准卡)。覆盖缺口: telegramIM.test 只覆盖卡片与邀请流程, 没有从设置页改准入。
 * 最小失败输入: 一个待批准的群在设置里勾上, 再点私聊里那张旧卡。tier: unit(内存 secrets 与 API 替身)。
 */

import { describe, expect, it, vi } from 'vitest';

import { TelegramGroupAdmission } from '../groupAdmission';

function secrets() {
  const store = new Map<string, string>();
  return {
    read: (key: string) => store.get(key) ?? null,
    write: (key: string, value: string) => { store.set(key, value); return true; },
    remove: (key: string) => { store.delete(key); },
  } as never;
}

describe('TelegramGroupAdmission.setApproval', () => {
  it('勾上即批准、取消即拒绝; 私聊里还没点的旧批准卡随之失效', async () => {
    const admission = new TelegramGroupAdmission(secrets(), 'k', 'bot:owner', '42');
    const api = { call: vi.fn(async () => ({})) };
    await admission.request({ id: -100, type: 'group', title: '项目群' } as never, api as never, () => true, new AbortController().signal);
    const card = (api.call.mock.calls[0] as unknown[])[1] as { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } };
    const approve = card.reply_markup.inline_keyboard[0]![0]!.callback_data;
    expect(admission.allows(-100)).toBe(false);

    expect(admission.setApproval('-100', true)).toBe(true);
    expect(admission.allows(-100)).toBe(true);
    expect(admission.statusOf('-100')).toBe('approved');

    api.call.mockClear();
    await admission.handleCallback(
      { id: 'q', data: approve, from: { id: 42 }, message: { message_id: 1, chat: { id: 42, type: 'private' } } } as never,
      api as never,
      () => true,
      new AbortController().signal,
    );
    expect(api.call).toHaveBeenCalledWith(
      'answerCallbackQuery',
      expect.objectContaining({ text: '此请求已失效。This request has expired.' }),
      expect.anything(),
    );

    expect(admission.setApproval('-100', false)).toBe(true);
    expect(admission.allows(-100)).toBe(false);
    // 没绑主人或不是群 id 时不保存。
    expect(new TelegramGroupAdmission(secrets(), 'k', 'bot:', '').setApproval('-100', true)).toBe(false);
    expect(admission.setApproval('42', true)).toBe(false);
  });
});
