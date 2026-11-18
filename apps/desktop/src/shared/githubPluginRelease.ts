import type { DownloadProgress } from './downloadProgress.js';

export interface GithubPluginRelease {
  version: string;
  assetId: number;
  sha256: string;
  size: number;
  prerelease: boolean;
}

export type GithubPluginReleaseCheck =
  | { status: 'available' | 'current'; release: GithubPluginRelease }
  | { status: 'empty' | 'sign-in' | 'forbidden' | 'unavailable' };

export type GithubPluginReleaseResult = GithubPluginReleaseCheck | { status: 'updated'; version: string };

export const GITHUB_PLUGIN_RELEASE_PROGRESS_CHANNEL = 'ghosts:github-release:progress';
export interface GithubPluginReleaseProgress {
  instanceId: string;
  progress: DownloadProgress;
}

export type GithubPluginReleaseInstallResult =
  | { status: 'installed'; instanceId: string; version: string }
  | { status: 'invalid' | 'empty' | 'ambiguous' | 'sign-in' | 'forbidden' | 'not-found' | 'unavailable' };
