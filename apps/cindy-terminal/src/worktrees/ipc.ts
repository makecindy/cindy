import path from "node:path";
import type { TerminalWorktrees } from "./host.js";
import type { TerminalTaskMeta } from "../tasks/storage.js";
import type { InvocationContext } from "../contracts.js";
import { TerminalRemoteError } from "../remote/types.js";

export const WORKTREE_CHANNELS = [
  "worktree:create",
  "worktree:detect-cwd",
  "worktree:get-for-session",
  "worktree:list-all",
  "worktree:suggest-name",
  "worktree:list-branches",
  "worktree:removal-preview",
  "worktree:restore-status",
  "worktree:restore-for-session",
  "worktree:discard-precreated",
  "worktree:cancel-precreated",
] as const;

const invalid = (): never => {
  throw new TerminalRemoteError("INVALID_PARAMS", "Invalid worktree request");
};
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid();
const text = (value: unknown, max = 4096): string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  !value.includes("\0")
    ? value
    : invalid();
const id = (value: unknown): string => {
  const result = text(value, 100);
  return /^[a-zA-Z0-9_-]+$/.test(result) ? result : invalid();
};
const directory = (value: unknown): string => {
  const result = text(value);
  return path.isAbsolute(result) ? result : invalid();
};

export function createTerminalWorktreeIpc(options: {
  host(): TerminalWorktrees;
  guard(context: InvocationContext): void;
  task(id: string): Promise<TerminalTaskMeta | null>;
  withTaskLock<T>(id: string, action: () => Promise<T>): Promise<T>;
  changed(id: string): void;
}) {
  return async (
    channel: string,
    args: unknown[],
    context: InvocationContext,
  ) => {
    options.guard(context);
    if (
      context.sharedTask ||
      (context.source === "remote" &&
        (!context.ownerId || !context.deviceId || !context.assertCurrent))
    ) {
      throw new TerminalRemoteError(
        "PERMISSION_DENIED",
        "Worktree management requires the device owner",
      );
    }
    const host = options.host();
    switch (channel) {
      case "worktree:detect-cwd":
        return host.manager.detectCwd(directory(object(args[0]).cwd));
      case "worktree:list-all":
        return host.manager.listAll();
      case "worktree:get-for-session":
        return host.manager.getForSession(id(args[0]));
      case "worktree:removal-preview":
        return host.manager.getRemovalPreview(id(args[0]));
      case "worktree:restore-status":
        return host.restore.getWorktreeRestoreStatus(id(args[0]));
      case "worktree:suggest-name":
        return {
          name: await host.manager.suggestName(
            directory(object(args[0]).baseRepo),
          ),
        };
      case "worktree:list-branches":
        return host.manager.listBranches(directory(object(args[0]).baseRepo));
      case "worktree:create": {
        const input = object(args[0]),
          sessionId = id(input.sessionId);
        if (
          input.ephemeral !== undefined &&
          typeof input.ephemeral !== "boolean"
        )
          invalid();
        const request = {
          sessionId,
          baseRepo: directory(input.baseRepo),
          name:
            typeof input.name === "string" &&
            input.name.length <= 100 &&
            !input.name.includes("\0")
              ? input.name
              : invalid(),
          sourceBranch: text(input.sourceBranch, 1024),
          ...(input.recoveryKey === undefined
            ? {}
            : { recoveryKey: text(input.recoveryKey, 256) }),
          ...(input.ephemeral === undefined
            ? {}
            : { ephemeral: input.ephemeral as boolean }),
        };
        return options.withTaskLock(sessionId, async () => {
          options.guard(context);
          const result = await host.manager.createWorktree(request);
          options.guard(context);
          if (result.ok) options.changed(sessionId);
          return result;
        });
      }
      case "worktree:restore-for-session": {
        const sessionId = id(args[0]);
        return options.withTaskLock(sessionId, async () => {
          options.guard(context);
          const result =
            await host.restore.restoreWorktreeForSession(sessionId);
          options.guard(context);
          if (result.ok) options.changed(sessionId);
          return result;
        });
      }
      case "worktree:discard-precreated":
      case "worktree:cancel-precreated": {
        const input = object(args[0]),
          sessionId = id(input.sessionId);
        if ((input.path !== undefined) === (input.recoveryKey !== undefined))
          invalid();
        const locator =
          input.path !== undefined
            ? { path: directory(input.path) }
            : { recoveryKey: text(input.recoveryKey, 256) };
        return options.withTaskLock(sessionId, async () => {
          const unclaimed = async () => {
            options.guard(context);
            return !(await options.task(sessionId));
          };
          if (!(await unclaimed()))
            throw new TerminalRemoteError(
              "PRECONDITION_FAILED",
              "The task already owns this worktree",
            );
          const gate = { canRemove: unclaimed };
          const result =
            channel === "worktree:cancel-precreated"
              ? await host.manager.cancelPrecreatedWorktree(
                  sessionId,
                  locator,
                  gate,
                )
              : locator.path !== undefined
                ? await host.manager.discardPrecreatedWorktree(
                    sessionId,
                    locator.path,
                    gate,
                  )
                : await host.manager.discardPrecreatedWorktreeByRecoveryKey(
                    sessionId,
                    locator.recoveryKey!,
                    gate,
                  );
          options.guard(context);
          if (result.status === "path-mismatch")
            throw new TerminalRemoteError(
              "PERMISSION_DENIED",
              "Worktree recovery locator does not match",
            );
          options.changed(sessionId);
          return result;
        });
      }
      default:
        throw new TerminalRemoteError(
          "CHANNEL_NOT_ALLOWED",
          "Worktree operation unavailable",
        );
    }
  };
}
