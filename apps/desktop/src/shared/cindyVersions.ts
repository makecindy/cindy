/** Public projection: executable paths and launch capabilities never cross into Renderer. */
export interface CindyVersionInfo {
  id: string;
  kind: 'original' | 'personal';
  development?: boolean;
  version?: string;
  dirty?: boolean;
  title?: string;
  builtAt?: string;
  commit?: string;
  available: boolean;
  compatible: boolean;
}

export interface CindyVersionsState {
  currentId: string;
  selectedId: string;
  switching: boolean;
  versions: CindyVersionInfo[];
  /** Running binary metadata may lag the single personal slot until the user restarts. */
  currentVersion?: CindyVersionInfo;
  personalUpdateAvailable?: boolean;
}

export type CindyVersionAction = 'switch' | 'remove';
export const CINDY_ORIGINAL_VERSION = 'original';
export const CINDY_PERSONAL_VERSION = 'personal';
export const CINDY_VERSION_PROTOCOL = 1;
