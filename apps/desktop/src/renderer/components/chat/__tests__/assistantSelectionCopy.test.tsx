// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Tooltip } from '@/components/ui/tooltip';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'copy-test' } }) }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
afterEach(cleanup);

import type { ClipboardEvent } from 'react';
import { handleAssistantCopy } from '@/lib/assistantSelectionCopy';
import { AssistantMessage } from '../AssistantMessage';
import { MarkdownRenderer } from '../MarkdownRenderer';

// Production entry: AssistantMessage wires handleAssistantCopy on its wrapper, so copy events from
// the rendered reply reach it. Issue #7416: copying one list item put the <ol><li> wrapper into
// text/html, so Slack/TextEdit rebuilt an unselected number. PR #7785 review: link-only selections
// lost the <a>, and the rewrite must not run for other MarkdownRenderer callers.
// Unit/DOM tier. jsdom's Selection.toString() is textContent-like (unlike Chromium),
// so hard-break plain text stays a manual check.
const LIST = '1. alpha\n2. beta [link](https://example.com), **bold**\n3. gamma';

type Pick = (root: HTMLElement) => [Node, number, Node, number];

function copy(render_: (content: string) => HTMLElement, pick: Pick) {
  const root = render_(LIST);
  const [startNode, startOffset, endNode, endOffset] = pick(root);
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  const setData = vi.fn();
  const notPrevented = fireEvent.copy(root.querySelector('.msg-markdown')!, {
    clipboardData: { setData },
  });
  const html = setData.mock.calls.find(([type]) => type === 'text/html')?.[1] as string | undefined;
  return { prevented: !notPrevented, setData, html };
}

const renderAssistant = (content: string) =>
  render(
    <MemoryRouter>
      <Tooltip.Provider>
        <ConfirmDialogProvider>
          <AssistantMessage workingDir="/w" content={content} />
        </ConfirmDialogProvider>
      </Tooltip.Provider>
    </MemoryRouter>,
  ).container;

const renderPlain = (content: string) =>
  render(<MarkdownRenderer workingDir="/w" content={content} />).container;

const items = (root: HTMLElement) => root.querySelectorAll('li');
const wholeItem2: Pick = (root) => {
  const li = items(root)[1];
  const linkText = li.querySelector('a')!.firstChild!;
  return [li.firstChild!, 0, linkText, linkText.textContent!.length];
};

describe('assistant reply copy', () => {
  it('writes the item without the list wrapper (#7416)', () => {
    const { prevented, setData, html } = copy(renderAssistant, wholeItem2);
    expect(prevented).toBe(true);
    expect(setData).toHaveBeenCalledWith('text/plain', 'beta link');
    expect(html).not.toMatch(/<\/?(ol|li)\b/);
  });

  it('keeps the link when only its text is selected', () => {
    const { html } = copy(renderAssistant, (root) => {
      const linkText = items(root)[1].querySelector('a')!.firstChild!;
      return [linkText, 0, linkText, 4];
    });
    expect(html).toMatch(/<a [^>]*href="https:\/\/example\.com"[^>]*>link<\/a>/);
  });

  it('leaves a multi-item selection to native copy', () => {
    const { prevented, setData } = copy(renderAssistant, (root) => [
      items(root)[0].firstChild!,
      0,
      items(root)[2].firstChild!,
      5,
    ]);
    expect(prevented).toBe(false);
    expect(setData).not.toHaveBeenCalled();
  });

  it('leaves a selection outside the reply DOM (portal preview) to native copy', () => {
    const root = renderAssistant(LIST);
    const [startNode, startOffset, endNode, endOffset] = wholeItem2(root);
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    const setData = vi.fn();
    const preventDefault = vi.fn();
    // A React portal event: currentTarget is the wrapper, but the selected DOM lives elsewhere.
    const portalHost = document.createElement('div');
    document.body.appendChild(portalHost);
    try {
      handleAssistantCopy({
        currentTarget: portalHost,
        clipboardData: { setData },
        preventDefault,
      } as unknown as ClipboardEvent<HTMLElement>);
      expect(setData).not.toHaveBeenCalled();
      expect(preventDefault).not.toHaveBeenCalled();
    } finally {
      portalHost.remove();
      window.getSelection()!.removeAllRanges();
    }
  });

  it('drops the zero-size link menu anchor inside the copied item (TextEdit line break)', () => {
    // Rendered reply: each link renders a fixed, zero-size menu anchor beside it.
    const { html } = copy(renderAssistant, (root) => {
      const li = items(root)[1];
      return [li, 0, li, li.childNodes.length];
    });
    expect(html).not.toContain('data-fixed-menu-anchor');
    expect(html).toMatch(/link<\/a>, <strong[^>]*>bold<\/strong>/);
  });

  it('leaves the same selection outside an assistant reply to native copy', () => {
    const { prevented, setData } = copy(renderPlain, wholeItem2);
    expect(prevented).toBe(false);
    expect(setData).not.toHaveBeenCalled();
  });
});
