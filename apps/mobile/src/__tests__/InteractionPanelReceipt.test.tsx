// @vitest-environment jsdom
import { act, useLayoutEffect, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sharedTaskHostPeer } from '@cindy/device-link';
import { AuthorizationMessageCard } from '@/session/AuthorizationMessageCard';
import type { NormalizedRemoteMessage } from '@/session/messageNormalize';
import { InteractionPanel, PluginSetupMessageContent } from '@/session/InteractionPanel';
import { remoteSessionStore, useSessionPendingInteractions } from '@/session/remoteSessionStore';
import { clearAllInteractionDrafts, readAskUserDraft, readPlanReviewDraft } from '@/session/interactionDraftStore';
import { forwardNavigationLock } from '@/utils/navigationLock';
import { ChatFilePathContext, type ChatFilePathContextValue } from '@/session/chatFilePathContext';
import { QuestionReferenceText } from '@/session/QuestionReferenceText';
import { ChatPathChipSpan } from '@/session/ChatPathChipSpan';
import { classifyChatPathLinkTarget } from '@/session/chatPathCandidate';
import { Text } from '@/components/AppText';
import { _clearRemotePathVerdictCache } from '@/session/remotePathVerdict';
import { i18n } from '@/i18n';
import { AskCardAuthContext } from '@/session/askCardAuth';
import { darkColors, lightColors } from '@/theme/tokens';

const voiceStarter = vi.hoisted(() => ({ start: vi.fn() }));
const theme = vi.hoisted(() => ({ mode: 'light' as 'light' | 'dark' }));
vi.mock('@/session/askCardVoiceStart', () => ({ startAskCardDictation: voiceStarter.start }));

const evidence = vi.hoisted(() => ({ openURL: vi.fn() }));
// As in LegendList, setters are inert outside a list item. The composer card
// needs ordinary React state to upgrade a reference after its remote stat.
vi.mock('@legendapp/list/react-native', async () => {
  const { useState } = await import('react');
  return { useRecyclingState: (initial: unknown) => [useState(initial)[0], () => {}] };
});

const { resolveInteraction, invoke, push } = vi.hoisted(() => ({ resolveInteraction: vi.fn(), invoke: vi.fn(), push: vi.fn() }));
const asyncReply = vi.hoisted(() => ({
  getSession: vi.fn(), aroundMessagesByClientId: vi.fn(),
  input: { steer: vi.fn(), enqueue: vi.fn(), resume: vi.fn() },
}));
const { routeParams } = vi.hoisted(() => ({ routeParams: {} as { deviceId?: string; sessionId?: string } }));
const { textLayouts } = vi.hoisted(() => ({ textLayouts: new Map<string, (event: { nativeEvent: { lines: unknown[] } }) => void>() }));
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return { useLocalSearchParams: () => routeParams, useRouter: () => ({ push }),
    useNavigation: () => ({ isFocused: () => true, addListener: () => () => {} }),
    useFocusEffect: useEffect };
});
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke }) }));
vi.mock('@/device-link/useMobileMakerTransport', () => ({
  useMobileMakerTransport: () => ({ resolveInteraction, ...asyncReply }),
}));
// 代输入 card has its own tests; its native modules (clipboard, secure store) are out of scope here.
vi.mock('@/inputHandoff/InputHandoffCard', () => ({ InputHandoffCard: () => null }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) }));
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const view = (tag: string) => ({ children, onPress, disabled, testID, accessibilityState, accessibilityLabel, style }: {
    children?: ReactNode; onPress?: () => void; disabled?: boolean; testID?: string; accessibilityState?: { busy?: boolean }; accessibilityLabel?: string; style?: unknown;
  }) => createElement(tag, { onClick: onPress, disabled, 'data-testid': testID, 'data-native-style': JSON.stringify(style), 'aria-busy': accessibilityState?.busy, 'aria-label': accessibilityLabel }, children);
  // Text keeps its onTextLayout so a test can report how many lines a label took.
  const Text = ({ children, onTextLayout, onPress, onLongPress, testID }: { children?: ReactNode; onTextLayout?: (event: { nativeEvent: { lines: unknown[] } }) => void; onPress?: () => void; onLongPress?: () => void; testID?: string }) => {
    if (onTextLayout) textLayouts.set(String(children), onTextLayout);
    return createElement('span', { onClick: onPress, onContextMenu: onLongPress, 'data-testid': testID }, children);
  };
  return { View: view('div'), Text, Pressable: view('button'), Linking: { openURL: evidence.openURL },
    ScrollView: view('div'), Image: () => null, ActivityIndicator: () => null,
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 } };
});
vi.mock('@/components/AppText', async () => {
  const { createElement } = await import('react');
  return { Text: (await import('react-native')).Text,
    TextInput: ({ value, onChangeText, testID, multiline, editable }: {
      value: string; onChangeText: (value: string) => void; testID: string; multiline?: boolean; editable?: boolean;
    }) => createElement(multiline ? 'textarea' : 'input', { value, 'data-testid': testID,
      onInput: (event: { currentTarget: HTMLInputElement }) => onChangeText(event.currentTarget.value),
      readOnly: editable === false }),
  };
});
vi.mock('lucide-react-native', async () => {
  const { createElement } = await import('react');
  return { ShieldCheck: () => null, MessageCircle: () => null, ChevronDown: () => null, ChevronUp: () => null, Check: () => null, CornerDownLeft: () => null,
    Maximize2: () => null, Minimize2: () => null, Minus: () => null, Mic: ({ color }: { color: string }) => createElement('span', { 'data-mic-color': color }), Square: ({ color }: { color: string }) => createElement('span', { 'data-stop-color': color }), Pencil: () => null, Plus: () => null };
});
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  const colors = () => theme.mode === 'dark' ? tokens.darkColors : tokens.lightColors;
  return { ...tokens, monoFont: 'monospace', useTheme: () => ({ colors: colors() }),
    useThemedStyles: (make: (colors: typeof tokens.lightColors) => unknown) => make(colors()) };
});

let root: Root;
let host: HTMLDivElement;
const requestId = 'codex:test:0';
const onError = vi.fn();
function Harness({ companion = false, deviceId = 'd1', fileContext }: { companion?: boolean; deviceId?: string; fileContext?: ChatFilePathContextValue }) {
  const interactions = useSessionPendingInteractions('s1');
  return <InteractionPanel companion={companion} deviceId={deviceId} sessionId="s1" fileContext={fileContext} interactions={interactions} onError={onError} />;
}
function CollapsibleHarness() {
  const interactions = useSessionPendingInteractions('s1');
  const [requestIds, setRequestIds] = useState<readonly string[]>([]);
  return <InteractionPanel deviceId="d1" sessionId="s1" interactions={interactions} onError={onError}
    collapse={{ requestIds, onToggle: (id) => setRequestIds((ids) => ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id]) }} />;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetAllMocks();
  theme.mode = 'light';
  _clearRemotePathVerdictCache();
  evidence.openURL.mockResolvedValue(undefined);
  routeParams.deviceId = 'd1'; routeParams.sessionId = 's1';
  forwardNavigationLock.reset();
  remoteSessionStore.clear();
  clearAllInteractionDrafts();
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

