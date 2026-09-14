import { describe, expect, it } from 'vitest';
import {
  countMobileRenderItemDiffs,
  isToolErrorLike,
  summarizeTodoCardPresentation,
  summarizeToolGroupPresentation,
  summarizeToolRowPresentation,
  summarizeWorkGroupPresentation,
  todoStatusPresentation,
} from '@/session/messagePresentation';
import type { NormalizedRemoteMessage } from '@/session/messageNormalize';
import type {
  MobileToolGroupItem,
  MobileWorkGroupItem,
} from '@/session/messageRenderModel';
import type { RemoteMessage } from '@/session/types';

function source(id: string, content: unknown = {}): RemoteMessage {
  return {
    id,
    clientId: id,
    sessionId: 's1',
    role: 'tool_use',
    content,
    toolUseId: id,
    agentMeta: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function tool(id: string, patch: Partial<NormalizedRemoteMessage> = {}): NormalizedRemoteMessage {
  return {
    key: id,
    source: source(id),
    kind: 'tool',
    role: 'tool_use',
    label: 'Bash',
    body: 'Bash(pnpm test)',
    align: 'agent',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

describe('messagePresentation', () => {
  it('summarizes tool groups as desktop-style headers without mobile detail badges', () => {
    const group: MobileToolGroupItem = {
      type: 'tool_group',
      key: 'tools-1',
      tools: [
        tool('bash-1', { secondaryBody: '{"ok":false,"error":"boom"}' }),
        tool('edit-1', {
          label: 'Edit',
          body: 'Edit(/repo/app.ts)',
          diff: {
            filePath: '/repo/app.ts',
            insertions: 2,
            deletions: 1,
            segments: [{ key: 'edit:0', oldString: 'old', newString: 'new' }],
          },
        }),
        tool('media-1', {
          label: 'Mivo',
          media: [{ kind: 'image', url: 'xdt-image://1', previewable: false }],
          secondaryBody: '{"xdt_image_url":"xdt-image://1"}',
        }),
      ],
    };

    expect(summarizeToolGroupPresentation(group)).toEqual({
      title: '编辑 1 个文件、运行 1 条命令 和 调用 1 个工具',
      hasRunning: false,
      header: {
        chevronPosition: 'trailing',
        chevronSize: 14,
        defaultExpanded: false,
        iconSize: 14,
        summaryCount: 0,
        subtitle: null,
        title: '编辑 1 个文件、运行 1 条命令 和 调用 1 个工具',
        variant: 'plain',
      },
    });

    expect(summarizeToolRowPresentation(group.tools[2])).toEqual({
      hasError: false,
      label: '调用 Mivo',
      status: 'done',
    });
  });

  it('matches desktop agent action verb ordering for tool summaries', () => {
    const group: MobileToolGroupItem = {
      type: 'tool_group',
      key: 'tools-ordered',
      tools: [
        tool('grep-1', { label: 'Grep' }),
        tool('bash-1', { label: 'Bash' }),
        tool('read-1', { label: 'Read' }),
        tool('edit-1', { label: 'Edit' }),
        tool('write-1', { label: 'Write' }),
        tool('todo-1', { label: 'TodoWrite' }),
        tool('web-1', { label: 'WebSearch' }),
        tool('custom-1', { label: 'CustomTool' }),
      ],
    };

    expect(summarizeToolGroupPresentation(group).title).toBe(
      '编辑 1 个文件、运行 1 条命令、读取 1 个文件、更新待办、创建 1 个文件 和 另外 3 项',
    );
  });

  it('summarizes todos through the mobile adapter boundary', () => {
    const todo = {
      type: 'todo' as const,
      key: 'todo-1',
      createdAt: '2026-01-01T00:00:01.000Z',
      todos: [
        { content: 'Inspect', status: 'completed' as const },
        { content: 'Patch', status: 'in_progress' as const },
        { content: 'Verify', status: 'pending' as const },
      ],
    };

    expect(summarizeTodoCardPresentation(todo)).toMatchObject({
      activeContent: 'Patch',
      completed: 1,
      defaultExpanded: true,
      header: {
        chevronPosition: 'leading',
        chevronSize: 14,
        defaultExpanded: true,
        iconSize: 16,
        summaryCount: 3,
        subtitle: null,
        title: '1/3 · Patch',
        variant: 'card',
      },
      title: '1/3 · Patch',
      total: 3,
    });
    expect(todoStatusPresentation('completed')).toEqual({ status: 'completed' });
  });

  it('detects common textual and structured tool failures', () => {
    expect(isToolErrorLike(tool('json', { secondaryBody: '{"status":"failed"}' }))).toBe(true);
    expect(isToolErrorLike(tool('text', { secondaryBody: 'process exited with exit code 2' }))).toBe(true);
    expect(isToolErrorLike(tool('ok', { secondaryBody: '{"ok":true}' }))).toBe(false);
  });

  it('summarizes folded work groups with only the desktop summary row visible', () => {
    const editTool = tool('edit-1', {
      diff: {
        filePath: '/repo/app.ts',
        insertions: 1,
        deletions: 1,
        segments: [{ key: 'edit:0', oldString: 'old', newString: 'new' }],
      },
    });
    const workGroup: MobileWorkGroupItem = {
      type: 'work_group',
      key: 'work-1',
      durationMs: 65_000,
      children: [
        {
          type: 'thinking',
          key: 'thinking-1',
          message: tool('thinking-1', { kind: 'thinking', role: 'thinking', body: 'thinking' }),
          redacted: false,
        },
        {
          type: 'tool_group',
          key: 'tools-1',
          tools: [
            tool('bash-1', { secondaryBody: 'stderr: failed' }),
            editTool,
          ],
        },
        {
          type: 'todo',
          key: 'todo-1',
          createdAt: '2026-01-01T00:00:01.000Z',
          todos: [
            { content: 'Inspect', status: 'completed' },
            { content: 'Patch', status: 'in_progress' },
          ],
        },
      ],
    };

    expect(summarizeWorkGroupPresentation(workGroup)).toEqual({
      title: 'Worked for 1m 5s',
      subtitle: '',
      header: {
        chevronPosition: 'trailing',
        chevronSize: 14,
        defaultExpanded: false,
        iconSize: 14,
        summaryCount: 0,
        subtitle: null,
        title: 'Worked for 1m 5s',
        variant: 'plain',
      },
    });

    expect(countMobileRenderItemDiffs([
      { type: 'tool_group', key: 'plain-tools', tools: [editTool] },
      workGroup,
    ])).toBe(2);
  });
});
