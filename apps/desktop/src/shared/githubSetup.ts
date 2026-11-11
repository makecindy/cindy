/** No credentials, process output or local paths cross this boundary. */
export type GithubConnectionState =
  | { status: 'connected'; login: string; source: 'gh-cli' | 'token' }
  | { status: 'missing' | 'auth' | 'network' | 'forbidden'; source?: 'gh-cli' | 'token' };

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
  userCode?: string;
  verificationUrl?: 'https://github.com/login/device';
  error?: 'unsupported' | 'install' | 'login' | 'timeout';
}
