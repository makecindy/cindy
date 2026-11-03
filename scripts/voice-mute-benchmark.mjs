#!/usr/bin/env node
// macOS only. Default is read-only; --apply briefly mutes/restores system output.
// No Electron instance, account, network connection, or microphone is used.
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

if (process.platform !== "darwin")
  throw new Error("This benchmark requires macOS");
const execFile = promisify(execFileCallback);
const apply = process.argv.includes("--apply");
const temporary = await mkdtemp(path.join(os.tmpdir(), "cindy-voice-mute-ab-"));
const binary = path.join(temporary, "audio-helper");
const compiled = path.join(temporary, "mute.scpt");
const source = fileURLToPath(
  new URL(
    "../apps/desktop/native/voice-input/macos-audio-mute-helper.swift",
    import.meta.url,
  ),
);
const script = apply
  ? [
      "set wasMuted to output muted of (get volume settings)",
      "if wasMuted is false then set volume with output muted",
      "return wasMuted",
    ]
  : ["output muted of (get volume settings)"];
const scriptArgs = script.flatMap((line) => ["-e", line]);
async function timed(file, args) {
  const start = performance.now();
  const { stdout } = await execFile(file, args, { timeout: 5_000 });
  return { stdout: stdout.trim(), ms: performance.now() - start };
}
const readApple = () =>
  timed("/usr/bin/osascript", ["-e", "output muted of (get volume settings)"]);
const restoreApple = (muted) =>
  timed("/usr/bin/osascript", [
    "-e",
    `set volume ${muted ? "with" : "without"} output muted`,
  ]);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    (sorted[Math.floor((sorted.length - 1) / 2)] +
      sorted[Math.floor(sorted.length / 2)]) /
    2
  );
};
let original;
let nativeOriginal;
try {
  await execFile("/usr/bin/xcrun", ["swiftc", source, "-o", binary], {
    timeout: 30_000,
  });
  await execFile("/usr/bin/osacompile", ["-o", compiled, ...scriptArgs], {
    timeout: 10_000,
  });
  original = (await readApple()).stdout === "true";
  const cold = await timed(binary, ["read"]);
  nativeOriginal = JSON.parse(cold.stdout);
  const rows = [];
  // Reverse each block to reduce order bias. All three variants get six runs.
  const order = Array.from({ length: 3 }, () => [
    "native",
    "apple",
    "compiled",
    "compiled",
    "apple",
    "native",
  ]).flat();
  for (const mode of order) {
    const result =
      mode === "native"
        ? await timed(binary, [apply ? "mute" : "read"])
        : await timed(
            "/usr/bin/osascript",
            mode === "compiled" ? [compiled] : scriptArgs,
          );
    let restoreMs;
    if (apply) {
      if ((await readApple()).stdout !== "true")
        throw new Error("Mute did not apply");
      const restored =
        mode === "native"
          ? await timed(binary, [
              "set",
              String(nativeOriginal.deviceId),
              nativeOriginal.deviceUID,
              String(original),
            ])
          : await restoreApple(original);
      restoreMs = restored.ms;
      if ((await readApple()).stdout !== String(original))
        throw new Error("Restore mismatch");
    }
    rows.push({
      mode,
      ms: result.ms,
      ...(restoreMs === undefined ? {} : { restoreMs }),
    });
  }
  console.log(
    JSON.stringify(
      {
        kind: apply ? "REAL_OUTPUT_MUTE_AB" : "READ_ONLY_AB",
        firstNativeProbeMs: cold.ms,
        // First launch of a new binary, not a reboot/OS-cache-cleared measurement.
        medians: Object.fromEntries(
          ["native", "apple", "compiled"].map((mode) => {
            const matching = rows.filter((row) => row.mode === mode);
            return [
              mode,
              {
                ms: median(matching.map((row) => row.ms)),
                ...(apply
                  ? { restoreMs: median(matching.map((row) => row.restoreMs)) }
                  : {}),
              },
            ];
          }),
        ),
        rows,
      },
      null,
      2,
    ),
  );
} finally {
  try {
    if (apply && original !== undefined) {
      // Restore the original device first; fall back to the OS route on error.
      if (nativeOriginal) {
        await timed(binary, [
          "set",
          String(nativeOriginal.deviceId),
          nativeOriginal.deviceUID,
          String(original),
        ]).catch(() => restoreApple(original));
      } else await restoreApple(original);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
