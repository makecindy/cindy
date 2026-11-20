import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { create } from 'tar';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { downloadAntigravityRelease, fetchAntigravityRelease, parseAntigravityRelease } from '../antigravity-download';

const base = 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13-1234/';
const windowsUrl = base + 'windows-x64/cli_windows_x64.exe';
const macUrl = base + 'darwin-arm/cli_mac_arm64.tar.gz';
const signal = new AbortController().signal;
const sha = (data: Buffer) => createHash('sha512').update(data).digest('hex');
let root: string;

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-download-test-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it.each([
  'https://example.com/cli_windows_x64.exe',
  windowsUrl.replace('1.5.13-1234', '1.5.12-1234'),
  windowsUrl.replace('1234', '1234/../1234'),
  macUrl,
])('rejects a URL that does not match the official platform and version: %s', (url) => {
  expect(() => parseAntigravityRelease({ version: '1.5.13', url, sha512: 'a'.repeat(128) }, 'windows_amd64'))
    .toThrow('ANTIGRAVITY_INVALID_RELEASE');
});

it('reads the stable platform manifest and validates the downloaded bytes', async () => {
  const bytes = Buffer.from('mock signed executable');
  const release = { version: '1.5.13', url: windowsUrl, sha512: sha(bytes) };
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(release)).mockResolvedValueOnce(new Response(bytes.toString()));
  expect(await fetchAntigravityRelease(fetcher, 'windows_amd64', signal)).toEqual(release);
  const binary = await downloadAntigravityRelease(fetcher, release, 'windows_amd64', root, signal);
  expect(await fs.readFile(binary)).toEqual(bytes);
  expect(fetcher).toHaveBeenNthCalledWith(1, expect.stringMatching(/\/manifests\/windows_amd64\.json$/), expect.objectContaining({ redirect: 'error' }));
  expect(fetcher).toHaveBeenNthCalledWith(2, windowsUrl, expect.objectContaining({ redirect: 'error' }));
});

it('rejects an artifact whose SHA-512 differs from the stable manifest', async () => {
  const release = { version: '1.5.13', url: windowsUrl, sha512: 'a'.repeat(128) };
  await expect(downloadAntigravityRelease(async () => new Response('modified bytes'), release, 'windows_amd64', root, signal))
    .rejects.toThrow('ANTIGRAVITY_DOWNLOAD_CHECKSUM');
});

it('extracts only the regular macOS executable from the verified archive', async () => {
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  await fs.mkdir(input);
  await fs.mkdir(output);
  await fs.writeFile(path.join(input, 'antigravity'), 'mock Mach-O');
  await fs.writeFile(path.join(input, 'unrelated'), 'never installed');
  const archive = path.join(root, 'fixture.tar.gz');
  await create({ cwd: input, gzip: true, file: archive }, ['antigravity', 'unrelated']);
  const bytes = await fs.readFile(archive);
  const release = { version: '1.5.13', url: macUrl, sha512: sha(bytes) };
  const binary = await downloadAntigravityRelease(async () => new Response(Uint8Array.from(bytes)), release, 'darwin_arm64', output, signal);
  expect(await fs.readFile(binary, 'utf8')).toBe('mock Mach-O');
  expect(await fs.readdir(output)).toEqual(['antigravity']);
});
