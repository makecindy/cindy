import { describe, expect, it } from 'vitest';

import {
  reconcileToolCallMarkup,
  reconcileSerializedToolCalls,
  SerializedToolCallEcho,
  type StructuredToolCall,
} from './tool-call-markup.js';

const BODY = 'const r = await tools.exec_command({ cmd: "ls" }); text(r.output);';
const EXEC = (body = BODY): StructuredToolCall[] => [{ name: 'exec', input: body }];
const TICK = String.fromCharCode(96);

function echo(body = BODY, close = '</function>'): string {
  return `<tool_call><function=exec>${body}${close}</tool_call>`;
}

describe('reconcileSerializedToolCalls', () => {
  it('requires distinct actual calls within one batch but can reconcile independent echoes', () => {
    const invoke = '<invoke name="read"><parameter name="path" string="true">a</parameter></invoke>';
    const batch = '<tool_calls>' + invoke + invoke + '</tool_calls>';
    const calls = [{ name: 'read', arguments: { path: 'a' } }];
    expect(reconcileToolCallMarkup(batch, calls)).toEqual({ text: batch, unexecuted: true });
    expect(reconcileToolCallMarkup(batch, [...calls, ...calls])).toEqual({ text: '', unexecuted: false });
    expect(reconcileToolCallMarkup(invoke + invoke, calls)).toEqual({ text: '', unexecuted: false });
  });
  it('removes a block whose name and freeform body match a structured call', () => {
    expect(reconcileSerializedToolCalls(echo(), EXEC())).toBe('');
  });

  it('keeps surrounding prose and removes only the echo', () => {
    expect(reconcileSerializedToolCalls(`done.${echo()}`, EXEC())).toBe('done.');
    expect(reconcileSerializedToolCalls(`done.\n${echo()}\n`, EXEC())).toBe('done.\n\n');
  });

  it('reads the MiMo variants: missing </function>, stray </parameter>, header newline', () => {
    expect(reconcileSerializedToolCalls(echo(BODY, ''), EXEC())).toBe('');
    expect(reconcileSerializedToolCalls(echo(BODY, '</parameter>'), EXEC())).toBe('');
    expect(
      reconcileSerializedToolCalls(`<tool_call><function=exec>\n${BODY}\n</function></tool_call>`, EXEC()),
    ).toBe('');
  });

  it('keeps a block whose body does not match, or whose name does not match', () => {
    expect(reconcileSerializedToolCalls(echo(), EXEC('other()'))).toBe(echo());
    expect(reconcileSerializedToolCalls(echo(), [{ name: 'shell', input: BODY }])).toBe(echo());
    expect(reconcileSerializedToolCalls(echo(), [{ name: 'exec' }])).toBe(echo());
  });

  it('leaves the markup byte-exact when there is no structured call', () => {
    expect(reconcileSerializedToolCalls(echo(), [])).toBe(echo());
  });

  it('removes a matching block and keeps an unrelated one', () => {
    const other = '<tool_call><function=exec>other()</tool_call>';
    expect(reconcileSerializedToolCalls(echo() + other, EXEC())).toBe(other);
  });

  it('does not touch text without the opener', () => {
    const text = 'a normal answer with `tool_call` in backticks';
    expect(reconcileSerializedToolCalls(text, EXEC())).toBe(text);
  });
});

