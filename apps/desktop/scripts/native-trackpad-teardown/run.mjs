import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

if (process.platform !== 'darwin')
  throw new Error('This regression exercises macOS trackpad input');
const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '../..');
const require = createRequire(path.join(desktop, 'package.json'));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-trackpad-teardown-'));
try {
  const source = process.argv[2] || path.join(desktop, 'src/main/nativeTrackpad.ts');
  const bundle = path.join(temporary, 'trackpad.cjs');
  await build({
    stdin: {
      contents: await fs.readFile(source, 'utf8'),
      resolveDir: path.join(desktop, 'src/main'),
      loader: 'ts',
    },
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    plugins: [
      {
        name: 'fixture-logger',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/logger$/ }, () => ({
            path: 'logger',
            namespace: 'fixture',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: 'export const createLogger = () => ({ debug(){}, warn(){} });',
          }));
        },
      },
    ],
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      require('electron'),
      [`--user-data-dir=${path.join(temporary, 'profile')}`, path.join(here, 'main.cjs'), bundle],
      { env, stdio: 'inherit' },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  console.log(JSON.stringify(result));
  process.exitCode = result.code === 0 && !result.signal ? 0 : 1;
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
