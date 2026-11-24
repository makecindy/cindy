import { createCloudInstanceOnboarding } from './onboarding';
import { createCloudInstanceLogin, type CloudLoginDependencies } from './login';
import { createCloudInstanceControl } from './instanceControl';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  cloudClientCapabilitiesSchema,
  cloudClientSessionSchema,
  cloudClientQueueViewSchema,
  type CloudClientOpen,
} from '../../shared/cloudSettingsClient';
import {
  CLOUD_SETTINGS_DOMAINS,
  cloudSettingsDomainSchema,
  type CloudSettingsDomain,
} from '../../shared/cloudSettings';
import {
  settingsWebCommandSchema,
  type SettingsWebCommand,
  type SettingsWebResult,
} from '../../shared/settingsWeb';
import type { ManagementCommand } from '../../shared/settingsManagement';
import { CloudClientError, type CloudClientHttp, type CloudClientIdentity } from './transport';
import { createCloudAuthorizationCallback } from './authorizationCallback';

export interface CloudClientCaller {
  id: number;
  assertCurrent(): void;
}
type Session = {
  owner: string;
  caller: CloudClientCaller;
  handle: string;
  controller: AbortController;
  remote: z.infer<typeof cloudClientSessionSchema>;
  issued: Map<string, { domain: string; revision: string }>;
  writes: Set<string>;
  actions: Map<string, number>;
  authorizations: Set<string>;
  pending: Set<string>;
  callbacks: Map<string, ReturnType<typeof createCloudAuthorizationCallback>>;
  inFlight: number;
  stopKeepAlive?: () => void;
  cancelling?: Promise<void>;
  closing?: Promise<void>;
};
const membershipSnapshot = z.object({
  instances: z
    .array(
      z.object({
        instanceId: z.string().min(1).max(128),
        deviceId: z.string().min(1).max(160),
      }),
    )
    .max(1024),
});
function parsed<S extends z.core.$ZodType>(schema: S, raw: unknown): z.output<S> {
  const result = z.safeParse(schema, raw);
  if (!result.success) throw new CloudClientError('CLOUD_SETTINGS_INVALID_RESPONSE');
  return result.data;
}

