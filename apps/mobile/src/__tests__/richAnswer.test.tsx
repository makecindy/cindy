// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RichAnswer } from '@/session/RichAnswer';
import { SessionQuickSendProvider } from '@/session/SessionQuickSendContext';

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
