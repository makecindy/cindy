// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SubagentTranscriptEntry,
  SubagentTranscriptPageRequest,
  SubagentTranscriptPageResponse,
} from '@cindy/maker-shared/subagent-workspace';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p>,
}));

import { TranscriptSection } from '../TranscriptSection';

function entry(sequence: number): SubagentTranscriptEntry {
  return {
    id: `entry-${sequence}`,
    sequence,
    role: 'subagent',
    content: `entry ${sequence}`,
    occurredAt: 1_000 + sequence,
  };
}

const PAGE_ONE: SubagentTranscriptPageResponse = {
  supported: true,
  entries: [entry(0), entry(1)],
  nextCursor: 'cursor-2',
};

const PAGE_TWO: SubagentTranscriptPageResponse = {
  supported: true,
  entries: [entry(2), entry(3)],
};

describe('TranscriptSection', () => {
  const transcript = vi.fn(
    async (input: SubagentTranscriptPageRequest): Promise<SubagentTranscriptPageResponse> =>
      input.cursor ? PAGE_TWO : PAGE_ONE,
  );

  beforeEach(() => {
    transcript.mockClear();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { localDb: { subagentRuns: { transcript } } },
    });
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'electronAPI');
  });

  function renderSection() {
    return render(
      <TranscriptSection
        sessionId="session-1"
        provider="pi"
        runId="run-1"
        supported
        workdir="/workspace"
        allowPrivilegedLinks={false}
      />,
    );
  }

  it('renders later pages after the entries already displayed', async () => {
    const { container } = renderSection();

    await screen.findByText('entry 0');
    expect(transcript).toHaveBeenCalledWith({
      sessionId: 'session-1',
      provider: 'pi',
      runIdOrAlias: 'run-1',
    });

    fireEvent.click(screen.getByRole('button'));

    await screen.findByText('entry 3');
    expect(transcript).toHaveBeenLastCalledWith({
      sessionId: 'session-1',
      provider: 'pi',
      runIdOrAlias: 'run-1',
      cursor: 'cursor-2',
    });

    const rendered = Array.from(container.querySelectorAll('p'))
      .map((node) => node.textContent)
      .filter((text): text is string => Boolean(text?.startsWith('entry ')));
    expect(rendered).toEqual(['entry 0', 'entry 1', 'entry 2', 'entry 3']);
  });

  it('hides the pager once the last page has been loaded', async () => {
    renderSection();

    await screen.findByText('entry 0');
    fireEvent.click(screen.getByRole('button'));

    await screen.findByText('entry 3');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps the unsupported placeholder without calling the bridge', () => {
    render(
      <TranscriptSection
        sessionId="session-1"
        provider="pi"
        runId="run-1"
        supported={false}
        workdir="/workspace"
        allowPrivilegedLinks={false}
      />,
    );

    expect(screen.getByText('rightSidebar.subagents.transcriptUnavailable')).toBeTruthy();
    expect(transcript).not.toHaveBeenCalled();
  });

  it('renders tool entries as names only', async () => {
    transcript.mockResolvedValueOnce({
      supported: true,
      entries: [
        {
          id: 'tool-1',
          sequence: 0,
          role: 'tool',
          content: 'secret command arguments',
          toolName: 'Bash',
          occurredAt: 1,
        },
      ],
    });
    renderSection();

    await screen.findByText('Bash');
    expect(screen.queryByText('secret command arguments')).toBeNull();
  });
});
