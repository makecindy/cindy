import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  guardContext,
  resolveTaskRoute,
  type ContextGuardResult,
  type ProbeLike,
  type ProviderFileEntry,
  type RouteAlternative,
  type RoutingFile,
} from '@cindy/model-providers';
import { useNavigate } from 'react-router-dom';

import { useChatDisplaySnapshot } from '@/components/chat/ChatDisplaySnapshotContext';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import type { Session } from '@/lib/ccAgent.types';
import { makerChatStore, type ChatMessage } from '@/lib/makerChatStore';
import * as sessionService from '@/lib/sessionService';
import { formatRouteAlternativeLabel } from './SessionRouteBlockedBanner';

export type MessageForSummariser = Pick<ChatMessage, 'role' | 'content' | 'turnUsageDetails'>;

/**
 * Resolve the conversation's current used token count for context-guard checks
 * (ROADMAP 2.5b). Prefers the latest assistant turn's `inputTokens + outputTokens`
 * (or `totalTokens`), falling back to `session.contextTokens` or `session.totalTokenUsage`.
 */
export function resolveSessionUsedTokens(
  messages: readonly MessageForSummariser[],
  session?: Pick<Session, 'contextTokens' | 'totalTokenUsage'> | null,
): number {
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || m.role !== 'assistant' || !m.turnUsageDetails) continue;
      const details = m.turnUsageDetails;
      const turnTotal =
        typeof details.totalTokens === 'number' && details.totalTokens > 0
          ? details.totalTokens
          : (details.inputTokens ?? 0) + (details.outputTokens ?? 0);
      if (turnTotal > 0) return turnTotal;
    }
  }
  if (session && typeof session.contextTokens === 'number' && session.contextTokens > 0) {
    return session.contextTokens;
  }
  if (session && typeof session.totalTokenUsage === 'number' && session.totalTokenUsage > 0) {
    return session.totalTokenUsage;
  }
  return 0;
}

/**
 * Resolve the active model's configured context length from `providers.yaml`
 * (`capabilities.contextLength`) via the session's provider, `routing.yaml`, or the
 * online endpoint whose discovered model list includes the session model, falling
 * back to `session.contextWindow` when positive.
 */
export function resolveSessionContextLength(params: {
  sessionModel?: string | null;
  sessionProviderId?: string | null;
  sessionContextWindow?: number | null;
  routing: RoutingFile;
  providers: readonly ProviderFileEntry[];
  /** Live endpoint probes; an online endpoint listing the model is where it runs. */
  probes?: readonly ProbeLike[];
}): number | undefined {
  const { sessionModel, sessionProviderId, sessionContextWindow, routing, providers, probes } = params;
  const byId = new Map(providers.map((p) => [p.id, p]));

  if (sessionProviderId && byId.has(sessionProviderId)) {
    const cap = byId.get(sessionProviderId)?.capabilities.contextLength;
    if (typeof cap === 'number' && cap > 0) return cap;
  }

  const trimmedModel = sessionModel?.trim();
  if (trimmedModel && trimmedModel !== 'hermes-default') {
    const matched = Object.values(routing.routes ?? {}).find(
      (target) => target.model === trimmedModel,
    );
    if (matched) {
      const cap = byId.get(matched.provider)?.capabilities.contextLength;
      if (typeof cap === 'number' && cap > 0) return cap;
    }
    // Models discovered on an endpoint (not hand-listed in routing.yaml) run on that
    // endpoint, so its limit applies, not chat.default's.
    const serving = probes?.find(
      (probe) => probe.status === 'online' && probe.models.includes(trimmedModel),
    );
    const servingCap = serving ? byId.get(serving.id)?.capabilities.contextLength : undefined;
    if (typeof servingCap === 'number' && servingCap > 0) return servingCap;
  }

  if (typeof sessionContextWindow === 'number' && sessionContextWindow > 0) {
    return sessionContextWindow;
  }

  const defaultRoute = resolveTaskRoute(routing, 'chat.default');
  if (defaultRoute.ok) {
    const cap = byId.get(defaultRoute.target.provider)?.capabilities.contextLength;
    if (typeof cap === 'number' && cap > 0) return cap;
  }

  return undefined;
}

export const SUMMARISE_SYSTEM_PROMPT =
  'Summarise this conversation concisely so a new session can continue the task without losing key decisions, file paths, constraints, or open questions.';

