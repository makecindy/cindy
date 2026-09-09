import { execFile, spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);

it.skipIf(process.platform !== 'darwin')(
  'preserves native system shortcut flags without posting input',
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cindy-keyboard-flags-'));
    try {
      const native = path.resolve(import.meta.dirname, '../../../../native/remote-desktop');
      const source = await readFile(path.join(native, 'macos-input.swift'), 'utf8');
      const tests = await readFile(path.join(native, 'macos-input.test.swift'), 'utf8');
      const main = path.join(directory, 'main.swift');
      const binary = path.join(directory, 'keyboard-test');
      await writeFile(main, `${source}\n${tests}`);
      await exec('swiftc', ['-D', 'DESKTOP_INPUT_TEST', main, '-o', binary], { timeout: 120_000 });
      const { stdout } = await exec(binary, [], { timeout: 5000 });
      expect(stdout.trim()).toBe('native keyboard flags passed');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  130_000,
);

it.skipIf(process.platform !== 'darwin')(
  'authenticates kernel stdio peers before any privileged entrypoint',
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cindy-input-caller-'));
    try {
      const native = path.resolve(import.meta.dirname, '../../../../native/remote-desktop');
      const source = await readFile(path.join(native, 'macos-input.swift'), 'utf8');
      const binary = path.join(directory, 'input');
      await exec('swiftc', [path.join(native, 'macos-input.swift'), '-o', binary], {
        timeout: 120_000,
      });
      for (const args of [
        [],
        ['--check'],
        ['--request-permission'],
        ['--clipboard-version'],
        ['--clipboard-content-version'],
        ['--clipboard-selection'],
        ['--clipboard-content-selection'],
        ['--display-modes', '1'],
        ['--display-mode', '1', '1'],
        ['--dev', '--check'],
      ]) {
        const result = spawnSync(binary, args, {
          encoding: 'utf8',
          timeout: 5000,
          env: { ...process.env, DESKTOP_INPUT_DEVELOPMENT: '1' },
        });
        expect(result.status, args.join(' ')).toBe(77);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('');
      }

      // Exercise the real audit-token/SecCode APIs with a harmless probe. It
      // contains only authentication, never AX reads, input or permission UI.
      const prefix = source
        .slice(0, source.indexOf('#if !DESKTOP_INPUT_TEST'))
        .replace(
          '"DESKTOP_INPUT_DEVELOPMENT_EXECUTABLE"',
          JSON.stringify(Buffer.from(process.execPath).toString('base64')),
        );
      const main = path.join(directory, 'main.swift');
      const probe = path.join(directory, 'probe');
      await writeFile(
        main,
        `${prefix}
if CommandLine.arguments.count == 2 {
  var own: SecCode?
  guard SecCodeCopySelf([], &own) == errSecSuccess, let own = own,
    DesktopInputCaller.hasSealedHelper(own, executable: URL(fileURLWithPath: CommandLine.arguments[1])) else { exit(79) }
  print("sealed"); exit(0)
}
guard let caller = DesktopInputCaller.authenticate(), caller.code() != nil else { exit(77) }
var staleToken = caller.token
staleToken.withUnsafeMutableBytes { $0.bindMemory(to: UInt32.self)[7] &+= 1 }
guard DesktopInputCaller(token: staleToken, parent: caller.parent, requirement: caller.requirement).code() == nil else { exit(78) }
print("authenticated")
`,
      );
      await exec('swiftc', ['-D', 'DESKTOP_INPUT_DEVELOPMENT', main, '-o', probe], {
        timeout: 120_000,
      });
      expect((await exec(probe, [], { timeout: 5000 })).stdout.trim()).toBe('authenticated');
      for (const stream of [0, 1, 2]) {
        const stdio: ('pipe' | 'ignore')[] = ['pipe', 'pipe', 'pipe'];
        stdio[stream] = 'ignore';
        // Keep the other socket peers open, as Main does; a closed stdin would
        // otherwise mask failures specific to stdout/stderr authentication.
        const status = await new Promise<number | null>((resolve, reject) => {
          const child = spawn(probe, [], { stdio, timeout: 5000 });
          child.stdout?.resume();
          child.stderr?.resume();
          child.once('error', reject);
          child.once('close', resolve);
        });
        expect(status).toBe(77);
      }
      const pipe = await exec('/bin/sh', ['-c', 'printf "" | "$1"', 'sh', probe], {
        timeout: 5000,
      }).catch((error: { code: number }) => error);
      expect(pipe).toMatchObject({ code: 77 });

      // Ad-hoc fixture exercises resource sealing only; it is deliberately
      // insufficient to pass production's Apple/team identity requirement.
      const bundle = path.join(directory, 'Fixture.app');
      const contents = path.join(bundle, 'Contents');
      const tools = path.join(contents, 'Resources/tools/remote-desktop');
      const executable = path.join(contents, 'MacOS/Fixture');
      const helper = path.join(tools, 'cindy-macos-desktop-input');
      await mkdir(tools, { recursive: true });
      await mkdir(path.dirname(executable), { recursive: true });
      await copyFile(probe, executable);
      await copyFile(binary, helper);
      await writeFile(
        path.join(contents, 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>invalid.cindy.input-auth-fixture</string>
<key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
      );
      await exec('/usr/bin/codesign', ['--force', '--sign', '-', bundle], { timeout: 10_000 });
      expect((await exec(executable, [helper], { timeout: 5000 })).stdout.trim()).toBe('sealed');
      await copyFile(probe, helper);
      expect(spawnSync(executable, [helper], { timeout: 5000 }).status).toBe(79);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  260_000,
);

it('keeps production authentication and hardened Electron fuses in packaged builds', async () => {
  const forge = await readFile(
    path.resolve(import.meta.dirname, '../../../../forge.config.ts'),
    'utf8',
  );
  expect(forge).not.toContain('DESKTOP_INPUT_DEVELOPMENT');
  expect(forge).not.toContain('DESKTOP_INPUT_TEST');
  for (const flag of [
    'RunAsNode',
    'EnableNodeOptionsEnvironmentVariable',
    'EnableNodeCliInspectArguments',
  ]) {
    expect(forge).toContain(`[FuseV1Options.${flag}]: false`);
  }
  for (const flag of ['EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar']) {
    expect(forge).toContain(`[FuseV1Options.${flag}]: true`);
  }
});
