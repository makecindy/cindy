/**
 * slack-hook-protocol 阶段 14(群消息中继帧)测试:
 *   1. group.message 构造 -> 序列化 -> 解析 round-trip(全字段 / 最小字段)
 *   2. 字段校验: 必填、text/fileNames 至少其一、上限、threadId/chatName 显式 null
 *   3. 能力标识常量 group-relay-v1
 *   4. 老端兼容: 不认识 group.message 的端按未知类型拒收(丢帧不断连语义)
 */

import { describe, it, expect } from 'vitest';

import {
  HOOK_FEATURE_GROUP_RELAY,
  HOOK_FEATURE_GROUP_RELAY_RECIPIENT,
  makeGroupMessage,
  makeTaskDispatch,
  parseHookMessage,
  serializeHookMessage,
  type GroupMessagePayload,
  type HookMessage,
} from '../index';

function roundTrip(message: HookMessage): HookMessage {
  const parsed = parseHookMessage(serializeHookMessage(message));
  expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
  if (!parsed.ok) throw new Error('unreachable');
  expect(parsed.message).toEqual(message);
  return parsed.message;
}

function expectReject(mutated: unknown, keyword: string): void {
  const parsed = parseHookMessage(mutated);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) throw new Error('unreachable');
  expect(parsed.error).toContain(keyword);
}

const FULL: GroupMessagePayload = {
  provider: 'telegram',
  recipient: { bindingId: 'binding-101', principalId: '101' },
  chatId: '-1001234567890',
  threadId: '77',
  messageId: '4213',
  chatName: 'Cindy Dev',
  author: { name: '@user202', isBot: false },
  text: '昨天部署失败了',
  fileNames: ['error.log'],
  sentAt: 1_785_200_000_000,
};

