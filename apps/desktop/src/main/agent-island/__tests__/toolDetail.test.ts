import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOL_ROW_WORDING, type ToolRowWording } from '@cindy/maker-shared/message-presentation';

import { formatIslandToolDetail } from '../toolDetail.js';

const wording = DEFAULT_TOOL_ROW_WORDING;

function detail(toolName: string, input: unknown, requireCommandVisible = false): string | null {
  return formatIslandToolDetail(toolName, input, { wording, requireCommandVisible });
}

describe('formatIslandToolDetail', () => {
  it('humanizes intent-classified commands into panel-style labels', () => {
    expect(detail('Bash', { command: 'pnpm test' })).toBe('运行测试');
    expect(detail('exec', { command: 'git status --short' })).toBe('查看工作区状态');
    expect(detail('exec', {
      command: 'bash -lc "pnpm build"',
      displayCommand: 'pnpm build',
    })).toBe('构建');
  });

  it('keeps the raw command for unclassifiable or destructive commands', () => {
    // rm 系破坏性命令刻意不进意图规则表:原文即最诚实的展示。
    expect(detail('Bash', { command: 'rm -rf dist' })).toBe('$ rm -rf dist');
    const opaque = 'docker run --rm -v /repo:/w node:22 bash -lc "true"';
    expect(detail('Bash', { command: opaque })).toBe(`$ ${opaque}`);
  });

  it('keeps model descriptions verbatim with the command as suffix', () => {
    expect(detail('Bash', { command: 'pnpm test', description: 'Run tests' }))
      .toBe('Run tests · $ pnpm test');
    // 描述已含命令时不重复。
    expect(detail('Bash', { command: 'pnpm test', description: 'Run tests: pnpm test' }))
      .toBe('Run tests: pnpm test');
  });

  it('forces the real command to stay visible for permission prompts', () => {
    expect(detail('Bash', { command: 'pnpm test' }, true)).toBe('运行测试 · $ pnpm test');
    expect(detail('Bash', { command: 'rm -rf dist' }, true)).toBe('$ rm -rf dist');
  });

  it('renders non-command descriptors with shared panel wording', () => {
    expect(detail('Read', { file_path: '/repo/src/app.ts' })).toBe('读取 app.ts');
    expect(detail('Edit', { file_path: '/repo/src/app.ts' })).toBe('编辑 app.ts');
    expect(detail('Grep', { pattern: 'useMemo', path: 'src/renderer' })).toBe('搜索 useMemo');
    expect(detail('WebFetch', { url: 'https://example.com/docs' })).toBe('访问 https://example.com/docs');
    expect(detail('TodoWrite', { todos: [] })).toBe('更新待办');
    expect(detail('mcp__lizi_feishu__read_by_url', { url: 'https://example.com' }))
      .toBe('调用 lizi_feishu · read by url');
    expect(detail('file_change', {
      changes: [
        { path: '/repo/a.ts', kind: { type: 'update' }, diff: '-a\n+b' },
        { path: '/repo/b.ts', kind: { type: 'add' }, diff: '+b' },
      ],
    })).toBe('更新 2 个文件');
  });

  it('covers the codex canonical tool shapes with the same shared pipeline', () => {
    // codex web_search:input 是 { query, action }。
    expect(detail('web_search', { query: 'electron notch api', action: 'search' }))
      .toBe('搜索 electron notch api');
    // codex update_plan 与 Claude TodoWrite 走同一个 todo 槽。
    expect(detail('update_plan', { plan: [] })).toBe('更新待办');
    // codex file_change 移动。
    expect(detail('file_change', {
      changes: [{ path: '/repo/src/old.ts', kind: { type: 'update', move_path: '/repo/src/new.ts' }, diff: '' }],
    })).toBe('重命名 old.ts → new.ts');
    // codex 官方 commandActions 优先于本地规则;多段 action 时取首段意图
    // (与 mobile 行、IM 卡片的 summarizeToolUseText 单行行为一致)。
    expect(detail('exec', {
      command: 'rg -n useMemo src/renderer',
      commandActions: [{ type: 'search', query: 'useMemo', path: 'src/renderer', command: 'rg' }],
    })).toBe('搜索 useMemo');
  });

  it('surfaces informative input fields for descriptor-opaque tools (codex MCP elicitation)', () => {
    // codex MCP elicitation 权限:toolName 只有 `mcp:server` 两段(拆不出 tool),
    // input 里的 message / toolTitle / toolDescription 才是人话(旧岛行为)。
    expect(detail('mcp:lizi_feishu', {
      serverName: 'lizi_feishu',
      message: '允许写入飞书文档《周报》?',
      toolTitle: '写入文档',
    }, true)).toBe('允许写入飞书文档《周报》?');
    expect(detail('mcp:lizi_feishu', {
      serverName: 'lizi_feishu',
      toolTitle: '写入文档',
    })).toBe('写入文档');
    // codex permissions 审批:input 无人话字段,回落请求级 description(reason)。
    expect(formatIslandToolDetail('permissions', { permissions: ['network'] }, { wording }, {
      description: 'Needs network access to fetch docs',
    })).toBe('Needs network access to fetch docs');
  });

  it('truncates task descriptions and generic labels to the island cap', () => {
    const longDescription = 'x'.repeat(120);
    const taskLabel = detail('Task', { description: longDescription, prompt: 'ignored' });
    expect(taskLabel).not.toBeNull();
    expect(taskLabel!.length).toBeLessThanOrEqual(80);
    expect(detail('SomeUnknownTool', { anything: true })).toBe('调用 SomeUnknownTool');
    // generic 但 input 有可读细节(DETAIL_KEYS)时,label 后跟细节(对齐面板行)。
    expect(detail('SomeUnknownTool', { query: 'find usages' })).toBe('调用 SomeUnknownTool · find usages');
  });

  it('prefers codex tool-side questions over tool shape', () => {
    expect(detail('some_tool', {
      questions: [{ question: 'Continue?' }, { question: 'Second' }],
    })).toBe('Continue? (+1)');
  });

  it('falls back to request metadata when input is not a record', () => {
    expect(formatIslandToolDetail('CustomTool', undefined, { wording }, {
      description: 'Do the thing',
    })).toBe('Do the thing');
    expect(formatIslandToolDetail('CustomTool', undefined, { wording }, {
      displayName: 'Custom Tool',
    })).toBe('Custom Tool');
    expect(formatIslandToolDetail('CustomTool', undefined, { wording })).toBeNull();
  });

  it('routes wording through the injected implementation', () => {
    const fake: ToolRowWording = {
      verb: (key) => `verb:${key}`,
      intentVerb: (action) => `intent:${action}`,
      updateFilesLabel: (count) => `updated ${count} files`,
    };
    expect(formatIslandToolDetail('Bash', { command: 'pnpm test' }, { wording: fake }))
      .toBe('intent:test');
    expect(formatIslandToolDetail('Read', { file_path: '/repo/a.ts' }, { wording: fake }))
      .toBe('verb:read a.ts');
  });
});
