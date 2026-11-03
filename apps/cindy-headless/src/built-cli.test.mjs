import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { headlessBuildOptions } from '../scripts/build-options.mjs';

const execFileAsync = promisify(execFile);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let output;

beforeAll(async () => {
  output = await mkdtemp(path.join(os.tmpdir(), 'cindy-headless-cli-'));
  await build({
    ...headlessBuildOptions,
    entryPoints: {
      cli: path.join(appDir, 'src/cli.ts'),
      'eval-cli': path.join(appDir, 'src/eval-cli.ts'),
    },
    outdir: output,
  });
}, 30_000);

afterAll(async () => {
  if (output) await rm(output, { recursive: true, force: true });
});

describe('standalone CommonJS CLI artifacts', () => {
  it('starts the bundled runtime outside the checkout without gateway configuration', async () => {
    const { stdout } = await execFileAsync(process.execPath, [path.join(output, 'cli.cjs'), 'version'], {
      cwd: output,
      timeout: 15_000,
      env: { ...process.env, CINDY_HEADLESS_CONFIG_FILE: path.join(output, 'missing-config.json') },
    });
    expect(JSON.parse(stdout)).toMatchObject({ name: 'cindy-headless', backends: ['claude-code', 'codex', 'pi'] });
  }, 20_000);

  it('runs the bundled evaluation CLI on local results', async () => {
    const results = path.join(output, 'results.json');
    await writeFile(results, '[]');
    const { stdout } = await execFileAsync(process.execPath, [path.join(output, 'eval-cli.cjs'), 'paired-summary', '--results', results], {
      cwd: output,
      timeout: 15_000,
    });
    expect(JSON.parse(stdout)).toMatchObject({ pairCount: 0, completePairCount: 0 });
  }, 20_000);
});
