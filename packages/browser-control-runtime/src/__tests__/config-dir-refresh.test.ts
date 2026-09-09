import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import * as textUtils from '../shim/_local/text-utils.js';

const originalEnv = process.env.XDT_BROWSER_RUNTIME_DIR;

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.XDT_BROWSER_RUNTIME_DIR;
  } else {
    process.env.XDT_BROWSER_RUNTIME_DIR = originalEnv;
  }
  textUtils.refreshBrowserRuntimeConfigDir();
});

describe('refreshBrowserRuntimeConfigDir', () => {
  it('re-reads XDT_BROWSER_RUNTIME_DIR so Chrome launch can pick up a late pin', () => {
    const pinned = path.join(os.tmpdir(), 'cindy-browser-runtime-pin');
    process.env.XDT_BROWSER_RUNTIME_DIR = pinned;
    textUtils.refreshBrowserRuntimeConfigDir();
    expect(textUtils.CONFIG_DIR).toBe(pinned);
  });
});
