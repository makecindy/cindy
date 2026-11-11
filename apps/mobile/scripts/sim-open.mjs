#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  extractSimWhoamiUdidArgs,
  resolveSimulatorDeviceSets,
  selectBootedSimulator,
  simctlArgs,
} from "./lib/sim-whoami.mjs";
import { openSimulatorViewer } from "./lib/simulator-viewer.mjs";

try {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const { simulatorUdid, passthrough } = extractSimWhoamiUdidArgs(args);
  if (passthrough.length)
    throw new Error(`Unsupported arguments: ${passthrough.join(" ")}`);
  // Do not boot an arbitrary default device or change the user's current target.
  const { deviceSet, targetBooted } = selectBootedSimulator(
    resolveSimulatorDeviceSets(),
    (set) =>
      execFileSync("xcrun", simctlArgs(set, ["list", "devices", "booted"]), {
        encoding: "utf8",
        timeout: 10000,
      }),
    simulatorUdid,
  );
  if (targetBooted.length !== 1)
    throw new Error(
      "Select one booted simulator with --udid; no device was changed.",
    );
  // Device Hub only shows the system device set; Cindy's simulator has its own sidebar viewer.
  if (deviceSet.path)
    throw new Error(
      `The booted device belongs to the ${deviceSet.name} simulator; open it in Cindy's sidebar instead of an external window.`,
    );
  const udid = targetBooted[0].match(/\(([0-9A-F-]{36})\)/i)[1].toUpperCase();
  const viewer = await openSimulatorViewer(udid);
  console.log(JSON.stringify({ ...viewer, udid, launchRequested: true }));
  console.log(
    "Viewer process is running. Verify the device window and fresh App bundle separately.",
  );
} catch (error) {
  console.error(`Simulator viewer launch failed: ${error.message}`);
  process.exitCode = 1;
}
