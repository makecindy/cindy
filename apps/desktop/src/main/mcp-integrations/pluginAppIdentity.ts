import { createHash } from 'node:crypto';
import type { InstalledGhost } from '../../shared/ghost.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';
export function pluginAppServerId(ghost: InstalledGhost): string {
  return `plugin-ui_${createHash('sha256').update(installedGhostStoragePart(ghost)).digest('hex')}`;
}
