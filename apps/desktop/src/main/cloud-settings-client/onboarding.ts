import { z } from 'zod';
import { cloudInstanceAccessSchema } from '../../shared/cloudSettingsClient';
import { isCloudRefusal } from '../../shared/cloudSettingsErrors';
import type { CloudClientCaller } from './service';
import {
  CloudClientError,
  isCloudLoginAttemptId,
  type CloudClientHttp,
  type CloudClientIdentity,
} from './transport';
import {
  parseCapacity,
  parseCloud,
  parseOwnedInstances,
  projectCloudInstance,
  projectOwnedInstances,
} from './ownedInstances';

const instancesPath = '/instance-login/api/manage/instances';
const attemptSchema = z.object({ continueUrl: z.string().max(2048) });
export function continuation(baseUrl: string, result: unknown) {
  const { continueUrl } = parseCloud(attemptSchema, result),
    base = new URL(baseUrl);
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !continueUrl.startsWith('/instance-login/#')
  )
    throw new CloudClientError('CLOUD_SETTINGS_INVALID_RESPONSE');
  const url = new URL(continueUrl, base.origin),
    fragment = new URLSearchParams(url.hash.slice(1));
  const id = fragment.get('attemptId'),
    secret = fragment.get('attemptSecret');
  if (
    url.origin !== base.origin ||
    url.pathname !== '/instance-login/' ||
    url.search ||
    Array.from(fragment.keys()).length !== 2 ||
    !isCloudLoginAttemptId(id) ||
    !secret ||
    !/^[A-Za-z0-9_-]{32,256}$/u.test(secret)
  )
    throw new CloudClientError('CLOUD_SETTINGS_INVALID_RESPONSE');
  url.hash = new URLSearchParams({ attemptId: id!, attemptSecret: secret }).toString();
  return { url: url.href, id: id!, secret };
}

/** The existing CIS login page owns SSO and any additional verification. Its
 * short-lived capability goes from Main to the pinned CIS browser page only,
 * never to Renderer, logs or storage. Instance credentials stay on CIS/runtime. */
