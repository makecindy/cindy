/**
 * The one progress shape every user-visible download/install surface shows.
 *
 * Main builds it with `createDownloadProgressReporter` (main/downloader/progressReporter.ts)
 * from the shared downloader's raw callbacks; the Renderer draws it with the standard
 * `DownloadProgress` component (renderer/components/ui/download-progress.tsx). Phases match
 * the plugin-facing `download-progress` event (shared/ghost.ts) plus host-only install steps.
 * Rules: docs/dev-rules/verified-downloads.md 「下载进度与界面」.
 *
 * Local IPC only. It is not part of any device-link or plugin wire contract.
 */

export const DOWNLOAD_PROGRESS_PHASES = [
  /** Work before bytes move: resolving a release, checking an existing install. */
  'preparing',
  /** Waiting for a download slot behind another transfer. */
  'queued',
  'downloading',
  /** Between attempts; see `retryReason` / `attempt`. */
  'retrying',
  /** All bytes arrived; checking size and SHA-256. */
  'verifying',
  /** Unpacking, version checks or registration after a verified download. */
  'installing',
  /** Stopped by the user with resumable data kept. */
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;

export type DownloadProgressPhase = (typeof DOWNLOAD_PROGRESS_PHASES)[number];

/** Why the downloader is about to try again; drives the explanation shown while retrying. */
export type DownloadRetryReason = 'slow' | 'network' | 'timeout' | 'server';

export interface DownloadProgress {
  phase: DownloadProgressPhase;
  /** Bytes on disk for this download. Never decreases while one download is shown. */
  loaded: number;
  /** Expected size; null when the server does not say. */
  total: number | null;
  /** Display percent 0–100, never decreasing within one download; null when unknown. */
  percent: number | null;
  /** Recent throughput in bytes per second; 0 when not measured or not transferring. */
  speedBps: number;
  /** Estimated seconds left at the current speed; null when it cannot be estimated. */
  etaSeconds: number | null;
  /** The attempt in progress (or about to start while retrying); omitted on the first. */
  attempt?: number;
  retryReason?: DownloadRetryReason;
}

export function initialDownloadProgress(
  phase: DownloadProgressPhase = 'preparing',
  total: number | null = null,
): DownloadProgress {
  return { phase, loaded: 0, total, percent: total ? 0 : null, speedBps: 0, etaSeconds: null };
}

/** Phases in which the transfer or its follow-up work is still running. */
export function isDownloadProgressActive(phase: DownloadProgressPhase): boolean {
  return !['paused', 'completed', 'failed', 'cancelled'].includes(phase);
}
