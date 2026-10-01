#!/usr/bin/env node

// Keep the direct `package` and `build` scripts on the same Forge environment
// as the release wrapper. The launcher must set NODE_OPTIONS before Node starts
// Forge; changing process.env from forge.config.ts would be too late for the
// Forge process that owns the Main/Renderer compilation.

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

import { packageNodeOptions } from './ci/package-lib.mjs';

const require = createRequire(import.meta.url);
const forgeCli = require.resolve('@electron-forge/cli/dist/electron-forge.js');
const result = spawnSync(
  process.execPath,
  [forgeCli, ...process.argv.slice(2)],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_OPTIONS: packageNodeOptions(process.env),
    },
    stdio: 'inherit',
  },
);

if (result.error) {
  console.error(`Failed to start electron-forge: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
