import type { createCurrentDbClient } from "@cindy/runtime-db/client/current";
import type { DbLogger } from "@cindy/runtime-db/logging";
import { createMediaLedger } from "@cindy/runtime-db/mediaLedger";
import { createBlobStore } from "@cindy/media-core/blob-store";
import { createLegacyImageCache } from "@cindy/media-core/legacy-image-cache";
import { createMediaRefCompensationJournal } from "./mediaRefCompensationJournal.js";
import { createMediaIngest } from "./mediaIngest.js";
import { createTaskImageDelivery } from "./taskImageDelivery.js";
import { createChatAttachments } from "./chatAttachments.js";

export interface PersistedMediaHost {
  database: Pick<
    ReturnType<typeof createCurrentDbClient>,
    "getDbClient" | "getCurrentDbClientSnapshot"
  >;
  logger: DbLogger;
  userDataDirectory(): string;
  mediaDirectory(): string;
  owner: Omit<
    Parameters<typeof createMediaRefCompensationJournal>[0],
    "userDataDirectory" | "ledger" | "logger"
  >;
}
/** The same owner-scoped ledger and compensation protocol as the Desktop media path. */
export function createPersistedMedia(host: PersistedMediaHost) {
  const { database, logger } = host;
  const blobStore = createBlobStore(host.mediaDirectory);
  const imageCacheStore = createLegacyImageCache(host.mediaDirectory);
  const ledger = createMediaLedger(database.getDbClient);
  const journal = createMediaRefCompensationJournal({
    ...host.owner,
    userDataDirectory: host.userDataDirectory,
    ledger,
    logger,
  });
  const ingest = createMediaIngest({
    blobStore,
    ledger,
    withMediaRefCompensation: journal.withMediaRefCompensation,
    logger,
  });
  const attachments = createChatAttachments({
    blobStore,
    ledger,
    getDbClient: database.getDbClient,
    logger,
  });
  const taskImages = createTaskImageDelivery({
    ...database,
    ingestMedia: ingest.ingestMedia,
    ledger,
    journal,
  });
  return {
    blobStore,
    imageCacheStore,
    ledger,
    journal,
    ...ingest,
    ...attachments,
    ...taskImages,
  };
}
