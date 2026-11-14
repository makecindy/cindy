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
  const body = CINDY_TOOL_FOLD_EXTENSION_SOURCE.replace(/^export default /m, '');
  const handlers: Record<string, Handler> = {};
  const tools: Record<string, Tool> = {};
  const pi = {
    on(name: string, fn: Handler) { handlers[name] = fn; },
    registerTool(tool: Tool & { name: string }) { tools[tool.name] = tool; },
  };
  new Function('pi', `const extension = ${body};\nextension(pi);`)(pi);
  if (!handlers.context) throw new Error('context handler was not registered');
  return { context: handlers.context, toolResult: handlers.tool_result, tool: tools.toolfold_read };
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
    messages.push(call(id, 'bash', { command: `run step ${index} with a reasonably long command line` }));
    messages.push(result(id, 'bash', `step ${index} ok ${'x'.repeat(textLength)}`));
  }
  return messages;
}

function isFolded(message: Message): boolean {
  const args = message.content?.[0]?.arguments as Record<string, unknown> | undefined;
  return args?.__folded === true;
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

  it('folds the whole backlog at once, keeps the newest 8 pairs verbatim and names the recovery id', () => {
    const { context } = loadExtension({ CINDY_PI_TOOL_FOLD_KEEP: '8' });
    const messages = pairs(40);
    const out = projection(context, messages);
    expect(out).toHaveLength(messages.length);
    const residentFrom = messages.length - 16;
    for (let index = 0; index < residentFrom; index += 1) {
      if (messages[index].role === 'assistant') expect(isFolded(out[index])).toBe(true);
    }
    for (let index = residentFrom; index < messages.length; index += 1) {
      expect(out[index]).toBe(messages[index]);
    }
    // Protocol shape survives: every result still answers an existing call, ids unchanged.
    const ids = new Set<string>();
    for (const message of out) {
      if (message.role === 'assistant') {
        for (const block of message.content ?? []) if (block.type === 'toolCall') ids.add(String(block.id));
      } else if (message.role === 'toolResult') {
        expect(ids.has(String(message.toolCallId))).toBe(true);
      }
    }
    const foldedText = String(out[1].content![0].text);
    expect(foldedText).toContain('[folded] ok');
    expect(foldedText).toContain('toolfold_read("call-0")');
    expect(foldedText).toContain('step 0 ok');
    expect(String((out[0].content![0].arguments as Record<string, unknown>).summary)).toContain('run step 0');
  });

  it('keeps folds sticky and does not rewrite them again until the next batch', () => {
    const { context } = loadExtension({ CINDY_PI_TOOL_FOLD_KEEP: '8' });
    const first = projection(context, pairs(40));
    const firstFolded = String((first[0].content![0].arguments as Record<string, unknown>).summary);
    const firstSavings = JSON.stringify(first).length;
    const again = projection(context, pairs(40));
    expect(String((again[0].content![0].arguments as Record<string, unknown>).summary)).toBe(firstFolded);
    expect(JSON.stringify(again).length).toBe(firstSavings);
    const grown = projection(context, pairs(41));
    expect(String((grown[0].content![0].arguments as Record<string, unknown>).summary)).toBe(firstFolded);
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

  it('recovers a folded original via toolfold_read and pins it until the next user message', async () => {
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
    expect(isFolded(pinnedView[10])).toBe(false);
    expect(pinnedView[11]).toBe(messages[11]);
    expect(isFolded(pinnedView[0])).toBe(true);
    // Turn boundary: a new user message releases the pin and the pair re-folds.
    const nextTurn = [...messages, { role: 'user', content: [{ type: 'text', text: 'next turn' }] }];
    const released = projection(context, nextTurn);
    expect(isFolded(released[10])).toBe(true);
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
      content: [{ type: 'text', text: 'docs mention [truncated 100 of 200 chars; toolfold_read("call-0") returns the full text]' }],
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
    expect(projection(context, messages).some(isFolded)).toBe(true);
    (globalThis as Record<symbol, unknown>)[flag] = true;
    try {
      // Every tool is blocked on these turns, so the summary must not replace the result.
      expect(projection(context, messages).some(isFolded)).toBe(false);
    } finally {
      delete (globalThis as Record<symbol, unknown>)[flag];
    }
    expect(projection(context, messages).some(isFolded)).toBe(true);
  });

  it('keeps a pinned call verbatim while its parallel siblings stay folded', async () => {
    const { context, tool } = loadExtension();
    const trip: Message = {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'par-a', name: 'bash', arguments: { command: 'run a' } },
        { type: 'toolCall', id: 'par-b', name: 'bash', arguments: { command: 'run b' } },
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
        { type: 'toolCall', id: 'big', name: 'bash', arguments: { command: 'big' } },
        { type: 'toolCall', id: 'small', name: 'bash', arguments: { command: 'small' } },
      ],
    };
    const messages: Message[] = [
      parallel,
      result('big', 'bash', 'b'.repeat(2600)),
      result('small', 'bash', 's'.repeat(100)),
      call('other', 'bash', { command: 'other' }),
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
    const preview = 'body zzz…\n[truncated 20000 of 22009 chars; toolfold_read("giant-0") returns the full text]';
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

  it('evicts the least-recently-recovered pin when the pin budget is exceeded', async () => {
    const { context, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_PIN_BUDGET: '1' });
    const messages = pairs(40);
    projection(context, messages);
    await tool.execute('t1', { call_id: 'call-2' });
    await tool.execute('t2', { call_id: 'call-6' }); // budget 1 char -> evicts call-2
    const view = projection(context, messages);
    expect(isFolded(view[4])).toBe(true); // call-2 re-folded: oldest recovery evicted
    expect(isFolded(view[12])).toBe(false); // call-6 still pinned
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
      { role: 'toolResult', toolCallId: 'g1', toolName: 'bash', content: [{ type: 'text', text: 'z'.repeat(2000) + '\n[truncated 58000 of 60000 chars; toolfold_read("g1") returns the full text]' }] } as unknown as { content: Block[] },
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
      { role: 'toolResult', toolCallId: 'giant-arg', toolName: 'bash', content: [{ type: 'text', text: 'q'.repeat(2000) + '\n[truncated 23000 of 25000 chars; toolfold_read("giant-arg") returns the full text]' }] });
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
    expect(kept).toContain('toolfold_read("giant-1")');
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
    expect(isFolded(out[0])).toBe(true);
  });

  it('counts parallel calls, not messages, toward the pairs gate', () => {
    const { context } = loadExtension({ CINDY_PI_TOOL_FOLD_MIN_PAIRS: '32', CINDY_PI_TOOL_FOLD_MIN_CHARS: '1000000000', CINDY_PI_TOOL_FOLD_KEEP: '1' });
    // One assistant message with 32 parallel calls: 32 complete pairs in one trip.
    const blocks = Array.from({ length: 32 }, (_, i) => ({ type: 'toolCall', id: `par-${i}`, name: 'bash', arguments: { command: `parallel step ${i}` } }));
    const results = blocks.map((b, i) => result(String(b.id), 'bash', `parallel ${i} ok ${'z'.repeat(120)}`));
    // A newer trailing pair keeps the 32-call trip outside the KEEP=1 resident window.
    const messages: Message[] = [
      { role: 'assistant', content: blocks as Block[] },
      ...results,
      call('tail-1', 'bash', { command: 'tail probe' }),
      result('tail-1', 'bash', 'tail ok'),
    ];
    const out = projection(context, messages);
    expect(isFolded(out[0])).toBe(true);
    expect(out[1]).not.toBe(messages[1]); // result folded to a one-liner
  });

  it('keeps live fold marks when the registry cap is pruned', () => {
    // MAX_FOLDED min is 100: the probe must produce more than 100 live marks before the
    // prune branch runs, otherwise the test cannot distinguish prune from wipe.
    const { context } = loadExtension({ CINDY_PI_TOOL_FOLD_MIN_PAIRS: '512', CINDY_PI_TOOL_FOLD_MIN_CHARS: '240000', CINDY_PI_TOOL_FOLD_KEEP: '1', CINDY_PI_TOOL_FOLD_MAX_FOLDED: '100' });
    // First pass: one large batch folds 120 pairs -> registry 120 > cap 100.
    const first = projection(context, pairs(120));
    expect(isFolded(first[0])).toBe(true);
    // Second pass doubles the backlog: the 120 new pairs form a new batch, the prune
    // path runs with 121 live marks against cap 100, and every old id stays live.
    const grown = pairs(240);
    const second = projection(context, grown);
    expect(isFolded(second[0])).toBe(true);   // old marks survive the prune: no full-text rebound
    expect(isFolded(second[100])).toBe(true); // mid-history marks survive too
    expect(isFolded(second[236])).toBe(true); // newly foldable backlog folds too
    expect(second[478]).toBe(grown[478]);     // newest 1 pair stays verbatim (KEEP=1)
  });

  it('rejects recovery of an evicted giant instead of serving the transcript preview', async () => {
    const { context, toolResult, tool } = loadExtension({ CINDY_PI_TOOL_FOLD_GIANTS: '8', CINDY_PI_TOOL_FOLD_KEEP: '1' });
    // 8 giants fill the registry; the 9th evicts giant-0 (oldest first).
    for (let i = 0; i < 9; i += 1) {
      toolResult({ toolName: 'bash', toolCallId: `giant-${i}`, content: [{ type: 'text', text: `payload ${i} ${'g'.repeat(25000)}` }] });
    }
    // The transcript keeps only the truncation preview, as pi would store it; the
    // tool_result hook passes it through (small enough), so build it inline.
    const previewText = 'payload 0 ' + 'g'.repeat(1800) + '\n[truncated 23000 of 25011 chars; toolfold_read("giant-0") returns the full text]';
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
