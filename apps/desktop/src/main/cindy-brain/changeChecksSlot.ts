import { randomUUID } from 'node:crypto';

import { ghostInstallApprovalToken, type InstalledGhost } from '../../shared/ghost.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import { hasPluginChecksApproval } from './taskCapability.js';
import { legacyChangeCheckSource, probeExistingGoogleTools } from './changeCheckToolAdapters.js';

export type ChangeCheckState = 'changed' | 'unchanged' | 'unknown';
export interface ChangeCheck {
  providerId: string;
  source: string;
  from: string;
  to: string;
}
export interface ChangeCheckResult extends ChangeCheck {
  state: ChangeCheckState;
}
export interface ChangeCheckPush {
  type: 'change-check';
  requestId: string;
  source: string;
  from: string;
  to: string;
}
interface Deps {
  owner(): string | null;
  list(): InstalledGhost[];
  wake(ghost: InstalledGhost): Promise<void>;
  send(id: string, payload: ChangeCheckPush): boolean;
  now?(): number;
  timeoutMs?: number;
  conversationChanges?(from: number, to: number): Promise<boolean>;
  readTool?(
    providerId: string,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
}
interface Pending {
  providerId: string;
  finish(state: ChangeCheckState): void;
}

/** Only source plugins see their accounts. Callers receive a tri-state, never tool output. */
export class GhostChangeChecksSlot {
  private readonly pending = new Map<string, Pending>();
  private readonly busy = new Set<string>();
  private readonly lastAttempt = new Map<string, number>();

  constructor(private readonly deps: Deps) {}

  private get(id: string) {
    return this.deps.list().find((ghost) => installedGhostStoragePart(ghost) === id);
  }

  private authorized(id: string, owner: string | null, token?: string): boolean {
    const ghost = this.get(id);
    return (
      owner !== null &&
      owner === this.deps.owner() &&
      hasPluginChecksApproval(ghost) &&
      (!token || ghostInstallApprovalToken(ghost?.approval) === token)
    );
  }

  async request(callerId: string, raw: unknown): Promise<unknown> {
    const owner = this.deps.owner();
    if (!this.authorized(callerId, owner)) return { ok: false, errorCode: 'PERMISSION_DENIED' };
    const callerToken = ghostInstallApprovalToken(this.get(callerId)?.approval);
    const input = raw as { action?: unknown; checks?: unknown } | null;
    if (input?.action === 'list') {
      return {
        ok: true,
        providers: [
          ...(this.deps.conversationChanges
            ? [{ providerId: '@cindy/local-history', name: 'Cindy', sources: ['cindy'] }]
            : []),
          ...this.deps
            .list()
            .flatMap((ghost) =>
              this.deps.readTool && legacyChangeCheckSource(ghost)
                ? [
                    {
                      providerId: installedGhostStoragePart(ghost),
                      name: ghost.manifest.name,
                      sources: [legacyChangeCheckSource(ghost)!],
                    },
                  ]
                : hasPluginChecksApproval(ghost) &&
                    Array.isArray(ghost.manifest.agent?.checkSources)
                  ? [
                      {
                        providerId: installedGhostStoragePart(ghost),
                        name: ghost.manifest.name,
                        sources: ghost.manifest.agent.checkSources.filter(
                          (source) =>
                            typeof source === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(source),
                        ),
                      },
                    ]
                  : [],
            ),
        ],
      };
    }
    const now = this.deps.now?.() ?? Date.now();
    if (
      input?.action !== 'probe' ||
      !Array.isArray(input.checks) ||
      !input.checks.length ||
      input.checks.length > 16
    )
      return { ok: false, errorCode: 'INVALID_REQUEST' };
    const checks: ChangeCheck[] = [];
    for (const value of input.checks) {
      const check = value as ChangeCheck | null;
      if (
        !check ||
        typeof check.providerId !== 'string' ||
        !check.providerId ||
        check.providerId.length > 256 ||
        typeof check.source !== 'string' ||
        !/^[a-z][a-z0-9-]{0,63}$/.test(check.source) ||
        typeof check.from !== 'string' ||
        check.from.length > 40 ||
        typeof check.to !== 'string' ||
        check.to.length > 40
      )
        return { ok: false, errorCode: 'INVALID_REQUEST' };
      const from = Date.parse(check.from),
        to = Date.parse(check.to);
      if (
        !Number.isFinite(from) ||
        !Number.isFinite(to) ||
        from >= to ||
        to > now + 30_000 ||
        to - from > 31 * 86_400_000
      )
        return { ok: false, errorCode: 'INVALID_REQUEST' };
      checks.push({
        providerId: check.providerId,
        source: check.source,
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
      });
    }
    const key = JSON.stringify([owner, callerId]);
    // Bound stale owner generations without retaining account activity indefinitely.
    for (const [oldKey, at] of this.lastAttempt)
      if (now - at >= 30_000) this.lastAttempt.delete(oldKey);
    if (this.busy.has(key) || now - (this.lastAttempt.get(key) ?? -Infinity) < 30_000)
      return { ok: false, errorCode: 'RATE_LIMITED' };
    this.lastAttempt.set(key, now);
    this.busy.add(key);
    try {
      // Same range repeated in one request is one provider call. No cross-account cache.
      const flights = new Map<string, Promise<ChangeCheckResult>>();
      const results = await Promise.all(
        checks.map((check) => {
          const checkKey = JSON.stringify(check);
          let flight = flights.get(checkKey);
          if (!flight) {
            flight = this.probe(callerId, callerToken, owner, check);
            flights.set(checkKey, flight);
          }
          return flight;
        }),
      );
      if (!this.authorized(callerId, owner, callerToken))
        return { ok: false, errorCode: 'PERMISSION_DENIED' };
      return { ok: true, results };
    } finally {
      this.busy.delete(key);
    }
  }

