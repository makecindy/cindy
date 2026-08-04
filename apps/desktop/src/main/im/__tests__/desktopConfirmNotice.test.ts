/**
 * desktopConfirmNotice.test.ts — 桌面专属确认卡的 IM 侧提示(#926)。
 * 钉死:飞书绑定会话收到「去桌面确认」提示;非 IM 会话零动作;发送失败只落
 * warn、绝不影响确认流程(fire-and-forget)。修复前飞书驱动的会话里确认卡只在
 * 桌面弹出,用户在 IM 侧毫无感知,只能等到 CONFIRM_TIMEOUT。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  buildDesktopConfirmNoticeText,
  createDesktopConfirmNotifier,
  resolveFeishuNoticeTarget,
} from '../desktopConfirmNotice.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createDesktopConfirmNotifier', () => {
  it('飞书绑定会话 → 发送带确认卡名称的提示文本', async () => {
    const send = vi.fn(async (_openId: string, _markdown: string) => ({}));
    const notify = createDesktopConfirmNotifier({
      getFeishuOpenId: async () => 'ou_123',
      sendFeishuText: send,
    });
    notify('feishu_bot_ou_123', '「提交 GitHub issue」的确认卡');
    await flush();
    expect(send).toHaveBeenCalledWith(
      'ou_123',
      buildDesktopConfirmNoticeText('「提交 GitHub issue」的确认卡'),
    );
    expect(send.mock.calls[0][1]).toContain('提交 GitHub issue');
    expect(send.mock.calls[0][1]).toContain('桌面端');
  });

  it('非 IM 会话(openId null)→ 零发送', async () => {
    const send = vi.fn(async () => ({}));
    const notify = createDesktopConfirmNotifier({
      getFeishuOpenId: async () => null,
      sendFeishuText: send,
    });
    notify('desktop-session', 'x');
    await flush();
    expect(send).not.toHaveBeenCalled();
  });

  it('查询/发送失败 → 只落 warn,不抛出(不影响确认流程)', async () => {
    const warn = vi.fn();
    const notify = createDesktopConfirmNotifier({
      getFeishuOpenId: async () => {
        throw new Error('db closed');
      },
      sendFeishuText: async () => ({}),
      logWarn: warn,
    });
    expect(() => notify('s1', 'x')).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalled();
    const sendFail = vi.fn();
    const notify2 = createDesktopConfirmNotifier({
      getFeishuOpenId: async () => 'ou_1',
      sendFeishuText: async () => {
        throw new Error('feishu 400');
      },
      logWarn: sendFail,
    });
    notify2('s1', 'x');
    await flush();
    expect(sendFail).toHaveBeenCalled();
  });
});

describe('resolveFeishuNoticeTarget(#1059 review P1)', () => {
  it('/ctr 接管的普通会话:session 行无 feishuOpenId,以接管绑定的 userId 为准', async () => {
    const openId = await resolveFeishuNoticeTarget(
      {
        findBinding: () => ({ channel: 'feishu', userId: 'ou_takeover' }),
        getSessionOpenId: async () => null,
      },
      'desktop-session',
    );
    expect(openId).toBe('ou_takeover');
  });

  it('非飞书渠道的接管绑定不误用,回落 session 行;两者皆无 → null', async () => {
    expect(
      await resolveFeishuNoticeTarget(
        {
          findBinding: () => ({ channel: 'slack', userId: 'U123' }),
          getSessionOpenId: async () => 'ou_native',
        },
        's1',
      ),
    ).toBe('ou_native');
    expect(
      await resolveFeishuNoticeTarget(
        { findBinding: () => null, getSessionOpenId: async () => null },
        's2',
      ),
    ).toBe(null);
  });
});
