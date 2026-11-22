/**
 * The first-connection window after launch or after the relay drops (e.g. waking from sleep).
 *
 * Before the relay first comes online, "not connected yet" says nothing about another computer:
 * the relay reports `stopped` until its client exists, and the device directory may still be a
 * stale or partial read. Inside this window such a state is "connecting", never "offline"
 * (docs/product-rules/cloud-companions.md §3.1). The window always ends; afterwards an
 * unreachable computer reads as offline exactly as before.
 *
 * App-lifetime singleton (same shape as useDeviceLinkDeviceList): one status listener per window.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useDeviceLinkDeviceListAuthoritative, useDeviceLinkDeviceListRequestState } from './useDeviceLinkDeviceList';

/**
 * One full relay connect attempt: token request (15 s) plus handshake (15 s), the device-link
 * client's DEFAULT_TIMING. Twice the 15 s chat grace in RemoteBotSessionView.
 */
export const FIRST_CONNECTION_WINDOW_MS = 30_000;
/**
 * A window timer this late (wall clock) means the computer slept through part of it: the window
 * opened at suspend (the client goes `connecting` before sleep, and waking sends no new status),
 * so even a one-minute sleep must give the connection after waking its own window. A hidden,
 * throttled window can also fire this late; that only re-opens a window nobody is looking at,
 * and once visible its timer fires on time, so the window still ends within 30 visible seconds.
 */
const SLEPT_THROUGH_MS = 5_000;

type LinkStatus = 'stopped' | 'connecting' | 'online';
let started = false;
let linkStatus: LinkStatus | null = null;
let statusRevision = 0;
let windowOpen = true;
let windowTimer: ReturnType<typeof setTimeout> | null = null;
let windowToken = 0;
const subs = new Set<() => void>();
const notify = () => subs.forEach(fn => fn());

function openWindow(durationMs: number): void {
  if (windowTimer !== null) clearTimeout(windowTimer);
  windowOpen = true;
  const token = ++windowToken;
  const openedAt = Date.now();
  windowTimer = setTimeout(() => {
    // An earlier window's timer never closes a newer one.
    if (token !== windowToken) return;
    windowTimer = null;
    // Slept through it: the connection after waking gets its own window. Each extension
    // needs another late timer, so an awake, visible computer always reaches the end.
    if (linkStatus !== 'online' && Date.now() - openedAt > Math.max(0, durationMs) + SLEPT_THROUGH_MS) {
      openWindow(FIRST_CONNECTION_WINDOW_MS);
      return;
    }
    closeWindow();
  }, Math.max(0, durationMs));
}

function closeWindow(): void {
  if (windowTimer !== null) clearTimeout(windowTimer);
  windowTimer = null;
  windowToken += 1;
  if (!windowOpen) return;
  windowOpen = false;
  notify();
}

// The launch window counts from renderer start (not from whenever a chat first
// asks) and ends even if status is never observed.
openWindow(FIRST_CONNECTION_WINDOW_MS - performance.now());

function setLinkStatus(next: LinkStatus): void {
  const dropped = linkStatus === 'online' && next !== 'online';
  linkStatus = next;
  // Only a drop from online opens a new window; reconnect attempts while still
  // offline never extend it, so a computer that stays unreachable reads as offline.
  if (dropped) openWindow(FIRST_CONNECTION_WINDOW_MS);
  notify();
}

/** Idempotent; called app-wide so a drop is seen before any companion chat opens. */
export function startDeviceLinkFirstConnectionWatch(): void {
  if (started) return;
  const api = typeof window === 'undefined' ? undefined : window.electronAPI?.deviceLink;
  if (!api?.onStatusChanged || !api.getState) return;
  started = true;
  api.onStatusChanged((state) => {
    statusRevision += 1;
    setLinkStatus(state.status);
  });
  const revision = statusRevision;
  void api.getState().then((state) => {
    if (revision === statusRevision) setLinkStatus(state.linkStatus);
  }, () => { /* Unknown status stays "not online" until the window ends. */ });
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  startDeviceLinkFirstConnectionWatch();
  return () => { subs.delete(fn); };
}

/**
 * True while connectivity is still undetermined: inside the window and either the relay is not
 * online yet or the device directory has no complete, fresh read. Unreachable is then "connecting".
 */
export function useDeviceLinkFirstConnectionPending(): boolean {
  const open = useSyncExternalStore(subscribe, () => windowOpen);
  const status = useSyncExternalStore(subscribe, () => linkStatus);
  const directory = useDeviceLinkDeviceListRequestState();
  // Only a complete, fresh read settles early. A stale fallback (e.g. a timed-out read right
  // after waking) shows unverified homes as offline; the window then runs to its end instead.
  const fresh = useDeviceLinkDeviceListAuthoritative();
  const settled = status === 'online' && directory.status === 'ready' && fresh;
  // Settled once: later directory refreshes (another device's presence, a rename) briefly
  // return to `loading` and must not turn a confirmed offline view back into "connecting".
  // Only the next real relay drop opens a new window.
  useEffect(() => { if (open && settled) closeWindow(); }, [open, settled]);
  return open && !settled;
}
