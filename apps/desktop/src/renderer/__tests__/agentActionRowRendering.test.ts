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

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';

vi.mock('react-i18next', () => ({
  // t 返回原 key(带 count 时后缀 :count),断言直接对 key 做,避免复制文案表。
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && typeof options.count === 'number' ? `${key}:${String(options.count)}` : key,
  }),
}));

// Lightbox 家族与文件 chip 菜单只在交互后出现,渲染测试不涉及 — mock 掉,
// 避免拖进重型依赖(DiffView / 文稿浏览器)。
vi.mock('@/components/chat/TextLightbox', () => ({ TextLightbox: () => null }));
vi.mock('@/components/chat/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('@/components/chat/ToolPayloadLightbox', () => ({
  ToolPayloadLightbox: ({ payload }: { payload: unknown }) => JSON.stringify(payload),
}));
vi.mock('@/components/chat/useFileChipContextMenu', () => ({
  useFileChipContextMenu: () => ({
    menu: null,
    onContextMenu: () => {},
    openAt: () => {},
  }),
}));
vi.mock('@/lib/filePreview', () => ({ shouldOpenTextLightbox: async () => false }));
vi.mock('@/lib/localPathResolver', () => ({ toLocalFileUrl: (p: string) => `xdt-file://${p}` }));

import { AgentActionRow } from '@/components/chat/AgentActionRow';
import { AgentActionsBlock } from '@/components/chat/AgentActionsBlock';
import { __test_internals as expandMemory } from '@/hooks/useExpandedBlockMemory';
import type { ChatMessage } from '@/lib/makerChatStore';

afterEach(cleanup);
// useExpandedBlockMemory 是 module-level 内存态,blockId(agent:<clientId>)
// 相同会让展开状态跨用例泄漏 — 每个用例前清空。
beforeEach(() => expandMemory.reset());

const mkTool = (id: string, toolName: string, toolInput: unknown): ChatMessage => ({
  clientId: id,
  role: 'tool_use',
  content: '',
  toolUseId: `tu-${id}`,
  toolName,
  toolInput,
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
            { type: 'search', command: 'rg -n useMemo src/renderer', query: 'useMemo', path: 'src/renderer' },
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
          changes: [{
            path: '/repo/src/old.ts',
            kind: { type: 'update', move_path: '/repo/src/new.ts' },
            diff: '',
          }],
        }),
      }),
    );
    expect(screen.getByText('chat.agentActionRow.fileChange.renamed')).toBeTruthy();
    expect(screen.getByText('old.ts → new.ts')).toBeTruthy();
    expect(document.querySelector('[data-agent-action-file-chip="true"]')).toBeTruthy();
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
    expect(container.querySelector('.animate-spin')).toBeTruthy();
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
    expect(container.querySelector('.animate-spin')).toBeNull();
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
    expect(container.querySelector('.animate-spin')).toBeNull();
    expandBlock();
    expect(screen.getByLabelText('chat.agentActionRow.status.done')).toBeTruthy();
  });
});
