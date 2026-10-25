export interface PermissionModeHost {
  captureAccount(): { assertCurrent(): void; isCurrent(): boolean };
  withSessionPermissionChange<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T>;
}
import {
  type PermissionModeChangeResult,
  type PermissionModeCommandContext,
} from "@cindy/im-runtime/permissionModeTypes";
export {
  type PermissionModeChangeResult,
  type PermissionModeCommandContext,
} from "@cindy/im-runtime/permissionModeTypes";
import type {
  PermissionMode,
  PermissionModeDescriptor,
} from "@cindy/maker-core";
import { requiresFullAccessConfirmation } from "@cindy/maker-shared/permission-mode";

import type { ImUiTextPack } from "./types";

export function permissionModeCommandContext(
  sessionId: string,
  currentMode: PermissionMode,
  modes: PermissionModeDescriptor[],
): PermissionModeCommandContext {
  return {
    sessionId,
    currentMode,
    modes,
  };
}

/**
 * Shared by Feishu cards and text-only IM channels. Runtime is changed first so
 * the active turn observes the new mode immediately; a failed DB write rolls it
 * back to keep runtime and persistence consistent.
 */
export async function changeSessionPermissionMode(
  args: {
    sessionId: string;
    mode: PermissionMode;
    modes: readonly PermissionModeDescriptor[];
    confirmedFullAccess?: boolean;
    readPreviousMode(): Promise<PermissionMode | null>;
    getLiveSession(): {
      setPermissionMode(mode: PermissionMode): Promise<void>;
    } | null;
    persist(mode: PermissionMode): Promise<void>;
  },
  host: PermissionModeHost,
): Promise<PermissionModeChangeResult> {
  const descriptor = args.modes.find((candidate) => candidate.id === args.mode);
  if (!args.sessionId || !descriptor) {
    return {
      kind: "invalid",
      reason: `Unsupported permission mode: ${args.mode}`,
    };
  }

  const { assertCurrent, isCurrent } = host.captureAccount();
  return host.withSessionPermissionChange(args.sessionId, async () => {
    assertCurrent();
    const previousMode = await args.readPreviousMode();
    assertCurrent();
    if (!previousMode) return { kind: "invalid", reason: "Session not found" };

    if (
      !args.confirmedFullAccess &&
      requiresFullAccessConfirmation(previousMode, args.mode)
    ) {
      return {
        kind: "confirmation-required",
        mode: args.mode,
        label: descriptor.displayName,
      };
    }

    const live = args.getLiveSession();
    let runtimeChanged = false;
    try {
      if (live) {
        await live.setPermissionMode(args.mode);
        runtimeChanged = true;
      }
      assertCurrent();
      await args.persist(args.mode);
      assertCurrent();
    } catch (error) {
      if (runtimeChanged && live && isCurrent()) {
        try {
          await live.setPermissionMode(previousMode);
        } catch {
          // The original failure is more useful to the caller. Rollback remains
          // best effort, matching the existing Feishu card behavior.
        }
      }
      return {
        kind: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      kind: "changed",
      mode: args.mode,
      label: descriptor.displayName,
      live: Boolean(live),
    };
  });
}

export function resolvePermissionMode(
  modes: readonly PermissionModeDescriptor[],
  rawMode: string,
): PermissionModeDescriptor | null {
  const normalized = rawMode.trim().toLowerCase();
  const alias =
    normalized === "bypass" ||
    normalized === "full" ||
    normalized === "full-access"
      ? "bypasspermissions"
      : normalized;
  return modes.find((mode) => mode.id.toLowerCase() === alias) ?? null;
}

export function renderTextPermissionModePicker(
  ui: ImUiTextPack,
  context: PermissionModeCommandContext,
): string {
  const current =
    context.modes.find((mode) => mode.id === context.currentMode) ??
    ({
      id: context.currentMode,
      displayName: context.currentMode,
      description: "",
    } satisfies PermissionModeDescriptor);
  const options = context.modes
    .map((mode) => {
      const description = mode.description ? ` — ${mode.description}` : "";
      return `/permission ${mode.id} — ${mode.displayName}${description}`;
    })
    .join("\n");
  return [
    ui.cards.permissionMode.title,
    ui.cards.permissionMode.currentLine(
      current.displayName,
      current.description ?? "",
    ),
    ui.cards.permissionMode.hint,
    options,
  ].join("\n\n");
}

export function renderTextPermissionModeResult(
  ui: ImUiTextPack,
  result: PermissionModeChangeResult,
): string {
  if (result.kind === "changed")
    return ui.cards.permissionMode.resolved(result.label);
  if (result.kind === "confirmation-required") {
    return [
      ui.cards.permissionMode.fullAccessConfirmTitle,
      ui.cards.permissionMode.fullAccessConfirmBody,
      `${ui.cards.permissionMode.btnConfirmFullAccess}: /permission ${result.mode} confirm`,
      `${ui.cards.permissionMode.btnCancelFullAccess}: ${ui.cards.permissionMode.fullAccessCancelled}`,
    ].join("\n\n");
  }
  return ui.cards.permissionMode.failed(result.reason);
}
