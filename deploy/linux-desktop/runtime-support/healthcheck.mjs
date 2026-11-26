#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const components = ["auth", "database", "binaries", "maker", "deviceLink"];
const recoverySocket = "/tmp/cindy-auth-recovery/control.sock";

async function loginReceiverAlive(socket) {
  try {
    const parent = fs.lstatSync(path.dirname(socket));
    const entry = fs.lstatSync(socket);
    if (!parent.isDirectory() || parent.isSymbolicLink() ||
        parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0 ||
        !entry.isSocket() || entry.uid !== process.getuid?.() ||
        (entry.mode & 0o777) !== 0o600) return false;
    return await new Promise(resolve => {
      const connection = net.createConnection(socket);
      const finish = ok => { connection.destroy(); resolve(ok); };
      connection.setTimeout(1000);
      connection.once("connect", () => finish(true));
      connection.once("timeout", () => finish(false));
      connection.once("error", () => finish(false));
    });
  } catch { return false; }
}

/** Startup may await owner authorization; readiness never grants that exception. */
export async function checkHealth(value, {
  deviceId, startup = false, now = Date.now(), socket = recoverySocket,
}) {
  if (!value || value.version !== 1 || !deviceId || value.instanceId !== deviceId ||
      !Number.isSafeInteger(value.heartbeatAtMs)) return false;
  const age = now - value.heartbeatAtMs;
  if (age < 0 || age > 30_000) return false;
  if (value.phase === "ready" &&
      components.every(component => value.readiness?.[component] === "ready")) return true;
  return startup && value.phase === "starting" &&
    value.readiness?.binaries === "ready" && value.readiness?.maker === "ready" &&
    value.authRecovery?.version === 1 &&
    ["login-required", "pending"].includes(value.authRecovery.state) &&
    await loginReceiverAlive(socket);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--startup")) throw new Error();
    const file = process.env.CINDY_CLOUD_STATUS_FILE;
    if (!file) throw new Error();
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!await checkHealth(value, {
      deviceId: process.env.CINDY_POD_DEVICE_ID, startup: args[0] === "--startup",
    })) throw new Error();
  } catch { process.exitCode = 1; }
}
