import type { DbClient } from '@cindy/runtime-db';
import type { DbLogger } from '@cindy/runtime-db/logging';
import type { messages } from '@cindy/runtime-db/schema';
import type { MessageWriterHost } from '@cindy/runtime-db/messageWriter';
import type { createCurrentDbClient } from '@cindy/runtime-db/client/current';
import type { createHistoryViewReader, HistoryPageShape } from '@cindy/remote-agent/host/historyViewReader';
import type { RegionalMoney, MoneyKind, MoneyEstimateReason } from '@cindy/maker-shared/regional-money-types';
import type { TurnUsageDetails } from '@cindy/maker-shared/turn-usage-types';
import type { AgentMeta } from './sessionTypes.js';
import type { BroadcastLocal, DataOwnerBroadcastScope, OwnerBroadcastTap } from './ownerBroadcast.js';

type MessageRow = typeof messages.$inferSelect;
type HistoryReader = ReturnType<typeof createHistoryViewReader>;

export interface MessageServiceHost<InvokeEvent> extends Pick<MessageWriterHost<DataOwnerBroadcastScope, AgentMeta>,
  'getDbClient' | 'commitMessageMediaRefs' | 'onChatMessageCreatedForEmbedding' | 'recordPrRefsForMessage'> {
  logger: DbLogger;
  getCurrentDbClientSnapshot: ReturnType<typeof createCurrentDbClient>['getCurrentDbClientSnapshot'];
  broadcastTap: OwnerBroadcastTap;
  broadcastLocal: BroadcastLocal;
  /** The same registered API is dispatched by Electron, a local terminal, or device-link. */
  ipc: { handle(channel: string, handler: (event: InvokeEvent, ...args: any[]) => unknown): void };
  assertTrustedAppRendererEvent(event: InvokeEvent): void;
  isDeviceLinkInvoke(): boolean;
  getDeviceLinkInvokeContext(): {
    sharedTask?: unknown;
    historyView?: {
      disable(): void;
      update(keys: string[], options: { workLines: boolean; shape?: HistoryPageShape }): void;
      setExpanded(keys: string[]): void;
    };
  } | null | undefined;
  whenTurnErrorPersisted(sessionId: string, clientId: string): Promise<void>;
  setHistoryWorkPageReader(reader: (sessionId: string, onShape: (shape: HistoryPageShape) => void) => ReturnType<HistoryReader['page']>): void;
  restoreTaskImageRows<T extends MessageRow>(client: DbClient, rows: T[]): Promise<T[]>;
  recoverGeneratedImagesForHistory(sessionId: string): Promise<unknown>;
  collectCindyMediaHashes(content: unknown): string[];
  removeMediaRefs(input: { refKind: 'message'; refId: string }, db?: DbClient['drizzle']): Promise<number>;
  removeSessionAttachmentRefIfUnreferencedByLiveMessage(input: { sessionId: string; hash: string; visibleOnly?: boolean }, db?: DbClient['drizzle']): Promise<number>;
  importExternalCodexMessagesForSession(sessionId: string): Promise<void>;
  importExternalClaudeCodeMessagesForSession(sessionId: string): Promise<void>;
  recomputePrRefsForSession(sessionId: string, scope?: { dbClient: DbClient; isCurrent: () => boolean }): Promise<void>;
  scheduleBotRemoteResourceChangedForSession(sessionId: string, ownerScopeKey?: string): void;
  latestVisiblePreviewRow(sessionId: string): Promise<{ clientId: string; content: string; role: string; createdAt: number } | null>;
  extractMessagePreview(raw: string | null | undefined, role: string | null | undefined): string | null;
  capReferenceMessageRows<T extends { content: unknown; agentMeta?: unknown }>(rows: readonly T[], limit: number | null, preserveStructuredRoles?: boolean): T[];
  resolveStaleCodexSubscriptionValueEstimate(value: number, details: TurnUsageDetails | null | undefined, model?: string | null): number | null;
  normalizeTurnUsageDetails(value: unknown): TurnUsageDetails | undefined;
  addCompatibleRegionalMoney(values: readonly RegionalMoney[]): RegionalMoney | null;
  asValueEstimateMoney(money: RegionalMoney): RegionalMoney;
  legacyUsdMoney(value: number): RegionalMoney;
  normalizeRegionalMoney(value: unknown): RegionalMoney | undefined;
  usdMoney(value: number, kind?: MoneyKind, reason?: MoneyEstimateReason): RegionalMoney;
}
