import { describe, expect, it, vi } from 'vitest';

import {
  buildForkOriginHandoff,
  composeForkOriginHandoff,
  buildHandoffText,
  createAgentHandoffPendingRegistry,
  extractPlainText,
  prependHandoffToUserMessage,
  type HandoffSourceMessage,
} from '../agentHandoff';

function msg(role: string, content: unknown, createdAt = 0): HandoffSourceMessage {
  return { role, content, createdAt };
}

describe('extractPlainText', () => {
  it('透传纯文本', () => {
    expect(extractPlainText('你好')).toBe('你好');
  });

  it('解析 JSON 字符串形态的 {text} 与 SDK blocks', () => {
    expect(extractPlainText(JSON.stringify({ text: 'hi', images: [], files: [] }))).toBe('hi');
    expect(
      extractPlainText(JSON.stringify([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])),
    ).toBe('a\nb');
  });

  it('对象形态取 text / message,未知形态回空', () => {
    expect(extractPlainText({ text: 't' })).toBe('t');
    expect(extractPlainText({ message: 'm' })).toBe('m');
    expect(extractPlainText(42)).toBe('');
    expect(extractPlainText(null)).toBe('');
  });

  it('DB user envelope uses semantic projection for quote and message chips', () => {
    const href = 'cindy://session/session-a?message=message-a';
    const text = `> <!-- cindy-composer-quote -->\n> selected\n\ninspect ${href}`;
    const content = {
      text,
      quotesEncoded: true,
      agentReferences: [{
        kind: 'message',
        start: text.indexOf(href),
        end: text.indexOf(href) + href.length,
        href,
        sessionId: 'session-a',
        messageClientId: 'message-a',
        text: 'Target message body',
      }],
    };

    const projected = extractPlainText(JSON.stringify(content));
    expect(projected).not.toContain('cindy-composer-quote');
    expect(projected).not.toContain(href);
    expect(projected).toContain('Target message body');
  });

  it('DB user envelope preserves a hand-written marker without quotesEncoded', () => {
    const text = '> <!-- cindy-composer-quote -->\n> hand written';
    expect(extractPlainText({ text, quotesEncoded: false })).toBe(text);
  });
});

describe('buildHandoffText', () => {
  const opts = { fromLabel: 'Claude Code', toLabel: 'Codex' };

  it('framing 包含续接指令与双引擎名,并以结束标记收尾', () => {
    const text = buildHandoffText([msg('user', '第一个问题'), msg('assistant', '第一个回答')], opts);
    expect(text).toContain('Claude Code');
    expect(text).toContain('Codex');
    expect(text).toContain('Do not mention this handoff note to the user');
    expect(text.trimEnd().endsWith("== End of handoff note; the user's new message follows ==")).toBe(true);
  });

  it('最近轮次逐字保留,更早轮次进单行提要', () => {
    const messages: HandoffSourceMessage[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(msg('user', `问题${i}`));
      messages.push(msg('assistant', `回答${i}`));
    }
    const text = buildHandoffText(messages, opts);
    // 最近 4 轮(4..7)逐字
    expect(text).toContain('[User]\n问题7');
    expect(text).toContain('[Assistant]\n回答7');
    expect(text).toContain('[User]\n问题4');
    // 更早轮(0..3)在提要区
    expect(text).toContain('- User: 问题0');
    expect(text).toContain('Reply: 回答3');
    expect(text).not.toContain('[User]\n问题0');
  });

  it('工具调用渲染为 name + input 摘要,tool_result/thinking 不进正文', () => {
    const text = buildHandoffText(
      [
        msg('user', '改一下代码'),
        msg('tool_use', { toolUseId: 't1', toolName: 'Read', input: { file_path: '/a.ts' } }),
        msg('tool_result', { anything: 'x'.repeat(500) }),
        msg('thinking', { kind: 'thinking', text: '内心戏' }),
        msg('assistant', '改好了'),
      ],
      opts,
    );
    expect(text).toContain('[Tool] Read: {"file_path":"/a.ts"}');
    expect(text).not.toContain('内心戏');
    expect(text).not.toContain('x'.repeat(200));
  });

  it('合成指令行([UI_ACTION_TRIGGER])不进交接', () => {
    const text = buildHandoffText(
      [msg('user', '正常消息'), msg('user', '[UI_ACTION_TRIGGER] resume'), msg('assistant', '好')],
      opts,
    );
    expect(text).not.toContain('UI_ACTION_TRIGGER');
    expect(text).toContain('正常消息');
  });

  it('handoff history never exposes product quote markers or private deep-link-only semantics', () => {
    const href = 'cindy://session/session-a?message=message-a';
    const text = `> <!-- cindy-composer-quote -->\n> selected\n\ninspect ${href}`;
    const handoff = buildHandoffText([
      msg('user', {
        text,
        quotesEncoded: true,
        agentReferences: [{
          kind: 'message',
          start: text.indexOf(href),
          end: text.indexOf(href) + href.length,
          href,
          sessionId: 'session-a',
          messageClientId: 'message-a',
          text: 'Target message body',
        }],
      }),
      msg('assistant', 'done'),
    ], opts);

    expect(handoff).not.toContain('cindy-composer-quote');
    expect(handoff).not.toContain(href);
    expect(handoff).toContain('Target message body');
  });

  it('超长文本被逐条截断,总长受硬上限保护', () => {
    const big = 'x'.repeat(50_000);
    const messages: HandoffSourceMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(msg('user', big));
      messages.push(msg('assistant', big));
    }
    const text = buildHandoffText(messages, opts);
    expect(text.length).toBeLessThanOrEqual(16_000);
  });
});

