import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDesktopDevStartupConfig,
  desktopUserDataDirForRegion,
  desktopUserDataDirNameForRegion,
  resolveDesktopDevRegion,
  resolveDesktopDevStartupConfig,
  stripDesktopDevRegionArgs,
} from "../shared/desktop-dev-region.mjs";

test("desktop shared userData follows the region identity", () => {
  assert.equal(desktopUserDataDirNameForRegion(), "CindyGlobal");
  assert.equal(desktopUserDataDirNameForRegion("global"), "CindyGlobal");
  assert.equal(desktopUserDataDirNameForRegion("cn"), "Cindy");
  assert.equal(desktopUserDataDirNameForRegion("dev"), "CindyDev");
  assert.throws(
    () => desktopUserDataDirNameForRegion("us"),
    /expected cn, global or dev/,
  );
});

test("desktop userData path follows platform appData rules and selected region", () => {
  assert.equal(
    desktopUserDataDirForRegion("global", "darwin", {}, "/Users/tester"),
    "/Users/tester/Library/Application Support/CindyGlobal",
  );
  assert.equal(
    desktopUserDataDirForRegion(
      "cn",
      "linux",
      { XDG_CONFIG_HOME: "/tmp/config" },
      "/home/tester",
    ),
    "/tmp/config/Cindy",
  );
  assert.equal(
    desktopUserDataDirForRegion(
      "dev",
      "win32",
      { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" },
      "C:\\Users\\tester",
    ),
    "C:\\Users\\tester\\AppData\\Roaming\\CindyDev",
  );
});

test("desktop dev region defaults to global and keeps the legacy env fallback", () => {
  assert.equal(resolveDesktopDevRegion([], {}), "global");
  assert.equal(resolveDesktopDevRegion([], { CINDY_AUTH_REGION: "cn" }), "cn");
});

test("desktop dev region accepts both CLI forms and overrides the legacy env", () => {
  assert.equal(resolveDesktopDevRegion(["--region=global"], {}), "global");
  assert.equal(
    resolveDesktopDevRegion(["--region", "cn"], {
      CINDY_AUTH_REGION: "global",
    }),
    "cn",
  );
});

test("desktop dev region rejects missing, duplicate, and unsupported values", () => {
  assert.throws(
    () => resolveDesktopDevRegion(["--region"], {}),
    /requires a value/,
  );
  assert.throws(
    () => resolveDesktopDevRegion(["--region=us"], {}),
    /expected cn, global or dev/,
  );
  assert.throws(
    () => resolveDesktopDevRegion(["--region=cn", "--region", "global"], {}),
    /may only be specified once/,
  );
});

test("remote dev selects the repository manifest matching the region", () => {
  assert.deepEqual(
    resolveDesktopDevStartupConfig({
      argv: [],
      env: {},
      mode: "remote",
    }),
    {
      region: "global",
      endpointsCdn: false,
      endpointManifestFile: "config/endpoint.global.json",
    },
  );
  assert.deepEqual(
    resolveDesktopDevStartupConfig({
      argv: ["--region=cn"],
      env: {},
      mode: "remote",
    }),
    {
      region: "cn",
      endpointsCdn: false,
      endpointManifestFile: "config/endpoint.json",
    },
  );
  assert.deepEqual(
    resolveDesktopDevStartupConfig({
      argv: ["--region=global"],
      env: {},
      mode: "remote",
    }),
    {
      region: "global",
      endpointsCdn: false,
      endpointManifestFile: "config/endpoint.global.json",
    },
  );
});

test("local dev applies the explicit region to the child environment", () => {
  const env = { VITE_CINDY_AUTH_REGION: "global" };
  assert.deepEqual(
    applyDesktopDevStartupConfig({
      argv: ["start", "--", "--region=cn"],
      env,
      mode: "local",
    }),
    {
      region: "cn",
      endpointsCdn: false,
      endpointManifestFile: undefined,
    },
  );
  assert.deepEqual(env, {
    CINDY_AUTH_REGION: "cn",
    VITE_CINDY_AUTH_REGION: "cn",
  });
});

test("--endpoints-cdn keeps the selected region and bypasses the default local manifest", () => {
  assert.deepEqual(
    resolveDesktopDevStartupConfig({
      argv: ["--region=global", "--endpoints-cdn"],
      env: {},
      mode: "remote",
    }),
    {
      region: "global",
      endpointsCdn: true,
      endpointManifestFile: undefined,
    },
  );
});

test("--endpoints-cdn applies the selected region to the child process environment", () => {
  const env = {};
  applyDesktopDevStartupConfig({
    argv: ["--region=global", "--endpoints-cdn"],
    env,
    mode: "remote",
  });
  assert.deepEqual(env, {
    CINDY_AUTH_REGION: "global",
    VITE_CINDY_AUTH_REGION: "global",
    XDT_ENDPOINTS_CDN: "1",
  });
});

test("direct dev consumes the region flag before launching Electron Forge", () => {
  assert.deepEqual(
    stripDesktopDevRegionArgs([
      "start",
      "--",
      "--region",
      "global",
      "--passive",
    ]),
    ["start", "--", "--passive"],
  );
  assert.deepEqual(stripDesktopDevRegionArgs(["start", "--region=global"]), [
    "start",
  ]);
});

test("local server debugging retains its endpoint manifest", () => {
  assert.deepEqual(
    resolveDesktopDevStartupConfig({
      argv: ["--region=global"],
      env: { XDT_ENDPOINT_MANIFEST_FILE: "config/custom-endpoint.json" },
      mode: "local",
    }),
    {
      region: "global",
      endpointsCdn: false,
      endpointManifestFile: "config/custom-endpoint.json",
    },
  );
});

test("remote dev replaces inherited manifests for every selected region", () => {
  const manifests = {
    cn: "config/endpoint.json",
    global: "config/endpoint.global.json",
    dev: "config/endpoint.dev.json",
  };
  for (const inherited of [
    ...Object.values(manifests),
    "config/custom-endpoint.json",
  ]) {
    for (const [region, manifest] of Object.entries(manifests)) {
      const env = {
        CINDY_AUTH_REGION: "cn",
        VITE_CINDY_AUTH_REGION: "cn",
        XDT_ENDPOINT_MANIFEST_FILE: inherited,
      };
      applyDesktopDevStartupConfig({ argv: [`--region=${region}`], env });
      assert.equal(env.CINDY_AUTH_REGION, region);
      assert.equal(env.VITE_CINDY_AUTH_REGION, region);
      assert.equal(env.XDT_ENDPOINT_MANIFEST_FILE, manifest);
      // The downstream dev wrapper parses the environment again without CLI flags.
      applyDesktopDevStartupConfig({ argv: [], env });
      assert.equal(env.XDT_ENDPOINT_MANIFEST_FILE, manifest);
    }
  }
});

test("switching regions in the same environment also switches the endpoint file", () => {
  const env = {};
  for (const region of ["cn", "global", "dev", "cn"]) {
    const config = applyDesktopDevStartupConfig({
      argv: [`--region=${region}`],
      env,
    });
    assert.equal(config.region, region);
    assert.equal(
      env.XDT_ENDPOINT_MANIFEST_FILE,
      `config/endpoint${region === "cn" ? "" : `.${region}`}.json`,
    );
  }
});

test("remote CDN startup removes inherited files and remains CDN through the child wrapper", () => {
  for (const argv of [
    ["--region=global", "--endpoints-cdn"],
    ["--region=global"],
  ]) {
    const env = {
      XDT_ENDPOINT_MANIFEST_FILE: "config/endpoint.json",
      XDT_ENDPOINTS_CDN: "1",
    };
    applyDesktopDevStartupConfig({ argv, env });
    assert.equal(env.XDT_ENDPOINT_MANIFEST_FILE, undefined);
    assert.deepEqual(applyDesktopDevStartupConfig({ argv: [], env }), {
      region: "global",
      endpointsCdn: true,
      endpointManifestFile: undefined,
    });
  }
});
