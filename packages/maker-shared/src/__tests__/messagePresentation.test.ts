import { describe, expect, it } from 'vitest';
import {
  buildMessageActionBarPresentation,
  countMessageRenderItemDiffs,
  isToolErrorLike,
  summarizeToolUseText,
  summarizeMessageBubblePresentation,
  summarizeTodoCardPresentation,
  summarizeToolGroupPresentation,
  summarizeToolRowPresentation,
  summarizeWorkGroupPresentation,
  todoStatusPresentation,
  type ToolRowWording,
} from '../messagePresentation';
import type { PresentationLocalizer } from '../presentationLocalization';
import type {
  MessageRenderNormalizedMessage,
  MessageRenderSourceMessageLike,
  MessageRenderToolGroupItem,
  MessageRenderWorkGroupItem,
} from '../messageRender';

type TestMessage = MessageRenderNormalizedMessage<MessageRenderSourceMessageLike> & {
  diff?: unknown;
  media?: readonly unknown[];
  toolSettled?: boolean;
};

function message(id: string, patch: Partial<TestMessage> = {}): TestMessage {
  return {
    key: id,
    source: { clientId: id, content: {}, createdAt: '2026-01-01T00:00:00.000Z' },
    kind: 'tool',
    label: 'Bash',
    body: 'Bash(pnpm test)',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

describe('messagePresentation', () => {
  it('exposes the same compact tool wording to remote channel previews', () => {
    expect(summarizeToolUseText('Read', { file_path: '/repo/src/app.ts' })).toEqual({
      label: '读取 app.ts',
      detail: '/repo/src/app.ts',
    });
    expect(summarizeToolUseText('exec', {
      command: 'git status --short',
    })).toEqual({
      label: '查看工作区状态',
      detail: 'git status --short',
    });
  });

  it('summarizes message bubble density without adding mobile-only role labels', () => {
    expect(summarizeMessageBubblePresentation({
      align: 'user',
      body: 'ok',
      kind: 'user',
    })).toEqual({
      density: 'compact',
      hasAuxiliaryContent: false,
      isUserAligned: true,
    });

    expect(summarizeMessageBubblePresentation({
      attachmentCount: 1,
      body: '带附件的消息',
      kind: 'assistant',
    })).toEqual({
      density: 'rich',
      hasAuxiliaryContent: true,
      isUserAligned: false,
    });

    expect(summarizeMessageBubblePresentation({
      body: '第一行\n第二行',
      isStreaming: true,
      kind: 'assistant',
    }).density).toBe('standard');
  });

  it('keeps message action bars in desktop order with desktop icon sizing', () => {
    expect(buildMessageActionBarPresentation({
      align: 'agent',
      canCopy: true,
      canFork: true,
      hasMoreActions: true,
      hasTime: true,
      hasTurnCost: true,
      isStreaming: false,
    })).toEqual({
      align: 'left',
      buttonSize: 24,
      iconSize: 14,
      items: ['copy', 'fork', 'more', 'time', 'cost'],
    });

    expect(buildMessageActionBarPresentation({
      align: 'user',
      canCopy: true,
      canFork: true,
      hasMoreActions: true,
      hasTime: true,
      hasTurnCost: true,
      isStreaming: false,
    })).toEqual({
      align: 'right',
      buttonSize: 24,
      iconSize: 14,
      items: ['time', 'copy', 'fork', 'more'],
    });

    expect(buildMessageActionBarPresentation({
      align: 'agent',
      canCopy: true,
      canFork: false,
      hasMoreActions: true,
      hasTime: true,
      hasTurnCost: true,
      isStreaming: true,
    }).items).toEqual(['streaming']);
  });

  it('summarizes tool groups as desktop-style headers without mobile detail badges', () => {
    const group: MessageRenderToolGroupItem<TestMessage> = {
      type: 'tool_group',
      key: 'tools-1',
      tools: [
        message('bash-1', { secondaryBody: '{"ok":false,"error":"boom"}' }),
        message('edit-1', {
          label: 'Edit',
          body: 'Edit(/repo/app.ts)',
          diff: { filePath: '/repo/app.ts' },
        }),
        message('media-1', {
          label: 'Mivo',
          media: [{ kind: 'image', url: 'xdt-image://1' }],
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

  it('matches desktop agent action verb ordering for tool group summaries', () => {
    const group: MessageRenderToolGroupItem<TestMessage> = {
      type: 'tool_group',
      key: 'tools-ordered',
      tools: [
        message('grep-1', { label: 'Grep' }),
        message('bash-1', { label: 'Bash' }),
        message('read-1', { label: 'Read' }),
        message('edit-1', { label: 'Edit' }),
        message('write-1', { label: 'Write' }),
        message('todo-1', { label: 'TodoWrite' }),
        message('web-1', { label: 'WebSearch' }),
        message('custom-1', { label: 'CustomTool' }),
      ],
    };

    expect(summarizeToolGroupPresentation(group).title).toBe(
      '编辑 1 个文件、运行 1 条命令、读取 1 个文件、更新待办、创建 1 个文件 和 另外 3 项',
    );
  });

  it('counts Codex file_change as an edited file action', () => {
    const group: MessageRenderToolGroupItem<TestMessage> = {
      type: 'tool_group',
      key: 'tools-file-change',
      tools: [message('file-change-summary', { label: 'file_change' })],
    };
    expect(summarizeToolGroupPresentation(group).title).toBe('编辑 1 个文件');
  });

  it('renders humanized tool row labels from tool_use descriptors (issue #450 mobile)', () => {
    // Bash 带模型 description:独立成句,命令原文降为次要细节。
    expect(summarizeToolRowPresentation(message('bash-desc', {
      source: {
        clientId: 'bash-desc',
        content: {
          toolName: 'Bash',
          input: { command: 'rg -n useMemo src/renderer | head -40', description: '搜索 useMemo 的使用位置' },
        },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    }))).toMatchObject({
      label: '搜索 useMemo 的使用位置',
      detail: 'rg -n useMemo src/renderer | head -40',
    });

    // codex exec 无 description:commandActions 意图 → 意图动词 + 目标。
    expect(summarizeToolRowPresentation(message('exec-intent', {
      label: 'exec',
      source: {
        clientId: 'exec-intent',
        content: {
          toolName: 'exec',
          input: {
            command: 'rg -n useMemo src/renderer',
            commandActions: [{ type: 'search', query: 'useMemo', path: 'src/renderer', command: 'rg' }],
          },
        },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    }))).toMatchObject({
      label: '搜索 useMemo',
      detail: 'rg -n useMemo src/renderer',
    });

    // 本地规则兜底(Claude 漏填 description):cat → 读取 <文件名>。
    expect(summarizeToolRowPresentation(message('bash-cat', {
      source: {
        clientId: 'bash-cat',
        content: { toolName: 'Bash', input: { command: 'cat src/app.ts' } },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    })).label).toBe('读取 app.ts');

    const compositeCases = [
      ["rg -n send src && sed -n '1,80p' src/register.ts", '查阅内容'],
      ['git status --short && git diff --stat', '检查仓库'],
      ['pnpm typecheck && pnpm test', '运行验证'],
    ] as const;
    for (const [command, label] of compositeCases) {
      expect(summarizeToolRowPresentation(message(`bash-${label}`, {
        source: {
          clientId: `bash-${label}`,
          content: { toolName: 'Bash', input: { command } },
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      })).label).toBe(label);
    }

    // Git 命令使用稳定的人话标题，真实命令留在次行。
    const shortRow = summarizeToolRowPresentation(message('bash-raw', {
      source: {
        clientId: 'bash-raw',
        content: { toolName: 'Bash', input: { command: 'git status' } },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    }));
    expect(shortRow.label).toBe('查看工作区状态');
    expect(shortRow.detail).toBe('git status');

    // 解析不出的命令回退「运行命令」，次行仍保留原文供审计。
    const longCommand = 'docker run --rm -v /repo:/w -w /w node:22 bash -lc "pnpm install --frozen-lockfile && pnpm build"';
    const longRow = summarizeToolRowPresentation(message('bash-long', {
      source: {
        clientId: 'bash-long',
        content: { toolName: 'Bash', input: { command: longCommand } },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    }));
    expect(longRow.label).toBe('运行命令');
    expect(longRow.detail).toBe(longCommand);

    // intent 无 target 时首行只显示完整意图标题，次行保留真实命令。
    const longTestCommand = 'pnpm --filter @cindy/maker-shared exec vitest run src/__tests__/messagePresentation.test.ts --reporter verbose';
    const longIntentRow = summarizeToolRowPresentation(message('bash-long-test', {
      source: {
        clientId: 'bash-long-test',
        content: { toolName: 'Bash', input: { command: longTestCommand } },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    }));
    expect(longIntentRow.label).toBe('运行测试');
    expect(longIntentRow.detail).toBe(longTestCommand);

    // MCP 工具:调用 server · tool(下划线转空格)。
    expect(summarizeToolRowPresentation(message('mcp-1', {
      label: 'mcp__lizi_feishu__read_by_url',
      source: {
        clientId: 'mcp-1',
        content: { toolName: 'mcp__lizi_feishu__read_by_url', input: { url: 'https://example.com' } },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    })).label).toBe('调用 lizi_feishu · read by url');

    // 文件工具:动词 + 文件名,完整路径进 detail。
    expect(summarizeToolRowPresentation(message('read-1', {
      label: 'Read',
      source: {
        clientId: 'read-1',
        content: { toolName: 'Read', input: { file_path: '/repo/src/app.ts' } },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    }))).toMatchObject({
      label: '读取 app.ts',
      detail: '/repo/src/app.ts',
    });

    const fileChangeSource = {
      clientId: 'file-change-1',
      content: {
        toolName: 'file_change',
        input: {
          changes: [{
            path: '/repo/src/old.ts',
            kind: { type: 'update', move_path: '/repo/src/new.ts' },
            diff: '',
          }],
        },
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    expect(summarizeToolRowPresentation(message('file-change-1', {
      label: 'file_change',
      source: fileChangeSource,
    }))).toMatchObject({
      label: '重命名 old.ts → new.ts',
      detail: '/repo/src/old.ts → /repo/src/new.ts',
    });

    expect(summarizeToolRowPresentation(message('file-change-many', {
      label: 'file_change',
      source: {
        ...fileChangeSource,
        clientId: 'file-change-many',
        content: {
          toolName: 'file_change',
          input: {
            changes: [
              { path: '/repo/a.ts', kind: { type: 'update' }, diff: '-a\n+b' },
              { path: '/repo/b.ts', kind: { type: 'add' }, diff: '+b' },
            ],
          },
        },
      },
    }))).toMatchObject({ label: '更新 2 个文件' });
  });

  it('routes all wording channels through an injected ToolRowWording (island i18n)', () => {
    // 假英文表:三个通道(verb / intentVerb / updateFilesLabel)各自可被注入方接管。
    const wording: ToolRowWording = {
      verb: (key) => `verb:${key}`,
      intentVerb: (action) => `intent:${action}`,
      updateFilesLabel: (count) => `updated ${count} files`,
    };

    // verb 通道:file 描述符。
    expect(summarizeToolUseText('Read', { file_path: '/repo/src/app.ts' }, { wording })).toEqual({
      label: 'verb:read app.ts',
      detail: '/repo/src/app.ts',
    });

    // intentVerb 通道:命令意图。
    expect(summarizeToolUseText('exec', { command: 'git status' }, { wording })).toEqual({
      label: 'intent:gitStatus',
      detail: 'git status',
    });

    // verb 通道:无法分类命令回退 runCommand。
    expect(summarizeToolUseText('Bash', {
      command: 'docker run --rm -v /repo:/w node:22 bash -lc "true"',
    }, { wording }).label).toBe('verb:runCommand');

    // updateFilesLabel 通道:fileChange 多文件。
    expect(summarizeToolUseText('file_change', {
      changes: [
        { path: '/repo/a.ts', kind: { type: 'update' }, diff: '-a\n+b' },
        { path: '/repo/b.ts', kind: { type: 'add' }, diff: '+b' },
      ],
    }, { wording }).label).toBe('updated 2 files');

    // verb 通道:todo 槽(灵动岛绑 agentIsland.native.updatingTasks 的注入点)。
    expect(summarizeToolUseText('TodoWrite', { todos: [] }, { wording }).label).toBe('verb:updateTodos');

    // 不注入时默认中文表(mobile / IM 零变化,与上方既有用例同一事实)。
    expect(summarizeToolUseText('TodoWrite', { todos: [] }).label).toBe('更新待办');
  });

  it('marks unsettled tool rows running only while the session is streaming', () => {
    const pending = message('bash-pending', { toolSettled: false });
    const settled = message('bash-done', { toolSettled: true });

    expect(summarizeToolRowPresentation(pending, { isSessionStreaming: true }).status).toBe('running');
    expect(summarizeToolRowPresentation(pending, { isSessionStreaming: false }).status).toBe('done');
    expect(summarizeToolRowPresentation(settled, { isSessionStreaming: true }).status).toBe('done');
    // 无 settled 信号的历史消息恒 done,防永久转圈。
    expect(summarizeToolRowPresentation(message('bash-legacy'), { isSessionStreaming: true }).status).toBe('done');

    const group: MessageRenderToolGroupItem<TestMessage> = {
      type: 'tool_group',
      key: 'tools-running',
      tools: [settled, pending],
    };
    expect(summarizeToolGroupPresentation(group, { isSessionStreaming: true }).hasRunning).toBe(true);
    expect(summarizeToolGroupPresentation(group, { isSessionStreaming: false }).hasRunning).toBe(false);
  });

  it('summarizes todo cards for compact mobile rendering', () => {
    const presentation = summarizeTodoCardPresentation({
      type: 'todo',
      key: 'todo-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      todos: [
        { content: 'Inspect desktop flow', status: 'completed' },
        { content: 'Patch mobile UI', status: 'in_progress', activeForm: 'editing' },
        { content: 'Run visual baseline', status: 'pending' },
        { content: 'Collect Android baseline', status: 'pending' },
      ],
    });

    expect(presentation).toEqual({
      activeContent: 'Patch mobile UI',
      completed: 1,
      defaultExpanded: true,
      header: {
        chevronPosition: 'leading',
        chevronSize: 14,
        defaultExpanded: true,
        iconSize: 16,
        summaryCount: 4,
        subtitle: null,
        title: '1/4 · Patch mobile UI',
        variant: 'card',
      },
      title: '1/4 · Patch mobile UI',
      total: 4,
    });

    expect(todoStatusPresentation('completed')).toEqual({
      status: 'completed',
    });
    expect(todoStatusPresentation('in_progress')).toEqual({ status: 'in_progress' });
    expect(todoStatusPresentation('pending')).toEqual({ status: 'pending' });
  });

  it('detects common textual and structured tool failures', () => {
    expect(isToolErrorLike(message('json', { secondaryBody: '{"status":"failed"}' }))).toBe(true);
    expect(isToolErrorLike(message('text', { secondaryBody: 'process exited with exit code 2' }))).toBe(true);
    expect(isToolErrorLike(message('ok', { secondaryBody: '{"ok":true}' }))).toBe(false);
    // 关闭关键词启发式后只信结构化错误记录。
    expect(isToolErrorLike(message('kw-off', { secondaryBody: 'build failed with error' }), false)).toBe(false);
    expect(isToolErrorLike(message('rec-on', { secondaryBody: '{"status":"failed"}' }), false)).toBe(true);
  });

  it('does not flag content-output tools (read/search/web) as errors by result keywords', () => {
    // Read 的结果是文件内容:文档里出现"失败/error"字样 ≠ 工具失败(实踩:读 PR 模板被标红)。
    const readDoc = summarizeToolRowPresentation(message('read-doc', {
      label: 'Read',
      source: {
        clientId: 'read-doc',
        content: { toolName: 'Read', input: { file_path: '/repo/.github/PULL_REQUEST_TEMPLATE.md' } },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      secondaryBody: '## Checklist\n- [ ] 构建失败时说明原因(error log 摘要)',
    }));
    expect(readDoc.hasError).toBe(false);

    // Grep 搜索 "error" 的命中结果同理不是错误。
    const grepHits = summarizeToolRowPresentation(message('grep-err', {
      label: 'Grep',
      source: {
        clientId: 'grep-err',
        content: { toolName: 'Grep', input: { pattern: 'error' } },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      secondaryBody: 'src/a.ts:12: throw new Error("boom")',
    }));
    expect(grepHits.hasError).toBe(false);

    // 结构化错误记录仍然生效(读文件真失败时 result 是错误 JSON)。
    const readFailed = summarizeToolRowPresentation(message('read-fail', {
      label: 'Read',
      source: {
        clientId: 'read-fail',
        content: { toolName: 'Read', input: { file_path: '/missing.ts' } },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      secondaryBody: '{"status":"failed"}',
    }));
    expect(readFailed.hasError).toBe(true);

    // 真实失败的纯文本形态也要保住:<tool_use_error> 标记 / 首行以失败句式开头。
    const readToolUseError = summarizeToolRowPresentation(message('read-tue', {
      label: 'Read',
      source: {
        clientId: 'read-tue',
        content: { toolName: 'Read', input: { file_path: '/missing.ts' } },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      secondaryBody: '<tool_use_error>File does not exist.</tool_use_error>',
    }));
    expect(readToolUseError.hasError).toBe(true);

    const readEnoent = summarizeToolRowPresentation(message('read-enoent', {
      label: 'Read',
      source: {
        clientId: 'read-enoent',
        content: { toolName: 'Read', input: { file_path: '/missing.ts' } },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      secondaryBody: "Error: ENOENT: no such file or directory, open '/missing.ts'",
    }));
    expect(readEnoent.hasError).toBe(true);

    const fetchFailed = summarizeToolRowPresentation(message('web-fail', {
      label: 'WebFetch',
      source: {
        clientId: 'web-fail',
        content: { toolName: 'WebFetch', input: { url: 'https://example.com' } },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      secondaryBody: 'request failed with status 404',
    }));
    expect(fetchFailed.hasError).toBe(true);

    // 中文失败句式:全角冒号「错误：」也要命中(字符类 U+FF1A + U+003A)。
    const readZhFailed = summarizeToolRowPresentation(message('read-zh-fail', {
      label: 'Read',
      source: {
        clientId: 'read-zh-fail',
        content: { toolName: 'Read', input: { file_path: '/missing.ts' } },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      secondaryBody: '错误：文件不存在',
    }));
    expect(readZhFailed.hasError).toBe(true);

    // 命令类输出仍走关键词启发式(stderr 关键词是真实失败信号)。
    const bashFailed = summarizeToolRowPresentation(message('bash-fail', {
      secondaryBody: 'process exited with exit code 2',
    }));
    expect(bashFailed.hasError).toBe(true);
  });

  it('summarizes folded work groups with only the desktop summary row visible', () => {
    const editTool = message('edit-1', {
      diff: { filePath: '/repo/app.ts' },
    });
    const workGroup: MessageRenderWorkGroupItem<TestMessage> = {
      type: 'work_group',
      key: 'work-1',
      durationMs: 65_000,
      children: [
        {
          type: 'thinking',
          key: 'thinking-1',
          message: message('thinking-1', { kind: 'thinking', body: 'thinking' }),
          redacted: false,
        },
        {
          type: 'tool_group',
          key: 'tools-1',
          tools: [
            message('bash-1', { secondaryBody: 'stderr: failed' }),
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

    expect(summarizeWorkGroupPresentation({ ...workGroup, isStreaming: true })).toMatchObject({
      title: 'Working…',
      header: { title: 'Working…' },
    });

    expect(summarizeWorkGroupPresentation({
      ...workGroup,
      durationMs: undefined,
      isStreaming: false,
    }).title).toBe('Work details');

    expect(countMessageRenderItemDiffs([
      { type: 'tool_group', key: 'plain-tools', tools: [editTool] },
      workGroup,
    ])).toBe(2);
  });

  it('localizes work-group titles and tool-row read verbs through injected i18n', () => {
    const catalogs: Record<string, Record<string, string>> = {
      en: {
        'chat.workGroup.working': 'Working…',
        'chat.workGroup.worked': 'Worked for {{duration}}',
        'chat.workGroup.workDetails': 'Work details',
      },
      'zh-CN': {
        'chat.workGroup.working': '正在工作…',
        'chat.workGroup.worked': '已工作 {{duration}}',
        'chat.workGroup.workDetails': '工作过程',
      },
    };
    const localizerFor = (locale: 'en' | 'zh-CN'): PresentationLocalizer => ({
      translate: (key, fallback, values) => {
        let text = catalogs[locale][key] ?? fallback;
        if (values) {
          for (const [name, value] of Object.entries(values)) {
            text = text.replaceAll(`{{${name}}}`, String(value ?? ''));
          }
        }
        return text;
      },
    });
    const workGroup: MessageRenderWorkGroupItem<TestMessage> = {
      type: 'work_group',
      key: 'work-i18n',
      durationMs: 65_000,
      children: [],
    };
    const readTool = message('read-en', {
      label: 'Read',
      source: {
        clientId: 'read-en',
        content: { toolName: 'Read', input: { file_path: '/repo/src/app.ts' } },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const enWording: ToolRowWording = {
      verb: (key) => (key === 'read' ? 'Read' : `verb:${key}`),
      intentVerb: (action) => `intent:${action}`,
      updateFilesLabel: (count) => `Updated ${count} files`,
    };

    expect(summarizeWorkGroupPresentation(workGroup, localizerFor('en')).title).toBe('Worked for 1m 5s');
    expect(summarizeWorkGroupPresentation({ ...workGroup, isStreaming: true }, localizerFor('en')).title)
      .toBe('Working…');
    expect(summarizeWorkGroupPresentation(workGroup, localizerFor('zh-CN')).title).toBe('已工作 1m 5s');
    expect(summarizeWorkGroupPresentation({ ...workGroup, isStreaming: true }, localizerFor('zh-CN')).title)
      .toBe('正在工作…');

    expect(summarizeToolRowPresentation(readTool).label).toBe('读取 app.ts');
    expect(summarizeToolRowPresentation(readTool, { wording: enWording }).label).toBe('Read app.ts');
    expect(summarizeToolRowPresentation(readTool, { wording: enWording }).label).not.toContain('读取');
  });
});
