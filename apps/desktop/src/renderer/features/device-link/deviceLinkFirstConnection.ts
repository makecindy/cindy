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
import { useSyncExternalStore } from 'react';
import { useDeviceLinkDeviceListRequestState } from './useDeviceLinkDeviceList';

/**
 * One full relay connect attempt: token request (15 s) plus handshake (15 s), the device-link
 * client's DEFAULT_TIMING. Twice the 15 s chat grace in RemoteBotSessionView.
 */
export const FIRST_CONNECTION_WINDOW_MS = 30_000;

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
  windowTimer = setTimeout(() => {
    // An earlier window's timer never closes a newer one.
    if (token !== windowToken) return;
    windowTimer = null;
    windowOpen = false;
    notify();
  }, Math.max(0, durationMs));
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
 * online yet or the device directory has not settled. Unreachable is then "connecting".
 */
export function useDeviceLinkFirstConnectionPending(): boolean {
  const open = useSyncExternalStore(subscribe, () => windowOpen);
  const status = useSyncExternalStore(subscribe, () => linkStatus);
  const directory = useDeviceLinkDeviceListRequestState();
  return open && (status !== 'online' || directory.status !== 'ready');
}
