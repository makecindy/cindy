// @vitest-environment jsdom

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
});
