import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Folder,
  FolderOpen,
  HardDrive,
  Link2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * Extracts a Windows drive letter (e.g. "D:") for instant volume recognition.
 * Returns null on POSIX paths or UNC shares.
 */
export function extractDriveBadge(rawPath: string): string | null {
  const match = /^([A-Za-z]):[\\/]/.exec(rawPath.trim());
  return match ? `${match[1].toUpperCase()}:` : null;
}

/**
 * Formats a full filesystem path for compact single-line display while preserving
 * the leading volume/anchor and the most meaningful trailing segments.
 */
export function formatCompactPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  const drive = extractDriveBadge(trimmed);
  const sep = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/';
  const withoutDrive = drive ? trimmed.slice(2) : trimmed;
  const parts = withoutDrive.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 3) {
    return drive ? parts.join(sep) || sep : trimmed;
  }
  const tail = parts.slice(-3).join(sep);
  return drive ? `…${sep}${tail}` : `${parts[0]}${sep}…${sep}${tail}`;
}

export interface WorkspacePathFieldProps {
  path: string;
  /** Optional original linked/canonical path shown as a secondary section in the popover. */
  linkedPath?: string;
  linkedPathLabel?: string;
  fullPathLabel: string;
  primaryPathLabel?: string;
  detailsText?: string;
  copyLabel: string;
  openLabel?: string;
  onCopy: (value: string) => void | Promise<void>;
  onOpen?: () => void | Promise<void>;
  disabled?: boolean;
  className?: string;
}

/**
 * Tactile, scannable read-only path well for buddy workspace location settings.
 *
 * Anatomy (36px height = Input md):
 *   [ Drive badge / Folder ] [ Monospace path (opens Full Path Popover) ] | [ Copy ] [ Open ]
 */
export function WorkspacePathField({
  path,
  linkedPath,
  linkedPathLabel,
  fullPathLabel,
  primaryPathLabel,
  detailsText,
  copyLabel,
  openLabel,
  onCopy,
  onOpen,
  disabled = false,
  className,
}: WorkspacePathFieldProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const driveBadge = extractDriveBadge(path);
  const compactDisplay = formatCompactPath(path);

  const handleCopy = async () => {
    await onCopy(path);
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div
      className={cn(
        'group flex h-9 min-w-0 items-center gap-2 overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] pl-2.5 pr-1.5 transition-colors',
        'hover:border-[var(--text-tertiary)]/50 focus-within:border-[var(--focus-ring)]',
        className,
      )}
    >
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={fullPathLabel}
            title={path}
            className="flex h-7 min-w-0 flex-1 items-center gap-2 px-1 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            {driveBadge ? (
              <span
                className="inline-flex h-5 shrink-0 items-center gap-1 rounded bg-[var(--surface-chip)] px-1.5 font-mono text-11 font-medium text-[var(--text-primary)]"
                aria-hidden
              >
                <HardDrive size={11} className="text-[var(--text-secondary)]" />
                {driveBadge}
              </span>
            ) : (
              <Folder
                size={14}
                className="shrink-0 text-[var(--text-secondary)]"
                aria-hidden
              />
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-12 text-[var(--text-primary)]">
              {compactDisplay}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={6}
          className="w-[380px] max-w-[calc(100vw-32px)] rounded-xl border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 text-[var(--text-primary)]"
        >
          <div className="flex flex-col gap-3">
            <div>
              <p className="mb-1.5 text-11 font-medium text-[var(--text-secondary)]">
                {primaryPathLabel ?? fullPathLabel}
              </p>
              <p className="select-text break-all font-mono text-12 leading-relaxed text-[var(--text-primary)]">
                {path}
              </p>
            </div>

            {linkedPath ? (
              <div className="border-t border-[var(--border-default)] pt-3">
                <p className="mb-1.5 flex items-center gap-1.5 text-11 font-medium text-[var(--text-secondary)]">
                  <Link2 size={12} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden />
                  {linkedPathLabel}
                </p>
                <p className="select-text break-all font-mono text-12 leading-relaxed text-[var(--text-secondary)]">
                  {linkedPath}
                </p>
              </div>
            ) : null}

            {detailsText ? (
              <p className="text-12 leading-[1.5] text-[var(--text-secondary)] [text-wrap:pretty]">
                {detailsText}
              </p>
            ) : null}

            <div className="flex items-center justify-end gap-2 pt-0.5">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                compact
                className="gap-1.5"
                onClick={() => void handleCopy()}
              >
                {copied ? (
                  <Check size={13} className="text-[var(--status-success)]" aria-hidden />
                ) : (
                  <Copy size={13} aria-hidden />
                )}
                {copyLabel}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <div className="h-4 w-px shrink-0 bg-[var(--border-default)]" aria-hidden />

      <div className="flex shrink-0 items-center gap-0.5">
        <Tip text={copyLabel}>
          <Button
            type="button"
            variant="secondary"
            tone="quiet"
            size="sm"
            className="w-7 px-0"
            disabled={disabled}
            aria-label={copyLabel}
            onClick={() => void handleCopy()}
          >
            {copied ? (
              <Check size={14} className="text-[var(--status-success)]" aria-hidden />
            ) : (
              <Copy size={14} aria-hidden />
            )}
          </Button>
        </Tip>

        {onOpen && openLabel ? (
          <Tip text={openLabel}>
            <Button
              type="button"
              variant="secondary"
              tone="quiet"
              size="sm"
              className="w-7 px-0"
              disabled={disabled}
              aria-label={openLabel}
              onClick={() => void onOpen()}
            >
              <FolderOpen size={14} aria-hidden />
            </Button>
          </Tip>
        ) : null}
      </div>
    </div>
  );
}
