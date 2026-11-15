import { describe, expect, it } from 'vitest';
import { formatMailDate, parseMailDate } from '@/plugins/mailReaderDate';

// Providers send RFC 2822 text that Hermes cannot parse; the reader must not
// show a shifted time or "Invalid Date" for it.
describe('mail reader dates', () => {
  it('honours the RFC 2822 zone offset', () => {
    expect(parseMailDate('Wed, 21 Oct 2026 09:55:03 +1300')?.toISOString()).toBe('2026-10-20T20:55:03.000Z');
  });
  it('converts RFC named zones instead of reading them as UTC', () => {
    expect(parseMailDate('Wed, 21 Oct 2026 09:55:03 EST')?.toISOString()).toBe('2026-10-21T14:55:03.000Z');
    expect(parseMailDate('21 Oct 2026 09:55 PDT (Pacific)')?.toISOString()).toBe('2026-10-21T16:55:00.000Z');
  });
  it('keeps unknown provider text as-is', () => {
    expect(formatMailDate('yesterday-ish', 'en')).toBe('yesterday-ish');
  });
});