export function createCloudSettingsService(deps: {
  identity(): CloudClientIdentity | null;
  http: CloudClientHttp;
  openExternal?: (url: string) => Promise<void>;
  loginAuth?: CloudLoginDependencies['loginAuth'];
  now?: () => number;
  pause?: (signal: AbortSignal) => Promise<void>;
  keepAlive?: (refresh: () => Promise<void>) => () => void;
}) {
  const instances = createCloudInstanceControl(deps);
  const onboarding = createCloudInstanceOnboarding(deps);
  const login = createCloudInstanceLogin(deps);
  const sessions = new Map<string, Session>();
  const opening = new Map<number, AbortController>();
  const now = deps.now ?? Date.now;
  const pause =
    deps.pause ??
    ((signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED'));
          return;
        }
        const finish = () => {
          signal.removeEventListener('abort', abort);
          resolve();
        };
        const timer = setTimeout(finish, 250);
        const abort = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          reject(new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED'));
        };
        signal.addEventListener('abort', abort, { once: true });
      }));
  const capture = (caller: CloudClientCaller, key?: string) => {
    caller.assertCurrent();
    const identity = deps.identity();
    if (!identity || (key !== undefined && identity.key !== key))
      throw new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED');
    return identity;
  };
  const scope = (caller: CloudClientCaller, handle: string) => {
    const session = sessions.get(handle);
    if (!session || session.caller.id !== caller.id || session.controller.signal.aborted)
      throw new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED');
    capture(caller, session.owner);
    session.caller.assertCurrent();
    return session;
  };
  const request = async (
    s: Session,
    suffix: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown,
  ) => {
    const check = () => {
      scope(s.caller, s.handle);
    };
    check();
    const result = await deps.http.request(
      capture(s.caller, s.owner),
      `/client/instances/${encodeURIComponent(s.remote.instanceId)}/settings/sessions/${encodeURIComponent(s.remote.sessionId)}${suffix}`,
      method,
      body,
      s.controller.signal,
      check,
    );
    check();
    return result;
  };
  const remember = (s: Session, result: SettingsWebResult) => {
    if (result.ok && 'settings' in result && result.settings.status === 'ready') {
      const state = result.settings;
      if (s.issued.size >= 256) s.issued.delete(s.issued.keys().next().value!);
      s.issued.set(state.operationId, { domain: state.domain, revision: state.revision });
    }
  };
  const verify = (command: SettingsWebCommand, result: SettingsWebResult) => {
    if (!result.ok) return;
    let valid = false;
    if (command.kind === 'read')
      valid = 'settings' in result && result.settings.domain === command.domain;
    if (command.kind === 'readBatch')
      valid =
        'entries' in result &&
        JSON.stringify([...result.entries.map((v) => v.domain), ...result.remainingDomains]) ===
          JSON.stringify(command.domains);
    if (command.kind === 'update' || command.kind === 'receipt')
      valid =
        'receipt' in result &&
        ('operationId' in result.receipt
          ? result.receipt.operationId ===
              (command.kind === 'update' ? command.change.operationId : command.operationId) &&
            (command.kind !== 'update' || result.receipt.domain === command.change.domain)
          : command.kind === 'receipt');
    if (command.kind === 'manage' && 'management' in result) {
      const c = command.command,
        r = result.management;
      valid =
        c.operation === 'list'
          ? r.kind === 'page' && r.section === c.section && (r.offset ?? 0) === (c.offset ?? 0)
          : r.kind === 'operation' && r.operationId === c.operationId;
    }
    if (!valid) throw new CloudClientError('CLOUD_SETTINGS_INVALID_RESPONSE');
  };
  const send = async (s: Session, input: SettingsWebCommand): Promise<SettingsWebResult> => {
    const command = parsed(settingsWebCommandSchema, input);
    if (s.inFlight >= 4) throw new CloudClientError('CLOUD_SETTINGS_BUSY');
    s.inFlight++;
    const requestId = randomUUID(),
      deadline = now() + 35_000;
    try {
      let raw: unknown;
      try {
        raw = await request(s, '/requests', 'POST', {
          requestId,
          runtimeId: s.remote.runtimeId,
          command,
        });
      } catch (error) {
        if (!(error instanceof CloudClientError) || error.code !== 'CLOUD_SETTINGS_UNAVAILABLE')
          throw error;
        // POST may have been accepted. Query that ID; never submit it again.
        raw = await request(s, `/requests/${requestId}`, 'GET');
      }
      for (let attempt = 0; attempt < 140; attempt++) {
        const view = parsed(cloudClientQueueViewSchema, raw);
        if (view.requestId !== requestId)
          throw new CloudClientError('CLOUD_SETTINGS_INVALID_RESPONSE');
        if (view.status === 'complete' && view.result) {
          verify(command, view.result);
          remember(s, view.result);
          return view.result;
        }
        if (view.status === 'unknown' || now() >= deadline) break;
        // CIS holds a `?wait=1` read until the Host answers (up to 1.5 s), so the first
        // one goes out at once; a fixed pause there would delay every call by 250 ms.
        if (!s.remote.resultWait || attempt > 0) await pause(s.controller.signal);
        raw = await request(
          s,
          `/requests/${requestId}${s.remote.resultWait ? '?wait=1' : ''}`,
          'GET',
        );
      }
      throw new CloudClientError('CLOUD_SETTINGS_SAVE_UNCONFIRMED');
    } finally {
      s.inFlight--;
    }
  };
  const assertDomain = (s: Session, domain: string) => {
    if (
      !cloudSettingsDomainSchema.safeParse(domain).success ||
      !s.remote.domains.includes(domain) ||
      domain === 'personalization' ||
      domain === 'gitSafety'
    )
      throw new CloudClientError('CLOUD_SETTINGS_UNSUPPORTED');
  };
  const manage = async (
    caller: CloudClientCaller,
    handle: string,
    command: ManagementCommand,
  ): Promise<SettingsWebResult> => {
    const s = scope(caller, handle);
    if (!s.remote.managementV1) throw new CloudClientError('CLOUD_SETTINGS_UNSUPPORTED');
    if (command.operation === 'list') {
      if (!['providers', 'bots', 'mcp'].includes(command.section))
        throw new CloudClientError('CLOUD_SETTINGS_UNSUPPORTED');
    } else if (command.operation === 'run') {
      if (
        (s.actions.get(command.actionId) ?? 0) <= now() ||
        s.authorizations.has(command.operationId)
      )
        throw new CloudClientError('CLOUD_SETTINGS_NOT_READY');
      if (s.authorizations.size >= 128) throw new CloudClientError('CLOUD_SETTINGS_BUSY');
      s.actions.delete(command.actionId);
      s.authorizations.add(command.operationId);
      s.pending.add(command.operationId);
    } else if (!s.authorizations.has(command.operationId))
      throw new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED');
    if (command.operation === 'cancel') {
      // Retire the local receiver before any network wait. A late status response
      // must not recreate it while cancellation is in flight.
      s.pending.delete(command.operationId);
      s.callbacks.get(command.operationId)?.close();
    }
    if (command.operation === 'respond')
      s.callbacks.get(command.operationId)?.claimManual(command.value);
    const result = await send(s, { kind: 'manage', command });
    if (result.ok && 'management' in result) {
      const r = result.management;
      if (r.kind === 'page') {
        for (const item of r.items)
          for (const action of item.actions) {
            if (s.actions.size >= 512) s.actions.delete(s.actions.keys().next().value!);
            s.actions.set(action.id, action.expiresAt);
          }
      } else if (!['running', 'waiting'].includes(r.phase)) {
        s.pending.delete(r.operationId);
        s.callbacks.get(r.operationId)?.finish();
      } else if (r.prompt?.kind === 'callback' && s.pending.has(r.operationId)) {
        let callback = s.callbacks.get(r.operationId);
        if (!callback) {
          callback = createCloudAuthorizationCallback({
            prompt: r.prompt,
            now,
            assertCurrent() {
              scope(caller, handle);
              if (s.closing || s.cancelling || !s.pending.has(r.operationId))
                throw new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED');
            },
            async submit(value) {
              const response = await send(s, {
                kind: 'manage',
                command: { operation: 'respond', operationId: r.operationId, value },
              });
              if (
                !response.ok ||
                !('management' in response) ||
                response.management.kind !== 'operation' ||
                !['running', 'waiting', 'succeeded'].includes(response.management.phase)
              )
                throw new CloudClientError('CLOUD_SETTINGS_SAVE_UNCONFIRMED');
            },
          });
          s.callbacks.set(r.operationId, callback);
        }
        if (callback.url !== r.prompt.url)
          throw new CloudClientError('CLOUD_SETTINGS_INVALID_RESPONSE');
        // Renderer may open the URL as soon as this result arrives.
        await callback.ready;
        scope(caller, handle);
      }
    }
    return result;
  };
  const cancel = (caller: CloudClientCaller, handle: string): Promise<void> => {
    const s = scope(caller, handle);
    if (s.cancelling) return s.cancelling;
    // Sequential and bounded, using only IDs created by this window.
    s.cancelling = (async () => {
      for (const operationId of [...s.pending]) {
        try {
          await manage(caller, handle, { operation: 'cancel', operationId });
        } catch {
          /* Lease expiry remains the remote fallback. Never cancel another caller. */
        }
      }
    })().finally(() => {
      s.cancelling = undefined;
    });
    return s.cancelling;
  };
  const discard = (s: Session) => {
    for (const callback of s.callbacks.values()) callback.close();
    s.stopKeepAlive?.();
    sessions.delete(s.handle);
    s.controller.abort();
  };
  return {
    instanceAccess: onboarding.access,
    instanceList: onboarding.list,
    instanceCapacity: onboarding.capacity,
    instanceClaim: onboarding.claim,
    instanceInitialize: onboarding.initialize,
    instanceLoginStart: login.start,
    instanceLoginDispatch: login.dispatch,
    instanceLoginPoll: login.poll,
    instanceLoginClose: login.close,
    instanceRead: instances.read,
    instancePower: instances.power,
    instanceUpgrade: instances.upgrade,
    instancePolicy: instances.policy,
    async open(caller: CloudClientCaller, deviceId: string): Promise<CloudClientOpen> {
      if (sessions.size + opening.size >= 32 || opening.has(caller.id))
        throw new CloudClientError('CLOUD_SETTINGS_BUSY');
      const initial = capture(caller),
        controller = new AbortController();
      opening.set(caller.id, controller);
      const check = () => {
        capture(caller, initial.key);
        if (controller.signal.aborted) throw new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED');
      };
      const call = async (path: string, method: 'GET' | 'POST', body?: unknown) => {
        check();
        const result = await deps.http.request(
          capture(caller, initial.key),
          path,
          method,
          body,
          controller.signal,
          check,
        );
        check();
        return result;
      };
      try {
        const snapshot = parsed(
          membershipSnapshot,
          await call('/instance-login/api/manage/instances', 'GET'),
        );
        const targets = snapshot.instances.filter((v) => v.deviceId === deviceId);
        if (targets.length !== 1) throw new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED');
        const target = targets[0]!;
        const remote = parsed(
          cloudClientSessionSchema,
          await call(
            `/client/instances/${encodeURIComponent(target.instanceId)}/settings/sessions`,
            'POST',
            {},
          ),
        );
        if (remote.deviceId !== deviceId || remote.instanceId !== target.instanceId)
          throw new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED');
        const handle = randomUUID();
        sessions.set(handle, {
          owner: initial.key,
          caller,
          handle,
          controller,
          remote,
          issued: new Map(),
          writes: new Set(),
          actions: new Map(),
          authorizations: new Set(),
          pending: new Set(),
          callbacks: new Map(),
          inFlight: 0,
        });
        const current = sessions.get(handle)!;
        current.stopKeepAlive = deps.keepAlive?.(async () => {
          if (current.closing) return;
          try {
            await request(current, '/heartbeat', 'POST', {});
          } catch (error) {
            // A transient outage does not replay a write. The server lease still
            // expires if connectivity does not recover; stale identity is final.
            if (!(error instanceof CloudClientError) || error.code !== 'CLOUD_SETTINGS_UNAVAILABLE')
              discard(current);
          }
        });
        const cap = cloudClientCapabilitiesSchema.parse(remote);
        return {
          ...cap,
          instanceId: remote.instanceId,
          deviceId: remote.deviceId,
          domains: cap.domains.filter(
            (d) =>
              (CLOUD_SETTINGS_DOMAINS as string[]).includes(d) &&
              !['personalization', 'gitSafety'].includes(d),
          ),
          handle,
          ownerGeneration: initial.generation,
        };
      } finally {
        opening.delete(caller.id);
      }
    },
    async read(
      caller: CloudClientCaller,
      handle: string,
      domains: readonly CloudSettingsDomain[],
    ): Promise<SettingsWebResult[]> {
      const s = scope(caller, handle);
      for (const domain of domains) assertDomain(s, domain);
      const results: SettingsWebResult[] = [];
      if (!s.remote.readBatch) {
        for (const domain of domains) results.push(await send(s, { kind: 'read', domain }));
        return results;
      }
      let remaining = [...domains];
      while (remaining.length) {
        const r = await send(s, { kind: 'readBatch', domains: remaining });
        if (!r.ok || !('entries' in r)) throw new CloudClientError('CLOUD_SETTINGS_UNAVAILABLE');
        for (const entry of r.entries) {
          remember(s, entry.result);
          results.push(entry.result);
        }
        remaining = r.remainingDomains as CloudSettingsDomain[];
      }
      return results;
    },
    async save(
      caller: CloudClientCaller,
      handle: string,
      change: Extract<SettingsWebCommand, { kind: 'update' }>['change'],
    ) {
      const s = scope(caller, handle);
      assertDomain(s, change.domain);
      const issue = s.issued.get(change.operationId);
      if (
        !issue ||
        issue.domain !== change.domain ||
        issue.revision !== change.expectedRevision ||
        s.writes.has(change.operationId)
      )
        throw new CloudClientError('CLOUD_SETTINGS_NOT_READY');
      // An issued operation is sent at most once, so only recent writes need to stay
      // answerable for their receipts.
      s.issued.delete(change.operationId);
      if (s.writes.size >= 256) s.writes.delete(s.writes.keys().next().value!);
      s.writes.add(change.operationId);
      try {
        return await send(s, { kind: 'update', change });
      } catch (error) {
        if (
          error instanceof CloudClientError &&
          ['CLOUD_SETTINGS_SCOPE_CHANGED', 'CLOUD_SETTINGS_UNSUPPORTED'].includes(error.code)
        )
          throw error;
        throw new CloudClientError('CLOUD_SETTINGS_SAVE_UNCONFIRMED');
      }
    },
    receipt(caller: CloudClientCaller, handle: string, operationId: string) {
      const s = scope(caller, handle);
      if (!s.writes.has(operationId)) throw new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED');
      return send(s, { kind: 'receipt', operationId });
    },
    manage,
    cancelAuthorizations: cancel,
    close(caller: CloudClientCaller, handle: string): Promise<void> {
      const s = scope(caller, handle);
      if (s.closing) return s.closing;
      for (const callback of s.callbacks.values()) callback.close();
      s.closing = (async () => {
        try {
          await cancel(caller, handle);
          await request(s, '', 'DELETE');
        } finally {
          discard(s);
        }
      })();
      return s.closing;
    },
    invalidate(callerId?: number) {
      instances.invalidate(callerId);
      onboarding.invalidate(callerId);
      login.invalidate(callerId);
      for (const [id, controller] of opening)
        if (callerId === undefined || id === callerId) controller.abort();
      for (const s of sessions.values())
        if (callerId === undefined || s.caller.id === callerId) discard(s);
    },
  };
}
