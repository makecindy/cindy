/**
 * ScanResultDialog — hub 安全扫描完成后弹出的独立结果弹窗。
 * 通过时简洁提示;未通过时展示原因 + 具体 issues。
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { ShieldAlert, ShieldCheck, AlertTriangle, Check, Copy } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import type { ScanResultPayload } from './PublishDialog';
import { isPassingScanStatus, isPendingManualReviewStatus } from './lib/scanStatus';
import { isPublicationProcessingFailure } from './lib/scanResultPresentation';

interface ScanIssue {
  severity?: string;
  message?: string | Record<string, string>;
  code?: string;
  path?: string;
  line?: number;
  evidence?: string;
}

const COPY_STATE_RESET_MS = 1500;
type ScanGate = NonNullable<ScanResultPayload['gates']>[number];

export interface ScanResultDialogProps {
  open: boolean;
  onClose: () => void;
  result: ScanResultPayload | null;
}

function resolveI18nField(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, string>;
    const lang = document.documentElement.lang || 'en';
    const short = lang.split('-')[0];
    return obj[lang] || obj[short] || obj['en'] || obj['zh'] || Object.values(obj)[0] || '';
  }
  return String(value ?? '');
}

function visibleScanIssues(gate: ScanGate): ScanIssue[] {
  const issues = Array.isArray(gate.issues) ? gate.issues : [];
  return (issues as ScanIssue[]).filter(
    (issue) => issue.severity === 'warning' || issue.severity === 'error',
  );
}

function normalizeScanCode(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

function scanStatusLabel(value: unknown, t: TFunction): string {
  const code = normalizeScanCode(value);
  if (code === 'pass' || code === 'passed' || code === 'success' || code === 'ok') {
    return t('skillhub.scanResult.statusLabel.passed');
  }
  if (
    code === 'fail' ||
    code === 'failed' ||
    code === 'rejected' ||
    code === 'blocked' ||
    code === 'quarantine' ||
    code === 'error'
  ) {
    return t('skillhub.scanResult.statusLabel.failed');
  }
  if (code === 'warn' || code === 'warning') {
    return t('skillhub.scanResult.statusLabel.warning');
  }
  if (code === 'pending') {
    return t('skillhub.scanResult.statusLabel.waitingReview');
  }
  if (
    code === 'scanning' ||
    code === 'reviewing' ||
    code === 'running' ||
    code === 'in-progress'
  ) {
    return t('skillhub.scanResult.statusLabel.reviewing');
  }
  if (code === 'unavailable' || code === 'scan-status-unavailable') {
    return t('skillhub.scanResult.statusLabel.unavailable');
  }
  return String(value ?? '');
}

function scanGateLabel(gate: ScanGate, t: TFunction): string {
  if (gate.label) return resolveI18nField(gate.label);
  const code = normalizeScanCode(gate.name);
  if (code === 'llm-review' || code === 'llmreview') {
    return t('skillhub.scanResult.gateLabel.llmReview');
  }
  if (code === 'security-scan' || code === 'scan-status') {
    return t('skillhub.scanResult.gateLabel.securityScan');
  }
  if (code === 'internal-error') {
    return t('skillhub.scanResult.gateLabel.publicationProcessing');
  }
  return gate.name;
}

function scanIssueCopyLine(issue: ScanIssue): string {
  const location = issue.path ? `${issue.path}${issue.line != null ? `:${issue.line}` : ''}` : '';
  const message = issue.message ? resolveI18nField(issue.message) : '';
  const fallback = issue.code ? String(issue.code) : '';

  if (location && message) return `${location} - ${message}`;
  return location || message || fallback;
}

function withRawCode(label: string, raw: unknown): string {
  const code = String(raw ?? '').trim();
  if (!code || code === label) return label;
  return `${label} (${code})`;
}

export function ScanResultDialog({ open, onClose, result }: ScanResultDialogProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setCopied(false);
    if (copyTimerRef.current != null) {
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
  }, [open, result]);

  if (!result) return null;

  const passed = isPassingScanStatus(result.status);
  const pendingManualReview = isPendingManualReviewStatus(result.status);
  const failedGates = (result.gates ?? []).filter((g) => !isPassingScanStatus(g.status));
  const processingFailure =
    !passed && !pendingManualReview && isPublicationProcessingFailure(result.gates);
  const title = passed
    ? t('skillhub.scanResult.passedTitle')
    : pendingManualReview
      ? t('skillhub.scanResult.pendingTitle')
      : processingFailure
        ? t('skillhub.scanResult.processingFailedTitle')
        : t('skillhub.scanResult.failedTitle', { status: result.status });
  const statusLabel = scanStatusLabel(result.status, t);
  const description = passed
    ? t('skillhub.scanResult.passedDesc')
    : pendingManualReview
      ? t('skillhub.scanResult.pendingDesc')
      : processingFailure
        ? t('skillhub.scanResult.processingFailedDesc')
        : t('skillhub.scanResult.failedDesc', { status: statusLabel });
  const footerButtonBaseClass = cn(
    'inline-flex h-9 min-w-[104px] items-center justify-center gap-1.5 rounded-full px-5',
    'text-sm font-medium leading-none',
    'transition-colors',
  );

  async function handleCopyReviewResult(): Promise<void> {
    const gatesToCopy = passed || pendingManualReview ? (result?.gates ?? []) : failedGates;
    const lines = [
      title,
      `${t('skillhub.scanResult.copyText.status')}: ${withRawCode(statusLabel, result?.status)}`,
      `${t('skillhub.scanResult.copyText.summary')}: ${description}`,
    ];

    if (gatesToCopy.length > 0) {
      lines.push('', `${t('skillhub.scanResult.copyText.gates')}:`);
      for (const gate of gatesToCopy) {
        const label = scanGateLabel(gate, t);
        lines.push(
          `- ${withRawCode(label, gate.name)}: ${withRawCode(scanStatusLabel(gate.status, t), gate.status)}`,
        );
        for (const issue of visibleScanIssues(gate)) {
          const line = scanIssueCopyLine(issue);
          if (line) lines.push(`  - ${line}`);
        }
      }
    }

    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, COPY_STATE_RESET_MS);
    } catch {
      toast.error(t('skillhub.scanResult.copyReviewResultFailed'));
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[10000] -translate-x-1/2 -translate-y-1/2',
            'w-full max-w-[480px] rounded-xl',
            'border bg-[var(--cmd-palette-bg)]',
            'border-[var(--cmd-palette-border)]',
            'max-h-[80vh] overflow-hidden flex flex-col',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          aria-describedby={undefined}
        >
          {/* Header */}
          <div className="flex flex-col items-center gap-2 px-6 pt-7 pb-3">
            {passed ? (
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--diff-add-bg)]">
                <ShieldCheck size={22} className="text-[var(--diff-add-fg)]" />
              </div>
            ) : pendingManualReview ? (
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--diff-add-bg)]">
                <ShieldCheck size={22} className="text-[var(--diff-add-fg)]" />
              </div>
            ) : processingFailure ? (
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--warning-bg-soft)]">
                <AlertTriangle size={22} className="text-[var(--warning-fg)]" />
              </div>
            ) : (
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--error-bg)]">
                <ShieldAlert size={22} className="text-[var(--error-fg-strong)]" />
              </div>
            )}
            <Dialog.Title className="text-base font-semibold text-[var(--msg-assistant-text)]">
              {title}
            </Dialog.Title>
            <p className="text-center text-xs leading-relaxed text-[var(--cmd-palette-item-meta)]">
              {description}
            </p>
          </div>

          {/* Gates list */}
          {result.gates && result.gates.length > 0 && (
            <div className="flex-1 overflow-y-auto px-6 pb-2">
              {/* Failed gates with details */}
              {failedGates.length > 0 && (
                <div className="flex flex-col gap-2">
                  {failedGates.map((gate) => (
                    <div
                      key={gate.name}
                      className="rounded-lg border border-[var(--error-border)] bg-[var(--error-bg)] p-3"
                    >
                      <div className="flex items-center gap-2">
                        <AlertTriangle
                          size={14}
                          className="shrink-0 text-[var(--error-fg-strong)]"
                        />
                        <span className="text-sm font-medium text-[var(--msg-assistant-text)]">
                          {scanGateLabel(gate, t)}
                        </span>
                        <span
                          className={cn(
                            'ml-auto shrink-0 rounded-full border px-2 py-0.5',
                            'border-[var(--error-border)] text-xs font-medium leading-none text-[var(--error-fg)]',
                          )}
                        >
                          {scanStatusLabel(gate.status, t)}
                        </span>
                      </div>
                      {visibleScanIssues(gate).length > 0 && (
                        <div className="mt-2 flex flex-col gap-1.5 pl-5">
                          {visibleScanIssues(gate).map((issue, i) => (
                            <div
                              key={i}
                              className="text-xs leading-relaxed text-[var(--cmd-palette-item-meta)]"
                            >
                              {issue.path && (
                                <span className="font-mono text-[var(--settings-section-desc)]">
                                  {issue.path}
                                  {issue.line != null ? `:${issue.line}` : ''}
                                </span>
                              )}
                              {issue.path && issue.message && <span className="mx-1">—</span>}
                              {issue.message && <span>{resolveI18nField(issue.message)}</span>}
                              {!issue.path && !issue.message && issue.code && (
                                <span className="font-mono">{issue.code}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Footer */}
          <div className="flex flex-wrap items-center justify-center gap-2 p-5">
            {!passed && !pendingManualReview && (
              <button
                type="button"
                onClick={() => void handleCopyReviewResult()}
                aria-label={t('skillhub.scanResult.copyReviewResult')}
                title={t('skillhub.scanResult.copyReviewResult')}
                className={cn(
                  footerButtonBaseClass,
                  'h-[38px] px-[22px]',
                  'border',
                  'border-[var(--confirm-btn-secondary-border)] bg-[var(--cmd-palette-bg)]',
                  'text-[var(--settings-btn-secondary-text)] hover:bg-[var(--surface-hover)]',
                )}
              >
                {copied ? (
                  <Check size={15} className="shrink-0" />
                ) : (
                  <Copy size={15} className="shrink-0" />
                )}
                {copied
                  ? t('skillhub.scanResult.copiedReviewResult')
                  : t('skillhub.scanResult.copyReviewResult')}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className={cn(
                footerButtonBaseClass,
                'bg-[var(--lightbox-cta-bg)] text-[var(--lightbox-cta-fg)]',
                'hover:bg-[var(--lightbox-cta-hover)]',
              )}
            >
              {t('skillhub.scanResult.dismiss')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
