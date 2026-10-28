import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  McpSetupDraftUpdate,
  McpSetupProposal,
  McpSetupResult,
  McpSetupSnapshot,
  McpSetupSubmission,
  McpSetupError,
  McpSetupDraft,
} from '../../shared/mcpSetup.js';
import { createDesktopOnlyConfirmationRequestId } from '../cindy-brain/desktopOnlyConfirmationProjection.js';
import {
  captureMcpOwner,
  newMcpId,
  saveMcpConfig,
  type McpOwner,
} from './custom-mcp-config-service.js';
import { validateCustomMcpConfig } from './custom-mcp-store.js';
import { validateMcpEndpoint } from '../mcp-integrations/custom-mcp-fetch.js';
import { verifyCustomMcp } from '../mcp-integrations/custom-mcp-verifier.js';
import { deviceName } from '../device-link/deviceName.js';

const requestId = z.string().min(1).max(100);
const draftSchema = z
  .object({
    name: z.string().max(60),
    url: z.string().max(2048),
    transport: z.enum(['http', 'sse']),
    headerNames: z.array(z.string().min(1).max(100)).max(32),
  })
  .strict();
export const mcpDraftUpdateSchema = z
  .object({ requestId, expectedRevision: z.number().int().nonnegative(), draft: draftSchema })
  .strict();
export const mcpSubmissionSchema = z
  .object({
    requestId,
    expectedRevision: z.number().int().nonnegative(),
    submissionId: z.string().uuid(),
    token: z.string().max(8192),
    headers: z
      .record(z.string().max(100), z.string().max(8192))
      .refine((value) => JSON.stringify(value).length <= 32768),
  })
  .strict();
export const mcpCancelSchema = z
  .object({ requestId, expectedRevision: z.number().int().nonnegative() })
  .strict();
