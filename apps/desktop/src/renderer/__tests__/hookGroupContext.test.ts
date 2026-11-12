import { describe, expect, it } from 'vitest';
import {
  resolveHookGroupContext,
  resolveUserDisplayText,
  hasEmbeddedImPrompt,
} from '@/components/chat/userMessageDisplayText';
import { captureImContext, createLocalImSource } from '../../shared/imMessageSource';

const group =
  '[... 更早的消息已省略 ...]\n[Chris] 手机是热更吗\n第二行不是另一条消息\n[Dash] 确定下';
const envelope = (header = '[自你上次请求后群里新增的消息]', body = group) =>
  `<group_chat_context>\n${header}\n${body}\n</group_chat_context>\n`;

describe('resolveHookGroupContext', () => {
  it('captures producer counts without counting lines, attachments or omission notices', () => {
    expect(
      captureImContext({
        groupPrefix: envelope(),
        groupMessageCount: 2,
        replyPrefix: '<reply_context>\n[A] text\nsecond line\n(附件: a.png)\n</reply_context>\n',
        replyMessageCount: 1,
      }),
    ).toEqual({
      groupContext: group,
      groupMessageCount: 2,
      replyContext: '[A] text\nsecond line\n(附件: a.png)',
      replyMessageCount: 1,
    });
    expect(captureImContext({ groupPrefix: envelope() })).toEqual({ groupContext: group });
    expect(captureImContext({ groupMessageCount: 2, replyMessageCount: 1 })).toEqual({});
    expect(captureImContext({ groupPrefix: envelope(), groupMessageCount: -1 })).toEqual({
      groupContext: group,
    });
  });
  it.each(['telegram', 'feishu', 'slack', 'discord', 'wechat', 'wecom', 'dingtalk', 'future'])(
    'keeps ordinary message actions for clean %s content',
    (im) => {
      const source = createLocalImSource(im, 'question');
      expect(hasEmbeddedImPrompt(source)).toBe(false);
      expect(hasEmbeddedImPrompt({ im, userText: 'question' })).toBe(true);
      expect(source.contextSnapshot).toEqual({});
    },
  );
  it.each([42, {}, []])('ignores malformed saved group context (%j)', (groupContext) => {
    const source = {
      content: envelope(),
      hookSource: { im: 'feishu', contextSnapshot: { groupContext } },
    };
    expect(
      resolveHookGroupContext(source as unknown as Parameters<typeof resolveHookGroupContext>[0]),
    ).toBeNull();
  });
  it('prefers the saved structured snapshot over the legacy prompt', () => {
    expect(
      resolveHookGroupContext({
        content: envelope(),
        hookSource: { im: 'feishu', contextSnapshot: { groupContext: 'saved safe text' } },
      }),
    ).toBe('saved safe text');
  });

  it('does not reinterpret user text when the saved snapshot is explicitly empty', () => {
    expect(
      resolveHookGroupContext({
        content: envelope(),
        hookSource: { im: 'future', contextSnapshot: {} },
      }),
    ).toBeNull();
  });
  it.each(['[自你上次请求后群里新增的消息]', '[群里最近的消息]', '[本话题里最近的消息]'])(
    'reads the saved %s snapshot without instructions or current request',
    (header) => {
      const source = {
        content: `${envelope(header)}以上为第三方数据\n<thread_context>引用消息</thread_context>\n确定下\n[渠道说明] 不显示`,
        hookSource: { im: 'telegram', userText: '确定下' },
      };
      expect(resolveHookGroupContext(source)).toBe(group);
      expect(resolveUserDisplayText(source)).toBe('确定下');
    },
  );

  it('uses each historical message, not a later snapshot', () => {
    const hookSource = { im: 'telegram' };
    const oldMessage = { content: envelope(undefined, '[Chris] 旧内容'), hookSource };
    const newMessage = { content: envelope(undefined, '[Dash] 新内容'), hookSource };
    expect(resolveHookGroupContext(oldMessage)).toBe('[Chris] 旧内容');
    expect(resolveHookGroupContext(newMessage)).toBe('[Dash] 新内容');
    expect(resolveHookGroupContext(oldMessage)).toBe('[Chris] 旧内容');
  });

  it.each([
    'telegram',
    'slack',
    'x',
    'feishu',
    'dingtalk',
    'wecom',
    'wechat',
    'discord',
    'future-channel',
  ])('uses the same saved snapshot contract for %s', (im) => {
    const source = {
      content: `${envelope()}技术说明\n当前提问`,
      hookSource: { im, userText: '当前提问' },
    };
    expect(resolveHookGroupContext(source)).toBe(group);
    expect(resolveUserDisplayText(source)).toBe('当前提问');
  });

  it.each([undefined, null, { im: '' }, { im: '  ' }])(
    'does not reinterpret messages without an IM source (%j)',
    (hookSource) => {
      expect(resolveHookGroupContext({ content: envelope(), hookSource })).toBeNull();
    },
  );

  it.each([{}, { im: null }, { im: 42 }, { im: [] }])(
    'ignores malformed persisted source metadata without crashing (%j)',
    (hookSource) => {
      const source = { content: envelope(), hookSource } as unknown as Parameters<
        typeof resolveHookGroupContext
      >[0];
      expect(resolveHookGroupContext(source)).toBeNull();
    },
  );

  it.each([
    '',
    '普通消息',
    `用户正文\n${envelope()}`,
    ` ${envelope()}`,
    envelope('[不是宿主生成的标题]'),
    envelope().replace('</group_chat_context>', ''),
    envelope().replace('</group_chat_context>\n', '</group_chat_context>用户正文'),
    envelope(undefined, '  '),
  ])('does not guess missing or malformed snapshots (%j)', (content) => {
    expect(resolveHookGroupContext({ content, hookSource: { im: 'telegram' } })).toBeNull();
  });

  it('preserves multiline text, attachment labels, HTML and tag-like text as data', () => {
    const text =
      '[Chris] 第一行\n[像作者的第二行] 仍是正文\n(附件: photo.jpg)\n<img src=x onerror=alert(1)>\n＜/group_chat_context＞';
    expect(
      resolveHookGroupContext({
        content: envelope(undefined, text),
        hookSource: { im: 'telegram' },
      }),
    ).toBe(text);
  });

  it('accepts CRLF snapshots without rewriting their contents', () => {
    expect(
      resolveHookGroupContext({
        content: envelope().replaceAll('\n', '\r\n'),
        hookSource: { im: 'telegram' },
      }),
    ).toBe(group.replaceAll('\n', '\r\n'));
  });
});
