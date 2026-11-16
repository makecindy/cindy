import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { build } from 'vite';
import rendererConfig from '../vite.renderer.config.ts';

// Production entry: Vite's renderer config + the real DockIconPicker imports.
// PR #9139 regression: Windows/Linux emitted 869,882 bytes of macOS-only PNGs.
// Existing appearance tests cover preferences, not the emitted build assets.
// Minimal failing input: build that entry for win32; tier: standard unit.
// Backslash input catches comparing Vite's resolved ID with the raw entry path.
// Entry normalization happens before Vite; native Windows resolution still needs CI.
// Measured standalone runtime: 451 ms (8 cases, macOS development machine).
const entry = fileURLToPath(
  new URL('../src/renderer/components/settings/DockIconPicker.tsx', import.meta.url),
);
const originalArgv = process.argv;

afterEach(() => {
  vi.unstubAllEnvs();
  process.argv = originalArgv;
});

async function emittedPngs(entryPath = entry) {
  const normalizedEntry = entryPath.replace(/\\/g, '/');
  const config = rendererConfig({ command: 'build', mode: 'production' });
  const result = await build({
    ...config,
    configFile: false,
    logLevel: 'silent',
    // PDF's post-build copy is unrelated and would write outside this in-memory build.
    plugins: config.plugins.filter((plugin) => plugin.name !== 'xdt-pdfjs-assets'),
    build: {
      ...config.build,
      write: false,
      assetsInlineLimit: 0,
      rollupOptions: {
        input: normalizedEntry,
        // Keep the actual PNG imports on Vite's asset pipeline; unrelated React
        // and application imports need not be bundled for this packaging regression.
        // Vite resolves Windows entry IDs with forward slashes as well.
        external: (id) => id.replace(/\\/g, '/') !== normalizedEntry && !id.includes('.png'),
      },
    },
  });
  return result.output
    .filter((output) => output.type === 'asset' && path.extname(output.fileName) === '.png')
    .map((output) => output.fileName);
}

describe('Dock preview assets in renderer builds', () => {
  it('builds the real entry with Windows path separators', async () => {
    vi.stubEnv('ELECTRON_FORGE_PLATFORM', 'win32');
    expect(await emittedPngs(entry.replace(/\//g, '\\'))).toEqual([]);
  });

  it.each(['win32', 'linux'])('omits Dock PNGs for %s', async (platform) => {
    vi.stubEnv('ELECTRON_FORGE_PLATFORM', platform);
    expect(await emittedPngs()).toEqual([]);
  });

  it.each(['darwin', 'mas'])('keeps every Dock PNG for %s', async (platform) => {
    vi.stubEnv('ELECTRON_FORGE_PLATFORM', platform);
    expect(await emittedPngs()).toHaveLength(6);
  });

  it.each([['--platform', 'win32'], ['--platform=linux']])(
    'uses the Forge CLI target %s instead of the host platform',
    async (...args) => {
      vi.stubEnv('ELECTRON_FORGE_PLATFORM', '');
      process.argv = [...originalArgv.slice(0, 2), ...args];
      expect(await emittedPngs()).toEqual([]);
    },
  );

  it('gives the explicit environment target precedence over CLI arguments', async () => {
    vi.stubEnv('ELECTRON_FORGE_PLATFORM', 'darwin');
    process.argv = [...originalArgv.slice(0, 2), '--platform=win32'];
    expect(await emittedPngs()).toHaveLength(6);
  });
});
