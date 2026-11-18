import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { createCodexResponsesCompatibilityAdapter, normalizeProviderRequest, prepareResponsesCompatibility, resolveProviderCompatibilityProfile, sanitizeXaiTools, hasCacheOnlySearchProhibition } from '../index';

async function responseText(transform: NodeJS.ReadWriteStream, text: string) {
  const output: Buffer[] = [];
  const done = new Promise<string>((resolve, reject) => {
    transform.on('data', chunk => output.push(Buffer.from(chunk)));
    transform.on('error', reject);
    transform.on('end', () => resolve(Buffer.concat(output).toString()));
  });
  Readable.from([...Buffer.from(text)].map(byte => Buffer.from([byte]))).pipe(transform);
  return done;
}

describe('request-owned Responses compatibility', () => {
  // #10085 / PR10091 remaining selector findings: real adapter JSON/SSE paths, unit tier.
  // Prior cases never selected a collision by its original kind or repaired native namespaces.
  it.each(['application/json', 'text/event-stream'])('keeps collision selectors on their original tool kind (%s)', async contentType => {
    for (const childKind of ['custom', 'function']) {
      for (const allowed of [false, true]) {
        const bareKind = childKind === 'custom' ? 'function' : 'custom';
        const selector = { type: childKind, name: 'workspace__read' };
        const input = { tools: [
          { type: bareKind, name: 'workspace__read', parameters: {} },
          { type: 'namespace', name: 'workspace', tools: [{ type: childKind, name: 'read', parameters: {} }] },
        ], tool_choice: allowed ? { type: 'allowed_tools', tools: [selector] } : selector };
        const adapter = createCodexResponsesCompatibilityAdapter();
        const request = adapter.adaptRequest(input, 10085, undefined, true) as typeof input;
        expect(request.tool_choice).toEqual(allowed
          ? { type: 'allowed_tools', tools: [{ type: 'function', name: 'workspace__read_2' }] }
          : { type: 'function', name: 'workspace__read_2' });
        const output = { output: [{ type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'workspace__read_2', arguments: childKind === 'custom' ? '{"input":"child"}' : '{}' }] };
        const sse = contentType === 'text/event-stream';
        const wire = sse ? `data: ${JSON.stringify({ type: 'response.completed', response: output })}\n\n` : JSON.stringify(output);
        const text = await responseText(adapter.createResponseTransform(10085, { contentType, contentEncoding: '' })!, wire);
        const parsed = JSON.parse(sse ? text.trim().slice(6) : text);
        expect((sse ? parsed.response : parsed).output[0]).toMatchObject({
          namespace: 'workspace', name: 'read', type: childKind === 'custom' ? 'custom_tool_call' : 'function_call',
        });
      }
    }
  });

  it.each(['application/json', 'text/event-stream'])('repairs native namespace calls with an unqualified selector (%s)', async contentType => {
    const adapter = createCodexResponsesCompatibilityAdapter();
    const input = { tools: [{ type: 'namespace', name: 'workspace', tools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: { line: { type: 'integer' } } } }] }], tool_choice: { type: 'function', name: 'read' } };
    adapter.adaptRequest(input, 10086);
    const output = { status: 'completed', output: [{ type: 'function_call', namespace: 'workspace', name: 'read', call_id: 'native', arguments: '{"line":12.0}' }] };
    const sse = contentType === 'text/event-stream';
    const wire = sse ? `data: ${JSON.stringify({ type: 'response.completed', response: output })}\n\n` : JSON.stringify(output);
    const transform = adapter.createResponseTransform(10086, { contentType, contentEncoding: '' });
    expect(transform).not.toBeNull();
    const text = await responseText(transform!, wire);
    const parsed = JSON.parse(sse ? text.trim().slice(6) : text);
    expect((sse ? parsed.response : parsed).output[0]).toMatchObject({ namespace: 'workspace', name: 'read', arguments: '{"line":12}' });
  });

  // #11199 reserved-functions regressions (unit): real Codex adapter, not a catalog mock.
  // Earlier bare/namespace cases declared the bare tool at top level and omitted default namespace.
  it.each(['application/json', 'text/event-stream'])('keeps grouped bare tools when a namespace child collides (%s)', async contentType => {
    for (const [bareKind, childKind] of [['function', 'function'], ['function', 'custom'], ['custom', 'function']]) {
      for (const reverse of [false, true]) {
        const tools = [
          { type: 'namespace', name: 'functions', tools: [{ type: bareKind, name: 'workspace__read', parameters: {} }] },
          { type: 'namespace', name: 'workspace', tools: [{ type: childKind, name: 'read', parameters: {} }] },
        ];
        if (reverse) tools.reverse();
        // Flat selection of an opposite-kind child must use its kind before lowering.
        if (bareKind !== childKind) {
          for (const allowed of [false, true]) {
            const selected = createCodexResponsesCompatibilityAdapter();
            const selector = { type: childKind, name: 'workspace__read' };
            const request = selected.adaptRequest({ tools, tool_choice: allowed ? { type: 'allowed_tools', tools: [selector] } : selector }, 10091, undefined, true) as { tool_choice: unknown };
            expect(request.tool_choice).toEqual(allowed
              ? { type: 'allowed_tools', tools: [{ type: 'function', name: 'workspace__read_2' }] }
              : { type: 'function', name: 'workspace__read_2' });
            selected.releaseResponse(10091);
          }
        }
        const adapter = createCodexResponsesCompatibilityAdapter();
        const request = adapter.adaptRequest({ tools }, 10089, undefined, true) as { tools: { name: string }[] };
        expect(request.tools.map(tool => tool.name).sort()).toEqual(['workspace__read', 'workspace__read_2']);
        const output = { status: 'completed', output: [
          { type: 'function_call', name: 'workspace__read', call_id: 'bare', arguments: bareKind === 'custom' ? '{"input":"bare"}' : '{}' },
          { type: 'function_call', name: 'workspace__read_2', call_id: 'child', arguments: childKind === 'custom' ? '{"input":"child"}' : '{}' },
        ] };
        const sse = contentType === 'text/event-stream';
        const wire = sse ? `data: ${JSON.stringify({ type: 'response.completed', response: output })}\n\n` : JSON.stringify(output);
        const text = await responseText(adapter.createResponseTransform(10089, { contentType, contentEncoding: '' })!, wire);
        const parsed = JSON.parse(sse ? text.trim().slice(6) : text);
        expect((sse ? parsed.response : parsed).output).toMatchObject([
          { name: 'workspace__read', type: bareKind === 'custom' ? 'custom_tool_call' : 'function_call' },
          { namespace: 'workspace', name: 'read', type: childKind === 'custom' ? 'custom_tool_call' : 'function_call' },
        ]);
      }
    }
  });

  // The canonical top-level declaration wins over a stale functions-group duplicate (#11199).
  it.each(['application/json', 'text/event-stream'])('keeps the canonical bare kind over grouped duplicates (%s)', async contentType => {
    for (const reverse of [false, true]) {
      for (const allowed of [undefined, false, true]) {
        const tools = [
          { type: 'function', name: 'workspace__read', parameters: {} },
          { type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'workspace__read' }] },
          { type: 'namespace', name: 'workspace', tools: [{ type: 'custom', name: 'read' }] },
        ];
        if (reverse) tools.reverse();
        const selector = { type: 'custom', name: 'workspace__read' };
        const input = { tools, ...(allowed === undefined ? {} : { tool_choice: allowed ? { type: 'allowed_tools', tools: [selector] } : selector }) };
        const adapter = createCodexResponsesCompatibilityAdapter();
        const request = adapter.adaptRequest(input, 10092, undefined, true) as { tools: { name: string }[]; tool_choice?: unknown };
        expect(request.tools.map(tool => tool.name).sort()).toEqual(['workspace__read', 'workspace__read_2']);
        if (allowed !== undefined) expect(request.tool_choice).toEqual(allowed
          ? { type: 'allowed_tools', tools: [{ type: 'function', name: 'workspace__read_2' }] }
          : { type: 'function', name: 'workspace__read_2' });
        const output = { status: 'completed', output: [
          { type: 'function_call', name: 'workspace__read', call_id: 'bare', arguments: '{}' },
          { type: 'function_call', name: 'workspace__read_2', call_id: 'child', arguments: '{"input":"child"}' },
        ] };
        const sse = contentType === 'text/event-stream';
        const wire = sse ? `data: ${JSON.stringify({ type: 'response.completed', response: output })}\n\n` : JSON.stringify(output);
        const text = await responseText(adapter.createResponseTransform(10092, { contentType, contentEncoding: '' })!, wire);
        const parsed = JSON.parse(sse ? text.trim().slice(6) : text);
        expect((sse ? parsed.response : parsed).output).toMatchObject([
          { type: 'function_call', name: 'workspace__read' },
          { type: 'custom_tool_call', namespace: 'workspace', name: 'read' },
        ]);
      }
    }
  });

  // Canonical bare schema must match the declaration actually forwarded, not a grouped duplicate.
  // #11199 review: kind restoration tests had empty schemas and missed Codex's integer rejection.
  it.each(['application/json', 'text/event-stream'])('repairs the canonical bare schema over grouped duplicates (%s)', async contentType => {
    for (const duplicateKind of ['function', 'custom']) {
      for (const lowerNamespaces of [false, true]) {
        for (const reverse of [false, true]) {
          const tools = [
            { type: 'function', name: 'workspace__read', parameters: { type: 'object', properties: { line: { type: 'integer' } } } },
            { type: 'namespace', name: 'functions', tools: [{ type: duplicateKind, name: 'workspace__read', parameters: { type: 'object', properties: { line: { type: 'number' } } } }] },
            { type: 'namespace', name: 'workspace', tools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: { line: { type: 'number' } } } }] },
          ];
          if (reverse) tools.reverse();
          const adapter = createCodexResponsesCompatibilityAdapter();
          adapter.adaptRequest({ tools }, 10094, undefined, lowerNamespaces);
          const bare = { type: 'function_call', namespace: 'functions', name: 'workspace__read', call_id: 'bare', arguments: '{"line":12.0}' };
          const child = { type: 'function_call', ...(lowerNamespaces ? { name: 'workspace__read_2' } : { namespace: 'workspace', name: 'read' }), call_id: 'child', arguments: '{"line":12.0}' };
          const output = { status: 'completed', output: [bare, child] };
          const sse = contentType === 'text/event-stream';
          const wire = sse ? `data: ${JSON.stringify({ type: 'response.completed', response: output })}\n\n` : JSON.stringify(output);
          const transform = adapter.createResponseTransform(10094, { contentType, contentEncoding: '' });
          expect(transform).not.toBeNull();
          const text = await responseText(transform!, wire);
          const parsed = JSON.parse(sse ? text.trim().slice(6) : text);
          expect((sse ? parsed.response : parsed).output).toMatchObject([
            { type: 'function_call', name: 'workspace__read', arguments: '{"line":12}' },
            { type: 'function_call', namespace: 'workspace', name: 'read', arguments: '{"line":12.0}' },
          ]);
          // Two canonical top-level schemas that disagree remain ambiguous; never pick one.
          const conflict = createCodexResponsesCompatibilityAdapter();
          conflict.adaptRequest({ tools: [...tools, { type: 'function', name: 'workspace__read', parameters: { type: 'object', properties: { line: { type: 'number' } } } }] }, 10095, undefined, lowerNamespaces);
          const unchanged = await responseText(conflict.createResponseTransform(10095, { contentType, contentEncoding: '' })!, wire);
          const conflictingResult = JSON.parse(sse ? unchanged.trim().slice(6) : unchanged);
          expect((sse ? conflictingResult.response : conflictingResult).output[0].arguments).toBe('{"line":12.0}');
        }
      }
    }
  });

  it.each(['application/json', 'text/event-stream'])('restores default functions custom calls as bare tools (%s)', async contentType => {
    const adapter = createCodexResponsesCompatibilityAdapter();
    adapter.adaptRequest({ tools: [
      { type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'workspace__read' }] },
      { type: 'namespace', name: 'workspace', tools: [{ type: 'function', name: 'read', parameters: {} }] },
    ] }, 10093, undefined, true);
    const output = { status: 'completed', output: [{ type: 'function_call', namespace: 'functions', name: 'workspace__read', call_id: 'bare', arguments: '{"input":"bare"}' }] };
    const sse = contentType === 'text/event-stream';
    const wire = sse ? `data: ${JSON.stringify({ type: 'response.completed', response: output })}\n\n` : JSON.stringify(output);
    const text = await responseText(adapter.createResponseTransform(10093, { contentType, contentEncoding: '' })!, wire);
    const parsed = JSON.parse(sse ? text.trim().slice(6) : text);
    expect((sse ? parsed.response : parsed).output[0]).toMatchObject({ type: 'custom_tool_call', name: 'workspace__read', input: 'bare' });
  });

  it.each(['application/json', 'text/event-stream'])('repairs default functions calls without using the displaced child schema (%s)', async contentType => {
    for (const choice of [undefined, { type: 'function', namespace: 'functions', name: 'workspace__read' }]) {
      const adapter = createCodexResponsesCompatibilityAdapter();
      adapter.adaptRequest({ tools: [
        { type: 'function', name: 'workspace__read', parameters: { type: 'object', properties: { line: { type: 'integer' } } } },
        { type: 'namespace', name: 'workspace', tools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: { line: { type: 'number' } } } }] },
      ], ...(choice ? { tool_choice: choice } : {}) }, 10090);
      const bare = { type: 'function_call', namespace: 'functions', name: 'workspace__read', call_id: 'bare', arguments: '{"line":12.0}' };
      const child = { type: 'function_call', namespace: 'workspace', name: 'read', call_id: 'child', arguments: '{"line":12.0}' };
      const output = { status: 'completed', output: [bare, child] };
      const sse = contentType === 'text/event-stream';
      const wire = sse ? `data: ${JSON.stringify({ type: 'response.completed', response: output })}\n\n` : JSON.stringify(output);
      const text = await responseText(adapter.createResponseTransform(10090, { contentType, contentEncoding: '' })!, wire);
      const parsed = JSON.parse(sse ? text.trim().slice(6) : text);
      expect((sse ? parsed.response : parsed).output).toEqual([{ ...bare, arguments: '{"line":12}' }, child]);
    }
  });

  // Native tool-search history is a real schema source even without live declarations.
  // Keep its unqualified selector repair when sharing the native identity plan (#11199).
  it.each(['application/json', 'text/event-stream'])('repairs native tools discovered only in search history (%s)', async contentType => {
    const adapter = createCodexResponsesCompatibilityAdapter();
    const input = { input: [{ type: 'tool_search_output', tools: [{ type: 'namespace', name: 'workspace', tools: [
      { type: 'function', name: 'read', parameters: { type: 'object', properties: { line: { type: 'integer' } } } },
    ] }] }], tool_choice: { type: 'function', name: 'read' } };
    adapter.adaptRequest(input, 10088);
    const output = { status: 'completed', output: [{ type: 'function_call', namespace: 'workspace', name: 'read', call_id: 'history', arguments: '{"line":12.0}' }] };
    const sse = contentType === 'text/event-stream';
    const wire = sse ? `data: ${JSON.stringify({ type: 'response.completed', response: output })}\n\n` : JSON.stringify(output);
    const transform = adapter.createResponseTransform(10088, { contentType, contentEncoding: '' });
    expect(transform).not.toBeNull();
    const text = await responseText(transform!, wire);
    const parsed = JSON.parse(sse ? text.trim().slice(6) : text);
    expect((sse ? parsed.response : parsed).output[0]).toEqual({ ...output.output[0], arguments: '{"line":12}' });
  });

  // #11199 native collision regression: public Codex transport, unit tier. The earlier native
  // case had no competing bare tool, so schema allocation and response lookup could diverge.
  it.each(['application/json', 'text/event-stream'])('repairs native collisions without borrowing the bare schema (%s)', async contentType => {
    for (const choice of [undefined, { type: 'function', name: 'read' },
      { type: 'function', namespace: 'workspace', name: 'read' },
      { type: 'allowed_tools', tools: [{ type: 'function', namespace: 'workspace', name: 'read' }] },
      { type: 'function', name: 'workspace__read' }]) {
      const input = { tools: [
        { type: 'function', name: 'workspace__read', parameters: { type: 'object', properties: { line: { type: 'number' } } } },
        { type: 'namespace', name: 'workspace', tools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: { line: { type: 'integer' } } } }] },
      ], ...(choice ? { tool_choice: choice } : {}) };
      const adapter = createCodexResponsesCompatibilityAdapter();
      expect(adapter.adaptRequest(input, 10087)).toBeNull();
      const child = { type: 'function_call', namespace: 'workspace', name: 'read', id: 'fc_child', call_id: 'child', arguments: '{"line":12.0}' };
      const bare = { type: 'function_call', name: 'workspace__read', id: 'fc_bare', call_id: 'bare', arguments: '{"line":12.0}' };
      const output = { status: 'completed', output: [child, bare] };
      const sse = contentType === 'text/event-stream';
      const events = [
        { type: 'response.output_item.added', output_index: 0, item: { ...child, arguments: '' } },
        { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_child', arguments: child.arguments },
        { type: 'response.output_item.done', output_index: 0, item: child },
        { type: 'response.completed', response: output },
      ];
      const wire = sse ? events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') : JSON.stringify(output);
      const text = await responseText(adapter.createResponseTransform(10087, { contentType, contentEncoding: '' })!, wire);
      const parsed = sse ? text.trim().split('\n\n').map(block => JSON.parse(block.slice(6))) : [];
      const expectedArguments = choice?.name === 'workspace__read' ? child.arguments : '{"line":12}';
      expect((sse ? parsed.at(-1).response : JSON.parse(text)).output).toEqual([{ ...child, arguments: expectedArguments }, bare]);
      if (sse) {
        expect(parsed[1].arguments).toBe(expectedArguments);
        expect(parsed[2].item).toEqual({ ...child, arguments: expectedArguments });
      }
    }
  });

  it('repairs allocated function arguments in incremental SSE while retaining event identity', () => {
    const parameters = { type: 'object', properties: { line: { type: 'integer' } } };
    const prepared = prepareResponsesCompatibility({ tools: [
      { type: 'function', name: 'workspace__read', parameters },
      { type: 'namespace', name: 'workspace', tools: [{ type: 'function', name: 'read', parameters }] },
    ] }, { namespaceTools: 'functions', repairFunctionArguments: true });
    const rewrite = prepared.createStreamRewrite();
    try {
      const events = [
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_child', call_id: 'child', name: 'workspace__read_2', arguments: '' } },
        { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_child', arguments: '{"line":12.0}' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_child', call_id: 'child', name: 'workspace__read_2', arguments: '{"line":12.0}' } },
      ].flatMap(event => rewrite(`data: ${JSON.stringify(event)}`)).map(block => JSON.parse(block.slice(6)));
      expect(events[1]).toMatchObject({ type: 'response.function_call_arguments.done', item_id: 'fc_child', arguments: '{"line":12}' });
      expect(events[2].item).toMatchObject({ type: 'function_call', id: 'fc_child', call_id: 'child', namespace: 'workspace', name: 'read', arguments: '{"line":12}' });
    } finally { rewrite.dispose?.(); }
  });

  it('does not authorize a custom child through a mismatched function selector after lowering', () => {
    for (const allowed of [false, true]) {
      const selector = { type: 'function', namespace: 'workspace', name: 'read' };
      const prepared = prepareResponsesCompatibility({ tools: [
        { type: 'function', name: 'workspace__read', parameters: {} },
        { type: 'namespace', name: 'workspace', tools: [{ type: 'custom', name: 'read', description: 'Child' }] },
      ], tool_choice: allowed ? { type: 'allowed_tools', tools: [selector] } : selector }, {
        namespaceTools: 'functions', customTools: 'functions',
      });
      const call = JSON.stringify({ output: [{ type: 'function_call', name: 'workspace__read_2', arguments: '{"input":"child"}', call_id: 'unapproved' }] });
      expect(prepared.restoreJson(call)).toBe(call);
    }
  });

  it.each(['application/json', 'text/event-stream'])('restores namespace and Code Mode identities (%s)', async contentType => {
    const adapter = createCodexResponsesCompatibilityAdapter();
    const input = {
      model: 'xai/grok-4.6',
      tools: [
        { type: 'custom', name: 'exec', description: 'Run JavaScript' },
        { type: 'namespace', name: 'files', tools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] },
      ],
    };
    const request = adapter.adaptRequest(input, 1, { harness: 'codex', protocol: 'openai-responses', upstreamBase: 'https://cli-chat-proxy.grok.com/v1', model: 'grok-4.6' }, true) as typeof input;
    expect(request.tools.map(tool => tool.name)).toEqual(['exec', 'files__read']);
    const result = { id: 'resp_test', output: [
      { type: 'function_call', id: 'fc_a', call_id: 'a', name: 'exec', arguments: JSON.stringify({ input: 'text("你好")' }) },
      { type: 'function_call', id: 'fc_b', call_id: 'b', name: 'files__read', arguments: '{"path":"README.md"}' },
    ] };
    const sse = contentType === 'text/event-stream';
    const wire = sse ? `data: ${JSON.stringify({ type: 'response.completed', response: result })}\n\n` : JSON.stringify(result);
    const transformed = await responseText(adapter.createResponseTransform(1, { contentType, contentEncoding: '' })!, wire);
    const parsed = JSON.parse(sse ? transformed.trim().slice(6) : transformed);
    const response = sse ? parsed.response : parsed;
    expect(response.output[0]).toMatchObject({ type: 'custom_tool_call', call_id: 'a', name: 'exec', input: 'text("你好")' });
    expect(response.output[1]).toMatchObject({ type: 'function_call', call_id: 'b', namespace: 'files', name: 'read' });
    expect(input.tools[1]!.type).toBe('namespace');
  });

  it('keeps native GPT namespaces and no-op response bodies unchanged', () => {
    const input = { model: 'gpt-5.4', tools: [{ type: 'namespace', name: 'files', tools: [{ type: 'function', name: 'read' }] }] };
    const adapter = createCodexResponsesCompatibilityAdapter();
    expect(adapter.adaptRequest(input, 1)).toBeNull();
    adapter.releaseResponse(1);
    expect(adapter.createResponseTransform(1, { contentType: 'application/json', contentEncoding: '' })).toBeNull();
  });

  it('restores tool discovery independently from web search', () => {
    const prepared = prepareResponsesCompatibility({ tools: [{ type: 'tool_search' }] }, { toolSearch: 'function' });
    const body = prepared.body as { tools: Array<{ name: string }> };
    const output = JSON.parse(prepared.restoreJson(JSON.stringify({ output: [{ type: 'function_call', name: body.tools[0]!.name, call_id: 'a', arguments: '{"query":"read files"}' }] })));
    expect(output.output[0].type).toBe('tool_search_call');
  });
});

