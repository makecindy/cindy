import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronsUpDown, CircleDot, Keyboard, Search } from 'lucide-react';

import { cn } from '@/lib/utils';

import { WorkLouderCodexKeycapGlyph } from './WorkLouderCodexKeycapGlyphs';

import {
  WORKLOUDER_CODEX_COMMAND_SLOTS,
  WORKLOUDER_CODEX_KEYCAP_IDS,
  type WorkLouderCodexAgentSlotState,
  type WorkLouderCodexCommandSlot,
  type WorkLouderCodexKeycapId,
  type WorkLouderCodexLayout,
} from '../../../shared/workLouderCodex';

/** A physical key location that can be opened by the layout editor. */
export type WorkLouderCodexAgentKey = `AG0${0 | 1 | 2 | 3 | 4 | 5}`;
export type WorkLouderCodexEditableKey = WorkLouderCodexCommandSlot | WorkLouderCodexAgentKey;

export interface WorkLouderCodexKeyboardLayoutProps {
  layout: WorkLouderCodexLayout;
  agentSlots: readonly WorkLouderCodexAgentSlotState[];
  disabled?: boolean;
  /** Optional localized footer copy supplied by the settings page. */
  footer?: ReactNode;
  labels?: {
    analogStick: string;
    encoder: string;
    codexMicro: string;
  };
  onEditKeycap?(slot: WorkLouderCodexEditableKey): void;
}

/**
 * Draws the Codex Micro in its physical shape. The board is intentionally a
 * real grid rather than a list of selects: users can see which physical key
 * they are changing before opening the keycap picker.
 */
export function WorkLouderCodexKeyboardLayout({
  layout,
  agentSlots,
  disabled = false,
  footer,
  labels,
  onEditKeycap,
}: WorkLouderCodexKeyboardLayoutProps) {
  const commandSlots = layout.separateMicrophoneKeys
    ? WORKLOUDER_CODEX_COMMAND_SLOTS.filter((slot) => slot !== 'ACT10_ACT11')
    : WORKLOUDER_CODEX_COMMAND_SLOTS.filter((slot) => slot !== 'ACT10' && slot !== 'ACT11');
  const commandRow = commandSlots.filter(
    (slot) => slot === 'ACT06' || slot === 'ACT07' || slot === 'ACT08' || slot === 'ACT09',
  );
  const bottomSlots = commandSlots.filter(
    (slot) => slot === 'ACT10' || slot === 'ACT11' || slot === 'ACT10_ACT11' || slot === 'ACT12',
  );

  return (
    <div
      className="flex w-full max-w-[520px] flex-col gap-3 rounded-2xl border border-[var(--settings-theme-card-border)] bg-[var(--surface-chip)] p-4"
      data-testid="worklouder-codex-keyboard-layout"
    >
      <div className="rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--surface)] p-3 shadow-[var(--shadow-card)]">
        <div className="grid grid-cols-6 gap-2">
          {Array.from({ length: 6 }, (_, index) => {
            const agent = agentSlots[index];
            const slot = `AG${index.toString().padStart(2, '0')}` as WorkLouderCodexAgentKey;
            return (
              <AgentKey key={slot} slot={slot} title={agent?.title ?? null} disabled={disabled} />
            );
          })}
        </div>

        <div className="mt-2 grid grid-cols-4 gap-2">
          {commandRow.map((slot) => (
            <CommandKey
              key={slot}
              slot={slot}
              keycapId={layout.slots[slot].keycapId}
              disabled={disabled}
              onEdit={onEditKeycap}
            />
          ))}
        </div>

        <div className="mt-2 grid grid-cols-8 gap-2">
          <ControlKey
            className="col-span-1 aspect-square"
            ariaLabel={labels?.analogStick ?? 'Analog stick'}
            icon={<CircleDot size={22} strokeWidth={1.7} />}
          />
          {bottomSlots.map((slot) => {
            const wide = slot === 'ACT10_ACT11';
            return (
              <CommandKey
                key={slot}
                className={cn(wide ? 'col-span-4' : 'col-span-2')}
                slot={slot}
                keycapId={layout.slots[slot].keycapId}
                disabled={disabled}
                onEdit={onEditKeycap}
              />
            );
          })}
          <ControlKey
            className="col-span-1 aspect-square"
            ariaLabel={labels?.encoder ?? 'Encoder'}
            icon={<ChevronsUpDown size={22} strokeWidth={1.7} />}
          />
        </div>
      </div>

      {footer && (
        <div className="flex items-center justify-between gap-2 px-1 text-11 text-[var(--text-tertiary)]">
          <span className="inline-flex items-center gap-1.5">
            <Keyboard size={13} aria-hidden="true" />
            {labels?.codexMicro ?? 'Codex Micro'}
          </span>
          <span>{footer}</span>
        </div>
      )}
    </div>
  );
}

