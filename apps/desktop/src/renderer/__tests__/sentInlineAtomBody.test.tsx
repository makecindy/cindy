// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

import { formatQuoteForSend } from '@/lib/chatQuotes';
import { SentInlineAtomBody } from '@/components/chat/SentInlineAtomBody';

const pendingQueueSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'PendingQueuePanel.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('SentInlineAtomBody', () => {
  it('keeps the same atom shapes in static queue/collapse projections without focus targets', () => {
    const quote = formatQuoteForSend({ text: 'quoted context' });
    const content = `${quote}\n\n/help\n\nfull pasted payload\n\n@src/App.tsx\n\n@src/index.ts`;
    const slashStart = content.indexOf('/help');
    const pastedStart = content.indexOf('full pasted payload');
    const agentStart = content.indexOf('@src/App.tsx');

    render(
      <SentInlineAtomBody
        agentReferences={[
          {
            kind: 'project',
            start: agentStart,
            end: agentStart + '@src/App.tsx'.length,
            href: 'cindy://project/src',
            name: 'src',
            workingDir: '/tmp/src',
          },
        ]}
        content={content}
        pastedTextRanges={[
          {
            start: pastedStart,
            end: pastedStart + 'full pasted payload'.length,
            display: 'Pasted text (1 line)',
          },
        ]}
        quotesEncoded
        slashCommandRanges={[{ start: slashStart, end: slashStart + '/help'.length }]}
      />,
    );

    expect(screen.getByText('quoted context')).toBeTruthy();
    expect(screen.getByText('/help')).toBeTruthy();
    expect(screen.getByText('Pasted text (1 line)')).toBeTruthy();
    expect(screen.getByText('src')).toBeTruthy();
    expect(screen.getByText('index.ts')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.querySelector('button')).toBeNull();
    expect(document.querySelector('[tabindex]')).toBeNull();
  });

  it('leaves the pending queue single-line truncation contract to the row container', () => {
    const bodyStart = pendingQueueSource.indexOf('<SentInlineAtomBody');
    const bodyEnd = pendingQueueSource.indexOf('/>', bodyStart);

    expect(bodyStart).toBeGreaterThanOrEqual(0);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    const bodyBlock = pendingQueueSource.slice(bodyStart, bodyEnd);
    expect(bodyBlock).not.toContain('whitespace-pre-wrap');
    expect(bodyBlock).not.toContain('truncate');
    expect(pendingQueueSource).toContain(
      "'relative top-px min-w-0 flex-1 truncate text-13 leading-[1.25]'",
    );
  });
});
