/**
 * Custom Library first-create: mkdir/open/meta stay on a held parent directory
 * fd. Darwin uses a fixed /usr/bin/perl mkdirat/openat helper (SYS_mkdirat=475,
 * SYS_openat=463 from MacOSX.sdk sys/syscall.h). Linux uses /proc/self/fd.
 * Windows uses the same PowerShell NtCreateFile helper: FILE_OPEN_IF dirs and
 * FILE_CREATE meta from the inherited parent handle. Missing helpers fail
 * closed before any mutation. No path mkdir fallback. Segments are
 * fixed/validated names, never concatenated user paths.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type CustomTreeInitResult =
  | { ok: true; createdMeta: boolean }
  | { ok: false; code: 'UNSUPPORTED' | 'IO' | 'INVALID' };

export type CustomExistingMeta = { version: 1; ghostId: string; createdAt: number };
export type CustomExistingUsage = { files: number; bytes: number; updatedAt: number; mutations: number };
export type CustomExistingResult =
  | { ok: true; meta: CustomExistingMeta; usage: CustomExistingUsage | null }
  | { ok: false; code: 'UNSUPPORTED' | 'IO' | 'INVALID' | 'MISSING' | 'CORRUPT' };

const HELPER_TIMEOUT_MS = 15_000;
const SYS_OPENAT = 463;
const SYS_MKDIRAT = 475;
const SYS_FSYNC = 95;

function validSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment.length <= 255 &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('\0') &&
    !segment.includes('/') &&
    !segment.includes('\\')
  );
}

const DARWIN_INIT_SCRIPT = String.raw`
use strict;
use warnings;
use Fcntl qw(O_RDONLY O_WRONLY O_CREAT O_EXCL O_DIRECTORY O_NOFOLLOW :mode);
use POSIX qw(write close);
use Errno qw(EEXIST);

use constant SYS_openat => ${SYS_OPENAT};
use constant SYS_mkdirat => ${SYS_MKDIRAT};
use constant SYS_fsync => ${SYS_FSYNC};

sub fail_closed { exit 1; }

sub valid_segment {
  my ($segment) = @_;
  return 0 if !defined($segment) || $segment eq '' || length($segment) > 255;
  return 0 if $segment eq '.' || $segment eq '..';
  return 0 if index($segment, '/') >= 0 || index($segment, "\\") >= 0 || index($segment, "\0") >= 0;
  return 1;
}

sub mkdirat_seg {
  my ($parent, $name) = @_;
  fail_closed() unless valid_segment($name);
  my $seg = "$name";
  my $mode = 0700;
  my $rc = syscall(SYS_mkdirat, $parent + 0, $seg, $mode);
  if (!defined($rc) || $rc < 0) {
    fail_closed() unless $! == EEXIST;
  }
}

sub openat_dir {
  my ($parent, $name) = @_;
  fail_closed() unless valid_segment($name);
  my $seg = "$name";
  my $flags = O_RDONLY | O_NOFOLLOW | O_DIRECTORY;
  my $fd = syscall(SYS_openat, $parent + 0, $seg, $flags, 0);
  fail_closed() if !defined($fd) || $fd < 0;
  return $fd;
}

my $ghost = $ARGV[0];
fail_closed() unless valid_segment($ghost);
my $meta = $ENV{CINDY_LIBRARY_META_JSON} // '';
fail_closed() unless $meta =~ /^\{"version":1,"ghostId":"[A-Za-z0-9._-]{1,128}","createdAt":[0-9]{1,16}\}$/;

my $parent = fileno(STDIN);
fail_closed() unless defined $parent && $parent >= 0;
my @pst = stat(STDIN);
fail_closed() unless @pst && S_ISDIR($pst[2]);

mkdirat_seg($parent, $ghost);
my $root = openat_dir($parent, $ghost);
mkdirat_seg($root, '.cindy-library');
my $meta_dir = openat_dir($root, '.cindy-library');
mkdirat_seg($meta_dir, 'tmp');
mkdirat_seg($meta_dir, 'backups');

my $flags = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW;
my $meta_name = 'meta.json';
my $meta_mode = 0600;
my $mfd = syscall(SYS_openat, $meta_dir + 0, $meta_name, $flags, $meta_mode);
my $created = 0;
if (defined($mfd) && $mfd >= 0) {
  $created = 1;
  my $w = POSIX::write($mfd, $meta, length($meta));
  fail_closed() unless defined($w) && $w == length($meta);
  syscall(SYS_fsync, $mfd);
  POSIX::close($mfd);
} else {
  fail_closed() unless $! == EEXIST;
}

POSIX::close($meta_dir);
POSIX::close($root);
print STDOUT ($created ? 'created' : 'exists');
`;

function runDarwinInit(parentFd: number, ghostId: string, metaJson: string): Promise<CustomTreeInitResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('/usr/bin/perl', ['-e', DARWIN_INIT_SCRIPT, '--', ghostId], {
        stdio: [parentFd, 'pipe', 'pipe'],
        env: { CINDY_LIBRARY_META_JSON: metaJson },
      });
    } catch {
      resolve({ ok: false, code: 'UNSUPPORTED' });
      return;
    }
    let settled = false;
    const finish = (value: CustomTreeInitResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once('error', () => finish({ ok: false, code: 'UNSUPPORTED' }));
    child.once('close', (code) => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (code === 0 && (text === 'created' || text === 'exists')) {
        finish({ ok: true, createdMeta: text === 'created' });
        return;
      }
      finish({ ok: false, code: 'IO' });
    });
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, code: 'IO' });
    }, HELPER_TIMEOUT_MS);
    timer.unref?.();
  });
}

function linuxInit(parentFd: number, ghostId: string, metaJson: string): CustomTreeInitResult {
  const opened: number[] = [];
  try {
    const mkdirAt = (dirFd: number, name: string): void => {
      try {
        fs.mkdirSync(`/proc/self/fd/${dirFd}/${name}`, { recursive: false });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    };
    const openDirAt = (dirFd: number, name: string): number => {
      let flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
      if (fs.constants.O_DIRECTORY) flags |= fs.constants.O_DIRECTORY;
      const fd = fs.openSync(`/proc/self/fd/${dirFd}/${name}`, flags);
      opened.push(fd);
      const st = fs.fstatSync(fd);
      if (!st.isDirectory()) throw Object.assign(new Error('not dir'), { code: 'ENOTDIR' });
      return fd;
    };
    mkdirAt(parentFd, ghostId);
    const rootFd = openDirAt(parentFd, ghostId);
    mkdirAt(rootFd, '.cindy-library');
    const metaDirFd = openDirAt(rootFd, '.cindy-library');
    mkdirAt(metaDirFd, 'tmp');
    mkdirAt(metaDirFd, 'backups');
    let createdMeta = false;
    try {
      const flags =
        fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0);
      const metaFd = fs.openSync(`/proc/self/fd/${metaDirFd}/meta.json`, flags, 0o600);
      opened.push(metaFd);
      fs.writeSync(metaFd, metaJson);
      fs.fsyncSync(metaFd);
      createdMeta = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    return { ok: true, createdMeta };
  } catch {
    return { ok: false, code: 'IO' };
  } finally {
    for (const fd of opened.reverse()) {
      try {
        fs.closeSync(fd);
      } catch {
        /* always close helper fds */
      }
    }
  }
}