async function click(id: string) {
  const button = host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
  expect(button, id).not.toBeNull();
  await act(async () => button!.click());
}
async function type(id: string, value: string) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// #6778, unit: render the real card/hook and start/stop dictation. Earlier tests
// only checked labels and clicks, missing the invisible inverse-colour mic.
// Preserve the unfilled control; distinguish startup, recording and processing.
// Minimal input: one question in each answer layout, in either theme.
it.each(['light', 'dark'] as const)('keeps the recording mic visible in %s answer layouts', async (mode) => {
  theme.mode = mode;
  const colors = mode === 'dark' ? darkColors : lightColors;
  const stop = vi.fn(async () => undefined);
  let onListening!: () => void;
  voiceStarter.start.mockImplementation(async (input) => {
    onListening = input.onListening;
    return { stop, cancel: vi.fn(async () => undefined) };
  });
  const button = () => host.querySelector<HTMLButtonElement>('[data-testid="interaction.ask.voice"]')!;
  const style = () => Object.assign({}, ...[JSON.parse(button().getAttribute('data-native-style')!)].flat(Infinity));
  const micColor = () => button().querySelector('[data-mic-color]')!.getAttribute('data-mic-color');
  for (const layout of ['free', 'custom-closed', 'custom-open']) {
    await act(async () => remoteSessionStore.setPendingInteractions('s1', [{ request: {
      kind: 'ask_user_question', requestId: requestId + ':' + layout,
      questions: [{ question: 'Answer?', ...(layout === 'free' ? {} : { options: [{ label: 'A' }] }) }],
    } }]));
    await act(async () => root.render(<AskCardAuthContext.Provider value={{
      getAccessToken: async () => null, refreshAccessToken: async () => null, apiFetch: async () => null,
    }}><Harness /></AskCardAuthContext.Provider>));
    if (layout === 'custom-open') await click('interaction.ask.showCustomButton');
    const idleStyle = style();
    expect(micColor()).toBe(colors.textSecondary);
    expect(idleStyle.backgroundColor).toBeUndefined();
    await click('interaction.ask.voice');
    expect(button().getAttribute('aria-busy')).toBe('true');
    expect(button().querySelector('[data-mic-color]')).toBeNull();
    expect(style()).toEqual(idleStyle);
    await act(async () => onListening());
    expect(button().getAttribute('aria-label')).toBe('session.common.voiceStopRecording');
    expect(button().getAttribute('aria-busy')).toBe('false');
    expect(style()).toEqual(idleStyle);
    expect(button().querySelector('[data-stop-color]')!.getAttribute('data-stop-color')).toBe(colors.textSecondary);
    await click('interaction.ask.voice');
    expect(button().getAttribute('aria-label')).toBe('session.screen.voiceStartInput');
    expect(style()).toEqual(idleStyle);
    expect(micColor()).toBe(colors.textSecondary);
  }
  expect(stop).toHaveBeenCalledTimes(3);
  expect(resolveInteraction).not.toHaveBeenCalled();
});

// #6785, unit: real card + hook; only native/cloud startup is faked.
// Existing cases never submitted while listening. The final text arrives at stop.
it.each([
  { multiSelect: false, connecting: false },
  { multiSelect: true, connecting: false },
  { multiSelect: false, connecting: true },
])('waits for voice finalization and submits once (%o)', async ({ multiSelect, connecting }) => {
  let finish!: () => void;
  const stop = vi.fn();
  voiceStarter.start.mockImplementation(async (input) => {
    const run = { stop: () => stop(), cancel: vi.fn(async () => undefined) };
    let ready: (() => void) | undefined;
    stop.mockImplementation(() => new Promise<void>((resolve) => { finish = () => { input.setText('完整回答'); ready?.(); resolve(); }; }));
    input.onRunCreated(run);
    input.onListening();
    return connecting ? new Promise((resolve) => { ready = () => resolve(run); }) : run;
  });
  remoteSessionStore.setPendingInteractions('s1', [{ request: {
    kind: 'ask_user_question', requestId, questions: [{ question: 'Answer?', multiSelect }],
  } }]);
  await act(async () => root.render(<AskCardAuthContext.Provider value={{
    getAccessToken: async () => null, refreshAccessToken: async () => null, apiFetch: async () => null,
  }}><Harness /></AskCardAuthContext.Provider>));
  await click('interaction.ask.voice');
  expect(host.querySelector<HTMLButtonElement>('[data-testid="interaction.ask.submitButton"]')!.disabled).toBe(false);
  await click('interaction.ask.submitButton');
  await click('interaction.ask.submitButton');
  expect(stop).toHaveBeenCalledOnce();
  expect(resolveInteraction).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(resolveInteraction).toHaveBeenCalledOnce();
  expect(JSON.stringify(resolveInteraction.mock.calls[0])).toContain('完整回答');
});

it('queues a submit before the voice handle exists without pretending to record', async () => {
  let publish!: () => void;
  let finish!: () => void;
  const stop = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  voiceStarter.start.mockImplementation((input) => new Promise((resolve) => {
    const run = { stop: async () => { await stop(); input.setText('最终回答'); }, cancel: vi.fn(async () => undefined) };
    publish = () => { input.onRunCreated(run); resolve(run); };
  }));
  remoteSessionStore.setPendingInteractions('s1', [{ request: {
    kind: 'ask_user_question', requestId, questions: [{ question: 'Answer?' }],
  } }]);
  await act(async () => root.render(<AskCardAuthContext.Provider value={{
    getAccessToken: async () => null, refreshAccessToken: async () => null, apiFetch: async () => null,
  }}><Harness /></AskCardAuthContext.Provider>));
  await type('interaction.ask.textInput', '已有文字');
  await click('interaction.ask.voice');
  const mic = host.querySelector('[data-testid="interaction.ask.voice"]')!;
  expect(mic.getAttribute('aria-busy')).toBe('true');
  expect(mic.getAttribute('aria-label')).toBe('session.common.voiceStopRecording');
  await click('interaction.ask.submitButton');
  const submit = host.querySelector('[data-testid="interaction.ask.submitButton"]')!;
  expect(submit.getAttribute('aria-busy')).toBe('true');
  expect(resolveInteraction).not.toHaveBeenCalled();
  await act(async () => publish());
  expect(stop).toHaveBeenCalledOnce();
  await act(async () => finish());
  expect(resolveInteraction).toHaveBeenCalledOnce();
  expect(JSON.stringify(resolveInteraction.mock.calls[0])).toContain('最终回答');
});

// Unit: real answer card/hook, fake microphone. Earlier fixtures never returned
// the controller's caret with a transcript, so a second take inserted at the
// stale selection instead of following the previous sentence.
it('continues a second dictation after the first sentence and shows processing while stopping', async () => {
  const selections: unknown[] = [];
  let finish!: () => void;
  voiceStarter.start.mockImplementation(async (input) => {
    selections.push(input.getSelection());
    input.onListening();
    return {
      stop: () => new Promise<void>((resolve) => {
        finish = () => { input.setText('第一句', { start: 3, end: 3 }); resolve(); };
      }),
      cancel: async () => undefined,
    };
  });
  remoteSessionStore.setPendingInteractions('s1', [{ request: {
    kind: 'ask_user_question', requestId, questions: [{ question: 'Answer?' }],
  } }]);
  await act(async () => root.render(<AskCardAuthContext.Provider value={{
    getAccessToken: async () => null, refreshAccessToken: async () => null, apiFetch: async () => null,
  }}><Harness /></AskCardAuthContext.Provider>));
  await click('interaction.ask.voice');
  await click('interaction.ask.voice');
  const button = host.querySelector('[data-testid="interaction.ask.voice"]')!;
  expect(button.getAttribute('aria-busy')).toBe('true');
  await act(async () => finish());
  await click('interaction.ask.voice');
  expect(selections).toEqual([{ start: 0, end: 0 }, { start: 3, end: 3 }]);
  expect(resolveInteraction).not.toHaveBeenCalled();
});

it.each(['stop', 'live'] as const)('retains text and permits manual correction after a %s failure', async (failure) => {
  let fail!: () => void;
  voiceStarter.start.mockImplementation(async (input) => {
    const run = { stop: async () => { input.setText('保留文字'); throw new Error('识别失败'); }, cancel: async () => undefined };
    fail = () => { input.setText('保留文字'); input.onError('识别失败'); };
    input.onRunCreated(run);
    input.onListening();
    return run;
  });
  remoteSessionStore.setPendingInteractions('s1', [{ request: {
    kind: 'ask_user_question', requestId, questions: [{ question: 'Answer?' }],
  } }]);
  await act(async () => root.render(<AskCardAuthContext.Provider value={{
    getAccessToken: async () => null, refreshAccessToken: async () => null, apiFetch: async () => null,
  }}><Harness /></AskCardAuthContext.Provider>));
  await click('interaction.ask.voice');
  if (failure === 'stop') await click('interaction.ask.submitButton');
  else await act(async () => fail());
  expect(resolveInteraction).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLInputElement>('[data-testid="interaction.ask.textInput"]')!.value).toBe('保留文字');
  expect(host.querySelector('[data-testid="interaction.ask.voiceError"]')!.textContent).toBe('识别失败');
  await type('interaction.ask.textInput', '修改后的回答');
  await click('interaction.ask.submitButton');
  expect(resolveInteraction).toHaveBeenCalledOnce();
  expect(JSON.stringify(resolveInteraction.mock.calls[0])).toContain('修改后的回答');
});