function AgentKey({
  slot,
  title,
  disabled,
}: {
  slot: WorkLouderCodexAgentKey;
  title: string | null;
  disabled: boolean;
}) {
  return (
    <ControlKey
      className="aspect-square min-w-0"
      ariaLabel={`${slot}${title ? ` ${title}` : ''}`}
      disabled={disabled}
      // Codex leaves its agent keys blank apart from a lit centre dot; the key
      // stands for a chat, not for an action, so it carries no glyph.
      icon={
        <span
          aria-hidden="true"
          className="block size-3 rounded-full border border-[#4f477f]/20 bg-[#685fae]/85 shadow-[0_0_5px_rgba(87,76,151,0.42)] dark:border-[#b5adf0]/20 dark:bg-[#8177c8]/90 dark:shadow-[0_0_6px_rgba(118,104,197,0.5)]"
        />
      }
    >
      <span className="max-w-full truncate text-10 font-medium">{title ?? slot}</span>
    </ControlKey>
  );
}

function CommandKey({
  slot,
  keycapId,
  className,
  disabled,
  onEdit,
}: {
  slot: WorkLouderCodexCommandSlot;
  keycapId: WorkLouderCodexKeycapId;
  className?: string;
  disabled: boolean;
  onEdit?: (slot: WorkLouderCodexEditableKey) => void;
}) {
  return (
    <ControlKey
      className={cn('min-h-[60px]', className)}
      ariaLabel={`${slot} ${keycapId}`}
      disabled={disabled}
      onClick={() => onEdit?.(slot)}
      icon={<KeycapGlyph keycapId={keycapId} />}
    >
      <span className="truncate text-11 font-medium tracking-wide">{keycapId}</span>
    </ControlKey>
  );
}

function ControlKey({
  ariaLabel,
  children,
  className,
  disabled = false,
  icon,
  onClick,
}: {
  ariaLabel: string;
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  icon?: ReactNode;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="text-[var(--text-primary)]">{icon}</span>
      {children}
    </>
  );
  const classes = cn(
    'flex min-w-0 flex-col items-center justify-center gap-1 rounded-xl border p-2 text-center transition-colors',
    'border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] text-[var(--text-primary)]',
    'shadow-[0_1px_0_var(--settings-theme-card-border)]',
    onClick &&
      !disabled &&
      'cursor-pointer hover:border-[var(--focus-ring)] hover:bg-[var(--surface-elevated)]',
    onClick &&
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
    disabled && 'cursor-not-allowed opacity-60',
    className,
  );

  return onClick ? (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={classes}
    >
      {content}
    </button>
  ) : (
    <div role="img" aria-label={ariaLabel} className={classes}>
      {content}
    </div>
  );
}

function KeycapGlyph({ keycapId }: { keycapId: WorkLouderCodexKeycapId }) {
  return <WorkLouderCodexKeycapGlyph keycapId={keycapId} className="size-[22px]" />;
}

export interface WorkLouderCodexKeycapPickerProps {
  open: boolean;
  slot: WorkLouderCodexCommandSlot | null;
  selectedKeycapId: WorkLouderCodexKeycapId | null;
  query: string;
  onQueryChange(query: string): void;
  onOpenChange(open: boolean): void;
  onSelect(keycapId: WorkLouderCodexKeycapId): void;
  onSave?(): void;
  onCancel?(): void;
  assignedAction?: ReactNode;
  copy: {
    title: string;
    description: string;
    searchPlaceholder: string;
    close: string;
    cancel?: string;
    save?: string;
    assignedShortcut?: string;
    noAssignment?: string;
  };
}

