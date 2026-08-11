import { describe, expect, it } from "vitest";

import {
  REVIEW_SENSITIVE_CREDENTIAL_GLOB_PATTERNS,
  isReviewSensitiveCredentialPath,
  isReviewSensitiveCredentialSelector,
  isSensitiveCredentialPath,
} from "./sensitive-credential-paths.js";

describe("Review credential path policy", () => {
  it("adds dotenv files without treating arbitrary .env text as a path", () => {
    expect(isSensitiveCredentialPath("/repo/.env.local")).toBe(false);
    expect(isReviewSensitiveCredentialPath("/repo/.env.local")).toBe(true);
    expect(isReviewSensitiveCredentialPath("jq .env data.json")).toBe(false);
  });

  it("retains the shared credential path protections", () => {
    expect(isReviewSensitiveCredentialPath("/Users/me/.ssh/id_ed25519")).toBe(
      true,
    );
    expect(isReviewSensitiveCredentialPath("/repo/.git/config")).toBe(true);
    expect(isReviewSensitiveCredentialPath("/repo/.gitignore")).toBe(false);
    expect(isReviewSensitiveCredentialPath("/repo/src/environment.ts")).toBe(
      false,
    );
  });

  it("keeps generated dependency trees outside the Review read scope", () => {
    expect(
      isReviewSensitiveCredentialPath("/repo/node_modules/pkg/index.js"),
    ).toBe(true);
    expect(
      isReviewSensitiveCredentialPath("/repo/packages/app/node_modules"),
    ).toBe(true);
    expect(
      isReviewSensitiveCredentialPath("/repo/src/node_modules-helper.ts"),
    ).toBe(false);
  });

  it("keeps managed harness binaries and local build caches outside Review", () => {
    for (const denied of [
      "/repo/apps/claude-code-bin/darwin-arm64/claude",
      "/repo/apps/codex-bin/win32-x64/codex.exe",
      "/repo/apps/pi-bin/linux-x64/pi",
      "/repo/apps/ripgrep-bin/darwin-arm64/rg",
      "/repo/tools/pi/updates/0.83.0/darwin-arm64/pi",
      "/repo/tools/codex/updates/0.144.6/darwin-arm64/codex",
      "/repo/tools/claude/updates/2.1.215/darwin-arm64/claude",
      "/repo/tools/ripgrep/updates/15.1.0/darwin-arm64/rg",
      "/repo/apps/desktop/.vite/build/main.js",
    ]) {
      expect(isReviewSensitiveCredentialPath(denied)).toBe(true);
    }
    expect(
      isReviewSensitiveCredentialPath("/repo/src/codex-binary-format.ts"),
    ).toBe(false);
    expect(
      isReviewSensitiveCredentialPath("/repo/packages/codex-bin/source.ts"),
    ).toBe(false);
    expect(
      isReviewSensitiveCredentialPath("/repo/tools/codex/src/main.ts"),
    ).toBe(false);
  });

  it("keeps unrelated tools/*/updates source reviewable", () => {
    // A reviewed repository may legitimately keep source under an `updates`
    // directory. Only Cindy's own managed harness payloads are excluded, so a
    // wildcard here would silently drop real changes from the review.
    //
    // The harness names are the dangerous case: matching them by name alone
    // would deny a reviewed repository that happens to use the same folder.
    // Cindy's payloads always sit at `updates/<version>/<platform>-<arch>/`.
    for (const allowed of [
      "/userrepo/tools/database/updates/migrate.ts",
      "/userrepo/tools/schema/updates/v2.sql",
      "/userrepo/tools/build/updates/index.ts",
      "/userrepo/tools/codex/updates/migrate.ts",
      "/userrepo/tools/claude/updates/index.ts",
      "/userrepo/tools/ripgrep/updates/v2/schema.sql",
      // Even the platform-shaped layout stays reviewable unless the version
      // segment is a real semver, which is what Cindy's downloader writes.
      "/userrepo/tools/codex/updates/v2/darwin-arm64/main.ts",
      "/userrepo/tools/claude/updates/next/linux-x64/index.ts",
    ]) {
      expect(isReviewSensitiveCredentialPath(allowed)).toBe(false);
    }
  });

  it("excludes managed harness payloads on every platform", () => {
    for (const denied of [
      "/repo/tools/pi/updates/0.83.0/linux-x64/pi",
      "/repo/tools/ripgrep/updates/15.1.0/win32-x64/rg.exe",
      "tools/codex/updates/0.144.6/darwin-arm64/codex",
    ]) {
      expect(isReviewSensitiveCredentialPath(denied)).toBe(true);
    }
  });

  it("keeps a managed worktree checkout readable as a review root", () => {
    // Cindy sessions frequently run inside `<repo>/.cindy-worktrees/<name>`.
    // Denying that prefix would classify the review's own working directory as
    // sensitive and make /review unusable for every managed-worktree session.
    for (const allowed of [
      "/repo/.cindy-worktrees/bold-euclid",
      "/repo/.cindy-worktrees/bold-euclid/apps/desktop/src/main.ts",
    ]) {
      expect(isReviewSensitiveCredentialPath(allowed)).toBe(false);
    }
  });

  it("recognizes credentials hidden behind file selector syntax", () => {
    for (const selector of [
      "**/*.pem",
      "**/.env*",
      "{src/**,**/.ssh/**}",
      "**/{safe.ts,.env.local}",
    ]) {
      expect(isReviewSensitiveCredentialSelector(selector)).toBe(true);
    }
    expect(
      isReviewSensitiveCredentialSelector("{src,test}/**/*.{ts,tsx}"),
    ).toBe(false);
  });

  it("keeps directory search denies aligned for common credential files", () => {
    expect(REVIEW_SENSITIVE_CREDENTIAL_GLOB_PATTERNS).toEqual(
      expect.arrayContaining([
        "**/.env.*",
        "**/.git/**",
        "**/node_modules/**",
        "**/apps/codex-bin/**",
        "**/tools/claude/updates/*/{darwin,linux,win32}-*/**",
        "**/tools/codex/updates/*/{darwin,linux,win32}-*/**",
        "**/tools/pi/updates/*/{darwin,linux,win32}-*/**",
        "**/tools/ripgrep/updates/*/{darwin,linux,win32}-*/**",
        "**/.vite/**",
        "**/credentials.json",
        "**/auth.json",
        "**/*.pem",
        "**/id_ed25519",
      ]),
    );
  });
});
