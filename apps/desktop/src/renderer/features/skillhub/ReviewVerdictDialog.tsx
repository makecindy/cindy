import { Button } from '@/components/ui/button';
/**
 * ReviewVerdictDialog — WARN and BLOCK review result dialogs.
 *
 *   WARN:  ZsNls (Light) / 4kwHH (Dark)
 *   BLOCK: VIuO3 (Light) / cRUum (Dark)
 *
 * 480px wide, cornerRadius 12, Card fill, Board border, backdrop bg-black/40.
 * All icons strictly grayscale per docs/design-rules/cindy-design-system.md / N12.
 */

import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle, XCircle } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface ReviewIssue {
  level: 'INFO' | 'WARN' | 'BLOCK';
  message: string;
  location?: string;
}

interface ReviewVerdictDialogProps {
  open: boolean;
  verdict: 'PASS' | 'WARN' | 'BLOCK';
  summary: string;
  issues: ReviewIssue[];
  /** Optional title override for non-local-review results, such as hub scan results. */
  title?: string;
  /** Optional subtitle fallback when summary is empty. */
  subtitle?: string;
  /** Optional primary button label for PASS/BLOCK single-action variants. */
  primaryLabel?: string;
  /** Called when user clicks "仍要发布" (WARN only). */
  onProceed?: () => void;
  /** Called when user clicks "取消" (WARN) or "去修改" (BLOCK). */
  onCancel: () => void;
}

// ── Issue level icon — strictly grayscale ────────────────────────────────────

function IssueLevelIcon({ level }: { level: ReviewIssue['level'] }) {
  if (level === 'BLOCK') {
    return <XCircle size={14} className="mt-0.5 shrink-0 text-[var(--settings-theme-icon)]" />;
  }
  if (level === 'WARN') {
    return <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--settings-theme-icon)]" />;
  }
  // INFO — no icon, just a bullet dot
  return (
    <span
      aria-hidden
      className="mt-[5px] inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--settings-theme-icon)]"
    />
  );
}

// ── Button helpers ────────────────────────────────────────────────────────────

// Spec: WARN 主行动 "知晓警告并继续发布" 用次级灰底而非主黑(语义=非首选)
// 规范沿用 PublishDialog button 尺寸 (h-8 / px-4 / text-sm)
function GrayPillButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <Button variant="primary" size="md" compact type="button" onClick={onClick}>
      {children}
    </Button>
  );
}

function WhitePillButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <Button variant="secondary" size="md" compact type="button" onClick={onClick}>
      {children}
    </Button>
  );
}

// ── ReviewVerdictDialog ───────────────────────────────────────────────────────

export function ReviewVerdictDialog({
  open,
  verdict,
  summary,
  issues,
  title: titleOverride,
  subtitle: subtitleOverride,
  primaryLabel,
  onProceed,
  onCancel,
}: ReviewVerdictDialogProps) {
  const { t } = useTranslation();
  // Design: CNtn8 WARN / vIcUa BLOCK
  // WARN: icon-box #e5e5e5 filled, triangle-alert #262626; title "审核发现潜在问题"
  // BLOCK: icon-box #262626 filled, X icon white; title "无法发布"
  const isPass = verdict === 'PASS';
  const isWarn = verdict === 'WARN';
  const title = titleOverride ?? (
    isPass
      ? t('skillhub.scanResult.passedTitle')
      : isWarn
        ? t('skillhub.reviewVerdict.warnTitle')
        : t('skillhub.reviewVerdict.blockTitle')
  );
  const subtitle = subtitleOverride ?? (
    isPass
      ? t('skillhub.scanResult.passedDesc')
      : isWarn
        ? t('skillhub.reviewVerdict.warnSubtitle', { count: issues.length })
        : t('skillhub.reviewVerdict.blockSubtitle')
  );

  return (
    <Dialog.Root open={open} modal>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
        <Dialog.Content
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          className={cn(
            'fixed left-1/2 top-1/2 z-[10000] -translate-x-1/2 -translate-y-1/2',
            'w-full max-w-[480px] rounded-xl overflow-hidden',
            'border bg-[var(--cmd-palette-bg)]',
            'border-[var(--cmd-palette-border)]',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          aria-describedby={undefined}
        >
          {/* Header: icon-box + title + subtitle — spec: padding [20,24,12,24], gap 12 */}
          <div className="flex items-start gap-3 px-6 pb-3 pt-5">
            {/* Icon box — WARN: #e5e5e5 bg, BLOCK: #262626 bg */}
            <div className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
              isWarn || isPass
                ? 'bg-[var(--chat-input-chip-bg)]'
                : 'bg-[var(--lightbox-cta-bg)]',
            )}>
              {isPass ? (
                <CheckCircle size={18} className="text-[var(--msg-assistant-text)]" />
              ) : isWarn ? (
                <AlertTriangle size={18} className="text-[var(--msg-assistant-text)]" />
              ) : (
                <XCircle size={18} className="text-[var(--lightbox-cta-fg)]" />
              )}
            </div>
            <div className="flex flex-col gap-1.5 pt-0.5">
              {/* Spec: title 18px / 500 (与基准 dialog 一致) */}
              <Dialog.Title className="text-lg font-medium text-[var(--msg-assistant-text)]">
                {title}
              </Dialog.Title>
              {(summary || subtitle) && (
                /* Spec: subtitle 12px / normal */
                <p className="text-xs leading-[1.5] text-[var(--cmd-palette-item-meta)]">
                  {summary || subtitle}
                </p>
              )}
            </div>
          </div>

          {/* Issues list — px-4 py-0, gap-1.5 */}
          {issues.length > 0 && (
            <div className="flex flex-col gap-1.5 px-4 pb-1">
              {issues.map((issue, i) => (
                <div
                  key={i}
                  className={cn(
                    'flex items-start gap-2.5 rounded-xl p-3',
                    'bg-[hsl(var(--content-area))]',
                    'border border-[var(--cmd-palette-border)]',
                  )}
                >
                  <IssueLevelIcon level={issue.level} />
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-sm leading-[1.45] text-[var(--msg-assistant-text)]">
                      {issue.message}
                    </span>
                    {issue.location && (
                      <span className="font-mono text-xs text-[var(--cmd-palette-item-meta)]">
                        {issue.location}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Action buttons — spec: padding 16, gap 8 */}
          <div className="flex items-center justify-end gap-2 p-4">
            {isWarn ? (
              <>
                <WhitePillButton onClick={onCancel}>{t('skillhub.reviewVerdict.cancel')}</WhitePillButton>
                <GrayPillButton onClick={() => onProceed?.()}>{t('skillhub.reviewVerdict.proceed')}</GrayPillButton>
              </>
            ) : (
              // PASS / BLOCK — single primary action (Spec primary: #262626/#d4d4d4)
              <Button variant="cta" size="md" compact type="button" onClick={onCancel}>
                {isPass
                  ? <CheckCircle size={14} className="shrink-0" />
                  : <AlertTriangle size={14} className="shrink-0" />}
                {primaryLabel ?? (isPass ? t('skillhub.scanResult.dismiss') : t('skillhub.reviewVerdict.returnToFix'))}
              </Button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
