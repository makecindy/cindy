import { Bot, Code, FilePenLine, FlaskConical, FolderOpen, GitMerge, ScanSearch, Shield, SquareTerminal } from 'lucide-react';
import type { ComponentType } from 'react';

import { cn } from '@/lib/utils';

import type { ApprovalKind } from './approvalFormat';

type IconType = ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: boolean }>;

/** Role -> glyph. Roles are free text, so anything unknown falls back to the generic Bot glyph. */
const ROLE_ICONS: Record<string, IconType> = {
  developer: Code,
  reviewer: ScanSearch,
  tester: FlaskConical,
  merger: GitMerge,
  security: Shield,
};

export const KIND_ICONS: Record<ApprovalKind, IconType> = {
  command: SquareTerminal,
  edit: FilePenLine,
  folder: FolderOpen,
  other: Shield,
};

/** Monochrome identity tile; the selected request inverts to the neutral call-to-action pair. */
export function ApprovalTile({ role, size = 36, inverse = false, muted = false }: {
  role: string | null; size?: number; inverse?: boolean; muted?: boolean;
}) {
  const Icon = (role && ROLE_ICONS[role.toLowerCase()]) || Bot;
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={cn(
        'grid shrink-0 select-none place-items-center rounded-lg border transition-colors',
        inverse
          ? 'border-[var(--accent-cta-bg-pure)] bg-[var(--accent-cta-bg-pure)] text-[var(--accent-pure-cta-fg)]'
          : 'border-[var(--border-default)] bg-[var(--surface-chip)]',
        !inverse && (muted ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]'),
      )}
    >
      <Icon size={Math.round(size * 0.46)} strokeWidth={1.75} aria-hidden />
    </span>
  );
}
