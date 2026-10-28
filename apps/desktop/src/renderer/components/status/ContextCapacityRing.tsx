import { useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { Tip } from '@/components/ui/tooltip';
import { useCodexContextWindow } from '@/hooks/useCodexContextWindow';
import { getModelsForVendor } from '@/lib/modelDefinitions';
import { resolveDisplayContextWindow } from '@/lib/contextWindow';
import { ContextWindowBudgetChip } from './ContextWindowBudgetChip';

/** Format a token count with K/M suffix: 200000 → "200K", 1000000 → "1M". */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
  }
  return n.toString();
}

/**
 * 从 maker capabilities cache 查模型 contextWindow。
 * 拿不到时返回 undefined，由 display resolver 兜底到 200K。
 */
export function getModelContextWindow(
  model: string,
  vendorKey: 'cc' | 'codex' | 'pi',
  deviceId?: string,
): number | undefined {
  const found = getModelsForVendor(vendorKey, deviceId).find((m) => m.id === model);
  return found?.contextWindow;
}

export function ContextCapacityRing({
  variant = 'ring',
  isRunning,
  sessionId,
  providerId,
  contextTokens,
  model,
  vendorKey,
  sdkContextWindow,
  verifiedContextWindow,
  deviceId,
  onCompact,
  providers,
  disabled,
}: {
  variant?: 'ring' | 'bar';
  isRunning?: boolean;
  sessionId?: string;
  providerId?: string | null;
  contextTokens: number;
  model: string;
  vendorKey: 'cc' | 'codex' | 'pi';
  /** SDK-reported context window; 0 = not yet known → use hardcoded fallback. */
  sdkContextWindow: number;
  verifiedContextWindow?: number | null;
  /** device-link 远程会话所属被控端 id;按被控端能力查 contextWindow(本机会话 undefined,行为不变)。 */
  deviceId?: string;
  /** 提供时在圆环浮层里显示手动压缩操作，沿用已有确认流程。 */
  onCompact?: () => void;
  providers?: ComponentProps<typeof ContextWindowBudgetChip>['providers'];
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [contextInspection, setContextInspection] = useState(0);
  const codexContext = useCodexContextWindow({
    enabled: vendorKey === 'codex' && !deviceId && Boolean(sessionId),
    providerId,
    modelId: model,
    sessionId,
    reportedWindow: sdkContextWindow,
    refreshKey: `${isRunning}:${contextInspection}`,
  });
  const contextWindow = resolveDisplayContextWindow({
    sdkContextWindow,
    verifiedContextWindow,
    runtimeWindowAuthoritative: vendorKey === 'codex',
    nativeContextWindow: codexContext?.contextWindow,
    nativeContextPending: codexContext?.pendingApply,
    modelContextWindow: getModelContextWindow(model, vendorKey, deviceId),
  });
  const pct =
    contextWindow > 0
      ? Math.min(Math.max(Math.round((contextTokens / contextWindow) * 100), 0), 100)
      : 0;

  // Ring geometry: outer diameter 20px, strokeWidth 2.5
  const size = 20;
  const strokeWidth = 2.5;
  const radius = (size - strokeWidth) / 2; // 8.75
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (circumference * pct) / 100;

  // Color thresholds per spec
  const fillColor =
    pct > 90
      ? 'var(--error-flat)'
      : pct > 70
        ? 'var(--warning-fg)'
        : 'var(--msg-tool-card-chevron)';

  const usedTokens = Math.max(0, contextTokens);
  const tooltipText =
    contextWindow > 0
      ? `Context — ${formatTokenCount(usedTokens)} / ${formatTokenCount(contextWindow)} (${pct}%)`
      : 'No context data yet';

  const ringContent = variant === 'bar' ? (
    <span className="hud-context-track" aria-hidden="true">
      <span className="hud-context-fill" style={{ width: `${pct}%`, background: fillColor }} />
    </span>
  ) : (
    <>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="shrink-0"
        aria-hidden="true"
        focusable="false"
      >
        {/* Track (background circle) */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--msg-tool-card-border)"
          strokeWidth={strokeWidth}
        />
        {/* Fill arc — starts at 12 o'clock, sweeps clockwise */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={fillColor}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="text-12 font-medium leading-none" style={{ color: fillColor }}>
        {contextWindow > 0 ? `${pct}%` : '—'}
      </span>
    </>
  );

  const statusKey =
    contextWindow <= 0 ? 'unknown' : pct > 90 ? 'nearLimit' : pct > 70 ? 'elevated' : 'available';
  const details = (
    <div className="space-y-4">
      <div>
        <p className="text-11 font-medium tracking-widest text-[var(--text-tertiary)]">CONTEXT</p>
        <h3 className="mt-1 text-16 font-medium text-[var(--text-primary)]">
          {t('ccAgent.contextRingPanel.title')}
        </h3>
        <p className="mt-1.5 text-12 leading-relaxed text-[var(--text-secondary)]">
          {t('ccAgent.contextRingPanel.meaning')}
        </p>
      </div>
      <div>
        <div className="flex items-end justify-between gap-3">
          <div className="flex items-baseline gap-1 tabular-nums text-[var(--text-primary)]">
            <span className="text-28 font-medium leading-none tracking-tight">
              {contextWindow > 0 ? pct : '—'}
            </span>
            {contextWindow > 0 && <span className="text-16">%</span>}
            <span className="ml-1 text-12 text-[var(--text-secondary)]">
              {t('ccAgent.contextRingPanel.used')}
            </span>
          </div>
          <span className="text-12 font-medium" style={{ color: fillColor }}>
            {t(`ccAgent.contextRingPanel.${statusKey}`)}
          </span>
        </div>
        {contextWindow > 0 && (
          <>
            <div
              role="progressbar"
              aria-label={t('ccAgent.contextRingPanel.used')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--msg-tool-card-border)]"
            >
              <div
                className="h-full rounded-full"
                style={{ width: `${pct}%`, backgroundColor: fillColor }}
              />
            </div>
            <p className="mt-2 text-11 tabular-nums text-[var(--text-secondary)]">
              {t('ccAgent.contextRingPanel.tokens', {
                used: formatTokenCount(usedTokens),
                total: formatTokenCount(contextWindow),
              })}
            </p>
          </>
        )}
        {(contextWindow <= 0 || pct <= 70) && (
          <p className="mt-2 text-12 leading-relaxed text-[var(--text-secondary)]">
            {t(`ccAgent.contextRingPanel.${contextWindow <= 0 ? 'unknownHint' : 'continueHint'}`)}
          </p>
        )}
      </div>
      {vendorKey === 'codex' && (
        <div className="border-t border-[var(--border-default)] pt-3">
          <p className="text-12 font-medium text-[var(--text-primary)]">
            {t('ccAgent.contextRingPanel.auto')}
          </p>
          <p className="mt-1 text-12 leading-relaxed text-[var(--text-secondary)]">
            {t('ccAgent.contextRingPanel.autoHelp')}
          </p>
          {codexContext?.pendingApply && (
            <p className="mt-1 text-12 text-[var(--warning-fg)]">
              {t('ccAgent.layout.contextRing.codexPendingHint')}
            </p>
          )}
          <details className="mt-2 text-11 text-[var(--text-secondary)]">
            <summary className="cursor-pointer">{t('ccAgent.contextRingPanel.technical')}</summary>
            <p className="mt-1 leading-relaxed">
              {codexContext
                ? t('settings.providers.models.advanced.codexContextValues', {
                    total: codexContext.contextWindow.toLocaleString(),
                    usable: codexContext.usableContextWindow.toLocaleString(),
                    compact: codexContext.autoCompactTokenLimit.toLocaleString(),
                  })
                : t('settings.providers.models.advanced.codexContextUnknown')}
            </p>
          </details>
        </div>
      )}
    </div>
  );

  if (sessionId && variant === 'ring') {
    return (
      <ContextWindowBudgetChip
        sessionId={sessionId}
        contextTokens={contextTokens}
        model={model}
        providerId={providerId}
        agentKind={vendorKey}
        providers={providers}
        deviceId={deviceId}
        disabled={disabled}
        details={details}
        onInspect={vendorKey === 'codex' ? () => setContextInspection((n) => n + 1) : undefined}
        onCompact={onCompact}
      >
        {ringContent}
      </ContextWindowBudgetChip>
    );
  }

  return (
    <Tip
      text={
        onCompact ? (
          <>
            <div>{tooltipText}</div>
            <div>{t('ccAgent.layout.contextRing.compactHint')}</div>
          </>
        ) : vendorKey === 'codex' ? (
          // Native Codex manages compaction; this control only reads its capacity.
          <>
            <div>
              {codexContext?.pendingApply
                ? t('ccAgent.layout.contextRing.codexPendingHint')
                : tooltipText}
            </div>
            <div>
              {codexContext
                ? t('settings.providers.models.advanced.codexContextValues', {
                    total: codexContext.contextWindow.toLocaleString(),
                    usable: codexContext.usableContextWindow.toLocaleString(),
                    compact: codexContext.autoCompactTokenLimit.toLocaleString(),
                  })
                : t('settings.providers.models.advanced.codexContextUnknown')}
            </div>
            <div>{t('ccAgent.layout.contextRing.codexAutoHint')}</div>
          </>
        ) : (
          tooltipText
        )
      }
    >
      {onCompact ? (
        <button
          type="button"
          onClick={onCompact}
          aria-label={t('ccAgent.layout.contextRing.compactHint')}
          className={variant === 'bar' ? 'hud-context-bar' : 'flex shrink-0 cursor-pointer items-center gap-1 transition-opacity hover:opacity-75 active:opacity-60'}
        >
          {ringContent}
        </button>
      ) : (
        <div
          className={variant === 'bar' ? 'hud-context-bar' : 'flex shrink-0 items-center gap-1'}
          tabIndex={variant === 'bar' ? 0 : undefined}
          role={variant === 'bar' ? 'meter' : undefined}
          aria-label={variant === 'bar' ? tooltipText : undefined}
          aria-valuemin={variant === 'bar' ? 0 : undefined}
          aria-valuemax={variant === 'bar' ? 100 : undefined}
          aria-valuenow={variant === 'bar' ? pct : undefined}
          onFocus={() => { if (vendorKey === 'codex') setContextInspection((n) => n + 1); }}
          onMouseEnter={() => {
            if (vendorKey === 'codex') setContextInspection((n) => n + 1);
          }}
        >
          {ringContent}
        </div>
      )}
    </Tip>
  );
}