  private async probe(
    callerId: string,
    callerToken: string,
    owner: string | null,
    check: ChangeCheck,
  ): Promise<ChangeCheckResult> {
    const legacyProvider = this.get(check.providerId);
    const legacySource = legacyProvider && legacyChangeCheckSource(legacyProvider);
    if (legacySource && legacySource === check.source && this.deps.readTool) {
      const token = ghostInstallApprovalToken(legacyProvider.approval);
      const current = () =>
        this.authorized(callerId, owner, callerToken) &&
        legacyChangeCheckSource(this.get(check.providerId) ?? ({} as InstalledGhost)) ===
          legacySource &&
        ghostInstallApprovalToken(this.get(check.providerId)?.approval) === token;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const state = await Promise.race([
          probeExistingGoogleTools(legacySource, check, async (tool, args) => {
            if (!current() || controller.signal.aborted) throw new Error('CHECK_INVALIDATED');
            const result = await this.deps.readTool!(
              check.providerId,
              tool,
              args,
              controller.signal,
            );
            if (!current() || controller.signal.aborted) throw new Error('CHECK_INVALIDATED');
            return result;
          }),
          new Promise<'unknown'>((resolve) => {
            timer = setTimeout(() => {
              controller.abort();
              resolve('unknown');
            }, this.deps.timeoutMs ?? 20_000);
          }),
        ]);
        return { ...check, state: current() ? state : 'unknown' };
      } catch {
        return { ...check, state: 'unknown' };
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    }
    if (
      check.providerId === '@cindy/local-history' &&
      check.source === 'cindy' &&
      this.deps.conversationChanges
    ) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const state = await Promise.race([
          this.deps
            .conversationChanges(Date.parse(check.from), Date.parse(check.to))
            .then((changed) => (changed ? ('changed' as const) : ('unchanged' as const))),
          new Promise<'unknown'>((resolve) => {
            timer = setTimeout(() => resolve('unknown'), this.deps.timeoutMs ?? 20_000);
          }),
        ]);
        return {
          ...check,
          state: this.authorized(callerId, owner, callerToken) ? state : 'unknown',
        };
      } catch {
        return { ...check, state: 'unknown' };
      } finally {
        clearTimeout(timer);
      }
    }
    const ghost = this.get(check.providerId);
    const providerToken = ghostInstallApprovalToken(ghost?.approval);
    const current = () =>
      this.authorized(callerId, owner, callerToken) &&
      this.authorized(check.providerId, owner, providerToken) &&
      Array.isArray(this.get(check.providerId)?.manifest.agent?.checkSources) &&
      this.get(check.providerId)?.manifest.agent?.checkSources?.includes(check.source) === true;
    if (!ghost || !current()) return { ...check, state: 'unknown' };
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const finish = (state: ChangeCheckState) => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timer);
        resolve({ ...check, state: current() ? state : 'unknown' });
      };
      const timer = setTimeout(() => finish('unknown'), this.deps.timeoutMs ?? 20_000);
      this.pending.set(requestId, { providerId: check.providerId, finish });
      void this.deps
        .wake(ghost)
        .then(() => {
          // Wake may finish after timeout, owner switch, update or disable. Do not send then.
          if (!this.pending.has(requestId)) return;
          if (
            !current() ||
            !this.deps.send(check.providerId, {
              type: 'change-check',
              requestId,
              source: check.source,
              from: check.from,
              to: check.to,
            })
          )
            finish('unknown');
        })
        .catch(() => finish('unknown'));
    });
  }

  result(senderId: string, raw: unknown): void {
    const value = raw as { requestId?: unknown; state?: unknown } | null;
    if (typeof value?.requestId !== 'string') return;
    const pending = this.pending.get(value.requestId);
    if (!pending || pending.providerId !== senderId) return;
    pending.finish(
      value.state === 'changed' || value.state === 'unchanged' ? value.state : 'unknown',
    );
  }

  dispose(): void {
    for (const pending of [...this.pending.values()]) pending.finish('unknown');
    this.lastAttempt.clear();
  }
}
