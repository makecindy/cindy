import { access } from "node:fs/promises";
import path from "node:path";

// Plain JS is intentional: Forge invokes the helper build script with Node,
// without a TypeScript loader. Build and runtime must share the layout rules.
export function normalizeIOSSimulatorDeveloperDirectory(value) {
  const selected = path.posix.normalize(value.trim()).replace(/\/+$/, "");
  const directory = selected.endsWith(".app")
    ? path.posix.join(selected, "Contents", "Developer")
    : selected;
  if (
    !path.posix.isAbsolute(directory) ||
    !directory.endsWith(".app/Contents/Developer")
  ) {
    throw new Error("An absolute Xcode Developer directory is required");
  }
  return directory;
}

/** Xcode 27 moved SimulatorKit out of Developer/Library/PrivateFrameworks. */
export function iosSimulatorKitFrameworkDirectories(developerDirectory) {
  const directory = normalizeIOSSimulatorDeveloperDirectory(developerDirectory);
  return [
    path.posix.join(directory, "Library", "PrivateFrameworks"),
    path.posix.join(directory, "..", "SharedFrameworks"),
  ];
}

/** Build-time architecture inspection follows the same layout order as the helper. */
export async function resolveIOSSimulatorKitBinary(
  developerDirectory,
  readable = (file) =>
    access(file).then(
      () => true,
      () => false,
    ),
) {
  for (const directory of iosSimulatorKitFrameworkDirectories(
    developerDirectory,
  )) {
    const binary = path.posix.join(
      directory,
      "SimulatorKit.framework",
      "SimulatorKit",
    );
    if (await readable(binary)) return binary;
  }
  throw new Error("The selected Xcode has no SimulatorKit framework");
}
