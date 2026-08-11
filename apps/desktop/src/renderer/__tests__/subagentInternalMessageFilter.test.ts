/**
 * subagentInternalMessageFilter.test.ts
 * ---------------------------------------------------------------------------
 * 锁住 buildRenderItems 对**子代理内部消息**的剔除。
 *
 * 背景:后台 Agent/Task 跑起来后,SDK 会把子代理自己的 thinking / 正文 / 工具调用
 * 一并 echo 回主流(每条带 parent_tool_use_id,经 makerChatStore 投影成顶层
 * parentToolUseId)。官方 CLI 不显示它们;Cindy 逐条渲染就等于把整篇子代理报告原样
 * 铺进聊天窗口。它们的去处是自己那张 AgentTaskCard,不是主流。
 *
 * 三条不变量:
 *  - SDK tool-parent 形态(toolu_ / call_ / 兼容模型的 Name_序号)的子消息被剔除;
 *  - 主线程消息(无 parentToolUseId)逐字节保留;
 *  - legacy Claude 导入的 transcript 链边(非 tool-use id 形态)不被误判成子代理 ——
 *    否则父会话自己的正文会被一起吞掉。
 */

import { describe, it, expect } from 'vitest';

import { buildRenderItems } from '../components/chat/MessageStream';
import type { ChatMessage } from '@/lib/makerChatStore';

const asst = (clientId: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  clientId,
  role: 'assistant',
  content,
  ...extra,
});

/** 取渲染结果里所有 message 条目的 clientId(顺序保持)。 */
const messageIds = (items: ReturnType<typeof buildRenderItems>['items']): string[] =>
  items.flatMap((it) => (it.type === 'message' ? [it.message.clientId] : []));

describe('buildRenderItems — subagent internal messages', () => {
  it('drops subagent assistant prose from the main stream', () => {
    const msgs: ChatMessage[] = [
      asst('parent-intro', '我先派一个后台调研。'),
      asst('subagent-report', '调研完成,以下是完整报告……', {
        parentToolUseId: 'toolu_01KzTJBHuSyQfTXT74MKLjgp',
        model: 'claude-opus-5',
      }),
      asst('parent-summary', '调研回来了,结论如下。'),
    ];

    expect(messageIds(buildRenderItems(msgs).items)).toEqual([
      'parent-intro',
      'parent-summary',
    ]);
  });

  it('drops subagent thinking blocks too', () => {
    const msgs: ChatMessage[] = [
      { clientId: 'think-sub', role: 'thinking', content: '子代理在想…', parentToolUseId: 'toolu_ABC' },
      asst('parent', '父会话正文'),
    ];

    expect(messageIds(buildRenderItems(msgs).items)).toEqual(['parent']);
  });

  it('recognises the compat tool-use id shape (kimi-style Name_序号)', () => {
    const msgs: ChatMessage[] = [
      asst('sub', '子代理正文', { parentToolUseId: 'Task_1' }),
      asst('parent', '父会话正文'),
    ];

    expect(messageIds(buildRenderItems(msgs).items)).toEqual(['parent']);
  });

  it('keeps main-thread messages untouched when nothing is a subagent child', () => {
    const msgs: ChatMessage[] = [
      asst('a', '第一段'),
      asst('b', '第二段'),
    ];

    expect(messageIds(buildRenderItems(msgs).items)).toEqual(['a', 'b']);
  });

  it('does NOT drop legacy transcript-chain parents (non tool-use id shape)', () => {
    // 旧 Claude 导入把普通 transcript 链边存在同一个字段上。把它当子代理归属会
    // 让父会话自己的正文整段消失 —— 这里锁住不能误判。
    const msgs: ChatMessage[] = [
      asst('legacy-1', '父会话正文', { parentToolUseId: 'preceding-user-uuid' }),
      asst('legacy-2', '父会话正文二', {
        parentToolUseId: '3d2ac20f-509c-4aff-ac12-842c75f56c6f',
      }),
    ];

    expect(messageIds(buildRenderItems(msgs).items)).toEqual(['legacy-1', 'legacy-2']);
  });

  it('still derives generated-file chips from filtered subagent Write calls', () => {
    // 子代理用 Write 建的文件是**真实产物**,只是它的 tool_use 行不该渲染。产物收集
    // 必须回到原始序列取 turn 切片,否则文件 chip 静默消失(review: codex P2)。
    const msgs: ChatMessage[] = [
      { clientId: 'u1', role: 'user', content: '帮我生成报告' },
      {
        clientId: 'sub-write',
        role: 'tool_use',
        content: '',
        toolName: 'Write',
        toolUseId: 'toolu_write',
        toolInput: { file_path: '/repo/report.md', content: '…' },
        parentToolUseId: 'toolu_AGENT',
      },
      { clientId: 'a1', role: 'assistant', content: '写好了' },
      { clientId: 'u2', role: 'user', content: '谢谢' },
    ];

    const items = buildRenderItems(msgs, undefined, undefined, { workingDir: '/repo' }).items;
    const genfiles = items.filter((it) => it.type === 'generated_files');
    expect(genfiles).toHaveLength(1);
    expect(
      genfiles[0].type === 'generated_files' ? genfiles[0].files.map((f) => f.path) : [],
    ).toEqual(['/repo/report.md']);
    // 子代理的 Write 行本身仍然不渲染。
    expect(messageIds(items)).toEqual(['u1', 'a1', 'u2']);
  });

  it('keeps the parent Agent tool call itself (only its children are internal)', () => {
    const msgs: ChatMessage[] = [
      {
        clientId: 'agent-call',
        role: 'tool_use',
        content: '',
        toolName: 'Agent',
        toolUseId: 'toolu_AGENT',
      },
      asst('sub-child', '子代理正文', { parentToolUseId: 'toolu_AGENT' }),
    ];

    const items = buildRenderItems(msgs).items;
    // Agent 调用渲染成 agent_task 卡,子代理正文不出现在任何 message 条目里。
    expect(items.some((it) => it.type === 'agent_task')).toBe(true);
    expect(messageIds(items)).toEqual([]);
  });
});
