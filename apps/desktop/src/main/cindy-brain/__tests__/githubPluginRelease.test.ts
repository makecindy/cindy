import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { checkGithubPluginRelease, downloadGithubPluginRelease, installCheckedGithubPluginRelease } from '../githubPluginRelease';

const bytes = 'fixture plugin archive';
const sha256 = createHash('sha256').update(bytes).digest('hex');

function release(version: string, draft = false) {
  return {
    tag_name: `v${version}`,
    draft,
    prerelease: true,
    assets: [{
      id: 41, size: bytes.length, digest: `sha256:${sha256}`, state: 'uploaded',
      name: `example-plugin-${version}.cindy`,
    }],
  };
}

// Isolated network/filesystem integration: guard the private-release path against
// downgrades and sending the GitHub credential to arbitrary redirect destinations.
describe('GitHub plugin release', () => {
  it('uses only published packages and does not offer an upstream downgrade', async () => {
    const fetch = vi.fn(async () => Response.json([release('0.3.0', true), release('0.2.12')]));
    const result = await checkGithubPluginRelease(fetch, 'fixture', 'example/plugin', 'example-plugin', '0.2.14');
    expect(result).toMatchObject({ status: 'current', release: { version: '0.2.12', prerelease: true } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('requires authorized GitHub access before presenting an update', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));
    expect(await checkGithubPluginRelease(fetch, null, 'example/plugin', 'example-plugin', '0.2.11')).toEqual({ status: 'sign-in' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await checkGithubPluginRelease(fetch, 'fixture', 'example/plugin', 'example-plugin', '0.2.11')).toEqual({ status: 'forbidden' });
  });

  it('verifies downloaded bytes and keeps Authorization on the API request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'github-plugin-release-test-'));
    try {
      const candidate = { assetId: 41, size: bytes.length, version: '0.2.12', sha256, prerelease: true };
      const fetch = vi.fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(new Response(null, {
          status: 302, headers: { Location: 'https://release-assets.githubusercontent.com/object' },
        }))
        .mockResolvedValueOnce(new Response(bytes));
      const file = join(dir, 'download.cindy');
      await downloadGithubPluginRelease(fetch, 'fixture', 'example/plugin', candidate, file);
      expect(await readFile(file, 'utf8')).toBe(bytes);
      expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer fixture');
      expect(new Headers(fetch.mock.calls[1][1]?.headers).has('authorization')).toBe(false);

      fetch.mockResolvedValueOnce(new Response('x'.repeat(bytes.length)));
      await expect(downloadGithubPluginRelease(fetch, 'fixture', 'example/plugin', candidate, join(dir, 'corrupt.cindy')))
        .rejects.toMatchObject({ code: 'CHECKSUM' });

      fetch.mockClear().mockResolvedValueOnce(new Response(null, {
        status: 302, headers: { Location: 'https://example.com/object' },
      }));
      await expect(downloadGithubPluginRelease(fetch, 'fixture', 'example/plugin', candidate, join(dir, 'blocked.cindy')))
        .rejects.toMatchObject({ code: 'URL_POLICY' });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('installs only the checked asset and refuses concurrent or changed-owner updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'github-plugin-install-test-'));
    let current = true;
    let finish: () => void = () => {};
    const downloading = new Promise<void>((resolve) => { finish = resolve; });
    const input = {
      check: { status: 'available' as const, release: { assetId: 41, size: bytes.length, version: '0.2.12', sha256, prerelease: false } },
      expectedAssetId: 41, pending: new Set<string>(), updateKey: 'owner/instance', tempRoot: root,
      isCurrentOwner: () => current, download: vi.fn(() => downloading),
      install: vi.fn(async () => '0.2.12'), emit: vi.fn(),
    };
    try {
      await expect(installCheckedGithubPluginRelease({ ...input, expectedAssetId: 40 })).resolves.toEqual(input.check);
      expect(input.download).not.toHaveBeenCalled();
      const update = installCheckedGithubPluginRelease(input);
      await expect(installCheckedGithubPluginRelease(input)).rejects.toThrow('already in progress');
      await vi.waitFor(() => expect(input.download).toHaveBeenCalledOnce());
      current = false;
      finish();
      await expect(update).rejects.toThrow('owner changed');
      expect(input.install).not.toHaveBeenCalled();
      current = true;
      await expect(installCheckedGithubPluginRelease(input)).resolves.toEqual({ status: 'updated', version: '0.2.12' });
      expect(input.install).toHaveBeenCalledOnce();
      expect(input.emit).toHaveBeenCalledWith(expect.objectContaining({ phase: 'installing' }));
    } finally {
      finish();
      await rm(root, { recursive: true, force: true });
    }
  });
});