/** Codex-style visual keycap library used by the keyboard layout editor. */
export function WorkLouderCodexKeycapPicker({
  open,
  slot,
  selectedKeycapId,
  query,
  onQueryChange,
  onOpenChange,
  onSelect,
  onSave,
  onCancel,
  assignedAction,
  copy,
}: WorkLouderCodexKeycapPickerProps) {
  const double = slot === 'ACT10_ACT11';
  const normalizedQuery = query.trim().toLowerCase();
  const keycaps = WORKLOUDER_CODEX_KEYCAP_IDS.filter((keycapId) => {
    if (double !== (keycapId === 'MIC' || keycapId === 'EMPT5')) return false;
    return normalizedQuery.length === 0 || keycapId.toLowerCase().includes(normalizedQuery);
  });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[10000] flex max-h-[min(760px,calc(100vh-48px))] w-[min(720px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[var(--shadow-menu)] focus:outline-none">
          <div className="flex items-start justify-between gap-4 px-6 pb-4 pt-6">
            <div className="min-w-0">
              <Dialog.Title className="text-18 font-medium leading-[1.3]">
                {copy.title}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-13 leading-[1.4] text-[var(--text-secondary)]">
                {copy.description}
              </Dialog.Description>
            </div>
          </div>
          <div className="px-6 pb-4">
            <label className="flex h-10 items-center gap-2 rounded-lg border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3 focus-within:ring-2 focus-within:ring-[var(--focus-ring-soft)]">
              <Search size={16} className="text-[var(--text-tertiary)]" aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => onQueryChange(event.currentTarget.value)}
                placeholder={copy.searchPlaceholder}
                autoFocus
                className="min-w-0 flex-1 bg-transparent text-13 text-[var(--settings-input-text)] outline-none placeholder:text-[var(--text-tertiary)]"
              />
            </label>
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-6 gap-3 overflow-y-auto px-6 pb-6 max-md:grid-cols-4">
            {keycaps.map((keycapId) => (
              <button
                key={keycapId}
                type="button"
                aria-label={keycapId}
                aria-pressed={selectedKeycapId === keycapId}
                onClick={() => onSelect(keycapId)}
                className={cn(
                  'flex aspect-square min-w-0 flex-col items-center justify-center gap-2 rounded-xl border p-2 text-center transition-colors',
                  'bg-[var(--settings-theme-card-bg)] text-[var(--text-primary)] shadow-[0_1px_0_var(--settings-theme-card-border)]',
                  selectedKeycapId === keycapId
                    ? 'border-[var(--focus-ring)] ring-2 ring-[var(--focus-ring-soft)]'
                    : 'border-[var(--settings-theme-card-border)] hover:border-[var(--focus-ring)] hover:bg-[var(--surface-chip)]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
                )}
              >
                <KeycapGlyph keycapId={keycapId} />
                <span className="max-w-full truncate text-11 font-medium tracking-wide">
                  {keycapId}
                </span>
              </button>
            ))}
          </div>
          <div className="border-t border-[var(--border-default)] px-6 py-4">
            <div className="flex items-center justify-between gap-3 text-12">
              <span className="text-[var(--text-secondary)]">
                {copy.assignedShortcut ?? 'Assigned action'}
              </span>
              <span className="max-w-[60%] truncate font-medium text-[var(--text-primary)]">
                {assignedAction ?? copy.noAssignment ?? 'No action assigned'}
              </span>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  onCancel?.();
                  onOpenChange(false);
                }}
                className="rounded-lg border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3 py-2 text-12 font-medium text-[var(--settings-input-text)] transition-colors hover:bg-[var(--settings-menu-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
              >
                {copy.cancel ?? 'Cancel'}
              </button>
              <button
                type="button"
                disabled={!selectedKeycapId}
                onClick={() => {
                  onSave?.();
                  onOpenChange(false);
                }}
                className="rounded-lg bg-[var(--accent-cta-bg)] px-3 py-2 text-12 font-medium text-[var(--accent-pure-cta-fg)] transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {copy.save ?? 'Save'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
