import { describe, expect, it } from 'vitest';

import {
  buildSessionDragPreviewHtml,
  parseSessionDragPreviewPalette,
  truncateSessionDragPreviewLabel,
} from '../sessionDragPreviewHtml';

describe('sessionDragPreviewHtml', () => {
  it('uses a validated application-theme palette and escapes the task label', () => {
    const palette = parseSessionDragPreviewPalette({
      surface: 'rgb(31, 32, 34)',
      border: 'rgba(255, 255, 255, 0.22)',
      text: '#f4f4f2',
    });

    expect(palette).toEqual({
      surface: 'rgb(31, 32, 34)',
      border: 'rgba(255, 255, 255, 0.22)',
      text: '#f4f4f2',
    });
    const html = buildSessionDragPreviewHtml('A <remote> task', palette!);
    expect(html).toContain('background:rgb(31, 32, 34)');
    expect(html).toContain('border:1px solid rgba(255, 255, 255, 0.22)');
    expect(html).toContain('color:#f4f4f2');
    expect(html).toContain('A &lt;remote&gt; task');
    expect(html).not.toContain('A <remote> task');
  });

  it.each([
    ['non-object', 'red'],
    ['missing field', { surface: '#fff', border: '#000' }],
    ['style injection', { surface: '#fff;position:fixed', border: '#000', text: '#111' }],
    [
      'numeric entity injection',
      {
        surface: 'rgb(0 0 0 / 1 &#41 &#59 background-image:url(https://example.invalid/pixel)',
        border: '#000',
        text: '#111',
      },
    ],
    ['markup injection', { surface: '#fff', border: '#000', text: 'red"><script' }],
    ['unsupported CSS', { surface: 'var(--surface)', border: '#000', text: '#111' }],
    ['oversized value', { surface: `#${'f'.repeat(129)}`, border: '#000', text: '#111' }],
  ])('rejects %s palette input', (_label, input) => {
    expect(parseSessionDragPreviewPalette(input)).toBeNull();
  });

  it('truncates labels without splitting an emoji surrogate pair', () => {
    const label = `${'a'.repeat(159)}😀tail`;

    expect(truncateSessionDragPreviewLabel(label)).toBe(`${'a'.repeat(159)}😀`);
  });
});
