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
  const settings: Record<string, string> = {
    ...env,
    // Budget tests must not leak into the rest of the suite: reset what they switch off.
    CINDY_PI_TOOL_FOLD_ARG_CHARS: env.CINDY_PI_TOOL_FOLD_ARG_CHARS ?? '200',
    CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: env.CINDY_PI_TOOL_FOLD_RECOVERY_CHARS ?? '120000',
    CINDY_PI_TOOL_FOLD_PIN_BUDGET: env.CINDY_PI_TOOL_FOLD_PIN_BUDGET ?? '64000',
  };
  // The extension reads every setting while it loads, so nothing observes process.env afterwards:
  // set, load, put back.
  const before = Object.keys(settings).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, settings);
  const body = CINDY_TOOL_FOLD_EXTENSION_SOURCE.replace(/^export default /m, '');
  const handlers: Record<string, Handler> = {};
  const tools: Record<string, Tool> = {};
  const pi = {
    on(name: string, fn: Handler) { handlers[name] = fn; },
    registerTool(tool: Tool & { name: string }) { tools[tool.name] = tool; },
  };
  try {
    new Function('pi', `const extension = ${body};
extension(pi);`)(pi);
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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
  // 批记录 = 带 {"batch":"r…"} 的那一行，现在是一条 toolResult（模型写不到的角色）。
  const text = recordText(message);
  return text.startsWith('[folded] ') && /\{"batch":"r\d+"\}/.test(text);
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

function refsOf(messages: Message[]): string[] {
  return records(messages).flatMap((line) => Array.from(line.matchAll(/cindy_toolfold_read\(\{"batch":"([^"]+)"\}\)/g), (match) => match[1]));
}

function textChars(messages: Message[]): number {
  let total = 0;
  for (const message of messages) {
    for (const block of message.content ?? []) {
      if (typeof block.text === 'string') total += block.text.length;
      // 与扩展的 contentChars 同口径：被删的参数也算进来源字节。
      if (block.type === 'toolCall' && block.arguments) total += JSON.stringify(block.arguments).length;
    }
  }
  return total;
}

function projection(handler: Handler, messages: Message[]): Message[] {
  const changed = handler({ messages }) as { messages: Message[] } | undefined;
  return changed ? changed.messages : messages;
}

/** 翻完整批并把页拼回去；每页都不得超过 limit（上限以内的成员 + 至多一条整行放行的缺项说明 + 一条续读提示）。 */
async function readWholeBatch(tool: Tool, batchId: string, limit: number) {
  const next = (body: string) => /"batch":"[^"]+","at":(\d+),"offset":(\d+)\}\) to continue\.\]$/.exec(body);
  const pages: string[] = [];
  let joined = '';
  let params: Record<string, unknown> = { batch: batchId };
  for (let guard = 0; guard < 60; guard += 1) {
    const raw = String((await tool.execute('w' + guard, params)).content![0].text).replace(/^Cannot recover batch \S+: /, '');
    const again = next(raw);
    const body = raw.replace(/\n\n\[truncated: [^\n]*\]$/, '');
    expect(raw.length).toBeLessThanOrEqual(limit);
    pages.push(body);
    // 成员内部续读的两页之间没有分隔；成员开头续读的补回成员之间的分隔。
    joined += (pages.length > 1 && Number(params.offset) > 0 ? '' : (pages.length > 1 ? '\n\n' : '')) + body;
    if (!again) break;
    params = { batch: batchId, at: Number(again[1]), offset: Number(again[2]) };
  }
  return { pages, joined };
}

describe('cindy-tool-fold extension source', () => {
  it('leaves the transcript alone until the backlog reaches a batch', () => {
    const { context } = loadExtension({ CINDY_PI_TOOL_FOLD_KEEP: '8' });
    // 10 pairs, newest 8 stay resident: backlog 2 is below MIN_PAIRS and below MIN_CHARS.
    expect(context({ messages: pairs(10) })).toBeUndefined();
  });

  it('collapses the whole backlog into one tool-result record and keeps the newest 8 pairs verbatim', () => {
    const { context } = loadExtension({ CINDY_PI_TOOL_FOLD_KEEP: '8' });
    const messages = pairs(40);
    const out = projection(context, messages);
    // Every folded trip loses both halves except the batch's last one: it keeps its call
    // so the record can take the place of its result. Call and result stay paired.
    expect(out).toHaveLength(18);
    expect(callIds(out)).toEqual(Array.from({ length: 9 }, (_, index) => `call-${index + 31}`));
    expect(out[0]).toMatchObject({ role: 'assistant', content: [{ type: 'toolCall', id: 'call-31', name: 'bash' }] });
    expect(out[1]).toMatchObject({ role: 'toolResult', toolCallId: 'call-31' });
    expect(isRecord(out[1])).toBe(true);
    const foldedText = records(out).join('\n');
    // One batch, one line: the per-trip records are gone, so there is nothing shaped like
    // "command -> conclusion" for the model to re-use as its own narration template.
    expect(foldedText.match(/cindy_toolfold_read/g)).toHaveLength(1);
    // No two assistant messages end up adjacent, which providers reject.
    for (let index = 1; index < out.length; index += 1) {
      expect([out[index - 1].role, out[index].role]).not.toEqual(['assistant', 'assistant']);
    }
    const resident = out[out.length - 16];
    expect((resident.content as Block[]).find((block) => block.type === 'toolCall')).toEqual((messages[64].content as Block[])[0]);
    expect(out.slice(out.length - 14)).toEqual(messages.slice(66));
    const first = foldedText.slice(foldedText.indexOf('[folded]'));
    expect(first).toMatch(/^\[folded\] 32 round-trips, bash 32, \d+ chars, read with cindy_toolfold_read\(\{"batch":"r\d+"\}\)$/m);
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
    const batch = await tool.execute('t-batch', { batch: refsOf(out)[0] });
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
    // turn is gone; the anchor call and its record sit right after it, inside the turn.
    const at = out.findIndex((message) => message.role === 'user');
    expect(at).toBe(0);
    expect(out.slice(at + 1, at + 3).map((message) => message.role)).toEqual(['assistant', 'toolResult']);
    expect(isRecord(out[at + 2])).toBe(true);
    expect(out[at + 1]).toMatchObject({ content: [expect.objectContaining({ type: 'toolCall', id: 'call-31' })] });
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
    // resident window instead of being folded on its own. The folded batch keeps its
    // anchor call: the record rides on that call's result.
    expect(callIds(grown)).toEqual(Array.from({ length: 10 }, (_, index) => `call-${index + 31}`));
    expect(isFolded(grown[grown.length - 4])).toBe(false);
    expect(records(grown).join('\n')).toBe(records(first).join('\n'));
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
    // 记录行不点名成员，也不因钉住一条而改变：一批始终只有一条记录。
    expect(records(pinnedView)).toHaveLength(1);
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
    expect(text).toContain('Call cindy_toolfold_read({"call_id":"huge-write","offset":');
    // 部分读取不能钉住：钉住会把整段塞回下一次请求，读上限就白设了。
    const afterSlice = projection(context, messages);
    expect(callIds(afterSlice)).not.toContain('huge-write');
    expect(records(afterSlice)).toHaveLength(1);
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
    const next = Number(/"offset":(\d+)/.exec(first)![1]);
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
      content: [{ type: 'text', text: 'docs mention [truncated 100 of 200 chars; cindy_toolfold_read({"call_id":"call-0"}) returns the full text]' }],
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
    // The batch record is a tool result: host text never lands in the assistant position,
    // where the model would read it as something it said itself.
    expect(records(view)).toHaveLength(1);
    expect(view.filter((message) => message.role === 'assistant').some(isRecord)).toBe(false);
    expect(text).not.toContain('[folded] ');
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
    const batchId = /cindy_toolfold_read\(\{"batch":"([^"]+)"\}\)/.exec(records(view).join('\n'))![1];
    const read = await tool.execute('t-batch', { batch: batchId });
    const text = String(read.content![0].text);
    expect(text).toContain('B ok');
    // 缺项在它自己的成员位置上点名（p1 在 p2 之前），不是页尾另附的清单。
    const named = '[missing round-trip p1 (full text evicted); re-run that command]';
    expect(text).toContain(named);
    expect(text.indexOf(named)).toBeLessThan(text.indexOf('B ok'));
  });

  it('keeps the batch id short no matter how long the provider id is', async () => {
    const { context, tool } = loadExtension();
    const messages = pairs(40);
    const longId = 'call_' + 'z'.repeat(4100);
    messages[22] = call(longId, 'bash', { command: 'true' });
    messages[23] = result(longId, 'bash', 'r'.repeat(3000));
    const out = projection(context, messages);
    const ref = refsOf(out)[0];
    // 批 id 在登记时分配，与成员 id 长度无关：不会超 4096 的取回参数上限。
    expect(ref.length).toBeLessThanOrEqual(8);
    const read = await tool.execute('t-long-id', { batch: ref });
    expect(read.isError).toBeUndefined();
    expect(String(read.content![0].text)).toContain('true');
  });

  it('keeps batch refs and call ids in separate namespaces', async () => {
    const { context, tool } = loadExtension();
    const messages = pairs(40);
    // provider 的 id 叫 r1 完全合法：批用 batch 参数、调用用 call_id 参数，
    // 两个名字空间不共享，所以同名的批和调用可以各自打开。
    messages.push(call('r1', 'bash', { command: 'echo decoy one' }), result('r1', 'bash', 'decoy one'));
    // 调用 id 以 "batch:" 开头也只是一个调用 id：标识符按字段解释，不按字符串形状猜含义。
    messages.push(call('batch:call-0', 'bash', { command: 'echo decoy three' }), result('batch:call-0', 'bash', 'decoy three'));
    const view = projection(context, messages)!;
    const ref = refsOf(view)[0];
    expect(ref).toBe('r1');
    const batchRead = await tool.execute('t-batch', { batch: ref });
    expect(String(batchRead.content![0].text)).toContain('run step 0');
    expect(String(batchRead.content![0].text)).not.toContain('decoy one');
    const callRead = await tool.execute('t-call', { call_id: 'r1' });
    expect(String(callRead.content![0].text)).toContain('echo decoy one');
    const shapedRead = await tool.execute('t-shaped', { call_id: 'batch:call-0' });
    expect(String(shapedRead.content![0].text)).toContain('echo decoy three');
    expect(String(shapedRead.content![0].text)).not.toContain('run step 0');
  });

  it('keeps a batch readable after a later call takes the same id and folds', async () => {
    const { context, tool } = loadExtension();
    const messages = pairs(40);
    messages.push(call('r1', 'bash', { command: 'echo decoy two' }), result('r1', 'bash', 'decoy two'));
    const first = projection(context, messages)!;
    expect(refsOf(first)[0]).toBe('r1');
    // 同名调用稍后才出现，而且同样被折叠：折叠标记落在调用 id 上，不能影响批解析。
    const second = projection(context, messages.concat(pairs(40, 40)))!;
    expect(refsOf(second)).toContain('r1');
    const batchRead = await tool.execute('t-batch2', { batch: 'r1' });
    expect(String(batchRead.content![0].text)).toContain('run step 0');
    const callRead = await tool.execute('t-call2', { call_id: 'r1' });
    expect(String(callRead.content![0].text)).toContain('echo decoy two');
  });

  it('spends the text-only expansion budget on the newest results first', () => {
    const flag = Symbol.for('cindy.pi.textOnlyTurn');
    const { context, toolResult } = loadExtension();
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];
    for (const tag of ['old', 'mid', 'new']) {
      const body = tag + ' ' + 'z'.repeat(25000);
      const preview = (toolResult({ toolName: 'bash', toolCallId: tag, content: [{ type: 'text', text: body }] }) as { content: Block[] }).content;
      messages.push(call(tag, 'bash', { command: 'run ' + tag }), { role: 'toolResult', toolCallId: tag, toolName: 'bash', content: preview });
    }
    (globalThis as Record<symbol, unknown>)[flag] = true;
    try {
      const out = projection(context, messages)!;
      const textOfBlocks = (m: Message) => (m.content as Block[]).map((b) => String(b?.text ?? '')).join('');
      const newest = out.find((m) => m.role === 'toolResult' && m.toolCallId === 'new')!;
      const oldest = out.find((m) => m.role === 'toolResult' && m.toolCallId === 'old')!;
      expect(textOfBlocks(newest).length).toBeGreaterThan(20000);
      expect(textOfBlocks(oldest).length).toBeLessThan(3000);
    } finally {
      delete (globalThis as Record<symbol, unknown>)[flag];
    }
  });

  it('charges image bytes against the giant budget', async () => {
    const { context, toolResult, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_GIANT_BUDGET: '100000' });
    const admit = (id: string) => (toolResult({
      toolName: 'mcp',
      toolCallId: id,
      content: [
        { type: 'text', text: id + ' ' + 't'.repeat(21000) },
        { type: 'image', data: 'i'.repeat(30000), mimeType: 'image/png' },
      ],
    }) as { content: Block[] }).content;
    const first = admit('img-a');
    const second = admit('img-b');
    // 只按文本算两条共 42k 都会留下；算上图片各 51k，合计超 100k，最老的被挤掉。
    projection(context, [
      call('img-a', 'mcp', { cmd: 'run a' }),
      { role: 'toolResult', toolCallId: 'img-a', toolName: 'mcp', content: first } as Message,
      call('img-b', 'mcp', { cmd: 'run b' }),
      { role: 'toolResult', toolCallId: 'img-b', toolName: 'mcp', content: second } as Message,
    ]);
    const gone = await tool.execute('t-img-a', { call_id: 'img-a' });
    expect(gone.isError).toBe(true);
    const live = await tool.execute('t-img-b', { call_id: 'img-b' });
    expect(live.isError).toBeFalsy();
  });

  it('keeps folding after a pin instead of reviving dropped originals', async () => {
    const { context, tool } = loadExtension();
    const messages = pairs(40);
    projection(context, messages);
    await tool.execute('t-pin', { call_id: 'call-5' });
    // 钉住之后重投影：删除安排（outline）不能被单条调用信息覆盖，否则整批原文又冒出来。
    const second = projection(context, messages)!;
    expect(records(second).join('\n')).toContain('[folded]');
    expect(callIds(second)).toContain('call-5');
    expect(callIds(second)).not.toContain('call-6');
    expect(textChars(second)).toBeLessThanOrEqual(textChars(messages));
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
    // Simulate a resumed session: the transcript holds only the preview of giant-0, in the
    // shape earlier versions persisted (a bare-string call). That shape must still be recognized.
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
    expect(records(view).join('\n')).toMatch(/read with cindy_toolfold_read\(\{"batch":"r\d+"\}\)/);
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
    // Both persisted shapes of the marker must be recognized: the bare-string call that
    // earlier versions wrote (resumed sessions still carry it) and the JSON form written now.
    for (const example of ['cindy_toolfold_read("g1")', 'cindy_toolfold_read({"call_id":"g1"})']) {
      projection(context, [
        call('g1', 'bash', { command: 'make g1' }),
        { role: 'toolResult', toolCallId: 'g1', toolName: 'bash', content: [{ type: 'text', text: 'z'.repeat(2000) + '\n[truncated 58000 of 60000 chars; ' + example + ' returns the full text]' }] } as unknown as { content: Block[] },
      ]);
      const refused = await tool.execute('t1', { call_id: 'g1' });
      expect(refused.isError).toBe(true);
      expect(String(refused.content![0].text)).toContain('no longer available');
    }
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
    expect(kept).toContain('cindy_toolfold_read({"call_id":"giant-1"}) returns the full text');
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
    expect(isRecord(out[1])).toBe(true);
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
    expect(kept).toContain('cindy_toolfold_read({"call_id":"img-1"}) returns the full text');
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
    expect(isRecord(out[1])).toBe(true);
    // The anchor keeps exactly one of the 32 calls so the record can ride on its result;
    // the other 31 leave no pointer behind.
    expect(callIds(out)).toEqual(['par-31', 'tail-1']);
    expect((out[0].content as Block[]).filter((block) => block.type === 'toolCall')).toHaveLength(1);
    expect(records(out).join('\n')).toMatch(/^\[folded\] 1 round-trip, bash 32,/m);
    expect(records(out).join('\n')).not.toContain('parallel 0 ok');
  });

  it('keeps live fold marks when the registry cap is pruned', async () => {
    // MAX_FOLDED min is 100: the probe must produce more than 100 live marks before the
    // prune branch runs, otherwise the test cannot distinguish prune from wipe.
    const { context, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_MIN_PAIRS: '512', CINDY_PI_TOOL_FOLD_MIN_CHARS: '240000', CINDY_PI_TOOL_FOLD_KEEP: '1', CINDY_PI_TOOL_FOLD_MAX_FOLDED: '100' });
    // First pass: one large batch folds 120 pairs -> registry 120 > cap 100.
    const first = projection(context, pairs(120));
    expect(refsOf(first)).toHaveLength(1);
    const oldRef = refsOf(first)[0];
    // Second pass doubles the backlog: the 120 new pairs form a new batch, the prune
    // path runs with 121 live marks against cap 100, and every old id stays live.
    const grown = pairs(240);
    const second = projection(context, grown);
    // Both batches keep a record, and both reopen to their own members.
    const refs = refsOf(second);
    expect(refs).toHaveLength(2);
    expect(refs).toContain(oldRef);
    const reopened = await Promise.all(refs.map((ref) => tool.execute('t-' + ref, { batch: ref })));
    expect(String(reopened[0].content![0].text)).toContain('run step 0');
    expect(String(reopened[1].content![0].text)).toContain('run step 120');
    // The newer backlog folds too; each batch keeps its anchor call and the newest 1 pair
    // stays verbatim (KEEP=1).
    expect(callIds(second)).toEqual(['call-118', 'call-238', 'call-239']);
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
    const resumeAt = Number(/"offset":(\d+)/.exec(firstText)![1]);
    expect(resumeAt).toBeGreaterThan(0);
    const rest = await tool.execute('t2', { call_id: 'giant-8', offset: resumeAt });
    expect(rest.isError).toBeUndefined();
    expect(String(rest.content![0].text)).not.toContain('past the end');
  });

  it('resumes a giant read at the same offset once compaction has dropped its call block', async () => {
    // 取回的原文由「上下文里的调用头 + 登记表里的结果」现拼。压缩只带走前一半：同一份原文
    // 变短，上一页给的偏移就落进结果正文中间，跳过的正是还没读过的那一段。
    const { context, toolResult, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: '1000' });
    const big = 'body ' + 'z'.repeat(22000);
    toolResult({ toolName: 'bash', toolCallId: 'giant-9', content: [{ type: 'text', text: big }] });
    projection(context, [
      call('giant-9', 'bash', { command: 'make giant 9' }),
      { role: 'toolResult', toolCallId: 'giant-9', toolName: 'bash', content: [{ type: 'text', text: 'preview' }] } as unknown as { content: Block[] },
    ]);
    const pages: string[] = [];
    let params: { call_id: string; offset?: number } = { call_id: 'giant-9' };
    for (;;) {
      const page = await tool.execute('t', params);
      expect(page.isError).toBeUndefined();
      const text = String(page.content![0].text);
      pages.push(text.replace(/\n\n\[truncated: [^\n]*\]$/, ''));
      const next = /"offset":(\d+)/.exec(text);
      if (next === null) break;
      // 页与页之间发生压缩：调用块离开上下文，全文只剩登记表里那一份。
      projection(context, [{ role: 'user', content: [{ type: 'text', text: 'summary of the earlier work' }] }]);
      params = { call_id: 'giant-9', offset: Number(next[1]) };
    }
    const whole = pages.join('');
    const head = whole.slice(0, whole.indexOf('result:\n'));
    expect(head).toContain('"command":"make giant 9"');
    expect(whole).toBe(head + 'result:\n' + big);
  });

  it('keeps a failed giant result marked as an error when read back after compaction', async () => {
    // 失败是结果内容的一部分。超大结果入库时只有登记表里那一份全文；压缩带走上下文里的结果
    // 消息后，它是不是失败就只剩登记表知道。
    const { context, toolResult, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: '1000' });
    const big = 'boom ' + 'z'.repeat(22000);
    toolResult({ toolName: 'bash', toolCallId: 'giant-f', isError: true, content: [{ type: 'text', text: big }] });
    projection(context, [
      call('giant-f', 'bash', { command: 'make it fail' }),
      { role: 'toolResult', toolCallId: 'giant-f', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'preview' }] } as unknown as { content: Block[] },
    ]);
    // 压缩：调用块和预览都离开上下文。
    projection(context, [{ role: 'user', content: [{ type: 'text', text: 'summary of the earlier work' }] }]);
    const page = await tool.execute('t', { call_id: 'giant-f' });
    expect(page.isError).toBeUndefined();
    const text = String(page.content![0].text);
    expect(text).toContain('result (error):\nboom zzz');
    expect(text).not.toContain('result:\n');
  });

  it('resumes a batch read inside a cut member at the same offset once compaction has dropped its call block', async () => {
    // 同一件事的批读取形态：成员被页尾切开时，续读偏移落在它自己的全文里。成员是入库时
    // 被登记表收存的巨型结果；压缩后批里只有这类成员还取得到（其余缺项点名），那是另一条规则。
    const { context, toolResult, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: '1000', CINDY_PI_TOOL_FOLD_MIN_PAIRS: '4', CINDY_PI_TOOL_FOLD_MIN_CHARS: '2000', CINDY_PI_TOOL_FOLD_KEEP: '1' });
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];
    const body = ['a', 'b', 'c', 'd', 'e'];
    for (const index of [0, 1, 2, 3, 4]) {
      // 入库时经过截断钩子：超过入库下限的结果被登记表收存，上下文里只留预览。
      const clipped = (toolResult({ toolName: 'bash', toolCallId: `m-${index}`, content: [{ type: 'text', text: `member ${index} ` + body[index].repeat(21000) }] }) as { content: Block[] }).content;
      messages.push(call(`m-${index}`, 'bash', { command: `member ${index}` }));
      messages.push(result(`m-${index}`, 'bash', String(clipped[0].text)));
    }
    const out = projection(context, messages);
    const batch = refsOf(out)[0];
    const pages: string[] = [];
    let cuts = 0;
    let params: { batch: string; at?: number; offset?: number } = { batch };
    for (;;) {
      const page = await tool.execute('t', params);
      expect(page.isError).toBeUndefined();
      const text = String(page.content![0].text);
      pages.push(text.replace(/\n\n\[truncated: [^\n]*\]$/, ''));
      const next = /"at":(\d+)(?:,"offset":(\d+))?/.exec(text);
      if (next === null) break;
      cuts += 1;
      // 页与页之间发生压缩：调用块全部离开上下文，成员只剩登记表里那一份。
      projection(context, [{ role: 'user', content: [{ type: 'text', text: 'summary of the earlier work' }] }]);
      params = { batch, at: Number(next[1]), ...(next[2] === undefined ? {} : { offset: Number(next[2]) }) };
    }
    // 每个成员 21k 字符、每页 1000：每个成员都被切开二十来次。
    expect(cuts).toBeGreaterThan(50);
    const whole = pages.join('');
    // 第 0 个成员第一次被切开时调用块还在：之后每一页都切同一份带调用头的字节。
    expect(whole).toContain('"command":"member 0"}\nresult:\nmember 0 ' + body[0].repeat(21000));
    // 其余成员（锚点 m-3 在内）第一次被切开时调用块已被压缩带走（没人留有它）：取到的是登记表里的
    // 结果，同样逐页连续。m-4 在常驻窗口里，不成批。
    for (const index of [1, 2, 3]) {
      expect(whole).toContain('result:\nmember ' + index + ' ' + body[index].repeat(21000));
    }
  });

  it('reads the anchor back as its own original, never as the batch record', async () => {
    // 记录占了锚点的结果位，但那只是发给模型的投影：读取走投影前的原始消息，
    // 锚点取回的必须是它自己的调用与结果。
    const { context, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: '1000', CINDY_PI_TOOL_FOLD_MIN_PAIRS: '4', CINDY_PI_TOOL_FOLD_MIN_CHARS: '2000', CINDY_PI_TOOL_FOLD_KEEP: '1' });
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];
    for (const index of [0, 1, 2, 3, 4]) {
      messages.push(call(`s-${index}`, 'bash', { command: `step ${index}` }));
      messages.push(result(`s-${index}`, 'bash', `output ${index} ` + 'x'.repeat(600)));
    }
    const out = projection(context, messages);
    const record = out.find(isRecord)!;
    expect(record.role).toBe('toolResult');
    expect(recordText(record)).toContain('4 round-trips');
    const own = await tool.execute('t1', { call_id: 's-3' });
    expect(own.isError).toBeUndefined();
    const text = String(own.content![0].text);
    expect(text).toContain('"command":"step 3"}\nresult:\noutput 3 ');
    expect(text).not.toContain('round-trips');
  });

  it("keeps a failed round-trip's error state in its batch record and when read back", async () => {
    // 错误状态是往返内容的一部分：逐条记录一直带着（error · last: …），批记录换掉锚点结果时
    // 却丢掉 isError、也不数批内的失败；取回原文同样不带状态，模型读了整批也看不出哪次失败。
    const { context, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_MIN_PAIRS: '4', CINDY_PI_TOOL_FOLD_MIN_CHARS: '2000', CINDY_PI_TOOL_FOLD_KEEP: '1' });
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];
    for (const index of [0, 1, 2, 3, 4, 5]) {
      const failed = index % 2 === 0;
      messages.push(call(`f-${index}`, 'bash', { command: `step ${index}` }));
      messages.push(result(`f-${index}`, 'bash', failed ? `step ${index} failed ${'x'.repeat(300)}\nexit code 1` : `step ${index} ok ${'x'.repeat(300)}`, failed));
    }
    const out = projection(context, messages);
    const [record] = records(out);
    expect(record).toContain('3 failed (');
    expect(record.match(/bash: exit code 1/g)).toHaveLength(3);
    // 锚点是最后一条往返，它自己失败了：记录所在的结果位也必须如实标成错误。
    const recordMessage = out.find((message) => message.role === 'toolResult' && recordText(message) === record)!;
    expect(recordMessage.isError).toBe(true);
    const batch = await tool.execute('t', { batch: refsOf(out)[0] });
    const text = String(batch.content![0].text);
    expect(Array.from(text.matchAll(/result \(error\):\nstep (\d) failed/g), (match) => match[1])).toEqual(['0', '2', '4']);
    expect(Array.from(text.matchAll(/result:\nstep (\d) ok/g), (match) => match[1])).toEqual(['1', '3']);
  });

  it('describes the anchor call alone with isError and names the other failures in the record text', () => {
    // 结果位的 isError 属于它自己的调用 id：锚点成功就不能标成错误，否则模型会去重跑一条
    // 其实成功的命令。批内别的成员失败由记录正文点名。
    const { context } = loadExtension({ CINDY_PI_TOOL_FOLD_MIN_PAIRS: '4', CINDY_PI_TOOL_FOLD_MIN_CHARS: '2000', CINDY_PI_TOOL_FOLD_KEEP: '1' });
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];
    for (const index of [0, 1, 2, 3, 4, 5]) {
      const failed = index === 1;
      messages.push(call(`s-${index}`, 'bash', { command: `step ${index}` }));
      messages.push(result(`s-${index}`, 'bash', failed ? `boom ${'x'.repeat(300)}\nexit code 2` : `step ${index} ok ${'x'.repeat(300)}`, failed));
    }
    const out = projection(context, messages);
    const [record] = records(out);
    expect(record).toContain('1 failed (bash: exit code 2)');
    const recordMessage = out.find((message) => message.role === 'toolResult' && recordText(message) === record)!;
    expect(recordMessage.isError).toBe(false);
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

  it('holds its invariants on arbitrary message shapes', async () => {
    const { context, tool } = loadExtension({
      CINDY_PI_TOOL_FOLD_MIN_PAIRS: '4',
      CINDY_PI_TOOL_FOLD_MIN_CHARS: '2000',
      CINDY_PI_TOOL_FOLD_KEEP: '1',
      CINDY_PI_TOOL_FOLD_ARG_CHARS: '50',
    });
    // 固定种子：失败可以原样重放。只生成 shape，不对具体数字作断言。
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const pick = <T,>(items: T[]): T => items[rnd(items.length)];
    for (let round = 0; round < 40; round += 1) {
      const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'task ' + round }] }];
      const turns = 6 + rnd(10);
      for (let turn = 0; turn < turns; turn += 1) {
        const id = rnd(9) === 0 ? 'r' + round + '_' + 'x'.repeat(300) : 'r' + round + '-' + turn;
        const content: Block[] = [];
        if (rnd(2) === 0) content.push({ type: 'text', text: 'plan ' + turn });
        content.push({
          type: 'toolCall',
          id,
          name: pick(['bash', 'read']),
          arguments: rnd(2) === 0 ? { command: 'c'.repeat(10 + rnd(400)) } : { path: 'a' },
        } as Block);
        messages.push({ role: 'assistant', content } as Message);
        const blocks: Block[] = [{ type: 'text', text: 'out ' + 'z'.repeat(pick([0, 20, 300, 25000])) }];
        if (rnd(6) === 0) blocks.push({ type: 'image', data: 'AAAA', mimeType: 'image/png' } as Block);
        messages.push({ role: 'toolResult', toolCallId: id, toolName: 'bash', isError: rnd(7) === 0, content: blocks } as Message);
      }
      const out = projection(context, messages);
      // 1) 不放大 2) 不发明调用 3) 粘性 4) 记录里的 ref 都能取回
      expect(textChars(out)).toBeLessThanOrEqual(textChars(messages));
      const before = new Set(callIds(messages));
      for (const id of callIds(out)) expect(before.has(id)).toBe(true);
      expect(JSON.stringify(projection(context, out))).toBe(JSON.stringify(out));
      for (const ref of refsOf(out)) {
        const read = await tool.execute('t-' + ref, { batch: ref });
        expect(read.isError).toBeUndefined();
      }
    }
  });

  it('reads a call whose own result ends with an unterminated truncation marker', async () => {
    const { context, tool } = loadExtension();
    const messages = pairs(40);
    // 程序输出恰好以标记文字收尾、后面没有右括号：不是入库标记，也不能让定位原地打转。
    const poisoned = messages.find((message) => message.role === 'toolResult' && message.toolCallId === 'call-0')!;
    (poisoned.content as Block[])[0].text = 'scan done [truncated ';
    const view = projection(context, messages)!;
    expect(callIds(view)).not.toContain('call-0');
    const batchId = refsOf(view)[0];
    const whole = await tool.execute('t1', { batch: batchId });
    expect(whole.isError).toBeUndefined();
    expect(String(whole.content![0].text)).toContain('scan done [truncated ');
    const single = await tool.execute('t2', { call_id: 'call-0' });
    expect(single.isError).toBeUndefined();
    expect(String(single.content![0].text)).toContain('scan done [truncated ');
  });

  it('locates batch members through one index pass instead of rescanning the transcript per member', async () => {
    const { context, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: '1000000' });
    const messages = pairs(600, 100);
    let walks = 0;
    for (const message of messages) {
      if (message.role !== 'toolResult') continue;
      const id = message.toolCallId;
      Object.defineProperty(message, 'toolCallId', { enumerable: true, get() { walks += 1; return id; } });
    }
    const batchId = refsOf(projection(context, messages)!)[0];
    walks = 0;
    const read = await tool.execute('t', { batch: batchId });
    expect(read.isError).toBeUndefined();
    // 惰性索引：整份快照走一遍（每条结果消息读一次 id），之后每个成员只查表。
    expect(walks).toBe(messages.length / 2);
    expect(String(read.content![0].text)).toContain('run step 595');
  });

  it('pages a batch by member cursor, so a member dropped mid-read cannot shift the next page', async () => {
    const messages = pairs(40, 1500);
    const oracle = loadExtension();
    projection(oracle.context, messages);
    const full: string[] = [];
    for (let index = 0; index < 36; index += 1) {
      full.push(String((await oracle.tool.execute('o' + index, { call_id: 'call-' + index })).content![0].text));
    }
    const { context, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: '4000' });
    const batchId = refsOf(projection(context, messages)!)[0];
    const page = async (params: Record<string, unknown>) => String((await tool.execute('p' + reads++, params)).content![0].text);
    const next = (body: string) => /"batch":"[^"]+","at":(\d+),"offset":(\d+)\}\) to continue\.\]$/.exec(body);
    let reads = 0;
    const first = await page({ batch: batchId });
    expect(first.length).toBeLessThanOrEqual(4300);
    const resume = next(first)!;
    // 第 1 页在 call-1 内部截断；之后模拟压缩，删掉一条还没读到的成员（call-5）。
    const pruned = messages.filter((message) => !(message.role === 'toolResult' && message.toolCallId === 'call-5')
      && !(message.role === 'assistant' && (message.content as Block[]).some((block) => block.id === 'call-5')));
    projection(context, pruned);
    let params: Record<string, unknown> = { batch: batchId, at: Number(resume[1]), offset: Number(resume[2]) };
    let joined = first.replace(/\n\n\[truncated: [^\n]*\]$/, '');
    for (let guard = 0; guard < 40; guard += 1) {
      let body = await page(params);
      expect(body.length).toBeLessThanOrEqual(4300);
      const again = next(body);
      const cut = /\n\n\[truncated: [^\n]*\]$/.exec(body);
      if (cut) body = body.slice(0, cut.index);
      // 续读点落在成员内部时两页之间没有分隔；落在成员开头时补回成员之间的分隔。
      joined += (Number(params.offset) > 0 ? '' : '\n\n') + body;
      if (!again) break;
      params = { batch: batchId, at: Number(again[1]), offset: Number(again[2]) };
    }
    // 分页拼回去与逐条读取逐字相同，只少被删的那一条；缺项在它的成员位置上被点名。
    const gone = '[missing round-trip call-5 (not in this session); re-run that command]';
    expect(joined).toBe([...full.slice(0, 5), gone, ...full.slice(6)].join('\n\n'));
    // 游标成员自己被删：成员内偏移随之作废——缺项说明从头给出，下一条成员不被截头。
    const afterLoss = await page({ batch: batchId, at: 5, offset: 10 });
    expect(afterLoss.startsWith(gone + '\n\n' + full[6].slice(0, 300))).toBe(true);
    // 游标偏移越过成员现有的全文（续读期间它被截短）：偏移作废、页首说明、从头给出，不静默略过。
    const stale = await page({ batch: batchId, at: 7, offset: 1000000 });
    expect(stale.startsWith('[stale cursor: offset 1000000 is past the end of call-7 (' + full[7].length + ' chars now); shown from the start]\n\n' + full[7])).toBe(true);
    expect((await tool.execute('x', { batch: batchId, at: 99 })).isError).toBe(true);
  });

  it('keeps missing-member lines inside the read budget: a missing member is page content, not a footer', async () => {
    // 回归：缺项清单曾挂在每页页尾、不受读取预算约束——成批缺项配长调用 id 时，一页就越过
    // 读取上限，而且每页重复。取回结果不经入库截断，越界的说明会原样进入下一次请求。
    const { context, tool } = loadExtension();
    const ids = Array.from({ length: 100 }, (_, index) => 'call_' + index + '_' + 'z'.repeat(2000));
    const messages: Message[] = [];
    ids.forEach((id, index) => {
      messages.push(call(id, 'bash', { command: 'run step ' + index + ' ' + 'c'.repeat(420) }));
      messages.push(result(id, 'bash', 'step ' + index + ' ok ' + 'x'.repeat(500)));
    });
    const batchId = refsOf(projection(context, messages)!)[0];
    expect(batchId).toBeTruthy();
    // 压缩把整批成员都删了：100 条缺项、每条 id 2,000 字符，点名本身约 20 万字符。
    projection(context, [{ role: 'user', content: [{ type: 'text', text: 'continue' }] }]);
    const lines = ids.slice(0, 96).map((id) => '[missing round-trip ' + id + ' (not in this session); re-run that command]');
    // 续读游标是位置、不带调用 id：每页只有上限以内的成员、至多一条整行放行的说明、一条续读提示。
    const { pages, joined } = await readWholeBatch(tool, batchId, 120000 + lines[0].length + 300);
    expect(pages.length).toBe(2);
    expect(joined).toBe(lines.join('\n\n'));
    // 最新 4 条仍在上下文里，不进批；第一页点到第 58 条就停，不替后面 38 条点名。
    expect(pages[0]).toContain(lines[57]);
    expect(pages[0]).not.toContain(lines[58]);
    expect(joined).not.toContain('call_96_');
  });

  it('emits a missing-member line whole even when it is longer than the room left on the page', async () => {
    const { context, tool } = loadExtension({
      CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: '1000', CINDY_PI_TOOL_FOLD_KEEP: '1',
      CINDY_PI_TOOL_FOLD_MIN_PAIRS: '1', CINDY_PI_TOOL_FOLD_MIN_CHARS: '1',
    });
    const ids = ['a' + 'q'.repeat(500), 'b' + 'q'.repeat(1400), 'c' + 'q'.repeat(3000), 'd' + 'q'.repeat(10)];
    const messages: Message[] = [];
    ids.forEach((id, index) => {
      messages.push(call(id, 'bash', { command: 'run step ' + index + ' ' + 'c'.repeat(420) }));
      messages.push(result(id, 'bash', 'step ' + index + ' ok ' + 'x'.repeat(500)));
    });
    const batchId = refsOf(projection(context, messages)!)[0];
    expect(batchId).toBeTruthy();
    projection(context, [{ role: 'user', content: [{ type: 'text', text: 'continue' }] }]);
    // 说明行 564 / 1,464 / 3,064 字符，预算 1,000：第一条放下后只剩 434，第二条整行放行
    // （不按偏移切开——否则下一页的「游标成员已不在 → 偏移作废」会让它永远从头重发）；
    // 第三条另起一页，整行放行。
    const lines = ids.slice(0, 3).map((id) => '[missing round-trip ' + id + ' (not in this session); re-run that command]');
    const { pages, joined } = await readWholeBatch(tool, batchId, 1000 + Math.max(...lines.map((line) => line.length)) + 300);
    expect(pages).toEqual([lines[0] + '\n\n' + lines[1], lines[2]]);
    expect(joined).toBe(lines.join('\n\n'));
  });

  it('charges a text-only restore by the text it adds, not by the image it already shows', () => {
    const flag = Symbol.for('cindy.pi.textOnlyTurn');
    const { context, toolResult } = loadExtension();
    const blocks: Block[] = [{ type: 'text', text: 'b'.repeat(25000) }, { type: 'image', data: 'A'.repeat(100000), mimeType: 'image/png' }];
    const truncated = toolResult({ toolName: 'read', toolCallId: 'shot', content: blocks }) as { content: Block[] } | undefined;
    expect(truncated).toBeDefined();
    const messages: Message[] = [call('shot', 'read', { path: 'shot.png' }), { role: 'toolResult', toolCallId: 'shot', toolName: 'read', content: truncated!.content }];
    (globalThis as Record<symbol, unknown>)[flag] = true;
    try {
      // 增量是 23k 文本，图片原样留在原位：远在 64k 预算之内。
      expect(projection(context, messages)!.find((message) => message.role === 'toolResult')!.content).toEqual(blocks);
    } finally {
      delete (globalThis as Record<symbol, unknown>)[flag];
    }
  });

  it('keeps the retention ledger inside its budget and restores what fits on text-only turns', async () => {
    // 取值都贴着扩展自身的下限（入库阈值 4000、保留 500、8 条、总预算 100000）；
    // 传得比下限更小会被悄悄抬高，整段断言就变成对空集合成立。
    const flag = Symbol.for('cindy.pi.textOnlyTurn');
    const slots = 8;
    const budget = 100000;
    const pin = 6000;
    const { context, toolResult, tool } = loadExtension({
      CINDY_PI_TOOL_FOLD_INGEST_LIMIT: '4000',
      CINDY_PI_TOOL_FOLD_INGEST_KEEP: '500',
      CINDY_PI_TOOL_FOLD_GIANTS: String(slots),
      CINDY_PI_TOOL_FOLD_GIANT_BUDGET: String(budget),
      CINDY_PI_TOOL_FOLD_PIN_BUDGET: String(pin),
    });
    let seed = 20261123;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const cost = (blocks: Block[]) => blocks.reduce((sum, block) => sum + (block.type === 'text' ? String(block.text).length : JSON.stringify(block).length), 0);
    type Item = { id: string; blocks: Block[]; preview: Block[] };
    const added = (item: Item) => cost(item.blocks) - cost(item.preview);
    const chars = (list: Message[]) => list.reduce((sum, message) => sum + (message.content ?? []).reduce((inner, block) => inner
      + (block.type === 'toolCall' ? JSON.stringify(block.arguments ?? {}).length : String(block.text ?? '').length), 0), 0);
    // 不许空转：每条性质都必须真的被走到。
    const hit = { truncated: 0, evicted: 0, fits: 0, fitsWithImage: 0, keptWithImage: 0 };
    for (let round = 0; round < 80; round += 1) {
      const admitted: Item[] = [];
      const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];
      const count = 3 + rnd(9);
      for (let index = 0; index < count; index += 1) {
        const id = 'g-' + round + '-' + index;
        messages.push(call(id, 'read', { path: 'a' }));
        // 2500 不截断（噪声）；4500 截断后放得下钉住预算；9000 放不下。图片 30000 / 90000 字节。
        const blocks: Block[] = [{ type: 'text', text: 't'.repeat([2500, 4500, 9000][rnd(3)]) }];
        if (rnd(2) === 0) blocks.push({ type: 'image', data: 'A'.repeat([30000, 90000][rnd(2)]), mimeType: 'image/png' });
        const clipped = toolResult({ toolName: 'read', toolCallId: id, content: blocks }) as { content: Block[] } | undefined;
        const content = clipped ? clipped.content : blocks;
        messages.push({ role: 'toolResult', toolCallId: id, toolName: 'read', content });
        if (clipped) admitted.push({ id, blocks, preview: content });
      }
      hit.truncated += admitted.length;
      // 1) 账本不超预算（图片按序列化字节计入），且淘汰从最老的一条开始：留下的一定是后缀。
      const kept: Item[] = [];
      for (const item of admitted) {
        const read = await tool.execute('ledger-' + item.id, { call_id: item.id });
        if (!read.isError) kept.push(item);
      }
      expect(kept.map((item) => item.id)).toEqual(admitted.slice(admitted.length - kept.length).map((item) => item.id));
      expect(kept.length).toBeLessThanOrEqual(slots);
      expect(kept.reduce((sum, item) => sum + cost(item.blocks), 0)).toBeLessThanOrEqual(budget);
      hit.evicted += admitted.length - kept.length;
      if (kept.some((item) => item.blocks.length > 1)) hit.keptWithImage += 1;
      // 2) 文本回合：放得下的最新一条原样放回（图片留在原位），放回总量不超钉住预算，其余逐字不动。
      const newest = kept[kept.length - 1];
      (globalThis as Record<symbol, unknown>)[flag] = true;
      let out = messages;
      try { out = projection(context, messages) ?? messages; } finally { delete (globalThis as Record<symbol, unknown>)[flag]; }
      expect(out).toHaveLength(messages.length);
      for (let index = 0; index < messages.length; index += 1) {
        expect(out[index] === messages[index] || kept.some((item) => out[index].content === item.blocks)).toBe(true);
      }
      if (newest && added(newest) <= pin) {
        hit.fits += 1;
        if (newest.blocks.length > 1) hit.fitsWithImage += 1;
        expect(out.find((message) => message.role === 'toolResult' && message.toolCallId === newest.id)!.content).toBe(newest.blocks);
      }
      expect(chars(out) - chars(messages)).toBeLessThanOrEqual(pin);
    }
    expect(hit.truncated).toBeGreaterThan(150);
    expect(hit.evicted).toBeGreaterThan(5);
    expect(hit.keptWithImage).toBeGreaterThan(3);
    expect(hit.fits).toBeGreaterThan(5);
    expect(hit.fitsWithImage).toBeGreaterThan(3);
  });

  it('writes only call examples that are valid arguments of the read tool', async () => {
    // 「怎么调用」是契约的一部分：宿主写出的每个示例都由同一处从参数对象渲染成 JSON，
    // 既是 schema 的实例，照抄执行也能取回。这里把五条输出路径上的示例全部收集起来。
    const { context, tool, toolResult } = loadExtension({ CINDY_PI_TOOL_FOLD_KEEP: '1', CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: '1000' });
    const messages: Message[] = [];
    for (let index = 0; index < 40; index += 1) {
      messages.push({ role: 'assistant', content: [
        { type: 'toolCall', id: `par-${index}a`, name: 'bash', arguments: { command: `first ${index} ${'c'.repeat(420)}` } },
        { type: 'toolCall', id: `par-${index}b`, name: 'bash', arguments: { command: `second ${index} ${'c'.repeat(420)}` } },
      ] as Block[] });
      // Trip 0 is the one that ends up pinned. Only a whole recovery pins, so its first call
      // must return a short result (arguments plus result have to fit one page); its sibling
      // gets a short first line over a long body, because the per-call shape keeps the first
      // line as its head and a one-line result has nothing left to fold.
      messages.push(result(`par-${index}a`, 'bash', index === 0 ? 'a ok\n' + 'x'.repeat(100) : `a ok ${'x'.repeat(2000)}`));
      messages.push(result(`par-${index}b`, 'bash', index === 0 ? 'b ok\n' + 'x'.repeat(2000) : `b ok ${'x'.repeat(2000)}`));
    }
    const batchId = refsOf(projection(context, messages)!)[0];
    // Pinning one call of a trip leaves the sibling on the per-call shape.
    await tool.execute('t-pin', { call_id: 'par-0a' });
    const projected = projection(context, messages)!;
    const textOf = (list: Block[]) => list.map((block) => String((block as { text?: unknown }).text ?? '')).join('\n');
    const truncated = toolResult({ toolName: 'bash', toolCallId: 'giant', content: [{ type: 'text', text: 'G'.repeat(30000) }] }) as { content: Block[] };
    const texts = [
      ...projected.map((message) => textOf(message.content ?? [])),
      textOf(truncated.content),
      String((await tool.execute('t-call', { call_id: 'par-1a' }))?.content?.[0]?.text),
      String((await tool.execute('t-batch', { batch: batchId }))?.content?.[0]?.text),
    ].join('\n');
    const examples = new Set(Array.from(texts.matchAll(/cindy_toolfold_read\((\{[^{}]*\})\)/g), (match) => match[1]));
    // 不许空转：五条输出路径（批记录、逐条记录、入库标记、两处续读页尾）各留下一枚示例。
    expect(examples.size).toBeGreaterThanOrEqual(5);
    // 没有任何一处手写别的形式：裸字符串不是 schema 的实例，关键字叙述不是确切的参数。
    expect(texts).not.toMatch(/cindy_toolfold_read\("/);
    expect(texts).not.toMatch(/cindy_toolfold_read again with/);
    const allowed = Object.keys((tool as unknown as { parameters?: { properties?: Record<string, unknown> } }).parameters?.properties ?? {});
    for (const example of examples) {
      const args = JSON.parse(example) as Record<string, unknown>;
      expect(Object.keys(args).every((key) => allowed.includes(key))).toBe(true);
      // 照抄执行：模型原样复制示例参数时，读到的必须是一页真正的原文。
      const followed = await tool.execute('t-example', args);
      expect(followed?.isError).toBeUndefined();
      expect(String(followed?.content?.[0]?.text ?? '').length).toBeGreaterThan(0);
    }
  });

  it('keeps every record in a tool result and never writes assistant text', () => {
    // 宿主从不写助手位：助手消息里的每一段文字都必须能在输入里原样找到，记录只出现在
    // 工具结果里。实测仿写率随记录位置上升（工具结果位 6/29,981，助手位 8/3,483），
    // 所以「记录在哪」本身是不变量，不靠提示词。
    const { context } = loadExtension({ CINDY_PI_TOOL_FOLD_KEEP: '4' });
    const messages: Message[] = [];
    for (let index = 0; index < 60; index += 1) {
      const text = index % 7 === 3 ? `plan ${index}` : undefined;
      const block = { type: 'toolCall', id: `call-${index}`, name: 'bash', arguments: { command: `run step ${index}` } };
      messages.push({ role: 'assistant', content: text === undefined ? [block] : [{ type: 'text', text }, block] } as Message);
      messages.push(result(`call-${index}`, 'bash', `step ${index} ok ${'x'.repeat(2000)}`));
      if (index === 20 || index === 44) messages.push({ role: 'user', content: [{ type: 'text', text: `turn ${index}` }] });
    }
    const out = projection(context, messages)!;
    const texts = (list: Message[]) =>
      list
        .filter((message) => message.role === 'assistant')
        .flatMap((message) => (message.content as Block[]).filter((block) => block.type === 'text').map((block) => String(block.text ?? '')));
    const kept = texts(out);
    expect(kept.length).toBeGreaterThan(0);
    for (const text of kept) expect(texts(messages)).toContain(text);
    const recordMessages = out.filter((message) => isRecord(message));
    expect(recordMessages.length).toBeGreaterThan(0);
    for (const message of recordMessages) expect(message.role).toBe('toolResult');
    // A record always sits under the call it belongs to: call and result stay paired.
    expect(out.flatMap((message) => (message.role === 'toolResult' ? [message.toolCallId] : []))).toEqual(
      out.flatMap((message) => (message.role === 'assistant' ? callIds([message]) : [])),
    );
  });
});
