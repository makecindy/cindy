#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { requestControl } from '../control-socket.js';
import { resolveHeadlessPaths } from '../paths.js';

const [command] = process.argv.slice(2);
if (command !== 'status') {
  process.stderr.write('Usage: cindyctl status\n');
  process.exitCode = 2;
} else {
  const response = await requestControl(resolveHeadlessPaths().socketFile, { id: randomUUID(), method: 'daemon.ping' });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
}