// Unit regression: the real card/hook disabled submit during recording. Existing
// voice coverage only exercised signed-out errors, never final text or failures.
it.each(['free', 'custom', 'multi', 'failed', 'removed', 'connecting', 'connecting-failed', 'connecting-removed', 'connecting-cancelled'])(
  'submits final voice text once and preserves failed/cancelled answers: %s', async (mode) => {
    let finish!: () => void;
    let fail!: (error: Error) => void;
    let connect!: () => void;
    let failConnection!: (error: Error) => void;
    let signal: AbortSignal | undefined;
    const stop = vi.fn();
    const cancel = vi.fn(async () => undefined);
    voiceStarter.start.mockImplementation(async (input: { signal?: AbortSignal; onListening: () => void; setText: (text: string) => void }) => {
      signal = input.signal;
      stop.mockImplementation(() => new Promise<void>((resolve, reject) => {
        finish = () => { input.setText('Final answer'); resolve(); };
        fail = reject;
      }));
      const run = { stop, cancel };
      // PR #7017 review: listening can precede the ASR handshake. The previous
      // fixture always resolved startup immediately and missed lost recordings.
      if (mode.startsWith('connecting')) {
        await new Promise<void>((resolve, reject) => { connect = resolve; failConnection = reject; });
      }
      input.onListening();
      return run;
    });
    remoteSessionStore.setPendingInteractions('s1', [{ request: {
      kind: 'ask_user_question', requestId, questions: [{ question: 'Question?',
        ...(mode === 'custom' || mode === 'multi' ? { options: [{ label: 'A' }] } : {}),
        multiSelect: mode === 'multi',
      }],
    } }]);
    resolveInteraction.mockResolvedValue({ accepted: true });
    await act(async () => root.render(
      <AskCardAuthContext.Provider value={{ getAccessToken: async () => 'test', refreshAccessToken: async () => 'test', apiFetch: async () => ({}) }}>
        <Harness />
      </AskCardAuthContext.Provider>,
    ));
    if (mode === 'multi') await click('interaction.ask.option.1');
    if (mode === 'failed' || mode === 'connecting-failed') await type('interaction.ask.textInput', 'Saved draft');
    await click('interaction.ask.voice');
    const send = host.querySelector<HTMLButtonElement>('[data-testid="interaction.ask.submitButton"]')!;
    expect(send.disabled).toBe(false);
    if (mode === 'connecting-cancelled') {
      expect(host.querySelector('[data-testid="interaction.ask.voice"]')!.getAttribute('aria-label')).toBe('session.common.voiceStopRecording');
      await click('interaction.ask.voice');
      expect(signal?.aborted).toBe(true);
      expect(host.querySelector('[data-testid="interaction.ask.voice"]')!.getAttribute('aria-label')).toBe('session.screen.voiceStartInput');
      await act(async () => connect());
      expect(cancel).toHaveBeenCalledOnce();
      expect(stop).not.toHaveBeenCalled();
      expect(resolveInteraction).not.toHaveBeenCalled();
      return;
    }
    await click('interaction.ask.submitButton');
    await click('interaction.ask.submitButton');
    if (mode.startsWith('connecting')) {
      expect(signal?.aborted).toBe(false);
      expect(stop).not.toHaveBeenCalled();
      expect(resolveInteraction).not.toHaveBeenCalled();
      if (mode === 'connecting-removed') {
        await act(async () => remoteSessionStore.setPendingInteractions('s1', []));
        expect(signal?.aborted).toBe(true);
      }
      await act(async () => mode === 'connecting-failed' ? failConnection(new Error('Connection failed')) : connect());
      if (mode !== 'connecting') {
        expect(resolveInteraction).not.toHaveBeenCalled();
        expect(stop).not.toHaveBeenCalled();
        if (mode === 'connecting-failed') expect(readAskUserDraft(requestId)?.customInput).toBe('Saved draft');
        else expect(cancel).toHaveBeenCalledOnce();
        return;
      }
    }
    expect(stop).toHaveBeenCalledOnce();
    expect(resolveInteraction).not.toHaveBeenCalled();
    if (mode === 'removed') await act(async () => remoteSessionStore.setPendingInteractions('s1', []));
    await act(async () => mode === 'failed' ? fail(new Error('Voice failed')) : finish());
    if (mode === 'failed' || mode === 'removed') {
      expect(resolveInteraction).not.toHaveBeenCalled();
      if (mode === 'failed') expect(readAskUserDraft(requestId)?.customInput).toBe('Saved draft');
    } else {
      expect(resolveInteraction).toHaveBeenCalledExactlyOnceWith(requestId, {
        kind: 'ask_user_question', answers: { 'Question?': mode === 'multi' ? '["A","Final answer"]' : 'Final answer' },
      });
    }
  },
);

// PR #7017 review: no PCM has arrived yet, so the old hook left editing and
// navigation enabled while Send awaited startup. Exercise actual card actions,
// then resolve startup and verify the original answer/question is submitted.
it.each(['options', 'previous'])('protects the answer while submitting before the first audio chunk: %s', async (action) => {
  let connect!: () => void;
  const stop = vi.fn();
  voiceStarter.start.mockImplementation(async (input: { setText: (text: string) => void }) => {
    stop.mockImplementation(async () => input.setText('Final answer'));
    await new Promise<void>((resolve) => { connect = resolve; });
    return { stop, cancel: vi.fn(async () => undefined) };
  });
  remoteSessionStore.setPendingInteractions('s1', [{ request: {
    kind: 'ask_user_question', requestId, questions: [
      ...(action === 'previous' ? [{ question: 'First?', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] }] : []),
      { question: 'Current?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
    ],
  } }]);
  resolveInteraction.mockResolvedValue({ accepted: true });
  await act(async () => root.render(
    <AskCardAuthContext.Provider value={{ getAccessToken: async () => 'test', refreshAccessToken: async () => 'test', apiFetch: async () => ({}) }}>
      <Harness />
    </AskCardAuthContext.Provider>,
  ));
  if (action === 'previous') {
    await click('interaction.ask.option.1');
    await click('interaction.ask.submitButton');
  }
  await click('interaction.ask.option.1');
  await click('interaction.ask.voice');
  await click('interaction.ask.submitButton');
  expect(resolveInteraction).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLInputElement>('[data-testid="interaction.ask.customInput"]')!.readOnly).toBe(true);
  for (const id of ['interaction.ask.option.2', 'interaction.ask.skipButton',
    ...(action === 'previous' ? ['interaction.ask.previousButton'] : [])]) {
    expect(host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.disabled).toBe(true);
    await click(id);
  }
  expect(host.querySelector('[data-testid="interaction.ask.question"]')!.textContent).toBe('Current?');
  expect(readAskUserDraft(requestId)?.selectedLabels).toEqual(['A']);
  await act(async () => connect());
  expect(resolveInteraction).toHaveBeenCalledExactlyOnceWith(requestId, {
    kind: 'ask_user_question', answers: {
      ...(action === 'previous' ? { 'First?': '["X"]' } : {}),
      'Current?': '["A","Final answer"]',
    },
  });

});

