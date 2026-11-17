// @vitest-environment jsdom
import { useRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThreadMessageWindow } from '../ThreadMessageWindow';

// jsdom supplies no viewport or scrolling. Keep the real virtualizer; provide only browser geometry.
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-thread-window-row') ? 160 : this.dataset.viewport ? 600 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(448);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(32000);
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: function (this: HTMLElement, options?: ScrollToOptions) {
    if (options && typeof options === 'object' && options.top !== undefined) this.scrollTop = options.top;
    this.dispatchEvent(new Event('scroll'));
  } });
});
afterEach(async () => {
  document.getSelection()?.removeAllRanges();
  cleanup();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)); });
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
});
const ids = Array.from({ length: 200 }, (_, index) => `reply-${index}`);
function List({ messages = ids, sharing = false, focus, onLocated = () => {} }: {
  messages?: string[]; sharing?: boolean; focus?: { messageId: string; nonce: number }; onLocated?: (id: string) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null), following = useRef(false);
  return <div ref={scroll} data-viewport="true"><ThreadMessageWindow
    items={messages.map(id => ({ key: id, messageId: id }))} scrollRef={scroll} following={following}
    sharing={sharing} focus={focus} onLocated={onLocated}
    renderItem={index => <article data-share-message-id={messages[index]}>{messages[index]}</article>} /></div>;
}
it('keeps long history available while mounting only a viewport window', async () => {
  const view = render(<List />);
  await waitFor(() => expect(view.container.querySelectorAll('article').length).toBeGreaterThan(0));
  expect(view.container.querySelectorAll('article').length).toBeLessThan(30);
  expect(screen.queryByText('reply-199')).toBeNull();
  const scroller = view.container.querySelector<HTMLElement>('[data-viewport]')!;
  act(() => { scroller.scrollTop = 30000; fireEvent.scroll(scroller); });
  await screen.findByText('reply-190');
  expect(view.container.querySelectorAll('article').length).toBeLessThan(30);
});
it('reveals a loaded but unmounted focus target without loading history again', async () => {
  const onLocated = vi.fn();
  render(<List focus={{ messageId: 'reply-175', nonce: 1 }} onLocated={onLocated} />);
  await waitFor(() => expect(onLocated).toHaveBeenCalledWith('reply-175', expect.any(HTMLElement)));
  expect(screen.getByText('reply-175')).toBeTruthy();
});
it('exposes all messages for sharing and restores the window when sharing ends', async () => {
  const view = render(<List sharing />);
  expect(view.container.querySelectorAll('article')).toHaveLength(200);
  view.rerender(<List />);
  await waitFor(() => expect(view.container.querySelectorAll('article').length).toBeLessThan(30));
});
it('retains DOM during native text selection and resumes windowing after it clears', async () => {
  const view = render(<List />);
  const range = document.createRange(); range.selectNodeContents(screen.getByText('reply-2'));
  act(() => { document.getSelection()!.addRange(range); document.dispatchEvent(new Event('selectionchange')); });
  expect(view.container.querySelectorAll('article')).toHaveLength(200);
  act(() => { document.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); });
  await waitFor(() => expect(view.container.querySelectorAll('article').length).toBeLessThan(30));
});
it('keeps the visible message when earlier messages are prepended', async () => {
  const view = render(<List />);
  const scroller = view.container.querySelector<HTMLElement>('[data-viewport]')!;
  act(() => { scroller.scrollTop = 16000; fireEvent.scroll(scroller); });
  await screen.findByText('reply-100');
  view.rerender(<List messages={['earlier-1', 'earlier-2', ...ids]} />);
  await waitFor(() => expect(scroller.scrollTop).toBe(16320));
  expect(screen.getByText('reply-100')).toBeTruthy();
});
