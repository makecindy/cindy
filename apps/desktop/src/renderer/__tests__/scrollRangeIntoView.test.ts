/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { scrollRangeIntoView } from '../lib/scrollRangeIntoView';
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it('reveals matches on both axes inside nested scrollers without moving the owning message list', () => {
  document.body.innerHTML = '<div id="owner"><div id="vertical"><pre id="horizontal">needle</pre></div></div>';
  const owner = document.getElementById('owner')!;
  const vertical = document.getElementById('vertical')!;
  const horizontal = document.getElementById('horizontal')!;
  const box = (top: number, left: number) => ({ top, bottom: top + 20, left, right: left + 40, width: 40, height: 20 }) as DOMRect;
  for (const element of [owner, vertical, horizontal]) {
    element.style.overflowY = 'auto'; element.style.overflowX = 'auto';
    for (const [key, value] of Object.entries({ scrollHeight: 1000, scrollWidth: 1000, clientHeight: 100, clientWidth: 100 }))
      Object.defineProperty(element, key, { value });
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 100, left: 0, right: 100 } as DOMRect);
  }
  horizontal.style.overflowY = 'visible'; vertical.style.overflowX = 'visible';
  const range = document.createRange(); range.setStart(horizontal.firstChild!, 0); range.setEnd(horizontal.firstChild!, 6);
  range.getClientRects = () => [box(600 - horizontal.scrollTop - vertical.scrollTop, 800 - horizontal.scrollLeft - vertical.scrollLeft)] as unknown as DOMRectList;
  // The second wrapped fragment is wider than the first. Its right edge must
  // also be exposed (the real Markdown table reproducer clipped it by ~2px).
  range.getBoundingClientRect = () => ({ ...range.getClientRects()[0], right: 850 - horizontal.scrollLeft - vertical.scrollLeft }) as DOMRect;
  const scrollWindow = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
  scrollRangeIntoView(range, owner);
  expect(horizontal.scrollLeft).toBe(750); expect(vertical.scrollTop).toBe(520);
  expect(owner.scrollTop).toBe(0); expect(owner.scrollLeft).toBe(0);
  expect(scrollWindow).not.toHaveBeenCalled();
});
