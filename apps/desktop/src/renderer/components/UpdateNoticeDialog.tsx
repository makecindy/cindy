import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Flame, Zap, Wrench, Flower, ChevronDown } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import type {
  ReleaseNoteItem,
  ReleaseNoteSection,
  ReleaseNoteTopic,
  ReleaseNotes,
} from '@/release-notes';
import type { UpdateNoticeMode } from '@/hooks/useUpdateNotice';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UpdateNoticeDialogProps {
  open: boolean;
  mode: UpdateNoticeMode | null;
  /**
   * Auto mode: pre-loaded diff range, newest-first.
   * Manual mode: `[appVersionNotes]` — just the top block preloaded; the rest
   * is discovered via `allVersions` and hydrated lazily via `loadVersion`.
   */
  releaseNotes: ReleaseNotes[] | null;
  /**
   * Manual mode only: full history of versions on CDN (`≤ appVersion`),
   * newest-first. Each entry becomes a placeholder in the scroll body that
   * hydrates on view via `loadVersion`. Null in auto mode.
   */
  allVersions: string[] | null;
  /**
   * Fetch a single version's notes. Returns null on 404 / parse / network.
   * Backed by two-tier cache (main + renderer) — safe to call repeatedly.
   */
  loadVersion: (version: string) => Promise<ReleaseNotes | null>;
  onDismiss: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format date: '2026-04-18' -> locale-specific long date. */
function formatDate(dateStr: string, locale: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/** Shared content column: one reading measure for every block in the dialog. */
const CONTENT_COLUMN = 'w-full max-w-[800px]';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface VersionBadgeProps {
  label: string;
  /** Renders a small chevron on the right and hover state — used by dropdown trigger. */
  clickable?: boolean;
  /** Leading flame glyph. Off for the header's version-jump chip, which is a count, not a version. */
  icon?: boolean;
}

function VersionBadge({ label, clickable = false, icon = true }: VersionBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1 whitespace-nowrap',
        'bg-[var(--chat-input-chip-bg)]',
        // Chip text must use the chip's own semantic color. The previous
        // `--settings-section-desc` resolves to a mid grey that lands at
        // 2.33:1 against the chip background in dark mode (fails WCAG AA);
        // `--chat-input-chip-text` is the sanctioned pairing (7.46:1 dark,
        // 12:1 light).
        'text-xs font-medium text-[var(--chat-input-chip-text)]',
        clickable && 'cursor-pointer hover:bg-[var(--cmd-palette-item-hover)] transition-colors',
      )}
    >
      {icon && <Flame className="h-[13px] w-[13px] shrink-0" />}
      {label}
      {clickable && <ChevronDown className="h-[13px] w-[13px] shrink-0 opacity-70" />}
    </span>
  );
}

const SECTION_ICONS = { zap: Zap, wrench: Wrench } as const;

function groupItemsByAuthor(
  items: ReleaseNoteItem[],
): Array<{ author: string; items: ReleaseNoteItem[] }> {
  const order: string[] = [];
  const buckets = new Map<string, ReleaseNoteItem[]>();
  for (const item of items) {
    if (!buckets.has(item.by)) {
      buckets.set(item.by, []);
      order.push(item.by);
    }
    buckets.get(item.by)!.push(item);
  }
  return order.map((author) => ({ author, items: buckets.get(author)! }));
}

/**
 * Legacy (author-grouped) body, rendered in the SAME single column as the v2
 * topic layout. Previously this was a two-column split (features | fixes),
 * which left half the dialog empty on bugfix-only releases and — more
 * importantly — made scrolling through history alternate between two very
 * different layouts, since only the newest release uses the topic format.
 *
 * Empty sections are dropped rather than rendered as a bare heading.
 */
