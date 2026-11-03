import {
  createProjectAliasMirror,
  PROJECT_ALIASES_GET_CHANNEL,
  type ProjectAliasesByDevice,
} from '@cindy/maker-shared/project-alias-sync';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import { isRemoteDataOwnerPushCurrent } from '@/lib/remoteDataOwnerPushFence';

const mirror = createProjectAliasMirror();
const EMPTY: ProjectAliasesByDevice = new Map();
let owner: DataOwnerGeneration | null = null;

/** Renderer-only display mirror. Its lifecycle is owned by the existing remote-project synchronizer. */
export const remoteProjectAliases = {
  subscribe: mirror.subscribe,
  getSnapshot: (): ProjectAliasesByDevice =>
    owner && isDataOwnerGenerationCurrent(owner) ? mirror.getSnapshot() : EMPTY,
  clear(): void {
    owner = null;
    mirror.clear();
  },
  remove: mirror.remove,
  suspend: mirror.suspend,
  refresh(deviceId: string, isEligible: () => boolean, invalidate = false): Promise<void> {
    const requestOwner = getDataOwnerGeneration();
    if (!requestOwner.dataOwnerId || !isEligible()) return Promise.resolve();
    if (!owner || !isDataOwnerGenerationCurrent(owner)) {
      mirror.clear();
      owner = requestOwner;
    }
    return mirror[invalidate ? 'invalidate' : 'refresh'](
      deviceId,
      () => window.electronAPI.deviceLink.invoke(deviceId, PROJECT_ALIASES_GET_CHANNEL, []),
      (snapshot) => isEligible()
        && isDataOwnerGenerationCurrent(requestOwner)
        && (snapshot === undefined || (snapshot.ownerStamp !== undefined
          && isRemoteDataOwnerPushCurrent(deviceId, snapshot.ownerStamp))),
    );
  },
};
