import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { atomicWriteFileSync } from '../../utils/atomicWriteFile.js';
import { readBoundedFileNoFollowSync } from '../../utils/readBoundedFile.js';

export interface CustomBrowserSelection {
  executablePath: string;
  /** A fresh profile for each changed selection; never derived from browser-supplied input. */
  profileId: string;
}

export type SavedCustomBrowser = CustomBrowserSelection | 'invalid' | null;

export interface CustomBrowserStore {
  read(): SavedCustomBrowser;
  save(executablePath: string | null): CustomBrowserSelection | null;
}

const execFileAsync = promisify(execFile);
const SELECTION_MAX_BYTES = 32 * 1024;

function isLocalAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && value === value.trim()
    && !/[\u0000-\u001f]/.test(value) && path.isAbsolute(value)
    && (process.platform !== 'win32' || /^[a-z]:\\/i.test(value));
}

/** Inspect the approved file, never execute it as a discovery or validation probe. */
export async function isCustomBrowserExecutable(executablePath: string): Promise<boolean> {
  if (!isLocalAbsolutePath(executablePath)) return false;
  try {
    if (await fs.promises.realpath(executablePath) !== executablePath) return false;
    if (!(await fs.promises.stat(executablePath)).isFile()) return false;
    if (process.platform === 'win32') {
      if (path.extname(executablePath).toLowerCase() !== '.exe') return false;
    } else {
      await fs.promises.access(executablePath, fs.constants.X_OK);
    }
    const file = await fs.promises.open(executablePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    try {
      const header = Buffer.alloc(64);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      if (bytesRead < header.length) return false;
      switch (process.platform) {
        case 'darwin':
          return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xcafebabf]
            .includes(header.readUInt32BE(0));
        case 'win32': {
          if (header.readUInt16LE(0) !== 0x5a4d) return false;
          const peOffset = header.readUInt32LE(0x3c);
          if (peOffset < header.length) return false;
          const pe = await file.read(header, 0, 24, peOffset);
          return pe.bytesRead === 24 && header.readUInt32LE(0) === 0x4550
            && (header.readUInt16LE(22) & 0x2002) === 2; // executable image, not a DLL
        }
        case 'linux':
          return header.readUInt32BE(0) === 0x7f454c46;
        default:
          return false;
      }
    } finally {
      await file.close();
    }
  } catch {
    return false;
  }
}

// Chromium ships these data files beside the binary, in a version directory
// on Windows, or in the bundled framework on macOS. This checks packaging,
// not identity or publisher; compatibility is established by managed launch.
async function hasChromiumResources(directory: string): Promise<boolean> {
  try {
    const [icu, pak] = await Promise.all([
      fs.promises.stat(path.join(directory, 'icudtl.dat')),
      fs.promises.stat(path.join(directory, 'resources.pak')),
    ]);
    return icu.isFile() && pak.isFile();
  } catch {
    return false;
  }
}

async function hasInstalledChromiumResources(executablePath: string): Promise<boolean> {
  const binDir = path.dirname(executablePath);
  const platform = process.platform;
  if (platform !== 'darwin' && await hasChromiumResources(binDir)) return true;
  if (platform === 'linux') return false;
  const directory = platform === 'darwin' ? path.join(binDir, '..', 'Frameworks') : binDir;
  const entries = await fs.promises.opendir(directory);
  let remaining = 128;
  for await (const entry of entries) {
    if (--remaining < 0) break;
    if (!entry.isDirectory()) continue;
    if (platform === 'darwin') {
      if (entry.name.endsWith(' Framework.framework') && entry.name !== 'Electron Framework.framework'
        && await hasChromiumResources(path.join(directory, entry.name, 'Resources'))) return true;
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(entry.name) && await hasChromiumResources(path.join(directory, entry.name))) {
      return true;
    }
  }
  return false;
}

/** Only the native picker result enters here. A macOS app can have a differently named binary. */
export async function resolvePickedCustomBrowserExecutable(picked: string): Promise<string | null> {
  if (!isLocalAbsolutePath(picked)) return null;
  try {
    let executablePath: string;
    if (process.platform === 'darwin') {
      const bundle = await fs.promises.realpath(picked);
      if (path.extname(bundle).toLowerCase() !== '.app' || !(await fs.promises.stat(bundle)).isDirectory()) return null;
      const { stdout } = await execFileAsync('/usr/bin/plutil', [
        '-extract', 'CFBundleExecutable', 'raw', '-o', '-', '--', path.join(bundle, 'Contents', 'Info.plist'),
      ], { timeout: 2000, maxBuffer: 4096 });
      const name = stdout.trimEnd();
      if (!name || name !== path.basename(name) || name === '.' || name === '..') return null;
      const binDir = path.join(bundle, 'Contents', 'MacOS');
      executablePath = await fs.promises.realpath(path.join(binDir, name));
      if (path.dirname(executablePath) !== binDir) return null;
    } else {
      executablePath = await fs.promises.realpath(picked);
    }
    return await isCustomBrowserExecutable(executablePath) && await hasInstalledChromiumResources(executablePath)
      ? executablePath : null;
  } catch {
    return null;
  }
}

/** Desktop profile-local consent. Not part of the editable settings API, migration, or sync. */
export function createCustomBrowserStore(userDataDir: string): CustomBrowserStore {
  const file = path.join(userDataDir, 'browser-custom-selection.json');

  function read(): SavedCustomBrowser {
    for (const candidate of [file, `${file}.bak`]) {
      try {
        const raw = readBoundedFileNoFollowSync(candidate, SELECTION_MAX_BYTES);
        if (!raw) return 'invalid';
        const { executablePath, profileId } = JSON.parse(raw.toString('utf8')) as Partial<CustomBrowserSelection>;
        return isLocalAbsolutePath(executablePath) && typeof profileId === 'string'
          && /^[a-f0-9]{32}$/.test(profileId) ? { executablePath, profileId } : 'invalid';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'invalid';
      }
    }
    return null;
  }

  function save(executablePath: string | null): CustomBrowserSelection | null {
    if (executablePath === null) {
      // Never let the atomic writer's recovery copy resurrect a reset selection.
      fs.rmSync(`${file}.bak`, { force: true });
      fs.rmSync(file, { force: true });
      return null;
    }
    const selection = { executablePath, profileId: randomUUID().replaceAll('-', '') };
    atomicWriteFileSync(file, JSON.stringify(selection));
    return selection;
  }

  return { read, save };
}