describe('SerializedToolCallEcho', () => {
  // #6545: a prose mention must not release a later real call in the same delta.
  it.each([false, true])('rescans after a pseudo-opener (executed=%s)', executed => {
    const prose = 'Use <tool_call> to call tools. ';
    const input = prose + echo() + 'after';
    for (const chunks of [[input], [...input], [prose + '<tool_', input.slice(prose.length + 6)]]) {
      const guard = new SerializedToolCallEcho();
      const visible = chunks.map(chunk => guard.push(chunk)).join('');
      expect(visible).toBe(prose);
      const result = guard.resolveReport(executed ? EXEC() : [], true);
      expect(visible + result.text).toBe(prose + 'after');
      expect(result.unexecuted).toBe(!executed);
    }
  });

  it('releases repeated pseudo-openers verbatim when the bounded rescan is exhausted', () => {
    const input = 'Use <tool_call> to call tools. '.repeat(129) + echo();
    const guard = new SerializedToolCallEcho();
    expect(guard.push(input)).toBe(input);
    expect(guard.hasPending).toBe(false);
    expect(guard.resolveReport(EXEC(), true)).toEqual({ text: '', unexecuted: false });
  });
  it.each([
    ['inline', TICK + echo() + TICK],
    ['fence', TICK.repeat(3) + 'xml\n' + echo() + '\n' + TICK.repeat(3)],
    ['tilde fence', '~~~xml\n' + echo() + '\n~~~'],
    ['quote', '> ' + echo()],
    ['quote continuation', '> Example:\n' + echo()],
    ['indent', '    ' + echo()],
    ['escape', '\\' + echo()],
  ])('preserves %s examples across one-character deltas', (_kind, literal) => {
    const guard = new SerializedToolCallEcho();
    let visible = '';
    for (const char of literal + '\n\n' + echo()) visible += guard.push(char);
    visible += guard.resolve(EXEC());
    expect(visible).toBe(literal + '\n\n');
  });

  it.each(['<tool_call><function=' + 'x'.repeat(65537), '<tool_call>' + ' '.repeat(65537)])(
    'releases an oversized unfinished header', (text) => {
      const guard = new SerializedToolCallEcho();
      expect(guard.push(text)).toBe(text);
      expect(guard.isHolding).toBe(false);
      expect(guard.resolve(EXEC())).toBe('');
    },
  );

  it('streams ordinary text without holding it', () => {
    const echoGuard = new SerializedToolCallEcho();
    expect(echoGuard.push('hello ')).toBe('hello ');
    expect(echoGuard.push('world')).toBe('world');
    expect(echoGuard.resolve([])).toBe('');
  });

  it('holds the tail once a possible opener appears, then resolves it', () => {
    const echoGuard = new SerializedToolCallEcho();
    expect(echoGuard.push('done.')).toBe('done.');
    expect(echoGuard.push(echo())).toBe('');
    expect(echoGuard.isHolding).toBe(true);
    expect(echoGuard.resolve(EXEC())).toBe('');
  });

  it('recognizes an opener split across deltas', () => {
    const echoGuard = new SerializedToolCallEcho();
    expect(echoGuard.push('done.<tool_')).toBe('done.');
    expect(echoGuard.push('call><function=exec>')).toBe('');
    expect(echoGuard.push(`${BODY}</tool_call>`)).toBe('');
    expect(echoGuard.resolve(EXEC())).toBe('');
  });

  it('recognizes a closing tag split across deltas', () => {
    const echoGuard = new SerializedToolCallEcho();
    expect(echoGuard.push(`<tool_call><function=exec>${BODY}</tool_`)).toBe('');
    expect(echoGuard.push('call>')).toBe('');
    expect(echoGuard.resolve(EXEC())).toBe('');
  });

  it('releases a quoted opener and still catches a later echo', () => {
    const echoGuard = new SerializedToolCallEcho();
    const quoted = 'Use <tool_call> to call tools. ';
    expect(echoGuard.push(quoted)).toBe(quoted);
    expect(echoGuard.push(echo())).toBe('');
    expect(echoGuard.resolve(EXEC())).toBe('');
  });

  it('releases the block unchanged when no structured call matches', () => {
    const echoGuard = new SerializedToolCallEcho();
    expect(echoGuard.push(`done.${echo()}`)).toBe('done.');
    expect(echoGuard.resolve([{ name: 'exec', input: 'other()' }])).toBe(echo());
  });

  it('releases a closed block once enough trailing prose follows', () => {
    const echoGuard = new SerializedToolCallEcho();
    const trailing = 'x'.repeat(8 * 1024 + 1);
    const out = echoGuard.push(`${echo()}${trailing}`);
    expect(out).toBe(`${echo()}${trailing}`);
    expect(echoGuard.resolve(EXEC())).toBe('');
  });

  it('drains held text unchanged for a failed turn', () => {
    const echoGuard = new SerializedToolCallEcho();
    expect(echoGuard.push(`done.${echo()}`)).toBe('done.');
    expect(echoGuard.drain()).toBe(echo());
    expect(echoGuard.resolve(EXEC())).toBe('');
  });
});

// #6531 unit: each real model grammar is reconciled against typed structured arguments.
// Existing MiMo freeform tests did not protect DSML, CodeBuddy, Hermes or GLM.
describe('grammar registry', () => {
  const args = { command: 'echo ok' };
  const calls = [{ name: 'shell', arguments: args }];
  const variants = [
    '<tool_call><function=shell><parameter name="command">echo ok</parameter></function></tool_call>',
    '<｜DSML｜tool_calls><｜DSML｜invoke name="shell"><｜DSML｜parameter name="command" string="true">echo ok</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>',
    '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="shell"><｜｜DSML｜｜ parameter name="command">echo ok</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>',
    '<tool_call>{"name":"shell","arguments":{"command":"echo ok"}}</tool_call>',
    '<tool_call>shell<arg_key>command</arg_key><arg_value>echo ok</arg_value></tool_call>',
    '<tool_call>shell<arg_key>command<arg_value>echo ok</tool_call>',
  ];
  it.each(variants)('removes only a matching call: %s', markup => {
    expect(reconcileSerializedToolCalls('before.' + markup + '.after', calls)).toBe('before..after');
    expect(reconcileSerializedToolCalls(markup, [{ name: 'shell', arguments: { command: 'other' } }])).toBe(markup);
    const guard = new SerializedToolCallEcho();
    let text = '';
    for (const char of markup) text += guard.push(char);
    const result = guard.resolveReport([], true);
    expect(text + result.text).toBe('');
    expect(result.unexecuted).toBe(true);
  });
});
