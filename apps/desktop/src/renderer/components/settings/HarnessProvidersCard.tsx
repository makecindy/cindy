import { useCallback, useEffect, useState } from 'react';
import {
  projectProviderFileEndpoints,
  type ProviderFileEndpointView,
  type ProviderFileIssue,
} from '@cindy/model-providers';
import { RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  SETTINGS_ROW_CLASS,
  SETTINGS_ROW_HINT_CLASS,
  SETTINGS_ROW_LABEL_CLASS,
} from './settingsRowClasses';

export function formatEndpointCapabilities(
  capabilities: ProviderFileEndpointView['capabilities'],
): string {
  const parts: string[] = [];
  if (capabilities.tools) parts.push('tools');
  if (capabilities.vision) parts.push('vision');
  if (typeof capabilities.contextLength === 'number' && capabilities.contextLength > 0) {
    const k = Math.round(capabilities.contextLength / 1024);
    parts.push(
      capabilities.contextLength % 1024 === 0 ? `ctx ${k}k` : `ctx ${capabilities.contextLength}`,
    );
  }
  return parts.length > 0 ? parts.join(' · ') : 'text only';
}

/**
 * Pure presentational view for `~/.cindy-harness/providers.yaml` endpoints and
 * discovery status (ROADMAP 2.1b / 2.2b).
 */
export function HarnessProvidersCardView({
  endpoints,
  issues,
  loading = false,
  onRefresh,
}: {
  endpoints: readonly ProviderFileEndpointView[];
  issues: readonly ProviderFileIssue[];
  loading?: boolean;
  onRefresh?: () => void;
}) {
  return (
    <div
      data-testid="harness-providers-card"
      className={cn(SETTINGS_ROW_CLASS, 'flex-col items-start gap-3')}
    >
      <div className="flex w-full items-center justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <span className={SETTINGS_ROW_LABEL_CLASS}>Provider Registry</span>
            <span className="text-11 text-[var(--text-tertiary)]">
              ({endpoints.length})
            </span>
          </div>
          <span className={SETTINGS_ROW_HINT_CLASS}>
            Configured endpoints from{' '}
            <code className="font-mono">~/.cindy-harness/providers.yaml</code>
          </span>
        </div>

        {onRefresh ? (
          <Button
            variant="secondary"
            tone="quiet"
            size="sm"
            onClick={onRefresh}
            disabled={loading}
            className="h-8 shrink-0 gap-1.5 px-2 text-12 text-[var(--settings-section-desc)]"
          >
            <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
            Probe
          </Button>
        ) : null}
      </div>

      {endpoints.length > 0 ? (
        <div className="flex w-full flex-col gap-2">
          {endpoints.map((ep) => {
            const capText = formatEndpointCapabilities(ep.capabilities);
            const authText = ep.keyEnv ? `env: ${ep.keyEnv}` : 'keyless';
            return (
              <div
                key={ep.id}
                data-testid="harness-provider-row"
                className="flex flex-col gap-1 border border-[var(--settings-theme-card-border)] bg-[var(--settings-menu-bg)] px-3 py-2 text-12"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="font-medium text-[var(--text-primary)]">{ep.id}</span>
                    <span className="border border-[var(--settings-theme-card-border)] bg-[var(--bg-card)] px-1.5 py-0.5 font-mono text-10 text-[var(--text-secondary)]">
                      {ep.kind}
                    </span>
                    <span className="text-10 text-[var(--text-tertiary)]">
                      {ep.local ? 'local' : 'remote'}
                    </span>
                  </div>
                  <span
                    data-testid={`harness-provider-status-${ep.id}`}
                    className="font-mono text-11 text-[var(--text-secondary)]"
                  >
                    {ep.status}
                  </span>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-11 text-[var(--text-tertiary)]">
                  <span className="truncate font-mono">{ep.baseUrl}</span>
                  <span>
                    {authText} · {capText}
                  </span>
                </div>

                {ep.status === 'online' && ep.models.length > 0 ? (
                  <div
                    data-testid={`harness-provider-models-${ep.id}`}
                    className="font-mono text-11 text-[var(--text-secondary)]"
                  >
                    Models: {ep.models.join(', ')}
                  </div>
                ) : null}

                {ep.status !== 'online' && ep.error ? (
                  <div
                    data-testid={`harness-provider-error-${ep.id}`}
                    className="text-11 text-[var(--text-tertiary)]"
                  >
                    {ep.error}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex w-full items-center justify-between border border-dashed border-[var(--settings-theme-card-border)] px-3 py-2.5 text-12 text-[var(--text-tertiary)]">
          <span>
            No endpoints configured in ~/.cindy-harness/providers.yaml.
          </span>
        </div>
      )}

      {issues.length > 0 ? (
        <div
          data-testid="harness-provider-issues"
          className="flex w-full flex-col gap-1 border border-[var(--settings-theme-card-border)] bg-[var(--settings-menu-bg)] px-3 py-2 text-11 text-[var(--text-secondary)]"
        >
          {issues.map((issue, idx) => (
            <div key={`${issue.entry}-${idx}`} data-testid="harness-provider-issue">
              <span className="font-mono font-medium text-[var(--text-primary)]">
                {issue.entry}:
              </span>{' '}
              <span>{issue.message}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function HarnessProvidersCard() {
  const [endpoints, setEndpoints] = useState<ProviderFileEndpointView[]>([]);
  const [issues, setIssues] = useState<ProviderFileIssue[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    const api = window.electronAPI?.maker?.providers;
    if (!api) return;
    setLoading(true);
    try {
      const [fileResult, probes] = await Promise.all([
        api.list(),
        api.discover().catch(() => []),
      ]);
      setEndpoints(projectProviderFileEndpoints(fileResult.providers ?? [], probes));
      setIssues(fileResult.issues ?? []);
    } catch {
      // Keep existing state when IPC is unavailable.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <HarnessProvidersCardView
      endpoints={endpoints}
      issues={issues}
      loading={loading}
      onRefresh={() => void refresh()}
    />
  );
}
