import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDbClient: vi.fn(),
  queryOne: vi.fn(),
  query: vi.fn(),
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: mocks.getDbClient,
}));

import { searchSessionsFn } from '../session-search.js';

describe('session_search Bot ownership boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDbClient.mockReturnValue({
      queryOne: mocks.queryOne,
      query: mocks.query,
    });
    mocks.query.mockResolvedValue([]);
  });

  it('restricts a Bot caller to Sessions linked to the same Bot', async () => {
    mocks.queryOne.mockResolvedValue({ source: 'bot', botId: 'bot-a' });

    await searchSessionsFn('release', { callerSessionId: 'bot-session-a' });

    expect(mocks.queryOne).toHaveBeenCalledWith(expect.stringContaining('LEFT JOIN bot_session_links'), [
      'bot-session-a',
    ]);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM bot_session_links scoped'),
      ['"release"', 'bot-a', 10],
    );
  });

  it('keeps a model-supplied session filter inside the same Bot scope', async () => {
    mocks.queryOne.mockResolvedValue({ source: 'bot', botId: 'bot-a' });

    await searchSessionsFn('release', {
      callerSessionId: 'bot-session-a',
      sessionId: 'foreign-session',
    });

    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringMatching(/m\.session_id = \?[\s\S]*scoped\.bot_id = \?/),
      ['"release"', 'foreign-session', 'bot-a', 10],
    );
  });

  it('fails closed when a Bot Session has lost its ownership link', async () => {
    mocks.queryOne.mockResolvedValue({ source: 'bot', botId: null });

    await expect(
      searchSessionsFn('release', { callerSessionId: 'orphan-bot-session' }),
    ).resolves.toEqual([]);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('fails closed when Bot memory attribution survives but caller Session attribution is lost', async () => {
    await expect(
      searchSessionsFn('release', { callerMemoryScopeKey: 'bot:bot-a' }),
    ).resolves.toEqual([]);
    expect(mocks.queryOne).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('preserves the existing account history behavior for non-Bot Sessions', async () => {
    mocks.queryOne.mockResolvedValue({ source: 'desktop', botId: null });

    await searchSessionsFn('release', { callerSessionId: 'desktop-session' });

    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('FROM bot_session_links scoped');
    expect(params).toEqual(['"release"', 10]);
  });
});
