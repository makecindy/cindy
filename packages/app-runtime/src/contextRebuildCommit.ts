import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { sessions } from "@cindy/runtime-db/schema";
import type { CurrentDbClientSnapshot } from "@cindy/runtime-db/client/current";
import type { DbLogger } from "@cindy/runtime-db/logging";
import type { ContextOverflowRolloverDeps } from "@cindy/im-runtime/contextOverflowRollover";
import type { createMessageService } from "./messageService.js";
import type { createSessionNotifications } from "./sessionNotifications.js";
import type { OwnerBroadcastTap } from "./ownerBroadcast.js";
import type { AgentMeta } from "./sessionTypes.js";

type Messages = ReturnType<typeof createMessageService>;
export interface ContextRebuildCommitHost
  extends
    Pick<
      OwnerBroadcastTap,
      "captureDataOwnerBroadcastScope" | "isDataOwnerBroadcastScopeCurrent"
    >,
    Pick<
      ReturnType<typeof createSessionNotifications>,
      "broadcastSessionPatched"
    >,
    Pick<Messages, "commitContextRebuild"> {
  getCurrentDbClientSnapshot(): CurrentDbClientSnapshot | null;
  createDbMessage: Messages["createMessage"];
  logger: DbLogger;
}

/** Original atomic rebuild plus its owner-scoped session and transcript projections. */
export function createContextRebuildCommit(
  host: ContextRebuildCommitHost,
): ContextOverflowRolloverDeps["commitRebuild"] {
  const {
    captureDataOwnerBroadcastScope,
    getCurrentDbClientSnapshot,
    isDataOwnerBroadcastScopeCurrent,
    commitContextRebuild,
    broadcastSessionPatched,
    createDbMessage,
    logger: log,
  } = host;
  return async (sessionId, handoff, meta, signal) => {
    // Read projection metadata before the transaction: after a successful
    // context.rebuild there must be no fallible step before the zero-usage push.
    const ownerScope = captureDataOwnerBroadcastScope();
    const dbSnapshot = getCurrentDbClientSnapshot();
    if (!dbSnapshot)
      throw new Error("context rebuild requires an active Profile database");
    const [sessionKindRow] = await dbSnapshot.client.drizzle
      .select({
        agentKind: sessions.agentKind,
        contextWindow: sessions.contextWindow,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (
      !isDataOwnerBroadcastScopeCurrent(ownerScope) ||
      getCurrentDbClientSnapshot()?.clientEpoch !== dbSnapshot.clientEpoch
    ) {
      throw new Error("context rebuild owner changed before commit");
    }
    signal?.throwIfAborted();
    const { updatedAt } = await commitContextRebuild(sessionId, handoff, meta);
    if (
      !isDataOwnerBroadcastScopeCurrent(ownerScope) ||
      getCurrentDbClientSnapshot()?.clientEpoch !== dbSnapshot.clientEpoch
    ) {
      throw new Error("context rebuild owner changed after commit");
    }
    const projectionContextWindow =
      typeof sessionKindRow?.contextWindow === "number" &&
      Number.isFinite(sessionKindRow.contextWindow) &&
      sessionKindRow.contextWindow > 0
        ? sessionKindRow.contextWindow
        : undefined;
    const cardAgentKind =
      sessionKindRow?.agentKind === "codex"
        ? "codex"
        : sessionKindRow?.agentKind === "pi"
          ? "pi"
          : "cc";
    broadcastSessionPatched(
      sessionId,
      {
        sdkSessionId: null,
        contextTokens: 0,
        ...(meta.replacementRoute
          ? {
              model: meta.replacementRoute.model,
              providerId: meta.replacementRoute.providerId,
              effort: meta.replacementRoute.effort,
              fastMode: meta.replacementRoute.fastMode,
            }
          : {}),
        ...(projectionContextWindow === undefined
          ? {}
          : { contextWindow: projectionContextWindow }),
        updatedAt: new Date(updatedAt).toISOString(),
      },
      ownerScope,
    );
    try {
      await createDbMessage(
        sessionId,
        {
          clientId: `context-rebuild-card:${createId()}`,
          role: "assistant",
          content: "",
          agentKind: cardAgentKind,
          agentMeta: {
            contextRebuild: { reason: meta.reason, handoff },
          } as AgentMeta,
        },
        {
          broadcastOwnerScope: ownerScope,
          shouldBroadcast: () =>
            isDataOwnerBroadcastScopeCurrent(ownerScope) &&
            getCurrentDbClientSnapshot()?.clientEpoch ===
              dbSnapshot.clientEpoch,
        },
      );
    } catch (error) {
      // The hidden marker and zero-usage session state are already committed.
      // A derived visual card must not turn that successful rebuild into a
      // failed switch or strand control projections on the source route.
      log.warn("context rebuild card creation failed after commit", {
        sessionId,
        reason: meta.reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
