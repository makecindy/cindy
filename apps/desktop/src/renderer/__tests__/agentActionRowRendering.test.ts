// @vitest-environment jsdom

/**
 * agentActionRowRendering.test.ts
 * ---------------------------------------------------------------------------
 * issue #450 — AgentActionRow / AgentActionsBlock 的 DOM 级渲染断言(jsdom +
 * testing-library),覆盖源码扫描测试覆盖不到的「实际渲染出什么」:
 *
 *   - Bash 有 description:description 独立成句、动词 label 隐藏、hover
 *     title = 命令原文
 *   - 无 description(codex exec / 模型漏填):动词 + 命令回退
 *   - MCP 行:`server · tool` 人话形态
 *   - 状态图标:running spinner / done 灰勾(经 aria-label);块头 Bot ↔
 *     spinner 切换;settledIds(orca 隐藏结果)按 done 渲染
 *   - 友好命令不重复显示次行，点击后仍可查看命令原文
 *   - Codex file_change 与 Claude 文件编辑共用 diff lightbox
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { i18n } from '../i18n';

const ghostFixtures = vi.hoisted(() => ({ ghosts: [] as unknown[] }));
const openFileMenuAt = vi.hoisted(() => vi.fn());
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({
  useInstalledGhosts: () => ghostFixtures.ghosts,
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  // Image delivery uses production translations; other rows retain stable key-based assertions.
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      key.startsWith('chat.imageDelivery.')
        ? i18n.t(key, { lng: 'en' })
        : options && typeof options.count === 'number'
          ? `${key}:${String(options.count)}`
          : options && typeof options.size === 'string'
            ? `${key}:${options.size}`
            : key,
  }),
}));

// Lightbox 家族与文件 chip 菜单只在交互后出现,渲染测试不涉及 — mock 掉,
// 避免拖进重型依赖(DiffView / 文稿浏览器)。
vi.mock('@/components/chat/TextLightbox', () => ({
  formatBytes: (bytes: number) => `${bytes / 1024} KB`,
  TextLightbox: () => null,
}));
vi.mock('@/components/chat/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('@/components/chat/ToolPayloadLightbox', () => ({
  ToolPayloadLightbox: ({ payload }: { payload: unknown }) => JSON.stringify(payload),
}));
vi.mock('@/components/chat/useFileChipContextMenu', () => ({
  useFileChipContextMenu: () => ({
    menu: null,
    onContextMenu: () => {},
    onActivate: (_event: unknown, openDefault: () => void) => openDefault(),
    openAt: openFileMenuAt,
  }),
}));
vi.mock('@/lib/filePreview', () => ({ shouldOpenTextLightbox: async () => false }));
vi.mock('@/lib/localPathResolver', () => ({ toLocalFileUrl: (p: string) => `xdt-file://${p}` }));

import { AgentActionRow, humanizeDocumentToolResult } from '@/components/chat/AgentActionRow';
import { ChatSessionFileProvider } from '@/components/chat/ChatSessionFileContext';
import { AgentActionsBlock } from '@/components/chat/AgentActionsBlock';
import { __test_internals as expandMemory } from '@/hooks/useExpandedBlockMemory';
import type { ChatMessage } from '@/lib/makerChatStore';

afterEach(cleanup);
// useExpandedBlockMemory 是 module-level 内存态,blockId(agent:<clientId>)
// 相同会让展开状态跨用例泄漏 — 每个用例前清空。
beforeEach(() => {
  expandMemory.reset();
  ghostFixtures.ghosts = [];
  openFileMenuAt.mockClear();
});

const mkTool = (id: string, toolName: string, toolInput: unknown): ChatMessage => ({
  clientId: id,
  role: 'tool_use',
  content: '',
  toolUseId: `tu-${id}`,
  toolName,
  toolInput,
});

it.each(['ContextMenu', 'F10'])('passes the focused tool row to its file menu (%s)', (key) => {
  render(createElement(AgentActionRow, {
    message: mkTool('read-file', 'Read', { file_path: '/repo/example.ts' }),
  }));
  const row = screen.getByRole('button');
  row.focus();
  fireEvent.keyDown(row, { key, shiftKey: key === 'F10' });
  expect(openFileMenuAt).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), row);
});

describe('AgentActionRow — ghost_call 插件名称', () => {
  const root = {
    manifest: { id: 'helper', name: 'Root Helper' },
    namespace: null,
    instanceKey: '_root__helper',
  };
  const organization = {
    manifest: { id: 'helper', name: 'Organization Helper' },
    namespace: 'acme',
    instanceKey: '_ns__acme__helper',
  };
  const renderCall = (ghostId: string, namespace?: string | null) => {
    const toolInput = namespace === undefined
      ? { ghost_id: ghostId, tool: 'echo' }
      : { ghost_id: ghostId, namespace, tool: 'echo' };
    render(createElement(AgentActionRow, {
      message: mkTool('ghost', 'mcp__cindy__ghost_call', toolInput),
    }));
  };

  it('新 root 实例：省略 namespace 与显式 null 都显示名称', () => {
    ghostFixtures.ghosts = [root];
    renderCall('helper');
    expect(screen.getByText(/「Root Helper」· echo/)).toBeTruthy();
    cleanup();
    renderCall('helper', null);
    expect(screen.getByText(/「Root Helper」· echo/)).toBeTruthy();
  });

  it('唯一企业实例：省略 namespace 与显式 slug 都显示名称', () => {
    ghostFixtures.ghosts = [organization];
    renderCall('helper');
    expect(screen.getByText(/「Organization Helper」· echo/)).toBeTruthy();
    cleanup();
    renderCall('helper', 'acme');
    expect(screen.getByText(/「Organization Helper」· echo/)).toBeTruthy();
  });

  it('旧 root 裸实例键仍显示名称', () => {
    ghostFixtures.ghosts = [{ ...root, instanceKey: 'helper' }];
    renderCall('helper');
    expect(screen.getByText(/「Root Helper」· echo/)).toBeTruthy();
  });

  it('同 ID 多实例不让旧 root 的物理键掩盖歧义', () => {
    ghostFixtures.ghosts = [{ ...root, instanceKey: 'helper' }, organization];
    renderCall('helper');
    expect(screen.getByText(/「helper」· echo/)).toBeTruthy();
    expect(screen.queryByText(/「Root Helper」· echo/)).toBeNull();
    cleanup();
    renderCall('helper', null);
    expect(screen.getByText(/「Root Helper」· echo/)).toBeTruthy();
    cleanup();
    renderCall('helper', 'acme');
    expect(screen.getByText(/「Organization Helper」· echo/)).toBeTruthy();
  });

  it('真实实例键精确查找，卸载后回退为 ID', () => {
    ghostFixtures.ghosts = [root, organization];
    renderCall('_ns__acme__helper');
    expect(screen.getByText(/「Organization Helper」· echo/)).toBeTruthy();
    cleanup();
    ghostFixtures.ghosts = [];
    renderCall('helper');
    expect(screen.getByText(/「helper」· echo/)).toBeTruthy();
  });
});

describe('document tool result presentation', () => {
  it('shows a human hint instead of the raw JSON error payload', () => {
    expect(
      humanizeDocumentToolResult(
        'mcp__cindy_docs__make_docx',
        JSON.stringify({
          ok: false,
          errorCode: 'FILE_EXISTS',
          data: { hint: '目标文件已存在，请换一个文件名。' },
        }),
      ),
    ).toBe('目标文件已存在，请换一个文件名。');
  });

  it('shows a human hint for read-only document tool failures too', () => {
    const error = JSON.stringify({
      ok: false,
      errorCode: 'FILE_TOO_LARGE',
      data: { hint: '文件超过检查上限，请先压缩或拆分。' },
    });
    expect(humanizeDocumentToolResult('mcp__cindy_docs__read_sheet', error)).toBe(
      '文件超过检查上限，请先压缩或拆分。',
    );
    expect(humanizeDocumentToolResult('mcp:cindy_docs:inspect_pdf', error)).toBe(
      '文件超过检查上限，请先压缩或拆分。',
    );
  });

  it('does not rewrite non-document tool results', () => {
    expect(humanizeDocumentToolResult('Bash', '{"ok":false}')).toBeNull();
  });
});

describe('AgentActionRow — 行主文案', () => {
  it('Bash 有 description:显示描述、隐藏动词、hover title 为命令原文', () => {
    render(
      createElement(AgentActionRow, {
        message: mkTool('t1', 'Bash', { command: 'git status', description: '查看工作区状态' }),
      }),
    );
    const desc = screen.getByText('查看工作区状态');
    expect(desc.getAttribute('title')).toBe('git status');
    expect(screen.queryByText('chat.agentActionRow.verb.ran')).toBeNull();
  });

  it('工作动作模式:Bash 首行保留 description，命令原文收进点击详情', () => {
    render(
      createElement(AgentActionRow, {
        message: mkTool('t1', 'Bash', { command: 'git status', description: '查看工作区状态' }),
        showRawCommand: true,
      }),
    );
    expect(screen.getByText('查看工作区状态')).toBeTruthy();
    expect(document.querySelector('[data-agent-action-raw-command="true"]')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('git status')).toBeTruthy();
  });

  it('exec 无法分类时回退为动词 + 命令文本', () => {
    render(
      createElement(AgentActionRow, {
        message: mkTool('t1', 'exec', { command: 'docker ps' }),
      }),
    );
    expect(screen.getByText('chat.agentActionRow.verb.ran')).toBeTruthy();
    expect(screen.getByText('docker ps')).toBeTruthy();
  });

  it('工作动作模式:历史 Codex wrapper 无 displayCommand 也会友好化并在详情解包', () => {
    render(
      createElement(AgentActionRow, {
        message: mkTool('t1', 'exec', {
          command: "/bin/zsh -lc 'git status --short'",
        }),
        showRawCommand: true,
      }),
    );
    expect(screen.getByText('chat.agentActionRow.verb.gitStatus')).toBeTruthy();
    expect(document.querySelector('[data-agent-action-raw-command="true"]')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('git status --short')).toBeTruthy();
    expect(screen.queryByText("/bin/zsh -lc 'git status --short'")).toBeNull();
  });

  it('工作动作模式:无法识别的命令仍用第二行原文兜底', () => {
    render(
      createElement(AgentActionRow, {
        message: mkTool('t1', 'exec', { command: 'docker ps' }),
        showRawCommand: true,
      }),
    );
    expect(screen.getByText('chat.agentActionRow.verb.ranCommand')).toBeTruthy();
    expect(document.querySelector('[data-agent-action-raw-command="true"]')?.textContent).toBe(
      'docker ps',
    );
    fireEvent.click(screen.getByRole('button'));
    expect(document.querySelector('[data-agent-action-raw-command="true"]')).toBeNull();
    expect(screen.getByText('docker ps')).toBeTruthy();
  });

  it('exec 带 codex commandActions:意图动词 + 目标,hover 保留命令原文', () => {
    render(
      createElement(AgentActionRow, {
        message: mkTool('t1', 'exec', {
          command: 'rg -n useMemo src/renderer | head -40',
          commandActions: [
            {
              type: 'search',
              command: 'rg -n useMemo src/renderer',
              query: 'useMemo',
              path: 'src/renderer',
            },
          ],
        }),
      }),
    );
    expect(screen.getByText('chat.agentActionRow.verb.searched')).toBeTruthy();
    const target = screen.getByText('useMemo');
    expect(target.getAttribute('title')).toContain('rg -n useMemo src/renderer | head -40');
    expect(target.getAttribute('title')).toContain('src/renderer');
  });

  it('exec 无 commandActions 时本地规则解析意图:pnpm test → 运行测试动词', () => {
    render(
      createElement(AgentActionRow, {
        message: mkTool('t1', 'exec', { command: 'pnpm --filter desktop test' }),
      }),
    );
    expect(screen.getByText('chat.agentActionRow.verb.ranTests')).toBeTruthy();
    // 无 target 的意图首行只留完整标题，真实命令由工作过程的次行/详情承载。
    expect(screen.queryByText('pnpm --filter desktop test')).toBeNull();
  });

  it('MCP 行:显示 server · tool 人话标签,title 保留原始 toolName', () => {
    render(
      createElement(AgentActionRow, {
        message: mkTool('t1', 'mcp__feishu__read_by_url', { url: 'https://f.cn/doc' }),
      }),
    );
    const label = screen.getByText('feishu · read by url');
    expect(label.getAttribute('title')).toContain('mcp__feishu__read_by_url');
    expect(screen.getByText('chat.agentActionRow.verb.used')).toBeTruthy();
  });

  it('file_change:主行显示文件数与总 diff，点击后直接进入共享 diff lightbox', () => {
    render(
      createElement(AgentActionRow, {
        message: mkTool('t1', 'file_change', {
          changes: [
            {
              path: '/repo/src/app.ts',
              kind: { type: 'update' },
              diff: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new',
            },
            {
              path: '/repo/src/new.ts',
              kind: { type: 'add' },
              diff: '+++ b/src/new.ts\n+one\n+two',
            },
          ],
        }),
        toolResult: 'update /repo/src/app.ts\nadd /repo/src/new.ts',
      }),
    );

    expect(screen.getByText('chat.agentActionRow.verb.updated')).toBeTruthy();
    expect(screen.getByText('chat.agentActionRow.fileChange.files:2')).toBeTruthy();
    expect(screen.getByText('+3')).toBeTruthy();
    expect(screen.getByText('-1')).toBeTruthy();

    fireEvent.click(screen.getByRole('button'));
    expect(document.body.textContent).toContain('"kind":"diff"');
    expect(document.body.textContent).toContain('"filePath":"/repo/src/app.ts"');
    expect(document.body.textContent).toContain('"rawDiff":"--- a/src/app.ts');
    expect(document.body.textContent).not.toContain('chat.agentActionRow.fileChange.rawData');
    expect(document.querySelector('[data-agent-file-change-details="true"]')).toBeNull();
  });

  it('file_change:单文件重命名直接显示源文件和目标文件', () => {
    render(
      createElement(AgentActionRow, {
        message: mkTool('t1', 'file_change', {
          changes: [
            {
              path: '/repo/src/old.ts',
              kind: { type: 'update', move_path: '/repo/src/new.ts' },
              diff: '',
            },
          ],
        }),
      }),
    );
    expect(screen.getByText('chat.agentActionRow.fileChange.renamed')).toBeTruthy();
    expect(screen.getByText('old.ts → new.ts')).toBeTruthy();
    expect(document.querySelector('[data-agent-action-file-chip="true"]')).toBeTruthy();
  });

  it('pi bash:小写工具名照样解析出意图动词,不再是「调用 bash」', () => {
    render(
      createElement(AgentActionRow, {
        message: mkTool('t1', 'bash', { command: 'git status' }),
      }),
    );
    expect(screen.getByText('chat.agentActionRow.verb.gitStatus')).toBeTruthy();
    expect(screen.queryByText('chat.agentActionRow.verb.used')).toBeNull();
    expect(screen.queryByText('bash')).toBeNull();
  });

  it('pi bash:无法分类的命令回退为运行动词 + 命令原文', () => {
    render(
      createElement(AgentActionRow, {
        message: mkTool('t1', 'bash', { command: 'docker ps' }),
      }),
    );
    expect(screen.getByText('chat.agentActionRow.verb.ran')).toBeTruthy();
    expect(screen.getByText('docker ps')).toBeTruthy();
  });

  it('pi read:path 字段渲染成文件 chip 与读取动词', () => {
    render(
      createElement(AgentActionRow, {
        message: mkTool('t1', 'read', { path: '/repo/src/app.ts' }),
      }),
    );
    expect(screen.getByText('chat.agentActionRow.verb.read')).toBeTruthy();
    expect(screen.getByText('app.ts')).toBeTruthy();
    expect(document.querySelector('[data-agent-action-file-chip="true"]')).toBeTruthy();
  });

  it('pi grep / find:搜索动词 + 搜索目标', () => {
    const { rerender } = render(
      createElement(AgentActionRow, {
        message: mkTool('t1', 'grep', { pattern: 'TODO', path: 'src/' }),
      }),
    );
    expect(screen.getByText('chat.agentActionRow.verb.searched')).toBeTruthy();
    expect(screen.getByText('TODO')).toBeTruthy();
    rerender(
      createElement(AgentActionRow, {
        message: mkTool('t1', 'find', { pattern: '**/*.spec.ts' }),
      }),
    );
    expect(screen.getByText('chat.agentActionRow.verb.searched')).toBeTruthy();
    expect(screen.getByText('**/*.spec.ts')).toBeTruthy();
  });

  it('pi write:创建动词 + 行内 +N 统计,点击进共享 diff lightbox', () => {
    render(
      createElement(AgentActionRow, {
        message: mkTool('t1', 'write', { path: '/repo/src/new.ts', content: 'a\nb' }),
      }),
    );
    expect(screen.getByText('chat.agentActionRow.verb.created')).toBeTruthy();
    expect(screen.getByText('new.ts')).toBeTruthy();
    expect(screen.getByText('+2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    expect(document.body.textContent).toContain('"kind":"diff"');
    expect(document.body.textContent).toContain('"filePath":"/repo/src/new.ts"');
  });

  it('pi edit:edits[].oldText/newText 汇成编辑动词与 diff lightbox', () => {
    render(
      createElement(AgentActionRow, {
        message: mkTool('t1', 'edit', {
          path: '/repo/src/app.ts',
          edits: [{ oldText: 'old', newText: 'new' }],
        }),
      }),
    );
    expect(screen.getByText('chat.agentActionRow.verb.edited')).toBeTruthy();
    expect(screen.getByText('app.ts')).toBeTruthy();
    expect(screen.getByText('+1')).toBeTruthy();
    expect(screen.getByText('-1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    expect(document.body.textContent).toContain('"oldString":"old"');
    expect(document.body.textContent).toContain('"newString":"new"');
  });

  // pi 0.83.0 的 edit 同时接受 legacy 顶层单段(LegacyEditToolInput);只认 edits[]
  // 会让这种事件退化成空 diff 与 +0 -0。
  it('pi edit:legacy 顶层 oldText/newText 也给出真实统计与非空 diff', () => {
    render(
      createElement(AgentActionRow, {
        message: mkTool('t1', 'edit', {
          path: '/repo/src/app.ts',
          oldText: 'old A\nold B',
          newText: 'new A',
        }),
      }),
    );
    expect(screen.getByText('chat.agentActionRow.verb.edited')).toBeTruthy();
    expect(screen.getByText('app.ts')).toBeTruthy();
    expect(screen.getByText('+1')).toBeTruthy();
    expect(screen.getByText('-2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    expect(document.body.textContent).toContain('"oldString":"old A\\nold B"');
    expect(document.body.textContent).toContain('"newString":"new A"');
    // 空 diffs 数组会渲染成 "diffs":[] —— 明确断死它没退化。
    expect(document.body.textContent).not.toContain('"diffs":[]');
  });

  it('状态图标:running / done 经 aria-label 可达,缺省为 done', () => {
    const { rerender } = render(
      createElement(AgentActionRow, {
        message: mkTool('t1', 'Bash', { command: 'ls' }),
        status: 'running',
      }),
    );
    expect(screen.getByLabelText('chat.agentActionRow.status.running')).toBeTruthy();
    rerender(
      createElement(AgentActionRow, {
        message: mkTool('t1', 'Bash', { command: 'ls' }),
      }),
    );
    expect(screen.getByLabelText('chat.agentActionRow.status.done')).toBeTruthy();
  });

  it('就地展开区:命令原文保留,不再出现 # description 重复行', () => {
    render(
      createElement(AgentActionRow, {
        message: mkTool('t1', 'Bash', { command: 'git status', description: '查看工作区状态' }),
        toolResult: 'clean',
      }),
    );
    fireEvent.click(screen.getByRole('button'));
    // 展开后 <pre> 里是命令原文;description 只在行主文案出现一次,无 "# " 前缀行。
    expect(screen.getByText('git status')).toBeTruthy();
    expect(screen.getAllByText('查看工作区状态')).toHaveLength(1);
    expect(screen.queryByText(/^# /)).toBeNull();
  });

  it('已精简的工具结果显示释放提示与原始大小', () => {
    render(
      createElement(AgentActionRow, {
        message: mkTool('t1', 'Bash', { command: 'git status' }),
        toolResult: JSON.stringify({
          type: 'tool_result_compacted',
          version: 1,
          originalBytes: 128 * 1024,
          compactedAt: 500,
        }),
      }),
    );

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('chat.toolResultCompacted:128 KB')).toBeTruthy();
    expect(document.body.textContent).not.toContain('tool_result_compacted');
  });

  it('exposes the tool clientId as a viewport child anchor', () => {
    const { container } = render(
      createElement(AgentActionRow, {
        message: mkTool('t1', 'Bash', { command: 'ls' }),
      }),
    );
    expect(container.querySelector('[data-message-client-id="t1"]')).toBeTruthy();
  });
});

describe('AgentActionsBlock — 状态判定与块头', () => {
  const expandBlock = () => {
    // 块默认折叠;首个 button 是块头,点击展开行列表。
    fireEvent.click(screen.getAllByRole('button')[0]);
  };

  it('streaming 中无 result 的行 running,有 result 的行 done;块头出现 spinner', () => {
    const { container } = render(
      createElement(AgentActionsBlock, {
        toolCalls: [
          mkTool('t1', 'Bash', { command: 'ls' }),
          mkTool('t2', 'Bash', { command: 'pwd' }),
        ],
        resultMap: new Map([['t1', 'ok']]),
        settledIds: new Set<string>(),
        isSessionStreaming: true,
      }),
    );
    expect(container.querySelector('.animate-spinner')).toBeTruthy();
    expandBlock();
    expect(screen.getAllByLabelText('chat.agentActionRow.status.done')).toHaveLength(1);
    expect(screen.getAllByLabelText('chat.agentActionRow.status.running')).toHaveLength(1);
  });

  it('settledIds(被隐藏的 orca 空结果)按 done 渲染,不出现永久 spinner', () => {
    const { container } = render(
      createElement(AgentActionsBlock, {
        toolCalls: [mkTool('t1', 'mcp__orca_worker_bridge__send_to_lead', { message: 'hi' })],
        resultMap: new Map(),
        settledIds: new Set(['t1']),
        isSessionStreaming: true,
      }),
    );
    expect(container.querySelector('.animate-spinner')).toBeNull();
    expandBlock();
    expect(screen.getByLabelText('chat.agentActionRow.status.done')).toBeTruthy();
  });

  it('非 streaming(历史 / 中断会话)一律 done,即便没有 result', () => {
    const { container } = render(
      createElement(AgentActionsBlock, {
        toolCalls: [mkTool('t1', 'Bash', { command: 'ls' })],
        resultMap: new Map(),
      }),
    );
    expect(container.querySelector('.animate-spinner')).toBeNull();
    expandBlock();
    expect(screen.getByLabelText('chat.agentActionRow.status.done')).toBeTruthy();
  });
});

// #6412 / PR #6420: real locale lookup catches misplaced keys hidden by the previous identity mock.
// The retry button must display translated text and target the existing artifact on the task host.
it.each(['local', 'device'] as const)('retries image delivery through the %s task route without sending a model message', async (kind) => {
  const retry = vi.fn(async () => {});
  const invoke = vi.fn(async () => {});
  const previous = window.electronAPI;
  window.electronAPI = { maker: { input: { retryImageDelivery: retry } }, deviceLink: { invoke } } as never;
  try {
    render(createElement(ChatSessionFileProvider, { value: {
      sessionId: 'task', workingDir: '/task', origin: kind === 'device' ? { kind, deviceId: 'task-host' } : { kind },
    }, children: createElement(AgentActionRow, {
      message: mkTool('image', 'imagegen', {}),
      toolResult: JSON.stringify({ kind: 'generation', native_image_delivery: { id: 'a'.repeat(64), state: 'failed' } }),
    }) }));
    expect(screen.getByRole('status').textContent).toBe('Image delivery failed. Retry transferring the existing image.');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry delivery' })); });
    if (kind === 'device') {
      expect(invoke).toHaveBeenCalledWith('task-host', 'maker:images:retry', ['task', 'a'.repeat(64)]);
      expect(retry).not.toHaveBeenCalled();
    } else {
      expect(retry).toHaveBeenCalledWith('task', 'a'.repeat(64));
      expect(invoke).not.toHaveBeenCalled();
    }
  } finally { window.electronAPI = previous; }
});
