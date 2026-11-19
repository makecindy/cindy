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
  error?: 'unsupported' | 'install' | 'login' | 'timeout';
}

/** Public connection state only; OAuth credentials remain in main, never renderer. */
export interface GithubAppConnectionState {
  available: boolean;
  userAuthorization?: boolean;
  login?: string | null;
  repositories?: string[];
  unavailable?: string[];
}

export interface GithubInstallationAccess {
  id: number;
  owner: string;
  app: string;
  selection: 'all' | 'selected';
  /** Number visible to the signed-in user. A failed count preserves the scope. */
  visibleRepositories: number | null;
  suspended: boolean;
  permissions: Record<string, string>;
}

export type GithubAppAccess =
  | { status: 'ready'; installations: GithubInstallationAccess[] }
  | { status: 'missing' | 'unavailable' };
