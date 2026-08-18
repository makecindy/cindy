// @vitest-environment jsdom

/**
 * userMessageEditBox.test.ts
 * ---------------------------------------------------------------------------
 * edit-last-message: 编辑框「发送时中断 → 等 idle 接力提交 → 超时兜底 →
 * 取消零副作用」状态机的组件级契约。提交编排本身(rewind/重发/草稿兜底)
 * 由 editLastUserMessage.test.ts 覆盖,这里 mock 掉,只测组件时序。
 */

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn() },
}));

vi.mock('@/lib/httpClient', () => ({
  ApiError: class ApiError extends Error {
    code: string;
    constructor(code: string, _status: number, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock('@/lib/sessionService', () => ({
  rewindPreview: vi.fn(async () => ({
    canRewind: true,
    filesChanged: [] as string[],
    insertions: 0,
    deletions: 0,
  })),
}));

vi.mock('@/lib/editLastUserMessage', () => ({
  commitEditAndResendWithRunningRetry: vi.fn(async () => {}),
}));

import { toast } from '@/lib/toast';
import { rewindPreview } from '@/lib/sessionService';
import { commitEditAndResendWithRunningRetry } from '@/lib/editLastUserMessage';
import { UserMessageEditBox } from '../components/chat/UserMessageEditBox';

const commitMock = commitEditAndResendWithRunningRetry as unknown as ReturnType<typeof vi.fn>;
const previewMock = rewindPreview as unknown as ReturnType<typeof vi.fn>;

function renderBox(overrides: Partial<Parameters<typeof UserMessageEditBox>[0]> = {}) {
  const props = {
    sessionId: 'sess-1',
    messageClientId: 'msg-1',
    initialText: 'original text',
    workingDir: '/repo',
    sessionRunning: false,
    onRequestStop: vi.fn(),
    onCancel: vi.fn(),
    onSent: vi.fn(),
    ...overrides,
  };
  const utils = render(createElement(UserMessageEditBox, props));
  const textarea = utils.container.querySelector('textarea') as HTMLTextAreaElement;
  const buttons = [...utils.container.querySelectorAll('button')];
  const cancelBtn = buttons.find((b) => b.textContent === 'chat.userMessage.editCancel') as HTMLButtonElement;
  const sendBtn = buttons.find((b) => b.textContent?.includes('chat.userMessage.editSend')) as HTMLButtonElement;
  return { ...utils, props, textarea, cancelBtn, sendBtn };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('UserMessageEditBox — idle 发送', () => {
  it('idle 时点发送:直接提交(不触发 onRequestStop),成功后 onSent', async () => {
    const { props, textarea, sendBtn } = renderBox();
    fireEvent.change(textarea, { target: { value: 'edited' } });
    fireEvent.click(sendBtn);

    await waitFor(() => expect(props.onSent).toHaveBeenCalledTimes(1));
    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(commitMock.mock.calls[0][0]).toMatchObject({
      sessionId: 'sess-1',
      clientId: 'msg-1',
      text: 'edited',
      fallbackWorkingDir: '/repo',
    });
    expect(props.onRequestStop).not.toHaveBeenCalled();
  });

  it('引用编辑框隐藏 marker，未修改时仍提交保序原文，修改后只提交可见文本', async () => {
    const encoded = '> <!-- cindy-composer-quote -->\n> quoted\n\nreply';
    const visible = '> quoted\n\nreply';
    const first = renderBox({ initialText: visible, initialSubmitText: encoded, quotesEncoded: true });
    expect(first.textarea.value).toBe(visible);
    expect(first.textarea.value).not.toContain('cindy-composer-quote');
    fireEvent.click(first.sendBtn);
    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    expect(commitMock.mock.calls[0][0].text).toBe(encoded);
    expect(commitMock.mock.calls[0][0].quotesEncoded).toBe(true);
    first.unmount();

    vi.clearAllMocks();
    const second = renderBox({ initialText: visible, initialSubmitText: encoded, quotesEncoded: true });
    fireEvent.change(second.textarea, { target: { value: 'edited reply' } });
    fireEvent.click(second.sendBtn);
    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    expect(commitMock.mock.calls[0][0].text).toBe('edited reply');
    expect(commitMock.mock.calls[0][0].quotesEncoded).toBeUndefined();
  });

  it('被拦消息覆盖重发仅在引用正文未修改时透传 quote metadata', async () => {
    const encoded = '> <!-- cindy-composer-quote -->\n> quoted\n\nreply';
    const visible = '> quoted\n\nreply';
    const firstOverride = vi.fn(async () => {});
    const first = renderBox({
      initialText: visible,
      initialSubmitText: encoded,
      quotesEncoded: true,
      onCommitOverride: firstOverride,
    });
    fireEvent.click(first.sendBtn);
    await waitFor(() => expect(firstOverride).toHaveBeenCalledWith({
      text: encoded,
      quotesEncoded: true,
    }));
    first.unmount();

    const editedOverride = vi.fn(async () => {});
    const second = renderBox({
      initialText: visible,
      initialSubmitText: encoded,
      quotesEncoded: true,
      onCommitOverride: editedOverride,
    });
    fireEvent.change(second.textarea, { target: { value: 'edited reply' } });
    fireEvent.click(second.sendBtn);
    await waitFor(() => expect(editedOverride).toHaveBeenCalledWith({ text: 'edited reply' }));
  });

  it('文本未修改时保留语义引用与 chip ranges，文本修改后丢弃', async () => {
    const agentReferences = [{
      kind: 'session' as const,
      start: 0,
      end: 13,
      href: 'cindy://session/source',
      sessionId: 'source',
    }];
    const ranges = {
      agentReferences,
      pastedTextRanges: [{ start: 0, end: 13, display: 'Pasted text (1 line)' }],
      slashCommandRanges: [] as [],
    };
    const first = renderBox({ initialText: 'original text', ...ranges });
    fireEvent.click(first.sendBtn);
    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    expect(commitMock.mock.calls[0][0]).toMatchObject({
      text: 'original text',
      agentReferences,
      pastedTextRanges: ranges.pastedTextRanges,
      slashCommandRanges: [],
    });
    first.unmount();

    vi.clearAllMocks();
    const second = renderBox({ initialText: 'original text', ...ranges });
    fireEvent.change(second.textarea, { target: { value: 'edited text' } });
    fireEvent.click(second.sendBtn);
    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    expect(commitMock.mock.calls[0][0].agentReferences).toBeUndefined();
    expect(commitMock.mock.calls[0][0].pastedTextRanges).toBeUndefined();
    expect(commitMock.mock.calls[0][0].slashCommandRanges).toBeUndefined();
  });

  it('未确认的 /skill: 散文被用户删掉前缀后不再静默改回 runtime 名', async () => {
    const box = renderBox({
      initialText: '/skill:unknown is prose',
      slashCommandRanges: [],
    });
    fireEvent.change(box.textarea, { target: { value: '/unknown is prose' } });
    fireEvent.click(box.sendBtn);
    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    expect(commitMock.mock.calls[0][0].text).toBe('/unknown is prose');
    expect(commitMock.mock.calls[0][0].slashCommandRanges).toBeUndefined();
  });

  it('后文已确认的命令 range 不会让首行未确认的 /skill: 散文被改回', async () => {
    const original = '/skill:unknown\n/help later';
    const helpStart = original.indexOf('/help');
    const box = renderBox({
      initialText: original,
      initialSubmitText: original,
      slashCommandRanges: [{ start: helpStart, end: helpStart + 5 }],
    });
    fireEvent.change(box.textarea, { target: { value: '/unknown\n/help later' } });
    fireEvent.click(box.sendBtn);
    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    expect(commitMock.mock.calls[0][0].text).toBe('/unknown\n/help later');
    expect(commitMock.mock.calls[0][0].slashCommandRanges).toBeUndefined();
  });

  it('已确认 range 覆盖的 Pi skill 编辑后仍恢复 runtime 名', async () => {
    const box = renderBox({
      initialText: '/git please',
      initialSubmitText: '/skill:git please',
      slashCommandRanges: [{ start: 0, end: 10 }],
    });
    fireEvent.change(box.textarea, { target: { value: '/git review' } });
    fireEvent.click(box.sendBtn);
    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    expect(commitMock.mock.calls[0][0].text).toBe('/skill:git review');
    expect(commitMock.mock.calls[0][0].slashCommandRanges).toEqual([{ start: 0, end: 10 }]);
  });

  it('引用 marker 落库坐标仍能恢复可见 /git',
    async () => {
    const wire = [
      '> <!-- cindy-composer-quote -->',
      '> quoted',
      '',
      '/skill:git follow-up',
    ].join('\n');
    const skillStart = wire.indexOf('/skill:git');
    const box = renderBox({
      initialText: 'quoted\n\n/git follow-up',
      initialSubmitText: wire,
      quotesEncoded: true,
      slashCommandRanges: [{ start: skillStart, end: skillStart + 10 }],
    });
    fireEvent.change(box.textarea, { target: { value: 'quoted\n\n/git please' } });
    fireEvent.click(box.sendBtn);
    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    expect(commitMock.mock.calls[0][0].text).toBe('quoted\n\n/skill:git please');
  });

  it('被拦消息覆盖重发在文本未修改时透传语义引用与 chip ranges', async () => {
    const override = vi.fn(async () => {});
    const agentReferences = [{
      kind: 'session' as const,
      start: 0,
      end: 13,
      href: 'cindy://session/source',
      sessionId: 'source',
    }];
    const ranges = {
      agentReferences,
      pastedTextRanges: [{ start: 0, end: 13, display: 'Pasted text (1 line)' }],
      slashCommandRanges: [] as [],
    };
    const box = renderBox({
      initialText: 'original text',
      onCommitOverride: override,
      ...ranges,
    });
    fireEvent.click(box.sendBtn);
    await waitFor(() =>
      expect(override).toHaveBeenCalledWith({
        text: 'original text',
        agentReferences,
        pastedTextRanges: ranges.pastedTextRanges,
        slashCommandRanges: [],
      }),
    );
  });

  it('提交挂起期间重复点发送不会二次提交(同步 ref 防重入)', async () => {
    let release: () => void = () => {};
    commitMock.mockImplementationOnce(
      () => new Promise<void>((r) => { release = r; }),
    );
    const { props, sendBtn } = renderBox();
    fireEvent.click(sendBtn);
    fireEvent.click(sendBtn);
    fireEvent.click(sendBtn);
    expect(commitMock).toHaveBeenCalledTimes(1);
    await act(async () => release());
    await waitFor(() => expect(props.onSent).toHaveBeenCalledTimes(1));
  });

  it('空文本(无附件)发送按钮禁用', () => {
    const { textarea, sendBtn } = renderBox();
    fireEvent.change(textarea, { target: { value: '   ' } });
    expect(sendBtn.disabled).toBe(true);
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('提交失败:toast 报错、保持编辑态(不 onSent),可重试', async () => {
    commitMock.mockRejectedValueOnce(new Error('boom'));
    const { props, sendBtn } = renderBox();
    fireEvent.click(sendBtn);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('chat.userMessage.editFailed'),
    );
    expect(props.onSent).not.toHaveBeenCalled();
    // 失败后守卫复位,可再次发送
    fireEvent.click(sendBtn);
    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(2));
  });
});

describe('UserMessageEditBox — 运行中发送(停止时机在发送时刻)', () => {
  it('running 时点发送:先 onRequestStop,不提交;sessionRunning 翻 false 后接力提交', async () => {
    const { props, sendBtn, rerender } = renderBox({ sessionRunning: true });
    fireEvent.click(sendBtn);

    expect(props.onRequestStop).toHaveBeenCalledTimes(1);
    expect(commitMock).not.toHaveBeenCalled();

    // stop 完成 → renderer 观察到 idle → effect 接力提交
    rerender(createElement(UserMessageEditBox, { ...props, sessionRunning: false }));
    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(props.onSent).toHaveBeenCalledTimes(1));
  });

  it('等待停止超时(15s):toast 报错、退回编辑态、不提交', async () => {
    vi.useFakeTimers();
    const { props, sendBtn } = renderBox({ sessionRunning: true });
    fireEvent.click(sendBtn);
    expect(props.onRequestStop).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(toast.error).toHaveBeenCalledWith('chat.userMessage.editStopTimeout');
    expect(commitMock).not.toHaveBeenCalled();
    expect(props.onSent).not.toHaveBeenCalled();
    // 兜底后守卫复位:发送按钮回到可用态
    expect(sendBtn.disabled).toBe(false);
  });

  it('running 时进入编辑不触发 preview;翻 false 后重跑 preview 补提示', async () => {
    const { props, rerender } = renderBox({ sessionRunning: true });
    expect(previewMock).not.toHaveBeenCalled();

    rerender(createElement(UserMessageEditBox, { ...props, sessionRunning: false }));
    await waitFor(() => expect(previewMock).toHaveBeenCalledTimes(1));
  });
});

describe('UserMessageEditBox — 取消与键盘', () => {
  it('取消不产生额外副作用:onCancel 触发,不再 stop、不提交(点铅笔时的中断由 UserMessage 负责,取消后 AI 不恢复是既定语义)', () => {
    const { props, cancelBtn } = renderBox({ sessionRunning: true });
    fireEvent.click(cancelBtn);
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onRequestStop).not.toHaveBeenCalled();
    expect(commitMock).not.toHaveBeenCalled();
  });


  it('Enter 提交,Shift+Enter 不提交,IME 组合中的 Enter 不提交,Esc 取消', async () => {
    const { props, textarea } = renderBox();
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(commitMock).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    expect(commitMock).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(props.onCancel).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
  });

  it('preview 报告文件改动时渲染回滚提示', async () => {
    previewMock.mockResolvedValueOnce({
      canRewind: true,
      filesChanged: ['a.ts', 'b.ts'],
      insertions: 3,
      deletions: 1,
    });
    const { findByText } = renderBox();
    expect(await findByText('chat.userMessage.editRollbackHint')).toBeTruthy();
  });
});
