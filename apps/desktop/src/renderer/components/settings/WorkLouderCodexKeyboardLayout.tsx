import type { CSSProperties, ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Search } from 'lucide-react';

import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import {
  WORKLOUDER_CODEX_ENCODER_DETENT_DEG,
  WORKLOUDER_CODEX_KEYCAP_IDS,
  canonicalizeWorkLouderCodexKeycapId,
  creatorCommandAssignment,
  isCreatorTaskKey,
  isWorkLouderCodexBlankKeycap,
  isWorkLouderCodexDoubleKeycap,
  isWorkLouderCodexDuplicateBlankKeycap,
  normalizeWorkLouderCreatorTaskKeys,
  workLouderLayoutMerges,
  workLouderMergeDirectionOf,
  workLouderMergeForKey,
  WORKLOUDER_KEY_CELL,
  WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS,
  workLouderCodexStickPreviewOffset,
  type WorkLouderCreatorProgrammableKey,
  type WorkLouderCodexAgentSlotState,
  type WorkLouderCodexCommandSlot,
  type WorkLouderCodexKeycapId,
  type WorkLouderCodexLayout,
  type WorkLouderCodexPreviewPart,
  type WorkLouderModel,
} from '../../../shared/workLouderCodex';
import { WorkLouderCodexKeycapGlyph } from './WorkLouderCodexKeycapGlyphs';

/** A physical key location that can be opened by the layout editor. */
export type WorkLouderCodexAgentKey = `AG0${0 | 1 | 2 | 3 | 4 | 5}`;
/** The two parts of the board that are not keycaps but are still configurable. */
export type WorkLouderCodexControlPart = 'analog' | 'encoder';
export type WorkLouderCodexEditableKey =
  WorkLouderCodexCommandSlot | WorkLouderCodexAgentKey | WorkLouderCodexControlPart;

/** Hover copy for one part of the board: the legend, what it does, and why. */
export interface WorkLouderCodexKeyHint {
  /** Keycap legend or slot id, shown in bold on the first line. */
  legend: string;
  /** What the key is bound to. */
  name?: string | null;
  /** One line of detail under the name. */
  description?: string | null;
}

export interface WorkLouderCodexKeyboardLayoutProps {
  layout: WorkLouderCodexLayout;
  agentSlots: readonly WorkLouderCodexAgentSlotState[];
  disabled?: boolean;
  /** Which physical board to draw; the two models do not look alike. */
  model?: WorkLouderModel;
  labels: {
    analogStick: string;
    encoder: string;
    indicator: string;
  };
  /** Hover copy per part; the board itself carries no lettering. */
  hintFor?(key: WorkLouderCodexEditableKey): WorkLouderCodexKeyHint | null;
  /**
   * Whether a part has anything of its own to edit. Task keys do not when all
   * six follow one shared rule, and a key that opens nothing should not look
   * like a button.
   */
  canEdit?(key: WorkLouderCodexEditableKey): boolean;
  onEditKeycap?(slot: WorkLouderCodexEditableKey): void;
  pressedParts?: ReadonlySet<WorkLouderCodexPreviewPart>;
  /** Cumulative encoder detents since the settings page opened. */
  encoderTurns?: number;
  /** Live stick report. Distance 0 keeps the cap centred. */
  analogStick?: { angle: number; distance: number } | null;
}

/**
 * Draws the physical object the user owns: a 4×4 board with the analog stick
 * in one corner and the encoder in the other. Both boards keep the same three
 * status lights bottom-left. They differ in the rest of the bottom row and
 * the cap colours: Codex has a double-width MIC keycap; Creator has thirteen
 * blank 1U caps.
 *
 * The real keycaps carry artwork (Codex) or nothing at all (Creator) and no
 * legends either way, so neither does this. What a key is bound to belongs in
 * the hover tooltip, and changing it belongs behind a click on the key itself,
 * which is why there are no separate per-key rows anywhere else in the panel.
 */