// Unit regression for PR #6306 review: a signed-out microphone tap used to
// render hardcoded Chinese. Existing receipt tests never tapped this entry.
// Exercise the real card and hook in each supported locale, without auth.
it.each(['en', 'zh-CN', 'zh-TW', 'ja', 'ko', "es", "fr", "de", "pt-PT", "pt-BR"])('localizes the signed-out voice error in %s', async (locale) => {
  const previousLanguage = i18n.language;
  try {
    await i18n.changeLanguage(locale);
    remoteSessionStore.setPendingInteractions('s1', [{ request: {
      kind: 'ask_user_question', requestId, questions: [{ question: 'Answer?' }],
    } }]);
    await act(async () => root.render(<Harness />));
    expect(host.querySelector('[data-testid="interaction.ask.voiceError"]')).toBeNull();
    await click('interaction.ask.voice');
    expect(host.querySelector('[data-testid="interaction.ask.voiceError"]')?.textContent)
      .toBe(i18n.t('composer.voice.loginRequired'));
    expect(resolveInteraction).not.toHaveBeenCalled();
  } finally {
    await i18n.changeLanguage(previousLanguage);
  }
});

// Unit regression: receipt tests never opened evidence in a question title.
// Minimal input: a bare HTML filename + URL. Real card + remote stat must open
// the controlled computer's file without resolving the question.
it('opens question files on the controlled computer and URLs without resolving the question', async () => {
  const onOpenPath = vi.fn();
  const fileContext: ChatFilePathContextValue = {
    deviceId: 'd1', sessionId: 's1', workdir: '/repo', onOpenPath,
    statPath: vi.fn(async (absPath: string) => ({ kind: absPath.endsWith('missing.html') ? 'missing' as const : 'file' as const, resolvedPath: absPath })),
  };
  remoteSessionStore.setPendingInteractions('s1', [{ request: {
    kind: 'ask_user_question', requestId,
    questions: [{ question: '请查看 sidebar-layout-v1.html 和 https://example.com/view。 missing.html' }],
  } }]);
  await act(async () => root.render(<Harness fileContext={fileContext} />));
  await click('message.markdownPathChip');
  expect(onOpenPath).toHaveBeenCalledWith({ kind: 'file', absPath: '/repo/sidebar-layout-v1.html', relPath: 'sidebar-layout-v1.html' });
  expect(host.querySelectorAll('[data-testid="message.markdownPathChip"]')).toHaveLength(1);
  const url = Array.from(host.querySelectorAll('span')).find((element) => element.textContent === 'https://example.com/view')!;
  await act(async () => url.click());
  expect(evidence.openURL).toHaveBeenCalledWith('https://example.com/view');
  expect(resolveInteraction).not.toHaveBeenCalled();
  expect(host.querySelector('[data-testid="interaction.ask.card"]')).not.toBeNull();
});

// Unit: a new question must not borrow the last file's verified state. The
// existing click test never changed the href at a retained span index. Inspect
// the first committed frame before passive effects can clear the stale verdict.
it('keeps a changed question reference unclickable until its own verification', async () => {
  const onOpenPath = vi.fn();
  const fileContext: ChatFilePathContextValue = {
    deviceId: 'd1', sessionId: 's1', workdir: '/repo', onOpenPath,
    statPath: vi.fn((absPath: string) => absPath.endsWith('present.html')
      ? Promise.resolve({ kind: 'file' as const, resolvedPath: absPath })
      : new Promise<never>(() => {})),
  };
  const changedFrame: boolean[] = [];
  function ReferenceFrame({ text }: { text: string }) {
    useLayoutEffect(() => {
      if (text !== 'missing.html') return;
      const chip = host.querySelector<HTMLElement>('[data-testid="message.markdownPathChip"]');
      changedFrame.push(!!chip);
      chip?.click();
    }, [text]);
    return <ChatFilePathContext.Provider value={fileContext}><QuestionReferenceText text={text} /></ChatFilePathContext.Provider>;
  }
  await act(async () => root.render(<ReferenceFrame text="present.html" />));
  expect(host.querySelector('[data-testid="message.markdownPathChip"]')).not.toBeNull();
  await act(async () => root.render(<ReferenceFrame text="missing.html" />));
  expect(changedFrame).toEqual([false]);
  expect(onOpenPath).not.toHaveBeenCalled();
});

// Unit regression: previous coverage only tested auto-detected references.
// A missing authored file link must still reach the controlled device's preview
// (which reports read failures), without lighting up the same bare reference.
it.each([true, false])('keeps missing file links actionable only when authored: %s', async (explicitLink) => {
  const onOpenPath = vi.fn();
  const fileContext: ChatFilePathContextValue = {
    deviceId: 'd1', sessionId: 's1', workdir: '/repo', onOpenPath,
    statPath: vi.fn(async (absPath: string) => ({ kind: 'missing' as const, resolvedPath: absPath })),
  };
  await act(async () => root.render(
    <ChatFilePathContext.Provider value={fileContext}>
      <ChatPathChipSpan
        candidate={classifyChatPathLinkTarget('/repo/missing.html')}
        explicitLink={explicitLink}
        display="查看报告" SpanText={Text} chipStyle={{ textDecorationLine: 'underline' }}
        plainStyle={{}} usePathState={useState}
      />
    </ChatFilePathContext.Provider>,
  ));
  const link = host.querySelector<HTMLElement>('[data-testid="message.markdownPathChip"]');
  expect(!!link).toBe(explicitLink);
  if (link) {
    await act(async () => link.click());
    expect(onOpenPath).toHaveBeenCalledExactlyOnceWith({
      kind: 'file', absPath: '/repo/missing.html', relPath: 'missing.html',
    });
  } else {
    expect(onOpenPath).not.toHaveBeenCalled();
  }
});

// #7303: an authored directory without a trailing slash can be tapped before
// background stat completes. Wait for its actual kind before choosing a route.
it.each(['open', 'menu', 'unmounted', 'outside'] as const)('waits for an authored directory kind before acting: %s', async (mode) => {
  const onOpenPath = vi.fn();
  const onLongPressPath = vi.fn();
  let finishStat!: (value: { kind: 'dir'; resolvedPath: string }) => void;
  const pending = new Promise<{ kind: 'dir'; resolvedPath: string }>((resolve) => { finishStat = resolve; });
  const fileContext: ChatFilePathContextValue = {
    deviceId: 'd1', sessionId: 's1', workdir: '/repo', onOpenPath, onLongPressPath,
    statPath: vi.fn(() => pending),
  };
  await act(async () => root.render(
    <ChatFilePathContext.Provider value={fileContext}>
      <ChatPathChipSpan candidate={classifyChatPathLinkTarget(mode === 'outside' ? '/other/components' : 'src/components')} explicitLink
        display="目录" SpanText={Text} chipStyle={{}} plainStyle={{}} usePathState={useState} />
    </ChatFilePathContext.Provider>,
  ));
  const link = host.querySelector<HTMLElement>('[data-testid="message.markdownPathChip"]')!;
  await act(async () => mode === 'menu'
    ? link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    : link.click());
  expect(onOpenPath).not.toHaveBeenCalled();
  expect(onLongPressPath).not.toHaveBeenCalled();
  if (mode === 'unmounted') await act(async () => root.render(null));
  await act(async () => finishStat({ kind: 'dir', resolvedPath: '/repo/src/components' }));
  if (mode === 'unmounted' || mode === 'outside') {
    expect(onOpenPath).not.toHaveBeenCalled();
    expect(onLongPressPath).not.toHaveBeenCalled();
    return;
  }
  expect(mode === 'menu' ? onLongPressPath : onOpenPath).toHaveBeenCalledExactlyOnceWith({
    kind: 'directory', absPath: '/repo/src/components', relPath: 'src/components',
  });
});

