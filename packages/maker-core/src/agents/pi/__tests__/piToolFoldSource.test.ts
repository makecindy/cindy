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

// 页尾只有一个消费者：从「Call cindy_toolfold_read({...}) to continue.]」取出续读参数；
// 没有页尾、或页尾不是合法 JSON，都算没有下一页。调用 id 由调用方自带。
function continuation(body: string): Record<string, unknown> | null {
  const match = /Call cindy_toolfold_read\((\{[^\n]*\})\) to continue\.\]$/.exec(body);
  if (match === null) return null;
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(JSON.parse(match[1]) as Record<string, unknown>)) {
    if (key !== 'call_id') params[key] = value;
  }
  return params;
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
// 说明行里的调用 id 经 oneLine 限长：空白折叠，超过 LINE 截断加省略号。
const LINE_CHARS = Number(/var LINE = (\d+);/.exec(CINDY_TOOL_FOLD_EXTENSION_SOURCE)![1]);
const idShown = (id: string) => {
  const text = id.replace(/\s+/g, ' ').trim();
  return text.length > LINE_CHARS ? text.slice(0, LINE_CHARS - 1) + '…' : text;
};

async function readWholeBatch(tool: Tool, batchId: string, limit: number) {
  const pages: string[] = [];
  let joined = '';
  let params: Record<string, unknown> = { batch: batchId };
  let again: Record<string, unknown> | null = null;
  for (let guard = 0; guard < 60; guard += 1) {
    const raw = String((await tool.execute('w' + guard, params)).content![0].text).replace(/^Cannot recover batch \S+: /, '');
    again = continuation(raw);
    const body = raw.replace(/\n\n\[truncated: [^\n]*\]$/, '');
    expect(raw.length).toBeLessThanOrEqual(limit);
    pages.push(body);
    // 成员内部续读的两页之间没有分隔；成员开头续读的补回成员之间的分隔。
    // 页尾带 part 是同一成员内部的续读，不补分隔；不带 part 是下一位成员，补回成员之间的分隔。
    const fresh = params.part === undefined && !Number(params.offset);
    joined += (pages.length > 1 && !fresh ? '' : (pages.length > 1 ? '\n\n' : '')) + body;
    if (again === null) break;
    params = { batch: batchId, ...again };
  }
  expect(again, 'pager did not finish within 60 pages; last cursor ' + JSON.stringify(params)).toBeNull();
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
    expect(text).toContain('Call cindy_toolfold_read({"call_id":"huge-write","part":"result","offset":');
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

    const readAt = async (more?: Record<string, unknown>) => {
      const read = await tool.execute('t-continue', more === undefined ? { call_id: 'big-one' } : { call_id: 'big-one', ...more });
      return String(read.content![0].text);
    };
    const first = await readAt();
    const next = continuation(first)!;
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
    expect(joined.length).toBeGreaterThan(next.offset as number);
  });

  // 把「允许新增多少」当成「总共保留多少」，会用更短的前缀覆盖已有预览，模型反而少看正文。
  it('never restores a shorter prefix than the preview it replaces', () => {
    const flag = Symbol.for('cindy.pi.textOnlyTurn');
    const { context, toolResult } = loadExtension({
      CINDY_PI_TOOL_FOLD_INGEST_KEEP: '32000',
      CINDY_PI_TOOL_FOLD_INGEST_LIMIT: '60000',
      CINDY_PI_TOOL_FOLD_PIN_BUDGET: '2000',
    });
    const body = 'line of payload\n'.repeat(6250);
    const truncated = toolResult({ toolName: 'read', toolCallId: 'wide', content: [{ type: 'text', text: body }] }) as { content: Block[] } | undefined;
    expect(truncated).toBeDefined();
    const previewChars = truncated!.content.map((block) => String(block.text ?? '')).join('').length;
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'what changed' }] },
      call('wide', 'read', { path: 'wide.log' }),
      { role: 'toolResult', toolCallId: 'wide', toolName: 'read', content: truncated!.content },
    ];
    (globalThis as Record<symbol, unknown>)[flag] = true;
    let out: Message[];
    try { out = projection(context, messages); } finally { delete (globalThis as Record<symbol, unknown>)[flag]; }
    const shown = (out[2].content ?? []).map((block) => String(block.text ?? '')).join('').length;
    expect(shown).toBeGreaterThanOrEqual(previewChars);
  });

  // 标记自己也要占地方：保留量贴近上限时，留给标记的空间只剩几百字符，超长调用 id 的
  // 「完整」标记放不进去，必须退到按身份的短形态。否则预览本身又被截断一次，模型看到
  // 半条标记，第二次进钩子还会再折一遍。
  it('keeps the truncation marker inside the room its own clip leaves', () => {
    const { toolResult } = loadExtension({
      CINDY_PI_TOOL_FOLD_INGEST_KEEP: '20000',
      CINDY_PI_TOOL_FOLD_INGEST_LIMIT: '20000',
    });
    const id = 'k'.repeat(3000);
    const body = 'b'.repeat(40000);
    const truncated = toolResult({ toolName: 'bash', toolCallId: id, content: [{ type: 'text', text: body }] }) as { content: Block[] } | undefined;
    expect(truncated).toBeDefined();
    const preview = truncated!.content.map((block) => String(block.text ?? '')).join('');
    expect(preview).toContain('[truncated');
    expect(preview.length).toBeLessThan(20000);
    // 预览已经是终态：再喂一次钩子不能再折（说明标记完整进了预算）。
    const twice = toolResult({ toolName: 'bash', toolCallId: id, content: truncated!.content });
    expect(twice).toBeUndefined();
  });

  // 恢复只能追加：被预算截住时，预览里已经交付的图片块必须原样留着（禁用工具的回合取不回来）。
  it('keeps the media blocks of a result whose text alone exceeds the restore budget', () => {
    const flag = Symbol.for('cindy.pi.textOnlyTurn');
    const { context, toolResult } = loadExtension({
      CINDY_PI_TOOL_FOLD_INGEST_KEEP: '8000',
      CINDY_PI_TOOL_FOLD_INGEST_LIMIT: '30000',
      CINDY_PI_TOOL_FOLD_PIN_BUDGET: '6000',
    });
    const image = { type: 'image', data: 'i'.repeat(20000), mimeType: 'image/png' } as Block;
    const body = 'payload line\n'.repeat(3000);
    const truncated = toolResult({ toolName: 'read', toolCallId: 'mixed', content: [{ type: 'text', text: body }, image] }) as { content: Block[] } | undefined;
    expect(truncated).toBeDefined();
    const previewChars = truncated!.content.map((block) => String(block.text ?? '')).join('').length;
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'what is in this screenshot' }] },
      call('mixed', 'read', { path: 'shot.png' }),
      { role: 'toolResult', toolCallId: 'mixed', toolName: 'read', content: truncated!.content },
    ];
    (globalThis as Record<symbol, unknown>)[flag] = true;
    let out: Message[];
    try { out = projection(context, messages); } finally { delete (globalThis as Record<symbol, unknown>)[flag]; }
    const blocks = out[2].content ?? [];
    const media = blocks.filter((block) => block.type === 'image');
    expect(media).toHaveLength(1);
    expect(String(media[0].data)).toHaveLength(20000);
    const shown = blocks.map((block) => String(block.text ?? '')).join('').length;
    expect(shown).toBeGreaterThanOrEqual(previewChars);
  });

  // 真实结果恰好以一句「上游截断」收尾、调用 id 又很短时，不能被当成截断预览而丢掉原文。
  it('keeps the original of a result that merely ends with an upstream truncation note', async () => {
    const { context, toolResult, tool } = loadExtension({
      CINDY_PI_TOOL_FOLD_INGEST_LIMIT: '20000',
      CINDY_PI_TOOL_FOLD_INGEST_KEEP: '4000',
    });
    const body = 'row ' + 'r'.repeat(24000) + '\n[truncated by upstream]';
    const truncated = toolResult({ toolName: 'read', toolCallId: 'a', content: [{ type: 'text', text: body }] }) as { content: Block[] } | undefined;
    expect(truncated).toBeDefined();
    projection(context, [
      { role: 'user', content: [{ type: 'text', text: 'read the table' }] },
      call('a', 'read', { path: 'table.csv' }),
      { role: 'toolResult', toolCallId: 'a', toolName: 'read', content: truncated!.content },
    ]);
    const recovered = await tool.execute('t-upstream', { call_id: 'a' });
    expect(recovered.isError).toBeUndefined();
    expect(String(recovered.content![0].text)).toContain('row rrrrrrrrrr');
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
    // 原文的去向只有入库账知道，所以这里走生产路径：超过登记预算的载荷被拒收（原文不留件），
    // 上下文里只剩预览。
    const { context, tool, toolResult } = loadExtension();
    const preview = (toolResult({ toolName: 'bash', toolCallId: 'p1', content: [{ type: 'text', text: 'A ' + 'z'.repeat(2100000) }] }) as { content: Block[] })
      .content.map((block) => String((block as { text?: string }).text ?? '')).join('\n');
    expect(preview).toContain('not retained');
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
    const named = '[missing round-trip p1 (full text not retained); it already ran]';
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

  it('does not merge two batches whose member ids join to one string', async () => {
    const { context, tool } = loadExtension();
    // 企业身份的键由成员 id 拼成。id 里可以有任何字符：['p\0q','s'] 与 ['p','q\0s']
    // 拼接后完全一样，如果键用 join 拼，第二批会拿到第一批的 ref（成员对不上）。
    const trip = (ids: string[], textLength: number): Message[] => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: ids.map((id) => ({ type: 'toolCall', id, name: 'bash', arguments: { command: `run ${id} ${'c'.repeat(420)}` } })),
        },
      ];
      for (const id of ids) messages.push(result(id, 'bash', `payload ${id} ${'x'.repeat(textLength)}`));
      return messages;
    };
    // 最新 4 个调用永远保持原样，所以每个批次后面跟一组便宜的往返把它推出窗口。
    const keepAway = (prefix: string): Message[] => {
      const messages: Message[] = [];
      for (const suffix of ['0', '1', '2', '3']) {
        messages.push(call(`${prefix}${suffix}`, 'bash', { command: `echo ${prefix}${suffix}` }), result(`${prefix}${suffix}`, 'bash', 'ok'));
      }
      return messages;
    };
    const first = [...trip(['p\u0000q', 's'], 19000), ...keepAway('t')];
    projection(context, first);
    const second = [...first, ...trip(['p', 'q\u0000s'], 19000), ...keepAway('u')];
    const view = projection(context, second)!;
    const refs = refsOf(view);
    expect(refs).toHaveLength(2);
    expect(new Set(refs).size).toBe(2);
    const read = await tool.execute('t-ids', { batch: refs[1] });
    const text = String(read.content![0].text);
    expect(text).toContain('payload p ');
    expect(text).toContain('payload q\u0000s ');
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
    const preview = 'body zzz…\n[truncated 20000 of 20009 chars; cindy_toolfold_read("giant-0") returns the full text]';
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
    // 扩展不知道被折的命令是否幂等：重复一次 rm 或 push 就是第二次副作用。
    expect(String(refused.content![0].text)).toContain('it already ran');
    expect(String(refused.content![0].text)).not.toContain('re-run');
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
    const previewText = 'payload 0 ' + 'g'.repeat(1800) + '\n[truncated 23000 of 24810 chars; cindy_toolfold_read("giant-0") returns the full text]';
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
  it('refuses recovery of an evicted giant whose result had several text blocks', async () => {
    // 多块结果的预览把标记放在单独一块里，块之间的换行是拼接出来的：用拼接后的整段文本去数
    // 「标记前有多少字符」，每个块间换行都多算一次，预览就被当成原文交回去了。
    const { context, toolResult, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_GIANTS: '8' });
    const mixed = toolResult({
      toolName: 'bash',
      toolCallId: 'multi-0',
      content: [{ type: 'text', text: 'head '.repeat(20) }, { type: 'text', text: 'm'.repeat(30000) }, { type: 'text', text: 'tail' }],
    }) as { content: Block[] } | undefined;
    expect(mixed!.content).toHaveLength(3);
    for (let i = 1; i < 9; i += 1) {
      toolResult({ toolName: 'bash', toolCallId: `multi-${i}`, content: [{ type: 'text', text: `payload ${i} ${'g'.repeat(25000)}` }] });
    }
    projection(context, [
      call('multi-0', 'bash', { command: 'cat parts' }),
      { role: 'toolResult', toolCallId: 'multi-0', toolName: 'bash', content: mixed!.content },
    ]);
    const refused = await tool.execute('t1', { call_id: 'multi-0' });
    expect(refused.isError).toBe(true);
    expect(String(refused.content![0].text)).toContain('no longer available');
  });
  it('never re-clips the preview it wrote, and keeps a result that merely looks like one', async () => {
    // 闭包：入库标记的长度有上限，成形的预览永远低于入库阈值，所以扩展自己写的预览再经过
    // 一次钩子（重放、恢复、改完重发）时不会被再截一次——第二次截断会把原文顶掉。
    const { toolResult } = loadExtension();
    const joined = (blocks?: Block[]) => (blocks ?? []).map((block) => String((block as { text?: string }).text ?? '')).join('\n');
    const first = toolResult({ toolName: 'bash', toolCallId: 'again', content: [{ type: 'text', text: 'p'.repeat(30000) }] }) as { content: Block[] };
    expect(joined(first.content).length).toBeLessThan(20000);
    // 同一份内容再走一次钩子：已经不高于入库阈值，不该被再截一次（钩子返回 undefined = 不改动）。
    const again = toolResult({ toolName: 'bash', toolCallId: 'again', content: first.content.map((block) => ({ ...block })) });
    expect(again).toBeUndefined();
    // 反向：结果自己的文字恰好凑得出「标记前长度 = 总数 − 被截掉」这套算术，也不能因此
    // 丢掉原文——入库只看大小，收进去的原文必须能整份取回。
    const { context, tool, toolResult: ingest } = loadExtension();
    const forged = 'f'.repeat(20000) + '\n[truncated 1 of 20001 chars; cindy_toolfold_read({"call_id":"forge"}) returns the full text]';
    ingest({ toolName: 'bash', toolCallId: 'forge', content: [{ type: 'text', text: forged }] });
    projection(context, [
      call('forge', 'bash', { command: 'make forge' }),
      { role: 'toolResult', toolCallId: 'forge', toolName: 'bash', content: [{ type: 'text', text: 'previewed' }] } as unknown as Message,
    ]);
    const out = await tool.execute('t-forge', { call_id: 'forge' });
    expect(out.isError).toBeUndefined();
    expect(joined(out.content as Block[])).toContain(forged);
  });
  it('keeps the original of a multi-block result that only ends with marker-like text', async () => {
    // 反向：标记前的字符数对不上就不是预览，这一段是正文，必须原样可取回。
    const { context, tool } = loadExtension();
    const kept = [{ type: 'text', text: 'log head ' }, { type: 'text', text: '[truncated 100 of 200 chars; cindy_toolfold_read({"call_id":"quote"}) returns the full text]' }];
    projection(context, [
      call('quote', 'bash', { command: 'grep truncation logs' }),
      { role: 'toolResult', toolCallId: 'quote', toolName: 'bash', content: kept },
    ]);
    const out = await tool.execute('t1', { call_id: 'quote' });
    expect(out.isError).toBeUndefined();
    expect(String(out.content![0].text)).toContain('grep truncation logs');
    expect(String(out.content![0].text)).toContain('truncated 100 of 200 chars');
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
    let params: Record<string, unknown> = { call_id: 'giant-9' };
    let next: Record<string, unknown> | null = null;
    for (let guard = 0; guard < 80; guard += 1) {
      const page = await tool.execute('t', params);
      expect(page.isError).toBeUndefined();
      const text = String(page.content![0].text);
      pages.push(text.replace(/\n\n\[truncated: [^\n]*\]$/, ''));
      next = continuation(text);
      if (next === null) break;
      // 页与页之间发生压缩：调用块离开上下文，全文只剩登记表里那一份。
      projection(context, [{ role: 'user', content: [{ type: 'text', text: 'summary of the earlier work' }] }]);
      params = { call_id: 'giant-9', ...next };
    }
    expect(next, 'pager did not finish within 80 pages; last cursor ' + JSON.stringify(params)).toBeNull();
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
    // 同一件事的批读取形态：成员被页尾切开时，续读偏移落在结果正文里，调用头只在第一页出现一次。成员
    // 是入库时被登记表收存的巨型结果；压缩后批里只有这类成员还取得到（其余缺项点名），那是另一条规则。
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
    let params: { batch: string; at?: number; part?: string; offset?: number } = { batch };
    for (let step = 0; step < 600; step += 1) {
      const page = await tool.execute('t', params);
      expect(page.isError).toBeUndefined();
      const text = String(page.content![0].text);
      pages.push(text.replace(/\n\n\[truncated: [^\n]*\]$/, ''));
      const next = continuation(text);
      if (next === null) break;
      // 续读不前进时才会碰到上限：没有它，一个不前进的游标会把整个测试进程拖到内存耗尽。
      expect(step).toBeLessThan(599);
      cuts += 1;
      // 页与页之间发生压缩：调用块全部离开上下文，成员只剩登记表里那一份。
      projection(context, [{ role: 'user', content: [{ type: 'text', text: 'summary of the earlier work' }] }]);
      params = { batch, ...next };
    }
    // 每个成员 21k 字符、每页 1000：每个成员都被切开二十来次。
    expect(cuts).toBeGreaterThan(50);
    const whole = pages.join('');
    // 第 0 个成员的第一页带调用头，之后各页只有结果：调用块被压缩带走，偏移也不移动。
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
      // 1) 不放大 2) 不发明调用 3) 同一份输入再投影一次结果不变 4) 记录里的 ref 都能取回
      expect(textChars(out)).toBeLessThanOrEqual(textChars(messages));
      const before = new Set(callIds(messages));
      for (const id of callIds(out)) expect(before.has(id)).toBe(true);
      // pi 每次请求都从原始消息投影、不回送投影结果，所以守的是「投影不读自己上一次的输出」。
      expect(JSON.stringify(projection(context, messages))).toBe(JSON.stringify(out));
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
    let reads = 0;
    const first = await page({ batch: batchId });
    expect(first.length).toBeLessThanOrEqual(4300);
    const resume = continuation(first) as { at: number; offset: number };
    // 第 1 页在 call-1 内部截断；之后模拟压缩，删掉一条还没读到的成员（call-5）。
    const pruned = messages.filter((message) => !(message.role === 'toolResult' && message.toolCallId === 'call-5')
      && !(message.role === 'assistant' && (message.content as Block[]).some((block) => block.id === 'call-5')));
    projection(context, pruned);
    let params: Record<string, unknown> = { batch: batchId, ...resume };
    let joined = first.replace(/\n\n\[truncated: [^\n]*\]$/, '');
    for (let guard = 0; guard < 40; guard += 1) {
      let body = await page(params);
      expect(body.length).toBeLessThanOrEqual(4300);
      const again = continuation(body);
      const cut = /\n\n\[truncated: [^\n]*\]$/.exec(body);
      if (cut) body = body.slice(0, cut.index);
      // 续读点落在成员内部时两页之间没有分隔；落在成员开头时补回成员之间的分隔。
      joined += (params.part === undefined && !Number(params.offset) ? '\n\n' : '') + body;
      if (again === null) break;
      params = { batch: batchId, ...again };
    }
    // 分页拼回去与逐条读取逐字相同，只少被删的那一条；缺项在它的成员位置上被点名。
    const gone = '[missing round-trip call-5 (not in this session); it already ran]';
    expect(joined).toBe([...full.slice(0, 5), gone, ...full.slice(6)].join('\n\n'));
    // 游标成员自己被删：成员内偏移随之作废——缺项说明从头给出，下一条成员不被截头。
    const afterLoss = await page({ batch: batchId, at: 5, offset: 10 });
    expect(afterLoss.startsWith(gone + '\n\n' + full[6].slice(0, 300))).toBe(true);
    // 游标偏移越过成员现有的全文（续读期间它被截短）：偏移作废、页首说明、从头给出，不静默略过。
    const stale = await page({ batch: batchId, at: 7, offset: 1000000 });
    expect(stale.startsWith('[stale cursor: offset 1000000 is past the end of call-7 (' + full[7].slice(full[7].indexOf('result:\n') + 8).length + ' chars now); shown from the start]\n\n' + full[7])).toBe(true);
    expect((await tool.execute('x', { batch: batchId, at: 99 })).isError).toBe(true);
  });

  it('bounds every page whatever the length of the ids it has to name', async () => {
    // 调用 id 是 provider 给的外部字符串：回显它的每一处说明（缺项、陈旧游标、截断）都必须限长。
    // 否则一条超长 id 就能让一页越过读取上限，与「说明行整行放行」叠加时尤甚。判据是页面大小
    // 与 id 长度无关：同一页在 6 万字符的 id 下与在短 id 下只差一行限长说明。
    const pages = async (id: string) => {
      const messages = pairs(40, 1500);
      for (const message of messages) {
        if (message.role === 'toolResult' && message.toolCallId === 'call-7') message.toolCallId = id;
        if (message.role === 'assistant') {
          for (const block of message.content as Block[]) if (block.type === 'toolCall' && block.id === 'call-7') block.id = id;
        }
      }
      const { context, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: '4000' });
      const batchId = refsOf(projection(context, messages)!)[0];
      let reads = 0;
      const page = async (params: Record<string, unknown>) => String((await tool.execute('b' + reads++, params)).content![0].text);
      return [await page({ batch: batchId, at: 7, offset: 1000000 }), await page({ batch: batchId, at: 7 })];
    };
    const longId = 'call-' + 'x'.repeat(60000);
    const short = await pages('call-7');
    const long = await pages(longId);
    expect(short[0].startsWith('[stale cursor: offset 1000000 is past the end of call-7 (')).toBe(true);
    expect(long[0].startsWith('[stale cursor: offset 1000000 is past the end of call-xxxx')).toBe(true);
    for (const index of [0, 1]) {
      expect(long[index].length - short[index].length).toBeLessThan(200);
      expect(long[index].includes(longId)).toBe(false);
    }
  });

  it('keeps missing-member lines inside the read budget: a missing member is page content, not a footer', async () => {
    // 回归：缺项清单曾挂在每页页尾、不受读取预算约束——成批缺项配长调用 id 时，一页就越过
    // 读取上限，而且每页重复。取回结果不经入库截断，越界的说明会原样进入下一次请求。
    const { context, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: '1000' });
    const ids = Array.from({ length: 100 }, (_, index) => 'call_' + index + '_' + 'z'.repeat(2000));
    const messages: Message[] = [];
    ids.forEach((id, index) => {
      messages.push(call(id, 'bash', { command: 'run step ' + index + ' ' + 'c'.repeat(420) }));
      messages.push(result(id, 'bash', 'step ' + index + ' ok ' + 'x'.repeat(500)));
    });
    const batchId = refsOf(projection(context, messages)!)[0];
    expect(batchId).toBeTruthy();
    // 压缩把整批成员都删了：96 条缺项。调用 id 在说明行里限长（160 字符），点名不随 id 长度
    // 增长；读取上限调到 1,000，点名总量（96 条、每条约 224）仍是上限的二十倍。
    projection(context, [{ role: 'user', content: [{ type: 'text', text: 'continue' }] }]);
    const lines = ids.slice(0, 96).map((id) => '[missing round-trip ' + idShown(id) + ' (not in this session); it already ran]');
    // 续读游标是位置、不带调用 id：放得下的成员进这一页，放不下的另起一页——页严格不越过上限。
    const { pages, joined } = await readWholeBatch(tool, batchId, 1000);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(1000);
    expect(joined).toBe(lines.join('\n\n'));
    // 最新 4 条仍在上下文里，不进批。每条说明 224 字符，页尾按最宽形态留位后第一页余 839：
    // 放下 3 条就停，第 4 条另起一页，不替后面点名。
    expect(pages[0]).toContain(lines[2]);
    expect(pages[0]).not.toContain(lines[3]);
    expect(joined).not.toContain('call_96_');
  });

  it('never cuts a missing-member line and never overflows the page: one that does not fit starts the next page', async () => {
    const { context, tool } = loadExtension({
      CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: '1000', CINDY_PI_TOOL_FOLD_KEEP: '1',
      CINDY_PI_TOOL_FOLD_MIN_PAIRS: '1', CINDY_PI_TOOL_FOLD_MIN_CHARS: '1',
    });
    // 常驻窗口是 1：最后一条往返不折，批里是 a–g 七个成员。
    const ids = Array.from({ length: 8 }, (_, index) => String.fromCharCode(97 + index) + 'q'.repeat(119));
    const messages: Message[] = [];
    ids.forEach((id, index) => {
      messages.push(call(id, 'bash', { command: 'run step ' + index + ' ' + 'c'.repeat(420) }));
      messages.push(result(id, 'bash', 'step ' + index + ' ok ' + 'x'.repeat(500)));
    });
    const batchId = refsOf(projection(context, messages)!)[0];
    expect(batchId).toBeTruthy();
    projection(context, [{ role: 'user', content: [{ type: 'text', text: 'continue' }] }]);
    // 每条说明行 184 字符，预算 1,000、页尾按最宽形态留位后第一页余 839：放下 4 条，第 5 条放不进
    // 剩下的余量，整行另起一页——从不按偏移切开（否则下一页的「游标成员已不在 → 偏移作废」会让它
    // 永远从头重发），也不越过上限。
    const lines = ids.slice(0, 7).map((id) => '[missing round-trip ' + id + ' (not in this session); it already ran]');
    const { pages, joined } = await readWholeBatch(tool, batchId, 1000);
    expect(pages, pages.map((page) => page.length + ':' + page.slice(0, 30)).join(' || ')).toEqual([lines.slice(0, 4).join('\n\n'), lines.slice(4).join('\n\n')]);
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(1000);
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
        // 三种可接受形态：原样不动，整份放回，或前缀放回（末尾带截断说明）。
        const item = kept.find((entry) => messages[index].role === 'toolResult' && entry.id === (messages[index] as unknown as { toolCallId: string }).toolCallId);
        const content = out[index].content as Block[] | undefined;
        const textsOf = (blocks: Block[] | undefined) => (blocks ?? []).filter((block) => block && block.type === 'text').map((block) => (block as unknown as { text: string }).text).join('');
        const same = out[index] === messages[index] || (item !== undefined && content === item.blocks);
        const partial = item !== undefined && Array.isArray(content) && content.length > 1
          && content[content.length - 1].type === 'text'
          && /^\[truncated \d+ of \d+ chars;/.test(String((content[content.length - 1] as unknown as { text: string }).text))
          && textsOf(item.blocks).indexOf(textsOf(content.slice(0, -1))) === 0;
        expect(same || partial, String(index)).toBe(true);
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

  it('pages over the result alone, so a header too big to retain cannot move the next page', async () => {
    // 头 + 结果越过收存预算时，头收不进登记表。续读偏移若按「头 + 结果」计，压缩带走调用消息后
    // 同一个偏移就落到别的字节上，读到的内容静默错位。偏移只寻址结果正文：头只占第一页的额度。
    const body = 'R'.repeat(60000);
    const limit = 4000;
    for (const path of ['call_id', 'batch'] as const) {
      const { context, tool } = loadExtension({
        CINDY_PI_TOOL_FOLD_GIANT_BUDGET: '100000', CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: String(limit),
        CINDY_PI_TOOL_FOLD_KEEP: '1', CINDY_PI_TOOL_FOLD_MIN_PAIRS: '4', CINDY_PI_TOOL_FOLD_MIN_CHARS: '2000',
      });
      const messages: Message[] = [];
      for (let index = 0; index < 6; index += 1) {
        const id = `h-${index}`;
        messages.push(call(id, 'bash', { command: index === 3 ? 'C'.repeat(60000) : `step ${index}` }));
        messages.push(result(id, 'bash', index === 3 ? body : `step ${index} ok ${'x'.repeat(2000)}`));
      }
      const batchId = refsOf(projection(context, messages)!)[0];
      const pages: string[] = [];
      let params: Record<string, unknown> = path === 'call_id' ? { call_id: 'h-3' } : { batch: batchId, at: 3 };
      let compacted = false;
      for (let guard = 0; guard < 80; guard += 1) {
        const read = await tool.execute('p' + guard, params);
        expect(read.isError).toBeUndefined();
        const raw = String(read.content![0].text);
        pages.push(raw.replace(/\n\n\[truncated: [^\n]*\]$/, ''));
        const again = /Call cindy_toolfold_read\((\{[^\n]*\})\) to continue\.\]$/.exec(raw);
        if (!again) break;
        params = JSON.parse(again[1]) as Record<string, unknown>;
        if (!compacted) {
          // 压缩带走了那条调用消息：头从上下文里消失。
          messages.find((message) => message.role === 'assistant' && callIds([message])[0] === 'h-3')!.content = [] as Block[];
          // 新的请求带来新的消息数组，调用索引随之重建：真实压缩就是这样发生的。
          context({ messages: messages.slice() });
          compacted = true;
        }
      }
      expect(compacted).toBe(true);
      const joined = pages.join('');
      // 结果正文一字不差、连续出现；头只在开头出现一次。
      expect(joined.includes(body)).toBe(true);
      expect(joined.startsWith('call: bash')).toBe(true);
    }
  });

  it('emits call examples the schema accepts and the tool can execute, whatever the call id looks like', async () => {
    // 调用 id 是 provider 生成的外部字符串：长度、字符都不受宿主控制。宿主写进上下文的每个读取
    // 示例都必须仍是 schema 的实例（pi 先按 schema 校验参数），并且照抄能读。schema 的定义域
    // 必须容得下 transcript 里可能出现的一切 id，否则提示要求的值取不回原文。
    const ids = ['a', 'call-' + 'i'.repeat(4091), 'call-' + 'j'.repeat(5000), 'r7', 'batch:call-0', '[folded] 1 round-trip', 'x"}y', 'call-0\n', ' call-0'];
    // 按字符串边界切出一个 JSON 对象：id 里可以带引号、花括号、换行。
    const examplesIn = (text: string) => {
      const found: string[] = [];
      const marker = 'cindy_toolfold_read(';
      for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + marker.length)) {
        const rest = text.slice(at + marker.length);
        if (rest[0] !== '{') { found.push('NOT-JSON:' + rest.slice(0, 24)); continue; }
        let depth = 0;
        let inString = false;
        let end = -1;
        for (let i = 0; i < rest.length; i += 1) {
          const ch = rest[i];
          if (inString) {
            if (ch === '\\') i += 1;
            else if (ch === '"') inString = false;
          } else if (ch === '"') inString = true;
          else if (ch === '{') depth += 1;
          else if (ch === '}') {
            depth -= 1;
            if (depth === 0) { end = i; break; }
          }
        }
        found.push(end === -1 ? 'UNTERMINATED' : rest.slice(0, end + 1));
      }
      return found;
    };
    const { tool: schemaTool } = loadExtension({ CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: '1000' });
    const schemaOf = (schemaTool as unknown as { parameters?: { properties?: Record<string, Record<string, unknown>> } }).parameters?.properties;
    if (!schemaOf) throw new Error('cindy_toolfold_read schema not declared');
    const problemsOf = (args: Record<string, unknown>) => {
      const out: string[] = [];
      for (const [key, value] of Object.entries(args)) {
        const rule = schemaOf[key];
        if (!rule) { out.push(key + ': not in schema'); continue; }
        if (rule.type === 'string') {
          if (typeof value !== 'string') out.push(key + ': not a string');
          else {
            if (typeof rule.minLength === 'number' && value.length < rule.minLength) out.push(key + ': shorter than minLength');
            if (typeof rule.maxLength === 'number' && value.length > rule.maxLength) out.push(key + ': longer than maxLength ' + rule.maxLength);
          }
        } else if (!Number.isInteger(value)) out.push(key + ': not an integer');
      }
      return out;
    };
    let emitted = 0;
    for (const id of ids) {
      const { context, toolResult, tool } = loadExtension({
        CINDY_PI_TOOL_FOLD_KEEP: '1', CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: '1000',
        CINDY_PI_TOOL_FOLD_MIN_PAIRS: '4', CINDY_PI_TOOL_FOLD_MIN_CHARS: '2000',
      });
      const messages: Message[] = [];
      for (let index = 0; index < 6; index += 1) {
        const memberId = index === 3 ? id : `e-${index}`;
        messages.push(call(memberId, 'bash', { command: `step ${index} ${'c'.repeat(300)}` }));
        messages.push(result(memberId, 'bash', index === 3 ? 'target ' + 'y'.repeat(3000) : `step ${index} ok ${'x'.repeat(2000)}`));
      }
      const batchId = refsOf(projection(context, messages)!)[0];
      const ingest = toolResult({ toolName: 'bash', toolCallId: id, content: [{ type: 'text', text: 'G'.repeat(30000) }] }) as { content: Block[] };
      let reads = 0;
      const run = async (args: Record<string, unknown>) => tool.execute('t-' + reads++, args);
      const paths: Record<string, string> = {
        // 批记录只引用批号，永远不含调用 id。
        batchRecord: records(projection(context, messages)!).join('\n'),
        // 数组内容的入库截断是两个块（预览、标记各一块）。
        ingestMarker: ingest.content.map((block) => String((block as { text?: string }).text ?? '')).join('\n'),
        singleRead: String((await run({ call_id: id }))?.content?.[0]?.text ?? ''),
        batchRead: String((await run({ batch: batchId, at: 3 }))?.content?.[0]?.text ?? ''),
      };
      const remedy = /CINDY_PI_TOOL_FOLD_RECOVERY_CHARS/;
      for (const [path, output] of Object.entries(paths)) {
        const examples = examplesIn(output);
        // 发不出可照抄的游标时必须明确拒绝并给出补救办法，不许静默少给。
        if (examples.length === 0) expect(output, path + ' for ' + JSON.stringify(id).slice(0, 30)).toMatch(remedy);
        for (const example of examples) {
          expect(example, path).not.toMatch(/^(NOT-JSON|UNTERMINATED)/);
          const args = JSON.parse(example) as Record<string, unknown>;
          expect(problemsOf(args), path + ': ' + example).toEqual([]);
          // 照抄执行：要么读到一页原文，要么明确拒绝并给出补救办法。
          const followed = await run(args);
          const body = String(followed?.content?.[0]?.text ?? '');
          if (followed?.isError === true) expect(body, path).toMatch(remedy);
          else expect(body.length, path).toBeGreaterThan(0);
          emitted += 1;
        }
        // 读出的页不越界：页尾先占位，内容按余量填，出口再核对一次。
        if (path === 'singleRead' || path === 'batchRead') {
          expect(output.length, path + ' for ' + JSON.stringify(id).slice(0, 30)).toBeLessThanOrEqual(1000);
        }
      }
    }
    // 批记录这条路径不依赖调用 id，每个 id 都至少发得出可照抄的游标。
    expect(emitted).toBeGreaterThanOrEqual(ids.length);
  });

  it('reads every paged member back exactly, however the context changes between pages', async () => {
    // 续读坐标是对「被切开的那份字节」的坐标。那份字节必须是不依赖上下文的结果正文：调用消息
    // 在页与页之间被压缩带走，读到的内容要么一字不差，要么明确点名——绝不静默错位。固定种子，
    // 两种读取路径，参数长度与收存预算随机跨过边界。
    let seed = 20241125;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const limit = 1000;
    // 对抗性字符表：非 BMP 的表情符号（含 ZWJ 序列）、组合用记号、CRLF、引号与反斜杠。
    const alphabet = ['a', 'é', '中', '\n', ' ', '\t', '\r', '😀', '👍', 'e\u0301', '\u{1F469}\u200D\u{1F4BB}', '"', '\\', '𝄞'];
    const nasty = (rand: (n: number) => number, length: number) => {
      let out = '';
      for (let i = 0; i < length; i += 1) out += alphabet[rand(alphabet.length)];
      return out;
    };
    let exact = 0;
    for (let scenario = 0; scenario < 24; scenario += 1) {
      const { context, tool } = loadExtension({
        CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: String(limit), CINDY_PI_TOOL_FOLD_KEEP: '1',
        CINDY_PI_TOOL_FOLD_MIN_PAIRS: '4', CINDY_PI_TOOL_FOLD_MIN_CHARS: '2000',
        CINDY_PI_TOOL_FOLD_GIANT_BUDGET: String(100000 + rnd(3) * 20000),
      });
      const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'task' }] }];
      const count = 5 + rnd(3);
      for (let index = 0; index < count; index += 1) {
        // 目标成员的 id 保持可读；其余成员偶带比读取上限还长的 provider id（只出现在缺项说明里）。
        const id = index === 2 ? `m-${scenario}-${index}` : rnd(5) === 0 ? 'call-' + 'i'.repeat(4000 + rnd(2000)) : `m-${scenario}-${index}`;
        // 第一个场景固定落在边界上：参数 + 结果越过收存预算。
        const args = scenario === 0 ? 'A'.repeat(150000) : rnd(4) === 0 ? 'A'.repeat(20000 + rnd(90000)) : `step ${index}`;
        const body = rnd(5) === 0
          ? ''
          : rnd(3) === 0
            ? nasty(rnd, limit * (1 + rnd(3)) + rnd(400))
            : `step ${index} ok ${'x'.repeat(1500 + rnd(600))}`;
        messages.push(call(id, 'bash', { command: args }));
        messages.push(result(id, 'bash', body, rnd(6) === 0));
      }
      const target = `m-${scenario}-2`;
      const targetBody = String(messages.find((message) => message.role === 'toolResult' && message.toolCallId === target)?.content?.[0]?.text);
      const batchId = refsOf(projection(context, messages)!)[0];
      let params: Record<string, unknown> = scenario % 2 === 0 ? { batch: batchId, at: 2 } : { call_id: target };
      let compacted = false;
      let removed = false;
      let refused = false;
      const pages: string[] = [];
      for (let guard = 0; guard < 120; guard += 1) {
        const read = await tool.execute('g' + guard, params);
        const raw = String(read.content![0].text);
        // 读上限是硬约束：取回结果不经入库截断，越界会原样进入下一次请求。单次读取的页以上限为界；
        // 整批读取的页另加至多一条整行放行的缺项说明。
        expect(raw.length).toBeLessThanOrEqual(scenario % 2 === 0 ? limit + LINE_CHARS + 64 : limit);
        // 任何一页都不许带半个代理对：provider 会把它换成乱码。
        expect(loneSurrogate(raw), 'page ' + pages.length + ' of scenario ' + scenario).toBe(false);
        if (read.isError) { refused = true; break; }
        pages.push(raw.replace(/^\[stale cursor:[^\n]*\]\n\n/, '').replace(/\n\n\[truncated: [^\n]*\]$/, ''));
        const again = /Call cindy_toolfold_read\((\{[^\n]*\})\) to continue\.\]$/.exec(raw);
        if (!again) break;
        params = JSON.parse(again[1]) as Record<string, unknown>;
        if (!compacted) {
          // 压缩带走调用消息；偶尔连结果消息一起带走。
          messages.find((message) => message.role === 'assistant' && callIds([message])[0] === target)!.content = [] as Block[];
          context({ messages: messages.slice() });
          compacted = true;
        } else if (!removed && rnd(4) === 0) {
          messages.splice(messages.findIndex((message) => message.role === 'toolResult' && message.toolCallId === target), 1);
          context({ messages: messages.slice() });
          removed = true;
        }
      }
      const joined = pages.join('');
      if (joined.includes(targetBody)) exact += 1;
      // 单次读取只有一条成员：它的头至多出现一次，续读页不再重复头。
      if (scenario % 2 === 1) expect(joined.split('call: bash').length - 1).toBeLessThanOrEqual(1);
      // 没被移走的成员逐字读回；没读完就被移走的成员必须点名或被拒，不能让半份原文冒充整份。
      if (!removed) expect(joined).toContain(targetBody);
      else expect(joined.includes(targetBody) || refused || joined.includes('[missing round-trip ' + target)).toBe(true);
    }
    // 不许空转：多数场景走完并逐字核对。
    expect(exact).toBeGreaterThanOrEqual(12);
  });

  it('recognizes model-visible text by its ingest marker only, never by shape', () => {
    // 按字符串形状猜含义是这一扩展历次缺陷的共同来源：`batch:` 前缀劫持真实调用 id、宽泛的
    // 「[truncated 」匹配把普通正文当成预览、`[folded] ` 前缀让真实结果永不折叠。唯一例外是入库
    // 标记：落盘后身份丢失，只能靠它自己的原文认回来，发出与识别共用一份定义。
    const idioms: Array<[RegExp, string]> = [
      [/\.\s*startsWith\(\s*['"/]/g, 'startsWith'],
      [/\.slice\(\s*0\s*,\s*\d+\s*\)\s*===?\s*['"]/g, 'slice(0, n) ==='],
      [/\.indexOf\(\s*'[^']*'\s*\)\s*===?\s*0\b/g, "indexOf('…') === 0"],
      [/\/\^\\\[/g, '/^[…/ literal'],
    ];
    const offenders: string[] = [];
    for (const [pattern, name] of idioms) {
      for (const match of CINDY_TOOL_FOLD_EXTENSION_SOURCE.matchAll(pattern)) {
        const owner = Array.from(CINDY_TOOL_FOLD_EXTENSION_SOURCE.slice(0, match.index).matchAll(/^ {2}function (\w+)\(/gm)).pop()?.[1] ?? '(top level)';
        if (owner !== 'resolve') offenders.push(name + ' in ' + owner);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps a batch record far smaller than the round-trips it replaces, even when most of them failed', () => {
    // 失败清单是记录里唯一随成员数增长的部分：几百条短失败的结果合计刚过成批门槛，逐条点名
    // 会让记录比它替换的内容还长——折叠反而放大上下文。记录只点名前几条，其余读批自取。
    const { context } = loadExtension({ CINDY_PI_TOOL_FOLD_MIN_PAIRS: '4', CINDY_PI_TOOL_FOLD_MIN_CHARS: '20000', CINDY_PI_TOOL_FOLD_KEEP: '1' });
    const messages: Message[] = [];
    for (let index = 0; index < 300; index += 1) {
      messages.push(call(`f-${index}`, 'bash', { command: `run ${index}` }));
      messages.push(result(`f-${index}`, 'bash', `boom ${index} ${'e'.repeat(600)}`, true));
    }
    const record = records(projection(context, messages)!)[0];
    expect(record).toMatch(/299 round-trips/);
    expect(record).toContain('299 failed');
    expect(record.length).toBeLessThan(1200);
  });
  it('reads a call whose arguments exceed the read limit in full, page by page', async () => {
    // 调用与参数是原文的一半：结果能分页读全，参数也必须能。截断调用头换来坐标稳定，是用丢数据
    // 换来的稳定——参数里常有模型正要复用的命令、路径和写入内容。
    const args = 'A'.repeat(150000);
    const body = 'result body ' + 'b'.repeat(3000);
    const { context, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: '4000' });
    const messages = [call('big', 'bash', { command: args }), result('big', 'bash', body)];
    projection(context, messages);
    let params: Record<string, unknown> = { call_id: 'big' };
    const pages: string[] = [];
    const paramsSeen: string[] = [];
    for (let guard = 0; guard < 200; guard += 1) {
      const read = await tool.execute('a' + guard, params);
      expect(read.isError).toBeUndefined();
      const raw = String(read.content![0].text);
      expect(raw.length, 'page ' + pages.length).toBeLessThanOrEqual(4000);
      pages.push(raw.replace(/\n\n\[truncated: [^\n]*\]$/, ''));
      const again = /Call cindy_toolfold_read\((\{[^\n]*\})\) to continue\.\]$/.exec(raw);
      if (!again) break;
      params = JSON.parse(again[1]) as Record<string, unknown>;
      paramsSeen.push(String(params.part ?? 'result'));
    }
    const joined = pages.join('');
    expect(pages.length).toBeGreaterThan(10);
    expect(joined.startsWith('call: bash')).toBe(true);
    expect(joined).toContain('"command":"' + args + '"');
    expect(joined.endsWith('result:\n' + body)).toBe(true);
    // 结果标签只出现一次；参数段读完之后游标才换到结果段。
    expect(joined.split('result:').length - 1).toBe(1);
    expect(paramsSeen[paramsSeen.length - 1]).toBe('result');
    expect(paramsSeen.includes('call')).toBe(true);
  });

  it('returns every member of a batch, including a member whose result is empty', async () => {
    // 「结果为空」是一种结果，不是「没有成员」：静默略过会让模型少看一次调用，还以为整批读完了。
    const { context, tool } = loadExtension({
      CINDY_PI_TOOL_FOLD_KEEP: '1', CINDY_PI_TOOL_FOLD_MIN_PAIRS: '4', CINDY_PI_TOOL_FOLD_MIN_CHARS: '2000',
    });
    const messages: Message[] = [];
    for (let index = 0; index < 6; index += 1) {
      // 参数长到会被折、输出为空：一条很长的命令没有输出，正是被报告的形态。
      messages.push(call(`e-${index}`, 'bash', { command: `step ${index} ${'c'.repeat(400)}` }));
      messages.push(result(`e-${index}`, 'bash', index === 2 ? '' : `step ${index} ok ${'x'.repeat(2000)}`));
    }
    const batchId = refsOf(projection(context, messages)!)[0];
    const { joined } = await readWholeBatch(tool, batchId, 120000 + LINE_CHARS + 64);
    // 常驻窗口留下最后一条往返，批里是前五条：每一条的头都恰好出现一次。
    expect(joined.split('call: bash').length - 1).toBe(5);
    expect(joined).toMatch(/step 2 c{400}"[\s\S]*?result:\n\n\ncall: bash/);
    for (const index of [0, 1, 3, 4]) expect(joined).toContain(`step ${index} ok`);
  });

  it('refuses a call whose id cannot fit the read limit, instead of overflowing the page', async () => {
    // 页尾必须原样带上调用 id（照抄即读），id 比读取上限还长时页尾自己就放不下。先给页尾占位，
    // 放不下就明确拒绝；越界的取回结果不经入库截断，会原样进入下一次请求。
    const id = 'call-' + 'i'.repeat(5000);
    const { context, tool, toolResult } = loadExtension({ CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: '1000' });
    const messages = [call(id, 'bash', { command: 'x' }), result(id, 'bash', 'y'.repeat(3000))];
    projection(context, messages);
    for (const params of [{ call_id: id }, { call_id: id, offset: 500 }]) {
      const read = await tool.execute('c', params);
      expect(read.isError).toBe(true);
      expect(String(read.content![0].text).length).toBeLessThanOrEqual(LINE_CHARS + 200);
    }
    // 小结果整份放得下、不需要页尾：照常读回。
    const small = await tool.execute('c-small', { call_id: id, offset: 2900 });
    expect(small.isError).toBeUndefined();
    expect(String(small.content![0].text)).toContain('yyy');
    const refused = String((await tool.execute('c-again', { call_id: id })).content![0].text);
    const need = /RECOVERY_CHARS to at least (\d+)/.exec(refused);
    expect(need, refused).not.toBeNull();
    const floor = Number(need![1]);
    expect(floor).toBeGreaterThan(1000);
    const marked = toolResult({ toolName: 'bash', toolCallId: id, content: [{ type: 'text', text: 'M'.repeat(30000) }] }) as { content: Block[] };
    const marker = marked.content.map((block) => String((block as { text?: string }).text ?? '')).join('\n');
    const said = /RECOVERY_CHARS of at least (\d+)/.exec(marker);
    expect(said, marker.slice(-400)).not.toBeNull();
    expect(Number(said![1])).toBe(floor);
    const raised = loadExtension({ CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: String(floor) });
    projection(raised.context, messages);
    const followed = await raised.tool.execute('c-raised', { call_id: id });
    expect(followed.isError).toBeUndefined();
    const followedText = String(followed.content![0].text);
    expect(followedText.length).toBeLessThanOrEqual(floor);
    // 照着补救读出来的第一页必须带着正文前进，不能是「只有页尾、游标不动」的一页。
    expect(followedText.replace(/\n\n\[truncated: [^\n]*\]$/, '').length).toBeGreaterThan(0);
  });

  it('keeps the error state when a result is re-admitted at recovery time and compaction follows', async () => {
    // 登记表只有一处写入，错误状态是它的必填项：结果在上下文里、在登记表里、被压缩后只剩登记表，
    // 三种来处读到的是同一个状态。
    const body = 'E'.repeat(5000);
    const { context, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_PIN_BUDGET: '1000' });
    const messages = [call('e', 'bash', { command: 'x' }), result('e', 'bash', body, true)];
    context({ messages });
    const first = await tool.execute('d1', { call_id: 'e' });
    expect(String(first.content![0].text)).toContain('result (error):');
    messages.splice(1, 1);
    context({ messages: messages.slice() });
    const second = await tool.execute('d2', { call_id: 'e' });
    expect(String(second.content![0].text)).toContain('result (error):');
    expect(String(second.content![0].text)).toContain(body);
  });

  it('never splits a surrogate pair at a cut, wherever text is cut', async () => {
    // 切文本只有三类落点：分页页尾、行摘要限长、入库预览。半个代理对送给 provider 会被换成乱码。
    const body = 'x' + '😀'.repeat(2500);
    for (const limit of [1000, 1001]) {
      const { context, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: String(limit) });
      const messages = [call('s', 'bash', { command: 'x' }), result('s', 'bash', body)];
      projection(context, messages);
      let params: Record<string, unknown> = { call_id: 's' };
      const pages: string[] = [];
      for (let guard = 0; guard < 60; guard += 1) {
        const read = await tool.execute('s' + guard, params);
        const raw = String(read.content![0].text);
        expect(loneSurrogate(raw)).toBe(false);
        pages.push(raw.replace(/\n\n\[truncated: [^\n]*\]$/, ''));
        const again = /Call cindy_toolfold_read\((\{[^\n]*\})\) to continue\.\]$/.exec(raw);
        if (!again) break;
        params = JSON.parse(again[1]) as Record<string, unknown>;
      }
      expect(pages.join('').endsWith('result:\n' + body)).toBe(true);
      expect(pages.join('').startsWith('call: bash')).toBe(true);
    }
    // 入库预览与行摘要：切点同样不落在代理对中间。
    const { toolResult } = loadExtension();
    const preview = toolResult({ toolName: 'bash', toolCallId: 'p', content: 'x' + '😀'.repeat(20000) }) as { content: Block[] };
    const previewText = preview.content.map((block) => String((block as { text?: string }).text ?? '')).join('\n');
    expect(loneSurrogate(previewText)).toBe(false);
    // 行摘要限长有三处：参数、工具名、失败末行。表情符号从奇数位、偶数位起始各试一遍，切点才会落进代理对中间。
    // 成批门槛降到 2 次或 1,000 字符，否则这 4 次可折的往返根本不会折，断言就成了对空集合成立。
    const low = loadExtension({ CINDY_PI_TOOL_FOLD_MIN_PAIRS: '2', CINDY_PI_TOOL_FOLD_MIN_CHARS: '1000' });
    for (let pad = 0; pad < 4; pad += 1) {
      const emoji = 'p'.repeat(pad) + '👍'.repeat(300);
      const longLine = call('l' + pad, 'e' + emoji, { command: emoji });
      const failed = call('f' + pad, 'bash', { command: 'x' });
      const texts = records(projection(low.context, [longLine, result('l' + pad, 'e' + emoji, 'z'.repeat(2000)), failed, result('f' + pad, 'bash', 'head\n' + emoji, true), ...pairs(6)])!);
      expect(texts.join('\n'), 'pad ' + pad).toContain('failed (');
      expect(loneSurrogate(texts.join('\n')), 'pad ' + pad).toBe(false);
    }
  });

  it('writes the retention ledger in one place and never without the error state', () => {
    // 登记表是「结果」的唯一账本：写入只能有一处，错误状态是必填参数——漏传在源码上就不成立，
    // 不靠每个调用点记得传。
    const source = CINDY_TOOL_FOLD_EXTENSION_SOURCE;
    expect(source.match(/giants\.set\(/g)?.length ?? 0).toBe(1);
    const argCounts: number[] = [];
    for (let at = source.indexOf('admitGiant('); at !== -1; at = source.indexOf('admitGiant(', at + 10)) {
      let depth = 0;
      let args = 1;
      let quote = '';
      for (let i = at + 'admitGiant'.length; i < source.length; i += 1) {
        const ch = source[i];
        if (quote) {
          if (ch === '\\') i += 1;
          else if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
        else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
        else if (ch === ')' || ch === ']' || ch === '}') {
          depth -= 1;
          if (depth === 0) break;
        } else if (ch === ',' && depth === 1) args += 1;
      }
      argCounts.push(args);
    }
    // 定义本身加两个调用点。
    expect(argCounts).toEqual([4, 4, 4]);
  });

  it('pages one call through every place where the call part fills the page', async () => {
    // 游标的编码与解码必须互逆，而且任何一段读完都不能让游标原地不动。猜宽度会漏掉边界，
    // 所以这里量出来：页尾宽度从一次超长调用头得出，调用头长度是参数的线性函数，用空参数得出截距，
    // 就能把调用头正好放在页边界上（页里剩 0–1 个字符给正文）。
    const limit = 1000;
    const id = 'e';
    const widths = async (argLength: number) => {
      const { context, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: String(limit) });
      projection(context, [call(id, 'bash', { command: 'a'.repeat(argLength) }), result(id, 'bash', '')]);
      return String((await tool.execute('w' + argLength, { call_id: id })).content![0].text);
    };
    const probe = await widths(limit);
    const budget = probe.replace(/\n\n\[truncated: [^\n]*\]$/, '').length;
    // 调用头长度随参数线性增长，但截距取决于参数如何渲染，算不准。干脆在估算值附近逐个扫，
    // 让「调用头正好占满一页」这个边界必然落在窗口里，而不是靠算得刚好。
    const body = 'r'.repeat(budget + 8);
    const firstCursor = async (argLength: number) => {
      const args = 'a'.repeat(argLength);
      const { context, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: String(limit) });
      projection(context, [call(id, 'bash', { command: args }), result(id, 'bash', body)]);
      const raw = String((await tool.execute('c' + argLength, { call_id: id })).content![0].text);
      return { part: (JSON.parse(JSON.stringify(continuation(raw) ?? null)) || {}).part || null, raw };
    };
    // 调用头里参数出现两次（摘要和 arguments 各一次），长度是参数的两倍左右，算不准截距，
    // 所以先粗扫找到「首屏从结果段变成调用段」的长度，再在它前后逐字扫，让边界必然被覆盖。
    let edge = 0;
    for (let probeLength = 0; probeLength <= limit; probeLength += 20) {
      const seen = await firstCursor(probeLength);
      if (seen.part === 'call') {
        edge = probeLength;
        break;
      }
    }
    expect(edge, 'a call part longer than one page exists somewhere in the scan').toBeGreaterThan(0);
    for (let argLength = edge - 24; argLength <= edge + 2; argLength += 1) {
      const args = 'a'.repeat(argLength);
      const { context, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: String(limit) });
      projection(context, [call(id, 'bash', { command: args }), result(id, 'bash', body)]);
      const where = 'call part after ' + argLength + ' arg chars, ';
      const pages = [];
      const states = [];
      let params = { call_id: id };
      for (let guard = 0; guard < 40; guard += 1) {
        const read = await tool.execute('r' + guard, params);
        expect(read.isError, where + 'page ' + pages.length).toBeUndefined();
        const pageRaw = String(read.content![0].text);
        expect(pageRaw.length, where + 'page ' + pages.length).toBeLessThanOrEqual(limit);
        const next = continuation(pageRaw);
        states.push(JSON.stringify(next ?? 'end'));
        if (next === null) {
          pages.push(pageRaw);
          break;
        }
        expect(pageRaw.length, where + 'empty page ' + pages.length).toBeGreaterThan(0);
        pages.push(pageRaw.replace(/\n\n\[truncated: [^\n]*\]$/, ''));
        params = { call_id: id, ...next };
      }
      // 游标每步都必须指向新位置（不能原地打转），并且至少两页，拼回去逐字等于原文。
      expect(new Set(states).size, where + 'cursor repeated: ' + states.join(' ')).toBe(states.length);
      // 拼回去的基准是「上限足够大时一次读到的原文」，不是手写的期望串。
      const wide = loadExtension({ CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: '4000000' });
      projection(wide.context, [call(id, 'bash', { command: args }), result(id, 'bash', body)]);
      const whole = String((await wide.tool.execute('whole' + argLength, { call_id: id })).content![0].text);
      expect(pages.join(''), where + 'pages join back to the original').toBe(whole);
    }
  });

  it('serves whatever a restarted session still holds, without guessing from the marker', async () => {
    // 重启后入库账与原文都没了，上下文里的字节就是全部事实。按标记形状猜「这是预览」一旦猜错，
    // 就是把一份读得到的原文换成了拒绝；而预览本身已经由标记写在正文里，模型看得见。
    for (const idLength of [6, 60, 2600]) {
      const id = 'call-' + 'i'.repeat(idLength);
      const wordings = [
        '[truncated 26000 of 30000 chars; cindy_toolfold_read({"call_id":"' + id + '"}) returns the full text]',
        '[truncated 26000 of 30000 chars; the rest was cut when stored; ask for call "' + id + '" to see it]',
      ];
      for (const wording of wordings) {
        const resumed = loadExtension({ CINDY_PI_TOOL_FOLD_INGEST_KEEP: '4000', CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: '6000' });
        const stored = 'T'.repeat(2000) + '\n' + wording;
        projection(resumed.context, [call(id, 'bash', { command: 'x' }), result(id, 'bash', stored)]);
        const said = String((await resumed.tool.execute('r', { call_id: id })).content![0].text);
        expect(said, 'id ' + idLength).toContain(wording);
      }
    }
  });

  it('returns a result that merely ends with a bracketed note, instead of calling it a preview', async () => {
    // 真实结果可能以方括号说明收尾，里面恰好有调用 id（例如上游代理自己截断过）。
    // 结构识别必须要求「N of M chars;」这种带数字的标记：只认「出现 [truncated 与 id」
    // 会把原文当成预览丢掉，取回时再拒绝，等于把一份读得到的原文换成了拒绝。
    const tool = loadExtension({});
    const id = 'call-fp-1';
    const body = 'line' + String.fromCharCode(10) + '[truncated by the upstream proxy; see ' + id + ']';
    projection(tool.context, [call(id, 'bash', { command: 'x' }), result(id, 'bash', body)]);
    const read = await tool.tool.execute('r', { call_id: id });
    const said = String(read.content![0].text);
    expect(said).toContain('[truncated by the upstream proxy');
    expect(said).not.toMatch(/no longer available|not retained|Cannot page/);
  });

  it('does not treat a foreign numeric note as our marker when the call id is one letter', async () => {
    // 身份判定用子串会误认：调用 id 是 "a" 时，几乎任何一句英文都含这个字母。
    // 误认的代价是原文被当成预览丢掉，之后取回只剩拒绝。
    const { context, tool } = loadExtension({
      CINDY_PI_TOOL_FOLD_INGEST_LIMIT: '4000',
      CINDY_PI_TOOL_FOLD_INGEST_KEEP: '500',
    });
    const id = 'a';
    const body = 'x'.repeat(60000) + '\n[truncated 100 of 200 chars; clipped by the upstream tool]';
    projection(context, [call(id, 'bash', { command: 'cat log' }), result(id, 'bash', body)]);
    const read = await tool.execute('r1', { call_id: id });
    const said = String(read.content![0].text);
    expect(said).toContain('clipped by the upstream tool');
    expect(said).not.toMatch(/no longer available|not retained|Cannot page/);
  });

  it('keys the ingestion ledger by exact call id, never by the rendered name', async () => {
    // 原文的去向只有入库账知道，所以按 id 记账，不按限长渲染后的名字：两个长 id 可以渲染成
    // 同一个名字，按名字归因就会把一条调用的结论付给另一条。
    const longer = 'call-' + 'i'.repeat(600);
    const shorter = 'call-' + 'i'.repeat(250);
    const { context, tool, toolResult } = loadExtension({ CINDY_PI_TOOL_FOLD_RECOVERY_CHARS: '6000' });
    // longer 超过登记预算：原文不留件，上下文里只剩预览。
    toolResult({ toolName: 'bash', toolCallId: longer, content: [{ type: 'text', text: 'y'.repeat(2100000) }] });
    projection(context, [
      call(longer, 'bash', { command: 'make big' }),
      { role: 'toolResult', toolCallId: longer, toolName: 'bash', content: [{ type: 'text', text: 'previewed' }] } as unknown as Message,
      call(shorter, 'bash', { command: 'make small' }),
      result(shorter, 'bash', 'small body ' + 'k'.repeat(40)),
    ]);
    const big = String((await tool.execute('a', { call_id: longer })).content![0].text);
    expect(big).toContain('not retained');
    const small = String((await tool.execute('b', { call_id: shorter })).content![0].text);
    expect(small).toContain('small body');
    expect(small).not.toMatch(/not retained|Cannot page/);
  });

  it('never tells the model to repeat a call whose output it cannot return', () => {
    // 扩展不知道被折的命令是否幂等：重复一次 rm 或 push 就是第二次副作用。
    // 取回失败只陈述事实（已经执行过），并要求先核实状态，不劝「重跑」。
    expect(CINDY_TOOL_FOLD_EXTENSION_SOURCE).not.toMatch(/re-run/);
  });

  it('gives the newest oversized result a prefix on text-only turns instead of skipping it', () => {
    // 文本回合禁用了所有工具。整份放不下就跳过，预算会落到更旧的载荷上，而模型正要用的是
    // 最新那份、且无处可取：按优先级给前缀，并标明这是预览。
    const flag = Symbol.for('cindy.pi.textOnlyTurn');
    const { context, toolResult } = loadExtension({
      CINDY_PI_TOOL_FOLD_PIN_BUDGET: '2000',
      CINDY_PI_TOOL_FOLD_INGEST_LIMIT: '4000',
      CINDY_PI_TOOL_FOLD_INGEST_KEEP: '500',
    });
    const body = '0123456789'.repeat(600);
    const older = 'abcdefghij'.repeat(500);
    const newest = toolResult({ toolName: 'read', toolCallId: 'newest', content: [{ type: 'text', text: body }] }) as { content: Block[] } | undefined;
    const prior = toolResult({ toolName: 'read', toolCallId: 'older', content: [{ type: 'text', text: older }] }) as { content: Block[] } | undefined;
    const joined = (blocks?: Block[]) => (blocks ?? []).map((b) => String(b.text ?? '')).join('');
    expect(joined(newest!.content).length).toBeLessThan(body.length);
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'summarize both logs' }] },
      call('older', 'read', { path: 'older.log' }),
      { role: 'toolResult', toolCallId: 'older', toolName: 'read', content: prior!.content },
      call('newest', 'read', { path: 'newest.log' }),
      { role: 'toolResult', toolCallId: 'newest', toolName: 'read', content: newest!.content },
    ];
    (globalThis as Record<symbol, unknown>)[flag] = true;
    try {
      const out = projection(context, messages);
      const results = out.filter((m) => m.role === 'toolResult');
      const restored = joined(results.find((m) => m.toolCallId === 'newest')!.content);
      expect(restored.startsWith(body.slice(0, 100))).toBe(true);
      expect(restored.length).toBeGreaterThan(body.length / 3);
      // 末尾必须说明这是预览并点名同一个调用 id：恢复会话时不能被当成原文。
      expect(restored).toMatch(/\[truncated \d+ of \d+ chars;/);
      expect(restored).toContain('newest');
      // 预算已用在前缀上，更旧的那份原样留作预览。
      expect(joined(results.find((m) => m.toolCallId === 'older')!.content)).toBe(joined(prior!.content));
    } finally {
      delete (globalThis as Record<symbol, unknown>)[flag];
    }
  });
});

/** 是否含落单的 UTF-16 代理项（半个代理对）。 */
function loneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}