export async function initCustomLibraryTree(req: {
  parentFd: number;
  ghostId: string;
  metaJson: string;
}): Promise<CustomTreeInitResult> {
  if (!validSegment(req.ghostId) || !Number.isInteger(req.parentFd) || req.parentFd < 0) {
    return { ok: false, code: 'INVALID' };
  }
  if (!/^\{"version":1,"ghostId":"[A-Za-z0-9._-]{1,128}","createdAt":[0-9]{1,16}\}$/.test(req.metaJson)) {
    return { ok: false, code: 'INVALID' };
  }
  if (process.platform === 'darwin') return runDarwinInit(req.parentFd, req.ghostId, req.metaJson);
  if (process.platform === 'linux') return linuxInit(req.parentFd, req.ghostId, req.metaJson);
  if (process.platform === 'win32') return runWindowsInit(req.parentFd, req.ghostId, req.metaJson);
  return { ok: false, code: 'UNSUPPORTED' };
}

const DARWIN_OPEN_EXISTING_SCRIPT = String.raw`
use strict;
use warnings;
use Fcntl qw(O_RDONLY O_DIRECTORY O_NOFOLLOW :mode);
use POSIX qw(read close);

use constant SYS_openat => ${SYS_OPENAT};

sub fail_closed { exit 1; }
sub missing { print STDOUT 'MISSING'; exit 0; }

sub valid_segment {
  my ($segment) = @_;
  return 0 if !defined($segment) || $segment eq '' || length($segment) > 255;
  return 0 if $segment eq '.' || $segment eq '..';
  return 0 if index($segment, '/') >= 0 || index($segment, "\\") >= 0 || index($segment, "\0") >= 0;
  return 1;
}

sub openat_dir {
  my ($parent, $name) = @_;
  fail_closed() unless valid_segment($name);
  my $seg = "$name";
  my $flags = O_RDONLY | O_NOFOLLOW | O_DIRECTORY;
  my $fd = syscall(SYS_openat, $parent + 0, $seg, $flags, 0);
  missing() if !defined($fd) || $fd < 0;
  return $fd;
}

sub openat_file {
  my ($parent, $name) = @_;
  fail_closed() unless valid_segment($name);
  my $seg = "$name";
  my $flags = O_RDONLY | O_NOFOLLOW;
  my $fd = syscall(SYS_openat, $parent + 0, $seg, $flags, 0);
  return undef if !defined($fd) || $fd < 0;
  return $fd;
}

sub read_all {
  my ($fd) = @_;
  my $buf = '';
  while (1) {
    my $chunk = '';
    my $n = POSIX::read($fd, $chunk, 8192);
    last if !defined($n) || $n == 0;
    $buf .= $chunk;
  }
  return $buf;
}

my $ghost = $ARGV[0];
fail_closed() unless valid_segment($ghost);
my $parent = fileno(STDIN);
fail_closed() unless defined $parent && $parent >= 0;
my @pst = stat(STDIN);
fail_closed() unless @pst && S_ISDIR($pst[2]);

my $root = openat_dir($parent, $ghost);
my $meta_dir = openat_dir($root, '.cindy-library');
openat_dir($meta_dir, 'tmp');
openat_dir($meta_dir, 'backups');
my $mfd = openat_file($meta_dir, 'meta.json');
missing() unless defined $mfd;
my $meta_raw = read_all($mfd);
POSIX::close($mfd);
my $ufd = openat_file($meta_dir, 'usage.json');
my $usage_raw = '';
if (defined $ufd) {
  $usage_raw = read_all($ufd);
  POSIX::close($ufd);
}
POSIX::close($meta_dir);
POSIX::close($root);
print STDOUT "OK\n$meta_raw\n";
print STDOUT $usage_raw;
`;