it.each(['push-first', 'receipt-first', 'lost-receipt', 'other-client'] as const)(
  'finalizes retained answers without stale snapshot resurrection: %s',
  async (order) => {
    const item = { persistId: 'original-row', request: {
      kind: 'ask_user_question', requestId, delivery: 'async', questions: [{ question: 'Original?' }],
    } };
    remoteSessionStore.setPendingInteractions('s1', [item]);
    await act(async () => root.render(<Harness />));
    await type('interaction.ask.textInput', 'Finished');
    let accept!: (value: { accepted: boolean }) => void;
    let reject!: (error: Error) => void;
    resolveInteraction.mockImplementationOnce(() => new Promise((resolve, fail) => {
      accept = resolve; reject = fail;
    }));
    if (order !== 'other-client') await click('interaction.ask.submitButton');
    if (order === 'receipt-first') await act(async () => accept({ accepted: true }));
    await act(async () => {
      remoteSessionStore.applyRemotePush('d1', 'maker:interaction-dismissed', {
        sessionId: 's1', requestId, reason: 'resolved',
        decision: { kind: 'ask_user_question', answers: { 'Original?': 'Finished' } },
      });
      // A snapshot requested before the answer may arrive after its push.
      remoteSessionStore.setPendingInteractions('s1', [item]);
    });
    expect(remoteSessionStore.getVisiblePendingInteractions('s1')).toEqual([]);
    expect(readAskUserDraft(requestId)).toBeNull();
    expect(host.querySelector('[data-testid="interaction.ask.card"]')).toBeNull();
    if (order === 'push-first') await act(async () => accept({ accepted: true }));
    if (order === 'lost-receipt') await act(async () => reject(new Error('receipt lost')));
    expect(asyncReply.input.enqueue).not.toHaveBeenCalled();
    expect(readAskUserDraft(requestId)).toBeNull();
    expect(onError.mock.calls.every(([error]) => error === null)).toBe(true);
  },
);

it.each(['send', 'close', 'stopped', 'stopped-empty', 'already-answered', 'unconfirmed', 'unknown-steer'])('retains edited async answers across expiry and new questions: %s', async (action) => {
  remoteSessionStore.setPendingInteractions('s1', [{
    persistId: 'original-row',
    request: { kind: 'ask_user_question', requestId, delivery: 'async', questions: [{ question: 'Original?' }] },
  }]);
  await act(async () => root.render(<Harness />));
  await type('interaction.ask.textInput', 'Writing');
  await type('interaction.ask.textInput', '');
  const input = host.querySelector('[data-testid="interaction.ask.textInput"]');
  await act(async () => remoteSessionStore.setPendingInteractions('s1', [{
    request: { kind: 'ask_user_question', requestId: 'new-question', questions: [{ question: 'New?' }] },
  }]));
  expect(host.querySelector('[data-testid="interaction.ask.textInput"]')).toBe(input);
  expect(host.textContent).toContain('Original?');
  await type('interaction.ask.textInput', 'Finished');
  resolveInteraction.mockResolvedValue({ accepted: false });
  asyncReply.aroundMessagesByClientId.mockResolvedValue([{
    clientId: 'original-row', role: 'ask_user', content: {
      requestId, status: action === 'already-answered' ? 'answered' : action === 'unconfirmed' ? 'pending' : 'cancelled',
    },
  }]);
  asyncReply.getSession.mockResolvedValue({ id: 's1', agentKind: 'codex', model: 'test', effort: 'medium',
    permissionMode: 'ask', workingDir: '/repo' });
  asyncReply.input.steer.mockResolvedValue(action === 'unknown-steer' ? undefined : false);
  const projection = remoteSessionStore.getInputProjection('s1');
  asyncReply.input.enqueue.mockResolvedValue({ ...projection, queuePaused: action === 'stopped' });
  asyncReply.input.resume.mockResolvedValue({ ...projection, queuePaused: false });
  if (action === 'stopped') {
    await act(async () => remoteSessionStore.setInputProjection('s1', { ...projection, queuePaused: true }));
    expect(host.textContent).toContain('interaction.panel.sendAndContinue');
  }
  if (action === 'stopped-empty') {
    expect(host.textContent).toContain('interaction.panel.sendAndContinue');
    expect(asyncReply.input.enqueue).not.toHaveBeenCalled();
  }
  await click(action === 'close' ? 'interaction.ask.closeButton' : 'interaction.ask.submitButton');
  if (action === 'unconfirmed' || action === 'unknown-steer') {
    expect(host.textContent).toContain('Original?');
    expect(readAskUserDraft(requestId)?.customInput).toBe('Finished');
    expect(onError).toHaveBeenLastCalledWith('interaction.panel.decisionNotAccepted');
  } else {
    expect(onError.mock.calls).toEqual([[null]]);
    expect(host.textContent).toContain('New?');
  }
  if (action === 'send' || action === 'stopped' || action === 'stopped-empty') {
    expect(asyncReply.input.enqueue).toHaveBeenCalledOnce();
    expect(asyncReply.input.enqueue.mock.calls[0][1]).toMatchObject({
      clientId: expect.stringMatching(/^question-reply:codex:test:0:[a-f0-9]{64}$/), text: '> Original?\n\nFinished',
    });
    expect(asyncReply.input.resume).toHaveBeenCalledTimes(action === 'stopped' ? 1 : 0);
  } else expect(asyncReply.input.enqueue).not.toHaveBeenCalled();
});

it('does not retain an untouched async card', async () => {
  remoteSessionStore.setPendingInteractions('s1', [{
    request: { kind: 'ask_user_question', requestId, delivery: 'async', questions: [{ question: 'Original?' }] },
  }]);
  await act(async () => root.render(<Harness />));
  await act(async () => remoteSessionStore.setPendingInteractions('s1', []));
  expect(host.querySelector('[data-testid="interaction.ask.card"]')).toBeNull();
});

it.each(['permission', 'ask_user_question', 'plan_review'])('lets a shared guest submit %s through its decision button', async (kind) => {
  remoteSessionStore.setPendingInteractions('s1', [{ request: {
    kind, requestId, toolName: 'Read', input: { path: '/tmp/test.txt' },
    questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }], plan: 'Read the file.',
  } }]);
  await act(async () => root.render(<Harness deviceId={sharedTaskHostPeer('shared', 'd1')} />));
  expect(host.querySelector('[data-testid="interaction.readOnlyCard"]')).toBeNull();
  resolveInteraction.mockResolvedValueOnce({ accepted: true });
  if (kind === 'ask_user_question') {
    await click('interaction.ask.option.1');
    await click('interaction.ask.submitButton');
  }
  else await click(kind === 'permission' ? 'interaction.permission.allowOnceButton' : 'interaction.plan.approveButton');
  expect(resolveInteraction).toHaveBeenCalledWith(requestId, expect.objectContaining(
    kind === 'ask_user_question' ? { kind, answers: { 'Continue?': 'Yes' } } : { kind, behavior: 'allow' },
  ));
});

it.each([false, true])('renders IM source once with companion=%s and keeps the operation as its title', async companion => {
  const source = '来源：测试群\n原消息：检查目录';
  remoteSessionStore.setPendingInteractions('s1', [{ request: {
    kind: 'permission', requestId, toolName: 'Read', input: { path: '/tmp/test.txt' },
    description: `${source}\n\nRead the requested file`, metadata: { imSourceDescription: source },
  } }]);
  await act(async () => root.render(<Harness companion={companion} />));
  expect(host.textContent!.split(source)).toHaveLength(2);
  expect(host.textContent).toContain('Read the requested file');
  if (companion) {
    const card = host.querySelector('[data-testid="interaction.permission.card"]')!;
    expect(card.children[1].textContent).toBe('Read the requested file');
  }
});

it('submits the host-provided Codex session approval from the shared guest always-allow button', async () => {
  const suggestions = [{ type: 'codexSessionApproval', destination: 'session' }];
  remoteSessionStore.setPendingInteractions('s1', [{ request: {
    kind: 'permission', requestId, toolName: 'Shell', input: { command: 'git status' }, suggestions,
  } }]);
  await act(async () => root.render(<Harness deviceId={sharedTaskHostPeer('shared', 'd1')} />));
  resolveInteraction.mockResolvedValueOnce({ accepted: true });
  await click('interaction.permission.alwaysAllowButton');
  expect(resolveInteraction).toHaveBeenCalledExactlyOnceWith(requestId, {
    kind: 'permission', behavior: 'allow', permissionUpdates: suggestions,
  });
});

