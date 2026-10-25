import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { messages, sessions } from "@cindy/runtime-db/schema";
import type { CurrentDbClientSnapshot } from "@cindy/runtime-db/client/current";
import { PluginTaskError } from "@cindy/plugin-runtime/pluginTaskService";
import { pluginWorkerCompletedAt } from "@cindy/orca-workflow/host/pluginWorkerCompletion";

export function createPluginWorkerCompletionReader(host: {
  getCurrentDbClientSnapshot(): CurrentDbClientSnapshot | null;
  getWorkerFlowStatus(
    sessionId: string,
  ): Promise<{ isWorking: boolean; queuedCount: number; queuePaused: boolean }>;
}) {
  return async (
    epoch: CurrentDbClientSnapshot,
    sessionId: string,
    status: string,
  ) => {
    const [row] = await epoch.client.drizzle
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    const safeMeta = sql`CASE WHEN json_valid(${messages.agentMeta}) THEN ${messages.agentMeta} ELSE '{}' END`;
    const [anchor] = await epoch.client.drizzle
      .select({
        role: messages.role,
        createdAt: messages.createdAt,
        agentMeta: messages.agentMeta,
        rowid: sql<number>`rowid`,
      })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, sessionId),
          isNull(messages.rewindAt),
          inArray(messages.role, ["user", "assistant"]),
          sql`json_extract(${safeMeta}, '$.parentUuid') IS NULL`,
        ),
      )
      .orderBy(desc(messages.createdAt), desc(sql`rowid`))
      .limit(1);
    const [taskInput] = anchor
      ? await epoch.client.drizzle
          .select({ createdAt: messages.createdAt, content: messages.content })
          .from(messages)
          .where(
            and(
              eq(messages.sessionId, sessionId),
              isNull(messages.rewindAt),
              eq(messages.role, "user"),
              sql`json_extract(${safeMeta}, '$.parentUuid') IS NULL`,
              sql`COALESCE(json_extract(${safeMeta}, '$.autoResume'), 0) != 1`,
              sql`${messages.createdAt} > ${row?.clearedAt ?? 0}`,
              sql`(${messages.createdAt} < ${anchor.createdAt} OR (${messages.createdAt} = ${anchor.createdAt} AND rowid < ${anchor.rowid}))`,
            ),
          )
          .orderBy(desc(messages.createdAt), desc(sql`rowid`))
          .limit(1)
      : [];
    const flow = await host.getWorkerFlowStatus(sessionId);
    if (epoch !== host.getCurrentDbClientSnapshot())
      throw new PluginTaskError("PERMISSION_DENIED", "Account changed");
    const completedAt = pluginWorkerCompletedAt({
      status,
      working: flow.isWorking,
      queued: flow.queuedCount,
      paused: flow.queuePaused,
      startedAt: row?.activeTurnStartedAt ?? null,
      endedAt: row?.lastTurnEndedAt ?? null,
      clearedAt: row?.clearedAt,
      anchor,
      taskInput,
    });
    return {
      row,
      completedAt,
      status:
        completedAt !== null ? "done" : status === "done" ? "idle" : status,
    };
  };
}

/** The host message window is independent of native-session log layout. */
export async function readPluginWorkerActivity(
  epoch: CurrentDbClientSnapshot,
  sessionId: string,
  createdAt = 0,
) {
  const [firstInput] = await epoch.client.drizzle
    .select({ at: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, "user"),
        isNull(messages.rewindAt),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(1);
  const [firstActivity] = await epoch.client.drizzle
    .select({ at: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        inArray(messages.role, ["assistant", "thinking", "tool_use"]),
        gte(messages.createdAt, firstInput?.at ?? createdAt),
        isNull(messages.rewindAt),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(1);
  return { acceptedAt: firstInput?.at, firstActivityAt: firstActivity?.at };
}
