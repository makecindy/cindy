import { desc, eq } from "drizzle-orm";
import { sessions } from "@cindy/runtime-db/schema";
import { makerToDbAgentKind } from "@cindy/maker-shared/agent-kind-conversion";
import {
  parseOrcaRemoteLead,
  serializeOrcaRemoteLead,
} from "@cindy/maker-shared/orca-remote-worker";
import type { NodeDatabase } from "../database.js";
import type { TerminalTaskMeta, NewTerminalTaskMeta } from "./storage.js";
import type { TerminalConversations } from "./conversations.js";
import type { createSessionOpening } from "@cindy/app-runtime/sessionOpening";

/** Terminal naming adapter for the original sessions table. Additional state
 * (queues, handoff, goals and provider groups) belongs to its original service,
 * never to a second task metadata document or terminal-only schema columns. */
export class TerminalSessionMetadata {
  constructor(
    private readonly database: NodeDatabase,
    private readonly runtime: TerminalConversations,
    private readonly opening: () => ReturnType<typeof createSessionOpening>,
  ) {}

  private patch(input: Partial<TerminalTaskMeta>) {
    for (const field of [
      "queuePaused",
      "queueExpanded",
      "pendingHandoff",
      "goalContinuation",
      "groupBinding",
      "imScopeKey",
    ] as const) {
      if (input[field] !== undefined && input[field] !== null)
        throw new Error(`TASK_STATE_REQUIRES_ORIGINAL_SERVICE:${field}`);
    }
    const source = {
      title: input.title,
      workingDir: input.workDir,
      workspaceKind: input.workspaceKind,
      model: input.model,
      effort: input.effort,
      permissionMode: input.permissionMode,
      providerId: input.providerId,
      fastMode: input.fastMode,
      planModeEnabled: input.planMode,
      ...("sdkSessionId" in input
        ? { sdkSessionId: input.sdkSessionId ?? null }
        : {}),
      ...("pinnedAt" in input
        ? {
            pinnedAt:
              input.pinnedAt == null
                ? null
                : new Date(input.pinnedAt).toISOString(),
          }
        : {}),
      ...("clearedAt" in input
        ? {
            clearedAt:
              input.clearedAt == null
                ? null
                : new Date(input.clearedAt).toISOString(),
          }
        : {}),
      ...("archived" in input || "deleted" in input
        ? ({
            status: input.deleted
              ? "deleted"
              : input.archived
                ? "archived"
                : "active",
          } as const)
        : {}),
      orcaRole: input.orcaRole,
      ...(input.usage
        ? {
            totalTokenUsage: input.usage.tokenUsage,
            totalCostUsd: input.usage.costUsd,
            contextTokens: input.usage.contextTokens,
            contextWindow: input.usage.contextWindow,
          }
        : {}),
    };
    // The original mapper distinguishes an omitted field from an explicit null.
    // Adapter defaults must never clear role, permission or other owned state.
    for (const [key, value] of Object.entries(source))
      if (value === undefined) Reflect.deleteProperty(source, key);
    const patch = this.runtime.rowMapper.sessionPatchToRow(source);
    if (input.agentKind !== undefined)
      patch.agentKind = makerToDbAgentKind(input.agentKind);
    for (const field of [
      "worktreePath",
      "hiddenAt",
      "userSendAt",
      "agentDeviceId",
      "remoteHostId",
      "feishuBotAppId",
      "feishuOpenId",
      "imBotContextId",
      "imUserId",
      "imDefaultRoute",
    ] as const)
      if (field in input)
        Object.assign(patch, { [field]: input[field] ?? null });
    if (input.source !== undefined)
      patch.source = input.source as typeof sessions.$inferInsert.source;
    if (input.orcaRemoteLead !== undefined)
      patch.orcaRemoteLead = serializeOrcaRemoteLead(input.orcaRemoteLead);
    return patch;
  }