/**
 * Build the prompt sent to the routed `summary` model for "summarise and continue"
 * (ROADMAP 2.5b). Keeps the newest user/assistant messages within `maxChars`.
 */
export function buildConversationSummaryPrompt(
  messages: readonly Pick<ChatMessage, 'role' | 'content'>[],
  maxChars = 12_000,
): string {
  if (!Array.isArray(messages)) return '';
  const eligible = messages.filter(
    (m) =>
      m &&
      (m.role === 'user' || m.role === 'assistant') &&
      typeof m.content === 'string' &&
      m.content.trim().length > 0,
  );
  if (eligible.length === 0) return '';

  const kept: string[] = [];
  let used = 0;
  for (let i = eligible.length - 1; i >= 0; i--) {
    const m = eligible[i]!;
    const label = m.role === 'user' ? 'User' : 'Assistant';
    const text = m.content.trim().slice(0, 2_000);
    const line = `${label}: ${text}`;
    if (kept.length > 0 && used + line.length + 2 > maxChars) break;
    kept.unshift(line);
    used += line.length + 2;
  }

  return [
    'Summarise the following conversation so the owner can continue in a fresh session:',
    '',
    kept.join('\n\n'),
  ].join('\n');
}

/**
 * Pure presentation for the context-window guard banner (ROADMAP 2.5b).
 *
 * Renders nothing when context level is `ok` or `unknown`. At `warn` or `critical`,
 * shows the context usage message and either:
 * - a one-click "Summarise and continue (<provider>/<model>)" button when the
 *   `summary` route is healthy, or
 * - the blocked reason + one-click alternative route buttons (never auto-switching).
 */
export function SessionContextGuardBannerView({
  guard,
  summarising = false,
  summaryError,
  onSummariseAndContinue,
  onSelectSummaryAlternative,
  onDismiss,
  style,
  className,
}: {
  guard: ContextGuardResult | null;
  summarising?: boolean;
  summaryError?: string | null;
  onSummariseAndContinue: () => void;
  onSelectSummaryAlternative?: (alt: RouteAlternative) => void;
  onDismiss?: () => void;
  style?: React.CSSProperties;
  className?: string;
}) {
  if (!guard) return null;
  const { context, summarise } = guard;
  if (context.level !== 'warn' && context.level !== 'critical') {
    return null;
  }

  return (
    <div
      data-testid="session-context-guard-banner"
      data-context-level={context.level}
      className={className ?? 'mx-1 shrink-0'}
      style={style ?? WINDOW_NO_DRAG_STYLE}
    >
      <ErrorNotice
        message={context.message}
        description={
          summaryError
            ? `Summarise failed: ${summaryError}`
            : summarise && !summarise.ok
              ? `Summary route blocked: ${summarise.message}`
              : undefined
        }
        onDismiss={onDismiss}
        actions={
          summarise?.ok ? (
            <Button
              type="button"
              size="sm"
              compact
              variant="secondary"
              loading={summarising}
              disabled={summarising}
              data-testid="summarise-and-continue-btn"
              onClick={onSummariseAndContinue}
            >
              {`Summarise and continue (${summarise.provider}/${summarise.model})`}
            </Button>
          ) : summarise && !summarise.ok && summarise.alternatives.length > 0 ? (
            <div
              data-testid="context-guard-summary-alternatives"
              className="flex flex-wrap items-center gap-1.5"
            >
              {summarise.alternatives.map((alt) => (
                <Button
                  key={alt.routeName}
                  type="button"
                  size="sm"
                  compact
                  variant="secondary"
                  disabled={summarising}
                  data-testid={`use-summary-alternative-${alt.routeName}`}
                  data-route-paid={alt.paid ? 'true' : 'false'}
                  onClick={() => onSelectSummaryAlternative?.(alt)}
                >
                  {formatRouteAlternativeLabel(alt)}
                </Button>
              ))}
            </div>
          ) : null
        }
      />
    </div>
  );
}

