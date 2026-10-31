import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { RemoteHost } from '@cindy/maker-remote-ssh';
import type { CodexModelListItem, RemoteCodexImageAttachment } from '@cindy/maker-core';

const REMOTE_ATTACHMENT_ROOT_SUFFIX = '.xdt-server/v1/session-attachments';
const MAX_REMOTE_CODEX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REMOTE_CODEX_IMAGE_TOTAL_BYTES = 64 * 1024 * 1024;
const REMOTE_HOME_TIMEOUT_MS = 10_000;
const REMOTE_WRITE_TIMEOUT_MS = 60_000;
const REMOTE_CLEANUP_TIMEOUT_MS = 15_000;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizedExtension(image: RemoteCodexImageAttachment): string {
  const ext = path.extname(image.path).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(ext)) return ext;
  const byMime: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'image/avif': '.avif',
    'image/heic': '.heic',
    'image/heif': '.heif',
  };
  return byMime[image.mimeType?.toLowerCase() ?? ''] ?? '.img';
}

function safeSessionScope(sessionId: string): string {
  const safe = sessionId.trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96);
  if (!safe || safe === '.' || safe === '..') {
    throw new Error('Remote Codex attachment session id is invalid');
  }
  return safe;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readImage(image: RemoteCodexImageAttachment, index: number): Promise<Buffer> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(image.path);
  } catch {
    throw new Error(`Remote Codex image #${index + 1} is not readable`);
  }
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`Remote Codex image #${index + 1} is not a non-empty file`);
  }
  if (stat.size > MAX_REMOTE_CODEX_IMAGE_BYTES) {
    throw new Error(
      `Remote Codex image #${index + 1} is ${stat.size} bytes (limit ${MAX_REMOTE_CODEX_IMAGE_BYTES})`,
    );
  }
  const bytes = await fs.readFile(image.path);
  if (bytes.length !== stat.size || bytes.length > MAX_REMOTE_CODEX_IMAGE_BYTES) {
    throw new Error(`Remote Codex image #${index + 1} changed while being read`);
  }
  return bytes;
}

async function resolveRemoteHome(remoteHost: RemoteHost): Promise<string> {
  // Re-resolve on every operation: SSH host config edits keep the same id but
  // can change the login user and therefore $HOME.
  const result = await remoteHost.exec(`printf '%s' "$HOME"`, {
    timeoutMs: REMOTE_HOME_TIMEOUT_MS,
    label: 'remote-codex-attachment-home',
    maxOutputBytes: 4096,
  });
  const home = result.stdout.trim();
  if (result.exitCode !== 0 || !home.startsWith('/') || home.includes('\0')) {
    throw new Error(`Remote Codex could not resolve a POSIX home directory (exit ${result.exitCode})`);
  }
  return home;
}

export function assertRemoteCodexModelSupportsImages(
  models: readonly CodexModelListItem[],
  model: string,
): void {
  const descriptor = models.find((item) => item.model === model || item.id === model);
  if (!descriptor) {
    throw new Error(`Remote Codex model "${model}" is unavailable on this SSH host`);
  }
  const modalities = descriptor.inputModalities;
  if (!Array.isArray(modalities) || !modalities.every((value) => typeof value === 'string')) {
    throw new Error(
      `Remote Codex cannot verify image input support for "${model}"; update the remote Codex model configuration and reconnect`,
    );
  }
  if (!modalities.includes('image')) {
    throw new Error(`Remote Codex model "${model}" does not support image input`);
  }
}

