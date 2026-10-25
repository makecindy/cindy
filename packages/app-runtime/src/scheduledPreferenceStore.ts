import { eq } from "drizzle-orm";
import { sessions } from "@cindy/runtime-db/schema";
import type { DbClient } from "@cindy/runtime-db";
import {
  effectiveSourceIdForModel,
  findCatalogModel,
  type Catalog,
  type ProviderView,
} from "@cindy/model-providers";
import { throwIpcError } from "@cindy/remote-agent/ipcValidate";
import { parseScheduledModelBaseline } from "./scheduledModelBaseline.js";
import type { ScheduledModelSelection } from "./scheduledModelSelection.js";
import type { createSessionRuntimeControl } from "./sessionRuntimeControl.js";
export function createScheduledPreferenceStore(host: {
  getDbClient(): DbClient;
  broadcastSessionRuntimeProjection(id: string): Promise<void>;
  getDesktopProviderService(): {
    listProviders(options: {
      allowSideEffects: boolean;
      catalog: Catalog;
    }): Promise<ProviderView[]>;
  };
  getActiveCatalog(): Catalog;
  resolveSessionRuntimeAxes: ReturnType<
    typeof createSessionRuntimeControl
  >["resolveSessionRuntimeAxes"];
}) {
  const {
    getDbClient,
    broadcastSessionRuntimeProjection,
    getDesktopProviderService,
    getActiveCatalog,
    resolveSessionRuntimeAxes,
  } = host;
  const updateScheduledPreference = async (
    sessionId: string,
    patch: {
      effort?: ScheduledModelSelection["effort"];
      fastMode?: ScheduledModelSelection["fastMode"];
    } | null,
  ) => {
    const db = getDbClient().drizzle;
    const [row] = await db
      .select({ baseline: sessions.scheduledModelBaseline })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    const baseline = parseScheduledModelBaseline(row?.baseline);
    if (!baseline) return;
    await db
      .update(sessions)
      .set({
        scheduledModelBaseline: patch
          ? JSON.stringify({ ...baseline, ...patch })
          : null,
      })
      .where(eq(sessions.id, sessionId));
    await broadcastSessionRuntimeProjection(sessionId);
  };
  const updateSavedScheduledAxis = async (
    sessionId: string,
    patch: {
      effort?: ScheduledModelSelection["effort"];
      fastMode?: ScheduledModelSelection["fastMode"];
    },
    assertCurrent: () => void,
  ): Promise<boolean> => {
    const [row] = await getDbClient()
      .drizzle.select({ baseline: sessions.scheduledModelBaseline })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    const baseline = parseScheduledModelBaseline(row?.baseline);
    if (!baseline) return false;
    const providers = await getDesktopProviderService().listProviders({
      allowSideEffects: false,
      catalog: getActiveCatalog(),
    });
    const providerId =
      baseline.providerId ??
      effectiveSourceIdForModel(
        providers,
        null,
        baseline.model,
        baseline.agentKind,
      );
    const model = findCatalogModel(
      providers.find((p) => p.id === providerId),
      baseline.model,
      baseline.agentKind,
      { exact: true },
    );
    if (!model)
      throwIpcError(
        "INVALID_PARAMS",
        `model "${baseline.model}" is unavailable`,
      );
    const axes = resolveSessionRuntimeAxes({
      model,
      effort: patch.effort ?? baseline.effort,
      fastMode: patch.fastMode ?? baseline.fastMode,
      effortExplicit: patch.effort !== undefined,
      fastExplicit: patch.fastMode !== undefined,
      allowFixedEffortPlaceholder: true,
    });
    if (!axes.ok)
      throwIpcError(
        "INVALID_PARAMS",
        `setting is unavailable for model "${baseline.model}"`,
      );
    assertCurrent();
    // The picker describes the owner's next turn, not the automation currently running.
    await updateScheduledPreference(sessionId, patch);
    return true;
  };

  return { updateScheduledPreference, updateSavedScheduledAxis };
}
