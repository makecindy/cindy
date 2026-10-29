// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RichAnswer, snapshotRichAnswerValues } from '@/session/RichAnswer';
import { SessionQuickSendProvider } from '@/session/SessionQuickSendContext';
import { buildConversationShareHtml } from '@/session/conversationShareWebViewHtml';
import { buildConversationShareSvgLayout } from '@/session/conversationShareSvgLayout';
import { lightColors } from '@/theme/tokens';

vi.mock('react-native', () => ({
  View: ({ children }: any) => <div>{children}</div>,
  Pressable: ({ children, onPress, disabled }: any) => <button disabled={disabled} onClick={onPress}>{children}</button>,
  Switch: () => null,
  StyleSheet: { create: (styles: unknown) => styles },
  AppState: { addEventListener: () => ({ remove() {} }) },
}));
vi.mock('@/components/AppText', () => ({
  Text: ({ children }: any) => <span>{children}</span>,
  TextInput: ({ value, onChangeText, accessibilityLabel }: any) =>
    <input aria-label={accessibilityLabel} value={value} onChange={event => onChangeText(event.target.value)} />,
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => undefined } }));
vi.mock('lucide-react-native', () => Object.fromEntries(['Mail', 'CalendarDays', 'Folder', 'ChartColumn', 'Check', 'Info', 'Clock', 'MapPin', 'Coffee', 'Image', 'Users', 'Star'].map(name => [name, () => null])));
vi.mock('react-native-svg', () => Object.fromEntries(['default', 'Path', 'Rect', 'Ellipse', 'Polygon', 'Polyline', 'Line', 'Circle', 'Text'].map(name => [name, () => null])));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'mobile-rich-test' } }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/theme', () => ({
  useTheme: () => ({ colors: {} }),
  useThemedStyles: () => ({ text: {}, heading: {}, caption: {}, iconTitle: {}, statValue: {}, buttonText: {}, input: {} }),
  spacing: {}, radius: {}, textStyles: {}, fontWeight: {}, iconSize: {}, iconStroke: {},
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); root = createRoot(container); });
afterEach(() => act(() => root.unmount()));
const source = [
  { id: 'name', kind: 'input', props: { label: 'Destination', default: 'Hangzhou' } },
  { id: 'submit', kind: 'form', props: { label: 'Plan trip', send: { op: 'concat', args: ['Plan a trip to ', { ref: 'name' }] } } },
].map((node, index) => JSON.stringify({ version: 1, seq: index + 1, op: 'create', ...node })).join('\n') + '\n';
async function render(stateKey: string, sender: ((text: string) => Promise<boolean>) | null, complete = true) {
  await act(async () => root.render(createElement(SessionQuickSendProvider, { value: sender },
    createElement(RichAnswer, { source, stateKey, complete, renderMarkdown: text => text }))));
}

// Tier 1: native rich controls previously only changed local values. Exercise the
// production renderer's explicit send, failure/retry and virtualized receipt;
// shared controller tests cannot prove the native button is wired correctly.
it('submits only on tap, retains inputs after refusal and deduplicates after remount', async () => {
  const send = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  await render('retry', send);
  expect(send).not.toHaveBeenCalled();
  await act(async () => container.querySelector('button')!.click());
  expect(send).toHaveBeenLastCalledWith('Plan a trip to Hangzhou');
  expect(container.textContent).toContain('message.richAnswer.sendFailed');
  expect(container.querySelector('input')!.value).toBe('Hangzhou');
  await act(async () => container.querySelector('button')!.click());
  expect(send).toHaveBeenCalledTimes(2);
  await act(async () => root.render(null));
  await render('retry', send);
  expect(container.querySelector('button')!.disabled).toBe(true);
  expect(container.textContent).toContain('message.richAnswer.sent');
});

it('keeps incomplete and read-only answers from sending', async () => {
  const send = vi.fn().mockResolvedValue(true);
  await render('readonly', send, false);
  expect(container.querySelector('button')!.disabled).toBe(true);
  await render('readonly', null);
  expect(container.querySelector('button')!.disabled).toBe(true);
  expect(send).not.toHaveBeenCalled();
});

