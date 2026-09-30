#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { extractSimWhoamiUdidArgs } from "./lib/sim-whoami.mjs";
import { openSimulatorViewer } from "./lib/simulator-viewer.mjs";

try {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const { simulatorUdid, passthrough } = extractSimWhoamiUdidArgs(args);
  if (passthrough.length)
    throw new Error(`Unsupported arguments: ${passthrough.join(" ")}`);
  // Do not boot an arbitrary default device or change the user's current target.
  const { devices } = JSON.parse(
    execFileSync("xcrun", ["simctl", "list", "devices", "booted", "--json"], {
      encoding: "utf8",
      timeout: 10000,
    }),
  );
  const targets = Object.values(devices)
    .flat()
    .filter(
      (device) =>
        device.state === "Booted" &&
        (!simulatorUdid || device.udid.toUpperCase() === simulatorUdid),
    );
  if (targets.length !== 1)
    throw new Error(
      "Select one booted simulator with --udid; no device was changed.",
    );
  const viewer = await openSimulatorViewer(targets[0].udid);
  console.log(
    JSON.stringify({ ...viewer, udid: targets[0].udid, launchRequested: true }),
  );
  console.log(
    "Viewer process is running. Verify the device window and fresh App bundle separately.",
  );
} catch (error) {
  console.error(`Simulator viewer launch failed: ${error.message}`);
  process.exitCode = 1;
}
