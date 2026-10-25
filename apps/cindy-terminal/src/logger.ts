import type { Logger } from '@cindy/maker-core';

/** Only explicitly classified runtime diagnostics leave the service. */
export const logger: Logger = {
  trace() {}, debug() {}, info() {},
  warn() { process.stderr.write('[Cindy] RUNTIME_WARNING\n'); },
  error() { process.stderr.write('[Cindy] RUNTIME_ERROR\n'); },
  fatal() { process.stderr.write('[Cindy] RUNTIME_FATAL\n'); },
  child() { return logger; },
};
