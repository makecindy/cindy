// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import katex from 'katex';
import { File } from 'lucide-react';
import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';
import { MessageActionBar, BubbleHoverToolbar } from '../MessageActionBar';
import { installKatexClipboardStyles, installRendererClipboardStyles, installRendererSelectionStyles as productionSelectionCss } from '../../../../test/vitest/rendererSelectionStyles';
import { InlineReferenceChip } from '../InlineReferenceChip';
import { copyChatSelection } from '../chatSelectionClipboard';
import { CopyAsImageBlock } from '../CopyAsImageBlock';
import { RichAnswer } from '../RichAnswer';
import { ChatVideoView } from '../ChatVideoView';
import { ChatAudioCard } from '../ChatAudioCard';
import { ChatSoundEffectCard } from '../ChatSoundEffectCard';
import { ChatImageView } from '../ChatImageView';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { MarkdownMermaidBlock } from '../MarkdownMermaidBlock';
import { UserMessageImageLink } from '../UserMessageImageLink';
import { GeneratedFilesCard, _clearLocalGeneratedFileStatCache } from '../GeneratedFilesCard';
import { SystemCard } from '../SystemCard';
import { BotAvatar } from '../../../features/bots/BotAvatar';
import { VideoSitePreview } from '../VideoSitePreview';
import { GhostSummonCard } from '../GhostSummonCard';

// Other SystemCard variants are unrelated to the context header under test.
vi.mock('@/features/bots/useRemoteBots', () => ({ useRemoteBots: () => [] }));
vi.mock('@/features/bots/BotCollaborationCard', () => ({
  BotSessionTaskCard: () => null, BotSessionTaskMessageTrace: () => null,
}));
vi.mock('@/features/learn/LearnStatusCard', () => ({ LearnStatusCard: () => null }));

const { taskLink } = vi.hoisted(() => ({ taskLink: vi.fn() }));

// Isolate task/plugin live stores, while testing their actual presentation below.
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({ useInstalledGhosts: () => [{
  manifest: { id: 'clipboard-plugin', name: 'Clipboard plugin' }, namespace: null, instanceKey: '_root__clipboard-plugin',
  iconDataUrl: 'https://example.com/plugin.png',
}] }));
vi.mock('@/cindy-brain/ghostUnreadStore', () => ({ useElementVisible: () => ({ ref: () => {}, visible: false }) }));
vi.mock('@/features/bots/BotSessionTaskLink', () => ({ useBotTaskSession: () => taskLink() ?? ({
  resolved: true, targetId: null, row: null, session: null, activity: null,
}) }));
vi.mock('@/contexts/PrRefsContext', () => ({
  usePrActions: () => ({}), usePrRefsForSession: () => [],
  usePrStatuses: () => ({ statuses: new Map(), successfulStatuses: new Map() }),
}));

// Isolate filesystem lookup; FileTargetChip itself is rendered by Markdown.
vi.mock('@/lib/localPathResolver', async original => ({
  ...(await original<typeof import('@/lib/localPathResolver')>()),
  peekResolveLocalPathSmart: (path: string) => path === '/tmp/clipboard-note.ts'
    ? { status: 'unique', absPath: path, kind: 'file' } : undefined,
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'clipboard-owner' } }) }));
vi.mock('@/hooks/useRemoteMediaUrl', () => ({ useRemoteMediaUrl: (url: string) => url }));
// Isolate the external drawing engine, not the production diagram wrapper.
vi.mock('mermaid', () => ({ default: {
  initialize: vi.fn(), parse: vi.fn().mockResolvedValue(true),
  render: vi.fn().mockResolvedValue({ svg: '<svg width="3000" height="2000" viewBox="0 0 3000 2000"><path d="M0 0L20 20" style="fill:none;stroke:purple"/><text>diagram label</text></svg>' }),
} }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
// The upstream inline player observes visibility; jsdom has no layout observer.
// Keep the real player and copy handler, isolating only the browser layout API.
vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });

vi.mock('../useCopyAsImage', () => ({
  useCopyAsImage: () => ({ copiedImage: false, copyAsImage: vi.fn(), canAnnotate: true, openAnnotate: vi.fn(), annotateNode: null }),
}));
vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ i18n: { language: 'en' }, t: (key: string, vars?: { count?: unknown }) => vars?.count === undefined ? key : `${key}:${vars.count}` }) }));

// Regression: selecting chat text and copying to a rich-text editor carries
// Cindy's background/theme. Existing copy-button tests do not exercise native
// selection copy. This unit suite dispatches copy through the production handler
// and checks the exported clipboard formats and the native-copy fallbacks.
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
  taskLink.mockReset();
  document.querySelectorAll('style[data-copy-test]').forEach(style => style.remove());
});

function setup(content: string | React.ReactNode) {
  const view = render(typeof content === 'string'
    ? <div onCopy={copyChatSelection} dangerouslySetInnerHTML={{ __html: content }} />
    : <div onCopy={copyChatSelection}>{content}</div>);
  const root = view.container.firstElementChild!;
  const select = (start: Node = root, end?: Node) => {
    const range = document.createRange();
    if (end) {
      range.setStart(start, 0);
      range.setEnd(end, end.textContent!.length);
    } else {
      range.selectNodeContents(start);
    }
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
  };
  const copy = (target: Element = root) => {
    const clipboardData = { setData: vi.fn() };
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: clipboardData });
    fireEvent(target, event);
    return { event, clipboardData };
  };
  return { root, select, copy };
}

