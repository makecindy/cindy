/**
 * Automation (schedule) session startup: the same funnel as ordinary tasks, plus a
 * fail-closed data-owner guard for the duration of that bootstrap.
 *
 * The owner snapshot must be taken **per fire**. Maker IPC handlers register during
 * startup, and the app session commit that restores the account can land after that
 * registration (update relaunch, slow cold start). A snapshot captured at registration
 * time is therefore stale for the whole process, and every automation then fails with
 * "Scheduled session owner changed" until the app restarts.
 *
 * Taking the snapshot here still catches a real owner switch: `assertAccess` is called
 * between the awaits inside the bootstrap, so an account switch mid-creation aborts.
 * Account switches that go through authManager's owner commit also tear the scheduler
 * down and abort in-flight fires, so this guard covers one bootstrap window. Volatile
 * owner commits on the passive/host-delegated paths do not reset the scheduler; there
 * the maker start gate (`ACCOUNT_PROVIDER_NOT_READY`) is what stops a stale fire.
 */
import type { Maker } from '@cindy/maker-core';

import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
} from '../device-link/broadcast-tap.js';

type CreateOpts = Parameters<Maker['createSession']>[0];
type CreateResult = ReturnType<Maker['createSession']>;

/** Startup funnel shared with ordinary tasks (group allocation may rewrite options).
 * `assertAccess` is required by this signature, and the register.ts wiring is pinned
 * by a source contract test: dropping the forwarder would silently downgrade the
 * owner guard to the single entry check (TypeScript alone cannot enforce it). */
export type ScheduledSessionStarter = (
  options: CreateOpts,
  assertAccess: () => void,
) => Promise<{ session: Awaited<CreateResult> }>;

export type ScheduledSessionBootstrap = (
  options: CreateOpts,
  signal?: AbortSignal,
) => CreateResult;

export function createScheduledSessionBootstrap(
  bootstrapSession: ScheduledSessionStarter,
): ScheduledSessionBootstrap {
  return async (createOpts, signal) => {
    const ownerScope = captureDataOwnerBroadcastScope();
    const assertCurrent = () => {
      signal?.throwIfAborted();
      if (!isDataOwnerBroadcastScopeCurrent(ownerScope)) {
        throw new Error('Scheduled session owner changed');
      }
    };
    assertCurrent();
    const prepared: CreateOpts = { ...createOpts };
    const { session } = await bootstrapSession(prepared, assertCurrent);
    // Keep the caller's routing metadata aligned with the group-selected member.
    createOpts.agentDeviceId = prepared.agentDeviceId;
    createOpts.providerId = prepared.providerId;
    return session;
  };
}
