import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => '/tmp/xdt-maker-test/app'),
    getPath: vi.fn(() => '/tmp/xdt-maker-test'),
    isPackaged: false,
  },
  ipcMain: { handle: vi.fn() },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
}));

import { buildHelpPrompt, parseAssistantOutput } from '../maker-ipc/help';
import { HELP_KNOWLEDGE } from '../maker-ipc/helpKnowledge.generated';
import { truncateHelpHistory, type HelpMessage } from '../../shared/helpTypes';

describe('parseAssistantOutput', () => {
  it('extracts a whitelisted action and strips the tag', () => {
    const r = parseAssistantOutput('Open API Keys and paste your key.\n<action tab="api-keys" />');
    expect(r).toEqual({
      kind: 'ai',
      answer: 'Open API Keys and paste your key.',
      action: { kind: 'settings-tab', tab: 'api-keys' },
    });
  });

  it('returns ai without action when there is no tag', () => {
    expect(parseAssistantOutput('Just some guidance.')).toEqual({
      kind: 'ai',
      answer: 'Just some guidance.',
    });
  });

  it('drops a non-whitelisted tab but keeps the prose', () => {
    expect(parseAssistantOutput('We have no Slack integration.\n<action tab="slack" />')).toEqual({
      kind: 'ai',
      answer: 'We have no Slack integration.',
    });
  });

  it('honors only the first action and strips every tag from the prose', () => {
    const r = parseAssistantOutput('a <action tab="import" /> b <action tab="api-keys" />');
    expect(r).toEqual({ kind: 'ai', answer: 'a  b', action: { kind: 'settings-tab', tab: 'import' } });
  });

  it('is case-insensitive and tolerates extra whitespace', () => {
    const r = parseAssistantOutput('Go there. <ACTION   tab="voice-input"/>');
    expect(r).toEqual({
      kind: 'ai',
      answer: 'Go there.',
      action: { kind: 'settings-tab', tab: 'voice-input' },
    });
  });

  it('returns no-answer for empty or whitespace-only output', () => {
    expect(parseAssistantOutput('')).toEqual({ kind: 'no-answer' });
    expect(parseAssistantOutput('   \n ')).toEqual({ kind: 'no-answer' });
  });

  it('returns no-answer when only an action tag is present', () => {
    expect(parseAssistantOutput('<action tab="import" />')).toEqual({ kind: 'no-answer' });
  });
});

describe('buildHelpPrompt', () => {
  const history: HelpMessage[] = [
    { role: 'user', content: 'how to import?' },
    { role: 'assistant', content: 'Open import.' },
    { role: 'user', content: 'not import, archive' },
  ];

  it('injects the locale name', () => {
    expect(buildHelpPrompt(history, 'zh-CN', 'claude-code', [])).toContain('Simplified Chinese');
    expect(buildHelpPrompt(history, 'ja', 'claude-code', [])).toContain('Japanese');
  });

  it('lists every allowed tab id', () => {
    const p = buildHelpPrompt(history, 'en', 'claude-code', []);
    for (const tab of ['import', 'providers', 'im-bot', 'voice-input', 'personalization']) {
      expect(p).toContain(tab);
    }
  });

  it('serializes history in order with the latest user turn last', () => {
    const p = buildHelpPrompt(history, 'en', 'claude-code', []);
    const iUser1 = p.indexOf('USER: how to import?');
    const iAssist = p.indexOf('ASSISTANT: Open import.');
    const iUser2 = p.indexOf('USER: not import, archive');
    expect(iUser1).toBeGreaterThanOrEqual(0);
    expect(iUser1).toBeLessThan(iAssist);
    expect(iAssist).toBeLessThan(iUser2);
    expect(p.trimEnd().endsWith('USER: not import, archive')).toBe(true);
  });

  it('adds a length hint for codex only', () => {
    expect(buildHelpPrompt(history, 'en', 'codex', [])).toContain('under 3 short sentences');
    expect(buildHelpPrompt(history, 'en', 'claude-code', [])).not.toContain('under 3 short sentences');
  });

  it('embeds routed doc content and forbids inventing beyond it', () => {
    const docs = [{ id: 'x', title: 'Test Topic', summary: 's', content: 'UNIQUE_BODY_TOKEN_42' }];
    const p = buildHelpPrompt(history, 'en', 'claude-code', docs);
    expect(p).toContain('UNIQUE_BODY_TOKEN_42');
    expect(p).toContain('Answer using ONLY the product knowledge below');
  });

  it('falls back to summaries when no docs were routed', () => {
    expect(buildHelpPrompt(history, 'en', 'claude-code', [])).toContain(
      'Only short topic summaries are available',
    );
  });

  it.each(['claude-code', 'codex'] as const)(
    'does not advertise disabled Cindy Make entries in the packaged help knowledge for %s',
    (agentKind) => {
      for (const docs of [HELP_KNOWLEDGE, []]) {
        const prompt = buildHelpPrompt(history, 'en', agentKind, docs);
        expect(prompt).not.toMatch(/cindy[ -]make/i);
      }
    },
  );

  it.each(['claude-code', 'codex'] as const)(
    'preserves enabled slash-command guidance in the packaged help knowledge for %s',
    (agentKind) => {
      const docs = HELP_KNOWLEDGE.filter((doc) => doc.id === 'commands');
      expect(docs).toHaveLength(1);
      const prompt = buildHelpPrompt(history, 'en', agentKind, docs);
      for (const command of ['/help', '/clear', '/cmd', '/issue', '/goal', '/workflows', '/jump-session']) {
        expect(prompt).toContain(command);
      }
    },
  );
});

describe('truncateHelpHistory', () => {
  const make = (n: number): HelpMessage[] =>
    Array.from({ length: n }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `m${i}`,
    }));

  it('returns the same array when within the cap (<= 12)', () => {
    const h = make(12);
    expect(truncateHelpHistory(h)).toBe(h);
  });

  it('keeps the most recent MAX_HELP_MESSAGES when over the cap, when the tail naturally starts with a user', () => {
    // n=20 → slice(-12) = indices 8..19. h[8] is even index → user. Tail naturally starts with user.
    const h = make(20);
    const t = truncateHelpHistory(h);
    expect(t).toEqual(h.slice(-12));
    expect(t).toHaveLength(12);
    expect(t[0].role).toBe('user');
  });

  it('drops a leading assistant from the tail so each assistant in the result has its paired user as immediate predecessor', () => {
    // n=13 → slice(-12) = indices 1..12. h[1] is odd index → assistant. The
    // truncator must drop h[1] so the kept tail starts at h[2] (user).
    // Without this drop, the UI would mistakenly pair h[1] (assistant) with
    // h[0] from the kept-anchor design (old behavior) or with nothing (current
    // design), breaking the "prefill feedback with the right question" path.
    const h = make(13);
    const t = truncateHelpHistory(h);
    expect(t[0].role).toBe('user');
    expect(t).toEqual(h.slice(2)); // h[2..12], 11 elements
    expect(t).toHaveLength(11);
  });

  it('preserves strict user/assistant alternation in the result', () => {
    const h = make(25);
    const t = truncateHelpHistory(h);
    for (let i = 0; i < t.length; i++) {
      const expected = i % 2 === 0 ? 'user' : 'assistant';
      expect(t[i].role).toBe(expected);
    }
  });
});
