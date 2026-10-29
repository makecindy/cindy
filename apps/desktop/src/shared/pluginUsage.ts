/** Personal records belong to the executing host's account database. */
export type PluginUsageOutcome = 'unknown' | 'succeeded' | 'failed' | 'timed-out' | 'cancelled';
export type PluginUsageEntryKind = 'tool' | 'execution';

export interface PluginUsageSummary {
  subjectId: string;
  recordingStartedAt: number;
  lastUsedAt: number | null;
  callsLast7Days: number;
  totalCalls: number;
  until: number;
  deviceName: string;
  recentTasks: { sessionId: string; title: string; lastUsedAt: number }[];
}

/** Host-verified source, never supplied by a plugin or renderer. */
export interface PluginUsageIdentity {
  ghostId: string;
  displayName: string;
  revision: string;
  sourceKind: 'server' | 'git-market' | 'local-market' | 'manual';
  stableKey: string | null;
  pluginId: string | null;
  organizationId: string | null;
  sourceKey: string | null;
  serverRoot: string | null;
  version: string | null;
  releaseId: string | null;
  reportingScope?: 'public' | 'organization' | 'personal';
  verifiedServerRoot?: string;
}

export interface PluginUsageHandle {
  subjectId: string;
  historyGeneration: number;
  identity: PluginUsageIdentity;
  reportTarget?: PluginUsageReportTarget | null;
}

export interface PluginUsageReportTarget {
  serverRoot: string;
  pluginId: string;
  ownerId: string;
  scope: 'public' | 'organization';
  organizationId: string | null;
}

export interface PluginUsageReportRow {
  callId: string;
  subjectId: string;
  historyGeneration: number;
  releaseId: string;
  occurredAt: number;
  reportTarget: string;
  attemptCount: number;
}

export type PluginUsageTransaction =
  | {
      action: 'bind';
      identity: PluginUsageIdentity;
      newId: string;
      now: number;
      previousRevision?: string;
    }
  | {
      action: 'accept';
      handle: PluginUsageHandle;
      callId: string;
      toolName: string;
      sessionId: string | null;
      occurredAt: number;
      entryKind?: PluginUsageEntryKind;
    }
  | { action: 'settle'; handle: PluginUsageHandle; callId: string; outcome: PluginUsageOutcome }
  | { action: 'clear'; subjectId: string | null; now: number }
  | { action: 'detach'; ghostId: string }
  | {
      action: 'report';
      updates: {
        row: PluginUsageReportRow;
        state: 'pending' | 'sent' | 'rejected';
        nextAttemptAt: number | null;
      }[];
    };
