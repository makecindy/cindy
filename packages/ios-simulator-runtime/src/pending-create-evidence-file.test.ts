import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { IOSSimulatorPendingCreateEvidenceFile } from "./pending-create-evidence-file.js";

describe("IOSSimulatorPendingCreateEvidenceFile", () => {
  it("stays unarmed until a create arms it, then clears on a matching generation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-evidence-"));
    try {
      const evidence = new IOSSimulatorPendingCreateEvidenceFile(
        path.join(root, "nested", "pending-create-evidence.json"),
      );
      expect(evidence.isArmed()).toBe(false);
      expect(evidence.generation()).toBe(0);

      // The armed generation goes back to the caller so it can retire exactly
      // its own evidence later.
      expect(evidence.arm()).toBe(1);
      expect(evidence.isArmed()).toBe(true);
      expect(evidence.generation()).toBe(1);
      if (process.platform !== "win32") {
        expect((await stat(evidence.filePath)).mode & 0o777).toBe(0o600);
      }

      evidence.clearIfUnchanged(evidence.generation());
      expect(evidence.isArmed()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps evidence armed by a create that started after the sweep captured its generation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-evidence-"));
    try {
      const evidence = new IOSSimulatorPendingCreateEvidenceFile(
        path.join(root, "pending-create-evidence.json"),
      );
      evidence.arm();
      const sweepGeneration = evidence.generation();

      // A concurrent create arms again while the sweep is still running.
      evidence.arm();
      evidence.clearIfUnchanged(sweepGeneration);

      expect(evidence.isArmed()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a failed arm instead of failing the create", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-evidence-"));
    try {
      const onError = vi.fn();
      // A directory in place of the marker file makes every write fail.
      const evidence = new IOSSimulatorPendingCreateEvidenceFile(root, {
        onError,
      });

      expect(() => evidence.arm()).not.toThrow();
      expect(onError).toHaveBeenCalledOnce();
      expect(evidence.generation()).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
