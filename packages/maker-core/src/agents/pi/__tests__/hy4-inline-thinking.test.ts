import { describe, expect, it } from 'vitest';
import { createPiTranslateContext, disposePiTranslateContext, translatePiEvent } from '../translator.js';
import { activePiHistoryFromTree } from '../session-tree.js';
import type { AgentEvent } from '../../../types/events.js';
import type { AsyncQueue } from '../../shared/async-queue.js';
import type { PiRpcEvent } from '../rpc-client.js';
import type { Logger } from '../../../interfaces/logger.js';

const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } } as Logger;
const marker = '</think:6124c78e>';
const thought = 'Check the window drag region first.';
const answer = '再开一个任务。';

function harness(model = 'tencent/hy4') {
  const ctx = createPiTranslateContext(logger);
  const events: AgentEvent[] = [];
  const queue = { push(event: AgentEvent) { events.push(event); } } as AsyncQueue<AgentEvent>;
  const send = (event: Record<string, unknown>) => translatePiEvent(event as PiRpcEvent, queue, ctx);
  const start = () => send({ type: 'message_start', message: { role: 'assistant', model } });
  const delta = (text: string, contentIndex = 0) => send({ type: 'message_update', assistantMessageEvent: {
    type: 'text_delta', contentIndex, delta: text, partial: { role: 'assistant', model },
  } });
  const end = (text: string, stopReason = 'stop') => send({ type: 'message_end', message: {
    role: 'assistant', model, stopReason, content: [{ type: 'text', text }],
  } });
  const texts = () => events.filter(e => e.type === 'text').map(e => e.data as { text: string; isFinal: boolean });
  const thoughts = () => events.filter(e => e.type === 'thinking').map(e => e.data as { stage: string; text?: string; blockId: string });
  return { ctx, events, send, start, delta, end, texts, thoughts };
}

