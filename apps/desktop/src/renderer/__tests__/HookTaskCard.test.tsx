// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import HookTaskCard from '@/components/chat/HookTaskCard';
import {
  resolveHookGroupContext,
  resolveUserDisplayText,
} from '@/components/chat/userMessageDisplayText';

// Keep the real Collapse component; reduced motion makes mounting deterministic.
vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => true }));

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
});
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en');
});

describe('HookTaskCard attached context', () => {
  it.each(['telegram', 'feishu', 'slack', 'discord', 'wechat', 'wecom', 'dingtalk', 'x', 'future'])(
    'shows accurate group counts and their total for %s',
    (im) => {
      render(
        <HookTaskCard
          im={im}
          userText="问题"
          replyContext={'[A] 引用\n第二行\n(附件: a.png)'}
          replyMessageCount={1}
          threadContext={[{ author: 'B', text: '另一条引用' }]}
          groupContext={'[... 更早的消息已省略 ...]\n[C] 背景\n第二行'}
          groupMessageCount={10}
        />,
      );
      const toggle = screen.getByRole('button', { name: '本条附带的上下文（12）' });
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(toggle);
      expect(screen.getByRole('region', { name: '引用消息（2）' })).toBeTruthy();
      expect(screen.getByRole('region', { name: '群聊背景（10）' })).toBeTruthy();
    },
  );
  it.each([undefined, -1, 0, 1.5, NaN, Infinity, '2', Number.MAX_SAFE_INTEGER + 1])(
    'does not invent a total when a saved count is unknown or invalid (%s)',
    (count) => {
      render(
        <HookTaskCard
          im="slack"
          userText="问题"
          threadContext={[{ author: 'A', text: '引用' }]}
          groupContext={'[B] 一条\n[C] 仍是同一条的内容'}
          groupMessageCount={count as number}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: '本条附带的上下文' }));
      expect(screen.getByRole('region', { name: '引用消息（1）' })).toBeTruthy();
      expect(screen.getByRole('region', { name: '群聊背景' })).toBeTruthy();
    },
  );
  it('counts group-only context and ignores stale counts for absent groups', () => {
    render(
      <HookTaskCard
        im="feishu"
        userText="问题"
        groupContext="背景"
        groupMessageCount={3}
        replyMessageCount={99}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '本条附带的上下文（3）' }));
    expect(screen.getByRole('region', { name: '群聊背景（3）' })).toBeTruthy();
    expect(screen.getAllByRole('region')).toHaveLength(1);
  });
  it('retains the existing long-message protection for clean IM user text', () => {
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(720);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    try {
      const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
      const { container } = render(<HookTaskCard im="feishu" userText={text} collapseUserText />);
      const toggle = screen.getByRole('button');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(container.querySelector('.line-clamp-10')).toBeTruthy();
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(container.querySelector('.line-clamp-10')).toBeNull();
    } finally {
      cleanup();
      height.mockRestore();
      vi.unstubAllGlobals();
    }
  });
  it('ignores malformed saved text fields without crashing', () => {
    render(
      <HookTaskCard
        im="feishu"
        userText="确定下"
        groupContext={42 as unknown as string}
        replyContext={{} as unknown as string}
      />,
    );
    expect(screen.queryByRole('button', { name: '本条附带的上下文' })).toBeNull();
  });
  it('groups a saved local reply without guessing a message count', () => {
    render(
      <HookTaskCard
        im="feishu"
        userText="确定下"
        replyContext={'[Alice] quoted text\nsecond line'}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '本条附带的上下文' }));
    expect(screen.getByRole('heading', { name: '引用消息' })).toBeTruthy();
    expect(screen.getByText(/quoted text/)).toBeTruthy();
    expect(screen.queryByText('群聊背景')).toBeNull();
  });
  it('starts collapsed, expands two groups, then unmounts them on collapse', () => {
    const group = '[... 更早的消息已省略 ...]\n[Chris] 群聊背景原文\n另一行';
    const source = {
      content: `<group_chat_context>\n[自你上次请求后群里新增的消息]\n${group}\n</group_chat_context>\n不应展示的技术指引\n确定下`,
      hookSource: { im: 'telegram', userText: '确定下' },
    };
    const { container } = render(
      <HookTaskCard
        im="telegram"
        userText={resolveUserDisplayText(source)}
        threadContext={[{ author: 'Chris', text: '手机是热更吗\n(附件: photo.jpg)' }]}
        groupContext={resolveHookGroupContext(source)}
      />,
    );
    const toggle = screen.getByRole('button', { name: '本条附带的上下文' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryAllByRole('region')).toHaveLength(0);
    expect(container.textContent).not.toContain('群聊背景原文');
    expect(screen.getByText('确定下')).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBeTruthy();
    const replies = screen.getByRole('region', { name: '引用消息（1）' });
    expect(replies.textContent).toContain('[Chris] 手机是热更吗\n(附件: photo.jpg)');
    const background = screen.getByRole('region', { name: '群聊背景' });
    expect(background.textContent).toContain(group);
    expect(screen.getAllByRole('region')).toEqual([replies, background]);
    expect(container.textContent).not.toContain('不应展示的技术指引');
    expect(container.textContent).not.toContain('group_chat_context');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryAllByRole('region')).toHaveLength(0);
    expect(container.textContent).not.toContain('群聊背景原文');
  });

  it('shows group-only context even when there are no reply entries', () => {
    render(<HookTaskCard im="telegram" userText="问题" groupContext="[A] 背景" />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getAllByRole('region')).toHaveLength(1);
    expect(screen.getByRole('region', { name: '群聊背景' })).toBeTruthy();
  });

  it('keeps legacy reply-only messages expandable and omits the empty group', () => {
    render(
      <HookTaskCard
        im="telegram"
        userText="问题"
        threadContext={[{ author: 'A', text: '引用' }]}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getAllByRole('region')).toHaveLength(1);
    expect(screen.getByRole('region', { name: '引用消息（1）' })).toBeTruthy();
  });

  it('has no empty disclosure for a context-free message', () => {
    render(<HookTaskCard im="telegram" userText="问题" threadContext={[]} groupContext="  " />);
    expect(screen.queryByRole('button')).toBeNull();
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
  ])('uses the same collapsed groups for %s without platform-specific context labels', (im) => {
    const source = {
      content:
        '<group_chat_context>\n[群里最近的消息]\n[B] 背景\n</group_chat_context>\n技术说明\n问题',
      hookSource: { im, userText: '问题' },
    };
    const { container } = render(
      <HookTaskCard
        im={im}
        userText={resolveUserDisplayText(source)}
        threadContext={[{ author: 'A', text: 'thread' }]}
        groupContext={resolveHookGroupContext(source)}
      />,
    );
    const toggle = screen.getByRole('button', { name: '本条附带的上下文' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryAllByRole('region')).toHaveLength(0);
    fireEvent.click(toggle);
    expect(screen.getByRole('region', { name: '引用消息（1）' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '群聊背景' })).toBeTruthy();
    expect(container.textContent).not.toContain('技术说明');
    fireEvent.click(toggle);
    expect(screen.queryAllByRole('region')).toHaveLength(0);
  });

  it('renders untrusted text literally, without HTML, links or media execution', () => {
    const text = '<img src=x onerror="alert(1)"> [link](https://example.com)';
    const { container } = render(
      <HookTaskCard
        im="telegram"
        userText="问题"
        threadContext={[{ author: '<b>A</b>', text }]}
        groupContext={text}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(within(screen.getByRole('region', { name: '群聊背景' })).getByText(text)).toBeTruthy();
    expect(container.querySelector('img, a, script, b')).toBeNull();
  });

  it.each([
    ['en', 'Context attached to this message', 'Referenced messages (1)', 'Group chat background'],
    ['zh-TW', '這則訊息附帶的上下文', '引用訊息（1）', '群組背景'],
    [
      'ja',
      'このメッセージに添付されたコンテキスト',
      '参照メッセージ（1）',
      'グループチャットの背景',
    ],
    ['ko', '이 메시지에 첨부된 컨텍스트', '참조 메시지 (1)', '그룹 채팅 배경'],
  ])(
    'localizes the disclosure and group headings in %s',
    async (locale, label, replies, background) => {
      await i18n.changeLanguage(locale);
      render(
        <HookTaskCard
          im="telegram"
          userText="Question"
          threadContext={[{ author: 'A', text: 'Reply' }]}
          groupContext="[B] Background"
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(screen.getByRole('region', { name: replies })).toBeTruthy();
      expect(screen.getByRole('region', { name: background })).toBeTruthy();
    },
  );
});
