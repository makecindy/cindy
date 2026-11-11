import { beforeEach, expect, it, vi } from 'vitest';

const execute = vi.hoisted(() => {
  const fn = vi.fn();
  // Node's execFile has a custom promisifier returning both output streams.
  Object.defineProperty(fn, Symbol.for('nodejs.util.promisify.custom'), {
    value: (...args: unknown[]) => new Promise((resolve, reject) => {
      fn(...args, (error: Error | null, stdout: string, stderr: string) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    }),
  });
  return fn;
});
vi.mock('node:child_process', () => ({ execFile: execute }));
vi.mock('../logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
import { registerWindowsDeepLinkName } from '../deepLinkWindowsRegistration';

beforeEach(() => {
  execute.mockReset();
  execute.mockImplementation((_file, args, _options, callback) => {
    callback(args[0] === 'query' ? new Error('missing') : null, '', '');
  });
});
it.each(['cindy', 'xdt-maker'])('names only the registered %s protocol, retaining the Electron launch command', async (scheme) => {
  await registerWindowsDeepLinkName(scheme, 'win32');
  const writes = execute.mock.calls.filter(([, args]) => args[0] === 'add');
  expect(writes).toHaveLength(1);
  expect(writes[0].slice(0, 3)).toEqual(['reg.exe', [
    'add', `HKCU\\Software\\Classes\\${scheme}\\Application`, '/v', 'ApplicationName', '/t', 'REG_SZ', '/d', 'Cindy', '/f',
  ], { windowsHide: true, encoding: 'utf8', timeout: 3_000 }]);
});
it('leaves correct names untouched and does not write on other platforms or to arbitrary protocols', async () => {
  execute.mockImplementation((_file, _args, _options, callback) => callback(null, '    ApplicationName    REG_SZ    Cindy\r\n', ''));
  await registerWindowsDeepLinkName('cindy', 'win32');
  expect(execute).toHaveBeenCalledTimes(1);
  execute.mockClear();
  await registerWindowsDeepLinkName('cindy', 'darwin');
  await registerWindowsDeepLinkName('https', 'win32');
  expect(execute).not.toHaveBeenCalled();
});
it('does not fail application startup when Windows refuses the metadata write', async () => {
  execute.mockImplementation((_file, _args, _options, callback) => callback(new Error('denied'), '', ''));
  await expect(registerWindowsDeepLinkName('cindy', 'win32')).resolves.toBeUndefined();
});
