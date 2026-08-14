import { describe, expect, it } from 'vitest';

import type { TgCallbackQuery } from '../api.js';
import { buildCardPayload, parseCallbackQuery } from '../components.js';

describe('buildCardPayload', () => {
  it('标题加粗 + 按钮生成 callback_data', () => {
    const { html, replyMarkup } = buildCardPayload({
      title: 'T<A>',
      body: '**b**',
      buttons: [{ id: 'x', label: 'Go' }],
    });
    expect(html).toContain('<b>T&lt;A&gt;</b>');
    expect(html).toContain('<b>b</b>');
    expect(replyMarkup?.inline_keyboard.flat()).toHaveLength(1);
    expect(replyMarkup?.inline_keyboard[0][0].text).toBe('Go');
  });

  it('短 label 两键并排, 长 label 独占一行', () => {
    const { replyMarkup } = buildCardPayload({
      body: 'b',
      buttons: [
        { id: 'a', label: '✅ 允许' },
        { id: 'b', label: '❌ 拒绝' },
        { id: 'c', label: '这是一个特别长的按钮文案超过阈值' },
      ],
    });
    expect(replyMarkup?.inline_keyboard.map((row) => row.length)).toEqual([2, 1]);
  });

  it('超长正文截断不切进标签/实体, 未配对标签补闭合(parse_mode=HTML 不 400)', () => {
    // 长链接列表: 3800 截点大概率落在 <a href="..."> 内部或实体中间
    const body = Array.from({ length: 200 }, (_, i) =>
      `[链接与符号 & 文本 ${i}](https://example.com/very/long/path/segment-${i}?q=a&b=c)`,
    ).join(' ');
    const { html } = buildCardPayload({ title: 'T', body, buttons: [] });
    expect(html.length).toBeLessThan(4200);
    // 无残缺标签: 每个 '<' 都有配对 '>'
    expect(html.lastIndexOf('<')).toBeLessThan(html.lastIndexOf('>'));
    // 标签配对: <a> 与 </a> 数量一致(截断处补了闭合)
    const opens = (html.match(/<a\s/g) ?? []).length;
    const closes = (html.match(/<\/a>/g) ?? []).length;
    expect(opens).toBe(closes);
    // 无被切断的实体(& 后面在合理窗口内必有 ;)
    const tail = html.slice(-12);
    const amp = tail.lastIndexOf('&');
    if (amp !== -1) expect(tail.slice(amp)).toContain(';');
  });

  it('无按钮时下发空键盘(而不是省略 reply_markup, 否则旧键盘会留在消息上)', () => {
    expect(buildCardPayload({ body: 'b', buttons: [] }).replyMarkup).toEqual({
      inline_keyboard: [],
    });
  });
});

describe('parseCallbackQuery', () => {
  function query(chatType: 'private' | 'supergroup', data: string): TgCallbackQuery {
    return {
      id: 'q1',
      from: { id: 111, is_bot: false, first_name: 'C' },
      data,
      message: {
        message_id: 9,
        chat: { id: chatType === 'private' ? 111 : -500, type: chatType },
        date: 0,
      },
    };
  }

  it('私聊卡片 senderId = 按键者数字 id', () => {
    const { replyMarkup } = buildCardPayload({
      body: 'b',
      buttons: [{ id: 'perm:allow', label: 'ok', payload: { requestId: 'r1' } }],
    });
    const data = replyMarkup!.inline_keyboard[0][0].callback_data;
    const event = parseCallbackQuery(query('private', data));
    expect(event).toMatchObject({
      channelName: 'telegram',
      senderId: '111',
      chatId: '111',
      messageId: '111|9',
      buttonId: 'perm:allow',
      payload: { requestId: 'r1' },
    });
  });

  it('群卡片 senderId = 群 lane id(路由回 lane 会话)', () => {
    const { replyMarkup } = buildCardPayload({
      body: 'b',
      buttons: [{ id: 'x', label: 'ok' }],
    });
    const data = replyMarkup!.inline_keyboard[0][0].callback_data;
    const event = parseCallbackQuery(query('supergroup', data));
    expect(event?.senderId).toBe('g/-500');
  });

  it('过期/未知 callback_data 返回 null', () => {
    expect(parseCallbackQuery(query('private', 'r:gone'))).toBeNull();
  });
});