type Entry = {
  sessionId: string;
  owner: McpOwner;
  serverId: string;
  snapshot: McpSetupSnapshot;
  abort: AbortController;
  timer: ReturnType<typeof setTimeout>;
  submissionId?: string;
  submissionRevision?: number;
  committingDraft?: McpSetupDraft;
  job?: Promise<McpSetupSnapshot>;
  activationJob?: Promise<NonNullable<McpSetupResult['activation']>>;
  completionSent?: boolean;
  silent?: boolean;
  executionKey?: string;
};
interface SetupDeps {
  broadcast(sessionId: string, snapshot: McpSetupSnapshot): void;
  complete(sessionId: string, snapshot: McpSetupSnapshot, assertCurrent: () => void): Promise<void>;
  changed(): Promise<void | boolean | 'deferred'>;
  activationPending?(): boolean;
  executionKey?(sessionId: string): string | undefined;
  captureOwner?: typeof captureMcpOwner;
  verify?: typeof verifyCustomMcp;
  save?: typeof saveMcpConfig;
}
const safeErrors = new Set<McpSetupError>([
  'INVALID_CONFIG',
  'INSECURE_ENDPOINT',
  'AUTH_REJECTED',
  'CONNECT_TIMEOUT',
  'TLS_FAILED',
  'PROTOCOL_MISMATCH',
  'REDIRECT_REQUIRES_REVIEW',
  'RESPONSE_LIMIT',
  'SECRET_STORE_UNAVAILABLE',
  'SECRET_UNREADABLE',
  'CONFIG_CONFLICT',
  'SAVE_FAILED',
  'OWNER_CHANGED',
  'REQUEST_EXPIRED',
]);
export class CustomMcpSetupService {
  private entries = new Map<string, Entry>();
  constructor(private deps: SetupDeps) {}
  private result(snapshot: McpSetupSnapshot): McpSetupResult {
    const { operationId, status, errorCode, serverId, verification, activation } = snapshot;
    return { operationId, status, errorCode, serverId, verification, activation };
  }
  private async committed(entry: Entry) {
    entry.owner.assertOwner();
    entry.snapshot = {
      ...entry.snapshot,
      status: 'saved',
      serverId: entry.serverId,
      activation: entry.silent ? 'pending' : 'refreshing',
      errorCode: undefined,
    };
    clearTimeout(entry.timer);
    // Persistence is already durable. Runtime refresh may wait on a local
    // Agent host; never leave the owner looking at an encryption spinner.
    // Stop suppresses Agent continuation, but the same owner's visible card
    // must still settle after a transaction that can no longer be cancelled.
    this.deps.broadcast(entry.sessionId, entry.snapshot);
    // Return the safe receipt before an idle Codex host refresh can retire
    // the originating session. The existing input queue deduplicates it.
    await this.notifyCompleted(entry);
    entry.owner.assertOwner();
    if (entry.silent) {
      if (entry.snapshot.activation === 'refreshing') {
        entry.snapshot = { ...entry.snapshot, activation: 'pending' };
        this.deps.broadcast(entry.sessionId, entry.snapshot);
      }
      return;
    }
    const activation = await this.refreshActivation(entry);
    entry.owner.assertOwner();
    this.setActivation(entry, activation);
  }
  private async recoverCommitted(entry: Entry): Promise<boolean> {
    if (!entry.committingDraft) return false;
    const receipt = await entry.owner.client.queryOne(
      'SELECT server_id FROM custom_mcp_setup_receipts WHERE operation_id=? AND session_id=?',
      [entry.snapshot.operationId, entry.sessionId],
    );
    entry.owner.assertOwner();
    entry.abort.signal.throwIfAborted();
    if (!receipt) {
      entry.committingDraft = undefined;
      return false;
    }
    // An uncertain save belongs to its original target, even if the owner
    // subsequently edited the form. Never verify or save those new values
    // until the previous operation is known not to have committed.
    entry.snapshot = {
      ...entry.snapshot, draft: entry.committingDraft, verification: 'passed',
    };
    await this.committed(entry);
    entry.committingDraft = undefined;
    return true;
  }
  private refreshActivation(entry: Entry): Promise<NonNullable<McpSetupResult['activation']>> {
    if (entry.activationJob) return entry.activationJob;
    entry.activationJob = Promise.resolve()
      .then(() => this.deps.changed())
      .then(
        (result) => result === false ? 'pending' as const : result === 'deferred' ? 'deferred' as const : 'next_session' as const,
        () => 'pending' as const,
      )
      .finally(() => {
        entry.activationJob = undefined;
      });
    return entry.activationJob;
  }
  private setActivation(entry: Entry, activation: NonNullable<McpSetupResult['activation']>): void {
    // The idle callback may run before changed() returns. Re-read its existing
    // pending flag in the same synchronous step that publishes the receipt.
    entry.snapshot = { ...entry.snapshot, activation:
      activation === 'deferred' && this.deps.activationPending?.() === false ? 'next_session' : activation,
    };
  }
  private async notifyCompleted(entry: Entry): Promise<void> {
    entry.owner.assertOwner();
    if (
      entry.silent ||
      entry.completionSent ||
      this.deps.executionKey?.(entry.sessionId) !== entry.executionKey
    )
      return;
    entry.completionSent = true;
    const assertCurrent = () => {
      entry.owner.assertOwner();
      if (entry.silent || this.deps.executionKey?.(entry.sessionId) !== entry.executionKey)
        throw new Error('OWNER_CHANGED');
    };
    await this.deps.complete(entry.sessionId, entry.snapshot, assertCurrent).catch(() => {
      entry.completionSent = false;
    });
  }
  request(sessionId: string, proposal: McpSetupProposal): McpSetupResult {
    const owner = (this.deps.captureOwner ?? captureMcpOwner)();
    const existing = [...this.entries.values()].find(
      (e) =>
        e.sessionId === sessionId &&
        e.owner.scope === owner.scope &&
        ['awaiting_user', 'verifying', 'committing'].includes(e.snapshot.status),
    );
    if (existing) return this.result(existing.snapshot);
    // Tool proposals never carry credentials or opaque URL parameters.
    if (proposal.url) validateMcpEndpoint(proposal.url);
    const snapshot: McpSetupSnapshot = {
      kind: 'mcp_setup',
      requestId: createDesktopOnlyConfirmationRequestId(),
      operationId: randomUUID(),
      revision: 0,
      expiresAt: Date.now() + 15 * 60_000,
      status: 'awaiting_user',
      deviceName: deviceName(),
      draft: {
        name: proposal.name ?? '',
        url: proposal.url ?? '',
        transport: proposal.transport ?? 'http',
        headerNames: [],
      },
    };
    const entry: Entry = {
      sessionId,
      owner,
      serverId: newMcpId(),
      snapshot,
      abort: new AbortController(),
      timer: setTimeout(() => {
        try {
          this.cancel(snapshot.requestId, undefined, 'expired');
        } catch {
          this.cancel(snapshot.requestId, undefined, 'expired', true);
        }
      }, 15 * 60_000),
    };
    entry.executionKey = this.deps.executionKey?.(sessionId);
    entry.timer.unref?.();
    // Terminal receipts remain in SQLite; bound the process-only UI history.
    if (this.entries.size >= 200)
      for (const [id, old] of this.entries) {
        if (['saved', 'cancelled', 'expired'].includes(old.snapshot.status)) {
          this.entries.delete(id);
          break;
        }
      }
    this.entries.set(snapshot.requestId, entry);
    this.deps.broadcast(sessionId, snapshot);
    return this.result(snapshot);
  }
  private current(id: string, revision?: number): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('REQUEST_EXPIRED');
    entry.owner.assertOwner();
    if (revision !== undefined && revision !== entry.snapshot.revision)
      throw new Error('CONFIG_CONFLICT');
    return entry;
  }
  update(input: McpSetupDraftUpdate): McpSetupSnapshot {
    const parsed = mcpDraftUpdateSchema.parse(input);
    const entry = this.current(parsed.requestId, parsed.expectedRevision);
    if (entry.snapshot.status !== 'awaiting_user' || Date.now() >= entry.snapshot.expiresAt)
      throw new Error('REQUEST_EXPIRED');
    validateMcpEndpoint(parsed.draft.url);
    const headers = Object.fromEntries(parsed.draft.headerNames.map((name) => [name, '']));
    if (
      !validateCustomMcpConfig({ ...parsed.draft, headers, id: entry.serverId }).ok ||
      new Set(parsed.draft.headerNames.map((name) => name.toLowerCase())).size !==
        parsed.draft.headerNames.length
    )
      throw new Error('INVALID_CONFIG');
    entry.snapshot = {
      ...entry.snapshot,
      revision: entry.snapshot.revision + 1,
      draft: parsed.draft,
      errorCode: undefined,
    };
    this.deps.broadcast(entry.sessionId, entry.snapshot);
    return entry.snapshot;
  }
  submit(input: McpSetupSubmission): Promise<McpSetupSnapshot> {
    const parsed = mcpSubmissionSchema.parse(input);
    parsed.token = parsed.token.trim();
    const entry = this.current(parsed.requestId);
    if (
      entry.submissionId === parsed.submissionId &&
      entry.submissionRevision === parsed.expectedRevision &&
      entry.job
    )
      return entry.job;
    this.current(parsed.requestId, parsed.expectedRevision);
    if (entry.snapshot.status !== 'awaiting_user' || Date.now() >= entry.snapshot.expiresAt)
      throw new Error('REQUEST_EXPIRED');
    const draft = entry.snapshot.draft;
    if (
      Object.keys(parsed.headers).length !== draft.headerNames.length ||
      draft.headerNames.some((name) => !Object.hasOwn(parsed.headers, name))
    )
      throw new Error('INVALID_CONFIG');
    const config = {
      name: draft.name,
      url: draft.url,
      transport: draft.transport,
      id: entry.serverId,
      headers: parsed.headers,
    };
    if (
      !validateCustomMcpConfig(config).ok ||
      /[^\x20-\x7e]/.test(parsed.token) ||
      /^Bearer\s/i.test(parsed.token)
    )
      throw new Error('INVALID_CONFIG');
    entry.submissionId = parsed.submissionId;
    entry.submissionRevision = parsed.expectedRevision;
    entry.snapshot = {
      ...entry.snapshot,
      status: 'verifying',
      revision: entry.snapshot.revision + 1,
      errorCode: undefined,
    };
    this.deps.broadcast(entry.sessionId, entry.snapshot);
    entry.job = (async () => {
      try {
        if (!(entry.committingDraft && (await this.recoverCommitted(entry)))) {
          await (this.deps.verify ?? verifyCustomMcp)(config, parsed.token, entry.abort.signal);
          entry.owner.assertOwner();
          entry.abort.signal.throwIfAborted();
          if (Date.now() >= entry.snapshot.expiresAt) throw new Error('REQUEST_EXPIRED');
          entry.snapshot = { ...entry.snapshot, status: 'committing', verification: 'passed' };
          entry.committingDraft = draft;
          this.deps.broadcast(entry.sessionId, entry.snapshot);
          await (this.deps.save ?? saveMcpConfig)(
            { ...config, token: parsed.token, tokenAction: 'replace' },
            true,
            {
              owner: entry.owner,
              receipt: { operationId: entry.snapshot.operationId, sessionId: entry.sessionId },
              secureNetwork: true,
            },
          );
          entry.owner.assertOwner();
          await this.committed(entry);
          entry.committingDraft = undefined;
        }
      } catch (error) {
        if (entry.abort.signal.aborted) return entry.snapshot;
        const message = error instanceof Error ? error.message : '';
        let recovered = false;
        if (entry.committingDraft) {
          try {
            recovered = await this.recoverCommitted(entry);
          } catch {
            /* Keep the same operation/server id; never duplicate a possibly committed save. */
          }
        }
        if (entry.abort.signal.aborted) return entry.snapshot;
        if (!recovered)
          entry.snapshot = {
            ...entry.snapshot,
            status: entry.silent ? 'cancelled' : 'awaiting_user',
            verification: undefined,
            errorCode: safeErrors.has(message as McpSetupError)
              ? (message as McpSetupError)
              : 'SAVE_FAILED',
          };
        if (entry.silent) {
          clearTimeout(entry.timer);
          if (!recovered) {
            try {
              entry.owner.assertOwner();
              this.deps.broadcast(entry.sessionId, entry.snapshot);
            } catch {
              /* Never publish a stopped owner's draft across an account boundary. */
            }
          }
          return entry.snapshot;
        }
      } finally {
        parsed.token = '';
        parsed.headers = {};
      }
      entry.owner.assertOwner();
      // Runtime refresh can retire the original Agent session. A durable receipt
      // still belongs to this owner even when continuation has been silenced.
      if (!entry.silent || entry.snapshot.status === 'saved')
        this.deps.broadcast(entry.sessionId, entry.snapshot);
      if (!entry.silent && entry.snapshot.status === 'saved') await this.notifyCompleted(entry);
      return entry.snapshot;
    })();
    return entry.job;
  }
  cancel(
    id: string,
    revision?: number,
    status: 'cancelled' | 'expired' = 'cancelled',
    silent = false,
  ): McpSetupSnapshot | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (!silent) this.current(id, revision);
    entry.silent ||= silent;
    if (
      entry.snapshot.status === 'committing' ||
      ['saved', 'cancelled', 'expired'].includes(entry.snapshot.status)
    )
      return entry.snapshot;
    clearTimeout(entry.timer);
    entry.abort.abort();
    entry.snapshot = {
      ...entry.snapshot,
      status,
      revision: entry.snapshot.revision + 1,
      errorCode: undefined,
    };
    if (!silent) this.deps.broadcast(entry.sessionId, entry.snapshot);
    else {
      try {
        entry.owner.assertOwner();
        this.deps.broadcast(entry.sessionId, entry.snapshot);
      } catch {
        /* An owner boundary must not publish the previous owner's draft. */
      }
    }
    if (!silent && this.deps.executionKey?.(entry.sessionId) === entry.executionKey)
      void this.notifyCompleted(entry).catch(() => {});
    return entry.snapshot;
  }
  pendingSnapshots(sessionId?: string) {
    return [...this.entries.values()]
      .filter(
        (entry) =>
          (!sessionId || entry.sessionId === sessionId) &&
          !entry.silent &&
          ['awaiting_user', 'verifying', 'committing'].includes(entry.snapshot.status),
      )
      .map((entry) => ({ request: entry.snapshot }));
  }
  async retryActivation(id: string, revision: number): Promise<McpSetupSnapshot> {
    const entry = this.current(id, revision);
    if (entry.snapshot.status !== 'saved') throw new Error('CONFIG_CONFLICT');
    const activation = await this.refreshActivation(entry);
    entry.owner.assertOwner();
    this.setActivation(entry, activation);
    this.deps.broadcast(entry.sessionId, entry.snapshot);
    return entry.snapshot;
  }
  /** The existing owner-scoped idle restart has applied the frozen MCP config. */
  activationApplied(): void {
    for (const entry of this.entries.values()) {
      if (entry.snapshot.status !== 'saved' || entry.snapshot.activation !== 'deferred') continue;
      try {
        entry.owner.assertOwner();
        entry.snapshot = { ...entry.snapshot, activation: 'next_session' };
        this.deps.broadcast(entry.sessionId, entry.snapshot);
      } catch {
        /* Never publish a receipt across an account boundary. */
      }
    }
  }
  cleanupForSession(sessionId: string) {
    for (const e of this.entries.values())
      if (e.sessionId === sessionId)
        this.cancel(e.snapshot.requestId, undefined, 'cancelled', true);
  }
  invalidate() {
    for (const e of this.entries.values())
      this.cancel(e.snapshot.requestId, undefined, 'cancelled', true);
    this.entries.clear();
  }
  async status(sessionId: string, operationId: string): Promise<McpSetupResult | null> {
    const owner = (this.deps.captureOwner ?? captureMcpOwner)();
    const entry = [...this.entries.values()].find(
      (e) =>
        e.sessionId === sessionId &&
        e.owner.scope === owner.scope &&
        e.snapshot.operationId === operationId,
    );
    if (entry) return this.result(entry.snapshot);
    const receipt = await owner.client.queryOne<{ server_id: string }>(
      'SELECT server_id FROM custom_mcp_setup_receipts WHERE operation_id=? AND session_id=?',
      [operationId, sessionId],
    );
    owner.assertOwner();
    return receipt
      ? {
          operationId,
          status: 'saved',
          serverId: receipt.server_id,
          verification: 'passed',
          activation: 'next_session',
        }
      : null;
  }
}
let service: CustomMcpSetupService | null = null;
export function setCustomMcpSetupService(value: CustomMcpSetupService) {
  service = value;
}
export function getCustomMcpSetupService() {
  return service;
}
