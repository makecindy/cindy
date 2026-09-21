#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Execute the production state machine with controllable framework callbacks.
// Only framework imports are replaced; no production logic is rewritten.
const directory = mkdtempSync(join(tmpdir(), "cindy-receiver-test-"));
try {
  const source = readFileSync(
    new URL(
      "../modules/cindy-remote-presentation/ios/RemoteDesktopReceiver.swift",
      import.meta.url,
    ),
    "utf8",
  ).replace(/^import (WebRTC|UIKit)\n/gm, "");
  const fixture = readFileSync(
    new URL("./fixtures/remote-desktop-receiver.swift", import.meta.url),
    "utf8",
  );
  const input = join(directory, "ReceiverTests.swift");
  const executable = join(directory, "receiver-tests");
  const numbers = readFileSync(
    new URL(
      "../modules/cindy-remote-presentation/ios/RemoteDesktopBridgeNumber.swift",
      import.meta.url,
    ),
    "utf8",
  );
  writeFileSync(input, numbers + "\n" + source + "\n" + fixture);
  execFileSync(
    "xcrun",
    ["swiftc", "-parse-as-library", input, "-o", executable],
    { stdio: "inherit" },
  );
  execFileSync(executable, [], { stdio: "inherit" });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
