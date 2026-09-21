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
}

export type CindyVersionAction = 'switch' | 'remove';
export const CINDY_ORIGINAL_VERSION = 'original';
export const CINDY_VERSION_PROTOCOL = 1;
