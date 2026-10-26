import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
let identity: string | undefined;
let pending: Promise<string | null> | undefined;

/** A kernel boot generation, never Date.now() - uptime (wall clocks can jump). */
export async function readSchemaMigrationBootIdentity(): Promise<string | null> {
  if (identity) return identity;
  if (pending) return pending;
  pending = probe()
    .then((value) => {
      if (value) identity = value;
      return value;
    })
    .finally(() => {
      pending = undefined;
    });
  return pending;
}

async function probe(): Promise<string | null> {
  try {
    let value: string;
    if (process.platform === 'linux') {
      value = await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8');
    } else if (process.platform === 'darwin') {
      value = (
        await run('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
          timeout: 5_000,
          encoding: 'utf8',
        })
      ).stdout;
    } else if (process.platform === 'win32') {
      // SystemBootEnvironmentInformation (90) starts with the kernel's boot GUID.
      // Unlike a timestamp, this does not mistake a clock correction for a reboot.
      const script = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CindySchemaBootIdentity {
  [DllImport("ntdll.dll")]
  private static extern int NtQuerySystemInformation(int kind, IntPtr buffer, int size, out int returned);
  public static string Read() {
    IntPtr buffer = Marshal.AllocHGlobal(32);
    try {
      int returned;
      if (NtQuerySystemInformation(90, buffer, 32, out returned) != 0) return "";
      return Marshal.PtrToStructure<Guid>(buffer).ToString();
    } finally { Marshal.FreeHGlobal(buffer); }
  }
}
'@; [CindySchemaBootIdentity]::Read()`;
      value = (
        await run(
          path.join(
            process.env.SystemRoot ?? 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          ),
          ['-NoProfile', '-NonInteractive', '-Command', script],
          {
            timeout: 5_000,
            encoding: 'utf8',
            windowsHide: true,
          },
        )
      ).stdout;
    } else {
      return null;
    }
    const uuid = value.trim().toLowerCase();
    return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(uuid) &&
      uuid !== '00000000-0000-0000-0000-000000000000'
      ? `${process.platform}:${uuid}`
      : null;
  } catch {
    return null;
  }
}
