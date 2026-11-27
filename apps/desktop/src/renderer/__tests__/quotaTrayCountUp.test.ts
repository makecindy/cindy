import { describe, expect, it } from 'vitest';
import { countUpFrames } from '../quota-tray-tube';

// PR #11277 review (Codex P1, 2026-11-18): the tray card's count-up read every displayed amount
// as an en-US number, so a German "31,17" counted to 3117 and "1.234" to 1.234 before snapping
// to the real text. Entry: countUpFrames, which CountUp renders frame by frame. Unit tier: pure
// Intl formatting, no DOM. Minimal failing input: the first row. Every frame must be written the
// way the final text is, and text no locale writes back exactly must not animate at all.
const fr = new Intl.NumberFormat('fr').format(1234.5);

describe('countUpFrames', () => {
  it.each([
    { locale: 'de', text: '31,20 €', half: '15,60 €' },
    { locale: 'de', text: '1.234', half: '617' },
    { locale: 'de', text: '¥28.0k', half: '¥14.0k' },
    { locale: 'en', text: '$1,234.50', half: '$617.25' },
    { locale: 'fr', text: fr + ' €', half: '617,3 €' },
    { locale: 'zh-CN', text: '60', half: '30' },
  ])('counts $text in $locale with its own separators', ({ locale, text, half }) => {
    const frames = countUpFrames(text, locale);
    expect(frames?.(0.5)).toBe(half);
    expect(frames?.(1)).toBe(text);
  });

  it.each(['—', '1,2,3', 'Pro'])('shows %s as-is', text => {
    expect(countUpFrames(text, 'en')).toBeNull();
  });
});