// Unit regression: route ids used to miss the live memory entry when file origin was null.
// Edit the production control, then read its real memory through both export builders.
it.each([null, { deviceId: 'desktop', sessionId: 'task' }])(
  'exports edited controls using the live file origin %j', async (origin) => {
    const messageKey = origin ? 'scoped-share' : 'originless-share';
    // This is the stateKey supplied by MessageRenderer, including the rich part offset.
    const stateKey = `${origin?.deviceId ?? ''}:${origin?.sessionId ?? ''}:${messageKey}:1`;
    await render(stateKey, null);
    const input = container.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Suzhou');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const body = `\n\`\`\`cindy-ui\n${source}\n\`\`\``;
    const scope = { userId: 'mobile-rich-test', origin, messageKey };
    const richValues = snapshotRichAnswerValues(body, scope);
    expect(richValues[1]?.name).toBe('Suzhou');
    expect(snapshotRichAnswerValues(body, { ...scope, userId: 'other-account' })[1]).toEqual({});
    const messages = [{ clientId: messageKey, kind: 'assistant' as const, body, richValues }];
    const colors = {
      ...lightColors, background: lightColors.surface,
      codeSurface: lightColors.chatCodeSurface, inlineCode: lightColors.chatInlineCodeText,
      syntax: {},
    };
    const html = buildConversationShareHtml({ selectedMessages: messages, allShareableIds: [messageKey], colors, contentWidth: 390 });
    const layout = buildConversationShareSvgLayout({ messages, allShareableIds: [messageKey], colors, width: 390 });
    const text = layout.bubbles.flatMap(b => b.textBlocks.flatMap(block => block.lines)).join('\n');
    for (const output of [html, text]) {
      expect(output).toContain('Suzhou');
      expect(output).not.toContain('Hangzhou');
    }
    expect(input.value).toBe('Suzhou');
  },
);

// Tier 1: a completed-looking partial snapshot used to poison the mounted parser.
// The same answer must recover on its final snapshot without leaving/reopening it.
it('replaces the incomplete notice with the late full answer without remounting', async () => {
  const full = JSON.stringify({ version: 1, seq: 1, op: 'create', id: 'answer', kind: 'markdown', props: { text: 'Complete findings' } });
  const renderSnapshot = async (snapshot: string) => {
    await act(async () => root.render(createElement(SessionQuickSendProvider, { value: null },
      createElement(RichAnswer, { source: snapshot, stateKey: 'late-final', complete: true, renderMarkdown: text => text }))));
  };
  await renderSnapshot(full.slice(0, -6));
  expect(container.textContent).toContain('message.richAnswer.incomplete');
  await renderSnapshot(full);
  expect(container.textContent).toContain('Complete findings');
  expect(container.textContent).not.toContain('message.richAnswer.incomplete');
});

// Tier 1: malformed later suffixes must not erase text already on screen.
it('keeps committed text visible while malformed suffixes grow without remounting', async () => {
  const full = JSON.stringify({ version: 1, seq: 1, op: 'create', id: 'answer', kind: 'markdown', props: { text: 'Readable findings' } });
  for (const suffix of ['', '{', '{"seq":', '{"seq":2']) {
    await act(async () => root.render(createElement(SessionQuickSendProvider, { value: null },
      createElement(RichAnswer, { source: full + suffix, stateKey: 'malformed-tail', complete: true, renderMarkdown: text => text }))));
    expect(container.textContent).toContain('Readable findings');
    if (suffix) expect(container.textContent).toContain('message.richAnswer.incomplete');
  }
  const prefix = full + '{"seq":2' + String.fromCharCode(10);
  const later = JSON.stringify({ seq: 2, op: 'create', id: 'later', kind: 'markdown', props: { text: 'Later findings' } });
  for (const tail of [later.slice(0, -6), later]) {
    await act(async () => root.render(createElement(SessionQuickSendProvider, { value: null },
      createElement(RichAnswer, { source: prefix + tail, stateKey: 'malformed-tail', complete: true, renderMarkdown: text => text }))));
    expect(container.textContent).toContain('Readable findings');
    expect(container.textContent).toContain('message.richAnswer.incomplete');
  }
  expect(container.textContent).toContain('Later findings');
});
