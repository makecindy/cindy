import {
  REMOTE_DESKTOP_CHANNEL,
  type RemoteCredentialRequest,
  type RemoteDesktopRequest,
} from "@cindy/device-link";
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from "@/auth/authOwnerGeneration";
import { remoteCredentials } from "../../modules/cindy-remote-credentials/src";
import { credentialStep } from "./credentialDiagnostics";

type Invoke = <T>(
  deviceId: string,
  channel: string,
  args: unknown[],
  options?: { preSend?: () => void },
) => Promise<T>;
type Received = {
  kind: string;
  saved?: boolean;
  accepted?: boolean;
  id?: string;
  body?: string;
  success?: boolean;
};
export function isCredentialFailure(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  return /CREDENTIAL_[A-Z_]+|DESKTOP_AUTHENTICATION_REQUIRED/.test(
    `${code} ${String(error)}`,
  );
}

export function credentialErrorKey(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  const text = `${code} ${String(error)}`;
  if (text.includes("CREDENTIAL_PASSWORD_REJECTED"))
    return "credentialPasswordRejected";
  if (text.includes("CREDENTIAL_CANCELLED")) return "credentialCancelled";
  if (text.includes("CREDENTIAL_INVALID_IDENTITY"))
    return "credentialIdentityChanged";
  if (text.includes("CREDENTIAL_EXPIRED")) return "credentialExpired";
  if (text.includes("CREDENTIAL_ACCESSIBILITY_REQUIRED"))
    return "credentialAccessibilityRequired";
  if (text.includes("CREDENTIAL_UNLOCK_UNAVAILABLE"))
    return "credentialUnlockUnavailable";
  return "credentialRequired";
}

/** Media leases may be recreated without recreating this security session. */
export class RemoteDesktopCredentialSession {
  private state: {
    handle: string;
    host: string;
    target: string;
    owner: ReturnType<typeof getMobileAuthOwner>;
    authenticated: boolean;
    pending: boolean;
  } | null = null;
  private epoch = 0;
  private transport: Invoke | null = null;

