import { createBlobStore } from "../../desktop/src/main/cindy-media/blobStore.js";
import { createChatAttachments } from "../../desktop/src/main/cindy-media/chatAttachmentsCore.js";
import { createMediaIngest } from "../../desktop/src/main/cindy-media/ingestCore.js";
import { createMediaRefCompensationJournal } from "../../desktop/src/main/cindy-media/refCompensationJournal.js";
import { createToolProcessMedia } from "../../desktop/src/main/cindy-media/toolProcessMediaCore.js";
import { getUserDataDir } from "../../desktop/src/main/userDataPath.js";
import { getCurrentDbClientSnapshot } from "../../desktop/src/main/localDb/client/current.js";

// One byte store / lock registry per process, using the existing media format.
// Paths are resolved only after the launcher selects its isolated profile.
export const hostBlobStore = createBlobStore({ getUserDataDir });
export const hostMediaJournal = createMediaRefCompensationJournal({
  getUserDataDir,
  activeOwnerScopeKey() {
    const owner = getCurrentDbClientSnapshot();
    if (!owner) throw new Error("DbClient not ready");
    return `${owner.userId}:${owner.clientEpoch}`;
  },
  getActiveAppSession: () => ({
    dataOwnerId: getCurrentDbClientSnapshot()?.userId ?? null,
  }),
  isAppSessionBoundaryPending: () => getCurrentDbClientSnapshot() === null,
});
export const hostMediaIngest = createMediaIngest({
  blobStore: hostBlobStore,
  withMediaRefCompensation: hostMediaJournal.withMediaRefCompensation,
});
export const hostChatAttachments = createChatAttachments({
  blobStore: hostBlobStore,
});
export const materializeHostToolMedia = createToolProcessMedia({
  ingestMedia: hostMediaIngest.ingestMedia,
  async materializeSshRemoteMedia() {
    // Never reinterpret a remote absolute path as a path on the Host machine.
    throw new Error("SSH media requires the remote file service");
  },
});