export function WorkLouderCodexKeyboardLayout({
  layout,
  agentSlots,
  disabled = false,
  model = 'codex-micro',
  labels,
  hintFor,
  canEdit,
  onEditKeycap,
  pressedParts,
  encoderTurns = 0,
  analogStick = null,
}: WorkLouderCodexKeyboardLayoutProps) {
  const isCreator = model === 'creator-micro-2';
  const editHandlerFor = (key: WorkLouderCodexEditableKey) =>
    canEdit && !canEdit(key) ? undefined : onEditKeycap;
  const taskKeys = normalizeWorkLouderCreatorTaskKeys(layout.taskKeys);
  const merges = workLouderLayoutMerges(layout);

  const renderAgentKey = (slot: WorkLouderCodexEditableKey, index: number) => (
    <BoardPart
      key={slot}
      part={slot}
      hint={hintFor?.(slot) ?? { legend: slot, name: agentSlots[index]?.title ?? null }}
      disabled={disabled}
      pressed={pressedParts?.has(slot) ?? false}
      onEdit={editHandlerFor(slot)}
      // Default shipped caps: Codex task keys are translucent; Creator's set is
      // all black. Hardware is the same — only the factory keycap kit differs.
      className={
        isCreator
          ? 'bg-[var(--wl-command-cap)] shadow-[var(--wl-command-shadow)]'
          : 'bg-[var(--wl-agent-cap)] shadow-[var(--wl-agent-shadow)]'
      }
    >
      {/* Agent keys wear no artwork — just the lit dot that marks a task slot. */}
      <span aria-hidden="true" className="block size-3 rounded-full bg-[var(--wl-agent-dot)]" />
    </BoardPart>
  );

  const renderCommandKey = (
    slot: WorkLouderCodexCommandSlot | WorkLouderCreatorProgrammableKey,
    className?: string,
  ) => {
    const keycapId = creatorCommandAssignment(layout, slot as WorkLouderCreatorProgrammableKey)
      .keycapId;
    return (
      <BoardPart
        key={slot}
        part={slot}
        hint={hintFor?.(slot) ?? { legend: keycapId }}
        disabled={disabled}
        pressed={pressedParts?.has(slot) ?? false}
        onEdit={editHandlerFor(slot)}
        className={cn('bg-[var(--wl-command-cap)] shadow-[var(--wl-command-shadow)]', className)}
      >
        <WorkLouderCodexKeycapGlyph
          keycapId={keycapId}
          className="size-[22px] text-[var(--wl-command-glyph)]"
        />
      </BoardPart>
    );
  };

  const renderPhysicalKey = (slot: WorkLouderCreatorProgrammableKey) => {
    const merge = workLouderMergeForKey(merges, slot);
    if (merge?.cover === slot) return null;
    const index = taskKeys.indexOf(slot);
    const key =
      index >= 0 ? renderAgentKey(slot, index) : renderCommandKey(slot);
    return (
      <div key={slot} style={workLouderGridItemStyle(slot, merge)}>
        {key}
      </div>
    );
  };

  return (
    <div
      className={cn(
        'grid w-fit grid-cols-4 gap-2 rounded-[20px] p-3',
        'border border-[var(--wl-edge)] bg-[var(--wl-board)] shadow-[var(--wl-board-shadow)]',
      )}
      data-testid="worklouder-codex-keyboard-layout"
      style={{
        ...(isCreator ? WORKLOUDER_CREATOR_BOARD_TOKENS : WORKLOUDER_CODEX_BOARD_TOKENS),
        gridTemplateRows: 'repeat(4, var(--wl-key-size))',
        gridTemplateColumns: 'repeat(4, var(--wl-key-size))',
      }}
    >
      <div style={{ gridColumn: 1, gridRow: 1 }}>
        <BoardPart
          part="encoder"
          hint={hintFor?.('encoder') ?? { legend: labels.encoder }}
          disabled={disabled}
          pressed={pressedParts?.has('encoder') ?? false}
          onEdit={editHandlerFor('encoder')}
          rounded="full"
          className="bg-transparent shadow-none"
        >
          <Encoder label={labels.encoder} turns={encoderTurns} />
        </BoardPart>
      </div>
      <div style={{ gridColumn: 4, gridRow: 1 }}>
        <BoardPart
          part="analog"
          hint={hintFor?.('analog') ?? { legend: labels.analogStick }}
          disabled={disabled}
          pressed={pressedParts?.has('analog') ?? false}
          onEdit={editHandlerFor('analog')}
          className="bg-transparent shadow-none"
        >
          <AnalogStick label={labels.analogStick} analog={analogStick} />
        </BoardPart>
      </div>
      {WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS.map((slot) => renderPhysicalKey(slot))}
      <div
        className="flex items-center gap-2 px-1"
        role="img"
        aria-label={labels.indicator}
        style={{ gridColumn: 1, gridRow: 4 }}
      >
        <StatusLights />
        <span
          aria-hidden="true"
          className="size-8 rounded-full bg-[var(--wl-command-cap)] shadow-[var(--wl-command-shadow)]"
        />
      </div>
    </div>
  );
}