export async function stageRemoteCodexImageFiles(input: {
  remoteHost: RemoteHost;
  sessionId: string;
  images: readonly RemoteCodexImageAttachment[];
}): Promise<string[]> {
  if (input.images.length === 0) return [];
  const home = await resolveRemoteHome(input.remoteHost);
  const scope = safeSessionScope(input.sessionId);
  const remoteDir = `${home.replace(/\/+$/, '')}/${REMOTE_ATTACHMENT_ROOT_SUFFIX}/${scope}`;
  const remotePaths: string[] = [];
  let totalBytes = 0;

  for (const [index, image] of input.images.entries()) {
    const bytes = await readImage(image, index);
    totalBytes += bytes.length;
    if (totalBytes > MAX_REMOTE_CODEX_IMAGE_TOTAL_BYTES) {
      throw new Error(
        `Remote Codex images exceed the per-turn limit (${MAX_REMOTE_CODEX_IMAGE_TOTAL_BYTES} bytes)`,
      );
    }
    const digest = sha256(bytes);
    const ext = normalizedExtension(image);
    const remotePath = `${remoteDir}/${digest}${ext}`;
    const script = [
      'set -eu',
      `DIR=${shellQuote(remoteDir)}`,
      'umask 077',
      'mkdir -p "$DIR"',
      'chmod 700 "$DIR"',
      `FINAL=${shellQuote(remotePath)}`,
      'TMP="$FINAL.tmp.$$"',
      'cleanup() { rm -f "$TMP"; }',
      'trap cleanup EXIT HUP INT TERM',
      'cat > "$TMP"',
      'chmod 600 "$TMP"',
      'SIZE=$(wc -c < "$TMP" | tr -d \' \')',
      `[ "$SIZE" = '${bytes.length}' ] || { echo 'remote image size verification failed' >&2; exit 46; }`,
      `if command -v sha256sum >/dev/null 2>&1; then DIGEST=$(sha256sum "$TMP" | awk '{print $1}'); elif command -v shasum >/dev/null 2>&1; then DIGEST=$(shasum -a 256 "$TMP" | awk '{print $1}'); elif command -v openssl >/dev/null 2>&1; then DIGEST=$(openssl dgst -sha256 "$TMP" | awk '{print $NF}'); else echo 'remote sha256 is unavailable' >&2; exit 45; fi`,
      `[ "$DIGEST" = '${digest}' ] || { echo 'remote image sha256 verification failed' >&2; exit 47; }`,
      'mv -f "$TMP" "$FINAL"',
      'chmod 600 "$FINAL"',
      `printf '%s\\n' "$FINAL"`,
    ].join('\n');
    const result = await input.remoteHost.exec(`bash -c ${shellQuote(script)}`, {
      input: bytes,
      timeoutMs: REMOTE_WRITE_TIMEOUT_MS,
      label: 'remote-codex-image-write',
      maxOutputBytes: 4096,
    });
    const returnedPath = result.stdout.trim().split(/\r?\n/).pop() ?? '';
    if (result.exitCode !== 0 || returnedPath !== remotePath) {
      const detail = result.stderr.trim().slice(0, 200);
      throw new Error(
        `Remote Codex image upload failed (exit ${result.exitCode})${detail ? `: ${detail}` : ''}`,
      );
    }
    remotePaths.push(returnedPath);
  }
  return remotePaths;
}

export async function cleanupRemoteCodexSessionImages(input: {
  remoteHost: RemoteHost;
  sessionId: string;
}): Promise<void> {
  const home = await resolveRemoteHome(input.remoteHost);
  const scope = safeSessionScope(input.sessionId);
  const remoteDir = `${home.replace(/\/+$/, '')}/${REMOTE_ATTACHMENT_ROOT_SUFFIX}/${scope}`;
  const script = `rm -rf -- ${shellQuote(remoteDir)}`;
  const result = await input.remoteHost.exec(`bash -c ${shellQuote(script)}`, {
    timeoutMs: REMOTE_CLEANUP_TIMEOUT_MS,
    label: 'remote-codex-image-cleanup',
    maxOutputBytes: 4096,
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().slice(0, 200);
    throw new Error(
      `Remote Codex image cleanup failed (exit ${result.exitCode})${detail ? `: ${detail}` : ''}`,
    );
  }
}
