import type { SkillhubCatalogScope } from './skillhubCatalog';

/** Paths, registry internals and credentials never cross this projection. */
export interface RemoteSkillItem {
  id: string;
  revision: string;
  name: string;
  description: string;
  kind: 'skill' | 'command' | 'agent';
  scope: 'global' | 'project';
  project?: string;
  projectId?: string;
  /** Basename only; the Host retains the absolute entry path. */
  entryFile?: string;
  engines: string[];
  enabled: boolean;
  managedByPlugin: boolean;
  builtIn: boolean;
  canUninstall: boolean;
  version?: string;
  market?: {
    name: string;
    catalogScope?: SkillhubCatalogScope;
    origin?: 'installed' | 'published' | 'learned' | 'imported';
    authorId?: string;
  };
}
export interface RemoteSkillMarketItem {
  name: string;
  displayName: string;
  description: string;
  version: string;
  catalogScope: SkillhubCatalogScope;
}
export function isRemoteSkillMarketItem(value: unknown): value is RemoteSkillMarketItem {
  const item = value as RemoteSkillMarketItem | null;
  return (
    !!item &&
    typeof item.name === 'string' &&
    item.name.length <= 128 &&
    typeof item.displayName === 'string' &&
    item.displayName.length <= 256 &&
    typeof item.description === 'string' &&
    typeof item.version === 'string' &&
    item.version.length <= 128 &&
    ['market', 'team'].includes(item.catalogScope)
  );
}
export interface RemoteSkillsSnapshot {
  version: 1;
  items: RemoteSkillItem[];
  market: RemoteSkillMarketItem[];
  nextCursor: string | null;
  marketUnavailable: boolean;
  /** Absent on older Hosts. IDs authorize a choice, never a caller-supplied path. */
  projects?: RemoteSkillProject[];
}
export interface RemoteSkillProject {
  id: string;
  revision: string;
  name: string;
}
export type RemoteSkillMutation = 'enable' | 'disable' | 'install' | 'update' | 'uninstall';
export interface RemoteSkillReceipt {
  operationId: string;
  phase: 'confirmation' | 'running' | 'succeeded' | 'cancelled' | 'failed';
  confirmation?: {
    requestId: string;
    kind: RemoteSkillMutation;
    name: string;
    version?: string;
    linkOnly?: boolean;
  };
}

export function parseRemoteSkillReceipt(value: unknown, operationId: string): RemoteSkillReceipt {
  const receipt = value as RemoteSkillReceipt | null;
  const confirmation = receipt?.confirmation;
  if (
    !receipt ||
    receipt.operationId !== operationId ||
    !['confirmation', 'running', 'succeeded', 'cancelled', 'failed'].includes(receipt.phase) ||
    (receipt.phase === 'confirmation' &&
      (!confirmation ||
        typeof confirmation.requestId !== 'string' ||
        confirmation.requestId.length > 64 ||
        typeof confirmation.name !== 'string' ||
        confirmation.name.length > 256 ||
        !['install', 'update', 'uninstall'].includes(confirmation.kind) ||
        (confirmation.version !== undefined &&
          (typeof confirmation.version !== 'string' || confirmation.version.length > 128))))
  )
    throw new Error('INVALID_RESPONSE');
  return receipt;
}