function SectionList({ sections }: { sections: ReleaseNoteSection[] }) {
  const { t } = useTranslation();
  // Only the two canonical titles get translated. The legacy schema allows an
  // arbitrary section title, and headings are now per-section rather than
  // per-column, so mapping "anything that isn't Bug Fixes" to "New Features"
  // would mislabel unknown sections and print the same heading twice when a
  // payload carries several non-bugfix sections. Unknown titles pass through
  // verbatim.
  const labelFor = (title: string) => {
    if (title === 'Bug Fixes') {
      return { text: t('update.notice.bugFixes'), Icon: SECTION_ICONS.wrench };
    }
    if (title === 'New Features') {
      return { text: t('update.notice.newFeatures'), Icon: SECTION_ICONS.zap };
    }
    return { text: title, Icon: SECTION_ICONS.zap };
  };
  const filled = sections.filter((s) => s.items.length > 0);
  return (
    <>
      {filled.map((section, i) => {
        const { text, Icon } = labelFor(section.title);
        const groups = groupItemsByAuthor(section.items);
        return (
          <div key={`${i}-${section.title}`} className={cn(CONTENT_COLUMN, 'pt-4 pb-1')}>
            <div className="mb-2.5 flex items-center gap-1.5">
              <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--cmd-palette-item-meta)]" />
              <span className="text-13 font-medium text-[var(--cmd-palette-item-meta)]">
                {text}
              </span>
            </div>
            <div className="flex flex-col gap-3.5">
              {groups.map((group) => (
                <AuthorGroup key={group.author} author={group.author} items={group.items} />
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}

function AuthorGroup({ author, items }: { author: string; items: ReleaseNoteItem[] }) {
  return (
    <div>
      <div
        className={cn(
          'mb-2 text-15 font-semibold leading-none tracking-tight',
          'text-[var(--msg-assistant-text)]',
        )}
      >
        {author}
      </div>
      <ul className="flex flex-col gap-1 list-none">
        {items.map((item) => (
          <li key={item.text} className="flex gap-2">
            <span className="shrink-0 text-sm leading-[1.5] text-[var(--settings-section-desc)]">
              &bull;
            </span>
            <span className="text-sm leading-[1.5] text-[var(--msg-assistant-text)]">
              {item.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Per-version thanks line, closing out that version's block like film credits.
 *
 * It used to live in the dialog chrome, which meant the same list was rendered
 * twice at once (chrome + the version block's own subheader) and, at ~30
 * contributors, turned the top of the dialog into a two-line wall of names.
 * Anchoring it to the end of the version it belongs to removes the duplication
 * and makes the attribution unambiguous. Regular weight + secondary color keeps
 * it a closing note rather than a heading.
 */
function ThanksLine({ contributors }: { contributors: string[] }) {
  const { t } = useTranslation();
  if (contributors.length === 0) return null;
  return (
    <div
      className={cn(
        CONTENT_COLUMN,
        'mt-3 flex items-start gap-1.5 border-t border-[var(--cmd-palette-border)] pt-4',
        'text-12 leading-[1.7] select-text',
      )}
    >
      <Flower
        className="mt-[3px] h-3.5 w-3.5 shrink-0 text-[var(--status-bar-accent)]"
        strokeWidth={2.25}
      />
      <span className="shrink-0 text-[var(--cmd-palette-item-meta)]">
        {t('update.notice.thanksTo')}
      </span>
      <span className="min-w-0 break-words text-[var(--cmd-palette-item-meta)]">
        {contributors.join(' · ')}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Topic-format (v2) body: single centered column of theme blocks. Replaces
// the two-column author-grouped layout for payloads that carry `topics` —
// notably fixes the half-empty dialog on bugfix-only releases.
// ---------------------------------------------------------------------------

function TopicList({ intro, topics }: { intro?: string; topics: ReleaseNoteTopic[] }) {
  return (
    <>
      {intro && (
        <div
          className={cn(
            CONTENT_COLUMN,
            'pt-3 pb-1 text-sm leading-[1.7] break-words text-[var(--cmd-palette-item-meta)]',
          )}
        >
          {intro}
        </div>
      )}
      {topics.map((topic, i) => (
        <div key={`${i}-${topic.title}`} className={cn(CONTENT_COLUMN, 'py-3')}>
          {/* flex-wrap + min-w-0: long titles shrink/wrap and an overlong
              contributor list drops to its own right-aligned line instead of
              overflowing the dialog at narrow widths. */}
          <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            {topic.emoji && <span className="text-15 leading-none">{topic.emoji}</span>}
            <span
              className={cn(
                'min-w-0 break-words text-15 font-medium leading-tight tracking-tight',
                'text-[var(--msg-assistant-text)]',
              )}
            >
              {topic.title}
            </span>
            {topic.contributors.length > 0 && (
              <span className="ml-auto max-w-full break-words text-right text-12 text-[var(--cmd-palette-item-meta)]">
                {topic.contributors.join(' · ')}
              </span>
            )}
          </div>
          <div className="text-sm leading-[1.7] break-words text-[var(--msg-assistant-text)]">
            {topic.text}
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * One version's block, single column throughout:
 *
 *   [v0.1.21]  2026年7月29日      <- subheader: version + date only
 *   intro / topics (v2)  or  sections (legacy)
 *   ─────────────────────────
 *   🌸 感谢 A · B · C            <- closing thanks line
 *
 * The subheader deliberately no longer repeats the contributor list: it is the
 * thanks line's job, once, at the end. The outer container owns scrolling.
 */
function VersionBlock({ notes, locale }: { notes: ReleaseNotes; locale: string }) {
  const isTopicFormat = notes.topics.length > 0;
  const formattedDate = formatDate(notes.date, locale);
  return (
    <div className="flex flex-col items-center px-7 pb-2">
      <div className={cn(CONTENT_COLUMN, 'flex items-center gap-2 pt-5')}>
        <VersionBadge label={`v${notes.version}`} />
        {/* nowrap: a long date must not be squeezed into three lines by
            whatever sits next to it (the old subheader did exactly that). */}
        <span className="whitespace-nowrap text-13 text-[var(--cmd-palette-item-meta)]">
          {formattedDate}
        </span>
      </div>
      {isTopicFormat ? (
        <TopicList intro={notes.intro} topics={notes.topics} />
      ) : (
        <SectionList sections={notes.sections} />
      )}
      <ThanksLine contributors={notes.contributors} />
    </div>
  );
}

/**
 * Placeholder for a manual-mode version whose notes haven't been loaded yet
 * (either not yet in view, or in flight, or permanently 404). Uses a fixed
 * min-height so scroll offsets stay stable when the real content swaps in.
 *
 * Error state is terminal (see ManualBody's startLoad guard) — but users can
 * hit the retry button to explicitly re-fire the fetch, useful when a CDN
 * eventually-consistent publish catches up after the initial miss.
 */
function PlaceholderBlock({
  version,
  isLoading,
  isError,
  onRetry,
}: {
  version: string;
  /**
   * True only while a fetch is actually in flight. `idle` (queued but not yet
   * observed) must NOT set this: every off-screen version used to render a
   * spinner + "loading", so a user opening the history saw a dozen versions
   * apparently stuck loading forever when in fact nothing had been requested.
   */
  isLoading: boolean;
  isError: boolean;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[180px] flex-col items-center px-7">
      <div className={cn(CONTENT_COLUMN, 'flex items-center gap-3 pt-5')}>
        <VersionBadge label={`v${version}`} />
        {isLoading && (
          <span className="inline-flex items-center gap-1.5 text-12 text-[var(--cmd-palette-item-meta)]">
            <Spinner size={14} />
            {t('update.notice.loading')}
          </span>
        )}
        {isError && (
          <span className="inline-flex items-center gap-2 text-12 text-[var(--cmd-palette-item-meta)]">
            {t('update.notice.loadFailed')}
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className={cn(
                  'rounded-md px-2 py-0.5 text-11',
                  'bg-[var(--chat-input-chip-bg)] hover:bg-[var(--cmd-palette-item-hover)]',
                  'text-[var(--chat-input-chip-text)]',
                  'transition-colors focus-visible:outline-none focus-visible:ring-1',
                )}
              >
                {t('update.notice.retry')}
              </button>
            )}
          </span>
        )}
      </div>
      {/* Idle (not yet scrolled near, nothing in flight) renders as reserved
          blank space, not as a spinner — see PlaceholderBlock's isLoading doc. */}
      <div className="flex min-h-[120px] flex-1 items-center justify-center" aria-hidden />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manual-mode dropdown: click header badge to jump to any version.
// ---------------------------------------------------------------------------

interface VersionDropdownProps {
  versions: string[];
  currentVersion: string;
  onSelect: (version: string) => void;
  triggerLabel: string;
  /**
   * Accessible name for the trigger. Must be given separately from
   * `triggerLabel`: the visible chip only shows a version *count*, so reusing
   * it as the accessible name would leave screen-reader users with no way to
   * tell which version they are currently on without opening the menu.
   */
  triggerAriaLabel: string;
  /**
   * Bubble open state up so the parent AlertDialog can guard its overlay
   * onClick — Radix outside-click closes the dropdown but the click continues
   * to propagate; without the guard it would land on `AlertDialog.Overlay`
   * and dismiss the whole dialog too.
   */
  onOpenChange?: (open: boolean) => void;
}

function VersionDropdown({
  versions,
  currentVersion,
  onSelect,
  triggerLabel,
  triggerAriaLabel,
  onOpenChange,
}: VersionDropdownProps) {
  return (
    <DropdownMenu.Root onOpenChange={onOpenChange} modal>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="inline-flex outline-none"
          aria-label={triggerAriaLabel}
        >
          {/* The trigger now reads "N versions", not a version number, so the
              flame glyph would be misleading — hence icon={false}. */}
          <VersionBadge label={triggerLabel} clickable icon={false} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={6}
          // Stop clicks inside dropdown content from bubbling — belt-and-
          // suspenders on top of `modal` prop + parent dropdownOpenRef guard.
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'z-[10001] max-h-[400px] w-[180px] overflow-y-auto rounded-lg py-1',
            'bg-[var(--cmd-palette-bg)] border border-[var(--cmd-palette-border)]',
            'shadow-[var(--shadow-menu)]',
            // Animate with the overlay-style pure-fade keyframes; the
            // confirm-content-in animation has a `translate(-50%,-50%) scale`
            // transform meant for center-of-screen dialogs, and Radix Popper
            // applies its own transform for anchor positioning — stacking the
            // two causes the dropdown to visually "jump" from the middle of
            // the screen to the trigger during mount. Pure opacity fade
            // stays neutral to Popper's positioning transform.
            'data-[state=open]:animate-confirm-overlay-in',
            'data-[state=closed]:animate-confirm-overlay-out',
          )}
        >
          {versions.map((v) => (
            <DropdownMenu.Item
              key={v}
              onSelect={() => onSelect(v)}
              className={cn(
                'flex cursor-pointer items-center gap-2 px-3 py-1.5 text-13 outline-none',
                'text-[var(--msg-assistant-text)]',
                'data-[highlighted]:bg-[var(--cmd-palette-item-hover)]',
                v === currentVersion && 'font-semibold',
              )}
            >
              <span className="tabular-nums">v{v}</span>
              {v === currentVersion && (
                <span className="ml-auto text-11 text-[var(--cmd-palette-item-meta)]">•</span>
              )}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// ---------------------------------------------------------------------------
// Auto-mode body: static header badge (v<oldest> → v<newest>), preloaded
// blocks stacked.
// ---------------------------------------------------------------------------

function AutoBody({
  releaseNotes,
  locale,
}: {
  releaseNotes: ReleaseNotes[];
  locale: string;
}) {
  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-y-auto py-2 select-text">
      {releaseNotes.map((notes, i) => (
        <div key={notes.version} className="flex flex-col">
          {i > 0 && <div className="mx-auto h-px w-full max-w-[800px] bg-[var(--cmd-palette-border)]" />}
          <VersionBlock notes={notes} locale={locale} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manual-mode body: full history with lazy hydration.
// ---------------------------------------------------------------------------

/** State of a single version's fetch. */
type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

interface ManualBodyProps {
  allVersions: string[];
  initialLoaded: Map<string, ReleaseNotes>;
  loadVersion: (v: string) => Promise<ReleaseNotes | null>;
  locale: string;
  /** Called when the topmost visible version changes, so header can update. */
  onStickyChange: (version: string) => void;
  /** Setter registered by parent so `jumpToVersion` can programmatically scroll. */
  registerJump: (fn: (v: string) => void) => void;
}

function ManualBody({
  allVersions,
  initialLoaded,
  loadVersion,
  locale,
  onStickyChange,
  registerJump,
}: ManualBodyProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const blockRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [notesMap, setNotesMap] = useState<Map<string, ReleaseNotes>>(initialLoaded);
  const [stateMap, setStateMap] = useState<Map<string, LoadState>>(() => {
    const m = new Map<string, LoadState>();
    for (const v of allVersions) {
      m.set(v, initialLoaded.has(v) ? 'loaded' : 'idle');
    }
    return m;
  });
  const inFlightRef = useRef<Set<string>>(new Set());
  // Ref mirror of stateMap so `startLoad` doesn't need it in useCallback deps.
  // Without this, every setStateMap → new startLoad identity → observer
  // useEffect re-runs → new observer immediately fires callbacks for still-
  // intersecting blocks → for `error` state blocks, retriggers fetch → error
  // again → infinite loading↔failed flicker (the bug this refactor fixes).
  const stateMapRef = useRef(stateMap);
  useEffect(() => { stateMapRef.current = stateMap; }, [stateMap]);

  const startLoad = useCallback(
    async (version: string) => {
      if (inFlightRef.current.has(version)) return;
      const current = stateMapRef.current.get(version);
      // Terminal states — never retry automatically. Loaded needs no work,
      // loading is already in flight (also guarded by inFlightRef), error is
      // sticky until user hits the retry button (see `retryVersion`).
      if (current === 'loaded' || current === 'loading' || current === 'error') return;
      inFlightRef.current.add(version);
      setStateMap((prev) => new Map(prev).set(version, 'loading'));
      try {
        const notes = await loadVersion(version);
        if (notes) {
          setNotesMap((prev) => new Map(prev).set(version, notes));
          setStateMap((prev) => new Map(prev).set(version, 'loaded'));
        } else {
          setStateMap((prev) => new Map(prev).set(version, 'error'));
        }
      } catch {
        setStateMap((prev) => new Map(prev).set(version, 'error'));
      } finally {
        inFlightRef.current.delete(version);
      }
    },
    [loadVersion],
  );

  // Manual retry from the error placeholder's button. Only meaningful for
  // 'error' state (idle/loading/loaded are no-ops). Resets state to idle so
  // startLoad's guard passes, then kicks off a fresh fetch. Sync-mutates the
  // ref so the immediate startLoad call sees the reset — the paired
  // setStateMap keeps React state consistent for rendering.
  const retryVersion = useCallback(
    (version: string) => {
      if (stateMapRef.current.get(version) !== 'error') return;
      const next = new Map(stateMapRef.current);
      next.set(version, 'idle');
      stateMapRef.current = next;
      setStateMap(next);
      void startLoad(version);
    },
    [startLoad],
  );

  // Lazy-load observer: fires when a block enters or is within 400px of the
  // viewport so hydration starts before the user actually reaches it.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const v = (entry.target as HTMLElement).dataset.version;
          if (v) void startLoad(v);
        }
      },
      { root, rootMargin: '400px 0px 400px 0px', threshold: 0 },
    );
    for (const el of blockRefs.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [allVersions, startLoad]);

  // Sticky-header observer: narrow band at the very top of the scroll area
  // tells us which version block the user is currently reading. Whichever
  // entry's top edge is closest to (but not past) the scroll-container top
  // wins the badge.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    // rootMargin trick: negative bottom margin equal to (100% - 1px) shrinks
    // the intersection zone to a 1px band at the top. Any element crossing
    // that band is by definition the topmost currently-scrolled-to element.
    const observer = new IntersectionObserver(
      (entries) => {
        // Pick the most-recently-crossed intersecting entry. Multiple can
        // report in a single callback during fast scrolls; take the one with
        // the smallest positive `top` for stability.
        let best: { v: string; top: number } | null = null;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const v = (entry.target as HTMLElement).dataset.version;
          if (!v) continue;
          const top = entry.boundingClientRect.top;
          if (best === null || top < best.top) best = { v, top };
        }
        if (best) onStickyChange(best.v);
      },
      { root, rootMargin: '0px 0px -99% 0px', threshold: 0 },
    );
    for (const el of blockRefs.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [allVersions, onStickyChange]);

  // Programmatic jump handler exposed to parent (header dropdown).
  useEffect(() => {
    registerJump((v: string) => {
      const el = blockRefs.current.get(v);
      if (!el) return;
      // Use instant scroll to avoid triggering IntersectionObserver for all
      // intermediate placeholders (smooth scroll would fan out CDN requests).
      el.scrollIntoView({ behavior: 'instant', block: 'start' });
      void startLoad(v);
    });
  }, [registerJump, startLoad]);

  return (
    <div ref={scrollRef} className="flex flex-1 min-h-0 flex-col overflow-y-auto py-2 select-text">
      {allVersions.map((v, i) => {
        const notes = notesMap.get(v);
        const state = stateMap.get(v) ?? 'idle';
        return (
          <div
            key={v}
            ref={(el) => {
              if (el) blockRefs.current.set(v, el);
              else blockRefs.current.delete(v);
            }}
            data-version={v}
            className="flex flex-col"
          >
            {i > 0 && <div className="mx-auto h-px w-full max-w-[800px] bg-[var(--cmd-palette-border)]" />}
            {notes ? (
              <VersionBlock notes={notes} locale={locale} />
            ) : (
              <PlaceholderBlock
                version={v}
                isLoading={state === 'loading'}
                isError={state === 'error'}
                onRetry={() => retryVersion(v)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function UpdateNoticeDialog({
  open,
  mode,
  releaseNotes,
  allVersions,
  loadVersion,
  onDismiss,
}: UpdateNoticeDialogProps) {
  const { t, i18n } = useTranslation();

  // Memo-ize the seed Map so ManualBody's useState(initialLoaded) doesn't
  // receive a new object identity on every parent re-render. The Map is only
  // read once at ManualBody mount, but avoiding the allocation cost is free.
  const initialLoaded = useMemo(
    () => new Map((releaseNotes ?? []).map((n) => [n.version, n])),
    [releaseNotes],
  );

  // Sticky version state — used only in manual mode; defaults to the newest
  // preloaded version so the header badge is populated from the very first
  // frame (no null flash while IntersectionObserver hasn't fired yet).
  const initialSticky = releaseNotes?.[0]?.version ?? '';
  const [stickyVersion, setStickyVersion] = useState<string>(initialSticky);

  const jumpRef = useRef<((v: string) => void) | null>(null);
  const registerJump = useCallback((fn: (v: string) => void) => {
    jumpRef.current = fn;
  }, []);

  // Track version-dropdown open state + timestamp of most recent close.
  //
  // The tricky case: a single user click that starts on an area outside the
  // dropdown fires pointerdown → pointerup → click in sequence. Radix's
  // DismissableLayer catches pointerdown outside and synchronously calls
  // onOpenChange(false), which flips our ref via setTimeout(0). But browser
  // event dispatch may schedule these three events as separate macrotasks
  // (spec-legal), so setTimeout(0) can fire BEFORE the trailing click event.
  // The overlay's onClick then sees ref === false and dismisses the dialog.
  //
  // Fix: track a timestamp of when the dropdown was last observed to close;
  // guard dismissIfDialogOnly by BOTH the ref and a grace window. Any click
  // within `GRACE_MS` of a dropdown close is treated as "part of the same
  // dismissal gesture" and bounces. Independent of scheduler ordering.
  //
  // 200ms is generous vs typical event cascades (< 20ms) but well below any
  // human double-click cadence — if the user actually wants to close the
  // dialog after the dropdown closes, they click again after the grace.
  const DROPDOWN_CLOSE_GRACE_MS = 200;
  const dropdownOpenRef = useRef(false);
  const dropdownClosedAtRef = useRef(0);
  const dismissIfDialogOnly = useCallback(() => {
    if (dropdownOpenRef.current) return;
    if (Date.now() - dropdownClosedAtRef.current < DROPDOWN_CLOSE_GRACE_MS) return;
    onDismiss();
  }, [onDismiss]);

  // Reset sticky when dialog re-opens (avoids showing last-session's badge).
  useEffect(() => {
    if (open) setStickyVersion(releaseNotes?.[0]?.version ?? '');
  }, [open, releaseNotes]);

  if (!releaseNotes || !mode || releaseNotes.length === 0) {
    return null;
  }

  const isManual = mode === 'manual';
  const newest = releaseNotes[0];
  const oldestLoaded = releaseNotes[releaseNotes.length - 1];

  const isAutoMulti = mode === 'auto' && releaseNotes.length > 1;

  // Aria description reads differently for each mode so screen-readers get
  // a sensible summary instead of a generic "release notes for vX".
  const ariaDescription = isManual
    ? t('update.notice.ariaDescriptionSpan', {
        from: (allVersions && allVersions.length > 0)
          ? allVersions[allVersions.length - 1]
          : newest.version,
        count: allVersions?.length ?? 1,
      })
    : isAutoMulti
      ? t('update.notice.ariaDescriptionSpan', {
          from: oldestLoaded.version,
          count: releaseNotes.length,
        })
      : t('update.notice.ariaDescription', { version: newest.version });

  // Header's right cell — a version count, and in manual mode the entry point
  // for jumping across history. Version number, date and contributors all moved
  // into each version's own block, so there is nothing else left up here.
  //   - Manual:     "N versions" + dropdown
  //   - Auto multi: "N versions", static
  //   - Auto single: nothing (a single version's identity is in its block)
  const versionCountLabel = isManual
    ? t('update.notice.versionsSpan', { count: allVersions?.length ?? 1 })
    : isAutoMulti
      ? t('update.notice.versionsSpan', { count: releaseNotes.length })
      : null;

  return (
    <AlertDialog.Root
      open={open}
      // Route Radix-driven dismissal (Escape key) through the same guard as
      // the manual overlay click: dropdownOpenRef + grace window prevent
      // spurious closes triggered by the version dropdown's pointerdown
      // event cascade. This re-enables keyboard (Escape) dismissal without
      // the race condition that required the previous no-op approach.
      onOpenChange={(v) => { if (!v) dismissIfDialogOnly(); }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay
          className={cn(
            'fixed inset-0 z-[10000]',
            'bg-black/40 dark:bg-black/60',
            'data-[state=open]:animate-confirm-overlay-in',
            'data-[state=closed]:animate-confirm-overlay-out',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          // Overlay click-to-dismiss: only when nothing else is claiming the
          // click. Two guards:
          //   1. e.target === e.currentTarget — ensures we only respond to a
          //      click on the overlay itself, not a synthetic-event bubble
          //      from portaled children (defensive; React's tree bubbling
          //      shouldn't route Content clicks here, but Radix's nested
          //      dismissable layers have historically produced surprises).
          //   2. dropdownOpenRef — dropdown-outside clicks land on the
          //      overlay while dropdown is closing; we want those to only
          //      close the dropdown, not cascade into a dialog dismiss.
          onClick={(e) => {
            if (e.target !== e.currentTarget) return;
            dismissIfDialogOnly();
          }}
        />

        <AlertDialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[10000] -translate-x-1/2 -translate-y-1/2',
            // 920px, not the previous 1240px: the body is a single ~800px
            // reading column now, so the extra width only produced dead margins
            // and made the full-width chrome visibly mismatch the narrow body.
            'w-[920px] h-[838px] max-w-[95vw] max-h-[90vh] rounded-xl flex flex-col',
            'bg-[var(--cmd-palette-bg)]',
            'border border-[var(--cmd-palette-border)]',
            'data-[state=open]:animate-confirm-content-in',
            'data-[state=closed]:animate-confirm-content-out',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <AlertDialog.Description className="sr-only">
            {ariaDescription}
          </AlertDialog.Description>

          {/* ---- Header ----
              3-column grid instead of flex-justify-between so the right cell's
              width changes never shift the centered title: each 1fr cell is
              exactly a third of the header width, so the title always sits at
              the true horizontal middle. The left cell is intentionally empty —
              it exists to balance the grid. `min-w-0` keeps a long right label
              from blowing out its track. */}
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-6 pt-4 pb-3.5">
            <span aria-hidden />
            <AlertDialog.Title className="text-20 leading-[1.4] font-medium text-[var(--msg-assistant-text)] justify-self-center whitespace-nowrap">
              {t('update.notice.title')}
            </AlertDialog.Title>
            <div className="min-w-0 justify-self-end">
              {isManual && allVersions && allVersions.length > 1 && versionCountLabel ? (
                <VersionDropdown
                  versions={allVersions}
                  currentVersion={stickyVersion || newest.version}
                  triggerLabel={versionCountLabel}
                  triggerAriaLabel={t('update.notice.versionJumpAria', {
                    count: allVersions.length,
                    version: stickyVersion || newest.version,
                  })}
                  onSelect={(v) => jumpRef.current?.(v)}
                  onOpenChange={(dropOpen) => {
                    dropdownOpenRef.current = dropOpen;
                    // Record close timestamp so dismissIfDialogOnly can
                    // recognize any trailing click within the grace window
                    // as "part of the same close gesture" and bounce. This
                    // replaces the earlier setTimeout(0) ref-flip trick,
                    // which was unreliable — the browser is free to schedule
                    // pointerdown/pointerup/click as separate macrotasks
                    // with setTimeout(0) sandwiched between, causing the
                    // guard to release too early.
                    if (!dropOpen) dropdownClosedAtRef.current = Date.now();
                  }}
                />
              ) : versionCountLabel ? (
                <span className="whitespace-nowrap text-13 text-[var(--cmd-palette-item-meta)]">
                  {versionCountLabel}
                </span>
              ) : null}
            </div>
          </div>

          <div className="h-px bg-[var(--cmd-palette-border)]" />

          {/* ---- Content ---- */}
          {/* Auto single-version no longer needs its own branch: VersionBlock
              carries the version, date and thanks itself, so one block and N
              blocks render through the same path. */}
          {isManual && allVersions ? (
            <ManualBody
              allVersions={allVersions}
              initialLoaded={initialLoaded}
              loadVersion={loadVersion}
              locale={i18n.language}
              onStickyChange={setStickyVersion}
              registerJump={registerJump}
            />
          ) : (
            <AutoBody releaseNotes={releaseNotes} locale={i18n.language} />
          )}

          <div className="h-px bg-[var(--cmd-palette-border)]" />

          {/* ---- Footer ---- */}
          <div className="flex justify-center px-7 pt-4 pb-5">
            {/* Plain button rather than AlertDialog.Action: since the root's
                onOpenChange is a deliberate no-op (see comment there), we
                can't rely on AlertDialog.Action calling context.onOpenChange
                to close the dialog. Hand-wired onClick calls our onDismiss
                directly — bypasses all Radix internal dismissal machinery. */}
            <button
              type="button"
              onClick={onDismiss}
              className={cn(
                'rounded-full px-8 py-2.5 text-14 font-medium',
                'bg-[var(--chat-input-chip-bg)] text-[var(--chat-input-chip-text)]',
                'hover:bg-[var(--cmd-palette-item-hover)] transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                'active:scale-[0.98]',
              )}
            >
              {t('update.notice.gotIt')}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
