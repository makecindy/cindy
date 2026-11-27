import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { reviewPdfRuntimePackages } from '../reviewPdfRuntimeDeps';

const desktopRoot = path.resolve(process.cwd());
const workspaceRequire = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

describe('Review PDF utility process packaging contract', () => {
  it('packages a dedicated utility-process entry without reopening RunAsNode', () => {
    const forge = fs.readFileSync(path.join(desktopRoot, 'forge.config.ts'), 'utf8');
    const controller = fs.readFileSync(
      path.join(desktopRoot, 'src/main/reviewer/reviewPdfProcess.ts'),
      'utf8',
    );
    const worker = fs.readFileSync(
      path.join(desktopRoot, 'src/main/reviewer/reviewPdfUtilityProcess.ts'),
      'utf8',
    );
    const polyfills = fs.readFileSync(
      path.join(desktopRoot, 'src/main/reviewer/pdfNodeDomPolyfills.ts'),
      'utf8',
    );
    const viteConfig = fs.readFileSync(
      path.join(desktopRoot, 'vite.review-pdf-process.config.ts'),
      'utf8',
    );

    expect(forge).toContain("entry: 'src/main/reviewer/reviewPdfUtilityProcess.ts'");
    expect(forge).toContain("config: 'vite.review-pdf-process.config.ts'");
    expect(forge).toContain('[FuseV1Options.RunAsNode]: false');
    expect(controller).toContain("path.join(__dirname, 'reviewPdfUtilityProcess.js')");
    expect(controller).toContain('utilityProcess.fork');
    expect(controller).not.toContain('ELECTRON_RUN_AS_NODE');
    expect(controller).not.toContain('process.execPath');
    expect(worker.indexOf("import './pdfNodeDomPolyfills.js'")).toBeLessThan(
      worker.indexOf("import 'pdfjs-dist/legacy/build/pdf.worker.mjs'"),
    );
    expect(worker).toContain("import 'pdfjs-dist/legacy/build/pdf.worker.mjs'");
    expect(worker).toContain("from 'pdfjs-dist/legacy/build/pdf.mjs'");
    expect(polyfills).toContain("from '@napi-rs/canvas'");
    expect(polyfills).toContain("typeof globalThis.DOMMatrix === 'undefined'");
    expect(viteConfig).toContain("external: ['@napi-rs/canvas']");
    expect(viteConfig).toContain('inlineDynamicImports: true');
    expect(forge).toContain('...reviewPdfRuntimePackages(targetPlatform, targetArch)');
  });

  it('staged canvas wrapper and current-platform binding load without workspace node_modules', async () => {
    const runtimePackages = reviewPdfRuntimePackages(process.platform, process.arch);
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-review-pdf-package-'));
    let phase = 'stage runtime packages';
    const startedAt = performance.now();
    try {
      const stagedModules = path.join(temp, 'node_modules');
      const stagePackage = async (name: string): Promise<void> => {
        phase = 'stage ' + name;
        console.info('[review-pdf-package] ' + phase);
        const packageJson = workspaceRequire.resolve(`${name}/package.json`, {
          paths: [desktopRoot],
        });
        const destination = path.join(stagedModules, name);
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        await fs.promises.cp(path.dirname(packageJson), destination, { recursive: true, dereference: true });
      };
      for (const runtimePackage of runtimePackages) await stagePackage(runtimePackage);

      phase = 'load staged native binding and encode PNG';
      console.info('[review-pdf-package] ' + phase);
      const probeRequirePath = path.join(temp, 'probe.cjs');
      const probe = await execFileAsync(
        process.execPath,
        [
          '-e',
          `const { createRequire } = require('node:module');
const stagedRequire = createRequire(${JSON.stringify(probeRequirePath)});
const canvas = stagedRequire('@napi-rs/canvas');
process.stdout.write(canvas.createCanvas(1, 1).toBuffer('image/png').subarray(1, 4).toString('ascii'));`,
        ],
        {
          cwd: temp,
          encoding: 'utf8',
          // This contract probes packaging and PNG encoding, neither of which
          // needs the host's installed fonts. Keep native loading real while
          // excluding machine-dependent system/user font enumeration.
          env: { ...process.env, DISABLE_SYSTEM_FONTS_LOAD: '1' },
          timeout: 15_000,
          killSignal: 'SIGKILL',
        },
      );
      expect(probe.stdout).toBe('PNG');
    } catch (cause) {
      throw new Error(
        'Review PDF package probe failed during ' + phase + ' after ' +
        Math.round(performance.now() - startedAt) + 'ms',
        { cause },
      );
    } finally {
      console.info('[review-pdf-package] cleanup after ' + phase);
      await fs.promises.rm(temp, { recursive: true, force: true });
    }
    // Keep real staging/loading and the existing IO budget, but yield while copying
    // and probing: synchronous IO took 64s on Windows CI and can starve Vitest 3 RPC
    // responses past their independent 60s deadline. execFile rejects nonzero exits.
  }, 120_000);

  it('maps every packaged Desktop target to its canvas binding', () => {
    expect(reviewPdfRuntimePackages('darwin', 'arm64')).toEqual([
      '@napi-rs/canvas',
      '@napi-rs/canvas-darwin-arm64',
    ]);
    expect(reviewPdfRuntimePackages('darwin', 'x64')).toEqual([
      '@napi-rs/canvas',
      '@napi-rs/canvas-darwin-x64',
    ]);
    expect(reviewPdfRuntimePackages('win32', 'x64')).toEqual([
      '@napi-rs/canvas',
      '@napi-rs/canvas-win32-x64-msvc',
    ]);
    expect(reviewPdfRuntimePackages('linux', 'arm64')).toEqual([
      '@napi-rs/canvas',
      '@napi-rs/canvas-linux-arm64-gnu',
    ]);
    expect(reviewPdfRuntimePackages('linux', 'x64')).toEqual([
      '@napi-rs/canvas',
      '@napi-rs/canvas-linux-x64-gnu',
    ]);
  });

  it('passes only system locale/temp variables and a neutral cwd to the helper', () => {
    const controller = fs.readFileSync(
      path.join(desktopRoot, 'src/main/reviewer/reviewPdfProcess.ts'),
      'utf8',
    );

    expect(controller).toContain('const env: NodeJS.ProcessEnv = {}');
    expect(controller).not.toContain('...process.env');
    expect(controller).toContain('cwd: os.tmpdir()');
    expect(controller).toContain("execArgv: ['--max-old-space-size=128', '--max-semi-space-size=8']");
    expect(controller).toContain("stdio: 'ignore'");
  });
});
