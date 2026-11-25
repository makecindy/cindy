// @vitest-environment jsdom
/** Renderer unit: the canvas tests route actions; these card-level cases exercise the
 * click/double-click race, rejected native receipts and IME edits across card roles. */
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DagNodeCard } from '../DagNodeCard';
import { ChildDraftCard } from '../ChildDraftCard';
import type { DagNode } from '../types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const node: DagNode = { id: 'n', sessionId: 's', parentId: null, question: '原始问题', answer: '## 原始回答' };
function history(extra: Partial<Parameters<typeof DagNodeCard>[0]> = {}) {
  return <DagNodeCard node={node} versions={[{ ...node, key: 'origin', manual: false }]}
    selectedVersionKey="origin" outgoingReferences={[]} selected onSelectVersion={vi.fn()} onOpen={vi.fn()}
    onPreviewAction={vi.fn()} onStartBranchDrag={vi.fn()} consumeDragClick={() => false}
    onRemoveReference={vi.fn()} onCardPointerDown={vi.fn()} onNudge={vi.fn()} {...extra} />;
}
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('单击打开一次，双击问题只编辑；取消不重问，双击回答不能进入编辑', () => {
  vi.useFakeTimers();
  const onOpen = vi.fn(), onResubmit = vi.fn();
  render(history({ onOpen, onResubmit }));
  const question = screen.getByRole('button', { name: /打开原生对话/ });
  fireEvent.click(question, { detail: 1 });
  act(() => vi.runAllTimers());
  expect(onOpen).toHaveBeenCalledTimes(1);
  fireEvent.click(question, { detail: 1 });
  fireEvent.click(question, { detail: 2 });
  fireEvent.doubleClick(question);
  act(() => vi.runAllTimers());
  expect(onOpen).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByRole('textbox', { name: '编辑本卡问题' }), { target: { value: '未提交' } });
  expect(screen.getByRole('heading', { name: '原始回答' })).toBeTruthy();
  fireEvent.click(screen.getByText('取消'));
  fireEvent.doubleClick(screen.getByRole('heading'));
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByRole('button', { name: /打开原生对话/ }).textContent).toBe(node.question);
  expect(onResubmit).not.toHaveBeenCalled();
});

it('重问等待原生回执；失败保留内容，再试沿用原操作 ID', async () => {
  let reject!: (error: Error) => void;
  const onResubmit = vi.fn<(question: string, id: string) => Promise<void>>()
    .mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; })).mockResolvedValue(undefined);
  render(history({ onResubmit }));
  fireEvent.keyDown(screen.getByRole('button', { name: /打开原生对话/ }), { key: 'F2' });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '改过的问题' } });
  fireEvent.click(screen.getByText('重新提问'));
  const pending = screen.getByRole('button', { name: '提交中…' }) as HTMLButtonElement;
  expect(pending.disabled).toBe(true);
  fireEvent.click(pending);
  expect(onResubmit).toHaveBeenCalledTimes(1);
  await act(async () => { reject(new Error('尚未受理')); });
  expect(screen.getByRole('alert').textContent).toBe('尚未受理');
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('改过的问题');
  await act(async () => { fireEvent.click(screen.getByText('重新提问')); });
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(onResubmit.mock.calls[0]).toEqual(['改过的问题', expect.any(String)]);
  expect(onResubmit.mock.calls[1]).toEqual(onResubmit.mock.calls[0]);
});

it.each([
  ['为什么登录页在320宽度下会横向滚动？给我结论和改法。', '登录页横滚'],
  ['为什么结算页面在低带宽环境中会白屏？', '结算页白屏'],
  ['徒步路线怎么选？', '徒步路线'], ['走山脊线要多久？', '山脊线'],
  ['How do I fix the cache after restart?', 'cache'], ['怎么选？', '节点'],
])('将 %s 显示为主题名而非原问句', (question, name) => {
  render(history({ versions: [{ question, answer: '', key: 'origin', manual: false }] }));
  expect(screen.getByRole('button', { name: `节点名：${name}` })).toBeTruthy();
});

it('仅保存只回传问题，不重问；节点名剔除开场白与 Markdown 标记', async () => {
  const onSaveQuestion = vi.fn(), onResubmit = vi.fn();
  const question = '请问，帮我看看 `SQLite`   锁冲突怎么解决';
  render(history({ versions: [{ question, answer: node.answer, key: 'origin', manual: false }], onSaveQuestion, onResubmit }));
  expect(screen.getByRole('button', { name: '节点名：SQLite 锁冲突' })).toBeTruthy();
  fireEvent.doubleClick(screen.getByRole('button', { name: /打开原生对话/ }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '新版本' } });
  await act(async () => { fireEvent.click(screen.getByText('仅保存')); });
  expect(onSaveQuestion).toHaveBeenCalledExactlyOnceWith('新版本');
  expect(onResubmit).not.toHaveBeenCalled();
  expect(screen.queryByRole('textbox')).toBeNull();
});

it('错误卡直接重试原问题，而不是选中的手工修订', async () => {
  const failed: DagNode = { ...node, runState: 'failed' };
  const onRetryFailed = vi.fn(), onPreviewAction = vi.fn(), onOpen = vi.fn();
  render(history({ node: failed, versions: [{ question: '修订', answer: '答', key: 'm', manual: true }],
    selectedVersionKey: 'm', onRetryFailed, onPreviewAction, onOpen }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试原问题' })); });
  expect(onRetryFailed).toHaveBeenCalledExactlyOnceWith(failed);
  expect(onPreviewAction).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
});

it('输入卡与占位卡共用可迁移的覆盖值，组合输入不提前确认或切断字素，清空恢复自动摘要', () => {
  const prefix = '一二三四五六七八九', composed = prefix + '👩‍💻';
  function Family({ status }: { status: 'editing' | 'accepted' | 'history' }) {
    const [summary, onSummaryChange] = useState('');
    return status === 'history' ? history({ summary, onSummaryChange }) : (
      <ChildDraftCard id="d" parentId="p" point={{ x: 0, y: 0 }} question={node.question} status={status}
        summary={summary} onSummaryChange={onSummaryChange} onDragBlank={vi.fn()} onOpen={vi.fn()}
        onChange={vi.fn()} onCancel={vi.fn()} onAsk={vi.fn()} onError={vi.fn()} />
    );
  }
  const { rerender } = render(<Family status="editing" />);
  fireEvent.click(screen.getByRole('button', { name: `节点名：${node.question}` }));
  const input = screen.getByRole('textbox', { name: '编辑节点名' }) as HTMLInputElement;
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: composed + '十一' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(input.value).toBe(composed + '十一');
  fireEvent.compositionEnd(input);
  expect(input.value).toBe(composed);
  fireEvent.keyDown(input, { key: 'Enter' });
  for (const status of ['accepted', 'history'] as const) {
    rerender(<Family status={status} />);
    expect(screen.getByRole('button', { name: `节点名：${composed}` })).toBeTruthy();
  }
  fireEvent.click(screen.getByRole('button', { name: `节点名：${composed}` }));
  const reset = screen.getByRole('textbox', { name: '编辑节点名' });
  fireEvent.change(reset, { target: { value: '' } });
  fireEvent.blur(reset);
  expect(screen.getByRole('button', { name: `节点名：${node.question}` })).toBeTruthy();
});