export function createCloudInstanceOnboarding(deps: {
  identity(): CloudClientIdentity | null;
  http: CloudClientHttp;
  openExternal?: (url: string) => Promise<void>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const active = new Map<AbortController, number>();
  const mutations = new Set<string>();
  const attempts = new Map<
    string,
    { callerId: number; url: string; expires: number; cancel: () => void }
  >();
  function cancelContinuation(baseUrl: string, result: unknown) {
    try {
      const value = continuation(baseUrl, result);
      void deps.http.cancelLogin?.(baseUrl, value.id, value.secret).catch(() => undefined);
    } catch {
      /* Invalid/unconfirmed capabilities are never forwarded. */
    }
  }
  async function perform<T>(
    caller: CloudClientCaller,
    mutation: boolean,
    run: (
      call: (path: string, method?: 'GET' | 'POST', body?: unknown) => Promise<unknown>,
      identity: CloudClientIdentity,
      check: () => void,
    ) => Promise<T>,
  ) {
    caller.assertCurrent();
    const identity = deps.identity();
    if (!identity) throw new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED');
    if (active.size >= 32 || (mutation && mutations.has(identity.key)))
      throw new CloudClientError('CLOUD_SETTINGS_BUSY');
    const controller = new AbortController();
    active.set(controller, caller.id);
    if (mutation) mutations.add(identity.key);
    const check = () => {
      caller.assertCurrent();
      if (controller.signal.aborted || deps.identity()?.key !== identity.key)
        throw new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED');
    };
    const call = async (path: string, method: 'GET' | 'POST' = 'GET', body?: unknown) => {
      check();
      const creatingLogin = path === '/instance-login/api/attempts' && method === 'POST';
      const result = await deps.http.request(
        creatingLogin ? identity : deps.identity()!,
        path,
        method,
        body,
        creatingLogin ? AbortSignal.timeout(8_000) : controller.signal,
        creatingLogin ? () => undefined : check,
      );
      try {
        check();
      } catch (error) {
        if (path === '/instance-login/api/attempts' && method === 'POST')
          cancelContinuation(identity.baseUrl, result);
        throw error;
      }
      return result;
    };
    try {
      return await run(call, identity, check);
    } finally {
      active.delete(controller);
      if (mutation) mutations.delete(identity.key);
    }
  }
  /** One more instance, only while CIS reports the owner below their limit. CIS checks the limit
   * again when it creates the instance. Like the first claim, a lost response or LOGIN_REQUIRED is
   * read back from the list instead of resubmitted. */
  async function claimAnother(
    call: (path: string, method?: 'GET' | 'POST', body?: unknown) => Promise<unknown>,
    check: () => void,
    before: ReturnType<typeof parseOwnedInstances>,
    capacity: ReturnType<typeof parseCapacity>,
  ) {
    if (!capacity) throw new CloudClientError('CLOUD_SETTINGS_UNSUPPORTED');
    if (capacity.used >= capacity.limit) throw new CloudClientError('CLOUD_SETTINGS_QUOTA_EXCEEDED');
    try {
      await call(instancesPath, 'POST', {});
    } catch (error) {
      check();
      if (error instanceof CloudClientError && isCloudRefusal(error.code)) throw error;
    }
    try {
      const after = parseOwnedInstances(await call(instancesPath));
      const known = new Set(before.map((v) => v.deviceId));
      if (after.some((v) => !known.has(v.deviceId)))
        return after.map((v) => projectCloudInstance(v, after));
    } catch {
      check();
    }
    throw new CloudClientError('CLOUD_SETTINGS_SAVE_UNCONFIRMED');
  }
  return {
    access(caller: CloudClientCaller) {
      return perform(caller, false, async (call) =>
        parseCloud(cloudInstanceAccessSchema, await call('/client/access')),
      );
    },
    list(caller: CloudClientCaller) {
      return perform(caller, false, async (call) =>
        projectOwnedInstances(await call(instancesPath)),
      );
    },
    capacity(caller: CloudClientCaller) {
      return perform(caller, false, async (call) => parseCapacity(await call(instancesPath)));
    },
    claim(caller: CloudClientCaller, another = false) {
      return perform(caller, true, async (call, _identity, check) => {
        const raw = await call(instancesPath);
        const before = parseOwnedInstances(raw);
        if (another) return claimAnother(call, check, before, parseCapacity(raw));
        // Do not wake or allocate on entry, errors, or an existing membership.
        if (before.length) return before.map((v) => projectCloudInstance(v, before));
        try {
          // CIS atomically ensures one default instance and chooses image/quota/defaults.
          await call(`${instancesPath}/wake`, 'POST', {});
        } catch (error) {
          check();
          // A refusal creates nothing: say why. LOGIN_REQUIRED persists a record before
          // returning an error, and a lost response can do the same: read back instead of
          // retrying the POST.
          if (error instanceof CloudClientError && isCloudRefusal(error.code)) throw error;
        }
        try {
          const after = parseOwnedInstances(await call(instancesPath));
          if (after.length) return after.map((v) => projectCloudInstance(v, after));
        } catch {
          check();
        }
        throw new CloudClientError('CLOUD_SETTINGS_SAVE_UNCONFIRMED');
      });
    },
    initialize(caller: CloudClientCaller, deviceId: string) {
      return perform(caller, true, async (call, identity, check) => {
        if (!deps.openExternal) throw new CloudClientError('CLOUD_SETTINGS_UNSUPPORTED');
        const target = parseOwnedInstances(await call(instancesPath)).find(
          (v) => v.deviceId === deviceId,
        );
        if (!target) throw new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED');
        if (!target.status.loginRequired) return;
        const org = target.status.ownership?.orgSlug;
        if (!target.status.ownership) throw new CloudClientError('CLOUD_SETTINGS_INVALID_RESPONSE');
        const key = JSON.stringify([identity.key, caller.id, target.instanceId, target.deviceId]);
        for (const [id, value] of attempts)
          if (value.expires <= now()) {
            value.cancel();
            attempts.delete(id);
          }
        let cached = attempts.get(key);
        if (cached) {
          const prior = continuation(identity.baseUrl, {
            continueUrl: cached.url.replace(new URL(cached.url).origin, ''),
          });
          try {
            const state = parseCloud(
              z.object({ status: z.string() }),
              await call(`/instance-login/api/attempts/${prior.id}/status`, 'POST', {
                attemptSecret: prior.secret,
              }),
            );
            if (state.status === 'failed') {
              attempts.delete(key);
              cached = undefined;
            }
          } catch (error) {
            check();
            // The browser may have cancelled/expired the old capability. Only
            // a definite missing attempt permits creating another one.
            if (error instanceof CloudClientError && error.code === 'CLOUD_SETTINGS_NOT_READY') {
              attempts.delete(key);
              cached = undefined;
            } else throw error;
          }
        }
        if (!cached) {
          if (attempts.size >= 32) throw new CloudClientError('CLOUD_SETTINGS_BUSY');
          const createdAt = now();
          const result = parseCloud(
            attemptSchema,
            await call('/instance-login/api/attempts', 'POST', {
              instanceId: target.instanceId,
              ...(target.status.desiredState === 'stopped' && target.status.loginWakeSupported
                ? { wake: true }
                : {}),
              ...(org ? { org } : {}),
            }),
          );
          const value = continuation(identity.baseUrl, result);
          cached = {
            callerId: caller.id,
            url: value.url,
            expires: createdAt + 10 * 60_000,
            cancel: () => cancelContinuation(identity.baseUrl, result),
          };
          attempts.set(key, cached);
        }
        check();
        try {
          await deps.openExternal(cached.url);
        } catch {
          check();
          throw new CloudClientError('CLOUD_SETTINGS_UNAVAILABLE');
        }
        check();
      });
    },
    invalidate(callerId?: number) {
      for (const [controller, id] of active)
        if (callerId === undefined || id === callerId) controller.abort();
      for (const [key, attempt] of attempts)
        if (callerId === undefined || attempt.callerId === callerId) {
          attempt.cancel();
          attempts.delete(key);
        }
    },
  };
}