describe('buildForkOriginHandoff', () => {
  it('带上父会话 id,并以结束标记收尾(模型不会把它读成用户的话)', () => {
    const text = buildForkOriginHandoff('sess-parent-1');
    expect(text).toContain('sess-parent-1');
    expect(text).toContain('forked by the user from another conversation');
    expect(text.trimEnd().endsWith("== End of fork note; the user's new message follows =="))
      .toBe(true);
  });

  it('不提分叉点——forkSessionStripEncrypted 的 forkedAtMessageId 为 null,措辞须对两种 fork 都成立', () => {
    const text = buildForkOriginHandoff('sess-parent-3');
    expect(text).not.toContain('at one of its messages');
  });

  it('带「不要向用户提及」约束,避免把父会话 id 泄露给用户', () => {
    expect(buildForkOriginHandoff('sess-parent-4')).toContain('Do not mention this note or that id');
    // 组合进交接时同样带着该约束(它在事实行里,不在独立结束段)
    expect(composeForkOriginHandoff('sess-parent-4', 'PENDING')).toContain(
      'Do not mention this note or that id',
    );
  });

  it('保持极简:不重复 agent-switch 那套摘要/检索指引(fork 的上下文本来就是完整的)', () => {
    const text = buildForkOriginHandoff('sess-parent-2');
    expect(text).not.toContain('search_chat_history');
    expect(text).not.toContain('get_chat_history');
    expect(text).not.toContain('== Work state');
    expect(text.split('\n').filter((line) => line.trim().length > 0)).toHaveLength(3);
  });
});

