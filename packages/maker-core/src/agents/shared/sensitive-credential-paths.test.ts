import { describe, expect, it } from "vitest";

import {
  REVIEW_SENSITIVE_CREDENTIAL_GLOB_PATTERNS,
  isReviewSensitiveCredentialPath,
  isReviewSensitiveCredentialSelector,
  isSensitiveCredentialPath,
} from "./sensitive-credential-paths.js";

describe("credential path policy", () => {
  it("treats dotenv files as credentials without matching similar text", () => {
    for (const dotenvPath of [
      ".env",
      ".env.local",
      "/repo/.env",
      "/repo/.env.production.local",
      "C:\\repo\\.ENV.test",
    ]) {
      expect(isSensitiveCredentialPath(dotenvPath)).toBe(true);
      expect(isReviewSensitiveCredentialPath(dotenvPath)).toBe(true);
    }

    for (const ordinary of [
      "/repo/.environment",
      "/repo/.envrc",
      "/repo/env.local",
      "jq .env data.json",
    ]) {
      expect(isSensitiveCredentialPath(ordinary)).toBe(false);
      expect(isReviewSensitiveCredentialPath(ordinary)).toBe(false);
    }
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

  it("protects plugin-engine isolated account dirs and Antigravity credential stores without blocking repo source paths", () => {
    for (const sensitive of [
      "/Users/me/Library/Application Support/CindyGlobal/owners/abae59844621cadf5062/plugin-engine-accounts",
      "/Users/me/Library/Application Support/CindyGlobal/owners/abae59844621cadf5062/plugin-engine-accounts/_root__cindy-antigravity-acp/agy/cindy-abae59844621-ef086271-bfe8-4fb6-a5c3-235fe8839270/.gemini/antigravity-cli/antigravity-oauth-token",
      "C:\\Users\\me\\AppData\\Roaming\\Cindy\\owners\\owner1\\plugin-engine-accounts\\_root__agy\\agy\\cindy-0123456789ab-11111111-1111-4111-8111-111111111111",
      "/tmp/moved/plugin-engine-accounts/_root__agy/agy/cindy-0123456789ab-11111111-1111-4111-8111-111111111111/state",
      "/Users/me/.gemini/antigravity-cli/antigravity-oauth-token",
      "~/.gemini/antigravity-cli/jetski_state.pbtxt",
      "/tmp/copied/antigravity-oauth-token",
      "/Users/me/.claude-cindy-0123456789ab-11111111-1111-4111-8111-111111111111/.credentials.json",
      "/Users/me/.codex-cindy-0123456789ab-11111111-1111-4111-8111-111111111111/auth.json",
    ]) {
      expect(isSensitiveCredentialPath(sensitive), sensitive).toBe(true);
      expect(isReviewSensitiveCredentialPath(sensitive), sensitive).toBe(true);
    }

    for (const ordinary of [
      "/repo/apps/desktop/src/main/plugin-engine-accounts/paths.ts",
      "/repo/apps/desktop/src/main/plugin-engine-accounts/__tests__/runtime.test.ts",
      "/repo/.gemini/settings.json",
    ]) {
      expect(isSensitiveCredentialPath(ordinary), ordinary).toBe(false);
      expect(isReviewSensitiveCredentialPath(ordinary), ordinary).toBe(false);
    }
  });

  it("keeps directory search denies aligned for common credential files", () => {
    expect(REVIEW_SENSITIVE_CREDENTIAL_GLOB_PATTERNS).toEqual(
      expect.arrayContaining([
        "**/.env.*",
        "**/.git/**",
        "**/node_modules/**",
        "**/apps/codex-bin/**",
        "**/tools/pi/updates/**",
        "**/.vite/**",
        "**/.claude-cindy-*/**",
        "**/.codex-cindy-*/**",
        "**/.gemini/antigravity-cli/**",
        "**/antigravity-oauth-token",
        "**/owners/*/plugin-engine-accounts/**",
        "**/credentials.json",
        "**/auth.json",
        "**/*.pem",
        "**/id_ed25519",
      ]),
    );
  });
});
