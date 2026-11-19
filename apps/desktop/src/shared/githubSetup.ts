import type { DownloadProgress } from './downloadProgress';

/** No credentials, process output or local paths cross this boundary. */
export type GithubConnectionState =
  | { status: 'connected'; login: string; source: 'gh-cli' | 'token' | 'github-app' }
  | { status: 'missing' | 'auth' | 'network' | 'forbidden'; source?: 'gh-cli' | 'token' | 'github-app' };

export interface GithubSetupState {
  phase:
    | 'idle'
    | 'checking'
    | 'downloading'
    | 'installing'
    | 'authorizing'
    | 'connected'
    | 'error'
    | 'cancelled';
  percent?: number;
  /** Standard progress while downloading/installing gh; drawn by the shared DownloadMeter. */
  download?: DownloadProgress;
  userCode?: string;
  verificationUrl?: 'https://github.com/login/device';
  error?: 'unsupported' | 'install' | 'login' | 'timeout' | 'network';
}

/** Public connection state only; OAuth credentials remain in main, never renderer. */
export interface GithubAppConnectionState {
  available: boolean;
  userAuthorization?: boolean;
  login?: string | null;
  repositories?: string[];
  unavailable?: string[];
}
