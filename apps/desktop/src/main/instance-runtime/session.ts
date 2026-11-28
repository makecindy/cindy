import { createHash } from "node:crypto";
import { AuthApiError, type AuthTokenPair } from "@cindy/auth-client";
import type { InstanceAuthProtocol, InstanceConfig } from "./config.js";
import { isResourceRefreshToken } from "./store.js";

type InstanceIdentity =
  | { version: 1; instanceId: string; generation: number }
  | { version: 2; protocol: "resource-v1" };

export type InstanceRecord = InstanceIdentity & {
  deviceId: string;
  membershipId: string;
  authBaseUrl: string;
  bootstrapDigest: string;
  refreshToken: string;
  /** Non-secret receipt for an owner-authorized reauthentication. */
  recoveryRequestId?: string;
  recoveryCredentialDigest?: string;
};

export interface InstanceSessionDependencies {
  config: Pick<InstanceConfig, "deviceId" | "membershipId"> &
    Partial<Pick<InstanceConfig, "authProtocol" | "credentialSource">>;
  authBaseUrl: string;
  store: {
    read(): unknown;
    write(record: InstanceRecord): void;
    preflight(): void;
  };
  readBootstrap(): string | null;
  exchange(token: string): Promise<AuthTokenPair>;
  now?(): number;
}

export function validateInstancePair(
  pair: AuthTokenPair,
  config: InstanceSessionDependencies["config"],
  now = Date.now(),
): { instanceId: string; generation: number } {
  try {
    const pieces = pair.accessToken.split(".");
    if (pieces.length !== 3 || !pieces[2] || !pair.refreshToken)
      throw new Error();
    const claims = JSON.parse(
      Buffer.from(pieces[1], "base64url").toString("utf8"),
    );
    const instanceId = claims.instance?.id;
    const generation = claims.instance?.generation;
    if (
      claims.typ !== "instance_access" ||
      claims.aud !== "cindy:instance" ||
      claims.accountControl !== false ||
      claims.sub !== config.membershipId ||
      pair.membership.id !== config.membershipId ||
      claims.device !== config.deviceId ||
      typeof instanceId !== "string" ||
      !/^cloud-instance-[a-f0-9]{16}$/.test(instanceId) ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      !Number.isSafeInteger(claims.iat) ||
      !Number.isSafeInteger(claims.exp) ||
      claims.iat > now / 1000 + 30 ||
      claims.exp <= now / 1000 ||
      claims.exp <= claims.iat ||
      `cloud-device-${createHash("sha256").update(instanceId).digest("hex").slice(0, 24)}` !==
        config.deviceId
    ) {
      throw new Error();
    }
    return { instanceId, generation };
  } catch {
    throw new Error("INSTANCE_TOKEN_BINDING_REJECTED");
  }
}

export function validateResourcePair(
  pair: AuthTokenPair,
  config: InstanceSessionDependencies["config"],
  authBaseUrl: string,
  now = Date.now(),
): void {
  try {
    const pieces = pair.accessToken.split(".");
    if (
      pieces.length !== 3 ||
      !pieces[2] ||
      !isResourceRefreshToken(pair.refreshToken)
    )
      throw new Error();
    const claims = JSON.parse(
      Buffer.from(pieces[1], "base64url").toString("utf8"),
    );
    if (
      claims.typ !== "access" ||
      claims.aud !== "cindy" ||
      claims.iss !== authBaseUrl.replace(/\/+$/, "") ||
      claims.accountControl !== false ||
      claims.sub !== config.membershipId ||
      pair.membership.id !== config.membershipId ||
      claims.device !== config.deviceId ||
      claims.instance !== undefined ||
      !Number.isSafeInteger(claims.iat) ||
      !Number.isSafeInteger(claims.exp) ||
      claims.iat > now / 1000 + 30 ||
      claims.exp <= now / 1000 ||
      claims.exp <= claims.iat
    )
      throw new Error();
  } catch {
    throw new Error("INSTANCE_TOKEN_BINDING_REJECTED");
  }
}

export interface InstanceRecoveryOptions {
  /** Access token from the owner's explicit login, when CIS forwarded it. */
  accessToken?: string;
  /** Device-link removed this device; recovery is needed even though auth is ready. */
  registrationLost?: boolean;
}

/** A token minted by an explicit login carries authentication methods and auth_time;
 * refreshed tokens do not, and device-link only restores a removed device for the former. */
export function isExplicitLoginAccessToken(token: string): boolean {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return Array.isArray(claims.amr) && claims.amr.length > 0 && Number.isFinite(claims.auth_time);
  } catch {
    return false;
  }
}

export class InstanceSession {
  private flight: Promise<AuthTokenPair> | null = null;
  private pending: { pair: AuthTokenPair; record: InstanceRecord } | null =
    null;
  private dirty = false;
  private blocked = false;
  private storeHealthy = false;
  private acceptedPair: AuthTokenPair | null = null;
  private readonly protocol: InstanceAuthProtocol;