  async create(input: NewTerminalTaskMeta, guard: () => void) {
    const now = Date.now();
    const body = {
      title: input.title,
      workingDir: input.workDir,
      workspaceKind: input.workspaceKind,
      agentKind: makerToDbAgentKind(input.agentKind),
      model: input.model,
      effort: input.effort,
      permissionMode: input.permissionMode,
      fastMode: input.fastMode,
      planModeEnabled: input.planMode,
      providerId: input.providerId,
      remoteHostId: input.remoteHostId,
      agentDeviceId: input.agentDeviceId,
      parentSessionId: input.parentSessionId,
      orcaRole: input.orcaRole,
      orcaRemoteLead: input.orcaRemoteLead,
    };
    const extra = this.patch(input);
    // Admission owns the resolved route and directory. Preserve independently
    // supplied metadata (including a precreated worktree and import SDK identity).
    for (const key of [
      "title",
      "workingDir",
      "workspaceKind",
      "agentKind",
      "model",
      "providerId",
      "effort",
      "permissionMode",
      "fastMode",
      "planModeEnabled",
      "orcaRole",
      "orcaRemoteLead",
    ])
      Reflect.deleteProperty(extra, key);
    await this.opening().openSession(
      {
        id: input.id,
        now,
        body,
        assertCurrent: guard,
        ...(input.source
          ? { source: input.source as typeof sessions.$inferInsert.source }
          : {}),
        ...(typeof input.hiddenAt === "number"
          ? { hiddenAt: input.hiddenAt }
          : {}),
      },
      async (row, assertCurrent) => {
        assertCurrent();
        await this.database.db.drizzle
          .insert(sessions)
          .values({ ...row, ...extra });
      },
    );
    return (await this.get(input.id))!;
  }

  async update(id: string, input: Partial<TerminalTaskMeta>) {
    const patch = this.patch(input);
    if (input.title !== undefined) this.runtime.titles.noteUserTitleWritten(id);
    await this.database.db.drizzle
      .update(sessions)
      .set(patch)
      .where(eq(sessions.id, id));
  }

  async get(id: string): Promise<TerminalTaskMeta | null> {
    const rows = await this.database.db.drizzle
      .select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const base = this.database.sessionRowToMeta(row);
    const remoteLead = parseOrcaRemoteLead(row.orcaRemoteLead);
    return {
      ...base,
      archived: row.status === "archived",
      deleted: row.status === "deleted",
      providerId: row.providerId ?? undefined,
      worktreePath: row.worktreePath ?? undefined,
      clearedAt: row.clearedAt ?? undefined,
      pinnedAt: row.pinnedAt,
      hiddenAt: row.hiddenAt,
      source: row.source,
      feishuBotAppId: row.feishuBotAppId ?? undefined,
      feishuOpenId: row.feishuOpenId ?? undefined,
      imBotContextId: row.imBotContextId ?? undefined,
      imUserId: row.imUserId ?? undefined,
      imDefaultRoute: row.imDefaultRoute,
      userSendAt: row.userSendAt ?? undefined,
      orcaRole: row.orcaRole,
      ...(remoteLead ? { orcaRemoteLead: remoteLead } : {}),
      usage: {
        tokenUsage: row.totalTokenUsage,
        costUsd: row.totalCostUsd,
        contextTokens: row.contextTokens,
        contextWindow: row.contextWindow,
      },
    };
  }

  async list() {
    const ids = await this.database.db.drizzle
      .select({ id: sessions.id })
      .from(sessions)
      .orderBy(desc(sessions.updatedAt));
    const result: TerminalTaskMeta[] = [];
    for (const { id } of ids) {
      const row = await this.get(id);
      if (row) result.push(row);
    }
    return result;
  }

  async delete(id: string) {
    await this.database.sessionStorage.delete(id);
  }
  compareAndClearSdkSessionId(id: string, expected: string) {
    return this.database.sessionStorage.compareAndClearSdkSessionId(
      id,
      expected,
    );
  }
}
