// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InteractionPanel } from '@/session/InteractionPanel';
import { remoteSessionStore, useSessionPendingInteractions } from '@/session/remoteSessionStore';
import { clearAllInteractionDrafts, readAskUserDraft } from '@/session/interactionDraftStore';

const { resolveInteraction } = vi.hoisted(() => ({ resolveInteraction: vi.fn() }));
vi.mock('@/device-link/useMobileMakerTransport', () => ({
  useMobileMakerTransport: () => ({ resolveInteraction }),
}));
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const view = (tag: string) => ({ children, onPress, disabled, testID }: {
    children?: ReactNode; onPress?: () => void; disabled?: boolean; testID?: string;
  }) => createElement(tag, { onClick: onPress, disabled, 'data-testid': testID }, children);
  return { View: view('div'), Text: view('span'), Pressable: view('button'),
    ScrollView: view('div'), Image: () => null,
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 } };
});
vi.mock('@/components/AppText', async () => {
  const { createElement } = await import('react');
  return { Text: (await import('react-native')).Text,
    TextInput: ({ value, onChangeText, testID }: {
      value: string; onChangeText: (value: string) => void; testID: string;
    }) => createElement('input', { value, 'data-testid': testID,
      onInput: (event: { currentTarget: HTMLInputElement }) => onChangeText(event.currentTarget.value),
      readOnly: true }),
  };
});
vi.mock('lucide-react-native', () => ({ Check: () => null, CornerDownLeft: () => null,
  Maximize2: () => null, Minimize2: () => null, Minus: () => null, Pencil: () => null, Plus: () => null }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  return { ...tokens, monoFont: 'monospace', useTheme: () => ({ colors: tokens.lightColors }),
    useThemedStyles: (make: (colors: typeof tokens.lightColors) => unknown) => make(tokens.lightColors) };
});

let root: Root;
let host: HTMLDivElement;
const requestId = 'codex:test:0';
const onError = vi.fn();
function Harness() {
  const interactions = useSessionPendingInteractions('s1');
  return <InteractionPanel deviceId="d1" sessionId="s1" interactions={interactions} onError={onError} />;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetAllMocks();
  remoteSessionStore.clear();
  clearAllInteractionDrafts();
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

it('restores the last answer after a rejected receipt and clears it only after an accepted retry', async () => {
  let reply!: (receipt: { accepted: boolean }) => void;
  resolveInteraction.mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
  remoteSessionStore.setPendingInteractions('s1', [{ request: {
    kind: 'ask_user_question', requestId, questions: [{ question: 'Your answer?' }],
  } }]);
  await act(async () => root.render(<Harness />));
  const input = () => host.querySelector<HTMLInputElement>('[data-testid="interaction.ask.textInput"]');
  const submit = () => host.querySelector<HTMLButtonElement>('[data-testid="interaction.ask.submitButton"]')!;
  await act(async () => {
    input()!.value = 'Keep the connection';
    input()!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => submit().click());
  expect(input()).toBeNull();
  expect(readAskUserDraft(requestId)?.customInput).toBe('Keep the connection');
  await act(async () => reply({ accepted: false }));
  expect(input()?.value).toBe('Keep the connection');
  expect(onError).toHaveBeenLastCalledWith(expect.any(String));
  resolveInteraction.mockResolvedValueOnce({ accepted: true });
  await act(async () => submit().click());
  expect(resolveInteraction).toHaveBeenCalledTimes(2);
  expect(resolveInteraction.mock.calls[1]).toEqual(resolveInteraction.mock.calls[0]);
  expect(resolveInteraction.mock.calls[1][1]).toMatchObject({ answers: { 'Your answer?': 'Keep the connection' } });
  expect(input()).toBeNull();
  expect(readAskUserDraft(requestId)).toBeNull();
});
