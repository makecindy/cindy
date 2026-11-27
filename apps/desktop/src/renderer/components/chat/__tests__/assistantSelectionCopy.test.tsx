// @vitest-environment jsdom
import { EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES } from "@/cindy-brain/PluginUiContributions";

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Tooltip } from '@/components/ui/tooltip';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'copy-test' } }) }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
// CI #13235: useAgentCapabilities rejects without maker IPC and updates error/loading
// after a synchronous test returns. Those updates can enqueue React scheduler work
// beyond jsdom teardown. Keep diagnostics visible and fail if mounting escapes act.
beforeEach(() => {
  vi.spyOn(console, 'error');
});
afterEach(async () => {
  try {
    await act(async () => { cleanup(); });
    expect(vi.mocked(console.error).mock.calls.filter(([message]) =>
      typeof message === 'string' && message.includes('not wrapped in act'),
    )).toEqual([]);
  } finally {
    vi.restoreAllMocks();
  }
});

import type { ClipboardEvent, ReactNode } from 'react';
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

async function copy(render_: (content: string) => Promise<HTMLElement>, pick: Pick) {
  const root = await render_(LIST);
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

// Await the real mounted component's initial effects and promise callbacks before
// selecting/copying. Do not replace the capability hook or React scheduler with mocks.
async function renderSettled(element: ReactNode): Promise<HTMLElement> {
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(element));
  });
  return container;
}

const renderAssistant = (content: string) =>
  renderSettled(
    <MemoryRouter>
      <Tooltip.Provider>
        <ConfirmDialogProvider>
          <AssistantMessage pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES} workingDir="/w" content={content} />
        </ConfirmDialogProvider>
      </Tooltip.Provider>
    </MemoryRouter>,
  );

const renderPlain = (content: string) =>
  renderSettled(<MarkdownRenderer workingDir="/w" content={content} />);

const items = (root: HTMLElement) => root.querySelectorAll('li');
const wholeItem2: Pick = (root) => {
  const li = items(root)[1];
  const linkText = li.querySelector('a')!.firstChild!;
  return [li.firstChild!, 0, linkText, linkText.textContent!.length];
};

describe('assistant reply copy', () => {
  it('writes the item without the list wrapper (#7416)', async () => {
    const { prevented, setData, html } = await copy(renderAssistant, wholeItem2);
    expect(prevented).toBe(true);
    expect(setData).toHaveBeenCalledWith('text/plain', 'beta link');
    expect(html).not.toMatch(/<\/?(ol|li)\b/);
  });

  it('keeps the link when only its text is selected', async () => {
    const { html } = await copy(renderAssistant, (root) => {
      const linkText = items(root)[1].querySelector('a')!.firstChild!;
      return [linkText, 0, linkText, 4];
    });
    expect(html).toMatch(/<a [^>]*href="https:\/\/example\.com"[^>]*>link<\/a>/);
  });

  it('leaves a multi-item selection to native copy', async () => {
    const { prevented, setData } = await copy(renderAssistant, (root) => [
      items(root)[0].firstChild!,
      0,
      items(root)[2].firstChild!,
      5,
    ]);
    expect(prevented).toBe(false);
    expect(setData).not.toHaveBeenCalled();
  });

  it('leaves a selection outside the reply DOM (portal preview) to native copy', async () => {
    const root = await renderAssistant(LIST);
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

  it('drops the zero-size link menu anchor inside the copied item (TextEdit line break)', async () => {
    // Rendered reply: each link renders a fixed, zero-size menu anchor beside it.
    const { html } = await copy(renderAssistant, (root) => {
      const li = items(root)[1];
      return [li, 0, li, li.childNodes.length];
    });
    expect(html).not.toContain('data-fixed-menu-anchor');
    expect(html).toMatch(/link<\/a>, <strong[^>]*>bold<\/strong>/);
  });

  it('leaves the same selection outside an assistant reply to native copy', async () => {
    const { prevented, setData } = await copy(renderPlain, wholeItem2);
    expect(prevented).toBe(false);
    expect(setData).not.toHaveBeenCalled();
  });
});