describe('chat selection clipboard', () => {
  // Review #4367801832: existing tool/card cases miss message-level chrome.
  // Unit: render the actual action bar, select across it, and export through
  // production copy. Time/cost/token state must stay out of both formats,
  // including visible/fading bars; selected message text must remain.
  it.each([true, false].flatMap(money => [1, 0.5, 0].map(opacity => ({ money, opacity }))))('omits message action metadata (money=$money, opacity=$opacity)', ({ money, opacity }) => {
    productionSelectionCss();
    const { root, select, copy } = setup(<TooltipProvider><p>Message body</p>
      <MessageActionBar copyText="Message body" align="left" hovered
        createdAt={new Date(Date.now() - 180_000).toISOString()}
        turnMoney={money ? { currency: 'USD', amount: 0.03, approximate: false, kind: 'actual-cost' } : undefined}
        turnUsageDetails={{ inputTokens: 12000, outputTokens: 300, cacheReadTokens: 0, cacheCreateTokens: 0, totalTokens: 12300, cacheHitRate: 0 }} />
      <p>Next message</p></TooltipProvider>);
    const time = root.querySelector('time')!;
    const bar = time.closest('[data-share-exclude]') as HTMLElement;
    bar.style.opacity = String(opacity);
    const metadata = money ? '$0.03' : 'chat.messageActionBar.turnTokens';
    expect(time.textContent).toBeTruthy();
    expect(bar.textContent).toContain(metadata);
    select();
    const formats = copy().clipboardData.setData.mock.calls;
    expect(formats.map(([format]) => format).sort()).toEqual(['text/html', 'text/plain']);
    for (const [, value] of formats) {
      expect(value).toContain('Message body');
      expect(value).toContain('Next message');
      expect(value).not.toContain(time.textContent!);
      expect(value).not.toContain(metadata);
    }
    // The common selection ancestor may itself be inside the excluded bar.
    select(time.firstChild!);
    const excluded = copy();
    expect(excluded.event.defaultPrevented).toBe(true);
    expect(excluded.clipboardData.setData).toHaveBeenCalledTimes(2);
    expect(excluded.clipboardData.setData.mock.calls.every(([, value]) => value === '')).toBe(true);
  });

  it('omits the open production bubble toolbar frame and its non-button chrome', () => {
    const { root, select, copy } = setup(<><p>Message body</p>
      <BubbleHoverToolbar side="left" open><span>Bubble toolbar status</span></BubbleHoverToolbar>
      <p>Next message</p></>);
    const frame = root.querySelector('[data-share-exclude]') as HTMLElement;
    frame.style.opacity = '1';
    expect(frame.textContent).toBe('Bubble toolbar status');
    select();
    const formats = copy().clipboardData.setData.mock.calls;
    expect(formats).toHaveLength(2);
    for (const [, value] of formats) {
      expect(value).toContain('Message body');
      expect(value).toContain('Next message');
      expect(value).not.toContain('Bubble toolbar status');
    }
  });

  // Reviews #4360500198/#4360500214: copy the real task status and
  // unmarked video/plugin images; existing gallery fixtures miss these paths.
  it('omits the production screen-reader status without dropping the task title', async () => {
    const { BotTaskCard } = await vi.importActual<typeof import('@/features/bots/BotCollaborationCard')>('@/features/bots/BotCollaborationCard');
    const { root, select, copy } = setup(<><p>before task</p>
      <BotTaskCard card={{ role: 'delegation-request', objective: 'Task title' } as React.ComponentProps<typeof BotTaskCard>['card']} />
      <p>after task</p></>);
    expect(root.querySelector('.sr-only')?.textContent).toBe('bots.collab.status.unknown');
    select();
    const formats = copy().clipboardData.setData.mock.calls;
    for (const [, value] of formats) {
      expect(value).not.toContain('bots.collab.status.unknown');
      expect(value).toContain('Task title');
      expect(value).toContain('after task');
    }
    const status = root.querySelector('.sr-only')!;
    expect(status).toBeTruthy();
    select(status.firstChild!);
    expect(copy().clipboardData.setData.mock.calls.every(([, value]) => value === '')).toBe(true);
  });

  // Review #4360830856: live/completed task actions are application controls,
  // while the title and expanded result remain selectable message content.
  it.each(['running', 'waiting', 'completed'].flatMap(state => [false, true].map(selectText => ({ state, selectText }))))('omits production task action chips ($state, select-text=$selectText)', async ({ state, selectText }) => {
    productionSelectionCss();
    taskLink.mockReturnValue({
      resolved: true, targetId: 'child-task', open: vi.fn(), session: null, activity: null,
      row: { status: state, createdAt: Date.now(), completedAt: null, artifacts: [], resultSummary: 'Task result' },
    });
    const { BotTaskCard } = await vi.importActual<typeof import('@/features/bots/BotCollaborationCard')>('@/features/bots/BotCollaborationCard');
    const { root, select, copy } = setup(<><p>before task</p>
      <BotTaskCard sessionId="parent-task" card={{ role: 'delegation-request', objective: 'Task title' } as React.ComponentProps<typeof BotTaskCard>['card']} />
      <p>after task</p></>);
    root.classList.toggle('select-text', selectText);
    const buttons = [...root.querySelectorAll('button')];
    expect(buttons.some(button => button.textContent?.includes(state === 'waiting' ? 'bots.collab.lookAt' : 'bots.collab.watchWork'))).toBe(true);
    const action = buttons.find(button => button.textContent?.includes(state === 'waiting' ? 'bots.collab.lookAt' : 'bots.collab.watchWork'))!;
    expect(getComputedStyle(action).userSelect).toBe(selectText ? 'text' : 'none');
    if (state === 'running') {
      expect(buttons.some(button => button.textContent?.includes('bots.collab.addNote'))).toBe(true);
      expect(buttons.some(button => button.textContent?.includes('bots.collab.stop'))).toBe(true);
    }
    if (state === 'completed') fireEvent.click(buttons.find(button => button.textContent?.includes('bots.collab.expandResult'))!);
    select();
    const formats = copy().clipboardData.setData.mock.calls;
    expect(formats).toHaveLength(2);
    for (const [, value] of formats) {
      expect(value).not.toMatch(/bots\.collab\.(?:lookAt|watchWork|addNote|stop|expandResult|collapseResult)/);
      expect(value).toContain('Task title');
      expect(value).toContain('after task');
      if (state === 'completed') expect(value).toContain('Task result');
    }
    const html = formats.find(([type]) => type === 'text/html')![1];
    const pasted = document.createElement('div');
    pasted.innerHTML = html;
    // Running retains its adjacent status glyph, but no action-row icons.
    expect(pasted.querySelectorAll('svg')).toHaveLength(state === 'running' ? 1 : 0);
    // Excluding copy must not remove or disable the original task actions.
    expect(root.querySelectorAll('button').length).toBeGreaterThan(1);
  });

  it('keeps production video poster proportions and plugin avatar bounds', async () => {
    const { root, select, copy } = setup(<><p>before previews</p>
      <VideoSitePreview src="https://www.youtube.com/watch?v=dQw4w9WgXcQ" title="Video poster" />
      <GhostSummonCard directive={{ kind: 'mention', ghosts: [{ name: 'Clipboard plugin', ghostId: '_root__clipboard-plugin' }], raw: '' }} />
      <p>after previews</p></>);
    // Actual production utilities own sizes; do not overwrite component output.
    const poster = root.querySelector('img[alt="Video poster"]') as HTMLImageElement;
    const avatar = root.querySelector('img[src="https://example.com/plugin.png"]') as HTMLImageElement;
    expect(poster).toBeTruthy();
    expect(avatar).toBeTruthy();
    await installRendererClipboardStyles(root);
    select();
    const pasted = document.createElement('div');
    pasted.innerHTML = copy().clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')![1];
    const copiedPoster = pasted.querySelector('img[alt="Video poster"]') as HTMLImageElement;
    expect(copiedPoster.style.width).toBe('100%');
    expect(copiedPoster.style.aspectRatio).toBe('16 / 9');
    expect(copiedPoster.style.objectFit).toBe('contain');
    const copiedAvatar = pasted.querySelector('img[src="https://example.com/plugin.png"]') as HTMLImageElement;
    expect(copiedAvatar.style.width).toBe('14px');
    expect(copiedAvatar.style.height).toBe('14px');
    expect(pasted.querySelector('button')).toBeNull();
    expect(pasted.textContent).toContain('after previews');
  });

  // Review #4361430969: other clickable content wrappers are not inline chips.
  // Keep their labels/code and real links, but no detached activation semantics.
  it.each([false, true])('copies actual file/image paths as inert content (global CSS=%s)', async (globalCss) => {
    if (globalCss) productionSelectionCss();
    const { root, select, copy } = setup(<><p>before paths</p>
      <MarkdownRenderer workingDir="/tmp" content="`/tmp/clipboard-note.ts`" />
      <UserMessageImageLink path="/tmp/clipboard-image.png" onOpen={vi.fn()} />
      <a href="https://example.com/source">Source</a><p>after paths</p></>);
    await waitFor(() => expect(root.querySelector('code[role="button"]')).toBeTruthy());
    expect(root.querySelectorAll('[role="button"][tabindex="0"]')).toHaveLength(2);
    select();
    const formats = copy().clipboardData.setData.mock.calls;
    expect(formats).toHaveLength(2);
    for (const [, value] of formats) {
      expect(value).toContain('/tmp/clipboard-note.ts');
      expect(value).toContain('/tmp/clipboard-image.png');
      expect(value).toContain('after paths');
    }
    const pasted = document.createElement('div');
    pasted.innerHTML = formats.find(([type]) => type === 'text/html')![1];
    expect(pasted.querySelector('code')?.textContent).toContain('/tmp/clipboard-note.ts');
    expect(pasted.querySelector('[role="button"], [tabindex]')).toBeNull();
    expect(pasted.querySelector('a')?.getAttribute('href')).toBe('https://example.com/source');
    expect(root.querySelectorAll('[role="button"][tabindex="0"]')).toHaveLength(2);
  });

  // Review #4361701135: file delivery labels live in content buttons too.
  it('copies actual generated document and image labels under global control CSS', async () => {
    productionSelectionCss();
    const previous = window.electronAPI;
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
      ...previous, fsBrowse: { statPath: vi.fn(async () => ({ kind: 'file', birthtimeMs: 2000, mtimeMs: 2000 })) },
    } });
    _clearLocalGeneratedFileStatCache();
    try {
      const { root, select, copy } = setup(<><p>before generated</p>
        <GeneratedFilesCard botArtifacts turnStartMs={1000} turnEndMs={5000} files={[
          { path: '/workspace/report.pdf', name: 'report.pdf', source: 'tool', artifact: {
            format: 'pdf', title: 'Quarterly report', summary: { kind: 'pages', value: 3 },
          } },
          { path: '/workspace/preview.png', name: 'preview.png', source: 'tool' },
        ]} /><p>after generated</p></>);
      await waitFor(() => expect(root.querySelector('button[title="/workspace/report.pdf"]:not(:disabled)')).toBeTruthy());
      expect(root.querySelector('button[title="/workspace/preview.png"]')).toBeTruthy();
      // Review4434278361: compile actual block/flex/gap utilities before copy.
      await installRendererClipboardStyles(root);
      select();
      const formats = copy().clipboardData.setData.mock.calls;
      for (const [, value] of formats) {
        for (const label of ['Quarterly report', 'report.pdf', 'preview.png', 'chat.generatedFiles.formats.pdf', 'chat.generatedFiles.summary.pages:3', 'after generated']) expect(value).toContain(label);
      }
      const pasted = document.createElement('div');
      pasted.innerHTML = formats.find(([type]) => type === 'text/html')![1];
      expect(pasted.querySelector('button, [role="button"], [tabindex]')).toBeNull();
      // Unit: title and metadata must remain separate after stripping layout;
      // both clipboard formats retain authored content boundaries.
      for (const value of [pasted.textContent!, formats.find(([type]) => type === 'text/plain')![1]]) {
        expect(value).toMatch(/Quarterly report\s+chat\.generatedFiles\.formats\.pdf/);
        expect(value).toContain('chat.generatedFiles.formats.pdf · chat.generatedFiles.summary.pages:3 · report.pdf');
        expect(value).not.toContain('chat.generatedFiles.formats.pdfchat.generatedFiles.summary.pages:3');
      }
      expect(root.querySelector('button[title="/workspace/report.pdf"]')).toBeTruthy();
    } finally {
      Object.defineProperty(window, 'electronAPI', { configurable: true, value: previous });
      _clearLocalGeneratedFileStatCache();
    }
  });

  // Review #4359931559: the real bar renderer uses empty div geometry rather
  // than SVG. Copy-entry unit regression protects signed/zero widths and paint;
  // existing vector/line coverage does not reach this production branch.
  it('retains production bar geometry with destination ink and explicit paint', () => {
    const source = JSON.stringify({ version: 1, seq: 1, op: 'create', id: 'bars', kind: 'chart', props: {
      label: 'Balances', variant: 'bar', colors: ['primary', 'success', 'primary'],
      data: [{ label: 'Loss', value: -5 }, { label: 'Gain', value: 10 }, { label: 'Even', value: 0 }],
    } });
    const { root, select, copy } = setup(<><p>before bars</p>
      <RichAnswer stateKey="clipboard-bars" source={source} complete renderMarkdown={text => <span>{text}</span>} />
      <p>after bars</p></>);
    select();
    const pasted = document.createElement('div');
    pasted.innerHTML = copy().clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')![1];
    const tracks = [...pasted.querySelectorAll('svg[data-chat-rich-bar]')];
    expect(tracks).toHaveLength(3);
    const bars = tracks.map(track => track.firstElementChild!);
    expect(bars.every(Boolean)).toBe(true);
    expect(bars.map(bar => bar.getAttribute('width'))).toEqual(['33.33333333333333%', '66.66666666666666%', '0%']);
    expect(bars.map(bar => bar.getAttribute('x'))).toEqual(['0%', '33.33333333333333%', '33.33333333333333%']);
    expect(bars[0].getAttribute('fill')).toBe('currentColor');
    expect(bars[1].getAttribute('fill')).toBe(getComputedStyle(root.querySelectorAll('.rich-answer-track > div')[1]).backgroundColor);
    expect(pasted.textContent).toContain('Loss');
    expect(pasted.textContent).toContain('Gain');
    expect(pasted.textContent).toContain('after bars');
  });

  // Review #4359639062: media-only button unwrapping misses selectable card
  // summaries. Render the actual context card and copy across its header;
  // unit/jsdom verifies plain summary content without a dead pasted button.
  it.each([false, true])('copies a production context header with boundaries (header only=%s)', async headerOnly => {
    productionSelectionCss();
    const { root, select, copy } = setup(<>
      <p>before context</p>
      <SystemCard cardType="context" data={{ usage: {
        categories: [], totalTokens: 1000, maxTokens: 10000,
        rawMaxTokens: 10000, percentage: 10, model: 'test-model',
      } }} />
      <button data-chat-copy-exclude>Control action</button>
      <p>after context</p>
    </>);
    const header = root.querySelector('button[aria-expanded]')!;
    // Review4434400851: real gap-2, no JSX whitespace between labels.
    await installRendererClipboardStyles(root);
    const labels = [...header.querySelectorAll(':scope > span')].map(e => e.textContent!);
    expect(labels).toHaveLength(2);
    const summary = labels.join(' ');
    if (headerOnly) {
      // Review4434554285: drag between text leaves so common ancestor is button.
      const range = document.createRange();
      range.setStart(header.querySelector(':scope > span')!.firstChild!, 0);
      const last = header.querySelectorAll(':scope > span')[1].firstChild!;
      range.setEnd(last, last.textContent!.length);
      window.getSelection()!.addRange(range);
      expect(range.commonAncestorContainer).toBe(header);
    } else select();
    const { clipboardData } = copy();
    const html = clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')![1];
    const plain = clipboardData.setData.mock.calls.find(([type]) => type === 'text/plain')![1];
    const pasted = document.createElement('div');
    pasted.innerHTML = html;
    expect(pasted.querySelector('button')).toBeNull();
    expect(pasted.textContent).toContain(summary);
    expect(plain).toContain(summary);
    expect(pasted.textContent).not.toContain('Control action');
    expect(plain).not.toContain('Control action');
    if (headerOnly) {
      expect(pasted.textContent).not.toMatch(/before context|after context/);
    } else {
      expect(pasted.textContent).toContain('before context');
      expect(pasted.textContent).toContain('after context');
    }
    expect(header.isConnected).toBe(true);
    expect(header.getAttribute('aria-expanded')).toBe('false');
  });

  // Review4434400853: unit through the real decorative BotAvatar between
  // message bodies; a real message attachment remains copyable alongside it.
  it.each([false, true])('omits decorative bot artwork without losing content images (select-text=%s)', async selectable => {
    productionSelectionCss();
    const { root, select, copy } = setup(<div className={selectable ? 'select-text' : undefined}><p>first message body</p>
      <BotAvatar bot={{ name: 'Bot', avatar: 'https://example.com/bot-artwork.png' }} size="sm" />
      <p>second message body</p>
      <ChatImageView src="https://example.com/content.png" filename="Content attachment" variant="user-attached" />
    </div>);
    const avatar = root.querySelector('img[src="https://example.com/bot-artwork.png"]')!;
    expect(avatar.closest('[aria-hidden="true"]')).toBeTruthy();
    expect(getComputedStyle(avatar).userSelect).toBe(selectable ? 'text' : 'none');
    fireEvent.load(root.querySelector('img[alt="Content attachment"]')!);
    await waitFor(() => expect((root.querySelector('img[alt="Content attachment"]') as HTMLImageElement).style.display).not.toBe('none'));
    select();
    const formats = copy().clipboardData.setData.mock.calls;
    const pasted = document.createElement('div');
    pasted.innerHTML = formats.find(([type]) => type === 'text/html')![1];
    expect(pasted.querySelector('img[src="https://example.com/bot-artwork.png"]')).toBeNull();
    expect(pasted.querySelector('img[alt="Content attachment"]')).toBeTruthy();
    for (const value of [pasted.textContent!, formats.find(([type]) => type === 'text/plain')![1]]) {
      expect(value).toContain('first message body');
      expect(value).toContain('second message body');
    }
  });

  // Review #4334258580: real RichAnswer shapes/chart store presentation in
  // inline styles and CSS. Unit/jsdom copy-entry regression, alongside the
  // existing real reference-chip test that protects decorative SVG filtering.
  it('exports portable presentation from production RichAnswer vectors and line charts', () => {
    const source = [
      { id: 'vector', kind: 'svg', props: { label: 'Drawing', viewBox: [0, 0, 20, 20], shapes: [
        { type: 'rect', x: 0, y: 0, width: 10, height: 10, fill: 'success', stroke: 'primary' },
      ] } },
      { id: 'chart', kind: 'chart', props: { label: 'Trend', variant: 'line', data: [
        { label: 'A', value: 1 }, { label: 'B', value: 3 },
      ] } },
    ].map((node, index) => JSON.stringify({ version: 1, seq: index + 1, op: 'create', ...node })).join('\n');
    const { root, select, copy } = setup(<>
      <style>{'.rich-answer-chart-guide {stroke: rgb(120, 120, 120)}'}</style>
      <p>before drawing</p>
      <RichAnswer stateKey="clipboard-drawings" source={source} complete renderMarkdown={text => <span>{text}</span>} />
      <p>after drawing</p>
    </>);
    const originalRect = root.querySelector('rect')!;
    const originalLine = root.querySelector('polyline')!;
    expect(originalRect).toBeTruthy();
    expect(originalLine).toBeTruthy();
    select();
    const pasted = document.createElement('div');
    pasted.innerHTML = copy().clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')![1];
    pasted.querySelectorAll('style').forEach(style => style.remove());
    expect((pasted.querySelector('rect') as SVGElement).style.fill).toBe((originalRect as SVGElement).style.fill);
    expect((pasted.querySelector('rect') as SVGElement).style.stroke).toBe('currentcolor');
    expect((pasted.querySelector('polyline') as SVGElement).style.fill).toBe('none');
    expect((pasted.querySelector('polyline') as SVGElement).style.stroke).toBe('currentcolor');
    expect((pasted.querySelector('line') as SVGElement).style.stroke).toBe('currentcolor');
    const chart = pasted.querySelector('svg[data-chat-rich-svg="chart"]') as SVGElement;
    expect(chart.style.width).toBe('100%');
    expect(chart.style.maxWidth).toBe('100%');
    expect(pasted.textContent).toContain('before drawing');
    expect(pasted.textContent).toContain('after drawing');
  });

  // Review4434278365: unit through real RichAnswer props.style, not a raw
  // SVG fixture. Explicit author typography survives; inherited host fonts do not.
  it('preserves explicit vector font geometry without freezing inherited theme fonts', () => {
    const source = [
      { id: 'sized', kind: 'svg', props: { label: 'Sized lettering', viewBox: [0, 0, 200, 100], style: {
        fontSize: 36, letterSpacing: 2, fontWeight: 600,
      }, shapes: [{ type: 'text', x: 5, y: 45, text: 'Hello' }] } },
      { id: 'neutral', kind: 'svg', props: { label: 'Inherited lettering', viewBox: [0, 0, 200, 100],
        shapes: [{ type: 'text', x: 5, y: 45, text: 'World' }] } },
    ].map((node, index) => JSON.stringify({ version: 1, seq: index + 1, op: 'create', ...node })).join('\n');
    const { root, select, copy } = setup(<div style={{ fontSize: 19, letterSpacing: 5, fontFamily: 'SourceTheme' }}>
      <RichAnswer stateKey="explicit-svg-typography" source={source} complete renderMarkdown={text => <span>{text}</span>} />
    </div>);
    expect((root.querySelector('svg[aria-label="Sized lettering"]') as SVGElement).style.fontSize).toBe('36px');
    select();
    const pasted = document.createElement('div');
    pasted.innerHTML = copy().clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')![1];
    const sized = pasted.querySelector('svg[aria-label="Sized lettering"]') as SVGElement;
    expect(sized.style.fontSize).toBe('36px');
    expect(sized.style.letterSpacing).toBe('2px');
    expect(sized.style.fontWeight).toBe('600');
    const neutral = pasted.querySelector('svg[aria-label="Inherited lettering"]') as SVGElement;
    expect(neutral.style.fontSize).toBe('');
    expect(neutral.style.letterSpacing).toBe('');
    expect(pasted.innerHTML).not.toContain('SourceTheme');
  });

  // Review4434334651: real props.style.color colors currentColor shapes
  // from the SVG root. Unit: retain semantic ink; neutral/host ink stays portable.
  it.each(['success', 'warning', 'danger'] as const)('keeps explicit %s vector ink without copying neutral host color', role => {
    const source = [
      { id: 'semantic', kind: 'svg', props: { label: 'Semantic ink', viewBox: [0, 0, 20, 20],
        style: { color: role }, shapes: [{ type: 'rect', width: 10, height: 10 }] } },
      { id: 'neutral', kind: 'svg', props: { label: 'Neutral ink', viewBox: [0, 0, 20, 20],
        style: { color: 'primary' }, shapes: [{ type: 'rect', width: 10, height: 10 }] } },
      { id: 'inherited', kind: 'svg', props: { label: 'Inherited ink', viewBox: [0, 0, 20, 20],
        shapes: [{ type: 'rect', width: 10, height: 10 }] } },
    ].map((node, index) => JSON.stringify({ version: 1, seq: index + 1, op: 'create', ...node })).join('\n');
    const { root, select, copy } = setup(<div style={{ color: 'white' }}><p>before ink</p>
      <RichAnswer stateKey={'root-ink-' + role} source={source} complete renderMarkdown={text => <span>{text}</span>} />
      <p>after ink</p></div>);
    const original = root.querySelector('svg[aria-label="Semantic ink"]') as SVGElement;
    expect(original.style.color).toBe({ success: 'var(--status-success)', warning: 'var(--warning-fg)', danger: 'var(--error-fg)' }[role]);
    select();
    const pasted = document.createElement('div');
    pasted.innerHTML = copy().clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')![1];
    expect((pasted.querySelector('svg[aria-label="Semantic ink"]') as SVGElement).style.color).toBe(getComputedStyle(original).color);
    for (const label of ['Neutral ink', 'Inherited ink']) {
      expect((pasted.querySelector('svg[aria-label="' + label + '"]') as SVGElement).style.color).toBe('');
    }
    expect(pasted.innerHTML).not.toMatch(/color:\s*white|var\(--text-/);
  });

  // Review #4334592398: RichAnswer role colors come from the host theme,
  // unlike Mermaid's drawing stylesheet. A dark-source/light-target paste
  // must inherit target ink while explicit semantic drawing colors survive.
  it('keeps RichAnswer theme ink adaptable without losing explicit drawing paints', () => {
    const source = [
      { id: 'vector', kind: 'svg', props: { viewBox: [0, 0, 20, 20], shapes: [
        { type: 'rect', width: 10, height: 10, fill: 'primary', stroke: 'secondary' },
        { type: 'circle', cx: 15, cy: 15, r: 2, fill: 'success', stroke: 'none' },
      ] } },
      { id: 'chart', kind: 'chart', props: { label: 'Trend', variant: 'line', color: 'primary', data: [
        { label: 'A', value: 1 }, { label: 'B', value: 3 },
      ] } },
    ].map((node, index) => JSON.stringify({ version: 1, seq: index + 1, op: 'create', ...node })).join('\n');
    const { root, select, copy } = setup(<div style={{ color: 'white', fontFamily: 'SourceTheme' }}>
      <p>before</p>
      <RichAnswer stateKey="portable-ink" source={source} complete renderMarkdown={text => <span>{text}</span>} />
      <p>after</p>
    </div>);
    select();
    const pasted = document.createElement('div');
    pasted.innerHTML = copy().clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')![1];
    expect((pasted.querySelector('rect') as SVGElement).style.fill).toBe('currentcolor');
    expect((pasted.querySelector('rect') as SVGElement).style.stroke).toBe('currentcolor');
    expect((pasted.querySelector('circle') as SVGElement).style.fill).toBe(getComputedStyle(root.querySelector('circle')!).fill);
    expect((pasted.querySelector('circle') as SVGElement).style.stroke).toBe('none');
    expect((pasted.querySelector('polyline') as SVGElement).style.fill).toBe('none');
    expect((pasted.querySelector('polyline') as SVGElement).style.stroke).toBe('currentcolor');
    expect((pasted.querySelector('line') as SVGElement).style.stroke).toBe('currentcolor');
    expect(pasted.innerHTML).not.toMatch(/SourceTheme|color:\s*(?:white|rgb)|var\(--(?:text|border)-/);
  });

  // Review #4334258590: hand-built marker fixtures cannot catch production
  // integration drift. Render the actual four media components; mock only
  // remote URL resolution/drawing and export effects. Assert copied behavior,
  // not marker spellings or JSX/source text (unit/jsdom tier).
  it('copies real media components without preview controls or lost drawing/image presentation', async () => {
    productionSelectionCss();
    const { root, select, copy } = setup(<>
      <style>{'.object-cover { object-fit: cover; } .object-contain { object-fit: contain; } .hidden { display: none; }'}</style>
      <p>before media</p>
      <ChatImageView src="https://example.com/attachment.png" filename="Attachment" variant="user-attached" />
      <ChatImageView src="https://example.com/tool.png" filename="Tool image" variant="tool-output" />
      <ChatVideoView src="https://example.com/clip.mp4" filename="clip.mp4" variant="tool-output" />
      <ChatAudioCard track={{ kind: 'music', audioUrl: 'https://example.com/song.mp3', coverUrl: 'https://example.com/cover.png', title: 'Song title', tags: 'Ambient', lyrics: '', durationSeconds: 30 }} />
      <ChatSoundEffectCard track={{ kind: 'sound_effect', audioUrl: 'https://example.com/effect.mp3', coverUrl: '', title: 'Rain sound', tags: '', lyrics: '', durationSeconds: 30 }} />
      <MarkdownRenderer workingDir="" content="![Photo](https://example.com/photo.png)" />
      <MarkdownMermaidBlock raw="graph TD; A-->B" />
      <p>after media</p>
    </>);
    fireEvent.load(root.querySelector('img[alt="Photo"]')!);
    fireEvent.load(root.querySelector('img[alt="Attachment"]')!);
    fireEvent.load(root.querySelector('img[alt="Tool image"]')!);
    await waitFor(() => expect(root.querySelector('path[d="M0 0L20 20"]')).toBeTruthy());
    await installRendererClipboardStyles(root);
    select();
    const { clipboardData } = copy();
    const pasted = document.createElement('div');
    pasted.innerHTML = clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')![1];
    // Review #4360233963: loaded ChatImageView images own their preview bounds.
    const attachment = pasted.querySelector('img[alt="Attachment"]') as HTMLImageElement;
    const toolImage = pasted.querySelector('img[alt="Tool image"]') as HTMLImageElement;
    expect(attachment.style.maxWidth).toBe('280px');
    expect(attachment.style.maxHeight).toBe('180px');
    expect(attachment.style.objectFit).toBe('contain');
    expect(toolImage.style.maxWidth).toBe('min(100%, 50vw, 480px)');
    expect(toolImage.style.maxHeight).toBe('min(40vh, 420px)');
    expect(toolImage.style.height).toBe('auto');
    expect(toolImage.style.objectFit).toBe('contain');
    expect(pasted.querySelector('video, [role="button"], button')).toBeNull();
    const photo = pasted.querySelector('img[alt="Photo"]') as HTMLImageElement;
    expect(photo).toBeTruthy();
    expect(photo.style.maxWidth).toBe('min(100%, 50vw, 480px)');
    const cover = pasted.querySelector('img[src="https://example.com/cover.png"]') as HTMLImageElement;
    expect(cover).toBeTruthy();
    expect(cover.style.width).toBe('96px');
    expect(cover.style.height).toBe('96px');
    expect(cover.style.objectFit).toBe('cover');
    const drawing = pasted.querySelector('path[d="M0 0L20 20"]') as SVGElement;
    // Compiled production utilities own these bounds; no fixture sizing rule.
    expect(drawing.ownerSVGElement!.style.maxWidth).toBe('100%');
    expect(drawing.ownerSVGElement!.style.maxHeight).toBe('60vh');
    expect(drawing.style.fill).toBe(getComputedStyle(root.querySelector('path[d="M0 0L20 20"]')!).fill);
    expect(drawing.style.stroke).toBe(getComputedStyle(root.querySelector('path[d="M0 0L20 20"]')!).stroke);
    expect(pasted.textContent).toContain('Song title');
    expect(pasted.textContent).toContain('Rain sound');
    expect(pasted.textContent).toContain('diagram label');
    expect(pasted.textContent).toContain('before media');
    expect(pasted.textContent).toContain('after media');
    const plain = clipboardData.setData.mock.calls.find(([type]) => type === 'text/plain')![1];
    // Self-review: omit the complete player transport, not only its button.
    // Progress/time labels are UI state; preserve the adjacent track content.
    expect(plain).not.toMatch(/chat\.media|chat\.mermaid|0:00|0:30/);
    expect(pasted.querySelector('[role="slider"]')).toBeNull();
    expect(pasted.textContent).not.toMatch(/0:00|0:30/);
    expect(pasted.textContent).toContain('Ambient');
  });

  // Review4434467983: real Markdown/RichAnswer media override, not a
  // hand-sized img. Authored wrapper variables must survive detached export.
  it.each([
    { style: { width: 120 }, width: '120px', height: 'auto', maxWidth: '100%' },
    { style: { width: 120, height: 60 }, width: '120px', height: '60px', maxWidth: '100%' },
    // Review4434554280: max-width-only wrapper has no explicit image width.
    { style: { maxWidth: 120 }, width: '', height: 'auto', maxWidth: 'min(100%, 120px)' },
  ])('keeps effective authored image dimensions $maxWidth/$height', async ({ style, width, height, maxWidth }) => {
    const source = JSON.stringify({ version: 1, seq: 1, op: 'create', id: 'photo', kind: 'image', props: {
      src: 'https://example.com/rich-sized.png', alt: 'Sized rich photo', style,
    } });
    const { root, select, copy } = setup(<><p>before photo</p><MarkdownRenderer renderRichAnswers workingDir="" content={'```cindy-ui\n' + source + '\n```'} /><p>after photo</p></>);
    const image = root.querySelector('img')!;
    expect(image).toBeTruthy(); fireEvent.load(image);
    await waitFor(() => expect(image.style.display).not.toBe('none'));
    expect((image.closest('.rich-answer-media') as HTMLElement).style.getPropertyValue('--rich-width')).toBe(width);
    select(); const pasted = document.createElement('div');
    pasted.innerHTML = copy().clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')![1];
    const target = pasted.querySelector('img')!;
    expect(target.style.width).toBe(width); expect(target.style.height).toBe(height);
    expect(target.style.maxWidth).toBe(maxWidth);
    expect(pasted.textContent).toContain('before photo'); expect(pasted.textContent).toContain('after photo');
  });

  // Review 4434198424: ordinary image fixtures never load a tall attachment.
  // Unit: load the real component's 10:1 image, then copy mixed text through
  // the production event; exported geometry must survive removal of its parent.
  it('bounds a loaded long attachment independently of its preview wrapper', async () => {
    productionSelectionCss();
    const { root, select, copy } = setup(<><p>before tall image</p>
      <ChatImageView src="https://example.com/tall.png" filename="Tall attachment" variant="user-attached" />
      <p>after tall image</p></>);
    const image = root.querySelector('img')!;
    Object.defineProperties(image, { naturalWidth: { value: 1000 }, naturalHeight: { value: 10000 } });
    fireEvent.load(image);
    await waitFor(() => expect(image.style.objectFit).toBe('cover'));
    select();
    const { event, clipboardData } = copy();
    expect(event.defaultPrevented).toBe(true);
    const pasted = document.createElement('div');
    pasted.innerHTML = clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')![1];
    const target = pasted.querySelector('img')!;
    expect(target.style.width).toBe('240px');
    expect(target.style.maxWidth).toBe('100%');
    expect(target.style.maxHeight).toBe('240px');
    expect(target.style.height).toBe('auto');
    expect(target.style.aspectRatio).toBe('1 / 1');
    expect(target.style.objectFit).toBe('cover');
    expect(target.style.objectPosition).toBe('top');
    expect(target.src).toBe(image.src);
    expect(pasted.textContent).toContain('before tall image');
    expect(pasted.textContent).toContain('after tall image');
  });

  it.each(['#fffdf5', '#171717'])('exports semantic HTML without the %s theme', (background) => {
    const { root, select, copy } = setup(`<p class="theme" style="background:${background};color:red">Hello <strong>world</strong></p><p><a href="https://example.com" style="background-color:${background}">guide</a> <code class="token" style="color:blue">x &lt; y</code></p>`);
    select();
    const text = window.getSelection()!.toString();
    const { event, clipboardData } = copy();
    expect(event.defaultPrevented).toBe(true);
    expect(clipboardData.setData).toHaveBeenCalledWith('text/plain', text);
    const html = clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')?.[1];
    expect(html).toBe('<p>Hello <strong>world</strong></p><p><a href="https://example.com">guide</a> <code>x &lt; y</code></p>');
    expect(root.querySelector('p')!.getAttribute('style')).toContain('background');
  });

  it('copies only the selected substring', () => {
    const { root, copy } = setup('<p>Hello world</p>');
    const range = document.createRange();
    range.setStart(root.firstChild!.firstChild!, 6);
    range.setEnd(root.firstChild!.firstChild!, 11);
    window.getSelection()!.addRange(range);
    const { clipboardData } = copy();
    expect(clipboardData.setData).toHaveBeenCalledWith('text/plain', 'world');
    expect(clipboardData.setData).toHaveBeenCalledWith('text/html', '<p>world</p>');
  });

  it('retains link and emphasis ancestors for a partial text selection', () => {
    const { root, copy } = setup('<p><strong><a href="https://example.com" style="color:red">Hello world</a></strong></p>');
    const range = document.createRange();
    const text = root.querySelector('a')!.firstChild!;
    range.setStart(text, 6);
    range.setEnd(text, 11);
    window.getSelection()!.addRange(range);
    expect(copy().clipboardData.setData).toHaveBeenCalledWith('text/html', '<p><strong><a href="https://example.com">world</a></strong></p>');
  });

  // PR #6609 review: user messages preserve literal newlines/indentation via
  // CSS, while measurement mirrors and quote summaries must not enter HTML.
  // These outputs were not covered by the original theme-only fixtures.
  it('preserves multiline whitespace inherited by a partial inline selection', () => {
    const { root, select, copy } = setup('<div style="white-space:pre-wrap;background:red"><span>first\n  second</span></div>');
    select(root.querySelector('span')!.firstChild!);
    const { clipboardData } = copy();
    const html = clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')?.[1];
    const pasted = document.createElement('div');
    pasted.innerHTML = html;
    expect(pasted.textContent).toBe('first\n  second');
    expect(pasted.querySelector('[style]')?.getAttribute('style')).toMatch(/white-space:\s*pre-wrap/);
    expect(html).not.toContain('background');
  });

  it('excludes hidden mirrors and non-selectable quote summaries across messages', () => {
    const { select, copy } = setup('<p>start</p><div style="visibility:hidden"><span>hidden full message</span></div><span style="user-select:none"><span>quote summary</span></span><div style="display:none">hidden panel</div><p><code role="button">file.ts</code> end</p>');
    select();
    const { clipboardData } = copy();
    const html = clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')?.[1];
    expect(html).not.toMatch(/hidden full message|quote summary|hidden panel/);
    expect(html).toContain('<code>file.ts</code>');
    expect(html).toContain('start');
    expect(html).toContain('end');
  });

  // Review regressions: HTML consumers must keep table coordinates, omit
  // collapsed mail-history fields, and receive one equation representation.
  // Tier: renderer unit, exercising the production copy event entry point.
  it('preserves empty header and body cells without shifting later columns', () => {
    const { select, copy } = setup('<table><thead><tr><th>A</th><th></th><th>C</th></tr></thead><tbody><tr><td>1</td><td></td><td>3</td></tr></tbody></table>');
    select();
    const html = copy().clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')?.[1];
    const pasted = document.createElement('div');
    pasted.innerHTML = html;
    expect([...pasted.querySelectorAll('tr')].map(row => [...row.children].map(cell => cell.textContent)))
      .toEqual([['A', '', 'C'], ['1', '', '3']]);
  });

  it.each([false, true])('copies only rendered disclosure content (open=%s)', (open) => {
    const { select, copy } = setup(`<p>before</p><details${open ? ' open' : ''}><summary>mail updated</summary><dl><dt>to</dt><dd>recipient@example.com</dd></dl><summary>secondary summary</summary></details><p>after</p>`);
    select();
    const { clipboardData } = copy();
    const html = clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')?.[1];
    const plain = clipboardData.setData.mock.calls.find(([type]) => type === 'text/plain')?.[1];
    expect(html).toContain('mail updated');
    expect(html).toContain('before');
    expect(html).toContain('after');
    expect(html.includes('recipient@example.com')).toBe(open);
    expect(html.includes('secondary summary')).toBe(open);
    expect(plain.includes('recipient@example.com')).toBe(open);
    expect(plain.includes('secondary summary')).toBe(open);
  });

  it.each([false, true])('exports a rendered KaTeX equation once as semantic MathML (equation only=%s)', (equationOnly) => {
    const equation = katex.renderToString('x^2 + y^2');
    const { root, select, copy } = setup(`<p>before ${equation} after</p>`);
    select(equationOnly ? root.querySelector('.katex')! : root);
    const html = copy().clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')?.[1];
    const pasted = document.createElement('div');
    pasted.innerHTML = html;
    expect(pasted.querySelectorAll('math')).toHaveLength(1);
    expect(pasted.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(pasted.querySelector('annotation')?.textContent).toBe('x^2 + y^2');
    if (equationOnly) expect(pasted.textContent).not.toMatch(/before|after/);
    else expect(pasted.textContent).toMatch(/^before .* after$/);
    expect(html).not.toMatch(/class=|height:|vertical-align:/);
  });

  // New review boundaries: a prose-to-formula drag must not acquire an
  // unselected suffix, and GFM task items must retain their distinct states.
  it.each(['end', 'start'])('limits a partial equation at the selection %s', (boundary) => {
    const { root, copy } = setup(`<p>before ${katex.renderToString('x + y')} after</p>`);
    const range = document.createRange();
    const letters = root.querySelectorAll('.katex-html .mord.mathnormal');
    if (boundary === 'end') {
      range.setStart(root.querySelector('p')!.firstChild!, 0);
      range.setEnd(letters[0].firstChild!, 1);
    } else {
      range.setStart(letters[1].firstChild!, 0);
      const last = root.querySelector('p')!.lastChild!;
      range.setEnd(last, last.textContent!.length);
    }
    window.getSelection()!.addRange(range);
    const { clipboardData } = copy();
    const html = clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')?.[1];
    const pasted = document.createElement('div');
    pasted.innerHTML = html;
    expect(pasted.textContent).toBe(boundary === 'end' ? 'before x' : 'y after');
    expect(clipboardData.setData).toHaveBeenCalledWith('text/plain', boundary === 'end' ? 'before x' : 'y after');
    expect(pasted.querySelector('math, annotation')).toBeNull();
    // The visual slice is now the only representation, so it must be exposed
    // to assistive technology rather than retaining KaTeX's duplicate-hiding.
    expect(pasted.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it.each(['\\frac{a}{b}', '\\sqrt{x^2}'])('exports MathML when dragging only the visible formula %s', (source) => {
    const { root, copy } = setup(`<p>before ${katex.renderToString(source)} after</p>`);
    const visual = root.querySelector('.katex-html')!;
    const walker = document.createTreeWalker(visual, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) {
      if (walker.currentNode.textContent?.replace(/[\s\u200b]/g, '')) nodes.push(walker.currentNode as Text);
    }
    const range = document.createRange();
    range.setStart(nodes[0], 0);
    range.setEnd(nodes.at(-1)!, nodes.at(-1)!.length);
    window.getSelection()!.addRange(range);
    const html = copy().clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')?.[1];
    const pasted = document.createElement('div');
    pasted.innerHTML = html;
    expect(pasted.querySelectorAll('math')).toHaveLength(1);
    expect(pasted.querySelector('annotation')?.textContent).toBe(source);
    expect(pasted.querySelector('math mfrac, math msqrt')).not.toBeNull();
    expect(html).not.toMatch(/before|after|aria-hidden|class=/);
  });

  // Review4434467975: real KaTeX layout, selected structured slices only.
  // Unit geometry declarations supplement the detached native-browser check.
  it.each(['power', 'fraction'])('keeps portable layout for a partial %s', kind => {
    installKatexClipboardStyles();
    const { root, copy } = setup(katex.renderToString(kind === 'power' ? 'x^2 + y' : '\\frac{a}{b} + y'));
    const visual = root.querySelector('.katex-html')!;
    const range = document.createRange();
    if (kind === 'fraction') range.selectNodeContents(visual.querySelector('.mfrac')!);
    else {
      const walker = document.createTreeWalker(visual, NodeFilter.SHOW_TEXT);
      const leaves: Text[] = []; while (walker.nextNode()) if (walker.currentNode.textContent?.trim()) leaves.push(walker.currentNode as Text);
      range.setStart(leaves[0], 0); range.setEnd(leaves.find(n => n.textContent === '2')!, 1);
    }
    window.getSelection()!.addRange(range);
    const pasted = document.createElement('div');
    pasted.innerHTML = copy().clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')![1];
    expect(pasted.textContent).not.toMatch(/[+y]/);
    expect(pasted.querySelector('math, [aria-hidden="true"]')).toBeNull();
    const spans = [...pasted.querySelectorAll('span')];
    expect(spans.some(e => ['absolute', 'relative'].includes(e.style.position) && parseFloat(e.style.top) < 0)).toBe(true);
    expect(pasted.querySelector('br')).toBeNull();
    if (kind === 'fraction') expect(spans.some(e => e.style.borderBottomStyle === 'solid' && parseFloat(e.style.borderBottomWidth) > 0)).toBe(true);
    else expect(spans.some(e => parseFloat(e.style.top) < 0)).toBe(true);
    expect(pasted.innerHTML).not.toMatch(/background|color:/);
  });

  it('does not expand an internal partial formula selection', () => {
    const { root, copy } = setup(katex.renderToString('x + y'));
    const letter = root.querySelector('.katex-html .mord.mathnormal')!.firstChild!;
    const range = document.createRange();range.selectNodeContents(letter);
    window.getSelection()!.addRange(range);
    const { clipboardData } = copy();
    const html = clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')?.[1];
    const pasted = document.createElement('div');pasted.innerHTML = html;
    expect(pasted.textContent).toBe('x');
    expect(pasted.querySelector('math, [aria-hidden="true"]')).toBeNull();
    expect(clipboardData.setData).toHaveBeenCalledWith('text/plain', 'x');
  });

  it('preserves checked and unchecked GFM task markers in both clipboard formats', () => {
    const { select, copy } = setup('<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" checked disabled> done</li><li class="task-list-item"><input type="checkbox" disabled> todo</li></ul>');
    select();
    const { clipboardData } = copy();
    const html = clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')?.[1];
    const plain = clipboardData.setData.mock.calls.find(([type]) => type === 'text/plain')?.[1];
    const pasted = document.createElement('div');
    pasted.innerHTML = html;
    expect([...pasted.querySelectorAll('li')].map(item => item.textContent)).toEqual(['☑ done', '☐ todo']);
    expect(plain).toContain('☑ done');
    expect(plain).toContain('☐ todo');
    expect(pasted.querySelector('input')).toBeNull();
  });

  it('retains separators, empty list positions and labelled SVG geometry', () => {
    const { select, copy } = setup('<p>before</p><hr><ol><li>one</li><li></li><li>three</li></ol><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect x="1" y="1" width="40" height="20"/><path d="M 1 30 L 80 30"/><line x1="1" y1="40" x2="80" y2="40"/><text x="2" y="15">diagram label</text></svg><p>after</p>');
    select();
    const html = copy().clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')?.[1];
    const pasted = document.createElement('div');
    pasted.innerHTML = html;
    expect(pasted.querySelector('hr')).not.toBeNull();
    expect([...pasted.querySelectorAll('li')].map(item => item.textContent)).toEqual(['one', '', 'three']);
    expect(pasted.querySelector('svg rect')?.getAttribute('width')).toBe('40');
    expect(pasted.querySelector('svg path')?.getAttribute('d')).toBe('M 1 30 L 80 30');
    expect(pasted.querySelector('svg line')?.getAttribute('y2')).toBe('40');
    expect(pasted.querySelector('svg text')?.textContent).toBe('diagram label');
  });

  // Review 4434198428: full-list coverage misses an omitted prefix. Unit:
  // select across two real Markdown list items and keep their original numbers;
  // raw HTML variants exercise the same handler's start/reversed/value semantics.
  it.each([
    { content: <MarkdownRenderer workingDir="" content={'1. first\n2. second\n3. third'} />, start: 2 },
    { content: '<ol start="7"><li>first</li><li>second</li><li>third</li></ol>', start: 8 },
    { content: '<ol reversed><li>first</li><li>second</li><li>third</li></ol>', start: 2 },
    { content: '<ol><li value="10">first</li><li>second</li><li>third</li></ol>', start: 11 },
  ])('retains the first selected ordered-list number $start', ({ content, start }) => {
    const { root, select, copy } = setup(content);
    const items = root.querySelectorAll('li');
    select(items[1]!.firstChild!, items[2]!.firstChild!);
    const { event, clipboardData } = copy();
    expect(event.defaultPrevented).toBe(true);
    const pasted = document.createElement('div');
    pasted.innerHTML = clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')![1];
    expect([...pasted.querySelectorAll('li')].map(item => item.textContent)).toEqual(['second', 'third']);
    expect(pasted.querySelector('ol')!.start).toBe(start);
  });

  it('omits transparent hover toolbars without losing visible code or graphics', () => {
    const { select, copy } = setup('<p>before</p><div style="opacity:0"><button><svg><path d="M0 0L2 2"/></svg>hidden toolbar</button></div><pre><code>visible code</code></pre><p>after</p>');
    select();
    const { clipboardData } = copy();
    const html = clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')?.[1];
    const plain = clipboardData.setData.mock.calls.find(([type]) => type === 'text/plain')?.[1];
    expect(html).not.toMatch(/hidden toolbar|button|<svg/);
    expect(plain).not.toContain('hidden toolbar');
    expect(html).toContain('<code');
    expect(plain).toContain('visible code');
  });

  it.each([false, true])('keeps a fully selected SVG self-contained (diagram only=%s)', (diagramOnly) => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" id="diagram" viewBox="0 0 100 50"><style>#diagram .node{fill:aliceblue;stroke:navy}</style><rect class="node" width="90" height="40"/><foreignObject width="90" height="40"><div xmlns="http://www.w3.org/1999/xhtml" style="display:table-cell;white-space:nowrap">label</div></foreignObject></svg>';
    const { root, select, copy } = setup(`<div class="chat-theme" style="background:red;color:purple"><p>before</p><div data-chat-mermaid>${svg}</div><p>after</p></div>`);
    const presentation = document.createElement('style');
    presentation.textContent = '#diagram .node { fill: aliceblue; stroke: navy; }';
    document.head.append(presentation);
    select(diagramOnly ? root.querySelector('svg')! : root);
    const html = copy().clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')?.[1];
    const pasted = document.createElement('div');
    pasted.innerHTML = html;
    presentation.remove();
    expect(pasted.querySelector('svg style')?.textContent).toContain('#diagram .node');
    expect(pasted.querySelector('foreignObject div')?.getAttribute('style')).toMatch(/display:\s*table-cell/);
    pasted.querySelectorAll('style').forEach(node => node.remove());
    const rect = pasted.querySelector('rect')!;
    expect(rect.style.fill).toBe('rgb(240, 248, 255)');
    expect(rect.style.stroke).toBe('rgb(0, 0, 128)');
    expect(rect.getAttribute('width')).toBe('90');
    pasted.querySelector('svg')?.remove();
    expect(pasted.innerHTML).not.toMatch(/chat-theme|background|color:/);
  });

  it('localizes SVG fragment references on a hash-router page without changing external references', () => {
    const previous = window.location.href;
    window.history.replaceState(null, '', '#/cc-agent/clipboard');
    try {
      const base = document.URL.split('#')[0];
      const { select, copy } = setup(`<div data-chat-mermaid><svg xmlns="http://www.w3.org/2000/svg"><defs><marker id="arrow"/><linearGradient id="gradient"/></defs><path style='marker-end:url("${base}#arrow");fill:url("${base}#gradient");stroke:url("https://example.com/external.svg#paint")' d="M0 0L10 10"/><text>diagram</text></svg></div>`);
      select();
      const html = copy().clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')?.[1];
      const pasted = document.createElement('div');pasted.innerHTML = html;
      const style = pasted.querySelector('path')!.style;
      expect(style.markerEnd.replaceAll('"', '')).toBe('url(#arrow)');
      expect(style.fill.replaceAll('"', '')).toBe('url(#gradient)');
      expect(style.stroke).toContain('https://example.com/external.svg#paint');
    } finally {
      window.history.replaceState(null, '', previous);
    }
  });

  it('keeps sent reference labels without exporting decorative icons or their theme', () => {
    productionSelectionCss();
    const chip = render(<InlineReferenceChip label="project/file.ts" icon={<File />} textSelectable onClick={vi.fn()} ariaLabel="Open file" />);
    const { select, copy } = setup(`<p>before</p><span style="color:purple;font-family:monospace">${chip.container.innerHTML}<svg class="other-icon" style="color:red" viewBox="0 0 10 10"><path class="stroke-theme" style="stroke:purple" d="M0 0L10 10"/><text>ordinary graphic</text></svg></span><p>after</p>`);
    select();
    const { clipboardData } = copy();
    const html = clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')?.[1];
    const plain = clipboardData.setData.mock.calls.find(([type]) => type === 'text/plain')?.[1];
    const pasted = document.createElement('div');
    pasted.innerHTML = html;
    expect(pasted.textContent).toContain('project/file.ts');
    expect(plain).toContain('project/file.ts');
    expect(pasted.querySelector('[aria-hidden] svg')).toBeNull();
    expect(pasted.querySelectorAll('svg')).toHaveLength(1);
    expect(pasted.querySelector('svg path')?.getAttribute('d')).toBe('M0 0L10 10');
    expect(html).not.toMatch(/class=|color:|font-family:|stroke:/);
    expect(pasted.querySelector('[role="button"], [tabindex], [aria-label="Open file"]')).toBeNull();
    expect(chip.container.querySelector('[role="button"][tabindex="0"]')).toBeTruthy();
  });

  // Review 4333633275: opacity-only coverage missed hover/focus/fade states.
  // Unit: production copy must omit marked application controls at any opacity.
  it.each(['1', '0.5'])('omits visible or transitioning toolbars at opacity %s', (opacity) => {
    const { select, copy } = setup(`<p>before</p><pre><code>visible code</code></pre><button data-chat-copy-exclude style="opacity:${opacity}"><svg><path d="M0 0L2 2"/></svg>copy code</button><div data-chat-copy-exclude style="opacity:${opacity}"><button>view source</button></div><p>after</p>`);
    select();
    const { clipboardData } = copy();
    const html = clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')?.[1];
    const plain = clipboardData.setData.mock.calls.find(([type]) => type === 'text/plain')?.[1];
    expect(html).not.toMatch(/button|svg|copy code|view source/);
    const pasted = document.createElement('div'); pasted.innerHTML = html;
    expect(pasted.querySelector('code')?.textContent).toBe('visible code');
    expect(plain).not.toMatch(/copy code|view source/);
  });

  // Review 4333807318: generic marked fixtures cannot detect an unmarked
  // production toolbar. Unit: render the real table/formula wrapper (only its
  // image-export side effects are stubbed), then inspect actual copy output.
  it.each(['1', '0.5'])('excludes CopyAsImageBlock controls at opacity %s', (opacity) => {
    const equation = katex.renderToString('x^2', { displayMode: true });
    const view = render(<div onCopy={copyChatSelection}>
      <p>before</p>
      <CopyAsImageBlock><table><tbody><tr><td /><td>value</td></tr></tbody></table></CopyAsImageBlock>
      <CopyAsImageBlock><span dangerouslySetInnerHTML={{ __html: equation }} /></CopyAsImageBlock>
      <p>after</p>
    </div>);
    const root = view.container.firstElementChild!;
    // Simulate hover/focus or mid-transition; do not manually add export markers.
    for (const button of root.querySelectorAll('button')) button.parentElement!.style.opacity = opacity;
    const range = document.createRange(); range.selectNodeContents(root);
    window.getSelection()!.addRange(range);
    const clipboardData = { setData: vi.fn() };
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: clipboardData });
    fireEvent(root, event);
    const html = clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')?.[1];
    const plain = clipboardData.setData.mock.calls.find(([type]) => type === 'text/plain')?.[1];
    const pasted = document.createElement('div'); pasted.innerHTML = html;
    expect(pasted.querySelectorAll('button, svg')).toHaveLength(0);
    expect([...pasted.querySelectorAll('td')].map(cell => cell.textContent)).toEqual(['', 'value']);
    expect(pasted.querySelectorAll('math')).toHaveLength(1);
    expect(plain).not.toMatch(/markdownRenderer|annotateImage/);
    expect(pasted.textContent).toContain('before');
    expect(pasted.textContent).toContain('after');
  });

  // Review 4333633280: the prior sizing case only covered LightboxImage.
  // Unit: a high-resolution audio cover must retain its production 96px box.
  it('retains audio cover dimensions without carrying the card theme', () => {
    const { select, copy } = setup('<p>before</p><div style="width:96px;height:96px;background:red"><img data-chat-audio-cover src="https://example.com/cover.png" alt="track" style="width:100%;height:100%;object-fit:cover;color:purple"/></div><p>after</p>');
    select();
    const { clipboardData } = copy();
    const html = clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')?.[1];
    const pasted = document.createElement('div'); pasted.innerHTML = html;
    const image = pasted.querySelector('img')!;
    expect(image.style.width).toBe('96px');
    expect(image.style.height).toBe('96px');
    expect(image.style.objectFit).toBe('cover');
    expect(image.alt).toBe('track');
    expect(html).not.toMatch(/background|purple/);
  });

  it('omits a video preview together with its play overlay from a mixed text selection', () => {
    const { select, copy } = setup('<p>before</p><div data-chat-video-preview role="button" aria-label="clip.mp4"><video src="https://example.com/clip.mp4"></video><div aria-hidden="true"><svg class="lucide lucide-play"><path d="M0 0L10 5L0 10Z"/></svg></div></div><p>after</p>');
    select();
    const { clipboardData } = copy();
    const html = clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')?.[1];
    expect(html).toBe('<p>before</p><p>after</p>');
    const plain = clipboardData.setData.mock.calls.find(([type]) => type === 'text/plain')?.[1];
    expect(plain).toContain('before');expect(plain).toContain('after');
    expect(plain).not.toContain('clip.mp4');
  });

  it('unwraps a lightbox image trigger and preserves only image sizing in a mixed selection', () => {
    const { select, copy } = setup('<p>before</p><button data-chat-image-preview type="button" style="padding:0;border:0;background:transparent"><span><img src="https://example.com/photo.png" alt="photo" style="max-width:min(100%, 50vw, 480px);max-height:min(40vh, 420px);height:auto;background:red;color:purple"/></span></button><p>after</p>');
    select();
    const { clipboardData } = copy();
    const html = clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')?.[1];
    const pasted = document.createElement('div');pasted.innerHTML = html;
    expect(pasted.querySelector('button, [role="button"]')).toBeNull();
    const image = pasted.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('https://example.com/photo.png');
    expect(image.alt).toBe('photo');
    expect(image.style.maxWidth).toBe('min(100%, 50vw, 480px)');
    expect(image.style.maxHeight).toBe('min(40vh, 420px)');
    expect(image.style.height).toBe('auto');
    expect(html).not.toMatch(/background|color:|class=/);
    expect(pasted.textContent).toBe('beforeafter');
  });

  it.each(['textarea', 'input', 'div contenteditable="true"'])('leaves %s editing to native copy', (tag) => {
    const { root, select, copy } = setup(`<${tag}>draft</${tag.split(' ')[0]}>`);
    select(root.firstChild!);
    const { event, clipboardData } = copy(root.firstElementChild!);
    expect(event.defaultPrevented).toBe(false);
    expect(clipboardData.setData).not.toHaveBeenCalled();
  });

  it('leaves cross-container selections to native copy', () => {
    const { root, select, copy } = setup('<p>chat</p>');
    const outside = document.createElement('p');
    outside.textContent = 'outside';
    document.body.append(outside);
    select(root.firstChild!.firstChild!, outside.firstChild!);
    const { event, clipboardData } = copy();
    expect(event.defaultPrevented).toBe(false);
    expect(clipboardData.setData).not.toHaveBeenCalled();
    outside.remove();
  });

  // Reviews 4334030899/4334030908: cross-control ranges bypass endpoint
  // guards. Unit copy must omit dropdown alternatives and interactive state,
  // while disabled GFM task markers remain message content.
  it('omits form controls from mixed selections while retaining disabled task state', () => {
    const { select, copy } = setup('<p>before</p><label>Choice<select><option selected>shown</option><option>unseen alternative</option></select></label><label><input type="checkbox" checked/>toggle label</label><input value="draft"/><textarea>draft body</textarea><input type="checkbox" checked disabled/><ul><li class="task-list-item"><input type="checkbox" checked disabled/>done</li></ul><p>after</p>');
    select();
    const { clipboardData } = copy();
    const html = clipboardData.setData.mock.calls.find(([type]) => type === 'text/html')?.[1];
    const plain = clipboardData.setData.mock.calls.find(([type]) => type === 'text/plain')?.[1];
    expect(html).not.toMatch(/<select|<option|<input|<textarea|shown|unseen alternative|draft/);
    expect(plain).not.toMatch(/shown|unseen alternative|draft/);
    expect((html.match(/☑/g) || [])).toHaveLength(1);
    expect((plain.match(/☑/g) || [])).toHaveLength(1);
    expect(html).toContain('toggle label');
  });

  it('leaves direct select copying to the native control', () => {
    const { root, select, copy } = setup('<select><option>selected option</option></select>');
    select(root.querySelector('option')!.firstChild!);
    const { event, clipboardData } = copy(root.querySelector('select')!);
    expect(event.defaultPrevented).toBe(false);
    expect(clipboardData.setData).not.toHaveBeenCalled();
  });

  it('leaves image-only and collapsed selections to native copy', () => {
    const { root, select, copy } = setup('<img src="https://example.com/image.png" alt="image">');
    select();
    expect(copy().event.defaultPrevented).toBe(false);
    window.getSelection()!.collapse(root, 0);
    expect(copy().event.defaultPrevented).toBe(false);
  });

  it('respects a nested copy handler', () => {
    const { root, select, copy } = setup('<p>custom copy</p>');
    root.firstElementChild!.addEventListener('copy', (event) => event.preventDefault());
    select();
    expect(copy(root.firstElementChild!).clipboardData.setData).not.toHaveBeenCalled();
  });
});
