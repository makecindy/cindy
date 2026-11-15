import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const source = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(source, '../../package.json'));
export function buildTrackpad(output, arch = process.arch) {
  if (process.platform !== 'darwin') return;
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Unsupported trackpad architecture');
  const headers = path.join(
    os.homedir(),
    'Library/Caches/node-gyp',
    process.versions.node,
    'include/node',
  );
  if (!fs.existsSync(path.join(headers, 'node_api.h'))) {
    const rebuild = createRequire(require.resolve('@electron/rebuild'));
    execFileSync(
      process.execPath,
      [rebuild.resolve('node-gyp/bin/node-gyp.js'), 'install', '--ensure'],
      { stdio: 'inherit' },
    );
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    execFileSync(
      'xcrun',
      [
        'clang++',
        '-std=c++17',
        '-fobjc-arc',
        '-bundle',
        '-undefined',
        'dynamic_lookup',
        '-arch',
        arch === 'x64' ? 'x86_64' : 'arm64',
        '-mmacosx-version-min=12.0',
        '-framework',
        'Cocoa',
        '-I',
        headers,
        path.join(source, 'trackpad.mm'),
        '-o',
        temporary,
      ],
      { stdio: 'inherit' },
    );
    execFileSync('codesign', ['--force', '--sign', '-', temporary], { stdio: 'inherit' });
    fs.renameSync(temporary, output);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildTrackpad(
    process.argv[2] || path.join(source, '../../resources/tools/trackpad/cindy-trackpad.node'),
    process.argv[3],
  );
}