function extractJsonValue(source: string, from: number): { json: string; end: number } | null {
  let i = from;
  while (i < source.length && (source[i] === ' ' || source[i] === '\n' || source[i] === '\r' || source[i] === '\t')) i += 1;
  if (i >= source.length || (source[i] !== '{' && source[i] !== '[')) return null;
  const start = i;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (; i < source.length; i += 1) {
    const c = source[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === '\\') {
        esc = true;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{' || c === '[') depth += 1;
    if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return { json: source.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}

/** Existing-open helper payload: `OK` + complete JSON value(s), or `MISSING`. Pretty or compact. */
export function parseExistingStdout(text: string): CustomExistingResult {
  const body = text.replace(/^\uFEFF/, '');
  const trimmed = body.replace(/^\s+/, '');
  if (trimmed === 'MISSING' || trimmed.startsWith('MISSING\n') || trimmed.startsWith('MISSING\r\n')) {
    return { ok: false, code: 'MISSING' };
  }
  if (!trimmed.startsWith('OK')) return { ok: false, code: 'IO' };
  let rest = trimmed.slice(2);
  if (rest.startsWith('\r\n')) rest = rest.slice(2);
  else if (rest.startsWith('\n')) rest = rest.slice(1);
  const metaTok = extractJsonValue(rest, 0);
  if (!metaTok) return { ok: false, code: 'CORRUPT' };
  let meta: CustomExistingMeta;
  try {
    const parsed = JSON.parse(metaTok.json) as CustomExistingMeta;
    if (
      typeof parsed !== 'object' || parsed === null || parsed.version !== 1 ||
      typeof parsed.ghostId !== 'string' || typeof parsed.createdAt !== 'number'
    ) {
      return { ok: false, code: 'CORRUPT' };
    }
    meta = parsed;
  } catch {
    return { ok: false, code: 'CORRUPT' };
  }
  const afterMeta = rest.slice(metaTok.end);
  const usageTok = extractJsonValue(afterMeta, 0);
  let usage: CustomExistingUsage | null = null;
  if (usageTok) {
    try {
      const parsed = JSON.parse(usageTok.json) as CustomExistingUsage;
      if (
        typeof parsed !== 'object' || parsed === null ||
        typeof parsed.files !== 'number' || typeof parsed.bytes !== 'number'
      ) {
        return { ok: false, code: 'CORRUPT' };
      }
      usage = {
        files: parsed.files,
        bytes: parsed.bytes,
        updatedAt: parsed.updatedAt ?? 0,
        mutations: parsed.mutations ?? 0,
      };
    } catch {
      return { ok: false, code: 'CORRUPT' };
    }
    if (afterMeta.slice(usageTok.end).trim() !== '') return { ok: false, code: 'CORRUPT' };
  } else if (afterMeta.trim() !== '') {
    return { ok: false, code: 'CORRUPT' };
  }
  return { ok: true, meta, usage };
}

function runDarwinOpenExisting(parentFd: number, ghostId: string): Promise<CustomExistingResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('/usr/bin/perl', ['-e', DARWIN_OPEN_EXISTING_SCRIPT, '--', ghostId], {
        stdio: [parentFd, 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin' },
      });
    } catch {
      resolve({ ok: false, code: 'UNSUPPORTED' });
      return;
    }
    let settled = false;
    const finish = (value: CustomExistingResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once('error', () => finish({ ok: false, code: 'UNSUPPORTED' }));
    child.once('close', (code) => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (code !== 0) {
        finish({ ok: false, code: text === 'MISSING' ? 'MISSING' : 'IO' });
        return;
      }
      finish(parseExistingStdout(text));
    });
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, code: 'IO' });
    }, HELPER_TIMEOUT_MS);
    timer.unref?.();
  });
}

