import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import {
  fetchReleaseNotes,
  fetchReleaseNotesIndex,
  type ReleaseNotes,
} from '@/release-notes';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';

const log = createLogger('UseUpdateNotice');

const STORAGE_KEY = 'xdt-maker:lastReadVersion';

/**
 * Cap on how many versions get aggregated into a single **auto** popup. Users
 * who skip many releases don't actually read 30 blocks of notes — the wall
 * becomes scary and the CDN takes a beating fanning out that many parallel
 * fetches. Manual look-back (`onOpen`) is NOT capped — it lazy-loads full
 * history on scroll, so the initial cost stays constant regardless of depth.
 */
const MAX_AGGREGATED_VERSIONS = 5;

/**
 * How long the pre-install preview waits for the version index before opening
 * with the pending version alone. The index contributes only the *in-between*
 * blocks of a multi-version jump; a slow or unreachable CDN must not turn the
 * banner's link into a dead click for the full request timeout (15s in
 * `releaseNotesService`).
 */
const PREVIEW_INDEX_BUDGET_MS = 3000;

/** Numeric semver comparison. Returns >0 if a > b, <0 if a < b, 0 if equal. */
function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Two dialog modes with very different data / UX contracts:
 *
 *   - `auto`  — fired once per launch after a version upgrade. Loads the diff
 *              `(lastRead, appVersion]` (max N) all up front. Badge is static
 *              `v<oldest> → v<newest>`. Dismissal advances `lastReadVersion`.
 *
 *   - `manual`— fired by user clicking the flame icon. Loads only appVersion's
 *              notes up front; the rest of the history is exposed via
 *              `allVersions` and lazy-fetched via `loadVersion` as the dialog
 *              scrolls placeholders into view. Badge tracks the topmost
 *              visible version + doubles as a dropdown to jump to any version.
 *              Dismissal does NOT touch lastReadVersion (manual look-back
 *              must not suppress the next real upgrade popup).
 *
 * `onOpenVersion(pending)` is a third entry point — the sidebar UpdateBanner
 * previewing an update that is downloaded but **not installed yet**. It reuses
 * the `auto` layout contract verbatim (pre-loaded blocks, `v旧 → v新` badge,
 * version count, no lazy history, no version jumper) because it carries the
 * same shape of payload: an aggregated diff range. The only difference is which
 * range — auto covers `(lastRead, appVersion]`, preview covers
 * `(appVersion, pending]`, so a user who skipped several releases sees every
 * version the restart will jump over, and a plain one-version bump sees one
 * block.
 *
 * Two things it deliberately does NOT do: attach the installed version or its
 * back-catalogue (that's the flame icon's job — `onOpen`), and advance
 * `lastReadVersion` on dismiss (that would swallow the real popup after the
 * restart). The read-marker, not `mode`, is what governs the latter — see
 * `readMarkerRef`.
 */
export type UpdateNoticeMode = 'auto' | 'manual';

export interface UseUpdateNoticeReturn {
  /** Dialog visibility. */
  open: boolean;
  /** Which UX contract the dialog is currently under. Null when closed. */
  mode: UpdateNoticeMode | null;
  /**
   * Initial notes for the dialog to render immediately.
   *   - auto: the loaded diff range, newest-first.
   *   - manual: `[appVersionNotes]` (single entry) — the rest of history is
   *             loaded lazily via `loadVersion` on scroll.
   * Null when dialog is closed.
   */
  releaseNotes: ReleaseNotes[] | null;
  /**
   * Manual mode only: full history of versions on CDN (`≤ appVersion`),
   * newest-first. The dialog renders one placeholder per entry and hydrates
   * on demand via `loadVersion`. Null in auto mode / when dialog is closed.
   */
  allVersions: string[] | null;
  /**
   * Fetch a single version's notes. Returns null on 404 / parse / network.
   * Backed by main-side + renderer-side caches, so repeated calls for the
   * same version are near-free — the dialog can wire it into
   * IntersectionObserver callbacks without extra bookkeeping.
   */
  loadVersion: (version: string) => Promise<ReleaseNotes | null>;
  /** Close the dialog (writes lastReadVersion in auto mode only). */
  dismiss: () => void;
  /** Manually open the dialog for a lazy full-history review. */
  onOpen: () => void;
  /**
   * Open the dialog as a pre-install preview of `pendingVersion`: that version
   * plus every version between it and the installed one, aggregated in the
   * `auto` layout. Dismissal does not touch `lastReadVersion`.
   *
   * No fallback to a different version: if `pendingVersion`'s own notes can't
   * be fetched we toast and stay closed rather than answering a question the
   * user didn't ask. Callers should gate their entry point on a successful
   * `fetchReleaseNotes` probe so this stays an edge case.
   */
  onOpenVersion: (pendingVersion: string) => void;
}

