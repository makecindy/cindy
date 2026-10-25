import path from 'node:path';
import {normalizeProjectKey,projectKeyComparisonKey} from '@cindy/maker-shared/project-keys';
import {normalizeSidebarPinnedOrder,SIDEBAR_HIDDEN_MAIN_VIEW_MAX_ENTRIES,isSidebarGhostId} from '@cindy/plugin-runtime/shared/sidebarSettings';
import {createOverrideSettingsFile} from './overrideSettingsFile.js';
import type {Logger} from '@cindy/maker-core';
export interface SidebarSettingsShape {
  pinnedOrder: string[];
  hiddenProjectKeys: string[];
  hiddenMainViewGhostIds: string[];
}

const DEFAULTS: SidebarSettingsShape = {
  pinnedOrder: [],
  hiddenProjectKeys: [],
  hiddenMainViewGhostIds: [],
};
const MAX_HIDDEN_PROJECT_ENTRIES = 10_000;
const MAX_PROJECT_KEY_LENGTH = 4_096;
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;
const SETTINGS_FILE_NAME = 'sidebar-settings.json';
function normalizeHiddenProjectKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of raw) {
    const projectKey = normalizeProjectKey(entry);
    const comparisonKey = projectKeyComparisonKey(projectKey, process.platform);
    if (
      projectKey == null ||
      projectKey.length > MAX_PROJECT_KEY_LENGTH ||
      comparisonKey == null ||
      seen.has(comparisonKey)
    ) {
      continue;
    }
    seen.add(comparisonKey);
    normalized.push(projectKey);
    if (normalized.length >= MAX_HIDDEN_PROJECT_ENTRIES) break;
  }
  return normalized;
}

function normalizeHiddenMainViewGhostIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of raw) {
    if (!isSidebarGhostId(entry) || seen.has(entry)) continue;
    seen.add(entry);
    normalized.push(entry);
    if (normalized.length >= SIDEBAR_HIDDEN_MAIN_VIEW_MAX_ENTRIES) break;
  }
  return normalized;
}

function normalizeSettings(raw: unknown): SidebarSettingsShape {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    pinnedOrder: normalizeSidebarPinnedOrder(value.pinnedOrder),
    hiddenProjectKeys: normalizeHiddenProjectKeys(value.hiddenProjectKeys),
    hiddenMainViewGhostIds: normalizeHiddenMainViewGhostIds(value.hiddenMainViewGhostIds),
  };
}


export {normalizeSettings,normalizeHiddenProjectKeys,normalizeHiddenMainViewGhostIds,MAX_HIDDEN_PROJECT_ENTRIES,MAX_SETTINGS_BYTES,SETTINGS_FILE_NAME,MAX_PROJECT_KEY_LENGTH};
export function createSidebarSettingsDocument(host:{ownerRoot:string;activeOwnerScopeKey():string;log:Pick<Logger,'info'|'warn'>}) {
 return createOverrideSettingsFile<SidebarSettingsShape>({
  filePath:()=>path.join(host.ownerRoot,SETTINGS_FILE_NAME),defaults:DEFAULTS,normalize:normalizeSettings,
  log:host.log,label:'sidebar',scopeKey:host.activeOwnerScopeKey,maxBytes:MAX_SETTINGS_BYTES,
  preserveUnreadableFile:true,logLoadedValue:false,logReadErrorDetails:false,
 });
}
