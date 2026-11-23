import { describe, expect, it } from 'vitest';
import {
  CINDY_TOOL_FOLD_ENV_NAMES,
  CINDY_TOOL_FOLD_EXTENSION_SOURCE,
} from '../pi-tool-fold-source.js';

type Block = { type: string; [key: string]: unknown };
type Message = { role?: string; toolCallId?: string; toolName?: string; isError?: boolean; content?: Block[]; [key: string]: unknown };
type Handler = (event: unknown) => unknown;
type Tool = { execute: (id: string, params: unknown) => Promise<{ content?: Block[]; isError?: boolean }> };

/** Run the shipped extension source the way pi loads it, capturing handlers and tools. */
function loadExtension(env: Record<string, string> = {}) {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  // Budget tests must not leak into the rest of the suite: reset what they switch off.
  process.env.CINDY_PI_TOOL_FOLD_ARG_CHARS = env.CINDY_PI_TOOL_FOLD_ARG_CHARS ?? '200';
  process.env.CINDY_PI_TOOL_FOLD_RECOVERY_CHARS = env.CINDY_PI_TOOL_FOLD_RECOVERY_CHARS ?? '120000';
  process.env.CINDY_PI_TOOL_FOLD_PIN_BUDGET = env.CINDY_PI_TOOL_FOLD_PIN_BUDGET ?? '64000';
  const body = CINDY_TOOL_FOLD_EXTENSION_SOURCE.replace(/^export default /m, '');
  const handlers: Record<string, Handler> = {};
  const tools: Record<string, Tool> = {};
  const pi = {
    on(name: string, fn: Handler) { handlers[name] = fn; },
    registerTool(tool: Tool & { name: string }) { tools[tool.name] = tool; },
  };
  new Function('pi', `const extension = ${body};\nextension(pi);`)(pi);
  if (!handlers.context) throw new Error('context handler was not registered');
  return { context: handlers.context, toolResult: handlers.tool_result, tool: tools.cindy_toolfold_read };
}

function call(id: string, name: string, args: Record<string, unknown>): Message {
  return { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] };
}

function result(id: string, name: string, text: string, isError = false): Message {
  return { role: 'toolResult', toolCallId: id, toolName: name, isError, content: [{ type: 'text', text }] };
}

function pairs(count: number, textLength = 2000): Message[] {
  const messages: Message[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `call-${index}`;
    messages.push(call(id, 'bash', { command: `run step ${index} ${'c'.repeat(420)}` }));
    messages.push(result(id, 'bash', `step ${index} ok ${'x'.repeat(textLength)}`));
  }
  return messages;
}

function isFolded(message: Message): boolean {
  const args = message.content?.[0]?.arguments as Record<string, unknown> | undefined;
  return args?.__folded === true;
}

function recordText(message: Message): string {
  return (message.content ?? []).map((block) => String(block.text ?? '')).join('\n');
}

function isRecord(message: Message): boolean {
  return message.role === 'assistant' && recordText(message).startsWith('[folded] ');
}

function callIds(messages: Message[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content ?? []) if (block.type === 'toolCall') ids.push(String(block.id));
  }
  return ids;
}

function records(messages: Message[]): string[] {
  return messages.filter(isRecord).map(recordText);
}

function projection(handler: Handler, messages: Message[]): Message[] {
  const changed = handler({ messages }) as { messages: Message[] } | undefined;
  return changed ? changed.messages : messages;
}

