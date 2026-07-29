import { describe, expect, it } from 'vitest';

import { parseStdioArgsInput, selectStdioEnvMutation } from '../customMcpForm';

describe('custom MCP stdio form helpers', () => {
  it('preserves empty arguments and meaningful whitespace from JSON', () => {
    expect(parseStdioArgsInput('["", "  padded  ", "--flag"]')).toEqual({
      ok: true,
      args: ['', '  padded  ', '--flag'],
    });
  });

  it('rejects malformed or non-string argv input', () => {
    expect(parseStdioArgsInput('--flag')).toEqual({ ok: false });
    expect(parseStdioArgsInput('["ok", 1]')).toEqual({ ok: false });
  });

  it('preserves stored env while an existing stdio secret is still unresolved', () => {
    expect(
      selectStdioEnvMutation({
        editing: true,
        initialTransport: 'stdio',
        envLoaded: false,
        envDirty: false,
        env: {},
      }),
    ).toBeUndefined();
  });

  it('replaces env after loading, editing, or switching into stdio', () => {
    const env = { API_KEY: 'secret' };
    expect(
      selectStdioEnvMutation({
        editing: true,
        initialTransport: 'stdio',
        envLoaded: true,
        envDirty: false,
        env,
      }),
    ).toBe(env);
    expect(
      selectStdioEnvMutation({
        editing: true,
        initialTransport: 'stdio',
        envLoaded: false,
        envDirty: true,
        env,
      }),
    ).toBe(env);
    expect(
      selectStdioEnvMutation({
        editing: true,
        initialTransport: 'http',
        envLoaded: false,
        envDirty: false,
        env,
      }),
    ).toBe(env);
  });
});
