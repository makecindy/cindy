const noop = (): void => undefined;

/** Worker-local logger shim; structured maintenance logs travel through parentPort. */
export function createLogger() {
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  };
}

export function maskPath(): string {
  return '<database-path>';
}
