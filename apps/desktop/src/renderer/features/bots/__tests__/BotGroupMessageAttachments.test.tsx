// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tooltip } from '@/components/ui/tooltip';
import type { BotGroupAttachment } from '../../../../shared/botGroupChat';
import { BotGroupMessageAttachments } from '../BotGroupMessageAttachments';

vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const pending = (id: string, name: string, state: 'loading' | 'unavailable'): BotGroupAttachment =>
  ({ id, name, category: 'file', mimeType: '', size: 0, url: null, path: null, state });
const image = (id: string, name: string): BotGroupAttachment =>
  ({ id, name, category: 'image', mimeType: 'image/png', size: 1, url: `cindy-media://blobs/${id}.png`, path: null });
const file = (id: string, name: string): BotGroupAttachment =>
  ({ id, name, category: 'text', mimeType: 'text/plain', size: 1, url: null, path: `/tmp/${name}` });
const view = (attachments: BotGroupAttachment[]) => <Tooltip.Provider><BotGroupMessageAttachments attachments={attachments} align="start" /></Tooltip.Provider>;
/** The attachment names in the order they appear, read from whatever currently stands in for each. */
const sequence = (names: string[]) => names
  .map((name) => ({ name, node: screen.queryByAltText(name) ?? screen.getByText(name) }))
  .sort((a, b) => (a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
  .map(({ name }) => name);

afterEach(cleanup);

describe('BotGroupMessageAttachments order', () => {
  it('keeps two pictures in the sent order while the first is still arriving, then becomes ready or fails', () => {
    const { rerender } = render(view([pending('a', 'a.png', 'loading'), image('b', 'b.png')]));
    expect(sequence(['a.png', 'b.png'])).toEqual(['a.png', 'b.png']);
    const shown = screen.getByAltText('b.png');
    rerender(view([image('a', 'a.png'), image('b', 'b.png')]));
    expect(sequence(['a.png', 'b.png'])).toEqual(['a.png', 'b.png']);
    // Same key: the picture already on screen is not remounted when its neighbour arrives.
    expect(screen.getByAltText('b.png')).toBe(shown);
    rerender(view([pending('a', 'a.png', 'unavailable'), image('b', 'b.png')]));
    expect(sequence(['a.png', 'b.png'])).toEqual(['a.png', 'b.png']);
    expect(screen.getByAltText('b.png')).toBe(shown);
  });

  it('keeps several files in the sent order whatever order their downloads finish in', () => {
    const names = ['1.txt', '2.txt', '3.txt'];
    const arrivals: BotGroupAttachment[][] = [
      [pending('1', '1.txt', 'loading'), pending('2', '2.txt', 'loading'), file('3', '3.txt')],
      [pending('1', '1.txt', 'loading'), file('2', '2.txt'), file('3', '3.txt')],
      [pending('1', '1.txt', 'unavailable'), file('2', '2.txt'), file('3', '3.txt')],
      [file('1', '1.txt'), file('2', '2.txt'), file('3', '3.txt')],
    ];
    const { rerender } = render(view(arrivals[0]!));
    for (const attachments of arrivals) {
      rerender(view(attachments));
      expect(sequence(names)).toEqual(names);
    }
  });

  it('mixes pictures and file chips in the sent order', () => {
    render(view([file('f', 'f.txt'), pending('p', 'p.png', 'loading'), pending('g', 'g.md', 'unavailable'), image('q', 'q.png')]));
    expect(sequence(['f.txt', 'p.png', 'g.md', 'q.png'])).toEqual(['f.txt', 'p.png', 'g.md', 'q.png']);
  });
});
