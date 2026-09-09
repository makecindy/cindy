// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SubagentTranscriptEntry } from '@cindy/maker-shared/subagent-workspace';

/**
 * Stand-in for the real i18n runtime: resolves the two keys this suite needs and
 * honours `defaultValue` for everything else, which is exactly how i18next
 * reports a missing key.
 */
const STRINGS: Record<string, string> = {
  'rightSidebar.subagents.systemEvents.stop-requested': '父任务请求了停止。',
  'rightSidebar.subagents.systemEvents.turn-ended': 'Subagent 本轮已结束。',
};
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      STRINGS[key] ?? options?.defaultValue ?? key,
  }),
}));

import { SystemLogRow } from '../SubagentChrome';

let sequence = 0;
function entry(overrides: Partial<SubagentTranscriptEntry> & { id: string }): SubagentTranscriptEntry {
  sequence += 1;
  return { sequence, role: 'system', content: '', occurredAt: 0, ...overrides };
}

afterEach(cleanup);

/**
 * The transcript is durable: its English sentence is written once, at synthesis
 * time, and read back much later by a UI in whatever language the user picked.
 * The slug is what lets that row be localized; the sentence stays as the
 * fallback so older clients and older records are unaffected.
 */
describe('SystemLogRow localization', () => {
  it('localizes a line Cindy synthesised', () => {
    render(<SystemLogRow entry={entry({
      id: 'a',
      content: 'A stop was requested from the parent task.',
      systemEvent: { kind: 'stop-requested' },
    })} />);
    expect(screen.getByText('父任务请求了停止。')).toBeTruthy();
    expect(screen.queryByText('A stop was requested from the parent task.')).toBeNull();
  });

  it('shows runtime output verbatim', () => {
    // stdout / stderr / harness errors carry no slug and must not be rewritten.
    render(<SystemLogRow entry={entry({ id: 'b', content: 'raw runner noise' })} />);
    expect(screen.getByText('raw runner noise')).toBeTruthy();
  });

  it('falls back to the recorded sentence for a record written before the slug existed', () => {
    render(<SystemLogRow entry={entry({ id: 'c', content: 'Subagent turn ended.' })} />);
    expect(screen.getByText('Subagent turn ended.')).toBeTruthy();
  });

  it('falls back when the producer knows a slug this bundle does not', () => {
    render(<SystemLogRow entry={entry({
      id: 'd',
      content: 'Something new happened.',
      systemEvent: { kind: 'not-in-this-bundle' },
    })} />);
    expect(screen.getByText('Something new happened.')).toBeTruthy();
    // Never a raw key on screen.
    expect(screen.queryByText(/rightSidebar\.subagents/)).toBeNull();
  });
});