export function SessionContextGuardBanner({
  session,
  style,
  className,
}: {
  session: Session;
  style?: React.CSSProperties;
  className?: string;
}) {
  const navigate = useNavigate();
  const displaySnapshot = useChatDisplaySnapshot(session.id);
  const [storeMessages, setStoreMessages] = useState<readonly ChatMessage[]>(() =>
    session.id ? makerChatStore.getSnapshot(session.id).messages : [],
  );
  const [routing, setRouting] = useState<RoutingFile>({ routes: {}, rules: {} });
  const [providers, setProviders] = useState<ProviderFileEntry[]>([]);
  const [probes, setProbes] = useState<ProbeLike[]>([]);
  const [summarising, setSummarising] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  useEffect(() => {
    if (displaySnapshot) return undefined;
    if (!session.id) {
      setStoreMessages([]);
      return undefined;
    }
    const update = () => {
      setStoreMessages(makerChatStore.getSnapshot(session.id).messages);
    };
    update();
    return makerChatStore.subscribe(session.id, update);
  }, [displaySnapshot, session.id]);

  useEffect(() => {
    if (session.agentKind !== 'hermes') return;
    const api = window.electronAPI?.maker?.providers;
    if (!api?.list || !api?.discover || !api?.getRouting) return;
    let cancelled = false;
    void Promise.all([api.list(), api.getRouting(), api.discover()])
      .then(([providersRes, routingRes, probesRes]) => {
        if (cancelled) return;
        setProviders(providersRes.providers ?? []);
        setRouting(routingRes ?? { routes: {}, rules: {} });
        setProbes(probesRes ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session.agentKind, session.id, session.model]);

  const messages = displaySnapshot ? displaySnapshot.messages : storeMessages;

  const guard = useMemo<ContextGuardResult | null>(() => {
    if (session.agentKind !== 'hermes') return null;
    const usedTokens = resolveSessionUsedTokens(messages, session);
    const contextLength = resolveSessionContextLength({
      sessionModel: session.model,
      sessionProviderId: session.providerId,
      sessionContextWindow: session.contextWindow,
      routing,
      providers,
      probes,
    });
    return guardContext({
      usedTokens,
      contextLength,
      routing,
      providers,
      probes,
    });
  }, [messages, probes, providers, routing, session]);

  const handleSummariseAndContinue = useCallback(async () => {
    const api = window.electronAPI?.maker?.providers;
    if (!api?.requestRoutedTaskText) return;
    const prompt = buildConversationSummaryPrompt(messages);
    if (!prompt) {
      setSummaryError('Conversation has no messages to summarise.');
      return;
    }
    setSummarising(true);
    setSummaryError(null);
    try {
      const res = await api.requestRoutedTaskText({
        taskClass: 'summary',
        prompt,
        systemPrompt: SUMMARISE_SYSTEM_PROMPT,
        maxTokens: 1024,
      });
      if (res.kind !== 'ok') {
        setSummaryError(
          res.kind === 'not-routed'
            ? 'No summary route configured in routing.yaml'
            : res.message,
        );
        return;
      }
      const nextSession = await sessionService.create({
        title: `${session.title || 'Session'} (continued)`,
        workingDir: session.workingDir ?? undefined,
        workspaceKind: session.workspaceKind,
        agentKind: session.agentKind,
        model: session.model,
        providerId: session.providerId,
        permissionMode: session.permissionMode,
      });
      const handoffPrompt = [
        `Summary of previous session "${session.title || 'Untitled'}" (summarised by ${res.provider}/${res.model}):`,
        '',
        res.text,
        '',
        'Continue from this context.',
      ].join('\n');
      await makerChatStore.sendMessage(
        nextSession.id,
        handoffPrompt,
        nextSession.model || session.model || 'hermes-default',
        nextSession.effort || session.effort || 'medium',
        nextSession.permissionMode || session.permissionMode || 'default',
        nextSession.workingDir || session.workingDir || '/',
      );
      navigate(`/cc-agent/${nextSession.id}`);
    } catch (error) {
      setSummaryError(error instanceof Error ? error.message : String(error));
    } finally {
      setSummarising(false);
    }
  }, [messages, navigate, session]);

  if (session.agentKind !== 'hermes' || !guard) return null;
  if (guard.context.level !== 'warn' && guard.context.level !== 'critical') return null;

  const currentKey = `${session.id}:${guard.context.level}:${guard.context.usedTokens}`;
  if (dismissedKey === currentKey) return null;

  return (
    <SessionContextGuardBannerView
      guard={guard}
      summarising={summarising}
      summaryError={summaryError}
      onSummariseAndContinue={() => void handleSummariseAndContinue()}
      onDismiss={() => setDismissedKey(currentKey)}
      style={style}
      className={className}
    />
  );
}
