import type { ChannelIM, IdentityKey } from "@cindy/im";
import type { AgentKind, Logger } from "@cindy/maker-core";
import type { ProviderView } from "@cindy/model-providers";
import type { ImChannelAdapter, ImOrchestratorConfig } from "./types";
import type { ImDefaultSettingsChannel } from "./imDefaultSettings";
import type { ImSessionRow } from "./sessionRepo";
import type { ImCardBuilders } from "./cardBuilders";
import type { ControlProject, RecentControlSession } from "./controlProjects";

export interface ImCommandHost {
  createLogger(scope: string): Pick<Logger, "info" | "warn" | "error">;
  listProviders(): Promise<ProviderView[]>;
  readDeviceProviderViews(deviceId: string): Promise<ProviderView[]>;
  waitForModelVisibilityMirror(): Promise<void>;
  getModelVisibilityOverride(
    agentKind: AgentKind,
    providerId: string,
    modelId: string,
  ): boolean | undefined;
  getSessionProvider(sessionId: string): string | null;
  resetImSessionToChannelDefaults(
    sessionId: string,
    config: ImOrchestratorConfig,
    prepared: ImSessionRow | undefined,
    channel: ImDefaultSettingsChannel,
  ): Promise<void>;
  listProjectsForControl(): Promise<ControlProject[]>;
  listRecentSessionsForPicker(): Promise<RecentControlSession[]>;
  readSessionTitle(sessionId: string): Promise<string>;
  enterControl(botContextId: string, userId: string, scope?: string): void;
  startThreadControlFlow(
    im: ChannelIM,
    adapter: ImChannelAdapter,
    cards: ImCardBuilders,
    args: { botContextId: string; userId: string },
  ): Promise<boolean>;
  bindingStore: {
    get(identity: IdentityKey): string | null;
    listByIdentity(
      channel: string,
      botContextId: string,
      userId: string,
    ): Array<{ identity: IdentityKey; targetSessionId: string }>;
    applyPersistedDetach(
      identity: IdentityKey,
      expectedTargetSessionId: string,
    ): Promise<boolean>;
  };
  executeDetach(
    identity: IdentityKey,
    source: `${string}-slash` | "desktop-revoke",
  ): Promise<{ wasAttached: boolean; targetSessionId: string | null }>;
}
