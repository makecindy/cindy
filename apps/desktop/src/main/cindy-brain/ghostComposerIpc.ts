import { createHash } from 'node:crypto';
import type { IpcMainInvokeEvent } from 'electron';
import type { InstalledGhost } from '../../shared/ghost';
import {
  COMPOSER_ICON_REF_RE,
  GHOST_COMPOSER_LIST_CHANNEL,
  MAX_COMPOSER_KNOWN_ICONS,
  projectGhostComposerEntries,
  type GhostComposerEntry,
} from '../../shared/ghostComposer';
import { getDeviceLinkInvokeContext } from '../device-link/invoke-context';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer';
import { throwIpcError } from '../utils/ipcValidate';

// Leave room for the invoke envelope below the transport's 4 MiB message limit.
export const MAX_REMOTE_COMPOSER_CATALOG_BYTES = 1024 * 1024;

/** Content tag of one icon; the controller caches icons by it across reads. */
export function composerIconRef(iconDataUrl: string): string {
  return createHash('sha256').update(iconDataUrl).digest('hex').slice(0, 32);
}

interface RemoteIconOptions {
  /** Icon tags the controller already holds; their icons are omitted. */
  known: ReadonlySet<string>;
}

/**
 * The optional second argument is new: old controllers never send it and keep receiving
 * every icon inline. A malformed value is rejected rather than read as "no icons known".
 */
function parseRemoteIconOptions(value: unknown): RemoteIconOptions | null {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwIpcError('INVALID_PARAMS', 'Invalid plugin catalog options');
  }
  const { iconRefs, knownIcons } = value as Record<string, unknown>;
  if (iconRefs !== 1) throwIpcError('INVALID_PARAMS', 'Invalid plugin catalog options');
  if (knownIcons === undefined) return { known: new Set() };
  if (
    !Array.isArray(knownIcons) ||
    knownIcons.length > MAX_COMPOSER_KNOWN_ICONS ||
    !knownIcons.every((ref) => typeof ref === 'string' && COMPOSER_ICON_REF_RE.test(ref))
  ) {
    throwIpcError('INVALID_PARAMS', 'Invalid plugin catalog options');
  }
  return { known: new Set(knownIcons as string[]) };
}

function boundRemoteCatalog(
  entries: GhostComposerEntry[],
  iconOptions: RemoteIconOptions | null,
): GhostComposerEntry[] {
  const iconRefs = iconOptions
    ? entries.map((entry) => (entry.iconDataUrl ? composerIconRef(entry.iconDataUrl) : undefined))
    : [];
  const result = entries.map<GhostComposerEntry>(
    ({ manifest: { tools: _tools, ...manifest }, iconDataUrl: _icon, ...entry }, index) => ({
      ...entry,
      manifest,
      ...(iconRefs[index] ? { iconRef: iconRefs[index] } : {}),
    }),
  );
  let bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (bytes > MAX_REMOTE_COMPOSER_CATALOG_BYTES) {
    throwIpcError('PRECONDITION_FAILED', 'Plugin catalog metadata exceeds the response size limit');
  }

  // Keep every menu entry. Optional schemas and icons fall back to discovery and
  // the generic icon when they do not fit; never truncate a tool declaration.
  // Icons the controller already holds are not sent again.
  for (const field of ['tools', 'iconDataUrl'] as const) {
    entries.forEach((entry, index) => {
      const value = field === 'tools' ? entry.manifest.tools : entry.iconDataUrl;
      if (value === undefined) return;
      if (field === 'iconDataUrl' && iconOptions?.known.has(iconRefs[index]!)) return;
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
  return (event: IpcMainInvokeEvent, workingDir?: unknown, options?: unknown) => {
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
    const iconOptions = context ? parseRemoteIconOptions(options) : null;
    const entries = projectGhostComposerEntries(
      deps.list(),
      typeof workingDir === 'string' && workingDir.trim() ? deps.disabledIds(workingDir) : [],
    );
    return context ? boundRemoteCatalog(entries, iconOptions) : entries;
  };
}