/**
 * Resolve the diff set of versions to auto-load given user's last-read cursor
 * and the current app version. Auto path only — manual path uses the full
 * `allVersions` array separately.
 *
 * - Fresh install (lastRead === null): only the current version.
 * - Same version (lastRead === appVersion): nothing (caller returns early).
 * - Upgrade: every index entry strictly greater than lastRead and less than
 *   or equal to appVersion, with tolerant fallbacks for edge conditions
 *   (lastRead older than earliest index entry, appVersion not yet in index,
 *   user downgraded).
 */
function versionsToFetch(
  index: string[] | null,
  lastRead: string | null,
  appVersion: string,
): string[] {
  if (lastRead === null || !index) return [appVersion];
  const curIdx = index.indexOf(appVersion);
  if (curIdx === -1) return [appVersion];
  const lastIdx = index.indexOf(lastRead);
  if (lastIdx === -1) {
    const insertIdx = index.findIndex((v) => cmpVersion(v, lastRead) > 0);
    if (insertIdx === -1 || insertIdx > curIdx) return [appVersion];
    return index.slice(insertIdx, curIdx + 1);
  }
  if (curIdx <= lastIdx) return [appVersion];
  return index.slice(lastIdx + 1, curIdx + 1);
}

/**
 * Build the pre-install preview range for `onOpenVersion`: every version the
 * user is about to jump over, i.e. index entries in `(appVersion, pending]`,
 * ascending, plus `pending` itself.
 *
 * Deliberately excludes `appVersion` and everything older — the question is
 * "what do I get by restarting", not "what has ever shipped". Skipping several
 * releases therefore yields several blocks; a normal one-version bump yields
 * exactly one.
 *
 * - Index unreachable → just `[pending]`; the dialog still opens with the one
 *   block that matters.
 * - `pending` not in the index yet (CDN publishes the notice and the index
 *   separately, so there is a window) → appended anyway. It is the version the
 *   caller already probed successfully.
 * - Capped to the newest `MAX_AGGREGATED_VERSIONS` for the same reason auto
 *   mode is: nobody reads 30 blocks, and each one is a CDN round-trip.
 */
function versionsToPreview(
  index: string[] | null,
  appVersion: string,
  pending: string,
): string[] {
  const inRange = (index ?? []).filter(
    (v) => cmpVersion(v, appVersion) > 0 && cmpVersion(v, pending) <= 0,
  );
  if (!inRange.includes(pending)) inRange.push(pending);
  return inRange.slice(-MAX_AGGREGATED_VERSIONS);
}

/**
 * Build the manual-mode full-history list: everything in the CDN index up to
 * (and including) appVersion, reversed to newest-first for UI convenience.
 * Returns just `[appVersion]` when index isn't reachable — the dialog still
 * opens with a single block, matching the pre-lazy behaviour.
 */
function versionsForManual(index: string[] | null, appVersion: string): string[] {
  if (!index) return [appVersion];
  const curIdx = index.indexOf(appVersion);
  if (curIdx !== -1) return index.slice(0, curIdx + 1).reverse();
  // appVersion 尚未进入 CDN index（刚发布版本存在短暂延迟）：
  // 仍然列出 index 中所有 <= appVersion 的历史版本，并把当前版本插到最前面，
  // 避免手动查看历史路径在版本刚发布时退化成单一条目。
  const olderVersions = index
    .filter((v) => cmpVersion(v, appVersion) <= 0)
    .reverse();
  return [appVersion, ...olderVersions];
}

