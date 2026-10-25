import { CodexAgent, type BaseAgent, type Session } from "@cindy/maker-core";
import {
  createSessionArchiveSync,
  prepareArchiveSessions,
} from "@cindy/app-runtime/nativeSessionArchiveSync";
import type { createSessionRouteLock } from "@cindy/app-runtime/sessionRouteLock";
import type { NodeDatabase } from "../database.js";
import type { DbLogger } from "@cindy/runtime-db/logging";

/** Drive the same archive reconciler using this owner's native runtime handles. */
export function createTerminalNativeArchive(host: {
  database: NodeDatabase;
  logger: DbLogger;
  assertCurrent(): void;
  withSessionRouteLocks: ReturnType<
    typeof createSessionRouteLock
  >["withSessionRouteLocks"];
  session(id: string): Session | undefined;
  liveAgent(id: string): BaseAgent | undefined;
  createAgent(id: string): Promise<BaseAgent>;
  canUseRemote(id: string): boolean;
}) {
  const controls = new Map<string, CodexAgent>();
  const used = new Set<CodexAgent>();
  const sync = createSessionArchiveSync({
    withSessionRouteLocks: host.withSessionRouteLocks,
    capture: () => {
      host.assertCurrent();
      const snapshot = host.database.getCurrentDbClientSnapshot();
      if (!snapshot) throw new Error("Native archive database is unavailable");
      return {
        client: snapshot.client,
        assertCurrent: () => {
          host.assertCurrent();
          if (host.database.getCurrentDbClientSnapshot() !== snapshot)
            throw new Error("Native archive owner changed");
        },
      };
    },
    prepare: (rows) => prepareArchiveSessions(rows, host.session),
    canUseRemote: host.canUseRemote,
    sync: async (input) => {
      input.assertCurrent();
      const rows = await host.database.getDbClient().query<{ id: string }>(
        `SELECT id FROM sessions WHERE agent_kind = 'codex' AND sdk_session_id = ?
         AND remote_host_id IS ? AND status IN ('active', 'archived')
         ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, id`,
        [input.threadId, input.remoteHostId ?? null],
      );
      input.assertCurrent();
      if (!rows.length) return;
      let agent = rows
        .map((row) => host.liveAgent(row.id))
        .find((value) => value instanceof CodexAgent);
      if (!agent) {
        const id = rows[0]!.id;
        agent = controls.get(id);
        if (!agent) {
          const created = await host.createAgent(id);
          if (!(created instanceof CodexAgent)) {
            await created.dispose();
            throw new Error("Native Codex archive runtime is unavailable");
          }
          agent = created;
          controls.set(id, agent);
        }
      }
      used.add(agent);
      input.assertCurrent();
      await agent.syncThreadArchiveState(input);
    },
    release: async () => {
      const results = await Promise.allSettled(
        [...used].map((agent) => agent.releaseArchiveHosts()),
      );
      used.clear();
      const disposed = await Promise.allSettled(
        [...controls.values()].map((agent) => agent.dispose()),
      );
      controls.clear();
      const errors = [...results, ...disposed].filter(
        (value): value is PromiseRejectedResult => value.status === "rejected",
      );
      if (errors.length)
        throw new AggregateError(
          errors.map((value) => value.reason),
          "Native archive cleanup failed",
        );
    },
    warn: (failures) =>
      host.logger.warn("native archive sync deferred", { failures }),
  });
  return { request: sync.request, close: sync.stop };
}
