import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { IOSSimulatorDeviceGrantRegistryFile } from "./device-grant-registry-file.js";
import type { IOSSimulatorDeviceGrant } from "./device-grant-store.js";

const GRANT: IOSSimulatorDeviceGrant = {
  simulatorUdid: "1A9D41E0-E031-4AD0-A8B5-847480802E8E",
  agentControl: "allowed",
  screenshotCapture: "denied",
  policySource: "user",
  updatedAt: "2026-08-07T00:00:00.000Z",
};

describe("IOSSimulatorDeviceGrantRegistryFile", () => {
  it("treats a missing file as empty and round-trips grants atomically", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-grants-"));
    try {
      const registry = new IOSSimulatorDeviceGrantRegistryFile(
        path.join(root, "device-grants.json"),
      );
      expect(registry.loadSync()).toEqual([]);

      registry.saveSync([GRANT]);
      expect(registry.loadSync()).toEqual([GRANT]);
      expect(
        JSON.parse(await readFile(registry.filePath, "utf8")),
      ).toMatchObject({
        version: 1,
        grants: [
          { simulatorUdid: GRANT.simulatorUdid, agentControl: "allowed" },
        ],
      });
      expect((await stat(registry.filePath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("canonicalizes device IDs and rejects malformed or duplicate snapshots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-grants-"));
    const filePath = path.join(root, "device-grants.json");
    const registry = new IOSSimulatorDeviceGrantRegistryFile(filePath);
    try {
      registry.saveSync([
        { ...GRANT, simulatorUdid: GRANT.simulatorUdid.toLowerCase() },
      ]);
      expect(registry.loadSync()[0]?.simulatorUdid).toBe(GRANT.simulatorUdid);

      await writeFile(filePath, JSON.stringify({ version: 999, grants: [] }));
      expect(() => registry.loadSync()).toThrowError(
        expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      );

      await writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          savedAt: "2026-08-07T00:00:00.000Z",
          grants: [
            GRANT,
            { ...GRANT, simulatorUdid: GRANT.simulatorUdid.toLowerCase() },
          ],
        }),
      );
      expect(() => registry.loadSync()).toThrowError(
        expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("checks the profile writer before reading and before replacing a snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-grants-"));
    let writerHeld = true;
    const registry = new IOSSimulatorDeviceGrantRegistryFile(
      path.join(root, "device-grants.json"),
      {
        assertMutationAllowed: () => {
          if (!writerHeld) throw new Error("writer lease lost");
        },
      },
    );
    try {
      registry.saveSync([GRANT]);
      writerHeld = false;
      expect(() => registry.loadSync()).toThrow("writer lease lost");
      expect(() => registry.saveSync([])).toThrow("writer lease lost");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