export function useUpdateNotice(): UseUpdateNoticeReturn {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<UpdateNoticeMode | null>(null);
  const [releaseNotes, setReleaseNotes] = useState<ReleaseNotes[] | null>(null);
  const [allVersions, setAllVersions] = useState<string[] | null>(null);
  /**
   * Version to write to `lastReadVersion` on dismiss. See extended comment on
   * the previous implementation for gap-safe logic. Manual look-back sets
   * this to null so dismiss doesn't touch lastReadVersion.
   */
  const readMarkerRef = useRef<string | null>(null);
  // Set synchronously (before any await) in onOpen so the auto-fetch path
  // can bail out if manual dialog was opened while the fetch was in flight.
  const dialogOpenedRef = useRef(false);
  // Stored handle for the dismiss cleanup timer so onOpen can cancel it if
  // the user re-opens the dialog before the 200ms animation delay fires.
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const appVersion = window.electronAPI.appVersion;
    let lastRead: string | null = null;
    try {
      lastRead = localStorage.getItem(STORAGE_KEY);
    } catch {
      // localStorage not available — fall through to the fetch path so the
      // user still sees the dialog; we just won't be able to mark it read.
    }

    // Already saw this exact version → nothing to do.
    if (lastRead === appVersion) return;

    let cancelled = false;

    (async () => {
      // Fresh install: skip the index round-trip and show only the current
      // version's notes. We don't want to blast a new user with 30 versions
      // of history on first launch.
      const index = lastRead === null ? null : await fetchReleaseNotesIndex();
      if (cancelled) return;

      const targets = versionsToFetch(index, lastRead, appVersion).slice(
        -MAX_AGGREGATED_VERSIONS,
      );
      const results = await Promise.all(targets.map((v) => fetchReleaseNotes(v)));
      if (cancelled) return;
      const notes = results.filter((n): n is ReleaseNotes => n !== null);

      if (notes.length === 0) return;
      if (!notes.some((n) => n.version === appVersion)) return;

      // Bail BEFORE computing readMarkerRef: if manual was opened while we
      // fetched, don't write the marker (which would cause onOpen's
      // readMarkerRef !== null guard to incorrectly abort the manual dialog).
      if (dialogOpenedRef.current) return;

      // Compute the safe read-marker (unchanged from prior impl).
      const isCurIdxMissing = index !== null && index.indexOf(appVersion) === -1;
      const firstFailIdx = results.findIndex((n) => n === null);
      if (isCurIdxMissing) {
        readMarkerRef.current = lastRead ?? null;
      } else if (firstFailIdx === -1) {
        readMarkerRef.current = appVersion;
      } else if (firstFailIdx === 0) {
        const skipKey = `xdt-maker:notice-skip-tried-${targets[0]}`;
        if (localStorage.getItem(skipKey) === null) {
          localStorage.setItem(skipKey, '1');
          readMarkerRef.current = lastRead ?? null;
        } else {
          readMarkerRef.current = targets[0];
        }
      } else {
        readMarkerRef.current = targets[firstFailIdx - 1];
      }

      notes.reverse();
      setMode('auto');
      setReleaseNotes(notes);
      setOpen(true);
    })().catch((err) => {
      log.warn('auto-fetch threw:', err);
    });

    return () => { cancelled = true; };
  }, []);

  const dismiss = useCallback(() => {
    dialogOpenedRef.current = false;
    setOpen(false);
    const marker = readMarkerRef.current;
    if (marker !== null) {
      try { localStorage.setItem(STORAGE_KEY, marker); } catch { /* noop */ }
    }
    readMarkerRef.current = null;
    // Delay clearing state so the exit animation can play before unmount.
    // Store the handle so onOpen() can cancel it if the dialog is re-opened
    // within the 200ms window (cached fetches can resolve in ~10ms, which
    // would race with the pending cleanup and blank the dialog).
    dismissTimerRef.current = setTimeout(() => {
      setReleaseNotes(null);
      setAllVersions(null);
      setMode(null);
    }, 200);
  }, []);

  const onOpen = useCallback(() => {
    if (open) return;
    // Cancel any pending dismiss cleanup so a fast re-open doesn't wipe the
    // state that the new open just wrote.
    if (dismissTimerRef.current !== null) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    // Set synchronously so the auto-fetch path can see it immediately even
    // before this async IIFE has called setOpen/setMode.
    dialogOpenedRef.current = true;
    const appVersion = window.electronAPI.appVersion;

    (async () => {
      // Fetch index + appVersion's notes in parallel. The index is what the
      // dialog uses to render placeholders for every history entry; the
      // appVersion notes are what the top block shows immediately so the
      // dialog isn't blank-until-lazy-load on open.
      const [index, appNotes] = await Promise.all([
        fetchReleaseNotesIndex(),
        fetchReleaseNotes(appVersion),
      ]);
      // The dialog needs at least one loaded note as its initial seed.
      // If appVersion's JSON is temporarily unavailable (CDN lag / 404), try
      // the most-recent historical version from the index as fallback seed so
      // users can still browse full history.  Only bail when the index is also
      // unavailable or every candidate fetch fails.
      let seed = appNotes;
      if (!seed && index && index.length > 0) {
        // Try each historical version in order (newest first) until one loads,
        // so a single bad/lagging CDN file doesn't block the entire history view.
        for (const fallbackVersion of versionsForManual(index, appVersion)) {
          if (fallbackVersion === appVersion) continue;
          const fallback = (await fetchReleaseNotes(fallbackVersion)) ?? null;
          if (fallback) {
            seed = fallback;
            break;
          }
        }
      }
      if (!seed) {
        dialogOpenedRef.current = false;
        toast.error(t('logic.toasts.fetchUpdateNoticeFailed'));
        return;
      }

      // Guard against a race with auto-fetch: if the auto path already opened
      // the dialog with a valid marker, the manual overlay would either fight
      // for the same setOpen slot or worse, wipe the auto marker on dismiss.
      // The `open` check at the top of onOpen already covers the "already
      // open" case; this covers the sub-1s window where marker was set but
      // setOpen hasn't rendered yet.
      if (readMarkerRef.current !== null) return;

      setMode('manual');
      setReleaseNotes([seed]);
      setAllVersions(versionsForManual(index, appVersion));
      readMarkerRef.current = null;
      setOpen(true);
    })().catch((err) => {
      dialogOpenedRef.current = false;
      log.warn('manual-fetch threw:', err);
      toast.error(t('logic.toasts.fetchUpdateNoticeFailed'));
    });
  }, [t, open]);

  const onOpenVersion = useCallback((pendingVersion: string) => {
    // `open` is state, so two clicks in the same tick both read `false` and both
    // fan out to the CDN. `dialogOpenedRef` is set synchronously below and stays
    // true until dismiss (or a failed attempt), so it is the re-entrancy guard
    // that actually holds for a double-clicked text link.
    if (open || dialogOpenedRef.current) return;
    if (dismissTimerRef.current !== null) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    dialogOpenedRef.current = true;
    const appVersion = window.electronAPI.appVersion;

    (async () => {
      // Kick off the pending version's notes immediately — it is the one block
      // that must be there, and the banner's probe usually leaves it cached, so
      // this resolves ~instantly and overlaps whatever the index costs.
      const pendingNotes = fetchReleaseNotes(pendingVersion);
      // The index only adds the *in-between* blocks. Waiting out the full CDN
      // timeout (15s, releaseNotesService) for them would make the link look
      // dead, so give it a budget and degrade to the pending version alone —
      // the same degradation `versionsToPreview` already does for a null index.
      const index = await Promise.race([
        fetchReleaseNotesIndex(),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), PREVIEW_INDEX_BUDGET_MS);
        }),
      ]);
      const targets = versionsToPreview(index, appVersion, pendingVersion);
      const results = await Promise.all(
        targets.map((v) => (v === pendingVersion ? pendingNotes : fetchReleaseNotes(v))),
      );
      const notes = results.filter((n): n is ReleaseNotes => n !== null);

      // The pending version's own notes are the point of this dialog — if only
      // the in-between ones loaded, we'd be answering a question the user
      // didn't ask. Bail (the banner's probe makes this a rare CDN race).
      if (!notes.some((n) => n.version === pendingVersion)) {
        dialogOpenedRef.current = false;
        toast.error(t('logic.toasts.fetchUpdateNoticeFailed'));
        return;
      }

      // Same race guard as onOpen: never clobber an auto popup that has already
      // claimed the dialog with a real read-marker.
      if (readMarkerRef.current !== null) return;

      notes.reverse();
      setMode('auto');
      setReleaseNotes(notes);
      setAllVersions(null);
      // Stays null: dismissing a pre-install preview must NOT advance
      // lastReadVersion, or the real popup after the restart never fires.
      readMarkerRef.current = null;
      setOpen(true);
    })().catch((err) => {
      dialogOpenedRef.current = false;
      log.warn('preview-fetch threw:', err);
      toast.error(t('logic.toasts.fetchUpdateNoticeFailed'));
    });
  }, [t, open]);

  const loadVersion = useCallback(
    (version: string) => fetchReleaseNotes(version),
    [],
  );

  return {
    open,
    mode,
    releaseNotes,
    allVersions,
    loadVersion,
    dismiss,
    onOpen,
    onOpenVersion,
  };
}