it.each(['plugin_setup', 'issue_confirm', 'ghost_grant_confirm', 'rename_sessions_confirm'])('keeps shared guest %s confirmation read-only', async (kind) => {
  remoteSessionStore.setPendingInteractions('s1', [{ request: { kind, requestId } }]);
  await act(async () => root.render(<Harness deviceId={sharedTaskHostPeer('shared', 'd1')} />));
  expect(host.querySelector('[data-testid="interaction.readOnlyCard"]')).not.toBeNull();
  expect(resolveInteraction).not.toHaveBeenCalled();
});

// Bug #1493: collapse belongs to the caller and must survive a card being replaced.
it('collapses through the supplied intent, restores that intent after queue churn, and expands again', async () => {
  const ask = { request: { kind: 'ask_user_question', requestId: 'ask-collapse', questions: [{ question: 'Continue?' }] } };
  remoteSessionStore.setPendingInteractions('s1', [ask]);
  await act(async () => root.render(<CollapsibleHarness />));
  await click('interaction.panel.collapseButton');
  expect(host.querySelector('[data-testid="interaction.panel.collapsedBar"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="interaction.ask.submitButton"]')).toBeNull();
  await act(async () => remoteSessionStore.setPendingInteractions('s1', [{ request: { kind: 'plugin_setup', requestId: 'setup-switch', revision: 1 } }]));
  expect(host.querySelector('[data-testid="interaction.panel.collapsedBar"]')).toBeNull();
  expect(host.querySelector('[data-testid="interaction.panel.collapseButton"]')).toBeNull();
  await act(async () => remoteSessionStore.setPendingInteractions('s1', [ask]));
  await click('interaction.panel.collapsedBar');
  expect(host.querySelector('[data-testid="interaction.ask.submitButton"]')).not.toBeNull();
});

// Remote kinds must not become i18next key paths. Observe the actual rendered title.
it.each(['permission.extra', '__proto__', 'constructor', 'unknown'])('normalizes remote kind %s to its translated fallback', async (kind) => {
  remoteSessionStore.setPendingInteractions('s1', [{ request: { kind, requestId: 'foreign-kind' } }]);
  await act(async () => root.render(<Harness />));
  expect(host.textContent).toContain('interaction.kinds.fallback.title');
  expect(host.textContent).not.toContain('interaction.kinds.' + kind + '.title');
});

it('keeps multiple selections and the free answer when moving back, remounting, and retrying', async () => {
  remoteSessionStore.setPendingInteractions('s1', [{ request: {
    kind: 'ask_user_question', requestId, questions: [
      { question: 'Colors?', multiSelect: true, options: [{ label: 'Red' }, { label: 'Blue' }] },
      { question: 'Note?' },
    ],
  } }]);
  await act(async () => root.render(<Harness companion />));
  await click('interaction.ask.option.1');
  await click('interaction.ask.option.2');
  await click('interaction.ask.submitButton');
  await type('interaction.ask.textInput', 'Keep both');
  await click('interaction.ask.previousButton');
  expect(host.querySelectorAll('[data-testid="interaction.ask.checkbox.checked"]')).toHaveLength(2);
  await click('interaction.ask.submitButton');
  expect(host.querySelector<HTMLInputElement>('[data-testid="interaction.ask.textInput"]')?.value).toBe('Keep both');
  await act(async () => root.render(null));
  await act(async () => root.render(<Harness companion />));
  expect(host.querySelector<HTMLInputElement>('[data-testid="interaction.ask.textInput"]')?.value).toBe('Keep both');
  resolveInteraction.mockResolvedValueOnce({ accepted: false });
  await click('interaction.ask.submitButton');
  expect(host.querySelector<HTMLInputElement>('[data-testid="interaction.ask.textInput"]')?.value).toBe('Keep both');
  resolveInteraction.mockResolvedValueOnce({ accepted: true });
  await click('interaction.ask.submitButton');
  expect(resolveInteraction.mock.calls[1]).toEqual(resolveInteraction.mock.calls[0]);
  expect(resolveInteraction.mock.calls[1][1]).toMatchObject({ answers: { 'Colors?': '["Red","Blue"]', 'Note?': 'Keep both' } });
  expect(readAskUserDraft(requestId)).toBeNull();
});

it('replaces a model-authored "Other" option with the single host custom input', async () => {
  remoteSessionStore.setPendingInteractions('s1', [{ request: {
    kind: 'ask_user_question', requestId, questions: [
      { question: 'Which approach?', options: [{ label: 'Approach A' }, { label: '其他（回复说明）' }] },
    ],
  } }]);
  await act(async () => root.render(<Harness />));
  // 模型选项被宿主入口取代:只剩 option.1 + 自定义入口,不再有 option.2。
  expect(host.querySelector('[data-testid="interaction.ask.option.1"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="interaction.ask.option.2"]')).toBeNull();
  await click('interaction.ask.showCustomButton');
  await type('interaction.ask.customInput', 'Use approach C first');
  resolveInteraction.mockResolvedValueOnce({ accepted: true });
  await click('interaction.ask.submitButton');
  expect(resolveInteraction.mock.calls[0][1]).toMatchObject({
    kind: 'ask_user_question',
    answers: { 'Which approach?': 'Use approach C first' },
  });
});

it('shows the direct free-text input when every option is an "Other" entry', async () => {
  remoteSessionStore.setPendingInteractions('s1', [{ request: {
    kind: 'ask_user_question', requestId, questions: [
      { question: 'Which approach?', options: [{ label: '其他（回复说明）' }, { label: 'Other (please specify)' }] },
    ],
  } }]);
  await act(async () => root.render(<Harness />));
  expect(host.querySelector('[data-testid="interaction.ask.option.1"]')).toBeNull();
  await type('interaction.ask.textInput', 'Something specific');
  resolveInteraction.mockResolvedValueOnce({ accepted: true });
  await click('interaction.ask.submitButton');
  expect(resolveInteraction.mock.calls[0][1]).toMatchObject({
    kind: 'ask_user_question',
    answers: { 'Which approach?': 'Something specific' },
  });
});

it.each([true, false])('preserves edited plan and feedback through rejected receipt (approve=%s)', async (approve) => {
  remoteSessionStore.setPendingInteractions('s1', [{ request: {
    kind: 'plan_review', requestId, plan: '# Original plan\nRead the file.',
  } }]);
  await act(async () => root.render(<Harness companion />));
  await click('interaction.plan.editTab');
  await type('interaction.plan.editor', '# Revised plan\nRead only.');
  await click('interaction.plan.minimizeButton');
  await click('interaction.plan.expandButton');
  expect(host.querySelector<HTMLInputElement>('[data-testid="interaction.plan.editor"]')?.value).toBe('# Revised plan\nRead only.');
  if (!approve) {
    await click('interaction.plan.feedbackButton');
    expect(host.querySelector<HTMLButtonElement>('[data-testid="interaction.plan.submitFeedbackButton"]')?.disabled).toBe(true);
    await type('interaction.plan.feedbackInput', 'Do not write files');
  }
  const action = approve ? 'interaction.plan.approveButton' : 'interaction.plan.submitFeedbackButton';
  resolveInteraction.mockResolvedValueOnce({ accepted: false });
  await click(action);
  expect(readPlanReviewDraft(requestId)?.planText).toBe('# Revised plan\nRead only.');
  resolveInteraction.mockResolvedValueOnce({ accepted: true });
  await click(action);
  expect(resolveInteraction.mock.calls[1]).toEqual(resolveInteraction.mock.calls[0]);
  expect(resolveInteraction.mock.calls[1][1]).toMatchObject({ kind: 'plan_review', behavior: approve ? 'allow' : 'deny' });
  if (approve) expect(resolveInteraction.mock.calls[1][1]).toMatchObject({ editedPlan: '# Revised plan\nRead only.' });
  else expect(resolveInteraction.mock.calls[1][1]).toMatchObject({ reason: 'Do not write files' });
  expect(readPlanReviewDraft(requestId)).toBeNull();
});