describe('composeForkOriginHandoff', () => {
  it('无 pending 交接时等价于单独的来源标记', () => {
    expect(composeForkOriginHandoff('sess-p', null)).toBe(buildForkOriginHandoff('sess-p'));
  });

  it('已顶到上限的交接:组合后仍不超限,且结束标记前保有空行分隔', () => {
    const terminator = "== End of handoff note; the user's new message follows ==";
    const capped = `${'x'.repeat(16_000 - terminator.length - 2)}\n\n${terminator}`;
    expect(capped.length).toBe(16_000);

    const text = composeForkOriginHandoff('sess-p', capped);

    expect(text.length).toBeLessThanOrEqual(16_000);
    expect(text).toContain('sess-p');
    expect(text.trimEnd().endsWith(terminator)).toBe(true);
    // 正文被从中部裁开后,结束标记不能直接贴在半句话后面
    expect(text.endsWith(`\n\n${terminator}`)).toBe(true);
  });

  it('在引擎切换边界上 fork:来源标记并入 re-armed 交接,不替换它', () => {
    // fork 事务会把复制过去的 agent_switch 边界 re-arm 成 consumed:false,
    // 子会话首发时必须仍拿得到完整跨引擎交接——顶掉它就等于让子会话失忆。
    const switchHandoff = buildHandoffText([msg('user', '切换前的问题')], {
      fromLabel: 'Claude Code',
      toLabel: 'Codex',
    });
    const text = composeForkOriginHandoff('sess-p', switchHandoff);

    expect(text).toContain('sess-p');
    expect(text).toContain('切换前的问题');
    expect(text).toContain('from here on you (Codex) continue it');
    // 来源标记在前,交接自带的结束标记统一收尾——不出现两个「以下是用户的新消息」
    expect(text.indexOf('forked by the user')).toBeLessThan(text.indexOf('Session handoff'));
    expect(text).not.toContain("== End of fork note");
    expect(text.trimEnd().endsWith("== End of handoff note; the user's new message follows =="))
      .toBe(true);
  });
});

describe('prependHandoffToUserMessage', () => {
  it('string 形态直接前拼', () => {
    expect(prependHandoffToUserMessage('新消息', 'HANDOFF')).toBe('HANDOFF\n\n新消息');
  });

  it('content string 形态前拼且保持结构', () => {
    expect(prependHandoffToUserMessage({ type: 'user', content: '新消息' }, 'H')).toEqual({
      type: 'user',
      content: 'H\n\n新消息',
    });
  });

  it('blocks 形态前插独立 text block,不改原 blocks', () => {
    const original = { type: 'user' as const, content: [{ type: 'text', text: '新消息' }] };
    const out = prependHandoffToUserMessage(original, 'H');
    expect(out).toEqual({
      type: 'user',
      content: [{ type: 'text', text: 'H' }, { type: 'text', text: '新消息' }],
    });
    expect(original.content).toHaveLength(1);
  });
});

