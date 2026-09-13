import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  appPath: '',
  userData: '',
  packaged: false,
  files: new Map<string, number>(),
  execFile: vi.fn(),
}));
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return fake.packaged;
    },
    getAppPath: () => fake.appPath,
    getPath: () => fake.userData,
  },
}));
vi.mock('node:fs', () => ({
  default: {
    existsSync: (file: string) => fake.files.has(file),
    realpathSync: (file: string) => file,
    readdirSync: () => ['main.rs'],
    statSync: (file: string) => ({ mtimeMs: fake.files.get(file) ?? 0 }),
  },
}));
vi.mock('node:child_process', () => ({ execFile: fake.execFile }));
import { resolveWindowsInputHelper } from '../windowsHelperBinary.js';

describe('Windows input helper cache', () => {
  beforeEach(() => {
    fake.files.clear();
    fake.execFile.mockReset();
    fake.packaged = false;
    fake.appPath = path.resolve('fixture', 'checkout-a', 'apps', 'desktop');
    fake.userData = path.resolve('fixture', 'shared-dev-profile');
    fake.execFile.mockImplementation((_command, args: string[], _options, callback) => {
      const targetDir = args[args.indexOf('--target-dir') + 1];
      const target = args[args.indexOf('--target') + 1];
      const manifest = args[args.indexOf('--manifest-path') + 1];
      const kind = manifest.includes('windows-micro-helper') ? 'micro' : 'gamepad';
      fake.files.set(
        path.join(targetDir, target, 'release', `cindy-windows-${kind}-helper.exe`),
        100,
      );
      callback(null, '', '');
    });
  });

  it.each(['micro', 'gamepad'] as const)(
    'isolates %s builds across older checkouts sharing userData',
    async (kind) => {
      const group = kind === 'micro' ? 'worklouder' : 'xbox-gamepad';
      const addSource = () => {
        const source = path.join(fake.appPath, 'native', group, `windows-${kind}-helper`);
        fake.files.set(source, 1);
        for (const file of ['Cargo.toml', 'Cargo.lock', path.join('src', 'main.rs')])
          fake.files.set(path.join(source, file), 1);
      };
      addSource();
      const first = await resolveWindowsInputHelper(kind);
      expect(await resolveWindowsInputHelper(kind)).toBe(first);
      expect(fake.execFile).toHaveBeenCalledTimes(1);
      fake.appPath = path.resolve('fixture', 'checkout-b', 'apps', 'desktop');
      addSource();
      const second = await resolveWindowsInputHelper(kind);
      expect(second).not.toBe(first);
      expect(fake.execFile).toHaveBeenCalledTimes(2);
    },
  );
});
