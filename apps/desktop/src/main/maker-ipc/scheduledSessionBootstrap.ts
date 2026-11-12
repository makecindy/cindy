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
 * The scheduler captures the owner at fire entry and passes its guard through the
 * host checks into this bootstrap. `assertAccess` runs between bootstrap awaits,
 * so switching accounts during preparation or creation cannot start under a new owner.
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
  assertOwner?: () => void,
) => CreateResult;

export function captureScheduledOwnerGuard(): () => void {
  const ownerScope = captureDataOwnerBroadcastScope();
  return () => {
    if (!isDataOwnerBroadcastScopeCurrent(ownerScope)) {
      throw new Error('Scheduled session owner changed');
    }
  };
}

export function createScheduledSessionBootstrap(
  bootstrapSession: ScheduledSessionStarter,
): ScheduledSessionBootstrap {
  return async (createOpts, signal, assertOwner = captureScheduledOwnerGuard()) => {
    const assertCurrent = () => {
      signal?.throwIfAborted();
      assertOwner();
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
