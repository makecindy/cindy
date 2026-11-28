import { describe, expect, it, vi } from 'vitest';
import { cloudCliAuthorization } from '../managementCliAuthorization.js';
import { runCloudManagementExecution } from '../managementCalls.js';
import type { ManagementExecution } from '../management.js';

function setup() {
  const abort = new AbortController();
  let respond: ((value: string) => Promise<void>) | undefined;
  const prompt = vi.fn();
  const execution: ManagementExecution = {
    signal: abort.signal, assertCurrent: () => abort.signal.throwIfAborted(), onCancel() {},
    prompt(value, callback) { prompt(value); respond = callback; },
  };
  return { execution, abort, prompt, get respond() { return respond!; } };
}
const url = 'https://auth.example.invalid/authorize?state=fixture-state&redirect_uri=https%3A%2F%2Fauth.example.invalid%2Fcode';
describe('official CLI cloud authorization', () => {
  it('does not intercept native desktop logins', () => {
    expect(cloudCliAuthorization(vi.fn())).toBeUndefined();
  });
  it('assembles split terminal output and forwards only a matching one-use code to CLI stdin', async () => {
    const e = setup(), write = vi.fn();
    await runCloudManagementExecution(e.execution, async () => {
      const present = cloudCliAuthorization(write)!;
      await present("If the browser didn't open, visit: \x1b]8;;" + url + '\x1b\\' + url.slice(0, 30));
      expect(e.prompt).not.toHaveBeenCalled();
      await present(url.slice(30) + '\x1b]8;;\x1b\\\nPaste code here if prompted > ');
      expect(e.prompt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'callback', url }));
      for (const input of ['code#wrong-state', 'code#fixture-state\nextra', 'code', 'code#fixture-state#extra'])
        await expect(e.respond(input)).rejects.toThrow();
      expect(write).not.toHaveBeenCalled();
      await e.respond('code#fixture-state');
      expect(write).toHaveBeenCalledExactlyOnceWith('code#fixture-state\n');
      await expect(e.respond('again#fixture-state')).rejects.toThrow();
      expect(JSON.stringify(e.prompt.mock.calls)).not.toContain('code#');
    });
  });
  it('rejects callback submission after cancellation and malformed destinations', async () => {
    const e = setup(), write = vi.fn();
    await runCloudManagementExecution(e.execution, async () => {
      const present = cloudCliAuthorization(write)!;
      await present(`If the browser didn't open, visit: ${url}\n`);
      e.abort.abort();
      await expect(e.respond('code#fixture-state')).rejects.toThrow();
      expect(write).not.toHaveBeenCalled();
    });
    const other = setup();
    await runCloudManagementExecution(other.execution, async () => {
      await expect(cloudCliAuthorization(write)!('If the browser didn\'t open, visit: https://auth.example.invalid/authorize?redirect_uri=file:///tmp/fixture\n')).rejects.toThrow();
      expect(other.prompt).not.toHaveBeenCalled();
    });
  });
});