function linuxOpenExisting(parentFd: number, ghostId: string): CustomExistingResult {
  const opened: number[] = [];
  try {
    const openDirAt = (dirFd: number, name: string): number => {
      let flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
      if (fs.constants.O_DIRECTORY) flags |= fs.constants.O_DIRECTORY;
      const fd = fs.openSync(`/proc/self/fd/${dirFd}/${name}`, flags);
      opened.push(fd);
      if (!fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('not dir'), { code: 'ENOTDIR' });
      return fd;
    };
    const rootFd = openDirAt(parentFd, ghostId);
    const metaDirFd = openDirAt(rootFd, '.cindy-library');
    openDirAt(metaDirFd, 'tmp');
    openDirAt(metaDirFd, 'backups');
    const metaFd = fs.openSync(`/proc/self/fd/${metaDirFd}/meta.json`, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    opened.push(metaFd);
    const metaRaw = fs.readFileSync(metaFd, 'utf8');
    let usageRaw = '';
    try {
      const usageFd = fs.openSync(`/proc/self/fd/${metaDirFd}/usage.json`, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      opened.push(usageFd);
      usageRaw = fs.readFileSync(usageFd, 'utf8');
    } catch {
      usageRaw = '';
    }
    return parseExistingStdout(`OK\n${metaRaw}\n${usageRaw}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, code: 'MISSING' };
    return { ok: false, code: 'IO' };
  } finally {
    for (const fd of opened.reverse()) {
      try {
        fs.closeSync(fd);
      } catch {
        /* always close */
      }
    }
  }
}

/** Read an already-initialized custom library from the held parent fd. Never mkdir. */
export async function openExistingCustomLibrary(req: {
  parentFd: number;
  ghostId: string;
}): Promise<CustomExistingResult> {
  if (!validSegment(req.ghostId) || !Number.isInteger(req.parentFd) || req.parentFd < 0) {
    return { ok: false, code: 'INVALID' };
  }
  if (process.platform === 'darwin') return runDarwinOpenExisting(req.parentFd, req.ghostId);
  if (process.platform === 'linux') return linuxOpenExisting(req.parentFd, req.ghostId);
  if (process.platform === 'win32') return runWindowsOpenExisting(req.parentFd, req.ghostId);
  return { ok: false, code: 'UNSUPPORTED' };
}

function windowsPowerShellPath(): string | null {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) return null;
  const executable = path.win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  try {
    return fs.statSync(executable).isFile() ? executable : null;
  } catch {
    return null;
  }
}

/** Staging leftovers from atomicWrite (`uuid.tmp`) and streams (`uuid.stream`). Not unique originals. */
export const PROVABLE_STAGING_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(tmp|stream)$/i;

/**
 * Age + empty streams Map cannot prove uuid.tmp/.stream are garbage:
 * atomicWrite/stream may have fsynced a complete unique payload before rename.
 * Diagnostic list only. No unlink. P2_tmp UNRESOLVED.
 */
export function listProvableStagingOnLinux(
  parentFd: number,
  ghostId: string,
): { ok: true; names: string[] } | { ok: false; code: 'UNSUPPORTED' | 'IO' | 'MISSING' } {
  if (process.platform !== 'linux') return { ok: false, code: 'UNSUPPORTED' };
  if (!validSegment(ghostId) || !Number.isInteger(parentFd) || parentFd < 0) {
    return { ok: false, code: 'IO' };
  }
  const opened: number[] = [];
  try {
    const openDirAt = (dirFd: number, name: string): number => {
      let flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
      if (fs.constants.O_DIRECTORY) flags |= fs.constants.O_DIRECTORY;
      const fd = fs.openSync(`/proc/self/fd/${dirFd}/${name}`, flags);
      opened.push(fd);
      return fd;
    };
    const rootFd = openDirAt(parentFd, ghostId);
    const metaDirFd = openDirAt(rootFd, '.cindy-library');
    const tmpFd = openDirAt(metaDirFd, 'tmp');
    const names = fs.readdirSync(`/proc/self/fd/${tmpFd}`).filter((name) => PROVABLE_STAGING_NAME.test(name));
    return { ok: true, names };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, code: 'MISSING' };
    return { ok: false, code: 'IO' };
  } finally {
    for (const fd of opened.reverse()) {
      try {
        fs.closeSync(fd);
      } catch {
        /* always close */
      }
    }
  }
}

const WINDOWS_EXISTING_OPEN_SCRIPT = String.raw`
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class CindyLibraryExistingOpen {
  private const uint FILE_READ_DATA = 0x00000001;
  private const uint FILE_READ_ATTRIBUTES = 0x00000080;
  private const uint SYNCHRONIZE = 0x00100000;
  private const uint FILE_SHARE_ALL = 0x00000007;
  private const uint FILE_SHARE_READ_WRITE = 0x00000003;
  private const uint FILE_OPEN = 0x00000001;
  private const uint FILE_DIRECTORY_FILE = 0x00000001;
  private const uint FILE_NON_DIRECTORY_FILE = 0x00000040;
  private const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
  private const uint FILE_OPEN_REPARSE_POINT = 0x00200000;
  private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;

  [StructLayout(LayoutKind.Sequential)]
  private struct UNICODE_STRING {
    public ushort Length;
    public ushort MaximumLength;
    public IntPtr Buffer;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct OBJECT_ATTRIBUTES {
    public int Length;
    public IntPtr RootDirectory;
    public IntPtr ObjectName;
    public uint Attributes;
    public IntPtr SecurityDescriptor;
    public IntPtr SecurityQualityOfService;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct IO_STATUS_BLOCK {
    public IntPtr Status;
    public IntPtr Information;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct FILE_ATTRIBUTE_TAG_INFO {
    public uint FileAttributes;
    public uint ReparseTag;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct BY_HANDLE_FILE_INFORMATION {
    public uint FileAttributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }

  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr handle, out BY_HANDLE_FILE_INFORMATION info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(IntPtr handle, int infoClass, out FILE_ATTRIBUTE_TAG_INFO info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr hFile, byte[] buffer, uint toRead, out uint read, IntPtr overlapped);
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out SafeFileHandle fileHandle, uint desiredAccess, ref OBJECT_ATTRIBUTES objectAttributes, out IO_STATUS_BLOCK ioStatusBlock, IntPtr allocationSize, uint fileAttributes, uint shareAccess, uint createDisposition, uint createOptions, IntPtr eaBuffer, uint eaLength);

  private static bool ValidSegment(string segment) {
    if (String.IsNullOrEmpty(segment) || segment.Length > 255) return false;
    if (segment == "." || segment == "..") return false;
    return segment.IndexOf('/') < 0 && segment.IndexOf((char)92) < 0 && segment.IndexOf((char)0) < 0 && segment.IndexOf(':') < 0;
  }

  private static SafeFileHandle OpenRelative(IntPtr root, string name, bool directory, bool readData) {
    if (!ValidSegment(name)) return null;
    IntPtr nameBuffer = IntPtr.Zero;
    IntPtr unicodePointer = IntPtr.Zero;
    try {
      nameBuffer = Marshal.StringToHGlobalUni(name);
      var unicode = new UNICODE_STRING {
        Length = checked((ushort)(name.Length * 2)),
        MaximumLength = checked((ushort)((name.Length + 1) * 2)),
        Buffer = nameBuffer
      };
      unicodePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
      Marshal.StructureToPtr(unicode, unicodePointer, false);
      var attributes = new OBJECT_ATTRIBUTES {
        Length = Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)),
        RootDirectory = root,
        ObjectName = unicodePointer,
        Attributes = 0,
        SecurityDescriptor = IntPtr.Zero,
        SecurityQualityOfService = IntPtr.Zero
      };
      IO_STATUS_BLOCK statusBlock;
      SafeFileHandle opened;
      uint access = (readData ? FILE_READ_DATA : 0) | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
      uint options = FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT |
        (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE);
      int status = NtCreateFile(out opened, access, ref attributes, out statusBlock, IntPtr.Zero, 0,
        directory ? FILE_SHARE_READ_WRITE : FILE_SHARE_ALL, FILE_OPEN, options, IntPtr.Zero, 0);
      if (status < 0 || opened == null || opened.IsInvalid) {
        if (opened != null) opened.Dispose();
        return null;
      }
      FILE_ATTRIBUTE_TAG_INFO tag;
      if (!GetFileInformationByHandleEx(opened.DangerousGetHandle(), 9, out tag, (uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO))) ||
          (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        opened.Dispose();
        return null;
      }
      return opened;
    } catch {
      return null;
    } finally {
      if (unicodePointer != IntPtr.Zero) Marshal.FreeHGlobal(unicodePointer);
      if (nameBuffer != IntPtr.Zero) Marshal.FreeHGlobal(nameBuffer);
    }
  }

  private static string ReadUtf8(IntPtr handle) {
    var chunks = new List<byte>();
    byte[] buffer = new byte[4096];
    uint read;
    while (ReadFile(handle, buffer, (uint)buffer.Length, out read, IntPtr.Zero) && read > 0) {
      for (int i = 0; i < read; i++) chunks.Add(buffer[i]);
      if (chunks.Count > 1048576) return null;
    }
    return Encoding.UTF8.GetString(chunks.ToArray());
  }

  public static int Run(string ghostId) {
    if (!ValidSegment(ghostId)) return 2;
    IntPtr parent = GetStdHandle(-10);
    if (parent == IntPtr.Zero || parent == new IntPtr(-1)) return 2;
    BY_HANDLE_FILE_INFORMATION parentInfo;
    if (!GetFileInformationByHandle(parent, out parentInfo) ||
        (parentInfo.FileIndexHigh == 0 && parentInfo.FileIndexLow == 0)) return 2;
    var opened = new List<SafeFileHandle>();
    try {
      SafeFileHandle ghost = OpenRelative(parent, ghostId, true, false);
      if (ghost == null) { Console.Out.Write("MISSING"); return 0; }
      opened.Add(ghost);
      SafeFileHandle metaDir = OpenRelative(ghost.DangerousGetHandle(), ".cindy-library", true, false);
      if (metaDir == null) { Console.Out.Write("MISSING"); return 0; }
      opened.Add(metaDir);
      SafeFileHandle tmp = OpenRelative(metaDir.DangerousGetHandle(), "tmp", true, false);
      if (tmp == null) { Console.Out.Write("MISSING"); return 0; }
      opened.Add(tmp);
      SafeFileHandle backups = OpenRelative(metaDir.DangerousGetHandle(), "backups", true, false);
      if (backups == null) { Console.Out.Write("MISSING"); return 0; }
      opened.Add(backups);
      SafeFileHandle meta = OpenRelative(metaDir.DangerousGetHandle(), "meta.json", false, true);
      if (meta == null) { Console.Out.Write("MISSING"); return 0; }
      opened.Add(meta);
      string metaRaw = ReadUtf8(meta.DangerousGetHandle());
      if (metaRaw == null) return 1;
      string usageRaw = "";
      SafeFileHandle usage = OpenRelative(metaDir.DangerousGetHandle(), "usage.json", false, true);
      if (usage != null) {
        opened.Add(usage);
        usageRaw = ReadUtf8(usage.DangerousGetHandle()) ?? "";
      }
      Console.Out.Write("OK\n" + metaRaw + "\n" + usageRaw);
      return 0;
    } finally {
      for (int i = opened.Count - 1; i >= 0; i--) opened[i].Dispose();
    }
  }
}
'@
try {
  $ghost = $env:CINDY_LIBRARY_GHOST_ID
  $code = [CindyLibraryExistingOpen]::Run([string]$ghost)
  exit $code
} catch {
  exit 1
}
`;

const WINDOWS_EXISTING_OPEN_COMMAND = Buffer.from(WINDOWS_EXISTING_OPEN_SCRIPT, 'utf16le').toString('base64');

function runWindowsOpenExisting(parentFd: number, ghostId: string): Promise<CustomExistingResult> {
  return new Promise((resolve) => {
    const powershell = windowsPowerShellPath();
    if (!powershell) {
      resolve({ ok: false, code: 'UNSUPPORTED' });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', WINDOWS_EXISTING_OPEN_COMMAND], {
        stdio: [parentFd, 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, CINDY_LIBRARY_GHOST_ID: ghostId },
      });
    } catch {
      resolve({ ok: false, code: 'UNSUPPORTED' });
      return;
    }
    let settled = false;
    const finish = (value: CustomExistingResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once('error', () => finish({ ok: false, code: 'UNSUPPORTED' }));
    child.once('close', (code) => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (code === 2) {
        finish({ ok: false, code: 'UNSUPPORTED' });
        return;
      }
      if (code !== 0) {
        finish({ ok: false, code: text === 'MISSING' ? 'MISSING' : 'IO' });
        return;
      }
      finish(parseExistingStdout(text));
    });
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, code: 'IO' });
    }, HELPER_TIMEOUT_MS);
    timer.unref?.();
  });
}

const WINDOWS_INIT_SCRIPT = String.raw`
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

public static class CindyLibraryInit {
  private const uint FILE_LIST_DIRECTORY = 0x00000001;
  private const uint FILE_ADD_FILE = 0x00000002;
  private const uint FILE_ADD_SUBDIRECTORY = 0x00000004;
  private const uint FILE_TRAVERSE = 0x00000020;
  private const uint FILE_WRITE_DATA = 0x00000002;
  private const uint FILE_READ_ATTRIBUTES = 0x00000080;
  private const uint SYNCHRONIZE = 0x00100000;
  private const uint FILE_SHARE_READ_WRITE = 0x00000003;
  private const uint FILE_SHARE_ALL = 0x00000007;
  private const uint FILE_OPEN = 0x00000001;
  private const uint FILE_CREATE = 0x00000002;
  private const uint FILE_OPEN_IF = 0x00000003;
  private const uint FILE_DIRECTORY_FILE = 0x00000001;
  private const uint FILE_NON_DIRECTORY_FILE = 0x00000040;
  private const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
  private const uint FILE_OPEN_REPARSE_POINT = 0x00200000;
  private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
  private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
  private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
  private const int STATUS_OBJECT_NAME_COLLISION = unchecked((int)0xC0000035);

  [StructLayout(LayoutKind.Sequential)]
  private struct UNICODE_STRING {
    public ushort Length;
    public ushort MaximumLength;
    public IntPtr Buffer;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct OBJECT_ATTRIBUTES {
    public int Length;
    public IntPtr RootDirectory;
    public IntPtr ObjectName;
    public uint Attributes;
    public IntPtr SecurityDescriptor;
    public IntPtr SecurityQualityOfService;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct IO_STATUS_BLOCK {
    public IntPtr Status;
    public IntPtr Information;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct FILE_ATTRIBUTE_TAG_INFO {
    public uint FileAttributes;
    public uint ReparseTag;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct BY_HANDLE_FILE_INFORMATION {
    public uint FileAttributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }

  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr handle, out BY_HANDLE_FILE_INFORMATION info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(IntPtr handle, int infoClass, out FILE_ATTRIBUTE_TAG_INFO info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(IntPtr hFile, byte[] buffer, uint toWrite, out uint written, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(IntPtr hFile);
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out SafeFileHandle fileHandle, uint desiredAccess, ref OBJECT_ATTRIBUTES objectAttributes, out IO_STATUS_BLOCK ioStatusBlock, IntPtr allocationSize, uint fileAttributes, uint shareAccess, uint createDisposition, uint createOptions, IntPtr eaBuffer, uint eaLength);

  private static bool ValidSegment(string segment) {
    if (String.IsNullOrEmpty(segment) || segment.Length > 255) return false;
    if (segment == "." || segment == "..") return false;
    return segment.IndexOf('/') < 0 && segment.IndexOf((char)92) < 0 && segment.IndexOf((char)0) < 0 && segment.IndexOf(':') < 0;
  }

  private enum RelativeStatus { Ok, Collision, Reparse, Failed }
  private struct RelativeOpen {
    public SafeFileHandle Handle;
    public RelativeStatus Status;
  }

  private static RelativeOpen CreateRelative(IntPtr root, string name, bool directory, uint disposition, uint access) {
    var failed = new RelativeOpen { Handle = null, Status = RelativeStatus.Failed };
    if (!ValidSegment(name)) return failed;
    IntPtr nameBuffer = IntPtr.Zero;
    IntPtr unicodePointer = IntPtr.Zero;
    SafeFileHandle opened = null;
    try {
      nameBuffer = Marshal.StringToHGlobalUni(name);
      var unicode = new UNICODE_STRING {
        Length = checked((ushort)(name.Length * 2)),
        MaximumLength = checked((ushort)((name.Length + 1) * 2)),
        Buffer = nameBuffer
      };
      unicodePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
      Marshal.StructureToPtr(unicode, unicodePointer, false);
      var attributes = new OBJECT_ATTRIBUTES {
        Length = Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)),
        RootDirectory = root,
        ObjectName = unicodePointer,
        Attributes = 0,
        SecurityDescriptor = IntPtr.Zero,
        SecurityQualityOfService = IntPtr.Zero
      };
      IO_STATUS_BLOCK statusBlock;
      uint options = FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT |
        (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE);
      uint fileAttributes = directory ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_NORMAL;
      uint share = directory ? FILE_SHARE_READ_WRITE : FILE_SHARE_ALL;
      int status = NtCreateFile(out opened, access, ref attributes, out statusBlock, IntPtr.Zero, fileAttributes,
        share, disposition, options, IntPtr.Zero, 0);
      if (status == STATUS_OBJECT_NAME_COLLISION) {
        if (opened != null) { opened.Dispose(); opened = null; }
        return new RelativeOpen { Handle = null, Status = RelativeStatus.Collision };
      }
      if (status < 0 || opened == null || opened.IsInvalid) {
        if (opened != null) { opened.Dispose(); opened = null; }
        return failed;
      }
      FILE_ATTRIBUTE_TAG_INFO tag;
      if (!GetFileInformationByHandleEx(opened.DangerousGetHandle(), 9, out tag, (uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO)))) {
        opened.Dispose(); opened = null;
        return failed;
      }
      if ((tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        opened.Dispose(); opened = null;
        return new RelativeOpen { Handle = null, Status = RelativeStatus.Reparse };
      }
      if (directory && (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
        opened.Dispose(); opened = null;
        return failed;
      }
      if (!directory && (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
        opened.Dispose(); opened = null;
        return failed;
      }
      var ok = new RelativeOpen { Handle = opened, Status = RelativeStatus.Ok };
      opened = null;
      return ok;
    } catch {
      if (opened != null) opened.Dispose();
      return failed;
    } finally {
      if (unicodePointer != IntPtr.Zero) Marshal.FreeHGlobal(unicodePointer);
      if (nameBuffer != IntPtr.Zero) Marshal.FreeHGlobal(nameBuffer);
    }
  }

  public static int Run(string ghostId, string metaJson) {
    if (!ValidSegment(ghostId)) return 2;
    if (metaJson == null || !Regex.IsMatch(metaJson, "^\\{\"version\":1,\"ghostId\":\"[A-Za-z0-9._-]{1,128}\",\"createdAt\":[0-9]{1,16}\\}$")) return 2;
    IntPtr parent = GetStdHandle(-10);
    if (parent == IntPtr.Zero || parent == new IntPtr(-1)) return 2;
    BY_HANDLE_FILE_INFORMATION parentInfo;
    if (!GetFileInformationByHandle(parent, out parentInfo) ||
        (parentInfo.FileIndexHigh == 0 && parentInfo.FileIndexLow == 0)) return 2;
    uint dirAccess = FILE_LIST_DIRECTORY | FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
    RelativeOpen ghost = CreateRelative(parent, ghostId, true, FILE_OPEN_IF, dirAccess);
    if (ghost.Status != RelativeStatus.Ok || ghost.Handle == null) return 1;
    try {
      RelativeOpen metaDir = CreateRelative(ghost.Handle.DangerousGetHandle(), ".cindy-library", true, FILE_OPEN_IF, dirAccess);
      if (metaDir.Status != RelativeStatus.Ok || metaDir.Handle == null) return 1;
      try {
        RelativeOpen tmp = CreateRelative(metaDir.Handle.DangerousGetHandle(), "tmp", true, FILE_OPEN_IF, dirAccess);
        if (tmp.Status != RelativeStatus.Ok || tmp.Handle == null) return 1;
        tmp.Handle.Dispose();
        RelativeOpen backups = CreateRelative(metaDir.Handle.DangerousGetHandle(), "backups", true, FILE_OPEN_IF, dirAccess);
        if (backups.Status != RelativeStatus.Ok || backups.Handle == null) return 1;
        backups.Handle.Dispose();
        uint fileAccess = FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
        RelativeOpen meta = CreateRelative(metaDir.Handle.DangerousGetHandle(), "meta.json", false, FILE_CREATE, fileAccess);
        if (meta.Status == RelativeStatus.Ok && meta.Handle != null) {
          try {
            byte[] bytes = Encoding.UTF8.GetBytes(metaJson);
            uint written;
            if (!WriteFile(meta.Handle.DangerousGetHandle(), bytes, (uint)bytes.Length, out written, IntPtr.Zero) || written != (uint)bytes.Length) return 1;
            if (!FlushFileBuffers(meta.Handle.DangerousGetHandle())) return 1;
            Console.Out.Write("created");
            return 0;
          } finally {
            meta.Handle.Dispose();
          }
        }
        if (meta.Handle != null) meta.Handle.Dispose();
        if (meta.Status != RelativeStatus.Collision) return 1;
        RelativeOpen existing = CreateRelative(metaDir.Handle.DangerousGetHandle(), "meta.json", false, FILE_OPEN, FILE_READ_ATTRIBUTES | SYNCHRONIZE);
        if (existing.Status != RelativeStatus.Ok || existing.Handle == null) return 1;
        existing.Handle.Dispose();
        Console.Out.Write("exists");
        return 0;
      } finally {
        metaDir.Handle.Dispose();
      }
    } finally {
      ghost.Handle.Dispose();
    }
  }
}
'@
try {
  $ghost = $env:CINDY_LIBRARY_GHOST_ID
  $meta = $env:CINDY_LIBRARY_META_JSON
  $code = [CindyLibraryInit]::Run([string]$ghost, [string]$meta)
  exit $code
} catch {
  exit 1
}
`;

const WINDOWS_INIT_COMMAND = Buffer.from(WINDOWS_INIT_SCRIPT, 'utf16le').toString('base64');

function runWindowsInit(parentFd: number, ghostId: string, metaJson: string): Promise<CustomTreeInitResult> {
  return new Promise((resolve) => {
    const powershell = windowsPowerShellPath();
    if (!powershell) {
      resolve({ ok: false, code: 'UNSUPPORTED' });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', WINDOWS_INIT_COMMAND], {
        stdio: [parentFd, 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          CINDY_LIBRARY_GHOST_ID: ghostId,
          CINDY_LIBRARY_META_JSON: metaJson,
        },
      });
    } catch {
      resolve({ ok: false, code: 'UNSUPPORTED' });
      return;
    }
    let settled = false;
    const finish = (value: CustomTreeInitResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once('error', () => finish({ ok: false, code: 'UNSUPPORTED' }));
    child.once('close', (code) => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (code === 2) {
        finish({ ok: false, code: 'UNSUPPORTED' });
        return;
      }
      if (code !== 0 || (text !== 'created' && text !== 'exists')) {
        finish({ ok: false, code: 'IO' });
        return;
      }
      finish({ ok: true, createdMeta: text === 'created' });
    });
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, code: 'IO' });
    }, HELPER_TIMEOUT_MS);
    timer.unref?.();
  });
}
