import { describe, expect, it } from 'vitest';
import { normalizeProviderRequest } from '../request';

const route = { harness: 'codex' as const, protocol: 'openai-responses' as const,
  upstreamBase: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-pro' };

describe('MiMo native Responses search compatibility', () => {
  it('keeps hello and callable tools while removing unsupported hosted search', () => {
    const fn = { type: 'function', name: 'read_file', parameters: { type: 'object' } };
    const input = [{ role: 'user', content: 'hello' }];
    const body = { model: route.model, input, tools: [fn, { type: 'web_search' }] };
    expect(normalizeProviderRequest(body, route)).toEqual({ ...body, tools: [fn] });
    expect(body.tools).toHaveLength(2);
  });

  it.each(['https://api.xiaomimimo.com/v1/', 'https://token-plan-cn.xiaomimimo.com/v1'])(
    'handles search-only declarations at the known channel %s', upstreamBase => {
      expect(normalizeProviderRequest({ tools: [{ type: 'web_search_preview' }],
        tool_choice: 'auto', parallel_tool_calls: true }, { ...route, upstreamBase })).toEqual({});
    },
  );

  it.each(['search', 'open_page', 'find_in_page'])('preserves completed %s evidence on continuation', type => {
    const action = { type, query: 'weather', url: 'https://example.com', sources: [{ url: 'https://example.com' }] };
    const user = { role: 'user', content: 'continue' };
    const body = { input: [{ type: 'web_search_call', id: 'ws_old', status: 'completed', action }, user] };
    expect(normalizeProviderRequest(body, route)).toEqual({ input: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '[completed web search]\n' + JSON.stringify(action) }] }, user,
    ] });
    expect(body.input[0]).toHaveProperty('type', 'web_search_call');
  });

  it.each(['failed', 'in_progress'])('does not turn %s search history into successful evidence', status => {
    expect(() => normalizeProviderRequest({ input: [{ type: 'web_search_call', status, action: { type: 'search' } }] }, route)).toThrow(/incomplete/);
  });

  it('does not silently satisfy explicit or required search requests without searching', () => {
    expect(() => normalizeProviderRequest({ tools: [{ type: 'web_search' }], tool_choice: 'required' }, route)).toThrow(/required/);
    expect(() => normalizeProviderRequest({ tool_choice: { type: 'web_search' } }, route)).toThrow(/tool_choice/);
    const fn = { type: 'function', name: 'read_file' };
    expect(normalizeProviderRequest({ tools: [fn, { type: 'web_search' }], tool_choice: 'required' }, route)).toEqual({ tools: [fn], tool_choice: 'required' });
    expect(normalizeProviderRequest({ tools: [fn, { type: 'web_search' }],
      tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [fn, { type: 'web_search' }] } }, route))
      .toEqual({ tools: [fn], tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [fn] } });
  });

  it.each([false, true])('allows optional search-only choices without widening function access (functions=%s)', withFunctions => {
    const fn = { type: 'function', name: 'read_file' };
    const body = { tools: [...(withFunctions ? [fn] : []), { type: 'web_search' }],
      tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'web_search' }] } };
    expect(normalizeProviderRequest(body, route)).toEqual({ ...(withFunctions ? { tools: [fn] } : {}), tool_choice: 'none' });
    expect(body.tool_choice.mode).toBe('auto');
  });

  it('rejects a required allowed list containing only hosted search', () => {
    expect(() => normalizeProviderRequest({ tools: [{ type: 'function', name: 'read_file' }, { type: 'web_search' }],
      tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'web_search' }] } }, route)).toThrow(/allowed hosted/);
  });

  it.each([
    { upstreamBase: 'https://api.openai.com/v1' },
    { upstreamBase: 'https://proxy.example/v1' },
    { upstreamBase: 'https://api.xiaomimimo.com.evil.example/v1' },
    { upstreamBase: 'https://api.xiaomimimo.com/v10' },
    { upstreamBase: 'https://api.xiaomimimo.com/anthropic' },
    { protocol: 'openai-chat' as const },
    { harness: 'pi' as const },
    { harness: 'claude-code' as const },
  ])('preserves supported or unrelated channels: %j', override => {
    const body = { tools: [{ type: 'web_search' }] };
    expect(normalizeProviderRequest(body, { ...route, ...override })).toBe(body);
  });

  it.each(['mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.6-pro-ultraspeed'])(
    'leaves normal function-only %s requests untouched', model => {
      const body = { model, input: [{ role: 'user', content: 'hello' }], tools: [{ type: 'function', name: 'read_file' }] };
      expect(normalizeProviderRequest(body, { ...route, model })).toBe(body);
    },
  );
});
