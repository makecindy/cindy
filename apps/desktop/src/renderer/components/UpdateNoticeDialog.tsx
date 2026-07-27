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

/** Split sections: left = New Features + other non-Bug-Fixes, right = Bug Fixes */
function splitSections(sections: ReleaseNoteSection[]): {
  leftSections: ReleaseNoteSection[];
  rightSections: ReleaseNoteSection[];
} {
  const left: ReleaseNoteSection[] = [];
  const right: ReleaseNoteSection[] = [];
  for (const section of sections) {
    if (section.title === 'Bug Fixes') {
      right.push(section);
    } else {
      left.push(section);
    }
  }
  return { leftSections: left, rightSections: right };
}

/**
 * Aggregate unique contributors across every currently-loaded version,
 * preserving first-appearance order. Used for the header hall-of-fame line.
 */
function aggregateContributors(notes: ReleaseNotes[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of notes) {
    for (const c of n.contributors) {
      if (!seen.has(c)) {
        seen.add(c);
        out.push(c);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface VersionBadgeProps {
  label: string;
  /** Renders a small chevron on the right and hover state — used by dropdown trigger. */
  clickable?: boolean;
}

function VersionBadge({ label, clickable = false }: VersionBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1',
        'bg-[var(--chat-input-chip-bg)]',
        'text-xs font-medium text-[var(--settings-section-desc)]',
        clickable && 'cursor-pointer hover:bg-[var(--cmd-palette-item-hover)] transition-colors',
      )}
    >
      <Flame className="h-[13px] w-[13px]" />
      {label}
      {clickable && <ChevronDown className="h-[13px] w-[13px] opacity-70" />}
    </span>
  );
}

const SECTION_ICONS = { zap: Zap, wrench: Wrench } as const;

interface SectionColumnProps {
  icon: keyof typeof SECTION_ICONS;
  title: string;
  sections: ReleaseNoteSection[];
  /** When false, the column doesn't own its own scroll — the outer container scrolls instead. */
  scroll?: boolean;
}

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

function SectionColumn({ icon, title, sections, scroll = true }: SectionColumnProps) {
  const Icon = SECTION_ICONS[icon];
  const allItems = sections.flatMap((s) => s.items);
  const groups = groupItemsByAuthor(allItems);
  return (
    <div className={cn('flex flex-1 flex-col px-7', scroll && 'overflow-y-auto')}>
      <div className="flex items-center gap-1.5 mb-3">
        <Icon className="h-3.5 w-3.5 text-[var(--cmd-palette-item-meta)]" />
        <span className="text-13 font-medium text-[var(--cmd-palette-item-meta)]">{title}</span>
      </div>
      <div className="flex flex-col gap-3.5">
        {groups.map((group) => (
          <AuthorGroup key={group.author} author={group.author} items={group.items} />
        ))}
      </div>
    </div>
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

function ContributorsLine({ contributors }: { contributors: string[] }) {
  const { t } = useTranslation();
  if (contributors.length === 0) return null;
  return (
    <div
      className={cn(
        'flex items-center justify-center gap-1.5 px-6 pb-3',
        'text-12 leading-none select-text',
      )}
    >
      <span className="flex h-[12px] items-center">
        <Flower
          className="h-3.5 w-3.5 text-[var(--status-bar-accent)] -translate-y-[2px]"
          strokeWidth={2.25}
        />
      </span>
      <span className="text-[var(--cmd-palette-item-meta)]">{t('update.notice.thanksTo')}</span>
      <span className="font-semibold text-[var(--msg-assistant-text)]">
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
    <div className="flex flex-col items-center px-7">
      {intro && (
        <div className="w-full max-w-[760px] pb-3 text-sm leading-[1.7] break-words text-[var(--cmd-palette-item-meta)]">
          {intro}
        </div>
      )}
      {topics.map((topic, i) => (
        <div key={`${i}-${topic.title}`} className="w-full max-w-[760px] py-3">
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
    </div>
  );
}

/**
 * A loaded version's block — subheader (version badge + date + contributors)
 * on top, body below: topic list for v2 payloads, two-column
 * features/bugfixes for legacy ones. Same layout auto and manual modes
 * share; the outer container owns scrolling in both cases.
 */
function VersionBlock({ notes, locale }: { notes: ReleaseNotes; locale: string }) {
  const { t } = useTranslation();
  const isTopicFormat = notes.topics.length > 0;
  const { leftSections, rightSections } = splitSections(notes.sections);
  const formattedDate = formatDate(notes.date, locale);
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-7 pt-3 pb-2.5">
        <div className="flex items-center gap-2">
          <VersionBadge label={`v${notes.version}`} />
          <span className="text-13 text-[var(--cmd-palette-item-meta)]">{formattedDate}</span>
        </div>
        {notes.contributors.length > 0 && (
          <span className="text-12 text-[var(--cmd-palette-item-meta)]">
            {notes.contributors.join(' · ')}
          </span>
        )}
      </div>
      {isTopicFormat ? (
        <div className="py-3">
          <TopicList intro={notes.intro} topics={notes.topics} />
        </div>
      ) : (
        <div className="flex py-3">
          <SectionColumn
            icon="zap"
            title={t('update.notice.newFeatures')}
            sections={leftSections}
            scroll={false}
          />
          <div className="w-px self-stretch bg-[var(--cmd-palette-border)]" />
          <SectionColumn
            icon="wrench"
            title={t('update.notice.bugFixes')}
            sections={rightSections}
            scroll={false}
          />
        </div>
      )}
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
  isLoading: boolean;
  isError: boolean;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col min-h-[180px]">
      <div className="flex items-center justify-between px-7 pt-3 pb-2.5">
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
      <div className="flex flex-1 min-h-[120px] items-center justify-center px-7">
        {!isLoading && !isError && (
          <span className="text-12 text-[var(--cmd-palette-item-meta)] opacity-40">
            &nbsp;
          </span>
        )}
      </div>
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
  onOpenChange,
}: VersionDropdownProps) {
  return (
    <DropdownMenu.Root onOpenChange={onOpenChange} modal>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="inline-flex outline-none"
          aria-label={triggerLabel}
        >
          <VersionBadge label={triggerLabel} clickable />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="start"
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
          {i > 0 && <div className="h-px mx-6 my-1 bg-[var(--cmd-palette-border)]" />}
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
  /** Called each time a version's notes finish loading, so parent can aggregate contributors. */
  onNotesLoaded?: (notes: ReleaseNotes) => void;
}

function ManualBody({
  allVersions,
  initialLoaded,
  loadVersion,
  locale,
  onStickyChange,
  registerJump,
  onNotesLoaded,
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
          onNotesLoaded?.(notes);
        } else {
          setStateMap((prev) => new Map(prev).set(version, 'error'));
        }
      } catch {
        setStateMap((prev) => new Map(prev).set(version, 'error'));
      } finally {
        inFlightRef.current.delete(version);
      }
    },
    [loadVersion, onNotesLoaded],
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
            {i > 0 && <div className="h-px mx-6 my-1 bg-[var(--cmd-palette-border)]" />}
            {notes ? (
              <VersionBlock notes={notes} locale={locale} />
            ) : (
              <PlaceholderBlock
                version={v}
                isLoading={state === 'loading' || state === 'idle'}
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

  // Manual mode: accumulate notes as they lazy-load so contributors line
  // reflects all visible history, not just the initial seed.
  const [manualLoadedNotes, setManualLoadedNotes] = useState<ReleaseNotes[]>(
    releaseNotes ?? [],
  );
  const handleNotesLoaded = useCallback((notes: ReleaseNotes) => {
    setManualLoadedNotes((prev) => {
      if (prev.some((n) => n.version === notes.version)) return prev;
      return [...prev, notes];
    });
  }, []);

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

  // Header badge label:
  //   - Auto multi:  v<oldest> → v<newest>  (static)
  //   - Auto single: v<newest>              (static)
  //   - Manual:      v<sticky>              (dynamic, click-to-open-dropdown)
  const badgeLabel = isManual
    ? `v${stickyVersion || newest.version}`
    : isAutoMulti
      ? `v${oldestLoaded.version} → v${newest.version}`
      : `v${newest.version}`;

  // Header right column:
  //   - Manual: total version count "N 个版本"
  //   - Auto multi: same
  //   - Auto single: newest's date
  const headerRight = isManual
    ? t('update.notice.versionsSpan', { count: allVersions?.length ?? 1 })
    : isAutoMulti
      ? t('update.notice.versionsSpan', { count: releaseNotes.length })
      : formatDate(newest.date, i18n.language);

  // Contributors line:
  //   - Manual: scoped to the currently visible (sticky) version only to avoid
  //     the header overflowing as dozens of names accumulate across loaded history.
  //   - Auto multi: aggregated from all pre-loaded diff range versions.
  //   - Auto single: just the newest version's contributors.
  const contributors = isManual
    ? (manualLoadedNotes.find((n) => n.version === stickyVersion)?.contributors ?? [])
    : isAutoMulti
      ? aggregateContributors(releaseNotes)
      : newest.contributors;

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
            'w-[1240px] h-[838px] max-w-[95vw] max-h-[90vh] rounded-xl flex flex-col',
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
              3-column grid instead of flex-justify-between so badge width
              changes (sticky version tracker updates as user scrolls in
              manual mode) don't shift the centered title. Each 1fr cell is
              exactly a third of the header width; the title always sits at
              the horizontal midpoint of its own cell, i.e. the true middle
              of the dialog. `min-w-0` on cells is required so long badges
              (e.g. "v0.0.140 → v0.0.144" in auto multi mode) don't blow
              out the grid track. */}
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-6 pt-4 pb-2.5">
            <div className="min-w-0 justify-self-start">
              {isManual && allVersions && allVersions.length > 1 ? (
                <VersionDropdown
                  versions={allVersions}
                  currentVersion={stickyVersion || newest.version}
                  triggerLabel={badgeLabel}
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
              ) : (
                <VersionBadge label={badgeLabel} />
              )}
            </div>
            <AlertDialog.Title className="text-20 leading-[1.4] font-medium text-[var(--msg-assistant-text)] justify-self-center whitespace-nowrap">
              {t('update.notice.title')}
            </AlertDialog.Title>
            <span className="text-13 text-[var(--cmd-palette-item-meta)] min-w-0 justify-self-end whitespace-nowrap">
              {headerRight}
            </span>
          </div>

          <ContributorsLine contributors={contributors} />

          <div className="h-px bg-[var(--cmd-palette-border)]" />

          {/* ---- Content ---- */}
          {isManual && allVersions ? (
            <ManualBody
              allVersions={allVersions}
              initialLoaded={initialLoaded}
              loadVersion={loadVersion}
              locale={i18n.language}
              onStickyChange={setStickyVersion}
              registerJump={registerJump}
              onNotesLoaded={handleNotesLoaded}
            />
          ) : mode === 'auto' && releaseNotes.length === 1 ? (
            newest.topics.length > 0 ? (
              <div className="flex flex-1 min-h-0 flex-col overflow-y-auto py-4 select-text">
                <TopicList intro={newest.intro} topics={newest.topics} />
              </div>
            ) : (
              (() => {
                const { leftSections, rightSections } = splitSections(newest.sections);
                return (
                  <div className="flex flex-1 min-h-0 py-4 select-text">
                    <SectionColumn
                      icon="zap"
                      title={t('update.notice.newFeatures')}
                      sections={leftSections}
                    />
                    <div className="w-px self-stretch bg-[var(--cmd-palette-border)]" />
                    <SectionColumn
                      icon="wrench"
                      title={t('update.notice.bugFixes')}
                      sections={rightSections}
                    />
                  </div>
                );
              })()
            )
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