function workLouderGridItemStyle(
  key: WorkLouderCreatorProgrammableKey,
  merge: ReturnType<typeof workLouderMergeForKey>,
): CSSProperties {
  const { row, col } = WORKLOUDER_KEY_CELL[key];
  const direction =
    merge?.origin === key ? workLouderMergeDirectionOf(merge) : null;
  return {
    gridColumn: `${col + 1} / span ${direction === 'right' ? 2 : 1}`,
    gridRow: `${row + 1} / span ${direction === 'down' ? 2 : 1}`,
  };
}

/**
 * Board colours describe one physical object, so they are fixed values rather
 * than semantic tokens: the task keys ship with translucent white caps and the
 * command keys with dark ones, and that contrast has to survive in both themes.
 * Routing them through `--surface-*` inverted the board in dark mode, which is
 * exactly backwards from the hardware. Only the shell tracks the app theme.
 */
const WORKLOUDER_CODEX_BOARD_TOKENS = {
  // One key tall. Keys are square, so this is their width too; the double-width
  // microphone key spans two columns without getting any taller.
  '--wl-key-size': '64px',
  '--wl-board': 'var(--surface-chip)',
  // The rim reads as the edge of a case: a lit top edge, a shadow under it.
  '--wl-edge': 'var(--border-default)',
  '--wl-board-shadow':
    'inset 0 1px 0 rgb(255 255 255 / 0.06), inset 0 0 0 1px rgb(0 0 0 / 0.12), 0 2px 8px rgb(0 0 0 / 0.22)',
  // Task keys: pale translucent caps, the lightest thing on the board.
  '--wl-agent-cap': 'rgb(214 214 214 / 0.92)',
  '--wl-agent-shadow':
    'inset 0 0 0 1px rgb(255 255 255 / 0.5), inset 0 1px 2px rgb(255 255 255 / 0.6), 0 1px 3px rgb(0 0 0 / 0.35)',
  '--wl-agent-dot': '#8177c8',
  // Command keys: dark caps with light artwork.
  '--wl-command-cap': '#2a2b30',
  '--wl-command-shadow':
    'inset 0 0 0 1px rgb(255 255 255 / 0.08), inset 0 1px 2px rgb(255 255 255 / 0.06), 0 1px 3px rgb(0 0 0 / 0.4)',
  '--wl-command-glyph': 'rgb(236 236 236)',
  // The stick: a well the same colour family as the task keys, so the dark
  // thumb cap reads against it instead of disappearing into a black square.
  '--wl-stick-housing': 'rgb(198 198 200 / 0.96)',
  '--wl-stick-housing-shadow':
    'inset 0 1px 3px rgb(0 0 0 / 0.22), inset 0 0 0 1px rgb(0 0 0 / 0.08), 0 1px 0 rgb(255 255 255 / 0.35)',
  '--wl-stick-cap': '#2a2b30',
} as CSSProperties;

