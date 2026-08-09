import { describe, expect, it } from 'vitest';

import type { TgMessage } from '../api.js';
import { detectGroupTrigger, groupWindowEntryOf, laneThreadIdOf, replyContextOf } from '../inbound.js';

const BOT_ID = 999;
const BOT_USERNAME = 'my_cindy_bot';

function msg(overrides: Partial<TgMessage> = {}): TgMessage {
  return {
    message_id: 1,
    from: { id: 111, is_bot: false, first_name: 'Chris' },
    chat: { id: -100200, type: 'supergroup', title: 'Ops' },
    date: 1_753_000_000,
    text: 'hello',
    ...overrides,
  };
}

describe('detectGroupTrigger', () => {
  it('@bot 提及触发并剥掉提及', () => {
    const m = msg({
      text: `@${BOT_USERNAME} 部署一下`,
      entities: [{ type: 'mention', offset: 0, length: BOT_USERNAME.length + 1 }],
    });
    expect(detectGroupTrigger(m, BOT_ID, BOT_USERNAME)).toEqual({ text: '部署一下' });
  });

  it('提及其它 bot 不触发', () => {
    const m = msg({
      text: '@other_bot hi',
      entities: [{ type: 'mention', offset: 0, length: 10 }],
    });
    expect(detectGroupTrigger(m, BOT_ID, BOT_USERNAME)).toBeNull();
  });

  it('回复 bot 的消息触发(无需提及)', () => {
    const m = msg({
      text: '继续',
      reply_to_message: msg({
        from: { id: BOT_ID, is_bot: true, first_name: 'Cindy' },
      }),
    });
    expect(detectGroupTrigger(m, BOT_ID, BOT_USERNAME)).toEqual({ text: '继续' });
  });

  it('回复别人的消息不触发', () => {
    const m = msg({
      text: '继续',
      reply_to_message: msg({ from: { id: 222, is_bot: false, first_name: 'B' } }),
    });
    expect(detectGroupTrigger(m, BOT_ID, BOT_USERNAME)).toBeNull();
  });

  it('/cmd@bot 指令触发且剥掉 @username 后缀', () => {
    const m = msg({
      text: `/new@${BOT_USERNAME}`,
      entities: [{ type: 'bot_command', offset: 0, length: 5 + BOT_USERNAME.length }],
    });
    expect(detectGroupTrigger(m, BOT_ID, BOT_USERNAME)).toEqual({ text: '/new' });
  });

  it('caption 提及(带图@bot)同样触发', () => {
    const m = msg({
      text: undefined,
      caption: `看看这个 @${BOT_USERNAME}`,
      caption_entities: [{ type: 'mention', offset: 5, length: BOT_USERNAME.length + 1 }],
    });
    expect(detectGroupTrigger(m, BOT_ID, BOT_USERNAME)).toEqual({ text: '看看这个' });
  });
});

describe('replyContextOf', () => {
  it('文本回复带作者与正文', () => {
    const m = msg({
      reply_to_message: msg({
        from: { id: 222, is_bot: false, first_name: 'Bob' },
        text: '昨天的部署日志在这',
      }),
    });
    expect(replyContextOf(m)).toEqual({ author: 'Bob', text: '昨天的部署日志在这' });
  });

  it('回复 bot 的消息标 isBot', () => {
    const m = msg({
      reply_to_message: msg({
        from: { id: BOT_ID, is_bot: true, first_name: 'Cindy' },
        text: '已完成',
      }),
    });
    expect(replyContextOf(m)).toEqual({ author: 'Cindy', text: '已完成', isBot: true });
  });

  it('纯附件回复给类型占位; 无内容的服务消息返回 null', () => {
    const photoReply = msg({
      reply_to_message: msg({
        text: undefined,
        photo: [{ file_id: 'f', file_unique_id: 'u', width: 100, height: 100 }],
      }),
    });
    expect(replyContextOf(photoReply)?.text).toBe('[图片]');
    const docReply = msg({
      reply_to_message: msg({
        text: undefined,
        document: { file_id: 'f', file_unique_id: 'u', file_name: 'a.pdf' },
      }),
    });
    expect(replyContextOf(docReply)?.text).toBe('[文件: a.pdf]');
    const empty = msg({ reply_to_message: msg({ text: undefined }) });
    expect(replyContextOf(empty)).toBeNull();
    expect(replyContextOf(msg())).toBeNull();
  });

  it('受保护群的被引消息不进 prompt(原文不外传)', () => {
    // 「禁止保存内容」的群里, 引用块会把原文原样带进模型上下文 —— 那和把它
    // 写进本地池是同一次外传。与官方 bot 服务端同一条边界。
    const protectedReplied = msg({
      reply_to_message: msg({ message_id: 3, text: '机密讨论', has_protected_content: true }),
    });
    expect(replyContextOf(protectedReplied)).toBeNull();

    // 触发消息自身受保护(整个群开了保护)时同样不带引用原文。
    const protectedTrigger = msg({
      has_protected_content: true,
      reply_to_message: msg({ message_id: 4, text: '机密讨论' }),
    });
    expect(replyContextOf(protectedTrigger)).toBeNull();

    // 未保护的群逐字节不变。
    expect(
      replyContextOf(msg({ reply_to_message: msg({ message_id: 5, text: '普通讨论' }) })),
    ).toMatchObject({ text: '普通讨论' });
  });
});

describe('groupWindowEntryOf / laneThreadIdOf', () => {
  it('普通群消息 → 窗口条目(threadId 空)', () => {
    const entry = groupWindowEntryOf(msg({ message_id: 7, text: 'hi there' }));
    expect(entry).toMatchObject({
      chatId: '-100200',
      threadId: '',
      messageId: '7',
      chatName: 'Ops',
      author: { name: 'Chris' },
      text: 'hi there',
      sentAt: 1_753_000_000_000,
    });
    expect(entry.fileNames).toBeUndefined();
  });

  it('topic 消息带 threadId;普通回复的 message_thread_id 不算 topic', () => {
    expect(laneThreadIdOf(msg({ message_thread_id: 55, is_topic_message: true }))).toBe('55');
    expect(laneThreadIdOf(msg({ message_thread_id: 55 }))).toBe('');
  });

  it('bot 消息标 isBot, 附件写 fileNames, 纯附件 text 空串', () => {
    const entry = groupWindowEntryOf(
      msg({
        from: { id: 5, is_bot: true, first_name: 'OtherBot' },
        text: undefined,
        document: { file_id: 'f', file_unique_id: 'u', file_name: 'a.pdf' },
      }),
    );
    expect(entry.author).toEqual({ name: 'OtherBot', isBot: true });
    expect(entry.fileNames).toEqual(['a.pdf']);
    expect(entry.text).toBe('');
  });
});
