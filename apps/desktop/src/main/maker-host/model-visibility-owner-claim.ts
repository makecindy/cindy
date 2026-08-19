import { app, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  dataOwnerStorageKey,
  getActiveAppSession,
  getActiveDataOwnerPushStamp,
  isAppSessionBoundaryPending,
} from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { hasExclusiveSharedLegacyUserDataAccess } from '../ownerNamespaceMigration.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { readBoundedFileNoFollowSync } from '../utils/readBoundedFile.js';
import { MAKER_INVOKE } from '../maker-ipc/channels.js';
import type { ModelVisibilityLegacyOwnerClaim } from '../../shared/modelVisibility.js';

const MARKER_FILE = 'model-visibility-renderer-legacy-owner.v1.json';
const MAX_MARKER_BYTES = 1_024;

interface OwnerMarker {
  version: 1;
  ownerKey: string;
}

type OwnerMarkerRead =
  | { kind: 'valid'; marker: OwnerMarker }
  | { kind: 'missing' }
  | { kind: 'blocked' };

const log = createLogger('modelVisibilityOwnerClaim');

function readOwnerMarker(markerPath: string): OwnerMarkerRead {
  try {
    const bytes = readBoundedFileNoFollowSync(markerPath, MAX_MARKER_BYTES);
    if (bytes === null) return { kind: 'blocked' };
    const parsed: unknown = JSON.parse(bytes.toString('utf-8'));
    if (
      !parsed
      || typeof parsed !== 'object'
      || Array.isArray(parsed)
      || (parsed as { version?: unknown }).version !== 1
      || typeof (parsed as { ownerKey?: unknown }).ownerKey !== 'string'
    ) {
      return { kind: 'blocked' };
    }
    return { kind: 'valid', marker: parsed as OwnerMarker };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'blocked' };
  }
}

/**
 * Atomically binds the pre-account Renderer preference key to the stable local/cloud owner active
 * during this upgrade. The marker is model-visibility-specific: older general migrations may have
 * been claimed by a historical account and therefore cannot establish who owns this localStorage.
 */
export function claimLegacyModelVisibilityOwner(): ModelVisibilityLegacyOwnerClaim {
  const stamp = getActiveDataOwnerPushStamp();
  const session = getActiveAppSession();
  if (
    session.mode === 'signed-out'
    || !stamp.dataOwnerId
    || session.dataOwnerId !== stamp.dataOwnerId
    || isAppSessionBoundaryPending()
  ) {
    return {
      ...stamp,
      canWriteOwnerScoped: false,
      claimed: false,
      claimedByOtherOwner: false,
      canInitialize: false,
    };
  }

  const ownerKey = dataOwnerStorageKey(stamp.dataOwnerId);
  const markerPath = path.join(app.getPath('userData'), MARKER_FILE);
  const exclusiveAtStart = hasExclusiveSharedLegacyUserDataAccess();
  let state = readOwnerMarker(markerPath);
  if (state.kind === 'missing' && exclusiveAtStart) {
    const temporaryPath = `${markerPath}.init-${process.pid}-${randomUUID()}`;
    try {
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(
        temporaryPath,
        JSON.stringify({ version: 1, ownerKey } satisfies OwnerMarker),
        { encoding: 'utf-8', flag: 'wx', mode: 0o600 },
      );
      fs.linkSync(temporaryPath, markerPath);
      log.info('legacy Renderer model visibility owner claimed', { ownerKey });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        log.warn('failed to claim legacy Renderer model visibility owner', {
          ownerKey,
          errorCode: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN',
        });
      }
    } finally {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The temporary marker is never authoritative until its hard link exists.
      }
    }
    state = readOwnerMarker(markerPath);
  }

  const claimed = state.kind === 'valid' && state.marker.ownerKey === ownerKey;
  return {
    ...stamp,
    canWriteOwnerScoped: true,
    claimed,
    claimedByOtherOwner: state.kind === 'valid' && !claimed,
    canInitialize:
      claimed && exclusiveAtStart && hasExclusiveSharedLegacyUserDataAccess(),
  };
}

/** Register before the first BrowserWindow: preload uses a synchronous claim read during auth boot. */
export function registerModelVisibilityOwnerClaimIpc(): void {
  ipcMain.on(MAKER_INVOKE.MODEL_VISIBILITY_LEGACY_OWNER_CLAIM_SYNC, (event) => {
    assertTrustedAppRendererEvent(event);
    event.returnValue = claimLegacyModelVisibilityOwner();
  });
}