describe('createAgentHandoffPendingRegistry', () => {
  it('set → peek 命中内存,consume 后不再注入且不回查 DB', async () => {
    const query = vi.fn(async () => 'from-db');
    const consumed = vi.fn();
    const reg = createAgentHandoffPendingRegistry(query, consumed);
    reg.set('s1', 'H1');
    expect(await reg.peek('s1')).toBe('H1');
    reg.consume('s1');
    expect(await reg.peek('s1')).toBeNull();
    expect(query).not.toHaveBeenCalled();
    expect(consumed).toHaveBeenCalledWith('s1');
  });

  it('内存命中也过 decorate:agent-switch 直接 set 的交接仍能并上 fork 来源标记', async () => {
    // fork 出子会话后、首发前切引擎:切换流程走 setPendingHandoff 直接写内存,
    // 不经 DB fallback。没有这层组合,来源标记会被整条跳过。
    const query = vi.fn(async () => null);
    const decorate = vi.fn(async (_sid: string, handoff: string) => `FORK-ORIGIN\n\n${handoff}`);
    const reg = createAgentHandoffPendingRegistry(query, undefined, decorate);
    reg.set('s1', 'SWITCH-HANDOFF');
    expect(await reg.peek('s1')).toBe('FORK-ORIGIN\n\nSWITCH-HANDOFF');
    expect(query).not.toHaveBeenCalled();
  });

  it('decorate 结果回写缓存:重试 peek 不重跑 DB 查询,也不会叠加', async () => {
    const decorate = vi.fn(async (_sid: string, handoff: string) => `FORK\n\n${handoff}`);
    const reg = createAgentHandoffPendingRegistry(async () => null, undefined, decorate);
    reg.set('s1', 'SWITCH-HANDOFF');
    expect(await reg.peek('s1')).toBe('FORK\n\nSWITCH-HANDOFF');
    // 首发被拒 → 未 consume → 重试再 peek
    expect(await reg.peek('s1')).toBe('FORK\n\nSWITCH-HANDOFF');
    expect(decorate).toHaveBeenCalledTimes(1);
  });

  it('decorate 失败不写缓存,下次 peek 仍重试组合', async () => {
    let fail = true;
    const decorate = vi.fn(async (_sid: string, handoff: string) => {
      if (fail) throw new Error('db down');
      return `FORK\n\n${handoff}`;
    });
    const reg = createAgentHandoffPendingRegistry(async () => null, undefined, decorate);
    reg.set('s1', 'SWITCH-HANDOFF');
    expect(await reg.peek('s1')).toBe('SWITCH-HANDOFF');
    fail = false;
    expect(await reg.peek('s1')).toBe('FORK\n\nSWITCH-HANDOFF');
  });

  it('invalidate 留墓碑:后续 peek 直接返回 null,不回落 DB(/clear 的 cleared_at 尚未落库)', async () => {
    const query = vi.fn(async () => 'FROM-DB-PRE-CLEAR');
    const reg = createAgentHandoffPendingRegistry(query);
    reg.set('s1', 'H');
    reg.invalidate('s1');
    expect(await reg.peek('s1')).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('invalidate 之后的 set 可以覆盖墓碑(clear 后又切引擎)', async () => {
    const reg = createAgentHandoffPendingRegistry(async () => null);
    reg.invalidate('s1');
    reg.set('s1', 'NEW-SWITCH-HANDOFF');
    expect(await reg.peek('s1')).toBe('NEW-SWITCH-HANDOFF');
  });

  it('decorate 抛错期间发生 /clear:不退回已作废的交接', async () => {
    let reg: ReturnType<typeof createAgentHandoffPendingRegistry>;
    const decorate = vi.fn(async () => {
      reg.clear('s1');
      throw new Error('db down');
    });
    reg = createAgentHandoffPendingRegistry(async () => null, undefined, decorate);
    reg.set('s1', 'STALE-HANDOFF');
    expect(await reg.peek('s1')).toBeNull();
  });

  it('consume 后不触发 decorate(消费语义不被组合钩子破坏)', async () => {
    const decorate = vi.fn(async (_sid: string, handoff: string) => `X${handoff}`);
    const reg = createAgentHandoffPendingRegistry(async () => null, undefined, decorate);
    reg.set('s1', 'H');
    await reg.peek('s1');
    reg.consume('s1');
    expect(await reg.peek('s1')).toBeNull();
    expect(decorate).toHaveBeenCalledTimes(1);
  });

  it('DB fallback 缓存的值不再 decorate:首发未 accepted 的重试不会拿到两份来源标记', async () => {
    const query = vi.fn(async () => 'COMPOSED-BY-QUERY');
    const decorate = vi.fn(async (_sid: string, handoff: string) => `FORK\n\n${handoff}`);
    const reg = createAgentHandoffPendingRegistry(query, undefined, decorate);
    expect(await reg.peek('s1')).toBe('COMPOSED-BY-QUERY');
    // 未 accepted → 未 consume → 重试再 peek，仍是同一份，不叠加
    expect(await reg.peek('s1')).toBe('COMPOSED-BY-QUERY');
    expect(decorate).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('set 覆盖 DB 缓存后重新纳入 decorate(切换交接是新塞进来的,尚未组合)', async () => {
    const reg = createAgentHandoffPendingRegistry(
      async () => 'COMPOSED-BY-QUERY',
      undefined,
      async (_sid: string, handoff: string) => `FORK\n\n${handoff}`,
    );
    await reg.peek('s1');
    reg.set('s1', 'SWITCH-HANDOFF');
    expect(await reg.peek('s1')).toBe('FORK\n\nSWITCH-HANDOFF');
  });

  it('decorate 失败退回未组合的原值,不吞掉本来该注入的交接', async () => {
    const decorate = vi.fn(async () => {
      throw new Error('db down');
    });
    const reg = createAgentHandoffPendingRegistry(async () => null, undefined, decorate);
    reg.set('s1', 'SWITCH-HANDOFF');
    expect(await reg.peek('s1')).toBe('SWITCH-HANDOFF');
  });

  it('内存 miss 时经 DB 重建并缓存(重启恢复语义)', async () => {
    const query = vi.fn(async () => 'from-db');
    const reg = createAgentHandoffPendingRegistry(query);
    expect(await reg.peek('s1')).toBe('from-db');
    expect(await reg.peek('s1')).toBe('from-db');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('DB 查询失败按无 pending 处理且不缓存(下次重查)', async () => {
    const query = vi.fn(async () => {
      throw new Error('db down');
    });
    const reg = createAgentHandoffPendingRegistry(query);
    expect(await reg.peek('s1')).toBeNull();
    expect(await reg.peek('s1')).toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('clear 后回落 DB 查询', async () => {
    const query = vi.fn(async () => null);
    const reg = createAgentHandoffPendingRegistry(query);
    reg.set('s1', 'H1');
    reg.clear('s1');
    expect(await reg.peek('s1')).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('buildHandoffText 工作状态区(社区 handoff packet 口径)', () => {
  const opts = { fromLabel: 'Claude Code', toLabel: 'Codex' };

  it('从 tool_use 提取改动文件(Claude Edit/Write 与 Codex apply_patch)与命令', () => {
    const text = buildHandoffText(
      [
        msg('user', '改代码'),
        msg('tool_use', { toolUseId: 't1', toolName: 'Edit', input: { file_path: '/repo/a.ts' } }),
        msg('tool_use', { toolUseId: 't2', toolName: 'Write', input: { file_path: '/repo/b.ts' } }),
        msg('tool_use', { toolUseId: 't3', toolName: 'apply_patch', input: { path: '/repo/c.ts' } }),
        msg('tool_use', { toolUseId: 't4', toolName: 'Bash', input: { command: 'pnpm test:unit' } }),
        msg('tool_use', { toolUseId: 't5', toolName: 'shell', input: { command: ['git', 'status', '--short'] } }),
        msg('assistant', '改好了'),
      ],
      opts,
    );
    expect(text).toContain('== Work state (auto-extracted) ==');
    expect(text).toContain('- /repo/a.ts');
    expect(text).toContain('- /repo/b.ts');
    expect(text).toContain('- /repo/c.ts');
    expect(text).toContain('- pnpm test:unit');
    expect(text).toContain('- git status --short');
  });

  it('同一文件多次编辑去重;Read 等只读工具不进清单', () => {
    const text = buildHandoffText(
      [
        msg('user', 'q'),
        msg('tool_use', { toolUseId: 't1', toolName: 'Edit', input: { file_path: '/repo/a.ts' } }),
        msg('tool_use', { toolUseId: 't2', toolName: 'Edit', input: { file_path: '/repo/a.ts' } }),
        msg('tool_use', { toolUseId: 't3', toolName: 'Read', input: { file_path: '/repo/readonly.ts' } }),
      ],
      opts,
    );
    expect(text.match(/- \/repo\/a\.ts/g)).toHaveLength(1);
    // Read 的路径可出现在对话区的工具行,但不得进「改动过的文件」清单(行首 '- ')
    expect(text).not.toContain('- /repo/readonly.ts');
  });

  it('无工具活动时不渲染工作状态区', () => {
    const text = buildHandoffText([msg('user', '你好'), msg('assistant', '你好!')], opts);
    expect(text).not.toContain('== Work state');
  });

  it('framing 包含「先核对工作区、以工作区为准」纪律', () => {
    const text = buildHandoffText([msg('user', 'q')], opts);
    expect(text).toContain('git status');
    expect(text).toContain('the workspace always wins');
  });
});

describe('buildHandoffText 早期原文检索指引', () => {
  const opts = { fromLabel: 'Claude Code', toLabel: 'Codex' };

  it('提供 sessionId 时附带检索指引(两个工具名 + session_ids 定向)', () => {
    const text = buildHandoffText([msg('user', '你好')], { ...opts, sessionId: 'sess-abc' });
    expect(text).toContain('== Retrieving earlier verbatim history (use when needed) ==');
    expect(text).toContain('Session id: sess-abc');
    expect(text).toContain('search_chat_history');
    expect(text).toContain('get_chat_history');
    expect(text).toContain('"session_ids":["sess-abc"]');
    // 指引在结束标记之前
    expect(text.indexOf('Retrieving earlier verbatim history')).toBeLessThan(
      text.indexOf('End of handoff note'),
    );
  });

  it('不提供 sessionId 时不渲染检索指引', () => {
    const text = buildHandoffText([msg('user', '你好')], opts);
    expect(text).not.toContain('Retrieving earlier verbatim history');
    expect(text).not.toContain('get_chat_history');
  });
});

describe('buildHandoffText 增量(delta)模式:切回停泊引擎', () => {
  const opts = { fromLabel: 'Codex', toLabel: 'Claude Code', mode: 'delta' as const };

  it('framing 为归位续接口径,不用全量交接的"此前由 X 驱动"措辞', () => {
    const text = buildHandoffText([msg('user', '离开期间的问题'), msg('assistant', '回答')], opts);
    expect(text).toContain('You (Claude Code) worked on this conversation before');
    expect(text).toContain('now it is switching back to you');
    expect(text).toContain('a record of what happened while you were away');
    expect(text).not.toContain('from here on you (Claude Code) continue it');
    // 纪律保留:不向用户提及 + 以工作区为准
    expect(text).toContain('Do not mention this handoff note to the user');
    expect(text).toContain('the workspace always wins');
    expect(text.trimEnd().endsWith("== End of handoff note; the user's new message follows ==")).toBe(true);
  });

  it('工作状态区按 workStateMessages(全量历史)提取,对话区只含增量', () => {
    const full: HandoffSourceMessage[] = [
      msg('user', '最早的问题'),
      msg('tool_use', { toolUseId: 't1', toolName: 'Edit', input: { file_path: '/repo/early.ts' } }),
      msg('user', '离开期间的问题'),
    ];
    const delta: HandoffSourceMessage[] = [msg('user', '离开期间的问题', 200)];
    const text = buildHandoffText(delta, { ...opts, workStateMessages: full });
    expect(text).toContain('- /repo/early.ts'); // 全量工作状态
    expect(text).toContain('离开期间的问题');
    expect(text).not.toContain('最早的问题'); // 对话区不含水位线之前的内容
    expect(text).toContain('== Conversation while you were away ==');
  });

  it('空增量(切走后立即切回)显式说明,不留歧义', () => {
    const text = buildHandoffText([], opts);
    expect(text).toContain('== No new messages while you were away ==');
  });

  it('delta 模式同样附带检索指引(sessionId 提供时)', () => {
    const text = buildHandoffText([msg('user', 'q')], { ...opts, sessionId: 'sess-d1' });
    expect(text).toContain('== Retrieving earlier verbatim history (use when needed) ==');
    expect(text).toContain('"session_ids":["sess-d1"]');
  });

  it('full 模式(缺省)不受 delta 文案影响', () => {
    const text = buildHandoffText([msg('user', 'q')], { fromLabel: 'Codex', toLabel: 'Claude Code' });
    expect(text).toContain('from here on you (Claude Code) continue it');
    expect(text).not.toContain('now it is switching back to you');
    expect(text).not.toContain('No new messages while you were away');
  });
});

describe('buildHandoffText 超限收缩保住首尾', () => {
  it('极端长对话下检索指引与结束标记不被截掉(收缩逐字区而非切尾)', () => {
    const big = 'x'.repeat(50_000);
    const messages: HandoffSourceMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(msg('user', big));
      messages.push(msg('assistant', big));
    }
    const text = buildHandoffText(messages, {
      fromLabel: 'Claude Code',
      toLabel: 'Codex',
      sessionId: 'sess-tail',
    });
    expect(text.length).toBeLessThanOrEqual(16_000);
    expect(text).toContain('== Retrieving earlier verbatim history (use when needed) ==');
    expect(text).toContain('"session_ids":["sess-tail"]');
    expect(text.trimEnd().endsWith("== End of handoff note; the user's new message follows ==")).toBe(true);
  });

  /**
   * 工具密集 + 工作状态区 + 检索指引三者叠满时,逐字区收缩到 1 轮仍会超过硬上限,
   * 真正走到兜底截断分支(实测该构造正好顶到 16000)。英文 framing 比原中文长,
   * 触达上限更容易;裸 slice 会把结束标记连同检索指引的尾巴一并削掉,用户的新消息
   * 就失去了与内部历史的唯一显式分隔。
   */
  function capOverflowHistory(): HandoffSourceMessage[] {
    const out: HandoffSourceMessage[] = [];
    for (let i = 0; i < 25; i++) {
      out.push(msg('user', `Q${i} ${'x'.repeat(3_000)}`));
      out.push(msg('tool_use', {
        toolUseId: `e-${i}`,
        toolName: 'Edit',
        input: { file_path: `/repo/very/deep/path/segment/${i}/${'d'.repeat(120)}.ts` },
      }));
      out.push(msg('tool_use', {
        toolUseId: `b-${i}`,
        toolName: 'Bash',
        input: { command: `pnpm run something-${i} ${'c'.repeat(300)}` },
      }));
      out.push(msg('assistant', `A${i} ${'y'.repeat(3_000)}`));
    }
    for (let j = 0; j < 45; j++) {
      out.push(msg('tool_use', {
        toolUseId: `x-${j}`,
        toolName: 'Read',
        input: { file_path: `/repo/tail/${j}/${'t'.repeat(400)}.ts` },
      }));
    }
    return out;
  }

  it('逐字区收缩到底仍超限时,兜底截断也必须留住结束标记(不裸 slice 削尾)', () => {
    const text = buildHandoffText(capOverflowHistory(), {
      fromLabel: 'Claude Code',
      toLabel: 'Codex',
      sessionId: 'sess-cap',
    });
    expect(text.length).toBe(16_000); // 确实顶到上限 = 确实走了兜底分支
    expect(text.trimEnd().endsWith("== End of handoff note; the user's new message follows =="))
      .toBe(true);
  });

  it('message-deletion 兜底截断留住的是重建版结束标记', () => {
    const text = buildHandoffText(capOverflowHistory(), {
      fromLabel: 'Codex',
      toLabel: 'Codex',
      sessionId: 'sess-cap',
      reason: 'message-deletion',
    });
    expect(text.length).toBe(16_000);
    expect(text.trimEnd().endsWith("== End of rebuild note; the user's new message follows =="))
      .toBe(true);
  });

  it('单轮 100 条 tool_use 折叠中部,且硬上限/检索段/结束标记全部存活', () => {
    const messages: HandoffSourceMessage[] = [msg('user', '执行大量工具')];
    for (let i = 0; i < 100; i++) {
      messages.push(msg('tool_use', {
        toolUseId: `tool-${i}`,
        toolName: 'Read',
        input: { file_path: `/repo/${i}-${'x'.repeat(200)}.ts` },
      }));
    }
    const text = buildHandoffText(messages, {
      fromLabel: 'Claude Code',
      toLabel: 'Codex',
      sessionId: 'sess-tools',
    });
    expect(text.length).toBeLessThanOrEqual(16_000);
    expect(text).toContain('(60 tool calls omitted)');
    expect(text).toContain('== Retrieving earlier verbatim history (use when needed) ==');
    expect(text).toContain('"session_ids":["sess-tools"]');
    expect(text.trimEnd().endsWith("== End of handoff note; the user's new message follows ==")).toBe(true);
  });
});
