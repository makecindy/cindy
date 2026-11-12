import type { IpcMainInvokeEvent } from 'electron';
import type { InstalledGhost } from '../../shared/ghost';
import {
  GHOST_COMPOSER_LIST_CHANNEL,
  projectGhostComposerEntries,
  type GhostComposerEntry,
} from '../../shared/ghostComposer';
import { getDeviceLinkInvokeContext } from '../device-link/invoke-context';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer';
import { throwIpcError } from '../utils/ipcValidate';

// Leave room for the invoke envelope below the transport's 4 MiB message limit.
export const MAX_REMOTE_COMPOSER_CATALOG_BYTES = 1024 * 1024;

function boundRemoteCatalog(entries: GhostComposerEntry[]): GhostComposerEntry[] {
  const result = entries.map<GhostComposerEntry>(
    ({ manifest: { tools: _tools, ...manifest }, iconDataUrl: _icon, ...entry }) => ({
      ...entry,
      manifest,
    }),
  );
  let bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (bytes > MAX_REMOTE_COMPOSER_CATALOG_BYTES) {
    throwIpcError('PRECONDITION_FAILED', 'Plugin catalog metadata exceeds the response size limit');
  }

  // Keep every menu entry. Optional schemas and icons fall back to discovery and
  // the generic icon when they do not fit; never truncate a tool declaration.
  for (const field of ['tools', 'iconDataUrl'] as const) {
    entries.forEach((entry, index) => {
      const value = field === 'tools' ? entry.manifest.tools : entry.iconDataUrl;
      if (value === undefined) return;
      // Both destination objects already have fields, so account for the comma
      // plus the JSON-escaped key/value, measured in UTF-8 bytes.
      const addedBytes = Buffer.byteLength(JSON.stringify({ [field]: value }), 'utf8') - 1;
      if (bytes + addedBytes > MAX_REMOTE_COMPOSER_CATALOG_BYTES) return;
      if (field === 'tools') result[index].manifest.tools = entry.manifest.tools;
      else result[index].iconDataUrl = entry.iconDataUrl;
      bytes += addedBytes;
    });
  }
  return result;
}

/** Read-only projection for same-account controllers and trusted local UI. */
export function createGhostComposerListHandler(deps: {
  list: () => InstalledGhost[];
  disabledIds: (workingDir: string) => string[];
}) {
  return (event: IpcMainInvokeEvent, workingDir?: unknown) => {
    const context = getDeviceLinkInvokeContext();
    if (context) {
      if (context.channel !== GHOST_COMPOSER_LIST_CHANNEL || context.sharedTask) {
        throwIpcError('PERMISSION_DENIED', 'Plugin catalog requires a same-account controller');
      }
    } else {
      assertTrustedAppRendererEvent(event);
    }
    if (
      workingDir !== undefined &&
      (typeof workingDir !== 'string' || workingDir.length > 32_768 || workingDir.includes('\0'))
    ) {
      throwIpcError('INVALID_PARAMS', 'Invalid working directory');
    }
    const entries = projectGhostComposerEntries(
      deps.list(),
      typeof workingDir === 'string' && workingDir.trim() ? deps.disabledIds(workingDir) : [],
    );
    return context ? boundRemoteCatalog(entries) : entries;
  };
}
