// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectBranch,
  DagGraphTools,
  exportGraphMarkdown,
  findGraphMatches,
} from '../DagGraphTools';
import type { DagNode } from '../types';
import { graphArchive } from '../graphArchive';
const nodes: DagNode[] = [
  {
    id: '1',
    parentId: null,
    sessionId: 's',
    question: '如何优化查询',
    answer: '加索引',
    userMessageId: 'u1',
    answerMessageId: 'a1',
  },
  {
    id: '2',
    parentId: '1',
    sessionId: 's',
    question: '缓存方案',
    answer: '使用 LRU',
    userMessageId: 'u2',
    answerMessageId: 'a2',
  },
  {
    id: '3',
    parentId: '2',
    sessionId: 's',
    question: '容量多少',
    answer: '试 100',
    userMessageId: 'u3',
    answerMessageId: 'a3',
  },
];
afterEach(cleanup);
describe('DAG graph tools', () => {
  // Public archive contract: a manual correction, its original answer and a frozen citation must survive export separately.
  it('exports revisions and directed snapshots without turning user text into HTML', () => {
    const corrected = { ...nodes[0], answer: 'PostgreSQL <表>' };
    const input = {
      nodes: [corrected, nodes[1]],
      originalNodes: nodes,
      labels: {},
      selectedVersions: { '1': 'v2' },
      canvasState: {
        positions: {},
        revisions: [
          {
            id: 'v2',
            nodeId: '1',
            question: corrected.question,
            answer: corrected.answer,
            createdAt: 1,
            source: 'manual' as const,
          },
        ],
        references: [
          {
            id: 'ref',
            fromNodeId: '2',
            toNodeId: '1',
            snapshot: { question: '选择？', summary: '确认时的摘录' },
            createdAt: 2,
          },
        ],
      },
    };
    const records = graphArchive(input, 'jsonl')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records[1]).toMatchObject({
      original: { answer: '加索引' },
      selected: { version: 'v2', answer: 'PostgreSQL <表>' },
    });
    expect(records[3]).toMatchObject({
      source: '1',
      target: '2',
      snapshot: { summary: '确认时的摘录' },
    });
    const html = new DOMParser().parseFromString(graphArchive(input, 'html'), 'text/html');
    expect(html.querySelector('#turn-1 pre')?.textContent).toBe(corrected.answer);
    expect(html.querySelector('details')?.textContent).toContain('加索引');
    expect(html.querySelector('li a')?.getAttribute('href')).toBe('#turn-2');
  });
  it('finds text and tag, respecting the tag filter', () => {
    expect(findGraphMatches(nodes, { '3': '待办' }, '容量', '').map((n) => n.id)).toEqual(['3']);
    expect(findGraphMatches(nodes, { '3': '待办' }, '', '待办').map((n) => n.id)).toEqual(['3']);
  });
  it('finds a running turn by visible tool name and preserves its ancestors', async () => {
    const visible = vi.fn();
    const running: DagNode[] = nodes.map((n, i) =>
      i === 1 ? { ...n, runState: 'running', toolText: '读取文档' } : n,
    );
    render(
      <DagGraphTools
        nodes={running}
        labels={{}}
        selectedId={null}
        onLabel={vi.fn()}
        onFocus={vi.fn()}
        onVisible={visible}
      />,
    );
    fireEvent.click(screen.getByLabelText('查找轮次'));
    fireEvent.change(screen.getByLabelText('运行状态'), { target: { value: 'running' } });
    fireEvent.change(screen.getByLabelText('搜索问答或标签'), { target: { value: '文档' } });
    expect(screen.getByRole('status').textContent).toBe('1 个匹配');
    await waitFor(() => expect(visible).toHaveBeenLastCalledWith(new Set(['1', '2'])));
  });
  it('exports an exact path or subtree, excluding ancestors outside the branch', () => {
    expect(collectBranch(nodes, '2', 'path').map((n) => n.id)).toEqual(['1', '2']);
    expect(collectBranch(nodes, '2', 'subtree').map((n) => n.id)).toEqual(['2', '3']);
    const text = exportGraphMarkdown(collectBranch(nodes, '2', 'path'), { '2': '已确认' });
    expect(text).toContain('标签：已确认');
    expect(text).toContain('使用 LRU');
    expect(text).not.toContain('试 100');
  });
  it('jumps to a match and exports from the compact tool without a toolbar row', async () => {
    const focus = vi.fn(),
      visible = vi.fn(),
      label = vi.fn();
    render(
      <DagGraphTools
        nodes={nodes}
        labels={{}}
        selectedId="2"
        onLabel={label}
        onFocus={focus}
        onVisible={visible}
      />,
    );
    expect(visible).toHaveBeenCalledWith(null);
    fireEvent.click(screen.getByLabelText('查找轮次'));
    fireEvent.change(screen.getByLabelText('搜索问答或标签'), { target: { value: '容量' } });
    fireEvent.click(screen.getByLabelText('下一个匹配'));
    expect(focus).toHaveBeenCalledWith('3');
    expect(screen.getByRole('status').textContent).toBe('1 / 1 个匹配');
    fireEvent.click(screen.getByLabelText('标签与导出'));
    fireEvent.change(screen.getByLabelText('节点标签'), { target: { value: '已核对' } });
    fireEvent.click(screen.getByText('保存'));
    expect(label).toHaveBeenCalledWith('2', '已核对');
  });
  it('keeps ancestors visible when filtering by tag', async () => {
    const visible = vi.fn();
    render(
      <DagGraphTools
        nodes={nodes}
        labels={{ '3': '待办' }}
        selectedId={null}
        onLabel={vi.fn()}
        onFocus={vi.fn()}
        onVisible={visible}
      />,
    );
    fireEvent.click(screen.getByLabelText('查找轮次'));
    fireEvent.change(screen.getByLabelText('搜索问答或标签'), { target: { value: 'x' } });
    fireEvent.change(screen.getByDisplayValue('全部'), { target: { value: '待办' } });
    await waitFor(() => expect(visible).toHaveBeenLastCalledWith(new Set(['1', '2', '3'])));
  });
});