it.each([false, true])('restores the last answer after a rejected receipt and clears it after retry (companion=%s)', async (companion) => {
  let reply!: (receipt: { accepted: boolean }) => void;
  resolveInteraction.mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
  remoteSessionStore.setPendingInteractions('s1', [{ request: {
    kind: 'ask_user_question', requestId, questions: [{ question: 'Your answer?' }],
  } }]);
  await act(async () => root.render(<Harness companion={companion} />));
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

it('keeps a typed custom answer when the pending request is refetched or the card remounts', async () => {
  const pending = () => [{ request: {
    kind: 'ask_user_question', requestId,
    questions: [{ question: 'Spine license?', options: [{ label: 'Yes' }, { label: 'No' }] }],
  } }];
  remoteSessionStore.setPendingInteractions('s1', pending());
  await act(async () => root.render(<Harness />));
  const input = () => host.querySelector<HTMLInputElement>('[data-testid="interaction.ask.customInput"]');
  await click('interaction.ask.showCustomButton');
  await act(async () => {
    input()!.value = 'No, figure it out';
    input()!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // 回到前台后重新拉取待处理请求:内容相同但对象引用全新。
  await act(async () => remoteSessionStore.setPendingInteractions('s1', pending()));
  expect(input()?.value).toBe('No, figure it out');
  await act(async () => root.render(null));
  await act(async () => root.render(<Harness />));
  expect(input()?.value).toBe('No, figure it out');
});

it('starts over when the same request replaces its questions', async () => {
  const first = { question: 'First?', options: [{ label: 'Yes' }, { label: 'No' }] };
  const second = { question: 'Second?', options: [{ label: 'A' }, { label: 'B' }] };
  remoteSessionStore.setPendingInteractions('s1', [{ request: { kind: 'ask_user_question', requestId, questions: [first, second] } }]);
  await act(async () => root.render(<Harness />));
  const question = () => (host.textContent!.includes('Second?') ? 'Second?' : host.textContent!.includes('First?') ? 'First?' : null);
  const input = () => host.querySelector<HTMLInputElement>('[data-testid="interaction.ask.customInput"]');
  await click('interaction.ask.option.1');
  await click('interaction.ask.submitButton');
  expect(question()).toBe('Second?');
  await click('interaction.ask.showCustomButton');
  await act(async () => {
    input()!.value = 'Old payload answer';
    input()!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // 同一 requestId 的问题从两道变成一道:旧题号与输入都不能带进新内容。
  await act(async () => remoteSessionStore.setPendingInteractions('s1', [{ request: {
    kind: 'ask_user_question', requestId, questions: [first],
  } }]));
  expect(question()).toBe('First?');
  expect(input()).toBeNull();
  resolveInteraction.mockResolvedValueOnce({ accepted: true });
  await click('interaction.ask.option.2');
  await click('interaction.ask.submitButton');
  expect(resolveInteraction).toHaveBeenCalledTimes(1);
  expect(resolveInteraction.mock.calls[0][1]).toMatchObject({ answers: { 'First?': 'No' } });
});


it.each(['allowOnce', 'deny'])('companion permission preserves complete evidence and %s receipt', async (action) => {
  const content = 'unique-complete-payload-' + 'x'.repeat(800);
  remoteSessionStore.setPendingInteractions('s1', [{ request: {
    kind: 'permission', requestId: 'permission-1', toolName: 'Write',
    input: { file_path: '/tmp/card-ui-qa.txt', content },
  } }]);
  await act(async () => root.render(<Harness companion />));
  expect(host.textContent).toContain('/tmp/card-ui-qa.txt');
  expect(host.textContent).not.toContain(content);
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="interaction.permission.detailsButton"]')!.click());
  expect(host.textContent).toContain(content);
  resolveInteraction.mockResolvedValueOnce({ accepted: false });
  await act(async () => host.querySelector<HTMLButtonElement>(`[data-testid="interaction.permission.${action}Button"]`)!.click());
  expect(resolveInteraction).toHaveBeenLastCalledWith('permission-1', expect.objectContaining({ behavior: action === 'deny' ? 'deny' : 'allow' }));
  expect(host.querySelector('[data-testid="interaction.permission.card"]')).not.toBeNull();
  expect(onError).toHaveBeenCalled();
  resolveInteraction.mockResolvedValueOnce({ accepted: true });
  await act(async () => host.querySelector<HTMLButtonElement>(`[data-testid="interaction.permission.${action}Button"]`)!.click());
  expect(host.querySelector('[data-testid="interaction.permission.card"]')).toBeNull();
});

it('companion permission shows the whole input when no single field leads, never the 500-character preview', async () => {
  const tail = 'unique-tail-' + 'y'.repeat(40);
  remoteSessionStore.setPendingInteractions('s1', [{ request: {
    kind: 'permission', requestId: 'permission-mcp', toolName: 'mcp__notes__append',
    input: { body: 'z'.repeat(600), target: tail },
  } }]);
  await act(async () => root.render(<Harness companion />));
  expect(host.textContent).toContain(tail);
});

it('stacks teammate card buttons one per row once any label would wrap at equal width', async () => {
  textLayouts.clear();
  remoteSessionStore.setPendingInteractions('s1', [{ request: {
    kind: 'permission', requestId: 'p-wrap', toolName: 'Read', input: { path: '/tmp/qa.txt' },
    suggestions: [{ destination: 'session', rules: [{ toolName: 'Read' }] }],
  } }]);
  await act(async () => root.render(<Harness companion />));
  const stacked = () => host.querySelector('[data-testid="interaction.actions.stacked"]');
  await act(async () => textLayouts.get('interaction.permission.deny')!({ nativeEvent: { lines: [{}] } }));
  expect(stacked()).toBeNull();
  // A long label (English 「Always allow this session」 on a narrow card) takes two lines.
  await act(async () => textLayouts.get('interaction.permission.alwaysAllow')!({ nativeEvent: { lines: [{}, {}] } }));
  expect(stacked()).not.toBeNull();
  // Ordinary task cards keep their own layout.
  textLayouts.clear();
  await act(async () => root.render(<Harness />));
  expect(textLayouts.size).toBe(0);
});

it('preserves session-only persistent permission and the high-risk confirmation step', async () => {
  const sessionRule = { destination: 'session', rules: [{ toolName: 'Read' }] };
  remoteSessionStore.setPendingInteractions('s1', [{ request: {
    kind: 'permission', requestId: 'p-safe', toolName: 'Read', input: { path: '/tmp/qa.txt' },
    suggestions: [sessionRule, { destination: 'project', rules: [{ toolName: 'Read' }] }],
  } }]);
  await act(async () => root.render(<Harness companion />));
  resolveInteraction.mockResolvedValue({ accepted: true });
  await click('interaction.permission.alwaysAllowButton');
  expect(resolveInteraction).toHaveBeenLastCalledWith('p-safe', expect.objectContaining({ permissionUpdates: [sessionRule] }));
  await act(async () => remoteSessionStore.setPendingInteractions('s1', [{ request: {
    kind: 'permission', requestId: 'p-risk', toolName: 'Bash', input: { command: 'git reset --hard HEAD && rm -rf node_modules' },
    suggestions: [{ destination: 'session', rules: [{ toolName: 'Bash' }] }],
  } }]));
  expect(host.querySelector('[data-testid="interaction.permission.alwaysAllowButton"]')).toBeNull();
  await click('interaction.permission.allowOnceButton');
  expect(resolveInteraction).toHaveBeenCalledTimes(1);
  await click('interaction.permission.allowOnceButton');
  expect(resolveInteraction).toHaveBeenCalledTimes(2);
  expect(resolveInteraction).toHaveBeenLastCalledWith('p-risk', { kind: 'permission', behavior: 'allow' });
});

it.each(['satisfied', 'failed'])('shows a host-authored plugin terminal state (%s) without stale actions', async (phase) => {
  await act(async () => root.render(<PluginSetupMessageContent request={{ kind: 'plugin_setup', requestId: 'terminal', terminal: true,
    ghost: { id: 'test', name: 'Test' }, steps: [{ id: 'a', title: 'Connect', phase, errorCode: phase === 'failed' ? 'SAVE_FAILED' : undefined }],
  }} busy={false} />));
  expect(host.textContent).not.toContain('interaction.pluginSetup.desktopActionHint');
  expect(host.querySelector('[data-testid="interaction.pluginSetup.cancelButton"]')).toBeNull();
  if (phase === 'failed') expect(host.textContent).toContain('interaction.pluginSetup.error.SAVE_FAILED');
  else expect(host.textContent).toContain('interaction.pluginSetup.phase.satisfied');
});

it('persistent setup shows actual steps and errors, retires desktop instructions at terminal', async () => {
  const request = { kind: 'plugin_setup', requestId: 'setup-1', revision: 1,
    ghost: { id: 'test-plugin', name: 'Test Plugin' }, steps: [{
      id: 'connect', title: 'Connect service', description: 'Complete the connection on your computer', phase: 'failed', errorCode: 'SAVE_FAILED',
      action: { id: 'connect-action', kind: 'oauth_connect' },
    }] };
  await act(async () => root.render(<PluginSetupMessageContent request={request} busy={false} onCancel={() => {}} />));
  expect(host.textContent).toContain('Test Plugin');
  expect(host.textContent).toContain('Connect service');
  expect(host.textContent).toContain('interaction.pluginSetup.error.SAVE_FAILED');
  expect(host.textContent).toContain('interaction.pluginSetup.desktopActionHint');
  expect(host.querySelector('[data-testid="interaction.pluginSetup.cancelButton"]')).not.toBeNull();
  await act(async () => root.render(<PluginSetupMessageContent request={{ ...request, terminal: true,
    steps: [{ ...request.steps[0], phase: 'cancelled' }] }} busy={false} />));
  expect(host.textContent).toContain('interaction.pluginSetup.phase.cancelled');
  expect(host.textContent).not.toContain('interaction.pluginSetup.desktopActionHint');
  expect(host.textContent).not.toContain('interaction.pluginSetup.completeOnDesktop');
  expect(host.textContent).not.toContain('Complete the connection on your computer');
  expect(host.querySelector('[data-testid="interaction.pluginSetup.cancelButton"]')).toBeNull();
});


it('opens only the target computer desktop without resolving or authorizing the plugin', async () => {
  const request = { kind: 'plugin_setup', requestId: 'setup-remote', revision: 1,
    ghost: { id: 'google-gmail', name: 'Gmail' }, remoteOauth: true, remoteSecret: true,
    steps: [{ id: 'account', title: 'Connect Gmail', phase: 'pending', action: { id: 'connect', kind: 'oauth_connect' } }] };
  remoteSessionStore.setPendingInteractions('s1', [{ request }]);
  await act(async () => root.render(<Harness />));
  await click('interaction.pluginSetup.remoteDesktop');
  await click('interaction.pluginSetup.remoteDesktop');
  expect(push).toHaveBeenCalledTimes(1);
  expect(push).toHaveBeenLastCalledWith({ pathname: '/devices/desktop/[deviceId]', params: { deviceId: 'd1', deviceName: 'another computer' } });
  expect(resolveInteraction).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  expect(host.querySelector('input')).toBeNull();
  forwardNavigationLock.reset();
  await act(async () => root.render(<AuthorizationMessageCard message={{ authorization: request } as unknown as NormalizedRemoteMessage} />));
  await click('interaction.pluginSetup.remoteDesktop');
  await click('interaction.pluginSetup.remoteDesktop');
  expect(push).toHaveBeenCalledTimes(2);
  for (const deviceId of [undefined, sharedTaskHostPeer('test', 'd1')]) {
    await act(async () => root.render(<PluginSetupMessageContent request={request} deviceId={deviceId} busy={false} />));
    expect(host.querySelector('[data-testid="interaction.pluginSetup.remoteDesktop"]')).toBeNull();
  }
  await act(async () => root.render(<PluginSetupMessageContent request={{ ...request, terminal: true }} deviceId="d1" busy={false} />));
  expect(host.querySelector('[data-testid="interaction.pluginSetup.remoteDesktop"]')).toBeNull();
});

it('uses the session device when a message route omits it, including a late store update', async () => {
  delete routeParams.deviceId;
  const authorization = { kind: 'plugin_setup', requestId: 'setup-fallback', revision: 1,
    ghost: { id: 'google-gmail', name: 'Gmail' },
    steps: [{ id: 'account', title: 'Connect Gmail', phase: 'pending' }] };
  await act(async () => root.render(<AuthorizationMessageCard message={{ authorization } as unknown as NormalizedRemoteMessage} />));
  expect(host.querySelector('[data-testid="interaction.pluginSetup.remoteDesktop"]')).toBeNull();
  await act(async () => remoteSessionStore.setDeviceIdentity([{ deviceId: 'stored-device', name: 'Work computer' }]));
  await act(async () => remoteSessionStore.setDeviceSessions('stored-device', 'Work computer', [
    { id: 's1' } as Parameters<typeof remoteSessionStore.setDeviceSessions>[2][number],
  ]));
  await click('interaction.pluginSetup.remoteDesktop');
  expect(push).toHaveBeenLastCalledWith({ pathname: '/devices/desktop/[deviceId]',
    params: { deviceId: 'stored-device', deviceName: 'Work computer' } });
  expect(invoke).not.toHaveBeenCalled();
  invoke.mockResolvedValueOnce({ accepted: true });
  await click('interaction.pluginSetup.cancelButton');
  expect(invoke.mock.calls[0][0]).toBe('stored-device');
  routeParams.deviceId = 'explicit-device';
  forwardNavigationLock.reset();
  await act(async () => root.render(<AuthorizationMessageCard message={{ authorization } as unknown as NormalizedRemoteMessage} />));
  await click('interaction.pluginSetup.remoteDesktop');
  expect(push.mock.calls.at(-1)?.[0].params.deviceId).toBe('explicit-device');
});

it('persistent setup cancellation waits for a host terminal update and allows retry after failure', async () => {
  let receipt!: (value: { accepted: boolean }) => void;
  const authorization = { kind: 'plugin_setup', requestId: 'setup-1', revision: 1,
    ghost: { id: 'test-plugin', name: 'Test Plugin' },
    steps: [{ id: 'connect', title: 'Connect service', phase: 'pending' }] };
  const message = { authorization } as unknown as NormalizedRemoteMessage;
  invoke.mockImplementationOnce(() => new Promise(resolve => { receipt = resolve; }));
  await act(async () => root.render(<AuthorizationMessageCard message={message} />));
  const cancel = () => host.querySelector<HTMLButtonElement>('[data-testid="interaction.pluginSetup.cancelButton"]');
  await act(async () => { cancel()!.click(); cancel()!.click(); });
  expect(invoke).toHaveBeenCalledTimes(1);
  await act(async () => receipt({ accepted: false }));
  expect(host.textContent).toContain('devices.companions.actionFailed');
  expect(cancel()?.disabled).toBe(false);
  invoke.mockResolvedValueOnce({ accepted: true });
  await act(async () => cancel()!.click());
  expect(cancel()).not.toBeNull();
  expect(host.textContent).not.toContain('interaction.pluginSetup.phase.cancelled');
  await act(async () => root.render(<AuthorizationMessageCard message={{ authorization: {
    ...authorization, terminal: true, steps: [{ ...authorization.steps[0], phase: 'cancelled' }],
  } } as unknown as NormalizedRemoteMessage} />));
  expect(cancel()).toBeNull();
  expect(host.textContent).toContain('interaction.pluginSetup.phase.cancelled');
});