describe('group.message(阶段 14)', () => {
  it('round-trip: 全字段与最小字段', () => {
    roundTrip(makeGroupMessage(FULL));
    roundTrip(
      makeGroupMessage({
        provider: 'telegram',
        chatId: '-900',
        threadId: null,
        messageId: '1',
        chatName: null,
        author: { name: 'Cindy(bot)', isBot: true },
        text: '看起来是连接池耗尽',
        sentAt: 1_785_200_000_001,
      }),
    );
  });

  it('纯附件消息: text 可为空但 fileNames 必须非空', () => {
    roundTrip(makeGroupMessage({ ...FULL, text: '', fileNames: ['photo.jpg'] }));
    const empty = makeGroupMessage({ ...FULL, text: '' });
    delete (empty.payload as Partial<GroupMessagePayload>).fileNames;
    expectReject(empty, 'text or fileNames');
  });

  it('字段校验: 必填与显式 null', () => {
    expectReject({ ...makeGroupMessage(FULL), payload: { ...FULL, chatId: '' } }, 'chatId');
    expectReject({ ...makeGroupMessage(FULL), payload: { ...FULL, messageId: '' } }, 'messageId');
    expectReject(
      { ...makeGroupMessage(FULL), payload: { ...FULL, author: { name: '' } } },
      'author.name',
    );
    expectReject({ ...makeGroupMessage(FULL), payload: { ...FULL, sentAt: 0 } }, 'sentAt');
    // threadId / chatName 必须显式 null, 不接受缺省。
    const noThread: Record<string, unknown> = { ...FULL };
    delete noThread.threadId;
    expectReject({ ...makeGroupMessage(FULL), payload: noThread }, 'threadId');
  });

  it('上限: 超长 text 与超量 fileNames 拒收', () => {
    expectReject(
      { ...makeGroupMessage(FULL), payload: { ...FULL, text: 'x'.repeat(8_193) } },
      'text',
    );
    expectReject(
      {
        ...makeGroupMessage(FULL),
        payload: { ...FULL, fileNames: Array.from({ length: 21 }, (_, i) => `f${i}`) },
      },
      'fileNames',
    );
    expectReject(
      { ...makeGroupMessage(FULL), payload: { ...FULL, fileNames: ['x'.repeat(257)] } },
      'fileNames',
    );
  });

  it('能力标识常量', () => {
    expect(HOOK_FEATURE_GROUP_RELAY).toBe('group-relay-v1');
    expect(HOOK_FEATURE_GROUP_RELAY_RECIPIENT).toBe('group-relay-recipient-v1');
  });

  it('recipient 绑定接收方代际；旧帧可缺省，新帧字段必须完整', () => {
    roundTrip(makeGroupMessage({ ...FULL, recipient: undefined }));
    roundTrip(makeGroupMessage(FULL));
    expectReject({ ...makeGroupMessage(FULL), payload: { ...FULL, recipient: null } }, 'recipient');
    expectReject(
      {
        ...makeGroupMessage(FULL),
        payload: { ...FULL, recipient: { bindingId: '', principalId: '101' } },
      },
      'recipient.bindingId',
    );
    expectReject(
      {
        ...makeGroupMessage(FULL),
        payload: { ...FULL, recipient: { bindingId: 'binding-101', principalId: '' } },
      },
      'recipient.principalId',
    );
  });

  it('provider 是开放集合: 非 telegram 值照常通过', () => {
    roundTrip(makeGroupMessage({ ...FULL, provider: 'discord' }));
  });

  it('author.id / author.username(阶段 19 追加, 可选): 携带时 round-trip, 省略时(老形态)仍照常通过', () => {
    // 老形态: 无 id/username, 与 FULL 完全一致 —— 已在上面的 round-trip 用例覆盖,
    // 这里再显式断言一次解析结果里两个字段确实缺席(而非被静默填充成 undefined 之外的值)。
    const legacy = roundTrip(makeGroupMessage(FULL));
    expect((legacy.payload as GroupMessagePayload).author).toEqual({
      name: '@user202',
      isBot: false,
    });

    // 新形态: 两个字段都带上(Telegram 真实契约: id 纯数字, username 字母数字下划线)。
    roundTrip(
      makeGroupMessage({
        ...FULL,
        author: { name: '@user202', isBot: false, id: '202', username: 'user202' },
      }),
    );
    // 只带其中一个也应放行。
    roundTrip(makeGroupMessage({ ...FULL, author: { name: '@user202', id: '202' } }));
    roundTrip(makeGroupMessage({ ...FULL, author: { name: '@user202', username: 'user202' } }));
    // 边界: id 恰好为 52-bit 上限、username 恰好 32 位字符都必须放行。
    roundTrip(makeGroupMessage({ ...FULL, author: { name: '@user202', id: '4503599627370495' } }));
    roundTrip(
      makeGroupMessage({ ...FULL, author: { name: '@user202', username: 'u'.repeat(32) } }),
    );
  });

  it('author.id 按 Telegram 契约收紧: 规范正整数且在 52-bit 范围内', () => {
    expectReject(
      { ...makeGroupMessage(FULL), payload: { ...FULL, author: { name: '@user202', id: '' } } },
      'author.id',
    );
    for (const id of ['0', '001', '4503599627370496', '1'.repeat(21)]) {
      expectReject(
        {
          ...makeGroupMessage(FULL),
          payload: { ...FULL, author: { name: '@user202', id } },
        },
        'author.id',
      );
    }
    expectReject(
      {
        ...makeGroupMessage(FULL),
        payload: { ...FULL, author: { name: '@user202', id: 'has space' } },
      },
      'author.id',
    );
    expectReject(
      {
        ...makeGroupMessage(FULL),
        payload: { ...FULL, author: { name: '@user202', id: 42 } },
      },
      'author.id',
    );
    // 收紧前(通用可打印 ASCII)允许的形态, 收紧后必须拒收: 字母、符号、负号。
    expectReject(
      {
        ...makeGroupMessage(FULL),
        payload: { ...FULL, author: { name: '@user202', id: 'abc123' } },
      },
      'author.id',
    );
    expectReject(
      {
        ...makeGroupMessage(FULL),
        payload: { ...FULL, author: { name: '@user202', id: '-202' } },
      },
      'author.id',
    );
    expectReject(
      {
        ...makeGroupMessage(FULL),
        payload: { ...FULL, author: { name: '@user202', id: '202.0' } },
      },
      'author.id',
    );
  });

  it('author.username 按 Telegram 契约收紧: 仅 [A-Za-z0-9_], 1~32 位', () => {
    expectReject(
      {
        ...makeGroupMessage(FULL),
        payload: { ...FULL, author: { name: '@user202', username: '' } },
      },
      'author.username',
    );
    expectReject(
      {
        ...makeGroupMessage(FULL),
        payload: { ...FULL, author: { name: '@user202', username: 'u'.repeat(33) } },
      },
      'author.username',
    );
    expectReject(
      {
        ...makeGroupMessage(FULL),
        payload: { ...FULL, author: { name: '@user202', username: 'has space' } },
      },
      'author.username',
    );
    // 收紧前(通用可打印 ASCII)允许的形态, 收紧后必须拒收: 连字符、@ 前缀、点号。
    expectReject(
      {
        ...makeGroupMessage(FULL),
        payload: { ...FULL, author: { name: '@user202', username: 'user-202' } },
      },
      'author.username',
    );
    expectReject(
      {
        ...makeGroupMessage(FULL),
        payload: { ...FULL, author: { name: '@user202', username: '@user202' } },
      },
      'author.username',
    );
    expectReject(
      {
        ...makeGroupMessage(FULL),
        payload: { ...FULL, author: { name: '@user202', username: 'user.202' } },
      },
      'author.username',
    );
  });

  it('task.dispatch.source.triggerMessageId: 可选、非空字符串或显式 null', () => {
    const dispatch = makeTaskDispatch({
      requestId: 'req-1',
      externalKey: 'telegram:group:1:-1:1:9:g1',
      workspace: 'chat',
      sessionId: null,
      prompt: 'hi',
      source: { im: 'telegram', userText: 'hi', triggerMessageId: '4213' },
    });
    roundTrip(dispatch);
    roundTrip(
      makeTaskDispatch({
        ...dispatch.payload,
        source: { im: 'telegram', triggerMessageId: null },
      }),
    );
    expectReject(
      {
        ...dispatch,
        payload: {
          ...dispatch.payload,
          source: { im: 'telegram', triggerMessageId: '' },
        },
      },
      'triggerMessageId',
    );
  });
});