  constructor(private readonly dependencies: InstanceSessionDependencies) {
    this.protocol = dependencies.config.authProtocol ?? "instance-v1";
    if (this.protocol !== "instance-v1" && this.protocol !== "resource-v1")
      throw new Error("INSTANCE_AUTH_PROTOCOL_INVALID");
    const source = dependencies.config.credentialSource ?? "bootstrap";
    if (
      !["bootstrap", "canonical"].includes(source) ||
      (source === "canonical" && this.protocol !== "resource-v1")
    )
      throw new Error("INSTANCE_CREDENTIAL_SOURCE_INVALID");
    const url = new URL(dependencies.authBaseUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
        ))
    ) {
      throw new Error("INSTANCE_AUTH_ENDPOINT_REJECTED");
    }
  }

  isReady(accessToken: string | null): boolean {
    if (
      this.blocked ||
      !this.storeHealthy ||
      this.dirty ||
      !accessToken ||
      accessToken !== this.acceptedPair?.accessToken
    )
      return false;
    try {
      this.validatePair(this.acceptedPair);
      return true;
    } catch {
      return false;
    }
  }

  owns(pair: AuthTokenPair): boolean {
    return (
      !this.blocked &&
      this.storeHealthy &&
      !this.dirty &&
      this.pending?.pair.accessToken === pair.accessToken &&
      this.pending.pair.refreshToken === pair.refreshToken
    );
  }

  acknowledge(pair: AuthTokenPair): void {
    if (!this.owns(pair)) throw new Error("INSTANCE_PUBLICATION_REJECTED");
    this.acceptedPair = pair;
    this.pending = null;
  }

  rotate(): Promise<AuthTokenPair> {
    if (this.flight) return this.flight;
    const flight = this.rotateOnce().finally(() => {
      this.flight = null;
    });
    this.flight = flight;
    return flight;
  }

  needsLogin(): boolean { return this.blocked; }

  recovered(requestId: string, credential?: string): boolean {
    if (this.pending || !this.isReady(this.acceptedPair?.accessToken ?? null)) return false;
    const record = this.readRecord();
    return record?.recoveryRequestId === requestId && (credential === undefined
      || record.recoveryCredentialDigest === createHash('sha256').update(credential).digest('hex'));
  }

  /** CIS supplies a newly authorized, same-device resource credential. Never
   * import account credentials or overwrite the profile from another process.
   * The normal auth manager must acknowledge the durable pair before success. */
  recover(requestId: string, refreshToken: string, options: InstanceRecoveryOptions = {}): Promise<AuthTokenPair> {
    if (this.flight) return Promise.reject(new Error("INSTANCE_RECOVERY_BUSY"));
    const flight = this.recoverOnce(requestId, refreshToken, options).finally(() => { this.flight = null; });
    this.flight = flight;
    return flight;
  }

  private async recoverOnce(requestId: string, token: string, options: InstanceRecoveryOptions): Promise<AuthTokenPair> {
    if (this.protocol !== "resource-v1" || !/^[A-Za-z0-9_-]{16,128}$/.test(requestId)
      || !isResourceRefreshToken(token)) throw new Error("INSTANCE_RECOVERY_REJECTED");
    this.dependencies.store.preflight();
    const previous = this.readRecord();
    if (!previous) throw new Error("INSTANCE_CANONICAL_REQUIRED");
    const digest = createHash("sha256").update(token).digest("hex");
    if (previous.recoveryRequestId === requestId) {
      if (previous.recoveryCredentialDigest !== digest) throw new Error("INSTANCE_RECOVERY_REJECTED");
      // A lost transport reply or restart resumes the canonical rotated token,
      // never spends the incoming refresh token a second time.
      return this.rotateOnce();
    }
    if (this.pending?.record.recoveryRequestId === requestId) {
      if (this.pending.record.recoveryCredentialDigest !== digest) throw new Error("INSTANCE_RECOVERY_REJECTED");
      return this.rotateOnce();
    }
    // A ready session needs no recovery unless device-link removed this device: only a
    // token from the owner's explicit login can register it again.
    if (this.pending || (this.isReady(this.acceptedPair?.accessToken ?? null) && !options.registrationLost))
      throw new Error("INSTANCE_RECOVERY_NOT_REQUIRED");
    let pair = await this.dependencies.exchange(token);
    if (options.accessToken && isExplicitLoginAccessToken(options.accessToken)) {
      // Keep the rotated refresh token and membership, but publish the login's own access
      // token first so device-link sees the explicit authentication. Unbound tokens are ignored.
      const explicit = { ...pair, accessToken: options.accessToken };
      try { this.validatePair(explicit); pair = explicit; } catch { /* keep the exchanged pair */ }
    }
    const identity = this.validatePair(pair);
    this.acceptedPair = null;
    this.pending = { pair, record: { ...identity, deviceId: previous.deviceId,
      membershipId: previous.membershipId, authBaseUrl: previous.authBaseUrl,
      bootstrapDigest: previous.bootstrapDigest, refreshToken: pair.refreshToken,
      recoveryRequestId: requestId, recoveryCredentialDigest: digest } };
    this.blocked = false;
    this.storeHealthy = false;
    this.dirty = true;
    return this.rotateOnce();
  }

  private validatePair(pair: AuthTokenPair): InstanceIdentity {
    const dependencies = this.dependencies;
    if (this.protocol === "resource-v1") {
      validateResourcePair(
        pair,
        dependencies.config,
        dependencies.authBaseUrl,
        dependencies.now?.(),
      );
      return { version: 2, protocol: "resource-v1" };
    }
    return {
      version: 1,
      ...validateInstancePair(pair, dependencies.config, dependencies.now?.()),
    };
  }

  private readRecord(): InstanceRecord | null {
    const value = this.dependencies.store.read();
    if (value === null) return null;
    const record = value as InstanceRecord;
    const config = this.dependencies.config;
    if (
      !record ||
      record.deviceId !== config.deviceId ||
      record.membershipId !== config.membershipId ||
      record.authBaseUrl !== this.dependencies.authBaseUrl ||
      typeof record.bootstrapDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.bootstrapDigest) ||
      typeof record.refreshToken !== "string" ||
      !record.refreshToken
    ) {
      throw new Error("INSTANCE_RECORD_REJECTED");
    }
    if (this.protocol === "resource-v1") {
      if (
        record.version !== 2 ||
        record.protocol !== "resource-v1" ||
        "instanceId" in record ||
        "generation" in record ||
        !isResourceRefreshToken(record.refreshToken)
      )
        throw new Error("INSTANCE_RECORD_REJECTED");
    } else if (
      record.version !== 1 ||
      "protocol" in record ||
      typeof record.instanceId !== "string" ||
      !/^cloud-instance-[a-f0-9]{16}$/.test(record.instanceId) ||
      `cloud-device-${createHash("sha256").update(record.instanceId).digest("hex").slice(0, 24)}` !==
        config.deviceId ||
      !Number.isSafeInteger(record.generation) ||
      record.generation < 1
    ) {
      throw new Error("INSTANCE_RECORD_REJECTED");
    }
    return record;
  }

  private async rotateOnce(): Promise<AuthTokenPair> {
    const dependencies = this.dependencies;
    if (this.blocked)
      throw new AuthApiError(
        "INSTANCE_GRANT_REJECTED",
        401,
        "Instance authorization rejected",
      );
    this.storeHealthy = false;
    dependencies.store.preflight();
    if (!this.pending) {
      const previous = this.readRecord();
      const canonicalOnly =
        dependencies.config.credentialSource === "canonical";
      if (canonicalOnly && !previous)
        throw new Error("INSTANCE_CANONICAL_REQUIRED");
      const bootstrap = canonicalOnly ? null : dependencies.readBootstrap();
      const digest = bootstrap
        ? createHash("sha256").update(bootstrap).digest("hex")
        : previous?.bootstrapDigest;
      const newBootstrap = !!bootstrap && digest !== previous?.bootstrapDigest;
      const token = newBootstrap ? bootstrap : previous?.refreshToken;
      if (!token || !digest) throw new Error("INSTANCE_BOOTSTRAP_REQUIRED");
      let pair: AuthTokenPair;
      try {
        pair = await dependencies.exchange(token);
      } catch (error) {
        if (
          error instanceof AuthApiError &&
          [401, 403].includes(error.statusCode)
        )
          this.blocked = true;
        throw error;
      }
      let identity: InstanceIdentity;
      try {
        identity = this.validatePair(pair);
        if (
          previous?.version === 1 &&
          identity.version === 1 &&
          (identity.instanceId !== previous.instanceId ||
            (newBootstrap
              ? identity.generation < previous.generation
              : identity.generation !== previous.generation))
        ) {
          throw new Error();
        }
      } catch {
        this.blocked = true;
        throw new AuthApiError(
          "INSTANCE_GRANT_REJECTED",
          401,
          "Instance authorization rejected",
        );
      }
      this.pending = {
        pair,
        record: {
          deviceId: dependencies.config.deviceId,
          membershipId: dependencies.config.membershipId,
          ...identity,
          authBaseUrl: dependencies.authBaseUrl,
          bootstrapDigest: digest,
          refreshToken: pair.refreshToken,
          ...(previous?.recoveryRequestId ? { recoveryRequestId: previous.recoveryRequestId,
            recoveryCredentialDigest: previous.recoveryCredentialDigest } : {}),
        },
      };
      this.dirty = true;
    }
    if (this.dirty) {
      dependencies.store.write(this.pending.record);
      this.dirty = false;
    }
    this.storeHealthy = true;
    return this.pending.pair;
  }
}
