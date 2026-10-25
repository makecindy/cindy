import type {
  PermissionMode,
  PermissionModeDescriptor,
} from "@cindy/maker-core";

export type PermissionModeChangeResult =
  | { kind: "changed"; mode: PermissionMode; label: string; live: boolean }
  | { kind: "confirmation-required"; mode: PermissionMode; label: string }
  | { kind: "invalid"; reason: string }
  | { kind: "failed"; reason: string };

export interface PermissionModeCommandContext {
  sessionId: string;
  currentMode: PermissionMode;
  modes: PermissionModeDescriptor[];
}
