import type { AccountMembership, AuthMembership, AuthRegion } from "./types.js";

export interface StoredAccountMetadata {
  membershipId: string;
  passportId: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  kind: "personal" | "org";
  role: "owner" | "admin" | "member";
  orgId: string | null;
  orgName: string | null;
  orgLogoUrl: string | null;
}

export interface AccountMetadataVault {
  resources: Record<string, { realm: AuthRegion; metadata: StoredAccountMetadata }>;
  passports: Record<
    string,
    { realm: AuthRegion; passportId: string; memberships: StoredAccountMetadata[] }
  >;
}

export function accountVaultKey(realm: AuthRegion, membershipId: string): string {
  return JSON.stringify([realm, membershipId]);
}

export function passportVaultKey(realm: AuthRegion, passportId: string): string {
  return JSON.stringify([realm, passportId]);
}

export function isStoredAccountMetadata(value: unknown): value is StoredAccountMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<StoredAccountMetadata>;
  return (
    typeof item.membershipId === "string" &&
    typeof item.passportId === "string" &&
    typeof item.displayName === "string" &&
    (item.email === null || typeof item.email === "string") &&
    (item.avatarUrl === null || typeof item.avatarUrl === "string") &&
    (item.kind === "personal" || item.kind === "org") &&
    (item.role === "owner" || item.role === "admin" || item.role === "member") &&
    (item.orgId === null || typeof item.orgId === "string") &&
    (item.orgName === null || typeof item.orgName === "string") &&
    (item.orgLogoUrl === null || typeof item.orgLogoUrl === "string")
  );
}

export function storedAccountMetadataFromMembership(
  membership: AuthMembership | AccountMembership,
  passportId: string,
): StoredAccountMetadata {
  return {
    membershipId: membership.id,
    passportId,
    displayName: membership.displayName,
    email: membership.email,
    avatarUrl: membership.avatarUrl ?? null,
    kind: membership.kind,
    role: membership.role,
    orgId: membership.orgId,
    orgName: membership.orgName,
    orgLogoUrl: membership.orgLogoUrl ?? null,
  };
}

/** Reconcile public account metadata without touching either refresh-token family. */
export function reconcileSavedAccountMetadata(
  vault: AccountMetadataVault,
  input: {
    realm: AuthRegion;
    passportId: string;
    memberships: readonly StoredAccountMetadata[];
    passportMode: "patch-known" | "replace-passport";
  },
): boolean {
  const latestById = new Map(
    input.memberships
      .filter((metadata) => metadata.passportId === input.passportId)
      .map((metadata) => [metadata.membershipId, metadata] as const),
  );
  if (latestById.size === 0 && input.passportMode === "patch-known") return false;

  let changed = false;
  for (const resource of Object.values(vault.resources)) {
    if (resource.realm !== input.realm || resource.metadata.passportId !== input.passportId) {
      continue;
    }
    const latest = latestById.get(resource.metadata.membershipId);
    if (!latest) continue;
    resource.metadata = latest;
    changed = true;
  }

  for (const passport of Object.values(vault.passports)) {
    if (passport.realm !== input.realm || passport.passportId !== input.passportId) continue;
    if (input.passportMode === "replace-passport") {
      passport.memberships = [...latestById.values()];
      changed = true;
      continue;
    }
    passport.memberships = passport.memberships.map((metadata) => {
      const latest = latestById.get(metadata.membershipId);
      if (!latest) return metadata;
      changed = true;
      return latest;
    });
  }

  return changed;
}
