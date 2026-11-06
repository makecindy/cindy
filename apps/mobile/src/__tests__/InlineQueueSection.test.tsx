// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { InlineQueueSection, type InlineQueueSectionProps } from '@/session/InlineQueueSection';
import type { InputProjection } from '@/session/types';
import { i18n } from '@/i18n';

vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const view = (tag: string) => ({ children, onPress, disabled, testID, accessibilityHint, accessibilityState }: {
    children?: ReactNode; onPress?: () => void; disabled?: boolean; testID?: string; accessibilityHint?: string;
    accessibilityState?: { busy?: boolean };
  }) => createElement(tag, { onClick: onPress, disabled, 'data-testid': testID, title: accessibilityHint, 'aria-busy': accessibilityState?.busy }, children);
  return { View: view('div'), Text: view('span'), Pressable: view('button'), ActivityIndicator: () => null,
    StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 } };
});
vi.mock('@/components/AppText', async () => ({ Text: (await import('react-native')).Text }));
vi.mock('lucide-react-native', () => ({ Pause: () => null, Play: () => null, Split: () => null, CircleAlert: () => null, X: () => null, ChevronRight: () => null, ChevronDown: () => null }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  return { ...tokens, useTheme: () => ({ colors: tokens.lightColors }),
    useThemedStyles: (make: (colors: typeof tokens.lightColors) => unknown) => make(tokens.lightColors) };
});

let root: Root;
let host: HTMLDivElement;
const retry = vi.fn();
const clear = vi.fn();
const resume = vi.fn();
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));
const projection = { error: 'Usage limit', errorRetryText: 'Try again', queuePaused: true } as InputProjection;
async function show(props: Partial<InlineQueueSectionProps> = {}) {
  await act(async () => root.render(<InlineQueueSection
    projection={projection}
    readOnlyReason={null}
    onRetryError={retry} onClearError={clear} onResume={resume} {...props}
  />));
}
const button = (action: string) => host.querySelector<HTMLButtonElement>(`[data-testid="queue.inline.${action}Button"]`)!;

it('lets the user retry, clear and resume', async () => {
  await show();
  expect(button('retry').disabled).toBe(false);
  expect(button('clearError').disabled).toBe(false);
  expect(button('resume').disabled).toBe(false);
  await act(async () => { button('retry').click(); button('clearError').click(); });
  expect(retry).toHaveBeenCalledOnce(); expect(clear).toHaveBeenCalledOnce();
});
it('keeps readiness and in-flight gates, then re-enables recovery', async () => {
  await show({ readOnlyReason: 'Syncing' });
  expect(button('retry').disabled).toBe(true); expect(button('clearError').title).toBe('Syncing');
  expect(host.querySelector('[data-testid="queue.inline.errorDisabledReason"]')?.textContent).toBe('Syncing');
  await act(async () => { button('retry').click(); button('clearError').click(); });
  expect(retry).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled();
  await show({ busy: true });
  expect(button('retry').disabled).toBe(true); expect(button('clearError').disabled).toBe(true);
  expect(host.textContent).toContain('message.queuePresentation.row.busy');
  await show(); expect(button('retry').disabled).toBe(false);
});
it('allows clearing an error without retry content', async () => {
  await show({ projection: { ...projection, errorRetryText: null } });
  expect(button('retry').disabled).toBe(true); expect(button('clearError').disabled).toBe(false);
});
// Scheduler failures release the original recovery record. The real error UI
// must activate the manual continuation callback while retaining its busy gate.
it('continues a settled error without replaying its old scheduled input', async () => {
  const onContinueAfterError = vi.fn();
  const props = { projection: { ...projection, errorRetryText: null }, onContinueAfterError };
  await show(props);
  expect(button('retry').disabled).toBe(false);
  await act(async () => button('retry').click());
  expect(onContinueAfterError).toHaveBeenCalledOnce();
  expect(retry).not.toHaveBeenCalled();
  await show({ ...props, busy: true });
  expect(button('retry').disabled).toBe(true);
  await show({ onContinueAfterError });
  await act(async () => button('retry').click());
  expect(retry).toHaveBeenCalledOnce();
  expect(onContinueAfterError).toHaveBeenCalledOnce();
});

it('explains a legacy compact failure without its discarded details and retains continuation', async () => {
  const onContinueAfterError = vi.fn();
  await show({
    projection: { ...projection, error: 'Error running remote compact task', errorReason: 'context-overflow', errorRetryText: null },
    onContinueAfterError,
  });
  expect(host.textContent).toContain(i18n.t('session.tail.remoteCompactEncryptedContent'));
  expect(button('retry').disabled).toBe(false);
  await act(async () => button('retry').click());
  expect(onContinueAfterError).toHaveBeenCalledOnce();
  expect(retry).not.toHaveBeenCalled();
});
// #7119 review: a host-confirmed scheduler failure without a retry token must
// obey the existing history-error exclusions. Unit: render the real component;
// previously these three minimal errors exposed a continuation action.
it.each([
  'codex not authenticated: no_credentials',
  'thread not found',
  'invalid_encrypted_content',
])('does not offer continuation for a non-retryable error: %s', async (error) => {
  const onContinueAfterError = vi.fn();
  await show({ projection: { ...projection, error, errorRetryText: null, errorCanContinue: true }, onContinueAfterError });
  expect(button('retry')).toBeNull();
  expect(button('clearError').disabled).toBe(false);
  expect(onContinueAfterError).not.toHaveBeenCalled();
});
// Review #6347: the real error actions must announce in-flight work, separately
// from read-only disabling. Existing tests only checked activation, not VoiceOver
// state. Minimal input: busy=true with a recovery action; unit (RN props -> DOM).
it('announces busy recovery actions without treating read-only as busy', async () => {
  const onRecoverHistory = vi.fn();
  const recovery = () => host.querySelector<HTMLButtonElement>('[data-testid="session.readableHistoryRecovery"]')!;
  await show({ busy: true, onRecoverHistory });
  for (const action of [button('retry'), button('clearError'), recovery()]) {
    expect(action.disabled).toBe(true);
    expect(action.getAttribute('aria-busy')).toBe('true');
  }
  await show({ readOnlyReason: 'Syncing', onRecoverHistory });
  for (const action of [button('retry'), button('clearError'), recovery()]) {
    expect(action.disabled).toBe(true);
    expect(action.getAttribute('aria-busy')).toBe('false');
  }
  await show({ onRecoverHistory });
  expect(recovery().disabled).toBe(false);
  await act(async () => recovery().click());
  expect(onRecoverHistory).toHaveBeenCalledOnce();
});
it('wires queue controls to the session availability gate', () => {
  const source = readFileSync('app/sessions/[sessionId].tsx', 'utf8');
  expect(source).toContain('readOnlyReason={queueAvailabilityReason}');
  expect(source).not.toContain('errorRecoveryReadOnlyReason');
});
