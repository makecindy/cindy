export function formatUuidBytes(bytes: Buffer): string;
export function parseUuidBytes(uuid: string): Buffer;
export function deriveMacAppMachoUuid(bundleId: string, electronVersion: string): string;
export function patchMachoUuidBuffer(
  source: Buffer,
  uuid: string | Buffer,
): { buffer: Buffer; previous: string[]; uuid: string };
export function patchMachoUuid(
  binaryPath: string,
  uuid: string | Buffer,
): { previous: string[]; uuid: string };
