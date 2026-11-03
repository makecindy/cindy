#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = mkdtempSync(join(tmpdir(), "cindy-backdrop-test-"));
try {
  const source = fileURLToPath(
    new URL(
      "../modules/cindy-remote-presentation/ios/RemoteDesktopBackdrop.swift",
      import.meta.url,
    ),
  );
  const fixture = fileURLToPath(
    new URL("./fixtures/remote-desktop-backdrop.swift", import.meta.url),
  );
  const executable = join(directory, "backdrop-tests");
  execFileSync("xcrun", ["swiftc", source, fixture, "-o", executable], {
    stdio: "inherit",
  });
  execFileSync(executable, [], { stdio: "inherit" });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
