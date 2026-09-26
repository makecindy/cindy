/** Shared POSIX layout helpers, also loaded directly by the Node build script. */
export function normalizeIOSSimulatorDeveloperDirectory(value: string): string;
export function iosSimulatorKitFrameworkDirectories(
  developerDirectory: string,
): string[];
export function resolveIOSSimulatorKitBinary(
  developerDirectory: string,
  readable?: (file: string) => Promise<boolean>,
): Promise<string>;
