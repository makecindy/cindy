import { describe, expect, it } from 'vitest';

import {
  isAllowedOllamaDownloadUrl,
  parseGithubSha256Digest,
  pickOfficialDarwinAsset,
  pickOfficialSidecarAsset,
  supportsManagedOllamaInstall,
} from '../ollamaRelease.js';

const GOOD_SHA = `sha256:${'ab'.repeat(32)}`;
const GOOD_DARWIN_URL = 'https://github.com/ollama/ollama/releases/download/v0.32.14/ollama-darwin.tgz';
const GOOD_WIN_AMD64_URL =
  'https://github.com/ollama/ollama/releases/download/v0.32.14/ollama-windows-amd64.zip';
const GOOD_WIN_ARM64_URL =
  'https://github.com/ollama/ollama/releases/download/v0.32.14/ollama-windows-arm64.zip';

describe('ollamaRelease', () => {
  it('accepts official darwin and windows sidecar URLs', () => {
    expect(isAllowedOllamaDownloadUrl(GOOD_DARWIN_URL)).toBe(true);
    expect(isAllowedOllamaDownloadUrl(GOOD_WIN_AMD64_URL)).toBe(true);
    expect(isAllowedOllamaDownloadUrl(GOOD_WIN_ARM64_URL)).toBe(true);
    expect(isAllowedOllamaDownloadUrl('https://evil.example/ollama-darwin.tgz')).toBe(false);
    expect(
      isAllowedOllamaDownloadUrl(
        'https://github.com/ollama/ollama/releases/download/v0.32.14/OllamaSetup.exe',
      ),
    ).toBe(false);
    expect(
      isAllowedOllamaDownloadUrl(
        'https://github.com/ollama/ollama/releases/download/v0.32.14/ollama-windows-amd64-mlx.zip',
      ),
    ).toBe(false);
  });

  it('picks the official darwin asset and checksum', () => {
    expect(
      pickOfficialDarwinAsset({
        tag_name: 'v0.32.14',
        assets: [
          {
            name: 'ollama-darwin.tgz',
            browser_download_url: GOOD_DARWIN_URL,
            digest: GOOD_SHA,
            size: 150_000_000,
          },
        ],
      }),
    ).toEqual({
      version: '0.32.14',
      url: GOOD_DARWIN_URL,
      sha256: 'ab'.repeat(32),
      sizeBytes: 150_000_000,
      assetName: 'ollama-darwin.tgz',
    });
  });

  it('picks the official windows zip for the host arch', () => {
    expect(
      pickOfficialSidecarAsset(
        {
          tag_name: 'v0.32.14',
          assets: [
            {
              name: 'ollama-windows-amd64.zip',
              browser_download_url: GOOD_WIN_AMD64_URL,
              digest: GOOD_SHA,
              size: 1_400_000_000,
            },
            {
              name: 'OllamaSetup.exe',
              browser_download_url:
                'https://github.com/ollama/ollama/releases/download/v0.32.14/OllamaSetup.exe',
              digest: GOOD_SHA,
              size: 1_500_000_000,
            },
          ],
        },
        'win32',
        'x64',
      ),
    ).toEqual({
      version: '0.32.14',
      url: GOOD_WIN_AMD64_URL,
      sha256: 'ab'.repeat(32),
      sizeBytes: 1_400_000_000,
      assetName: 'ollama-windows-amd64.zip',
    });
    expect(
      pickOfficialSidecarAsset(
        {
          tag_name: 'v0.32.14',
          assets: [
            {
              name: 'ollama-windows-arm64.zip',
              browser_download_url: GOOD_WIN_ARM64_URL,
              digest: GOOD_SHA,
              size: 200_000_000,
            },
          ],
        },
        'win32',
        'arm64',
      )?.assetName,
    ).toBe('ollama-windows-arm64.zip');
  });

  it('rejects a matching name with a bad host or digest', () => {
    expect(parseGithubSha256Digest('sha256:not-a-hash')).toBeNull();
    expect(
      pickOfficialDarwinAsset({
        tag_name: 'v0.32.14',
        assets: [
          {
            name: 'ollama-darwin.tgz',
            browser_download_url: 'https://evil.example/ollama-darwin.tgz',
            digest: GOOD_SHA,
            size: 1,
          },
        ],
      }),
    ).toBeNull();
  });

  it('is offered on macOS and Windows, not Linux or 32-bit Windows', () => {
    expect(supportsManagedOllamaInstall('darwin')).toBe(true);
    expect(supportsManagedOllamaInstall('win32', 'x64')).toBe(true);
    expect(supportsManagedOllamaInstall('win32', 'arm64')).toBe(true);
    expect(supportsManagedOllamaInstall('win32', 'ia32')).toBe(false);
    expect(supportsManagedOllamaInstall('linux')).toBe(false);
  });
});
