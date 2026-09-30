import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { inspectSimulatorNativeIdentity } from "../../scripts/lib/sim-native-identity.mjs";

const current = "a".repeat(40);
const previous = "b".repeat(40);

describe("simulator native compatibility", () => {
  it.each([
    [current, current, true, "native-matched"],
    [previous, current, false, "native-mismatch"],
    ["", current, false, "native-unknown"],
    ["file:fingerprint", current, false, "native-unknown"],
    [current, "", false, "native-unknown"],
  ])(
    "compares the embedded build fingerprint: %s / %s",
    (installed, expected, healthy, code) => {
      const read = vi.fn(() => installed);
      const result = inspectSimulatorNativeIdentity({
        appPath: "/sim/Cindy.app",
        expectedFingerprint: expected,
        read,
      });
      expect(result).toMatchObject({ healthy, code });
      expect(read).toHaveBeenCalledWith(
        join("/sim/Cindy.app", "EXUpdates.bundle", "fingerprint"),
      );
    },
  );

  it("does not treat a missing app or unreadable build resource as compatible", () => {
    expect(inspectSimulatorNativeIdentity({ appPath: "" })).toMatchObject({
      healthy: false,
      code: "native-missing",
    });
    expect(
      inspectSimulatorNativeIdentity({
        appPath: "/missing.app",
        read: () => {
          throw new Error("missing");
        },
      }),
    ).toMatchObject({ healthy: false, code: "native-unknown" });
  });

  it("fails closed when calculation fails without disclosing child output", () => {
    const result = inspectSimulatorNativeIdentity({
      appPath: "/app",
      read: () => current,
      compute: () => {
        throw new Error("secret child output");
      },
    });
    expect(result).toMatchObject({ healthy: false, code: "native-unknown" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("passes the actual worktree and development environment to the calculator", () => {
    const env = { EXPO_PUBLIC_APP_VARIANT: "beta" };
    const compute = vi.fn(() => current);
    expect(
      inspectSimulatorNativeIdentity({
        appPath: "/app",
        projectDir: "/worktree/mobile",
        env,
        read: () => `${current}\n`,
        compute,
      }).healthy,
    ).toBe(true);
    expect(compute).toHaveBeenCalledWith("/worktree/mobile", env);
  });
});
