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