describe('cindy-tool-fold extension source', () => {
  it('leaves the transcript alone until the backlog reaches a batch', () => {
    const { context } = loadExtension({ CINDY_PI_TOOL_FOLD_KEEP: '8' });
    // 10 pairs, newest 8 stay resident: backlog 2 is below MIN_PAIRS and below MIN_CHARS.
    expect(context({ messages: pairs(10) })).toBeUndefined();
  });

  it('collapses the whole backlog into assistant records and keeps the newest 8 pairs verbatim', () => {
    const { context } = loadExtension({ CINDY_PI_TOOL_FOLD_KEEP: '8' });
    const messages = pairs(40);
    const out = projection(context, messages);
    // Each folded trip loses both halves; the records merge into the next assistant
    // message so two assistant messages never sit next to each other.
    expect(out).toHaveLength(16);
    expect(callIds(out)).toEqual(Array.from({ length: 8 }, (_, index) => `call-${index + 32}`));
    const foldedText = records(out).join('\n');
    // One batch, one line: the per-trip records are gone, so there is nothing shaped like
    // "command -> conclusion" for the model to re-use as its own narration template.
    expect(foldedText.match(/cindy_toolfold_read/g)).toHaveLength(1);
    // The records ride on the next assistant message, so the resident pair keeps its
    // original call block while the tail of the window is untouched.
    // Records ride on the next assistant message, so no two assistant messages end up
    // adjacent, which providers reject.
    for (let index = 1; index < out.length; index += 1) {
      expect([out[index - 1].role, out[index].role]).not.toEqual(['assistant', 'assistant']);
    }    const resident = out[out.length - 16];
    expect((resident.content as Block[]).find((block) => block.type === 'toolCall')).toEqual((messages[64].content as Block[])[0]);
    expect(out.slice(out.length - 14)).toEqual(messages.slice(66));
    const first = foldedText.slice(foldedText.indexOf('[folded]'));
    expect(first).toMatch(/^\[folded\] 32 round-trips, bash 32, \d+ chars, read with cindy_toolfold_read\("batch:call-0"\)$/m);
    // No command text and no per-call statistics survive in assistant position.
    expect(first).not.toContain('run step 0');
    expect(first).not.toContain('ok');
    // Protocol shape survives: every remaining result still answers an existing call.
    const ids = new Set<string>();
    for (const message of out) {
      if (message.role === 'assistant') {
        for (const block of message.content ?? []) if (block.type === 'toolCall') ids.add(String(block.id));
      } else if (message.role === 'toolResult') {
        expect(ids.has(String(message.toolCallId))).toBe(true);
      }
    }
    // Two assistant messages must never end up next to each other.
    for (let index = 1; index < out.length; index += 1) {
      expect(out[index].role === 'assistant' && out[index - 1].role === 'assistant').toBe(false);
    }
  });

  it('keeps the subject out of the assistant record and behind the batch pointer', async () => {
    const { context, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_KEEP: '8' });
    const messages = pairs(40);
    // A `read`-sized argument object: smaller than any pointer that would replace it.
    const args = { path: 'packages/maker-core/src/agents/pi/pi-tool-fold-source.ts', offset: 1, limit: 40 };
    messages[0] = call('call-0', 'read', args);
    const out = projection(context, messages);
    const record = records(out)[0];
    expect(record).toContain('read 1');
    // The path is recoverable but never sits in assistant position: a record that carries
    // "command -> conclusion" is exactly what the model re-uses as its own narration.
    expect(record).not.toContain(args.path);
    expect(callIds(out)).not.toContain('call-0');
    const batch = await tool.execute('t-batch', { call_id: 'batch:call-0' });
    expect(String(batch.content![0].text)).toContain(args.path);
  });

  it('collapses a trip even when the argument budget is switched off', () => {
    const { context } = loadExtension({ CINDY_PI_TOOL_FOLD_KEEP: '8', CINDY_PI_TOOL_FOLD_ARG_CHARS: '0' });
    const messages = pairs(40);
    const out = projection(context, messages);
    // ARG_CHARS only governs the fallback shape; a collapsed trip drops its arguments too.
    expect(callIds(out)).not.toContain('call-0');
    expect(records(out)[0]).toMatch(/^\[folded\] 32 round-trips, bash 32,/);
    expect(records(out).join('\n')).not.toContain('run step 0');
  });

  it('leaves no command text in the pointer when a pinned sibling forces the pair shape', async () => {
    const { context, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_KEEP: '1' });
    const messages: Message[] = [];
    for (let index = 0; index < 40; index += 1) {
      messages.push({ role: 'assistant', content: [
        { type: 'toolCall', id: `par-${index}a`, name: 'bash', arguments: { command: `first ${index} ${'c'.repeat(420)}` } },
        { type: 'toolCall', id: `par-${index}b`, name: 'bash', arguments: { command: `second ${index} ${'c'.repeat(420)}` } },
      ] as Block[] });
      messages.push(result(`par-${index}a`, 'bash', `a ok ${'x'.repeat(2000)}`));
      messages.push(result(`par-${index}b`, 'bash', `b ok ${'x'.repeat(2000)}`));
    }
    projection(context, messages);
    // Pinning one call of a parallel trip keeps the trip: the sibling falls back to a pointer.
    await tool.execute('t1', { call_id: 'par-0a' });
    const out = projection(context, messages);
    const pointer = callIds(out).includes('par-0b')
      ? (out.find((message) => callIds([message]).includes('par-0b'))!.content!.find((block) => block.type === 'toolCall' && block.id === 'par-0b')!.arguments as Record<string, unknown>)
      : undefined;
    expect(pointer).toEqual({ __folded: true, call: 'par-0b' });
    expect(JSON.stringify(pointer)).not.toContain('second 0');
  });

  it('leaves a batch alone when none of it would actually disappear', () => {
    const { context } = loadExtension({ CINDY_PI_TOOL_FOLD_KEEP: '8' });
    const messages: Message[] = [];
    // Small arguments plus a one-word result: the record line is longer than both, so
    // folding this batch would grow the context instead of shrinking it.
    for (let index = 0; index < 40; index += 1) {
      messages.push(call(`call-${index}`, 'read', { path: `packages/maker-core/src/agents/pi/file-${index}.ts` }));
      messages.push(result(`call-${index}`, 'read', 'ok'));
    }
    // Nothing folded: the handler leaves the transcript untouched.
    expect(projection(context, messages)).toBe(messages);
  });

  it('folds a large argument even when its own result is smaller than the record', async () => {
    const { context, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_KEEP: '1' });
    const messages: Message[] = [];
    for (let index = 0; index < 40; index += 1) {
      messages.push({ role: 'assistant', content: [
        { type: 'toolCall', id: `pin-${index}`, name: 'bash', arguments: { command: `echo pin ${index}` } },
        { type: 'toolCall', id: `big-${index}`, name: 'write', arguments: { path: 'a.ts', content: 'x'.repeat(400) } },
      ] as Block[] });
      messages.push(result(`pin-${index}`, 'bash', 'ok'));
      messages.push(result(`big-${index}`, 'write', 'ok'));
    }
    projection(context, messages);
    // Pinning one call keeps its trip verbatim, so the sibling falls back to the pointer
    // shape — and its oversized argument must still be folded there.
    await tool.execute('t-big', { call_id: 'pin-0' });
    const out = projection(context, messages)!;
    const block = (out[0].content as Block[]).find((item) => item.type === 'toolCall' && item.id === 'big-0')!;
    expect(block.arguments).toEqual({ __folded: true, call: 'big-0' });
  });

  it('leaves arguments alone when the pointer repeats an id longer than they are', async () => {
    const { context, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_KEEP: '1' });
    const longId = `call_${'x'.repeat(2000)}`;
    const args = { command: 'y'.repeat(240) };
    const messages: Message[] = [
      { role: 'assistant', content: [
        { type: 'toolCall', id: 'pin-0', name: 'bash', arguments: { command: 'echo pin' } },
        { type: 'toolCall', id: longId, name: 'bash', arguments: args },
      ] as Block[] },
      result('pin-0', 'bash', 'ok'),
      result(longId, 'bash', 'ok'),
      ...pairs(40),
    ];
    projection(context, messages);
    await tool.execute('t-long', { call_id: 'pin-0' });
    const out = projection(context, messages)!;
    // The pointer would carry the 2 KB id twice, so this block stays verbatim.
    const block = (out[0].content as Block[]).find((item) => item.type === 'toolCall' && item.id === longId)!;
    expect(block.arguments).toEqual(args);
  });

  it('keeps a record inside a turn when the next message is already a user turn', () => {
    const { context } = loadExtension({ CINDY_PI_TOOL_FOLD_KEEP: '8' });
    const messages: Message[] = [];
    for (let index = 0; index < 40; index += 1) {
      messages.push(call(`call-${index}`, 'bash', { command: `run step ${index}` }));
      messages.push(result(`call-${index}`, 'bash', `step ${index} ok ${'x'.repeat(2000)}`));
      if (index === 20) messages.push({ role: 'user', content: [{ type: 'text', text: 'next turn' }] });
    }
    const out = projection(context, messages);
    // One line per batch, anchored at the batch's tail: the whole span before the user
    // turn is gone and a single pointer sits after it.
    const at = out.findIndex((message) => message.role === 'user');
    expect(at).toBe(0);
    expect(isRecord(out[at + 1])).toBe(true);
    expect(records(out).join('\n')).toMatch(/^\[folded\] 32 round-trips,/m);
    expect(callIds(out)).not.toContain('call-0');
  });

  it('never projects more characters than the request carried', () => {
    const { context } = loadExtension();
    const messages = pairs(40);
    const out = projection(context, messages);
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(messages).length);
  });

  it('keeps folds sticky and does not rewrite them again until the next batch', () => {
    const { context } = loadExtension({ CINDY_PI_TOOL_FOLD_KEEP: '8' });
    const first = projection(context, pairs(40));
    const firstSavings = JSON.stringify(first).length;
    const again = projection(context, pairs(40));
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
    expect(JSON.stringify(again).length).toBe(firstSavings);
    const grown = projection(context, pairs(41));
    // One more pair is not a new batch: the earlier marks stay, the new pair joins the
    // resident window instead of being folded on its own.
    expect(callIds(grown)).toEqual(Array.from({ length: 9 }, (_, index) => `call-${index + 32}`));
    expect(isFolded(grown[grown.length - 4])).toBe(false);
  });

  it('never folds a round-trip that carries an image', () => {
    const { context } = loadExtension();
    const messages = pairs(40);
    messages[1] = {
      role: 'toolResult',
      toolCallId: 'call-0',
      toolName: 'read',
      content: [
        { type: 'text', text: 'image follows' },
        { type: 'image', data: 'a'.repeat(200) },
      ],
    };
    const out = projection(context, messages);
    expect(isFolded(out[0])).toBe(false);
    expect(out[1]).toBe(messages[1]);
  });

  it('recovers a folded original via cindy_toolfold_read and pins it until the next user message', async () => {
    const { context, tool } = loadExtension();
    const messages = pairs(40);
    projection(context, messages);
    const recovered = await tool.execute('t1', { call_id: 'call-5' });
    const text = String(recovered.content![0].text);
    expect(text).toContain('call: bash');
    expect(text).toContain('run step 5');
    expect(text).toContain('step 5 ok');
    // Pinned: the pair projects as originals again while everything else stays folded.
    const pinnedView = projection(context, messages);
    const pinnedAt = pinnedView.findIndex((message) => callIds([message]).includes('call-5'));
    expect(pinnedAt).toBeGreaterThan(-1);
    expect(pinnedView[pinnedAt + 1]).toBe(messages[11]);
    expect(records(pinnedView).join('\n')).not.toContain('call-5');
    expect(records(pinnedView).join('\n')).toContain('call-0');
    // Turn boundary: a new user message releases the pin and the trip collapses again.
    const nextTurn = [...messages, { role: 'user', content: [{ type: 'text', text: 'next turn' }] }];
    const released = projection(context, nextTurn);
    expect(callIds(released)).not.toContain('call-5');
    // The batch pointer still reaches the released trip's original text.
    const again = await tool.execute('t2', { call_id: 'call-5' });
    expect(String(again.content![0].text)).toContain('run step 5');
  });

  it('clears pins when compaction drops a user message and a new turn replaces it', async () => {
    const { context, tool } = loadExtension();
    const base = pairs(40);
    const turn1 = [{ role: 'user', content: [{ type: 'text', text: 'first turn' }] }, ...base];
    projection(context, turn1);
    await tool.execute('t2', { call_id: 'call-5' });
    expect(callIds(projection(context, turn1))).toContain('call-5');
    // 压缩掉了旧的 user 消息，新回合又补上一条：条数不变，边界仍必须识别出来，
    // 否则陈旧的 pin 会跟到新回合里继续占上下文。
    const turn2 = [...base, { role: 'user', content: [{ type: 'text', text: 'second turn' }] }];
    expect(callIds(projection(context, turn2))).not.toContain('call-5');
  });

  it('refuses a recovery the retention budget cannot hold instead of pinning it back', async () => {
    const { context, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_GIANT_BUDGET: '100000' });
    const messages = pairs(40);
    messages[22] = call('too-big', 'bash', { command: 'cat huge.log' });
    messages[23] = result('too-big', 'bash', 'z'.repeat(200000));
    projection(context, messages);
    const read = await tool.execute('t3', { call_id: 'too-big' });
    expect(read.isError).toBe(true);
    expect(String(read.content![0].text)).toContain('retention budget');
    // 转存被拒也不能钉住：否则一次取回就把整段原文塞回请求。
    expect(callIds(projection(context, messages))).not.toContain('too-big');
  });

  it('slices a large folded record without pinning the whole history back in', async () => {
    const { context, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: '1000' });
    const messages = pairs(40);
    messages[0] = call('huge-write', 'read', { path: 'big.txt' });
    messages[1] = result('huge-write', 'read', 'w'.repeat(30000));
    projection(context, messages);
    const recovered = await tool.execute('t-slice', { call_id: 'huge-write' });
    const text = String(recovered.content![0].text);
    expect(text.length).toBeLessThan(1200);
    expect(text).toContain('Call cindy_toolfold_read again with offset');
    // 部分读取不能钉住：钉住会把整段塞回下一次请求，读上限就白设了。
    const afterSlice = projection(context, messages);
    expect(callIds(afterSlice)).not.toContain('huge-write');
    expect(records(afterSlice).join('\n')).toContain('huge-write');
  });

  // Bug: 超过 pin 预算的记录存进 giants 时存的是“调用说明 + 参数 + 结果”整段，
  // 下次 findOriginal 又拼一次头部，续读的 offset 于是偏移，全文里出现两份参数。
  it('keeps continuation stable when a large record is re-admitted instead of pinned', async () => {
    const { context, tool } = loadExtension({
      CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: '1000',
      CINDY_PI_TOOL_FOLD_PIN_BUDGET: '2000',
    });
    const messages = pairs(40);
    const body = 'y'.repeat(3600);
    messages[22] = call('big-one', 'bash', { command: 'cat big.txt' });
    messages[23] = result('big-one', 'bash', body);
    projection(context, messages);

    const readAt = async (offset?: number) => {
      const read = await tool.execute('t-continue', offset === undefined ? { call_id: 'big-one' } : { call_id: 'big-one', offset });
      return String(read.content![0].text);
    };
    const first = await readAt();
    const next = Number(/with offset: (\d+)/.exec(first)![1]);
    const second = await readAt(next);
    const again = await readAt();
    // 同一个 id 再读一次必须得到同样的开头：重拼是稳定的（旧写法把整段又塞进 giants，
    // 第二次拼出的开头带着第二份“调用说明 + 参数”）。
    expect(again).toBe(first);
    // 续读从断点接著走：全长里头部只出现一次，结果体连续。
    const strip = (text: string) => text.replace(/\n\n\[truncated:[\s\S]*$/, '');
    const joined = strip(first) + strip(second);
    expect(joined.match(/arguments:/g)).toHaveLength(1);
    expect(joined.match(/result:/g)).toHaveLength(1);
    const bodyAt = joined.indexOf(body.slice(0, 64));
    expect(bodyAt).toBeGreaterThan(0);
    expect(joined.slice(bodyAt)).toBe(body.slice(0, joined.length - bodyAt));
    expect(joined.length).toBeGreaterThan(next);
  });

  it('recovers a folded result that merely quotes the truncation marker text', async () => {
    const { context, tool } = loadExtension();
    const messages = pairs(40);
    // Sub-threshold result whose text quotes the marker for a DIFFERENT call id —
    // the substring-only guard used to reject this despite holding the full text.
    messages[11] = {
      role: 'toolResult',
      toolCallId: 'call-5',
      toolName: 'read',
      content: [{ type: 'text', text: 'docs mention [truncated 100 of 200 chars; cindy_toolfold_read("call-0") returns the full text]' }],
    };
    projection(context, messages);
    const recovered = await tool.execute('t1', { call_id: 'call-5' });
    expect(recovered.isError).toBeUndefined();
    expect(String(recovered.content![0].text)).toContain('docs mention');
  });

  it('recovers a folded result whose tail merely looks like a not-retained marker', async () => {
    const { context, tool } = loadExtension();
    const messages = pairs(40);
    // The old guard accepted any trailing "full text not retained" wording; this text is a
    // literal quote, not a marker this extension wrote.
    messages[11] = {
      role: 'toolResult',
      toolCallId: 'call-5',
      toolName: 'read',
      content: [{ type: 'text', text: 'body ok [truncated 5 of 9 chars; full text not retained]' }],
    };
    projection(context, messages);
    const recovered = await tool.execute('t1', { call_id: 'call-5' });
    expect(recovered.isError).toBeUndefined();
    expect(String(recovered.content![0].text)).toContain('body ok');
  });

  it('leaves folded history unfolded on host text-only turns', () => {
    const flag = Symbol.for('cindy.pi.textOnlyTurn');
    const { context } = loadExtension();
    const messages = pairs(40);
    expect(records(projection(context, messages)).length).toBeGreaterThan(0);
    (globalThis as Record<symbol, unknown>)[flag] = true;
    try {
      // Every tool is blocked on these turns, so the summary must not replace the result.
      expect(records(projection(context, messages))).toHaveLength(0);
    } finally {
      delete (globalThis as Record<symbol, unknown>)[flag];
    }
    expect(records(projection(context, messages)).length).toBeGreaterThan(0);
  });

  it('restores retained results on text-only turns, where no tool can fetch them', async () => {
    const flag = Symbol.for('cindy.pi.textOnlyTurn');
    const { context, toolResult } = loadExtension();
    const body = 'lorem ipsum '.repeat(2400);
    const truncated = toolResult({ toolName: 'read', toolCallId: 'big-read', content: [{ type: 'text', text: body }] }) as { content: Block[] } | undefined;
    expect(truncated).toBeDefined();
    const preview = truncated!.content;
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'summarize the log' }] },
      call('big-read', 'read', { path: 'big.log' }),
      { role: 'toolResult', toolCallId: 'big-read', toolName: 'read', content: preview },
    ];
    const previewChars = preview.map((b) => String(b.text ?? '')).join('').length;
    expect(previewChars).toBeLessThan(body.length);
    (globalThis as Record<symbol, unknown>)[flag] = true;
    try {
      const out = projection(context, messages);
      const back = out.find((m) => m.role === 'toolResult' && m.toolCallId === 'big-read');
      // 工具被禁，摘要里的“去读”没有任何可行性；整段原文在预算内就要放回去。
      expect((back!.content ?? []).map((b) => String(b?.text ?? '')).join('')).toBe(body);
    } finally {
      delete (globalThis as Record<symbol, unknown>)[flag];
    }
  });

  it('keeps images while restoring the text of a truncated result', () => {
    const flag = Symbol.for('cindy.pi.textOnlyTurn');
    const { context, toolResult } = loadExtension();
    const body = 'lorem ipsum '.repeat(2400);
    const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
    const preview = (toolResult({ toolName: 'read', toolCallId: 'mixed', content: [{ type: 'text', text: body }, image] }) as { content: Block[] }).content;
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'what is in this screenshot' }] },
      call('mixed', 'read', { path: 'shot.png' }),
      { role: 'toolResult', toolCallId: 'mixed', toolName: 'read', content: preview },
    ];
    (globalThis as Record<symbol, unknown>)[flag] = true;
    try {
      const out = projection(context, messages)!;
      const back = out.find((m) => m.role === 'toolResult' && m.toolCallId === 'mixed')!;
      const blocks = back.content as Block[];
      // 只有文本被截断过，图片块原样保留，原文也只补文本。
      expect(blocks.map((b) => String(b?.text ?? '')).join('')).toBe(body);
      expect(blocks.some((b) => b?.type === 'image')).toBe(true);
    } finally {
      delete (globalThis as Record<symbol, unknown>)[flag];
    }
  });

  it('keeps the assistant text of a dropped round-trip', () => {
    // 一条消息里既有正文又有调用时，正文是模型自己的计划与结论，折叠不能连它一起删。
    const { context } = loadExtension();
    const messages = pairs(40);
    messages[22] = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'PLAN: rerun the flaky test before touching the parser' },
        { type: 'toolCall', id: 'call-22', name: 'bash', arguments: { command: 'pnpm test' } },
      ],
    } as Message;
    messages[23] = result('call-22', 'bash', 'ok '.repeat(200));
    const view = projection(context, messages)!;
    const text = view
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => (message.content as Array<{ type: string; text?: string }>))
      .map((block) => String(block.text ?? ''))
      .join('\n');
    expect(text).toContain('PLAN: rerun the flaky test');
    expect(callIds(view)).not.toContain('call-22');
    expect(text).toContain('read with cindy_toolfold_read(');
  });

  it('names the batch members it could not restore', async () => {
    // 批里一条只剩入库摘要、原文又不在 giants 时，整批取回必须点名缺项，
    // 静默跳过会让模型把半批内容当成整批原文。
    const { context, tool } = loadExtension();
    const preview = 'A ' + 'z'.repeat(1900) + '\n[truncated 28000 of 30001 chars; cindy_toolfold_read("p1") returns the full text]';
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'run both' }] },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'p1', name: 'bash', arguments: { command: 'run A' } },
          { type: 'toolCall', id: 'p2', name: 'bash', arguments: { command: 'run B' } },
        ],
      } as Message,
      { role: 'toolResult', toolCallId: 'p1', toolName: 'bash', content: [{ type: 'text', text: preview }] },
      { role: 'toolResult', toolCallId: 'p2', toolName: 'bash', content: [{ type: 'text', text: 'B ok' }] },
      ...pairs(40),
    ];
    const view = projection(context, messages)!;
    const batchId = /cindy_toolfold_read\("([^"]+)"\)/.exec(records(view).join('\n'))![1];
    const read = await tool.execute('t-batch', { call_id: batchId });
    const text = String(read.content![0].text);
    expect(text).toContain('B ok');
    expect(text).toMatch(/missing 1 of \d+ round-trips/);
    expect(text).toContain('p1 (full text evicted)');
  });

  it('keeps a batch alias inside the recovery schema limit for huge provider ids', async () => {
    const { context, tool } = loadExtension();
    const messages = pairs(40);
    const longId = 'call_' + 'z'.repeat(4100);
    messages[22] = call(longId, 'bash', { command: 'true' });
    messages[23] = result(longId, 'bash', 'r'.repeat(3000));
    const out = projection(context, messages);
    const alias = /cindy_toolfold_read\("([^"]+)"\)/.exec(records(out)[0])![1];
    expect(alias.length).toBeLessThanOrEqual(4096);
    const read = await tool.execute('t-long-id', { call_id: alias });
    expect(read.isError).toBeUndefined();
    expect(String(read.content![0].text)).toContain('true');
  });

  it('never names a batch after a live call id', async () => {
    const { context, tool } = loadExtension();
    const messages = pairs(40);
    // 第一条被折叠的调用是 call-0；provider 的 id 恰好等于它将用的别名时不能撞名。
    messages.push(call('batch:call-0', 'bash', { command: 'echo decoy' }), result('batch:call-0', 'bash', 'decoy'));
    const view = projection(context, messages)!;
    const alias = /cindy_toolfold_read\("([^"]+)"\)/.exec(records(view).join('\n'))![1];
    expect(alias).not.toBe('batch:call-0');
    const read = await tool.execute('t-shadow', { call_id: alias });
    expect(read.isError).toBeUndefined();
    expect(String(read.content![0].text)).toContain('run step 0');
    expect(String(read.content![0].text)).not.toContain('echo decoy');
  });

  it('keeps a pinned call verbatim while its parallel siblings stay folded', async () => {
    const { context, tool } = loadExtension();
    const trip: Message = {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'par-a', name: 'bash', arguments: { command: `run a ${'a'.repeat(420)}` } },
        { type: 'toolCall', id: 'par-b', name: 'bash', arguments: { command: `run b ${'b'.repeat(420)}` } },
      ],
    };
    const messages: Message[] = [
      trip,
      result('par-a', 'bash', `a ${'x'.repeat(2000)}`),
      result('par-b', 'bash', `b ${'y'.repeat(2000)}`),
      ...pairs(40),
    ];
    projection(context, messages);
    await tool.execute('t1', { call_id: 'par-a' });
    const pinned = projection(context, messages);
    const foldedIdsIn = (message: Message) => (message.content ?? [])
      .filter((block) => (block.arguments as Record<string, unknown> | undefined)?.__folded === true)
      .map((block) => String(block.id));
    expect(foldedIdsIn(pinned[0])).toEqual(['par-b']);
    expect(pinned[1]).toBe(messages[1]);
    expect(String(pinned[2].content![0].text)).toContain('[folded]');
  });

  it('charges a pinned call its own share of a parallel trip, not the whole trip', async () => {
    const { context, tool } = loadExtension({
      CINDY_PI_TOOL_FOLD_KEEP: '2',
      CINDY_PI_TOOL_FOLD_PIN_BUDGET: '3000',
    });
    const parallel: Message = {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'big', name: 'bash', arguments: { command: `big ${'b'.repeat(420)}` } },
        { type: 'toolCall', id: 'small', name: 'bash', arguments: { command: `small ${'s'.repeat(420)}` } },
      ],
    };
    const messages: Message[] = [
      parallel,
      result('big', 'bash', 'b'.repeat(2600)),
      result('small', 'bash', 's'.repeat(100)),
      call('other', 'bash', { command: `other ${'o'.repeat(420)}` }),
      result('other', 'bash', 'o'.repeat(500)),
      ...pairs(40),
    ];
    projection(context, messages);
    await tool.execute('t2', { call_id: 'other' });
    await tool.execute('t3', { call_id: 'small' });
    const after = projection(context, messages);
    const foldedIdsIn = (message: Message) => (message.content ?? [])
      .filter((block) => (block.arguments as Record<string, unknown> | undefined)?.__folded === true)
      .map((block) => String(block.id));
    // Charging the whole 2.7k-char trip to `small` would push the 3k budget over and evict `other`.
    expect(foldedIdsIn(after[0])).toEqual(['big']);
    expect(isFolded(after[3])).toBe(false);
  });

  it('recovers a result that ends with the id-less not-retained sentence', async () => {
    const { context, tool } = loadExtension();
    const messages = pairs(40);
    messages[11] = result('call-5', 'read', 'body ok\n[truncated 1 of 2 chars; full text not retained; re-run if needed]');
    projection(context, messages);
    const recovered = await tool.execute('t4', { call_id: 'call-5' });
    expect(recovered.isError).toBeUndefined();
    expect(String(recovered.content![0].text)).toContain('body ok');
  });

  it('rejects recovery when only the truncated preview of this id remains', async () => {
    const { context, toolResult, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_GIANTS: '8' });
    // 9 giants: giant-0 gets evicted from the registry by FIFO rotation.
    for (let index = 0; index < 9; index += 1) {
      toolResult({ toolName: 'bash', toolCallId: `giant-${index}`, content: [{ type: 'text', text: `body ${'z'.repeat(22000)}` }] });
    }
    // Simulate a resumed session: the transcript holds only the preview of giant-0.
    const preview = 'body zzz…\n[truncated 20000 of 22009 chars; cindy_toolfold_read("giant-0") returns the full text]';
    const messages = [
      call('giant-0', 'bash', { command: 'make big output' }),
      { role: 'toolResult', toolCallId: 'giant-0', toolName: 'bash', content: [{ type: 'text', text: preview }] },
      ...pairs(40),
    ];
    projection(context, messages);
    const rejected = await tool.execute('t1', { call_id: 'giant-0' });
    expect(rejected.isError).toBe(true);
    expect(String(rejected.content![0].text)).toContain('giant-0');
    // Its own-marker preview while the registry still holds it stays recoverable.
    const kept = await tool.execute('t2', { call_id: 'giant-8' });
    expect(kept.isError).toBeUndefined();
    expect(String(kept.content![0].text)).toContain('body zz');
  });

  it('matches tool-call ids from a provider that emits prototype key names', () => {
    const { context } = loadExtension();
    const messages: Message[] = [
      call('hasOwnProperty', 'bash', { command: 'run with a hostile id' }),
      result('hasOwnProperty', 'bash', 'done ok'),
      { role: 'user', content: [{ type: 'text', text: 'turn 2' }] },
      call('call-0', 'bash', { command: 'fill backlog beyond the pairs gate' }),
      result('call-0', 'bash', `step ok ${'x'.repeat(2000)}`),
    ];
    // Must not throw from a boolean shadowing hasOwnProperty on the ids lookup.
    expect(() => projection(context, messages)).not.toThrow();
  });

  it('keeps an over-budget recovery out of the pin budget instead of exempting it', async () => {
    // 记录卡本身超过 pin 预算时，恢复结果不能既回灌原文、又被 pin 回下一次请求：
    // “至少保留一条”的豁免会让同一段文本出现两份，顶穿接近满的上下文。
    const { context, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_PIN_BUDGET: '1' });
    const messages = pairs(40);
    projection(context, messages);
    await tool.execute('t1', { call_id: 'call-2' });
    const view = projection(context, messages);
    // The recovery was over the per-read budget, so it is not pinned back in: the trip
    // stays collapsed instead of paying twice for the same text.
    expect(callIds(view)).not.toContain('call-2');
    expect(records(view).join('\n')).toContain('read with cindy_toolfold_read("batch:call-0")');
  });

  it('bounds retained giant payloads by aggregate characters, not just entry count', async () => {
    // Budget 100k chars: three 60k payloads cannot all stay resident.
    const { context, toolResult, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_GIANT_BUDGET: '100000' });
    const payload = 'z'.repeat(60000);
    for (const id of ['g1', 'g2', 'g3']) {
      const out = toolResult({ toolName: 'bash', toolCallId: id, content: [{ type: 'text', text: payload }] }) as { content: Block[] };
      expect(out).toBeDefined();
    }
    // g1 and g2 were evicted by the aggregate budget: their records promise recovery but
    // the registry no longer holds them, so recovery refuses instead of serving a preview.
    projection(context, [
      call('g1', 'bash', { command: 'make g1' }),
      { role: 'toolResult', toolCallId: 'g1', toolName: 'bash', content: [{ type: 'text', text: 'z'.repeat(2000) + '\n[truncated 58000 of 60000 chars; cindy_toolfold_read("g1") returns the full text]' }] } as unknown as { content: Block[] },
    ]);
    const refused = await tool.execute('t1', { call_id: 'g1' });
    expect(refused.isError).toBe(true);
    expect(String(refused.content![0].text)).toContain('no longer available');
    // The newest payload is still resident and recovers in full.
    const live = await tool.execute('t2', { call_id: 'g3' });
    expect(live.isError).toBeUndefined();
    expect(String(live.content![0].text)).toContain(payload);
  });

  it('does not retain a single payload larger than the aggregate budget', async () => {
    const { context, toolResult, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_GIANT_BUDGET: '100000' });
    const huge = 'w'.repeat(150000);
    const out = toolResult({ toolName: 'bash', toolCallId: 'huge-1', content: [{ type: 'text', text: huge }] }) as { content: Block[] };
    const text = (out.content ?? []).map((b) => String(b.text ?? '')).join('\n');
    expect(text).toContain('full text not retained');
    projection(context, [
      call('huge-1', 'bash', { command: 'make huge' }),
      { role: 'toolResult', toolCallId: 'huge-1', toolName: 'bash', content: [{ type: 'text', text }] } as unknown as { content: Block[] },
    ]);
    const refused = await tool.execute('t1', { call_id: 'huge-1' });
    expect(refused.isError).toBe(true);
    expect(String(refused.content![0].text)).toContain('re-run the command');
  });

  it('recovers a giant with its call arguments, not only the stored result text', async () => {
    const { context, toolResult, tool } = loadExtension();
    const giant = 'q'.repeat(25000);
    toolResult({ toolName: 'bash', toolCallId: 'giant-arg', content: [{ type: 'text', text: giant }] });
    // Put the truncated round-trip into the conversation so the call block is visible.
    const messages = pairs(40);
    messages.splice(0, 0,
      { role: 'assistant', content: [{ type: 'toolCall', id: 'giant-arg', name: 'bash', arguments: { command: 'cat big.txt --flag' } }] },
      { role: 'toolResult', toolCallId: 'giant-arg', toolName: 'bash', content: [{ type: 'text', text: 'q'.repeat(2000) + '\n[truncated 23000 of 25000 chars; cindy_toolfold_read("giant-arg") returns the full text]' }] });
    projection(context, messages);
    const recovered = await tool.execute('t1', { call_id: 'giant-arg' });
    const text = String(recovered.content![0].text);
    expect(text).toContain('call: bash');
    expect(text).toContain('cat big.txt --flag');
    expect(text).toContain('arguments:');
    expect(text).toContain('q'.repeat(2000));
  });

  it('truncates giant results at ingestion and recovers the full text from the in-memory registry', async () => {
    const { context, toolResult, tool } = loadExtension();
    const giant = 'y'.repeat(25000);
    const truncated = toolResult({ toolName: 'bash', toolCallId: 'giant-1', content: [{ type: 'text', text: giant }] }) as { content: Block[] } | undefined;
    expect(truncated).toBeDefined();
    const kept = (truncated!.content ?? []).map((b) => String(b.text ?? '')).join('\n');
    expect(kept.startsWith('y'.repeat(2000))).toBe(true);
    expect(kept.length).toBeLessThan(2600);
    expect(kept).toContain('cindy_toolfold_read("giant-1")');
    expect(toolResult({ toolName: 'bash', toolCallId: 'giant-2', content: [{ type: 'text', text: 'small' }] })).toBeUndefined();
    // structuredContent must survive a rewrite (pi drops it when only content is returned).
    const structured = toolResult({ toolName: 'mcp__x__y', toolCallId: 'giant-3', content: [{ type: 'text', text: giant }], structuredContent: { ok: true } }) as { structuredContent?: unknown };
    expect(structured.structuredContent).toEqual({ ok: true });
    // The full original is recoverable even though the transcript only holds the truncation.
    const recovered = await tool.execute('t1', { call_id: 'giant-1' });
    expect(String(recovered.content![0].text)).toContain(giant);
    // A truncated result still folds normally afterwards.
    const messages = pairs(40);
    messages[1] = { role: 'toolResult', toolCallId: 'call-0', toolName: 'bash', content: [{ type: 'text', text: kept }] };
    const out = projection(context, messages);
    expect(isRecord(out[0])).toBe(true);
  });

  it('bounds the text of an image-bearing result and keeps the image', async () => {
    const { toolResult, tool } = loadExtension();
    const giant = 'z'.repeat(25000);
    const out = toolResult({
      toolName: 'mcp__shot__capture',
      toolCallId: 'img-1',
      content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }, { type: 'text', text: giant }],
    }) as { content: Block[] } | undefined;
    expect(out).toBeDefined();
    const blocks = out!.content ?? [];
    expect(blocks.some((b) => b.type === 'image')).toBe(true);
    const kept = blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('\n');
    expect(kept.length).toBeLessThan(2600);
    expect(kept).toContain('cindy_toolfold_read("img-1")');
    const recovered = await tool.execute('t-img', { call_id: 'img-1' });
    expect(String(recovered.content![0].text)).toContain(giant);
  });

  it('counts parallel calls, not messages, toward the pairs gate', () => {
    const { context } = loadExtension({ CINDY_PI_TOOL_FOLD_MIN_PAIRS: '32', CINDY_PI_TOOL_FOLD_MIN_CHARS: '1000000000', CINDY_PI_TOOL_FOLD_KEEP: '1' });
    // One assistant message with 32 parallel calls: 32 complete pairs in one trip.
    const blocks = Array.from({ length: 32 }, (_, i) => ({ type: 'toolCall', id: `par-${i}`, name: 'bash', arguments: { command: `parallel step ${i} ${'p'.repeat(420)}` } }));
    const results = blocks.map((b, i) => result(String(b.id), 'bash', `parallel ${i} ok ${'z'.repeat(800)}`));
    // A newer trailing pair keeps the 32-call trip outside the KEEP=1 resident window.
    const messages: Message[] = [
      { role: 'assistant', content: blocks as Block[] },
      ...results,
      call('tail-1', 'bash', { command: 'tail probe' }),
      result('tail-1', 'bash', 'tail ok'),
    ];
    const out = projection(context, messages);
    expect(isRecord(out[0])).toBe(true);
    // The whole parallel trip is gone: no pointer left behind for any of its 32 calls.
    expect(callIds(out)).toEqual(['tail-1']);
    expect(records(out).join('\n')).toMatch(/^\[folded\] 1 round-trip, bash 32,/m);
    expect(records(out).join('\n')).not.toContain('parallel 0 ok');
  });

  it('keeps live fold marks when the registry cap is pruned', () => {
    // MAX_FOLDED min is 100: the probe must produce more than 100 live marks before the
    // prune branch runs, otherwise the test cannot distinguish prune from wipe.
    const { context } = loadExtension({ CINDY_PI_TOOL_FOLD_MIN_PAIRS: '512', CINDY_PI_TOOL_FOLD_MIN_CHARS: '240000', CINDY_PI_TOOL_FOLD_KEEP: '1', CINDY_PI_TOOL_FOLD_MAX_FOLDED: '100' });
    // First pass: one large batch folds 120 pairs -> registry 120 > cap 100.
    const first = projection(context, pairs(120));
    expect(records(first).join('\n')).toContain('call-0');
    // Second pass doubles the backlog: the 120 new pairs form a new batch, the prune
    // path runs with 121 live marks against cap 100, and every old id stays live.
    const grown = pairs(240);
    const second = projection(context, grown);
    // Old marks survive the prune: no full-text rebound for any of the first batch.
    expect(records(second).join('\n')).toContain('call-0');
    expect(records(second).join('\n')).toContain('call-119');
    // The newer backlog folds too, and the newest 1 pair stays verbatim (KEEP=1).
    expect(callIds(second)).toEqual(['call-239']);
  });

  it('rejects recovery of an evicted giant instead of serving the transcript preview', async () => {
    const { context, toolResult, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_GIANTS: '8', CINDY_PI_TOOL_FOLD_KEEP: '1' });
    // 8 giants fill the registry; the 9th evicts giant-0 (oldest first).
    for (let i = 0; i < 9; i += 1) {
      toolResult({ toolName: 'bash', toolCallId: `giant-${i}`, content: [{ type: 'text', text: `payload ${i} ${'g'.repeat(25000)}` }] });
    }
    // The transcript keeps only the truncation preview, as pi would store it; the
    // tool_result hook passes it through (small enough), so build it inline.
    const previewText = 'payload 0 ' + 'g'.repeat(1800) + '\n[truncated 23000 of 25011 chars; cindy_toolfold_read("giant-0") returns the full text]';
    const preview = { role: 'toolResult', toolCallId: 'giant-0', toolName: 'bash', content: [{ type: 'text', text: previewText }] } as unknown as { content: Block[] };
    expect(preview).toBeDefined();
    projection(context, [
      call('giant-0', 'bash', { command: 'make giant 0' }),
      preview!,
    ]);
    const refused = await tool.execute('t1', { call_id: 'giant-0' });
    expect(refused.isError).toBe(true);
    expect(String(refused.content![0].text)).toContain('full text is no longer available');
    // A live giant still recovers.
    const live = await tool.execute('t2', { call_id: 'giant-8' });
    expect(String(live.content![0].text)).toContain(`payload 8 ${'g'.repeat(25000)}`);
  });
  it('slices a giant recovery at the per-read limit and resumes from an offset', async () => {
    const { context, toolResult, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: '1000' });
    const big = 'body ' + 'z'.repeat(22000);
    toolResult({ toolName: 'bash', toolCallId: 'giant-8', content: [{ type: 'text', text: big }] });
    projection(context, [
      call('giant-8', 'bash', { command: 'make giant 8' }),
      { role: 'toolResult', toolCallId: 'giant-8', toolName: 'bash', content: [{ type: 'text', text: 'body zzz…' }] } as unknown as { content: Block[] },
    ]);
    const first = await tool.execute('t1', { call_id: 'giant-8' });
    const firstText = String(first.content![0].text);
    // 一次回灌 22k 字符会顶穿下一次请求的上下文窗口；切片后必须告诉模型怎么续读。
    expect(firstText.length).toBeLessThan(big.length);
    expect(firstText).toContain('remaining');
    expect(firstText).toContain('offset');
    const resumeAt = Number(/offset: (\d+)/.exec(firstText)![1]);
    expect(resumeAt).toBeGreaterThan(0);
    const rest = await tool.execute('t2', { call_id: 'giant-8', offset: resumeAt });
    expect(rest.isError).toBeUndefined();
    expect(String(rest.content![0].text)).not.toContain('past the end');
  });

  it('forwards every knob the extension reads to remote Pi sessions', () => {
    // A knob that exists in the extension but is missing from the forward list is
    // silently ignored on remote sessions (the default applies instead).
    const read = new Set<string>();
    const pattern = /CINDY_PI_TOOL_FOLD[A-Z_]*/g;
    let hit = pattern.exec(CINDY_TOOL_FOLD_EXTENSION_SOURCE);
    while (hit !== null) {
      read.add(hit[0]);
      hit = pattern.exec(CINDY_TOOL_FOLD_EXTENSION_SOURCE);
    }
    const forwarded = new Set<string>(CINDY_TOOL_FOLD_ENV_NAMES);
    expect([...read].filter((name) => !forwarded.has(name))).toEqual([]);
    expect(forwarded.has('CINDY_PI_TOOL_FOLD_GIANT_BUDGET')).toBe(true);
  });
});
