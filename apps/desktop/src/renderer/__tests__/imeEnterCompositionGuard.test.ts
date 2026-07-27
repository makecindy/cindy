// @vitest-environment jsdom

/**
 * imeEnterCompositionGuard.test.ts
 * ---------------------------------------------------------------------------
 * 回归覆盖(IME 组合期间的 Enter 不得触发提交):
 * - AskUserQuestionPrompt 的自定义输入框/自由输入框:中文输入法组合中按 Enter
 *   (isComposing=true, 确认候选词)只上屏、不发送;组合结束后的 Enter 才提交。
 * - PermissionPrompt 的全局 Enter 快捷键:组合中的 Enter 不算授权;焦点在
 *   可编辑元素上时 Enter/Escape 不被劫持为授权决定。
 * - SessionRenameInput(会话重命名共享组件):组合中的 Enter 不提交重命名。
 */

import { createElement } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type { PendingAskUser } from '@/lib/makerChatStore';
import { AskUserQuestionPrompt } from '../components/new-chat/AskUserQuestionPrompt';
import { PermissionPrompt } from '../components/new-chat/PermissionPrompt';
import { SessionRenameInput } from '../features/cc-agent/SessionRenameInput';

vi.mock('@/lib/makerTransport', () => ({
  regenerateSessionTitleFor: vi.fn(),
}));

afterEach(() => {
  cleanup();
});

function renderAskUser(pending: PendingAskUser, onAnswer: (requestId: string, answers: Record<string, string>) => void) {
  return render(createElement(AskUserQuestionPrompt, {
    pending,
    onAnswer,
    viewerState: 'expanded',
    onViewerStateChange: () => {},
    draft: null,
    onDraftChange: () => {},
  }));
}

describe('AskUserQuestionPrompt IME Enter guard', () => {
  it('custom input: composing Enter does not submit, plain Enter does', () => {
    const onAnswer = vi.fn();
    const { getByText, getByPlaceholderText } = renderAskUser(
      {
        requestId: 'req-1',
        questions: [{ question: 'Pick one?', options: [{ label: 'A' }, { label: 'B' }] }],
      },
      onAnswer,
    );

    fireEvent.click(getByText('Type something else...'));
    const input = getByPlaceholderText('Type your answer...');
    fireEvent.change(input, { target: { value: 'hello' } });

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onAnswer).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith('req-1', { 'Pick one?': 'hello' });
  });

  it('free-text input (no options): composing Enter does not submit', () => {
    const onAnswer = vi.fn();
    const { getByPlaceholderText } = renderAskUser(
      { requestId: 'req-2', questions: [{ question: 'Say something?' }] },
      onAnswer,
    );

    const input = getByPlaceholderText('Type your answer...');
    fireEvent.change(input, { target: { value: '你好' } });

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onAnswer).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith('req-2', { 'Say something?': '你好' });
  });
});

describe('PermissionPrompt global Enter guard', () => {
  const permission = {
    requestId: 'perm-1',
    toolName: 'Bash',
    input: { command: 'ls' },
  };

  it('composing Enter is not treated as allow-once', () => {
    const onRespond = vi.fn();
    render(createElement(PermissionPrompt, { permission, onRespond }));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
    expect(onRespond).not.toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'allow' }));
  });

  it('Enter/Escape from an editable element are not hijacked', () => {
    const onRespond = vi.fn();
    render(createElement(PermissionPrompt, { permission, onRespond }));

    const outsideInput = document.createElement('input');
    document.body.appendChild(outsideInput);
    try {
      outsideInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      outsideInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(onRespond).not.toHaveBeenCalled();
    } finally {
      outsideInput.remove();
    }
  });
});

describe('SessionRenameInput IME Enter guard', () => {
  it('composing Enter does not commit rename, plain Enter does', () => {
    const onCommit = vi.fn();
    const { container } = render(createElement(SessionRenameInput, {
      sessionId: 's1',
      value: '新标题',
      onValueChange: () => {},
      onCommit,
      onCancel: () => {},
    }));

    const input = container.querySelector('input');
    expect(input).not.toBeNull();
    fireEvent.keyDown(input!, { key: 'Enter', isComposing: true });
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.keyDown(input!, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('新标题');
  });
});
