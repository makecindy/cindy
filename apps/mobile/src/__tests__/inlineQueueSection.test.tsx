import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON,
  CLAUDE_SUBSCRIPTION_OPUS_PLAN_MISMATCH_REASON,
} from '@cindy/maker-shared/claude-opus-plan-mismatch';
import { i18n, SUPPORTED_LOCALES } from '@/i18n';
import { resolveSessionTailBanner } from '@/session/sessionTailBannerModel';
import type { InputProjection, RemoteMessage } from '@/session/types';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: 'View',
}));

vi.mock('lucide-react-native', () => ({ Pause: 'Pause', Play: 'Play' }));
vi.mock('@/components/AppText', () => ({ Text: 'Text' }));
vi.mock('@/device-link/remoteStatus', () => ({ describeAgentAuthError: () => null }));
vi.mock('@/theme', () => ({
  fontWeight: { medium: '500' },
  iconSize: { xs: 12, sm: 16 },
  iconStroke: { regular: 1.5 },
  lineHeight: { caption: 18 },
  useTheme: () => ({ colors: { ctaText: '#fff', textTertiary: '#888' } }),
  useThemedStyles: () => ({}),
}));
vi.mock('@/theme/tokens', () => ({
  radius: {},
  spacing: {},
  typeScale: {},
}));

import { InlineQueueSection } from '@/session/InlineQueueSection';

const MISLEADING =
  'Claude Opus is not available with the Claude Pro plan. Run /logout and /login.';

function projection(patch: Partial<InputProjection> = {}): InputProjection {
  return {
    sessionId: 's1',
    pendingQueue: [],
    steeringQueueClientIds: [],
    queuePaused: false,
    queueExpanded: false,
    queueInteractionLocks: [],
    queueEditLocks: [],
    queueAbortPending: false,
    error: null,
    errorReason: null,
    recovery: null,
    errorRetryText: null,
    credentialSwitchWait: null,
    continuationTurnClientId: null,
    continuationInFlightProjectionCapability: 'supported',
    ...patch,
  };
}

function renderProjection(value: InputProjection): ReactElement {
  const rendered = InlineQueueSection({
    projection: value,
    onResume: vi.fn(),
    onRetryError: vi.fn(),
    onClearError: vi.fn(),
  });
  if (!isValidElement(rendered)) throw new Error('expected inline queue section');
  return rendered;
}

function findByTestId(node: ReactNode, testID: string): ReactElement | null {
  if (!isValidElement(node)) return null;
  if ((node.props as { testID?: string }).testID === testID) return node;
  for (const child of Children.toArray((node.props as { children?: ReactNode }).children)) {
    const found = findByTestId(child, testID);
    if (found) return found;
  }
  return null;
}

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (!isValidElement(node)) return '';
  return textContent((node.props as { children?: ReactNode }).children);
}

function inlineErrorText(root: ReactElement): string {
  const box = findByTestId(root, 'queue.inline.error');
  if (!box) throw new Error('expected inline error box');
  const text = Children.toArray((box.props as { children?: ReactNode }).children)
    .find((child) => isValidElement(child) && child.type === 'Text');
  if (!text) throw new Error('expected inline error text');
  return textContent(text);
}

describe('InlineQueueSection Claude Opus request attribution', () => {
  it('localizes Gateway and subscription reasons safely in every Mobile locale without changing retry', async () => {
    const previousLanguage = i18n.language;
    const cases = [
      {
        reason: CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON,
        key: 'message.systemCard.claudeGatewayOpusPlanMismatch',
      },
      {
        reason: CLAUDE_SUBSCRIPTION_OPUS_PLAN_MISMATCH_REASON,
        key: 'message.systemCard.claudeSubscriptionOpusPlanMismatch',
      },
    ] as const;

    try {
      for (const locale of SUPPORTED_LOCALES) {
        await i18n.changeLanguage(locale);
        for (const fixture of cases) {
          const root = renderProjection(projection({
            error: MISLEADING,
            errorReason: fixture.reason,
            errorRetryText: 'retry original request',
          }));
          const text = inlineErrorText(root);
          expect(text, `${locale} ${fixture.reason}`).toBe(i18n.t(fixture.key));
          expect(text).not.toMatch(/Claude Pro plan|\/logout|\/login/i);
          expect((findByTestId(root, 'queue.inline.retryButton')?.props as { disabled?: boolean }).disabled)
            .toBe(false);
        }
      }
    } finally {
      await i18n.changeLanguage(previousLanguage);
    }
  });

  it.each([
    ['unknown', 'future-terminal-reason'],
    ['missing', null],
  ])('keeps the raw diagnostic for %s reason and preserves disabled retry semantics', (_label, reason) => {
    const root = renderProjection(projection({
      error: 'ordinary raw provider diagnostic',
      errorReason: reason,
      errorRetryText: null,
    }));
    expect(inlineErrorText(root)).toBe('ordinary raw provider diagnostic');
    expect((findByTestId(root, 'queue.inline.retryButton')?.props as { disabled?: boolean }).disabled)
      .toBe(true);
  });

  it('keeps one safe live banner when the projection suppresses the persisted error tail', async () => {
    const previousLanguage = i18n.language;
    await i18n.changeLanguage('en');
    try {
      const live = projection({
        error: MISLEADING,
        errorReason: CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON,
        errorRetryText: 'retry',
      });
      const persisted: RemoteMessage = {
        id: 'error-row',
        clientId: 'error-row',
        sessionId: 's1',
        role: 'error',
        content: JSON.stringify({
          message: MISLEADING,
          reason: CLAUDE_GATEWAY_OPUS_PLAN_MISMATCH_REASON,
        }),
        toolUseId: null,
        agentMeta: null,
        createdAt: '2026-08-12T00:00:00.000Z',
      };

      expect(resolveSessionTailBanner({
        messages: [persisted],
        session: { activeTurnStartedAt: null, lastTurnEndedAt: null, clearedAt: null },
        projection: { error: live.error, credentialSwitchWait: null },
        isSessionStreaming: false,
        continuationInFlight: false,
        interruptAcked: false,
        hiddenErrorClientIds: new Set(),
      })).toBeNull();
      expect(inlineErrorText(renderProjection(live)))
        .toBe(i18n.t('message.systemCard.claudeGatewayOpusPlanMismatch'));
    } finally {
      await i18n.changeLanguage(previousLanguage);
    }
  });
});
