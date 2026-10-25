import path from "node:path";
import type { CodexAgent } from "@cindy/maker-core";
import { CodexThreadLocations } from "@cindy/app-runtime/codexThreadLocations";
import type { NodeDatabase } from "../database.js";
import type { TerminalConversations } from "./conversations.js";

/** Native history belongs to the data owner even when its model account changes. */
export function createTerminalNativeHistory(host: {
  database: NodeDatabase;
  conversations: TerminalConversations;
  profileDir: string;
  assertCurrent(): void;
}) {
  const { database, conversations: c } = host;
  const owner = database.getCurrentDbClientSnapshot();
  const assertCurrent = () => {
    host.assertCurrent();
    if (database.getCurrentDbClientSnapshot() !== owner)
      throw new Error("Native history owner changed");
  };
  const local = c.nativeHistory;
  const locations = new CodexThreadLocations(
    path.join(host.profileDir, "engines", "codex", "thread-index", "locations"),
  );
  type NativeHistory = Pick<
    ConstructorParameters<typeof CodexAgent>[0],
    | "prepareCodexResumeSession"
    | "resolveCodexThreadStorage"
    | "recordCodexThreadLocation"
  >;
  const codex: NativeHistory = {
    prepareCodexResumeSession: async (threadId) => {
      assertCurrent();
      const result = await locations.prepareResume(
        threadId,
        local.prepareExternalCodexSessionForResume,
      );
      assertCurrent();
      return result;
    },
    resolveCodexThreadStorage: async (threadId, options) => {
      assertCurrent();
      const result =
        (await locations.readStorage(threadId)) ??
        (options?.readOnly
          ? local.readCodexThreadStorageForArchive(threadId)
          : await locations.readStorage(threadId, {
              home: path.join(host.profileDir, "codex-home"),
              prepare: local.prepareExternalCodexSessionForResume,
            }));
      assertCurrent();
      return result;
    },
    recordCodexThreadLocation: async (threadId, storageHome, rolloutPath) => {
      assertCurrent();
      if (rolloutPath)
        await locations.record(threadId, rolloutPath, storageHome);
      assertCurrent();
    },
  };
  return { local, codex };
}
