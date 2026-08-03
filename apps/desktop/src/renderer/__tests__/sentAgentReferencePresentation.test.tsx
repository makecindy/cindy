// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentInputReference } from '../../shared/agentInputQueue';
import {
  buildSentInlineTokens,
  locateChatQuoteTextSegmentStarts,
  projectSentInlinePlainText,
  projectSentRanges,
} from '@/components/chat/UserMessage';
import { SentAgentReferenceChip } from '@/components/chat/SentAgentReferenceChip';
import { formatQuoteForSend, parseChatQuoteSegments } from '@/lib/chatQuotes';

afterEach(cleanup);

function browserReference(label = 'Cindy issue #1462') {
  const href = 'cindy://browser-tab/tab-1?url=https%3A%2F%2Fgithub.com%2Fmakecindy%2Fcindy%2Fissues%2F1462';
  const wire = `[${label}](${href})`;
  const reference: AgentInputReference = {
    kind: 'browser-tab',
    start: 0,
    end: wire.length,
    href,
    tabId: 'tab-1',
    url: 'https://github.com/makecindy/cindy/issues/1462',
    title: label,
  };
  return { href, label, reference, wire };
}

describe('sent structured reference ranges', () => {
  it('replaces the exact browser Markdown span and preserves surrounding prose', () => {
    const { reference, wire } = browserReference();
    const content = `看下 ${wire}，总结下`;
    const start = content.indexOf(wire);
    const projected = { ...reference, start, end: start + wire.length };

    expect(buildSentInlineTokens(content, [], [], [projected])).toEqual([
      { kind: 'text', text: '看下 ' },
      { kind: 'agent-reference', text: wire, reference: projected },
      { kind: 'text', text: '，总结下' },
    ]);
    expect(projectSentInlinePlainText(content, [], [projected])).toBe(
      '看下 Cindy issue #1462，总结下',
    );
  });

  it('projects a reference after an inline quote to the correct text island', () => {
    const quote = formatQuoteForSend({ text: 'quoted selection' });
    const { reference, wire } = browserReference();
    const content = `${quote}\n\n${wire} 总结下`;
    const start = content.indexOf(wire);
    const projected = { ...reference, start, end: start + wire.length };
    const segments = parseChatQuoteSegments(content);
    const starts = locateChatQuoteTextSegmentStarts(content, segments);
    const textIndex = segments.findIndex((segment) => segment.kind === 'text');
    const segment = segments[textIndex];

    expect(segment.kind).toBe('text');
    if (segment.kind !== 'text') return;
    const localReferences = projectSentRanges(
      [projected],
      starts[textIndex],
      segment.text.length,
    );
    expect(buildSentInlineTokens(segment.text, [], [], localReferences)).toEqual([
      { kind: 'agent-reference', text: wire, reference: { ...projected, start: 0, end: wire.length } },
      { kind: 'text', text: ' 总结下' },
    ]);
  });

  it('keeps raw text when a persisted range is stale or out of bounds', () => {
    const { reference, wire } = browserReference();
    const stale = { ...reference, start: wire.length + 1, end: wire.length + 20 };

    expect(buildSentInlineTokens(wire, [], [], [stale])).toEqual([
      { kind: 'text', text: wire },
    ]);
  });
});

describe('sent structured reference chips', () => {
  it.each([
    {
      label: 'Cindy issue #1462',
      reference: browserReference().reference,
    },
    {
      label: 'Cindy Dev',
      reference: {
        kind: 'desktop-window',
        start: 0,
        end: 5,
        href: 'cindy://desktop-window/42/7?app=Cindy',
        windowId: 7,
        pid: 42,
        appName: 'Cindy',
        title: 'Cindy Dev',
      } satisfies AgentInputReference,
    },
    {
      label: '客户 ACME',
      reference: {
        kind: 'plugin-resource',
        start: 0,
        end: 5,
        href: 'cindy://plugin-resource/crm/search/customer-1',
        ghostId: 'crm',
        tool: 'search',
        resourceId: 'customer-1',
        pluginName: 'CRM',
        label: '客户 ACME',
      } satisfies AgentInputReference,
    },
  ])('renders $label with the same inline reference shell as the composer', ({ label, reference }) => {
    const { container } = render(<SentAgentReferenceChip reference={reference} />);
    const chip = container.querySelector('[data-inline-reference-chip]');

    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe(label);
    expect(chip?.querySelector('svg')).not.toBeNull();
    expect(container.textContent).not.toContain('cindy://');
  });
});