/**
 * Creator's factory kit is all black PBT, so the on-screen board matches that
 * default layout. The PCB is the same as Codex; only the shipped caps differ.
 */
const WORKLOUDER_CREATOR_BOARD_TOKENS = {
  '--wl-key-size': '64px',
  '--wl-board': 'var(--surface-chip)',
  '--wl-edge': 'var(--border-default)',
  '--wl-board-shadow':
    'inset 0 1px 0 rgb(255 255 255 / 0.06), inset 0 0 0 1px rgb(0 0 0 / 0.12), 0 2px 8px rgb(0 0 0 / 0.22)',
  // Task keys: the same black PBT as the command keys, with a brighter slot
  // dot so the six agent keys stay readable against all-dark caps.
  '--wl-agent-cap': '#2a2b30',
  '--wl-agent-shadow':
    'inset 0 0 0 1px rgb(255 255 255 / 0.08), inset 0 1px 2px rgb(255 255 255 / 0.06), 0 1px 3px rgb(0 0 0 / 0.4)',
  '--wl-agent-dot': '#a99df2',
  // Command keys: identical black caps.
  '--wl-command-cap': '#2a2b30',
  '--wl-command-shadow':
    'inset 0 0 0 1px rgb(255 255 255 / 0.08), inset 0 1px 2px rgb(255 255 255 / 0.06), 0 1px 3px rgb(0 0 0 / 0.4)',
  '--wl-command-glyph': 'rgb(236 236 236)',
  '--wl-stick-housing': 'rgb(198 198 200 / 0.96)',
  '--wl-stick-housing-shadow':
    'inset 0 1px 3px rgb(0 0 0 / 0.22), inset 0 0 0 1px rgb(0 0 0 / 0.08), 0 1px 0 rgb(255 255 255 / 0.35)',
  '--wl-stick-cap': '#2a2b30',
} as CSSProperties;

/**
 * One clickable part of the board. Everything the user can configure — keycaps,
 * agent keys, the stick, the encoder — renders through here so they share the
 * same press feedback, focus ring, and hover tooltip.
 */
function BoardPart({
  part,
  hint,
  children,
  className,
  disabled,
  pressed = false,
  onEdit,
  rounded = 'xl',
}: {
  part: WorkLouderCodexEditableKey;
  hint: WorkLouderCodexKeyHint;
  children: ReactNode;
  className?: string;
  disabled: boolean;
  pressed?: boolean;
  onEdit?: (part: WorkLouderCodexEditableKey) => void;
  rounded?: 'xl' | 'full';
}) {
  const label = [hint.legend, hint.name].filter(Boolean).join(' ');
  const classes = cn(
    'flex h-full min-h-[var(--wl-key-size)] w-full min-w-0 items-center justify-center transition-transform',
    rounded === 'full' ? 'aspect-square rounded-full' : 'rounded-xl',
    onEdit && !disabled && 'cursor-pointer active:scale-[0.97]',
    onEdit &&
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
    pressed && 'scale-[0.97] ring-2 ring-[var(--focus-ring-soft)]',
    disabled && 'cursor-not-allowed opacity-60',
    className,
  );

  const key = onEdit ? (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={() => onEdit(part)}
      className={classes}
    >
      {children}
    </button>
  ) : (
    <div role="img" aria-label={label} data-pressed={pressed ? 'true' : undefined} className={classes}>
      {children}
    </div>
  );

  return (
    <Tip text={<KeyHint hint={hint} />} side="top">
      {key}
    </Tip>
  );
}

/** Three stacked lines: legend, what it runs, and what that means. */
function KeyHint({ hint }: { hint: WorkLouderCodexKeyHint }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-semibold">{hint.legend}</span>
      {hint.name && <span>{hint.name}</span>}
      {hint.description && <span className="text-[var(--text-tertiary)]">{hint.description}</span>}
    </span>
  );
}

