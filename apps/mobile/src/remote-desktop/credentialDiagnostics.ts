import { mobileDebugLog } from "@/debug/mobileDebugLog";

type Stage =
  | "enable-face-id"
  | "change-face-id"
  | "scope"
  | "access-token"
  | "read-settings"
  | "open-link"
  | "host-prepare"
  | "phone-configure"
  | "phone-begin"
  | "host-open"
  | "phone-accept"
  | "ready-exchange"
  | "password-or-face-id"
  | "authentication-exchange"
  | "host-exchange"
  | "phone-reply-and-save";
const codes = [
  "CREDENTIAL_DEVELOPMENT_SIGNING_REQUIRED",
  "CREDENTIAL_INVALID_MESSAGE",
  "CREDENTIAL_INVALID_IDENTITY",
  "CREDENTIAL_UNAVAILABLE",
  "CREDENTIAL_APPLICATION_INACTIVE",
  "CREDENTIAL_AUTHENTICATION_BUSY",
  "CREDENTIAL_SAVED_PASSWORD_MISSING",
  "CREDENTIAL_SAVED_BINDING_CHANGED",
  "CREDENTIAL_SAVED_READ_DENIED",
  "CREDENTIAL_SAVED_INTERACTION_REQUIRED",
  "CREDENTIAL_SAVED_READ_FAILED",
  "CREDENTIAL_EXPIRED",
  "CREDENTIAL_CANCELLED",
  "CREDENTIAL_PASSWORD_REJECTED",
  "CREDENTIAL_ACCESSIBILITY_REQUIRED",
  "CREDENTIAL_UNLOCK_UNAVAILABLE",
  "CREDENTIAL_NATIVE_UPGRADE_REQUIRED",
  "DEVICE_LINK_TIMEOUT",
  "DEVICE_LINK_OFFLINE",
] as const;

/** Only fixed codes reach the journal. Native/transport errors can contain secrets. */
export function credentialDiagnosticCode(error: unknown): string {
  try {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "";
    const code =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "";
    return (
      codes.find((value) =>
        new RegExp(`\\b${value}\\b`).test(`${code} ${message}`),
      ) ?? "UNKNOWN"
    );
  } catch {
    return "UNKNOWN";
  }
}

/** Trace timings only; never inspect the action's arguments or return value. */
export async function credentialStep<T>(
  stage: Stage,
  action: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  mobileDebugLog("info", "device-link", "auto-unlock", {
    stage,
    phase: "start",
  });
  try {
    const result = await action();
    mobileDebugLog("info", "device-link", "auto-unlock", {
      stage,
      phase: "complete",
      elapsedMs: Date.now() - started,
    });
    return result;
  } catch (error) {
    mobileDebugLog("warn", "device-link", "auto-unlock", {
      stage,
      phase: "failed",
      elapsedMs: Date.now() - started,
      code: credentialDiagnosticCode(error),
    });
    throw error;
  }
}
