/**
 * Deterministic Mach-O LC_UUID patching for macOS Electron executables.
 *
 * Prebuilt Electron binaries share one stock LC_UUID per Electron release.
 * macOS Local Network privacy (nehelper) maps executables via their Mach-O
 * LC_UUID as well as bundle identity: when two Electron apps (or stock
 * Electron.app during development) share the same LC_UUID, macOS can silently
 * inherit a prior denial and skip both the one-time system permission prompt
 * and listing the app under System Settings > Privacy & Security > Local Network.
 *
 * Patching the main app executable's LC_UUID deterministically per
 * (bundleId, electronVersion) before code signing gives each Cindy build a
 * distinct, reproducible identity while staying stable across JS-only updates.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM_64 = 0xcffaedfe;
const FAT_MAGIC = 0xcafebabe;
const FAT_CIGAM = 0xbebafeca;
const FAT_MAGIC_64 = 0xcafebabf;
const FAT_CIGAM_64 = 0xbfbafeca;
const LC_UUID = 0x1b;
const LC_UUID_SIZE = 24;
const MACH_HEADER_64_SIZE = 32;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function formatUuidBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 16) {
    throw new Error('UUID must be a 16-byte Buffer');
  }
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function parseUuidBytes(uuid) {
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) {
    throw new Error(`Invalid UUID string: ${String(uuid)}`);
  }
  return Buffer.from(uuid.replaceAll('-', ''), 'hex');
}

/** Deterministic RFC 4122 v5-shaped UUID derived from bundle ID and Electron version. */
export function deriveMacAppMachoUuid(bundleId, electronVersion) {
  const id = typeof bundleId === 'string' ? bundleId.trim() : '';
  const version = typeof electronVersion === 'string' ? electronVersion.trim() : '';
  if (!id) throw new Error('bundleId is required to derive Mach-O LC_UUID');
  if (!version) throw new Error('electronVersion is required to derive Mach-O LC_UUID');
  const digest = createHash('sha256')
    .update(`cindy-macho-lc-uuid-v1\0${id}\0${version}`)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuidBytes(bytes);
}

function patchThinSlice(data, offset, limit, newUuidBytes) {
  if (offset < 0 || offset + MACH_HEADER_64_SIZE > limit) {
    throw new Error(`Truncated Mach-O slice at offset ${offset}`);
  }
  const magicLE = data.readUInt32LE(offset);
  let readUInt32;
  if (magicLE === MH_MAGIC_64) {
    readUInt32 = (pos) => data.readUInt32LE(pos);
  } else if (magicLE === MH_CIGAM_64) {
    readUInt32 = (pos) => data.readUInt32BE(pos);
  } else {
    throw new Error(`Unsupported Mach-O header magic 0x${magicLE.toString(16)} at offset ${offset}`);
  }

  const ncmds = readUInt32(offset + 16);
  const sizeofcmds = readUInt32(offset + 20);
  const commandsEnd = offset + MACH_HEADER_64_SIZE + sizeofcmds;
  if (commandsEnd > limit) {
    throw new Error(`Mach-O load commands exceed slice bounds at offset ${offset}`);
  }

  let pos = offset + MACH_HEADER_64_SIZE;
  for (let i = 0; i < ncmds; i++) {
    if (pos + 8 > commandsEnd) {
      throw new Error(`Truncated Mach-O load command ${i} at offset ${pos}`);
    }
    const cmd = readUInt32(pos);
    const cmdsize = readUInt32(pos + 4);
    if (cmdsize < 8 || pos + cmdsize > commandsEnd) {
      throw new Error(`Invalid Mach-O load command size ${cmdsize} at offset ${pos}`);
    }
    if (cmd === LC_UUID) {
      if (cmdsize !== LC_UUID_SIZE) {
        throw new Error(`Unexpected LC_UUID command size ${cmdsize} at offset ${pos}`);
      }
      const previous = formatUuidBytes(Buffer.from(data.subarray(pos + 8, pos + 24)));
      newUuidBytes.copy(data, pos + 8);
      return previous;
    }
    pos += cmdsize;
  }
  throw new Error(`Mach-O slice at offset ${offset} has no LC_UUID load command`);
}

/**
 * Patch the LC_UUID load command of a thin 64-bit or fat/universal Mach-O buffer.
 * Returns a new Buffer and the previous UUID(s) found in each slice.
 */
export function patchMachoUuidBuffer(source, uuid) {
  if (!Buffer.isBuffer(source) || source.length < 8) {
    throw new Error('Input must be a Mach-O Buffer');
  }
  const uuidBytes = Buffer.isBuffer(uuid) ? uuid : parseUuidBytes(uuid);
  if (uuidBytes.length !== 16) {
    throw new Error('UUID must be 16 bytes');
  }
  const data = Buffer.from(source);
  const magicBE = data.readUInt32BE(0);
  const previous = [];

  if (magicBE === FAT_MAGIC || magicBE === FAT_CIGAM) {
    const readU32 = magicBE === FAT_MAGIC ? (p) => data.readUInt32BE(p) : (p) => data.readUInt32LE(p);
    const nfat = readU32(4);
    if (nfat === 0 || 8 + nfat * 20 > data.length) {
      throw new Error(`Invalid Mach-O fat header (nfat=${nfat})`);
    }
    for (let i = 0; i < nfat; i++) {
      const archBase = 8 + i * 20;
      const sliceOffset = readU32(archBase + 8);
      const sliceSize = readU32(archBase + 12);
      if (sliceOffset + sliceSize > data.length) {
        throw new Error(`Mach-O fat slice ${i} exceeds file length`);
      }
      previous.push(patchThinSlice(data, sliceOffset, sliceOffset + sliceSize, uuidBytes));
    }
  } else if (magicBE === FAT_MAGIC_64 || magicBE === FAT_CIGAM_64) {
    const readU32 = magicBE === FAT_MAGIC_64 ? (p) => data.readUInt32BE(p) : (p) => data.readUInt32LE(p);
    const readU64 = magicBE === FAT_MAGIC_64 ? (p) => Number(data.readBigUInt64BE(p)) : (p) => Number(data.readBigUInt64LE(p));
    const nfat = readU32(4);
    if (nfat === 0 || 8 + nfat * 32 > data.length) {
      throw new Error(`Invalid Mach-O fat64 header (nfat=${nfat})`);
    }
    for (let i = 0; i < nfat; i++) {
      const archBase = 8 + i * 32;
      const sliceOffset = readU64(archBase + 8);
      const sliceSize = readU64(archBase + 16);
      if (sliceOffset + sliceSize > data.length) {
        throw new Error(`Mach-O fat64 slice ${i} exceeds file length`);
      }
      previous.push(patchThinSlice(data, sliceOffset, sliceOffset + sliceSize, uuidBytes));
    }
  } else {
    previous.push(patchThinSlice(data, 0, data.length, uuidBytes));
  }

  return { buffer: data, previous, uuid: formatUuidBytes(uuidBytes) };
}

/** Patch a Mach-O executable on disk in place (must happen before codesign). */
export function patchMachoUuid(binaryPath, uuid) {
  const source = fs.readFileSync(binaryPath);
  const patched = patchMachoUuidBuffer(source, uuid);
  fs.writeFileSync(binaryPath, patched.buffer);
  return { previous: patched.previous, uuid: patched.uuid };
}