  matches(handle: string): boolean {
    return this.state?.handle === handle;
  }
  invalidate(): void {
    this.epoch++;
    this.state = null;
  }
  close(): void {
    const state = this.state,
      invoke = this.transport,
      native = remoteCredentials;
    this.invalidate();
    this.transport = null;
    if (!state || !native) return;
    void native
      .end(state.handle)
      .then(async (ciphertext) => {
        if (!ciphertext || !invoke || !isMobileAuthOwnerCurrent(state.owner))
          return;
        await invoke(
          state.target,
          REMOTE_DESKTOP_CHANNEL,
          [
            {
              op: "credential",
              version: 1,
              kind: "exchange",
              handle: state.host,
              ciphertext,
            } satisfies RemoteCredentialRequest,
          ],
          {
            preSend: () => {
              if (!isMobileAuthOwnerCurrent(state.owner))
                throw new Error("CREDENTIAL_CANCELLED");
            },
          },
        );
      })
      .catch(() => {})
      .finally(() => {
        void native.close(state.handle).catch(() => {});
      });
  }
  async ensure(
    target: string,
    invoke: Invoke,
    locale: string,
    theme: "light" | "dark",
    unlock?: { setup: boolean; biometric: boolean; descriptor: string },
  ): Promise<void> {
    const native = remoteCredentials;
    if (!native) throw new Error("CREDENTIAL_NATIVE_UPGRADE_REQUIRED");
    if (
      this.state &&
      (this.state.target !== target ||
        !isMobileAuthOwnerCurrent(this.state.owner))
    )
      this.close();
    if (this.state?.authenticated) return;
    this.transport = invoke;
    const epoch = this.epoch,
      owner = getMobileAuthOwner();
    const check = () => {
      if (epoch !== this.epoch || !isMobileAuthOwnerCurrent(owner))
        throw new Error("CREDENTIAL_CANCELLED");
    };
    let saved = false;
    if (!this.state) {
      if (unlock && !native.beginUnlock)
        throw new Error("CREDENTIAL_NATIVE_UPGRADE_REQUIRED");
      const local = await credentialStep("phone-begin", () =>
        unlock
          ? native.beginUnlock!(
              target,
              unlock.setup,
              unlock.biometric,
              unlock.descriptor,
            )
          : native.begin(target),
      );
      try {
        check();
        const host = await credentialStep("host-open", () =>
          invoke<{ handle: string; offer: string }>(
            target,
            REMOTE_DESKTOP_CHANNEL,
            [
              {
                op: "credential",
                version: 1,
                kind: "open",
                offer: local.offer,
                ...(unlock && "descriptor" in local
                  ? { descriptor: local.descriptor as string }
                  : {}),
              } satisfies RemoteCredentialRequest,
            ],
            { preSend: check },
          ),
        );
        check();
        if (typeof host?.handle !== "string" || typeof host.offer !== "string")
          throw new Error("CREDENTIAL_INVALID_MESSAGE");
        const ready = await credentialStep("phone-accept", () =>
          native.accept(local.handle, host.offer),
        );
        check();
        this.state = {
          handle: local.handle,
          host: host.handle,
          target,
          owner,
          authenticated: false,
          pending: false,
        };
        const result = await credentialStep("ready-exchange", () =>
          this.exchange(ready, invoke, check),
        );
        if (result.kind !== "ready")
          throw new Error("CREDENTIAL_INVALID_MESSAGE");
        saved = !unlock?.setup && result.saved === true;
      } catch (error) {
        void native.close(local.handle).catch(() => {});
        this.invalidate();
        throw error;
      }
    }
    const state = this.state!;
    const ciphertext = await credentialStep("password-or-face-id", () =>
      state.pending
        ? native.authenticationStatus(state.handle)
        : native.password(state.handle, saved, locale, theme),
    );
    check();
    state.pending = true;
    const result = await credentialStep("authentication-exchange", () =>
      this.exchange(ciphertext, invoke, check),
    );
    if (result.kind !== "authenticated")
      throw new Error("CREDENTIAL_INVALID_MESSAGE");
    if (!result.accepted) {
      this.close();
      throw new Error("CREDENTIAL_PASSWORD_REJECTED");
    }
    state.authenticated = true;
  }
  async request<T>(
    message: RemoteDesktopRequest,
    invoke: Invoke,
    preSend?: () => void,
  ): Promise<T> {
    const native = remoteCredentials,
      state = this.state;
    if (!native || !state?.authenticated)
      throw new Error("DESKTOP_AUTHENTICATION_REQUIRED");
    const check = () => {
      if (this.state !== state || !isMobileAuthOwnerCurrent(state.owner))
        throw new Error("CREDENTIAL_CANCELLED");
      preSend?.();
    };
    check();
    const sealed = await native.request(state.handle, JSON.stringify(message));
    try {
      check();
      const result = await this.exchange(sealed.ciphertext, invoke, check);
      if (
        result.kind !== "response" ||
        result.id !== sealed.id ||
        typeof result.body !== "string"
      )
        throw new Error("CREDENTIAL_INVALID_MESSAGE");
      const body: unknown = JSON.parse(result.body);
      if (!result.success) {
        const code =
          body &&
          typeof body === "object" &&
          "error" in body &&
          typeof body.error === "string" &&
          /^[A-Z][A-Z0-9_]{1,100}$/.test(body.error)
            ? body.error
            : "DESKTOP_UNAVAILABLE";
        throw new Error(code);
      }
      return body as T;
    } finally {
      await native.abandonRequest(state.handle, sealed.id).catch(() => {});
    }
  }
  private async exchange(
    ciphertext: string,
    invoke: Invoke,
    check: () => void,
  ): Promise<Received> {
    const state = this.state;
    if (!state || !remoteCredentials)
      throw new Error("CREDENTIAL_INVALID_IDENTITY");
    const reply = await credentialStep("host-exchange", () =>
      invoke<{ ciphertext: string }>(
        state.target,
        REMOTE_DESKTOP_CHANNEL,
        [
          {
            op: "credential",
            version: 1,
            kind: "exchange",
            handle: state.host,
            ciphertext,
          } satisfies RemoteCredentialRequest,
        ],
        { preSend: check },
      ),
    );
    check();
    if (typeof reply?.ciphertext !== "string")
      throw new Error("CREDENTIAL_INVALID_MESSAGE");
    const native = remoteCredentials;
    const result = JSON.parse(
      await credentialStep("phone-reply-and-save", () =>
        native.receive(state.handle, reply.ciphertext),
      ),
    ) as Received;
    check();
    return result;
  }
}