/**
 * The stick sits in a square well the size of a keycap, with a dark thumb
 * cap in the middle — it is not a bare circle like the encoder.
 */
function AnalogStick({
  label,
  analog,
}: {
  label: string;
  analog: { angle: number; distance: number } | null;
}) {
  const distance = analog?.distance ?? 0;
  const angle = analog?.angle ?? 0;
  const offset = workLouderCodexStickPreviewOffset(angle, distance);
  return (
    <span
      aria-hidden="true"
      title={label}
      data-stick-angle={distance > 0 ? String(angle) : undefined}
      data-stick-distance={String(distance)}
      className="relative flex size-full items-center justify-center rounded-xl bg-[var(--wl-stick-housing)] shadow-[var(--wl-stick-housing-shadow)]"
    >
      <span
        data-testid="worklouder-codex-stick-cap"
        className="block size-[68%] rounded-full bg-[var(--wl-stick-cap)] shadow-[inset_0_1px_1px_rgb(255_255_255/0.18),0_1px_2px_rgb(0_0_0/0.28)]"
        style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
      />
    </span>
  );
}

/** The encoder is a round wheel that stands proud of the board. */
function Encoder({ label, turns }: { label: string; turns: number }) {
  // Firmware ENC_CW is visually counterclockwise on this board. CSS rotate()
  // is clockwise-positive, so the drawn knob has to flip the sign.
  return (
    <span
      aria-hidden="true"
      title={label}
      data-encoder-turns={String(turns)}
      className="block size-full overflow-hidden rounded-full bg-[var(--wl-command-cap)] shadow-[var(--wl-command-shadow)]"
      style={{ transform: `rotate(${-turns * WORKLOUDER_CODEX_ENCODER_DETENT_DEG}deg)` }}
    >
      <span className="relative block size-full bg-gradient-to-br from-white/[0.14] to-transparent">
        <span className="absolute left-1/2 top-[3px] h-[22%] w-[2px] -translate-x-1/2 rounded-full bg-white/55" />
      </span>
    </span>
  );
}

/** The board's three status LEDs. Decorative — they mirror hardware state. */
function StatusLights() {
  return (
    <span aria-hidden="true" className="flex flex-col gap-1">
      <span className="block size-1 rounded-full bg-[#4c8dff]" />
      <span className="block size-1 rounded-full bg-[var(--text-primary)]" />
      <span className="block size-1 rounded-full bg-[#e0b341]" />
    </span>
  );
}

export interface WorkLouderCodexKeycapPickerProps {
  open: boolean;
  slot: WorkLouderCodexCommandSlot | WorkLouderCreatorProgrammableKey | null;
  selectedKeycapId: WorkLouderCodexKeycapId | null;
  query: string;
  onQueryChange(query: string): void;
  onOpenChange(open: boolean): void;
  onSelect(keycapId: WorkLouderCodexKeycapId): void;
  onSave?(): void;
  onCancel?(): void;
  /** Keycap artwork this board cannot physically wear, e.g. Creator's missing MIC caps. */
  excludeKeycaps?: readonly WorkLouderCodexKeycapId[];
  /** When true, only 2U caps are listed. Defaults to the legacy merged-mic slot. */
  double?: boolean;
  /** Extra controls shown under the grid, e.g. the action bound to this key. */
  children?: ReactNode;
  /** Role or other controls that must sit above the keycap library. */
  header?: ReactNode;
  copy: {
    title: string;
    description: string;
    searchPlaceholder: string;
    close: string;
    cancel?: string;
    save?: string;
    /** Label for unprinted caps. The catalogue numbers them; the user should not see that. */
    blank: string;
  };
}

