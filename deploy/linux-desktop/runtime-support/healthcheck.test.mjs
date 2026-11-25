import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { checkHealth } from "./healthcheck.mjs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("probe requires fresh, matching, complete readiness", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "cindy-instance-health-test-"),
  );
  const file = path.join(root, "status.json");
  const script = fileURLToPath(new URL("./healthcheck.mjs", import.meta.url));
  const probe = (value) => {
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    return spawnSync(process.execPath, [script], {
      env: {
        ...process.env,
        CINDY_CLOUD_STATUS_FILE: file,
        CINDY_POD_DEVICE_ID: "test-device",
      },
      encoding: "utf8",
    }).status;
  };
  const ready = {
    version: 1,
    instanceId: "test-device",
    phase: "ready",
    heartbeatAtMs: Date.now(),
    readiness: {
      auth: "ready",
      database: "ready",
      binaries: "ready",
      maker: "ready",
      deviceLink: "ready",
    },
  };
  try {
    assert.equal(probe(ready), 0);
    assert.equal(probe({ ...ready, heartbeatAtMs: Date.now() - 31_000 }), 1);
    assert.equal(probe({ ...ready, heartbeatAtMs: Date.now() + 60_000 }), 1);
    assert.equal(probe({ ...ready, heartbeatAtMs: String(Date.now()) }), 1);
    assert.equal(
      probe({ ...ready, instanceId: "control-plane-instance-id" }),
      1,
    );
    assert.equal(probe({ ...ready, phase: "stopping" }), 1);
    for (const component of Object.keys(ready.readiness)) {
      assert.equal(
        probe({
          ...ready,
          readiness: { ...ready.readiness, [component]: "unknown" },
        }),
        1,
      );
    }
    assert.equal(probe({}), 1);
    assert.equal(probe(null), 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A live runtime waiting for owner login passes startup while readiness stays
// false. Synthetic status and a private local socket; no credentials.
test("startup accepts a live login receiver without making the instance ready", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cindy-health-startup-"));
  fs.chmodSync(root, 0o700);
  const socket = path.join(root, "control.sock");
  const server = net.createServer(connection => connection.end());
  await new Promise(resolve => server.listen(socket, resolve));
  fs.chmodSync(socket, 0o600);
  const now = Date.now();
  const waiting = {version: 1, instanceId: "test-device", phase: "starting",
    heartbeatAtMs: now, authRecovery: {version: 1, state: "login-required"},
    readiness: {auth: "not-ready", database: "not-ready", deviceLink: "not-ready",
      binaries: "ready", maker: "ready"}};
  const options = {deviceId: "test-device", startup: true, now, socket};
  try {
    assert.equal(await checkHealth(waiting, options), true);
    assert.equal(await checkHealth(waiting, {...options, startup: false}), false);
    assert.equal(await checkHealth({...waiting, authRecovery: {version: 1, state: "pending"}}, options), true);
    for (const patch of [
      {heartbeatAtMs: now - 30001}, {heartbeatAtMs: now + 1},
      {instanceId: "another-device"}, {phase: "stopping"}, {authRecovery: undefined},
      {authRecovery: {version: 2, state: "login-required"}},
      {authRecovery: {version: 1, state: "unknown"}},
      {readiness: {...waiting.readiness, maker: "not-ready"}},
      {readiness: {...waiting.readiness, binaries: "not-ready"}},
    ]) assert.equal(await checkHealth({...waiting, ...patch}, options), false);
    fs.chmodSync(socket, 0o666);
    assert.equal(await checkHealth(waiting, options), false);
    fs.chmodSync(socket, 0o600);
    await new Promise(resolve => server.close(resolve));
    assert.equal(await checkHealth(waiting, options), false);
  } finally {
    server.close();
    fs.rmSync(root, {recursive: true, force: true});
  }
});
