import path from "node:path";
import { createGeneratedMedia } from "@cindy/app-runtime/generatedMedia";
import { createGeneratedImageStorageRuntime } from "@cindy/app-runtime/generatedImageStorage";
import {
  createGeneratedImageDeliveryRuntime,
  type GeneratedImageDeliveryDeps,
} from "@cindy/app-runtime/generatedImageDelivery";
import type { NodeDatabase } from "../database.js";
import type { TerminalConversations } from "./conversations.js";
import type { TerminalTaskMedia } from "./media.js";

/** Original durable image delivery. Account scope and transport are supplied by
 * the Node host; journal, references, retries and recovery remain shared. */
export async function openTerminalGeneratedImages(options: {
  database: NodeDatabase;
  conversations: TerminalConversations;
  media: TerminalTaskMedia;
  profileDir: string;
  isCurrent(): boolean;
  invoke: GeneratedImageDeliveryDeps["invoke"];
  publish: GeneratedImageDeliveryDeps["publish"];
  materializeSshRemoteMedia: (origin:{remoteHostId:string|null;workdir:string},url:string,limits?:{maxBytes?:number})=>Promise<{ok:true;cachePath:string}|{ok:false}>;
  t(key: string, params?: Record<string, string | number>): string;
}) {
  const media = await options.media.persisted();
  const owner = options.database.getCurrentDbClientSnapshot();
  if (!owner) throw new Error("HOST_NOT_READY");
  const current = () =>
    options.isCurrent() &&
    options.database.getCurrentDbClientSnapshot() === owner;
  const generated = createGeneratedMedia(media);
  const storage = createGeneratedImageStorageRuntime({
    ...media,
    ...media.blobStore,
    ...media.ledger,
    ...media.journal,
    ...generated,
    getCurrentDbClientSnapshot: options.database.getCurrentDbClientSnapshot,
    getActiveAppSession: () => ({
      dataOwnerId: current() ? owner.userId : null,
      generation: owner.clientEpoch,
    }),
    isAppSessionBoundaryPending: () => !current(),
    ownerScopedUserDataPath: (...parts) => {
      if (!current()) throw new Error("IMAGE_DELIVERY_SCOPE_CHANGED");
      return path.join(options.profileDir, ...parts);
    },
  });
  const { createGeneratedImageDelivery } = createGeneratedImageDeliveryRuntime({
    ...storage,
    ...media,
    ...generated,
    ...options.conversations.messages,
    ...options.conversations.broadcastTap,
    t: options.t,
  });
  const delivery = createGeneratedImageDelivery({
    invoke: options.invoke,
    publish: options.publish,
    readSource: async (_id, image, session) => {
      if (image.pathOrigin === "remote-agent")
        throw new Error("REMOTE_SOURCE_REQUIRED");
      if (session.remoteHostId) {
        if (!image.path || !session.workingDir)
          throw new Error("REMOTE_SOURCE_REQUIRED");
        const result = await options.materializeSshRemoteMedia(
          { remoteHostId: session.remoteHostId, workdir: session.workingDir },
          `xdt-file://?path=${encodeURIComponent(image.path)}`,
          {maxBytes:generated.MAX_GENERATED_IMAGE_BYTES},
        );
        if (!result.ok) throw new Error("REMOTE_SOURCE_REQUIRED");
        return generated.readGeneratedImageFile(result.cachePath);
      }
      const managed = image.url?.startsWith("cindy-media://")
        ? media.blobStore.resolveSafe(image.url)
        : image.url?.startsWith("xdt-image://")
          ? media.imageCacheStore.resolveSafe(image.url)
          : undefined;
      if (managed) {
        try {
          return await generated.readGeneratedImageFile(managed.absPath);
        } catch (error) {
          if (!image.path) throw error;
        }
      }
      if (!image.path) throw new Error("MEDIA_SOURCE_MISSING");
      return generated.readGeneratedImageFile(image.path);
    },
  });
  const pending = new Set<Promise<unknown>>();
  let closing = false;
  function track<T>(work: () => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new Error("IMAGE_DELIVERY_CLOSED"));
    const operation = work();
    pending.add(operation);
    void operation.finally(() => pending.delete(operation)).catch(() => {});
    return operation;
  }
  const managed = {
    deliver: (...args: Parameters<typeof delivery.deliver>) =>
      track(() => delivery.deliver(...args)),
    recover: (...args: Parameters<typeof delivery.recover>) =>
      track(() => delivery.recover(...args)),
    cleanup: (...args: Parameters<typeof delivery.cleanup>) =>
      track(() => delivery.cleanup(...args)),
    reconcile: () => track(() => delivery.reconcile()),
    async close() {
      closing = true;
      await Promise.allSettled(pending);
    },
  };
  options.conversations.media.setGeneratedImageRecovery(
    (id) => managed.recover(id),
    () => managed.reconcile(),
  );
  return { ...managed, ...storage };
}
