import path from "node:path";

import { describe, expect, it } from "vitest";

import { createWdaBuildPlan, createWdaChildEnvironment } from "./build-plan.js";

const UDID = "1A9D41E0-E031-4AD0-A8B5-847480802E8E";
const OWNER_FINGERPRINT = "b".repeat(64);
const CHECKOUT_PATH = path.resolve("/tmp/wda");
const DERIVED_DATA_PATH = path.resolve("/tmp/wda-derived");

describe("createWdaBuildPlan", () => {
  it("builds exact argv plans for a pinned simulator destination", () => {
    const plan = createWdaBuildPlan({
      checkoutPath: CHECKOUT_PATH,
      derivedDataPath: DERIVED_DATA_PATH,
      simulatorUdid: UDID.toLowerCase(),
      ownerFingerprint: OWNER_FINGERPRINT,
      architecture: "arm64",
      controlPort: 18_100,
      mjpegPort: 19_100,
    });

    expect(plan.projectPath).toBe(
      path.join(CHECKOUT_PATH, "WebDriverAgent.xcodeproj"),
    );
    expect(plan.build).toMatchObject({
      command: "/usr/bin/xcodebuild",
      cwd: CHECKOUT_PATH,
    });
    expect(plan.build.args).toContain(
      `platform=iOS Simulator,id=${UDID},arch=arm64`,
    );
    expect(plan.build.args[0]).toBe("-quiet");
    expect(plan.build.args).toContain("build-for-testing");
    expect(plan.build.args).toContain(
      `CINDY_WDA_OWNER_FINGERPRINT=${OWNER_FINGERPRINT}`,
    );
    expect(plan.build.env).not.toHaveProperty("XDT_CODEX_API_KEY");
    expect(plan.launch.args).toContain("test-without-building");
    expect(plan.launch.args).toContain(
      `CINDY_WDA_OWNER_FINGERPRINT=${OWNER_FINGERPRINT}`,
    );
    expect(plan.launch.args).toContain(
      `UPGRADE_TIMESTAMP=${OWNER_FINGERPRINT}`,
    );
    expect(plan.launch.args[0]).toBe("-quiet");
    expect(plan.launch.env).toMatchObject({
      USE_PORT: "18100",
      MJPEG_SERVER_PORT: "19100",
    });
  });

  it("copies only the Apple tooling environment allowlist", () => {
    expect(
      createWdaChildEnvironment(
        {
          HOME: "/Users/tester",
          PATH: "/usr/bin:/bin",
          DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
          XDT_CODEX_API_KEY: "must-not-leak",
          OPENAI_API_KEY: "must-not-leak",
        },
        { USE_PORT: "18100" },
      ),
    ).toEqual({
      HOME: "/Users/tester",
      PATH: "/usr/bin:/bin",
      DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
      USE_PORT: "18100",
    });
  });

  it("rejects relative paths, invalid UUIDs, and colliding ports", () => {
    expect(() =>
      createWdaBuildPlan({
        checkoutPath: "relative",
        derivedDataPath: "/tmp/derived",
        simulatorUdid: UDID,
        ownerFingerprint: OWNER_FINGERPRINT,
      }),
    ).toThrow("checkoutPath must be an absolute path");
    expect(() =>
      createWdaBuildPlan({
        checkoutPath: CHECKOUT_PATH,
        derivedDataPath: path.resolve("/tmp/derived"),
        simulatorUdid: "not-a-udid",
        ownerFingerprint: OWNER_FINGERPRINT,
      }),
    ).toThrow("simulatorUdid must be an exact simulator UUID");
    expect(() =>
      createWdaBuildPlan({
        checkoutPath: CHECKOUT_PATH,
        derivedDataPath: path.resolve("/tmp/derived"),
        simulatorUdid: UDID,
        ownerFingerprint: OWNER_FINGERPRINT,
        controlPort: 8100,
        mjpegPort: 8100,
      }),
    ).toThrow("controlPort and mjpegPort must differ");
    expect(() =>
      createWdaBuildPlan({
        checkoutPath: CHECKOUT_PATH,
        derivedDataPath: DERIVED_DATA_PATH,
        simulatorUdid: UDID,
        ownerFingerprint: "not-a-digest",
      }),
    ).toThrow("ownerFingerprint must be an exact SHA-256 hex digest");
  });
});
