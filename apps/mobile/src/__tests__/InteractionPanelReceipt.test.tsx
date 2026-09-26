// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sharedTaskHostPeer } from '@cindy/device-link';
import { AuthorizationMessageCard } from '@/session/AuthorizationMessageCard';
import type { NormalizedRemoteMessage } from '@/session/messageNormalize';
import { InteractionPanel, PluginSetupMessageContent } from '@/session/InteractionPanel';
import { remoteSessionStore, useSessionPendingInteractions } from '@/session/remoteSessionStore';
import { clearAllInteractionDrafts, readAskUserDraft, readPlanReviewDraft } from '@/session/interactionDraftStore';

const { resolveInteraction, invoke, push } = vi.hoisted(() => ({ resolveInteraction: vi.fn(), invoke: vi.fn(), push: vi.fn() }));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({ deviceId: 'd1' }), useRouter: () => ({ push }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke }) }));
vi.mock('@/device-link/useMobileMakerTransport', () => ({
  useMobileMakerTransport: () => ({ resolveInteraction }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) }));
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
    TextInput: ({ value, onChangeText, testID, multiline }: {
      value: string; onChangeText: (value: string) => void; testID: string; multiline?: boolean;
    }) => createElement(multiline ? 'textarea' : 'input', { value, 'data-testid': testID,
      onInput: (event: { currentTarget: HTMLInputElement }) => onChangeText(event.currentTarget.value),
      readOnly: true }),
  };
});
vi.mock('lucide-react-native', () => ({ ShieldCheck: () => null, MessageCircle: () => null, ChevronDown: () => null, ChevronUp: () => null, Check: () => null, CornerDownLeft: () => null,
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
function Harness({ companion = false }: { companion?: boolean }) {
  const interactions = useSessionPendingInteractions('s1');
  return <InteractionPanel companion={companion} deviceId="d1" sessionId="s1" interactions={interactions} onError={onError} />;
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
  expect(push).toHaveBeenLastCalledWith({ pathname: '/devices/desktop/[deviceId]', params: { deviceId: 'd1', deviceName: 'd1' } });
  expect(resolveInteraction).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  expect(host.querySelector('input')).toBeNull();
  await act(async () => root.render(<AuthorizationMessageCard message={{ authorization: request } as unknown as NormalizedRemoteMessage} />));
  await click('interaction.pluginSetup.remoteDesktop');
  expect(push).toHaveBeenCalledTimes(2);
  for (const deviceId of [undefined, sharedTaskHostPeer('test', 'd1')]) {
    await act(async () => root.render(<PluginSetupMessageContent request={request} deviceId={deviceId} busy={false} />));
    expect(host.querySelector('[data-testid="interaction.pluginSetup.remoteDesktop"]')).toBeNull();
  }
  await act(async () => root.render(<PluginSetupMessageContent request={{ ...request, terminal: true }} deviceId="d1" busy={false} />));
  expect(host.querySelector('[data-testid="interaction.pluginSetup.remoteDesktop"]')).toBeNull();
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
