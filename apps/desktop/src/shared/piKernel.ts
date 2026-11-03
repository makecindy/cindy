/** Device-local Pi runtime management. No paths or download URLs cross IPC. */
export type PiKernelSource = 'official' | 'upstream';
export type PiKernelPhase = 'lookup' | 'download' | 'verify' | 'activate';
export interface PiKernelRelease {
  version: string;
  size?: number;
  publishedAt?: string;
  releaseUrl?: string;
}
export interface PiKernelCheck {
  release: PiKernelRelease | null;
  checkedAt: number | null;
  error: boolean;
}
export interface PiKernelState {
  currentVersion: string | null;
  restartRequired: boolean;
  official: PiKernelCheck;
  upstream: PiKernelCheck;
  operation: { source: PiKernelSource; phase: PiKernelPhase } | null;
}
export interface PiKernelInstallRequest {
  source: PiKernelSource;
  /** The exact version shown when the user chose to install. */
  version: string;
}
