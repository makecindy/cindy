import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';

/** Shared About geometry so every harness row and menu stays identical to Pi's. */
export const HARNESS_MENU_ITEM_CLASS = 'min-h-9 gap-3 rounded-lg px-3 text-13';

/** One harness, one row: the version pill opens that harness's action menu. */
export function HarnessVersionMenuRow({ label, manageLabel, version, status, pending, testId, children }: {
  label: string;
  manageLabel: string;
  version: string;
  status: string;
  /** Shows the spinner before the status while a check or install is running. */
  pending: boolean;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-[52px] items-center justify-between gap-3 px-[18px] py-2" data-testid={testId}>
      <span className="shrink-0 text-13 text-[var(--settings-section-sublabel)]">{label}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={manageLabel} className="-mr-2 flex min-h-9 min-w-0 items-center gap-2 rounded-full px-2 text-13 font-medium text-[var(--settings-section-title)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]">
            <span className="truncate">{version}</span>
            {status && <span role="status" className="flex shrink-0 items-center gap-1 text-12 font-normal text-[var(--settings-section-sublabel)]">{pending && <Spinner size={12} />}{status}</span>}
            <ChevronDown size={13} aria-hidden className="shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} className="z-[10000] w-[272px] max-w-[calc(100vw-24px)] rounded-xl p-1.5 shadow-none">
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Menu action with its target version right-aligned; "—" until a version is known. */
export function HarnessVersionMenuItem({ label, version, disabled, onSelect }: {
  label: string;
  version: string | null | undefined;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem className={HARNESS_MENU_ITEM_CLASS} disabled={disabled} onSelect={onSelect}>
      <span className="flex-1">{label}</span><span className="text-12 text-[var(--text-secondary)]">{version ?? '—'}</span>
    </DropdownMenuItem>
  );
}

export function HarnessMenuFootnote({ children }: { children: ReactNode }) {
  return <p className="px-3 py-1.5 text-11 text-[var(--text-secondary)]">{children}</p>;
}