describe('HY4 inline reasoning through Pi production adapters', () => {
  it.each(Array.from({ length: marker.length + 1 }, (_, i) => i))('holds split salted terminators at offset %i before publishing any text', offset => {
    const h = harness();
    h.start();
    h.delta(thought + marker.slice(0, offset));
    expect(h.texts()).toEqual([]);
    h.delta(marker.slice(offset) + answer);
    h.delta('完成。');
    h.end(thought + marker + answer + '完成。');
    expect(h.texts().filter(e => !e.isFinal).map(e => e.text).join('')).toBe(answer + '完成。');
    expect(h.texts().at(-1)?.text).toBe(answer + '完成。');
    expect(h.thoughts().filter(e => e.stage === 'final').map(e => e.text)).toEqual([thought]);
    disposePiTranslateContext(h.ctx);
  });

  it.each(['hy4', 'tencent/hy4', 'tencent/hy4-preview'])('normalizes final-only %s output and the settled result', model => {
    const h = harness(model);
    h.end(thought + marker + answer);
    h.send({ type: 'agent_settled' });
    expect(h.texts().at(-1)?.text).toBe(answer);
    expect(h.thoughts().find(e => e.stage === 'final')?.text).toBe(thought);
    expect(h.events.find(e => e.type === 'done')?.data).toMatchObject({ result: answer });
    disposePiTranslateContext(h.ctx);
  });

  it('keeps reasoning-only tool rounds out of text and resets before the next assistant message', () => {
    const h = harness();
    h.start(); h.delta(thought + marker); h.end(thought + marker, 'toolUse');
    expect(h.texts()).toEqual([]);
    h.start(); h.delta(answer); h.end(answer);
    expect(h.texts().at(-1)?.text).toBe(answer);
    expect(h.thoughts().filter(e => e.stage === 'final')).toHaveLength(1);
    disposePiTranslateContext(h.ctx);
  });

  it.each(['deepseek/deepseek-v4.1-flash', 'tencent/hy3', 'other/hy4'])('leaves other model text unchanged (%s)', model => {
    const h = harness(model);
    const literal = thought + marker + answer;
    h.start(); h.delta(literal); h.end(literal);
    expect(h.texts().map(e => e.text)).toEqual([literal, literal]);
    expect(h.thoughts()).toEqual([]);
    disposePiTranslateContext(h.ctx);
  });

  it.each([answer, 'Literal `<think>` syntax.', 'unfinished </think:6124', '```xml\n</think:6124c78e>\n```', '示例：`</think:6124c78e>`，不要删除。', '示例：\n```xml\n</think:6124c78e>\n```', 'x ``sample ` </think:6124c78e>`` y'])('preserves HY4 text without a protocol boundary: %s', text => {
    const h = harness();
    h.start(); h.delta(text); h.end(text);
    expect(h.texts().at(-1)?.text).toBe(text);
    expect(h.thoughts()).toEqual([]);
    disposePiTranslateContext(h.ctx);
  });

  it.each(['<think>private</think>public', '<think:1234abcd>private</think:1234abcd>public'])('handles explicit leading thinking tags: %s', text => {
    const h = harness();
    h.start();
    for (const char of text) h.delta(char);
    h.end(text);
    expect(h.texts().filter(e => !e.isFinal).map(e => e.text).join('')).toBe('public');
    expect(h.texts().at(-1)?.text).toBe('public');
    expect(h.thoughts().find(e => e.stage === 'final')?.text).toBe('private');
    disposePiTranslateContext(h.ctx);
  });

  it.each(['length', 'aborted', 'error'])('retains explicitly opened reasoning as thinking if interrupted (%s)', stopReason => {
    const h = harness();
    h.start(); h.delta('<think:1234abcd>' + thought);
    expect(h.texts()).toEqual([]);
    h.end('<think:1234abcd>' + thought, stopReason);
    expect(h.texts()).toEqual([]);
    expect(h.thoughts().find(e => e.stage === 'final')?.text).toBe(thought);
    disposePiTranslateContext(h.ctx);
  });

  it('uses the model attached to partial RPC messages when start omitted it', () => {
    const h = harness();
    h.send({ type: 'message_start', message: { role: 'assistant' } });
    h.delta(thought + marker + answer);
    h.end(thought + marker + answer);
    expect(h.texts().every(e => e.text === answer)).toBe(true);
    expect(h.thoughts().filter(e => e.stage === 'final')).toHaveLength(1);
    disposePiTranslateContext(h.ctx);
  });

  it('isolates text indexes and preserves native thinking and tool calls', () => {
    const h = harness();
    h.start();
    h.send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } });
    h.send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'native' } });
    h.delta(thought + marker + answer, 1);
    h.delta('More thought</think:87654321>More answer', 3);
    h.send({ type: 'message_end', message: { role: 'assistant', model: 'tencent/hy4', stopReason: 'toolUse', content: [
      { type: 'thinking', thinking: 'native' },
      { type: 'text', text: thought + marker + answer },
      { type: 'toolCall', id: 'chatcmpl-tool-test', name: 'read', arguments: {} },
      { type: 'text', text: 'More thought</think:87654321>More answer' },
    ] } });
    expect(h.texts().at(-1)?.text).toBe(answer + '\n\nMore answer');
    expect(h.thoughts().filter(e => e.stage === 'final').map(e => e.text)).toEqual(['native', thought, 'More thought']);
    const ids = h.thoughts().filter(e => e.stage === 'final').map(e => e.blockId);
    expect(new Set(ids).size).toBe(3);
    disposePiTranslateContext(h.ctx);
  });

  it('restores reasoning and answer separately from raw Pi history while retaining tools', () => {
    const data = { leafId: 'a', tree: [{ entry: { type: 'message', id: 'a', timestamp: '2026-11-09T07:50:00Z', message: {
      role: 'assistant', model: 'tencent/hy4', stopReason: 'toolUse', content: [
        { type: 'text', text: thought + marker + answer },
        { type: 'toolCall', id: 'chatcmpl-tool-demo', name: 'read', arguments: { path: 'sample.ts' } },
      ],
    } }, children: [] }] };
    const rows = activePiHistoryFromTree(data);
    expect(rows.map(r => r.role)).toEqual(['thinking', 'assistant', 'tool_use']);
    expect(rows[0].content).toMatchObject({ text: thought, kind: 'thinking' });
    expect(rows[1].content).toBe(answer);
    expect(rows[2].toolUseId).toBe('chatcmpl-tool-demo');
    expect(activePiHistoryFromTree(data)).toEqual(rows);
  });

  it('does not guess that independent tool-round text is reasoning based on its language', () => {
    // Sanitized shape of the real HY4 acceptance response (a6931b27).
    // This must be corrected at generation, not by hiding arbitrary English text.
    const narration = "I'll start by discovering the GitHub MCP tools available, then verify connectivity as required.";
    const message = {
      role: 'assistant', model: 'tencent/hy4', stopReason: 'toolUse',
      content: [
        { type: 'thinking', thinking: '用户想查找 HY4 修复的 PR。', thinkingSignature: 'reasoning_content' },
        { type: 'text', text: narration },
        { type: 'toolCall', id: 'chatcmpl-tool-example', name: 'cindy_mcp_list_tools', arguments: { limit: 50 } },
      ],
    };
    const h = harness();
    h.start();
    h.send({ type: 'message_end', message });
    expect(h.texts().at(-1)?.text).toBe(narration);
    const rows = activePiHistoryFromTree({ leafId: 'real-hy4-shape', tree: [{ entry: {
      type: 'message', id: 'real-hy4-shape', timestamp: '2026-11-09T10:20:54.925Z', message,
    }, children: [] }] });
    expect(rows.map(row => row.role)).toEqual(['thinking', 'assistant', 'tool_use']);
    expect(rows[1].content).toBe(narration);
    expect(rows[2].toolUseId).toBe('chatcmpl-tool-example');
    disposePiTranslateContext(h.ctx);
  });

  it.each([
    '示例：\n```js\nconst fence = "```";\nconst token = "</think:6124c78e>";\n```',
    '示例：\n~~~js\nconst fence = "~~~";\nconst token = "</think:6124c78e>";\n~~~~',
    '示例：\n```js\nconst fence = "```";\nconst token = "</think:6124c78e>";',
    '示例：\n```xml\n</think:6124c78e>\n````\n结束。',
    '> ```js\n> const fence = "```";\n> const token = "</think:6124c78e>";\n> ```',
    '- ```js\n  const fence = "```";\n  const token = "</think:6124c78e>";\n  ```',
    '示例：\n\n    const token = "</think:6124c78e>";\n\n请保留以上代码。',
    '示例：\n\n\tconst token = "</think:6124c78e>";',
    '示例：\n\n \tconst token = "</think:6124c78e>";',
    '> 示例：\n>\n>     const token = "</think:6124c78e>";',
    '-     const token = "</think:6124c78e>";',
    '- 一级\n  - 二级\n\n    ```js\n    const fence = "```";\n    const token = "</think:6124c78e>";\n    ```',
    '    <think>literal</think:6124c78e>',
    '\t<think:6124c78e>literal</think:6124c78e>',
    '- > ```js\n  > const fence = "```";\n  > const token = "</think:6124c78e>";\n  > ```',
    '> - > ```js\n>   > const fence = "```";\n>   > const token = "</think:6124c78e>";\n>   > ```',
    '- > - ```js\n  >   const fence = "```";\n  >   const token = "</think:6124c78e>";\n  >   ```',
    '1. > 1. ```js\n   >    const fence = "```";\n   >    const token = "</think:6124c78e>";\n   >    ```',
    '-\t```js\n\tconst fence = "```";\n\tconst token = "</think:6124c78e>";\n\t```',
    '  ```xml\n    ```\n</think:6124c78e>\n  ```',
    '\\```literal </think:6124c78e>``',
    'unmatched `\n```js\nconst fence = "`";\nconst token = "</think:6124c78e>";\n```',
    'unmatched `\n\n    const token = "</think:6124c78e>";',
    '- 未闭合的反引号：`\n- 示例：`</think:6124c78e>`',
    '1. 未闭合的反引号：`\n2. 示例：`</think:6124c78e>`',
    '> - 未闭合的反引号：`\n> - 示例：`</think:6124c78e>`',
    '- > 未闭合的反引号：`\n- > 示例：`</think:6124c78e>`',
    '| 标题 |\n| --- |\n| 未闭合：` |\n| 示例：`</think:6124c78e>` |',
  ])('keeps literal tags inside Markdown code in live, final and history projection: %s', text => {
    const h = harness();
    h.start();
    for (const char of text) h.delta(char);
    h.end(text);
    expect(h.texts().at(-1)?.text).toBe(text);
    expect(h.thoughts()).toEqual([]);
    const rows = activePiHistoryFromTree({ leafId: 'code', tree: [{ entry: {
      type: 'message', id: 'code', message: {
        role: 'assistant', model: 'tencent/hy4', content: [{ type: 'text', text }],
      },
    }, children: [] }] });
    expect(rows.map(row => row.role)).toEqual(['assistant']);
    expect(rows[0].content).toBe(text);
    disposePiTranslateContext(h.ctx);
  });

  it('recognizes a real boundary after a fenced example containing a literal boundary', () => {
    const reasoning = '检查代码：\n```js\nconst fence = "```";\nconst token = "</think:6124c78e>";\n```\n';
    const h = harness();
    h.start();
    for (const char of reasoning + marker + answer) h.delta(char);
    h.end(reasoning + marker + answer);
    expect(h.texts().at(-1)?.text).toBe(answer);
    expect(h.thoughts().filter(e => e.stage === 'final').map(e => e.text)).toEqual([reasoning]);
    disposePiTranslateContext(h.ctx);
  });

  it('recognizes a real boundary after indented code containing a literal boundary', () => {
    const reasoning = '检查代码：\n\n    const token = "</think:6124c78e>";\n\n';
    const h = harness();
    h.start();
    for (const char of reasoning + marker + answer) h.delta(char);
    h.end(reasoning + marker + answer);
    expect(h.texts().at(-1)?.text).toBe(answer);
    expect(h.thoughts().filter(e => e.stage === 'final').map(e => e.text)).toEqual([reasoning]);
    disposePiTranslateContext(h.ctx);
  });

  describe.each([
    ['<think>', '</think>'],
    ['<think:6124c78e>', marker],
  ])('explicit opener %s protects the same code boundaries as implicit reasoning', (opener, closer) => {
    it.each([
      '```xml\nTOKEN\n```',
      '    const token = "TOKEN";',
      '`TOKEN`',
      '- > ```xml\n  > TOKEN\n  > ```',
      '> - > ```xml\n>   > TOKEN\n>   > ```',
      '-\t```xml\n\tTOKEN\n\t```',
      '- 草稿：`\n- 示例：`TOKEN` 后面仍是私有分析。',
      '| 标题 |\n| --- |\n| 草稿：` |\n| 示例：`TOKEN` |',
    ])('does not release private analysis at a code-contained closer: %s', code => {
      const reasoning = '检查示例：\n\n' + code.replace('TOKEN', closer) + '\n\n这里仍是私有分析。\n';
      const h = harness();
      h.start();
      for (const char of opener + reasoning) h.delta(char);
      expect(h.texts()).toEqual([]);
      h.delta(closer + answer);
      h.end(opener + reasoning + closer + answer);
      h.send({ type: 'agent_settled' });
      expect(h.texts().at(-1)?.text).toBe(answer);
      expect(h.thoughts().filter(e => e.stage === 'final').map(e => e.text)).toEqual([reasoning]);
      expect(h.events.find(e => e.type === 'done')?.data).toMatchObject({ result: answer });
      const rows = activePiHistoryFromTree({ leafId: 'explicit', tree: [{ entry: {
        type: 'message', id: 'explicit', message: {
          role: 'assistant', model: 'tencent/hy4', content: [{ type: 'text', text: opener + reasoning + closer + answer }],
        },
      }, children: [] }] });
      expect(rows.map(row => row.role)).toEqual(['thinking', 'assistant']);
      expect(rows[0].content).toMatchObject({ text: reasoning });
      expect(rows[1].content).toBe(answer);
      disposePiTranslateContext(h.ctx);
    });

    it.each(['aborted', 'length', 'error'].flatMap(stopReason => ['fence', 'list'].map(form => [stopReason, form])))('keeps analysis private when only a code-contained closer arrived (%s / %s)', (stopReason, form) => {
      const reasoning = form === 'fence'
        ? '检查示例：\n```xml\n' + closer + '\n```\n这里仍是私有分析。'
        : '- 草稿：`\n- 示例：`' + closer + '` 后面仍是私有分析。';
      const h = harness();
      h.start();
      h.delta(opener + reasoning);
      h.end(opener + reasoning, stopReason);
      expect(h.texts()).toEqual([]);
      expect(h.thoughts().filter(e => e.stage === 'final').map(e => e.text)).toEqual([reasoning]);
      disposePiTranslateContext(h.ctx);
    });
  });

  it.each(['', '<think>', '<think:6124c78e>'])('does not let an unmatched inline run hide a real final boundary (%s)', opener => {
    const closer = opener === '<think>' ? '</think>' : marker;
    const reasoning = '这里仍是私有的 `unfinished draft';
    const h = harness();
    h.start();
    h.delta(opener + reasoning + closer + answer);
    expect(h.texts()).toEqual([]);
    h.end(opener + reasoning + closer + answer);
    expect(h.texts().at(-1)?.text).toBe(answer);
    expect(h.thoughts().filter(e => e.stage === 'final').map(e => e.text)).toEqual([reasoning]);
    disposePiTranslateContext(h.ctx);
  });

  it('keeps raw UTF-16 offsets when tabs and non-BMP characters precede a boundary', () => {
    const reasoning = '😀检查\t文件后给出结论。';
    const h = harness();
    h.start(); h.delta(reasoning + marker + answer); h.end(reasoning + marker + answer);
    expect(h.texts().at(-1)?.text).toBe(answer);
    expect(h.thoughts().filter(e => e.stage === 'final').map(e => e.text)).toEqual([reasoning]);
    disposePiTranslateContext(h.ctx);
  });
});
