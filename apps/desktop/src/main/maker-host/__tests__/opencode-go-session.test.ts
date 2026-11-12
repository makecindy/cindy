import { describe, expect, it } from 'vitest';

import { isOpenCodeGoUpstream, withOpenCodeGoSessionHeader } from '../opencode-go-session.js';

describe('isOpenCodeGoUpstream', () => {
  it('matches the OpenCode Go preset entry points with or without /v1 and trailing slash', () => {
    expect(isOpenCodeGoUpstream('https://opencode.ai/zen/go')).toBe(true);
    expect(isOpenCodeGoUpstream('https://opencode.ai/zen/go/v1')).toBe(true);
    expect(isOpenCodeGoUpstream('https://opencode.ai/zen/go/v1/')).toBe(true);
    expect(isOpenCodeGoUpstream('https://opencode.ai/zen/go/')).toBe(true);
  });

  it('rejects other hosts, products and decorated URLs', () => {
    expect(isOpenCodeGoUpstream('https://opencode.ai/zen')).toBe(false);
    expect(isOpenCodeGoUpstream('https://opencode.ai/zen/v1')).toBe(false);
    expect(isOpenCodeGoUpstream('https://opencode.ai/zen/go-extra')).toBe(false);
    expect(isOpenCodeGoUpstream('https://example.com/zen/go/v1')).toBe(false);
    expect(isOpenCodeGoUpstream('http://opencode.ai/zen/go/v1')).toBe(false);
    expect(isOpenCodeGoUpstream('https://user:pass@opencode.ai/zen/go/v1')).toBe(false);
    expect(isOpenCodeGoUpstream('https://opencode.ai/zen/go/v1?tenant=1')).toBe(false);
    expect(isOpenCodeGoUpstream('not-a-url')).toBe(false);
  });
});

describe('withOpenCodeGoSessionHeader', () => {
  it('adds a per-request session id for the OpenCode Go provider id and upstream', () => {
    for (const route of [
      { providerId: 'opencode-go', upstream: 'https://mirror.example/zen/go/v1' },
      { providerId: 'custom-id', upstream: 'https://opencode.ai/zen/go/v1' },
    ]) {
      const headers = withOpenCodeGoSessionHeader({ 'x-custom': '1' }, route);
      expect(headers?.['x-opencode-session']).toMatch(/^[0-9a-f-]{36}$/);
      expect(headers?.['x-custom']).toBe('1');
    }
  });

  it('does not invent a header for unrelated routes', () => {
    expect(
      withOpenCodeGoSessionHeader(undefined, {
        providerId: 'chat-only',
        upstream: 'https://chat.example/v1',
      }),
    ).toBeUndefined();
    expect(
      withOpenCodeGoSessionHeader(
        { 'x-custom': '1' },
        {
          providerId: 'chat-only',
          upstream: 'https://chat.example/v1',
        },
      ),
    ).toEqual({ 'x-custom': '1' });
  });

  it('preserves an explicitly configured non-empty session header case-insensitively', () => {
    const headers = withOpenCodeGoSessionHeader(
      { 'X-OpenCode-Session': 'user-fixed-id' },
      { providerId: 'opencode-go', upstream: 'https://opencode.ai/zen/go/v1' },
    );
    expect(headers).toEqual({ 'X-OpenCode-Session': 'user-fixed-id' });
  });

  it('keeps only one session header when the user value coexists with empty or duplicate variants', () => {
    for (const configured of ['', '   ']) {
      const headers = withOpenCodeGoSessionHeader(
        {
          'x-opencode-session': configured,
          'X-OpenCode-Session': 'user-fixed-id',
          'x-custom': '1',
        },
        { providerId: 'opencode-go', upstream: 'https://opencode.ai/zen/go/v1' },
      );
      // 两个非空同名键同样只能留一个（保留首见拼写），否则 fetch 合并出 `', <value>'`。
      expect(
        Object.keys(headers!).filter((key) => key.toLowerCase() === 'x-opencode-session'),
      ).toEqual(['X-OpenCode-Session']);
      expect(headers!['X-OpenCode-Session']).toBe('user-fixed-id');
      expect(headers!['x-custom']).toBe('1');
    }
    const duplicated = withOpenCodeGoSessionHeader(
      { 'x-opencode-session': 'second', 'X-OpenCode-Session': 'first' },
      { providerId: 'opencode-go', upstream: 'https://opencode.ai/zen/go/v1' },
    );
    expect(duplicated).toEqual({ 'x-opencode-session': 'second' });
  });

  it('recognizes a preset-created connection after its id and endpoint changed', () => {
    const headers = withOpenCodeGoSessionHeader(
      { 'x-custom': '1' },
      {
        providerId: 'opencode-go-mirror',
        catalogPresetId: 'opencode-go',
        upstream: 'https://mirror.example/zen-go/v1',
      },
    );
    expect(headers?.['x-opencode-session']).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers?.['x-custom']).toBe('1');
    // 其它预设身份 + 非 Go 地址不应被误判。
    expect(
      withOpenCodeGoSessionHeader(undefined, {
        providerId: 'claude-proxy',
        catalogPresetId: 'moonshot',
        upstream: 'https://api.moonshot.example/v1',
      }),
    ).toBeUndefined();
  });

  it('treats an empty configured session header as absent, including case variants', () => {
    for (const configured of ['', '   ']) {
      for (const name of ['x-opencode-session', 'X-OpenCode-Session']) {
        const headers = withOpenCodeGoSessionHeader(
          { [name]: configured, 'x-custom': '1' },
          { providerId: 'opencode-go', upstream: 'https://opencode.ai/zen/go/v1' },
        );
        // 同名不同拼写只能留一个，否则 fetch 会合并成 `', <uuid>'` 非法复合值。
        expect(
          Object.keys(headers!).filter((key) => key.toLowerCase() === 'x-opencode-session'),
        ).toEqual(['x-opencode-session']);
        expect(headers!['x-opencode-session']).toMatch(/^[0-9a-f-]{36}$/);
        expect(headers!['x-custom']).toBe('1');
      }
    }
  });

  it('generates a fresh id per request when no session id is given', () => {
    const route = { providerId: 'opencode-go', upstream: 'https://opencode.ai/zen/go/v1' };
    const first = withOpenCodeGoSessionHeader(undefined, route);
    const second = withOpenCodeGoSessionHeader(undefined, route);
    expect(first?.['x-opencode-session']).not.toBe(second?.['x-opencode-session']);
  });

  it('derives a deterministic id for spawn-env consumers so rebuilds stay byte-identical', () => {
    const route = {
      providerId: 'opencode-go',
      upstream: 'https://opencode.ai/zen/go/v1',
      sessionId: 'session-1',
    };
    const first = withOpenCodeGoSessionHeader(undefined, route);
    const second = withOpenCodeGoSessionHeader(undefined, route);
    expect(first?.['x-opencode-session']).toBe(second?.['x-opencode-session']);
    expect(first?.['x-opencode-session']).toMatch(/^[0-9a-f]{32}$/);

    const otherSession = withOpenCodeGoSessionHeader(undefined, {
      ...route,
      sessionId: 'session-2',
    });
    expect(otherSession?.['x-opencode-session']).not.toBe(first?.['x-opencode-session']);

    const trailingSlash = withOpenCodeGoSessionHeader(undefined, {
      ...route,
      upstream: 'https://opencode.ai/zen/go/v1/',
    });
    expect(trailingSlash?.['x-opencode-session']).toBe(first?.['x-opencode-session']);
  });
});
