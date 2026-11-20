import type { ProgressEvent } from '../downloader/index.js';
import type { DownloadProgress } from '../../shared/downloadProgress.js';

/** Publisher metadata supplied by trusted host code, never by Renderer. */
export interface ToolArtifact {
  id: string;
  version: string;
  host: string;
  url: string;
  sha256: string;
  format: 'binary' | 'zip' | 'tar.gz';
  /** POSIX path relative to the publisher archive root. */
  executable: string;
}
export interface ToolInstallProgress {
  status: 'downloading' | 'installing';
  /** Kept for stored Cindy Make reports; new UI reads `download`. */
  progress?: Pick<ProgressEvent, 'loaded' | 'total' | 'percent'>;
  /** Standard progress for the shared DownloadMeter (retries, verifying, speed, time left). */
  download: DownloadProgress;
}
