import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const resourceDir = path.resolve(scriptDir, '..', 'resources', 'ios-simulator');
const manifest = JSON.parse(await fs.readFile(path.join(resourceDir, 'manifest.json'), 'utf8'));
const archivePath = path.join(resourceDir, manifest.archiveFileName);
const maxBytes = 8 * 1024 * 1024;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function readVerifiedArchive() {
  try {
    const bytes = await fs.readFile(archivePath);
    return bytes.length > 0 && bytes.length <= maxBytes && sha256(bytes) === manifest.archiveSha256;
  } catch {
    return false;
  }
}

if (process.platform !== 'darwin') {
  console.log('[wda-source] skipped: iOS Simulator assets are macOS-only');
} else if (await readVerifiedArchive()) {
  console.log(`[wda-source] verified ${manifest.archiveFileName}`);
} else {
  const response = await fetch(manifest.archiveUrl, { redirect: 'follow' });
  if (!response.ok) throw new Error(`[wda-source] download failed: HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('[wda-source] archive exceeds the configured size limit');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length <= 0 || bytes.length > maxBytes) {
    throw new Error('[wda-source] downloaded archive size is invalid');
  }
  const actual = sha256(bytes);
  if (actual !== manifest.archiveSha256) {
    throw new Error(
      `[wda-source] sha256 mismatch: expected ${manifest.archiveSha256}, got ${actual}`,
    );
  }
  const temporaryPath = `${archivePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, bytes, { mode: 0o600 });
  await fs.rename(temporaryPath, archivePath);
  console.log(`[wda-source] staged ${manifest.archiveFileName} (${bytes.length} bytes)`);
}
