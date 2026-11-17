import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import {
  parseProviderSharePeer,
  providerShareGuestPeer,
  type RemoteAgentFastPolicy,
} from '@cindy/device-link';
import { createLogger } from '../logger.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsFile,
} from '../maker-host/override-settings-file.js';
import { hostSessionIdFor } from '../remote-agent/host/sessionIdentity.js';

interface Policy {
  revision: number;
  allowFast: boolean;
  confirmedAt?: number;
  local?: boolean;
}
interface Outgoing extends Policy {
  targets: Record<string, number>;
  members?: string[];
}
interface State {
  sources: Record<string, Policy>;
  bindings: Record<string, Record<string, string>>;
  outgoing: Record<string, Outgoing>;
  unreadable?: true;
}
interface BindingShard {
  bindings: State['bindings'];
  unreadable?: true;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const empty = (): State => ({ sources: {}, bindings: {}, outgoing: {} });

/** Per-owner durable constraints. A reconnect cannot erase a prohibition or reuse another guest's binding. */
export function createGroupFastPolicyStore(options: {
  filePath(): string; scopeKey(): string;
  clock?: { wall(): number; mono(): number };
}) {
  const lifetime = 30 * 60_000;
  const wallNow = () => options.clock?.wall() ?? Date.now();
  const monoNow = () => options.clock?.mono() ?? performance.now();
  // Wall time survives a restart; monotonic time prevents a clock rollback from
  // extending trust in this process. Bind/read operations never renew a source.
  // The singleton can load before account initialization. Bind each empty
  // in-memory map to the current owner on its first use, not during import.
  let deadlineOwner: string | undefined;
  const deadlines = new Map<string, { confirmedAt: number; wall: number; mono: number; expired: boolean }>();
  let suppressionOwner: string | undefined;
  const suppressed = new Map<string, Set<string>>();
  const requiredOrigins = new Map<string, string>();
  const suppression = () => {
    if (suppressionOwner !== options.scopeKey()) { suppressed.clear(); requiredOrigins.clear(); suppressionOwner = options.scopeKey(); }
    return suppressed;
  };
  const suppressSource = (task: string, source: string) => {
    const entries = suppression();
    const pending = entries.get(task) ?? new Set<string>();
    pending.add(source);
    entries.set(task, pending);
  };
  const fresh = (source: string, policy: Policy) => {
    if (!Number.isFinite(policy.confirmedAt) || policy.confirmedAt! > wallNow()) return false;
    if (deadlineOwner !== options.scopeKey()) {
      deadlines.clear();
      deadlineOwner = options.scopeKey();
    }
    let deadline = deadlines.get(source);
    if (!deadline || deadline.confirmedAt !== policy.confirmedAt) {
      const wall = policy.confirmedAt! + lifetime;
      deadline = { confirmedAt: policy.confirmedAt!, wall,
        mono: monoNow() + Math.max(0, Math.min(lifetime, wall - wallNow())), expired: false };
      deadlines.set(source, deadline);
    }
    deadline.expired ||= wallNow() >= deadline.wall || monoNow() >= deadline.mono;
    return !deadline.expired;
  };
  // Keep resumable tasks' constraints without putting every task in one bounded
  // settings file. Shards use the same atomic/owner-guarded writer as policies.
  // Legacy bindings remain readable; no age-based eviction can restore Fast.
  const shards = new Map<string, OverrideSettingsFile<BindingShard>>();
  const bindingShard = (sessionId: string) => {
    const key = createHash('sha256').update(sessionId).digest('hex').slice(0, 2);
    let shard = shards.get(key);
    if (!shard) {
      const filePath = () => path.join(`${options.filePath()}.bindings`, `${key}.json`);
      shard = createOverrideSettingsFile<BindingShard>({
        filePath,
        scopeKey: options.scopeKey,
        defaults: () => {
          try {
            fs.statSync(filePath());
            return { bindings: {}, unreadable: true };
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? { bindings: {} }
              : { bindings: {}, unreadable: true };
          }
        },
        normalize: (raw) =>
          object(raw) &&
          object(raw.bindings) &&
          Object.values(raw.bindings).every(
            (binding) =>
              object(binding) &&
              Object.values(binding).every((source) => typeof source === 'string'),
          )
            ? { bindings: raw.bindings as State['bindings'] }
            : { bindings: {}, unreadable: true },
        log: createLogger('group-fast-bindings'),
        label: 'group-fast-bindings',
        maxBytes: 4 * 1024 * 1024,
        preserveUnreadableFile: true,
        logLoadedValue: false,
        logReadErrorDetails: false,
      });
      shards.set(key, shard);
    }
    return shard;
  };
  const store = createOverrideSettingsFile<State>({
    ...options,
    defaults: () => {
      try {
        fs.statSync(options.filePath());
        return { ...empty(), unreadable: true };
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? empty()
          : { ...empty(), unreadable: true };
      }
    },
    normalize(raw) {
      if (!object(raw) || !object(raw.sources) || !object(raw.bindings) || !object(raw.outgoing))
        return { ...empty(), unreadable: true };
      const valid =
        Object.values(raw.sources).every(
          (p) => object(p) && Number.isSafeInteger(p.revision) && typeof p.allowFast === 'boolean'
            && (p.confirmedAt === undefined || typeof p.confirmedAt === 'number' && Number.isFinite(p.confirmedAt))
            && (p.local === undefined || typeof p.local === 'boolean'),
        ) &&
        Object.values(raw.bindings).every(
          (b) =>
            object(b) &&
            Object.values(b).every(
              (key) => typeof key === 'string' && Object.hasOwn(raw.sources as object, key),
            ),
        ) &&
        Object.values(raw.outgoing).every(
          (p) =>
            object(p) &&
            Number.isSafeInteger(p.revision) &&
            typeof p.allowFast === 'boolean' &&
            object(p.targets) &&
            Object.values(p.targets).every(Number.isSafeInteger) &&
            (p.members === undefined ||
              (Array.isArray(p.members) && p.members.every((d) => typeof d === 'string'))),
        );
      return valid
        ? ({
            sources: raw.sources,
            bindings: raw.bindings,
            outgoing: raw.outgoing,
          } as unknown as State)
        : { ...empty(), unreadable: true };
    },
    log: createLogger('group-fast-policy'),
    label: 'group-fast-policy',
    maxBytes: 4 * 1024 * 1024,
    preserveUnreadableFile: true,
    logLoadedValue: false,
    logReadErrorDetails: false,
  });
  const read = () => {
    store.invalidateIfChanged();
    return store.read();
  };
  const writable = (value: State) => {
    if (value.unreadable) throw new Error('Group Fast policy could not be read');
  };
  return {
    requireOrigin(sessionId: string, origin: string) {
      suppression();
      requiredOrigins.set(sessionId, origin);
    },
    suppress(sessionId: string, origin: string, group: string) {
      suppressSource(sessionId, JSON.stringify([origin, group]));
    },
    received(origin: string, group: string): Policy | null {
      const value = read();
      const source = value.sources[JSON.stringify([origin, group])];
      return !value.unreadable && source && fresh(JSON.stringify([origin, group]), source)
        ? { revision: source.revision, allowFast: source.allowFast } : null;
    },
    allows(sessionId: string, required = false): boolean {
      const value = read();
      const shard = bindingShard(sessionId);
      shard.invalidateIfChanged();
      const bindings = shard.read();
      const sources = Object.values({ ...value.bindings[sessionId], ...bindings.bindings[sessionId] });
      suppression();
      const origin = requiredOrigins.get(sessionId);
      const prefix = origin ? `${JSON.stringify([origin]).slice(0, -1)},` : undefined;
      return (
        !value.unreadable &&
        !bindings.unreadable &&
        !suppression().get(sessionId)?.size &&
        // M's own live permission is a ceiling, not evidence that O has
        // confirmed this group task. A local default cannot fill a missing O.
        (!required || sources.some(source => !!value.sources[source] && value.sources[source].local !== true
          && (!prefix || source.startsWith(prefix)))) &&
        sources.every(
          (source) => value.sources[source]?.allowFast === true
            && (value.sources[source].local === true || fresh(source, value.sources[source])),
        )
      );
    },
    async receive(
      origin: string,
      command: RemoteAgentFastPolicy,
      selfDeviceId: string | null,
      assertCurrent: () => void,
      trustedLocalTask?: string,
      cached = false,
      local = false,
    ): Promise<Policy> {
      const source = JSON.stringify([origin, command.group]);
      const receivedAt = wallNow();
      const receivedMono = monoNow();
      assertCurrent();
      writable(read());
      let boundTask: string | undefined;
      const failedWrite = (error: unknown): never => {
        assertCurrent();
        if (boundTask) suppressSource(boundTask, source);
        throw error;
      };
      if (command.binding) {
        const peer = parseProviderSharePeer(origin);
        const device = command.binding.controllerDeviceId;
        // A guest cannot choose another member's or the owner's task namespace.
        const controller = device
          ? peer?.role === 'guest'
            ? providerShareGuestPeer(peer.shareId, peer.memberId, device)
            : device
          : origin;
        const scope = command.binding.relay
          ? `${controller}\0relay:${command.binding.relay}`
          : controller;
        const task =
          trustedLocalTask ??
          (!peer && device === selfDeviceId && !command.binding.relay
            ? command.binding.sessionId
            : hostSessionIdFor(scope, command.binding.sessionId));
        boundTask = task;
        // Persist the binding first. A missing/uncommitted source is denied by
        // allows(), and an ACK is returned only after both writes are durable.
        await bindingShard(task).updateAtomic(({ value }) => {
          assertCurrent();
          if (value.unreadable) throw new Error('Group Fast bindings could not be read');
          return {
            bindings: { ...value.bindings, [task]: { ...value.bindings[task], [origin]: source } },
          };
        }).catch(failedWrite);
      }
      if (cached) {
        assertCurrent();
        return read().sources[source] ?? { revision: command.revision, allowFast: false };
      }
      const value = await store.updateAtomic(({ value }) => {
        assertCurrent();
        writable(value);
        const sources = { ...value.sources };
        const previous = sources[source];
        if (!previous || command.revision > previous.revision)
          sources[source] = { revision: command.revision, allowFast: command.allowFast,
            confirmedAt: receivedAt, ...(local && origin === selfDeviceId ? { local: true } : {}) };
        // Equal revisions with conflicting values may only tighten, never loosen.
        else if (command.revision === previous.revision && !command.allowFast)
          sources[source] = { ...previous, allowFast: false, confirmedAt: receivedAt };
        else if (command.revision === previous.revision)
          sources[source] = { ...previous, confirmedAt: receivedAt };
        if (local && origin === selfDeviceId) sources[source] = { ...sources[source], local: true };
        return { sources };
      }).catch(failedWrite);
      assertCurrent();
      if (boundTask) {
        const entries = suppression();
        if (value.sources[source].revision === command.revision
          && value.sources[source].allowFast === command.allowFast) {
          entries.get(boundTask)?.delete(source);
          if (!entries.get(boundTask)?.size) entries.delete(boundTask);
        } else {
          // Every binding entry shares this confirmation rule, including
          // independent fast-policy/relay and delegated grants. A stale ACK
          // cannot authorize Fast, even when its sender continues best-effort.
          suppressSource(boundTask, source);
        }
      }
      if (command.revision === value.sources[source].revision && value.sources[source].confirmedAt === receivedAt) {
        if (deadlineOwner !== options.scopeKey()) { deadlines.clear(); deadlineOwner = options.scopeKey(); }
        deadlines.set(source, { confirmedAt: receivedAt, wall: receivedAt + lifetime,
          mono: receivedMono + lifetime, expired: false });
      }
      return value.sources[source];
    },
    async prepare(
      group: string,
      allowFast: boolean,
      destinations: readonly string[],
      assertCurrent: () => void,
      replaceMembers = false,
    ): Promise<Outgoing> {
      assertCurrent();
      const snapshot = read();
      writable(snapshot);
      const previous = snapshot.outgoing[group];
      const members = replaceMembers ? [...new Set(destinations)].sort() : undefined;
      // Retrying an unacknowledged revision is a read, not a mutation. Avoid
      // updateAtomic's forced cache invalidation and disk write in this case.
      // Real changes still recompute from the latest snapshot under its lock.
      if (
        previous &&
        previous.allowFast === allowFast &&
        (!replaceMembers || JSON.stringify(previous.members) === JSON.stringify(members)) &&
        destinations.every((device) => previous.targets[device] !== undefined)
      ) {
        return previous;
      }
      const value = await store.updateAtomic(({ value }) => {
        assertCurrent();
        writable(value);
        const previous = value.outgoing[group];
        const nextMembers = replaceMembers ? members : previous?.members;
        const sameMembers =
          !replaceMembers || JSON.stringify(previous?.members) === JSON.stringify(nextMembers);
        const revision =
          previous && previous.allowFast === allowFast && sameMembers
            ? previous.revision
            : (previous?.revision ?? 0) + 1;
        const targets = { ...previous?.targets };
        for (const device of destinations) targets[device] ??= -1;
        return {
          outgoing: {
            ...value.outgoing,
            [group]: {
              revision,
              allowFast,
              targets,
              ...(nextMembers ? { members: nextMembers } : {}),
            },
          },
        };
      });
      assertCurrent();
      return value.outgoing[group];
    },
    async acknowledge(group: string, device: string, revision: number, assertCurrent: () => void) {
      await store.updateAtomic(({ value }) => {
        assertCurrent();
        writable(value);
        const current = value.outgoing[group];
        if (!current || current.revision !== revision) return {};
        const targets = { ...current.targets, [device]: revision };
        // Retain an offline member until its release is confirmed. Once it has
        // acknowledged the release, future group changes no longer concern it.
        if (current.members && !current.members.includes(device)) delete targets[device];
        return {
          outgoing: {
            ...value.outgoing,
            [group]: { ...current, targets },
          },
        };
      });
    },
    /** Only after permanent guest-history purge; never on ordinary close/idle. */
    async forgetSessions(sessionIds: readonly string[], assertCurrent: () => void): Promise<void> {
      assertCurrent();
      for (const id of sessionIds) { suppression().delete(id); requiredOrigins.delete(id); }
      if (!sessionIds.length) return;
      await store.updateAtomic(({ value }) => {
        assertCurrent();
        writable(value);
        const bindings = { ...value.bindings };
        for (const id of sessionIds) delete bindings[id];
        return { bindings };
      });
      const byShard = new Map<OverrideSettingsFile<BindingShard>, string[]>();
      for (const id of sessionIds) {
        const shard = bindingShard(id);
        const ids = byShard.get(shard) ?? [];
        ids.push(id);
        byShard.set(shard, ids);
      }
      for (const [shard, ids] of byShard) {
        await shard.updateAtomic(({ value }) => {
          assertCurrent();
          if (value.unreadable) throw new Error('Group Fast bindings could not be read');
          const bindings = { ...value.bindings };
          for (const id of ids) delete bindings[id];
          return { bindings };
        });
      }
      assertCurrent();
    },
    outgoing: () => read().outgoing,
  };
}

export const groupFastPolicyStore = createGroupFastPolicyStore({
  filePath: () => ownerScopedUserDataPath('provider-group-fast-policy.json'),
  scopeKey: activeOwnerScopeKey,
});
