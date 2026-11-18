#!/usr/bin/env node
import path from 'node:path';
import { runCli } from './cli.js';

runCli(process.argv.slice(2), path.resolve(process.argv[1])).then(result => {
  process.stdout.write(typeof result === 'string' ? result : JSON.stringify(result, null, 2) + '\n');
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