describe('provider policy boundaries across harnesses', () => {
  // #10434, unit: production normalization must emit the documented Chat toggle,
  // never reasoning_effort, and must not copy Chat fields to native Responses.
  it.each(['api', 'token-plan-cn', 'token-plan-ams', 'token-plan-sgp'])('normalizes MiMo V2.6 Chat switches on %s', host => {
    for (const model of ['mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.6-pro-ultraspeed']) {
      const route = { harness: 'pi' as const, protocol: 'openai-chat' as const,
        upstreamBase: `https://${host}.xiaomimimo.com/v1`, model };
      for (const effort of ['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
        expect(normalizeProviderRequest({ model, reasoning_effort: effort }, route)).toEqual({
          model, thinking: { type: effort === 'none' || effort === 'off' ? 'disabled' : 'enabled' },
        });
      }
      const native = { model, reasoning: { effort: 'high' } };
      expect(normalizeProviderRequest(native, { ...route, protocol: 'openai-responses' })).toEqual(native);
      const explicit = { model, thinking: { type: 'disabled' } };
      expect(normalizeProviderRequest(explicit, route)).toEqual(explicit);
      const absent = { model, messages: [] };
      expect(normalizeProviderRequest(absent, route)).toEqual(absent);
      const unknown = { model, reasoning_effort: 'medium' };
      expect(normalizeProviderRequest(unknown, { ...route, upstreamBase: 'https://api.xiaomimimo.com.evil.test/v1' })).toEqual(unknown);
      expect(normalizeProviderRequest(unknown, { ...route, model: 'mimo-v2.7-pro' })).not.toHaveProperty('thinking');
    }
  });
  it.each(['codex', 'claude-code', 'pi'] as const)('only normalizes an actual xAI Responses endpoint for %s', harness => {
    const body = { tools: [{ type: 'web_search', external_web_access: true, user_location: { country: 'CN' } }] };
    const route = { harness, protocol: 'openai-responses' as const, upstreamBase: 'https://api.x.ai/v1', model: 'grok-4.6' };
    expect(normalizeProviderRequest(body, route)).toEqual({ tools: [{ type: 'web_search', user_location: { country: 'CN' } }] });
    expect(normalizeProviderRequest(body, { ...route, upstreamBase: 'https://api.x.ai.evil.test/v1' })).toBe(body);
    expect(normalizeProviderRequest(body, { ...route, protocol: 'openai-chat' })).toBe(body);
  });
  it.each([false, null, 'false'])('does not widen an explicit non-live search declaration (%s)', external_web_access => {
    const body = { tools: [{ type: 'function', name: 'read' }], input: [{ type: 'additional_tools', tools: [{ type: 'web_search_preview', external_web_access }] }], tool_choice: { type: 'web_search_preview' } };
    expect(hasCacheOnlySearchProhibition(body)).toBe(true);
    expect(sanitizeXaiTools(body)).toMatchObject({ tools: [{ type: 'function', name: 'read' }], tool_choice: 'none', input: [] });
  });
  it('strips subscription-only schema markers without touching literals or the public xAI API', () => {
    const parameters = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { encrypted: { type: 'string', default: 'encrypted' } }, additionalProperties: false };
    const body = { tools: [{ type: 'function', name: 'read', parameters }] };
    const route = { harness: 'claude-code' as const, protocol: 'openai-responses' as const, model: 'grok-4.6', upstreamBase: 'https://cli-chat-proxy.grok.com/v1' };
    const output = normalizeProviderRequest(body, route) as typeof body;
    expect(output.tools[0]!.parameters).not.toHaveProperty('$schema');
    expect(output.tools[0]!.parameters.properties.encrypted.default).toBe('encrypted');
    expect(normalizeProviderRequest(body, { ...route, upstreamBase: 'https://api.x.ai/v1' })).toBe(body);
  });
  it('does not inherit compatibility by a familiar model name on an unknown gateway', () => {
    expect(resolveProviderCompatibilityProfile({ harness: 'codex', protocol: 'openai-responses', model: 'deepseek-v4-pro', upstreamBase: 'https://gateway.example/v1' })).toBeNull();
  });
});
