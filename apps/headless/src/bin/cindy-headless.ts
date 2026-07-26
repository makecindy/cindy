#!/usr/bin/env node
import { HeadlessDaemon } from '../daemon.js';

const daemon = new HeadlessDaemon();
await daemon.start();
process.stdout.write(`cindy-headless listening on ${daemon.paths.socketFile}\n`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void daemon.stop().finally(() => process.exit(0));
  });
}
