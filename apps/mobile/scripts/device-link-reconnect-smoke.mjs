#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const allowed = new Set(["--start-server", "--dry-run", "--interop"]);
if (args.some((arg) => !allowed.has(arg))) {
  console.error(
    "Use pnpm test:device-link [--interop] [--dry-run]. Old API/dev-login options were removed; see packages/device-link/TESTING.md.",
  );
  process.exit(2);
}
// Keep the existing mobile package script without changing its runtime fingerprint.
// --start-server now means an ephemeral loopback contract fixture, not dev:server.
const interop = args.includes("--interop");
if (interop && args.includes("--start-server")) {
  console.error(
    "Use the root pnpm test:device-link --interop entry for an external test relay.",
  );
  process.exit(2);
}
if (
  interop &&
  [
    "CINDY_TEST_RELAY_URL",
    "CINDY_TEST_HOST_TOKEN",
    "CINDY_TEST_CONTROLLER_TOKEN",
  ].some((key) => !process.env[key])
) {
  console.error(
    "Interop requires CINDY_TEST_RELAY_URL, CINDY_TEST_HOST_TOKEN and CINDY_TEST_CONTROLLER_TOKEN from an isolated test environment.",
  );
  process.exit(2);
}
if (args.includes("--dry-run")) {
  console.log(
    interop
      ? "Device Link interop: formal DeviceLinkClient against the explicitly configured test relay; credentials are not printed."
      : "Device Link integration: formal DeviceLinkClient + Mobile rehydrate + Desktop subscription replay; ephemeral loopback WebSocket contract fixture, no external services.",
  );
  process.exit(0);
}
const require = createRequire(import.meta.url);
const vitest = resolve(
  dirname(require.resolve("vitest/package.json")),
  "vitest.mjs",
);
const child = spawn(
  process.execPath,
  [vitest, "run", "--config", "scripts/device-link/vitest.config.ts"],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      CINDY_DEVICE_LINK_TEST_MODE: interop ? "interop" : "contract",
    },
  },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("error", () => {
  console.error(
    "Could not start Device Link tests; run pnpm install --frozen-lockfile first.",
  );
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
});
