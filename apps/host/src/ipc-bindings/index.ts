/**
 * Host handlers for the registered desktop IPC channels
 * (`@cindy/maker-shared/host-ipc-registry`), one file per registry family.
 *
 * Family keys match HOST_IPC_FAMILIES and stay sorted; the route test checks
 * that each family binds exactly its own channels. main.ts only passes deps.
 *
 * A handler receives the positional arguments after the route checked them.
 * It has no context yet (caller, owner stamp, AbortSignal): add one before
 * binding a write or a long-running read (see hostIpcRegistry.ts).
 */

import {
  MAKER_SESSION_BACKGROUND_TASKS_RESULT_FIELDS,
  makerSessionBackgroundTasksIpcBindings,
  type MakerSessionBackgroundTasksDeps,
} from './maker-session-background-tasks.js';
import { MAKER_SIDE_CHAT_RESULT_FIELDS, makerSideChatIpcBindings } from './maker-side-chat.js';

export type HostIpcBinding = (args: readonly unknown[]) => unknown;

/**
 * Every property of `T`, marked the way the registry schema marks it. Used with
 * `satisfies` on a literal table, so a property added to or removed from `T`,
 * or one that changes between optional and required, fails type checking.
 */
export type ResultFields<T> = { readonly [K in keyof T]-?: {} extends Pick<T, K> ? 'optional' : 'required' };

/**
 * Per channel, one table per object in the result schema, keyed by its schema
 * path (`result`, `result[]`, `result.tasks[]`). The route test requires a
 * table for every object a registered result contains and compares them with
 * the schema, so a type change in the code that produces a result fails the
 * build or the tests instead of only logging `result_mismatch` at run time.
 */
export type HostIpcResultFields = Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, 'optional' | 'required'>>>>>>;

export const HOST_IPC_RESULT_FIELDS: HostIpcResultFields = {
  ...MAKER_SESSION_BACKGROUND_TASKS_RESULT_FIELDS,
  ...MAKER_SIDE_CHAT_RESULT_FIELDS,
};

export type HostIpcBindingsDeps = MakerSessionBackgroundTasksDeps;

/** Bindings per registry family, keyed by family name. */
export function createHostIpcFamilyBindings(deps: HostIpcBindingsDeps): Record<string, Record<string, HostIpcBinding>> {
  return {
    'maker-session-background-tasks': makerSessionBackgroundTasksIpcBindings(deps),
    'maker-side-chat': makerSideChatIpcBindings(),
  };
}

/** Flat channel → handler table for createHostIpcRoute; a channel bound twice is a startup error. */
export function mergeHostIpcBindings(families: Record<string, Record<string, HostIpcBinding>>): Record<string, HostIpcBinding> {
  const merged: Record<string, HostIpcBinding> = {};
  for (const [family, bindings] of Object.entries(families)) {
    for (const [channel, handler] of Object.entries(bindings)) {
      if (Object.prototype.hasOwnProperty.call(merged, channel)) {
        throw new Error(`Host IPC channel ${channel} is bound twice (again in ${family})`);
      }
      merged[channel] = handler;
    }
  }
  return merged;
}

export function createHostIpcBindings(deps: HostIpcBindingsDeps): Record<string, HostIpcBinding> {
  return mergeHostIpcBindings(createHostIpcFamilyBindings(deps));
}
