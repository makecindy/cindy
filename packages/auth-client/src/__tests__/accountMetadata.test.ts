import { describe, expect, it } from "vitest";

import {
  accountVaultKey,
  reconcileSavedAccountMetadata,
  storedAccountMetadataFromMembership,
} from "../accountMetadata.js";

describe("saved account metadata", () => {
  it("keys memberships by realm so cross-region identities never collide", () => {
    expect(accountVaultKey("cn", "membership-1")).not.toBe(
      accountVaultKey("global", "membership-1"),
    );
  });

  it("keeps organization presentation metadata including its logo", () => {
    expect(
      storedAccountMetadataFromMembership(
        {
          id: "membership-1",
          passportId: "passport-1",
          kind: "org",
          role: "member",
          displayName: "Cao Jianbo",
          avatarUrl: "https://example.com/user.png",
          email: "cao@example.com",
          orgId: "org-1",
          orgName: "Cindy",
          orgLogoUrl: "https://example.com/org.png",
        },
        "passport-1",
      ),
    ).toMatchObject({
      kind: "org",
      displayName: "Cao Jianbo",
      orgName: "Cindy",
      orgLogoUrl: "https://example.com/org.png",
    });
  });

  it("lets an authoritative empty Passport result clear stale memberships", () => {
    const stale = storedAccountMetadataFromMembership(
      {
        id: "membership-1",
        passportId: "passport-1",
        kind: "org",
        role: "member",
        displayName: "Former member",
        email: "former@example.com",
        orgId: "org-1",
        orgName: "Former org",
      },
      "passport-1",
    );
    const vault = {
      resources: {},
      passports: {
        current: {
          realm: "global" as const,
          passportId: "passport-1",
          memberships: [stale],
        },
      },
    };

    expect(
      reconcileSavedAccountMetadata(vault, {
        realm: "global",
        passportId: "passport-1",
        memberships: [],
        passportMode: "replace-passport",
      }),
    ).toBe(true);
    expect(vault.passports.current.memberships).toEqual([]);

    vault.passports.current.memberships = [stale];
    expect(
      reconcileSavedAccountMetadata(vault, {
        realm: "global",
        passportId: "passport-1",
        memberships: [],
        passportMode: "patch-known",
      }),
    ).toBe(false);
    expect(vault.passports.current.memberships).toEqual([stale]);
  });
});