function keycapPickerLabel(keycapId: WorkLouderCodexKeycapId, blank: string): string {
  const canonical = canonicalizeWorkLouderCodexKeycapId(keycapId);
  return isWorkLouderCodexBlankKeycap(canonical) ? blank : canonical;
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
  excludeKeycaps,
  double,
  children,
  header,
  copy,
}: WorkLouderCodexKeycapPickerProps) {
  const twoUnit = double ?? slot === 'ACT10_ACT11';
  const normalizedQuery = query.trim().toLowerCase();
  const selectedCanonical = selectedKeycapId
    ? canonicalizeWorkLouderCodexKeycapId(selectedKeycapId)
    : null;
  const keycaps = WORKLOUDER_CODEX_KEYCAP_IDS.filter((keycapId) => {
    if (excludeKeycaps?.includes(keycapId)) return false;
    if (isWorkLouderCodexDuplicateBlankKeycap(keycapId) || keycapId === 'MIC1') return false;
    if (keycapId !== 'MIC' && twoUnit !== isWorkLouderCodexDoubleKeycap(keycapId)) return false;
    const label = keycapPickerLabel(keycapId, copy.blank);
    return (
      normalizedQuery.length === 0 ||
      keycapId.toLowerCase().includes(normalizedQuery) ||
      label.toLowerCase().includes(normalizedQuery)
    );
  }).sort(
    (left, right) =>
      Number(isWorkLouderCodexBlankKeycap(right)) - Number(isWorkLouderCodexBlankKeycap(left)),
  );

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
          {header ? <div className="px-6 pb-4">{header}</div> : null}
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
            {keycaps.map((keycapId) => {
              const label = keycapPickerLabel(keycapId, copy.blank);
              return (
                <button
                  key={keycapId}
                  type="button"
                  aria-label={label}
                  aria-pressed={selectedCanonical === keycapId}
                  onClick={() => onSelect(canonicalizeWorkLouderCodexKeycapId(keycapId))}
                  className={cn(
                    'flex aspect-square min-w-0 flex-col items-center justify-center gap-2 rounded-xl border p-2 text-center transition-colors',
                    'bg-[var(--settings-theme-card-bg)] text-[var(--text-primary)] shadow-[0_1px_0_var(--settings-theme-card-border)]',
                    selectedCanonical === keycapId
                      ? 'border-[var(--focus-ring)] ring-2 ring-[var(--focus-ring-soft)]'
                      : 'border-[var(--settings-theme-card-border)] hover:border-[var(--focus-ring)] hover:bg-[var(--surface-chip)]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
                  )}
                >
                  <WorkLouderCodexKeycapGlyph keycapId={keycapId} className="size-[22px]" />
                  <span className="max-w-full truncate text-11 font-medium tracking-wide">
                    {label}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="border-t border-[var(--border-default)] px-6 py-4">
            {children}
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

/** Shell for the non-keycap editors (agent keys, microphone, stick, encoder). */
export function WorkLouderCodexPartEditor({
  open,
  onOpenChange,
  title,
  description,
  closeLabel,
  children,
  onConfirm,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description: string;
  closeLabel: string;
  children: ReactNode;
  onConfirm?: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[10000] flex max-h-[min(700px,calc(100vh-48px))] w-[min(520px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[var(--shadow-menu)] focus:outline-none">
          <div className="px-6 pb-4 pt-6">
            <Dialog.Title className="text-18 font-medium leading-[1.3]">{title}</Dialog.Title>
            <Dialog.Description className="mt-1 text-13 leading-[1.4] text-[var(--text-secondary)]">
              {description}
            </Dialog.Description>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">{children}</div>
          <div className="flex justify-end border-t border-[var(--border-default)] px-6 py-4">
            <button
              type="button"
              onClick={() => {
                onConfirm?.();
                onOpenChange(false);
              }}
              className="rounded-lg bg-[var(--accent-cta-bg)] px-3 py-2 text-12 font-medium text-[var(--accent-pure-cta-fg)] transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
            >
              {closeLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
