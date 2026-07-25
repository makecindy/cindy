import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile, chmod, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const dist = path.join(root, 'dist');
const releaseRoot = path.join(dist, `cindy-headless-${packageJson.version}`);
const artifactName = `cindy-headless-linux-${process.arch}.tar.gz`;
const tarball = path.join(dist, artifactName);
const checksumFile = path.join(dist, `${artifactName}.sha256`);
const workspaceRoot = path.resolve(root, '..', '..');
const runtimeNode = await realpath(process.execPath);

await rm(dist, { recursive: true, force: true });
await exec(process.execPath, [path.join(root, 'scripts', 'bundle.mjs')], { cwd: root });
await rm(releaseRoot, { recursive: true, force: true });
await mkdir(path.join(releaseRoot, 'bin'), { recursive: true });
await cp(path.join(root, 'dist', 'bundle'), path.join(releaseRoot, 'lib'), { recursive: true });
// A server must not need Node, npm, a compiler, or a network connection just
// to install Cindy. Ship the matching Node runtime and native SQLite addon as
// one architecture-specific release. The release builder is responsible for
// producing one archive per supported Linux architecture/ABI.
await mkdir(path.join(releaseRoot, 'runtime'), { recursive: true });
await cp(runtimeNode, path.join(releaseRoot, 'runtime', 'node'));
await chmod(path.join(releaseRoot, 'runtime', 'node'), 0o755);
await mkdir(path.join(releaseRoot, 'node_modules'), { recursive: true });
// Keep this list closed over the two intentionally externalized modules in
// bundle.mjs. better-sqlite3 needs bindings; gray-matter is CommonJS and its
// small dependency tree is resolved dynamically by Node at runtime.
for (const name of [
  'better-sqlite3', 'bindings', 'file-uri-to-path',
  'gray-matter', 'js-yaml', 'kind-of', 'section-matter', 'strip-bom-string',
  'extend-shallow', 'is-extendable', 'argparse', 'sprintf-js',
]) {
  await cp(path.join(workspaceRoot, 'node_modules', name), path.join(releaseRoot, 'node_modules', name), { recursive: true });
}
await writeFile(path.join(releaseRoot, 'release-target.env'), `platform=${process.platform}\narch=${process.arch}\nnode=${process.version}\n`);
await cp(path.join(root, 'systemd'), path.join(releaseRoot, 'systemd'), { recursive: true });
await cp(path.join(root, 'scripts', 'install-user-service.sh'), path.join(releaseRoot, 'install-user-service.sh'));
await cp(path.join(root, 'scripts', 'uninstall-user-service.sh'), path.join(releaseRoot, 'uninstall-user-service.sh'));

for (const name of ['cindy-headless', 'cindy', 'cindyctl']) {
  const wrapper = `#!/usr/bin/env sh\nset -eu\n# Resolve installer-created ~/.local/bin symlinks before locating the bundled runtime.\nscript=$0\nwhile [ -L "$script" ]; do\n  link=$(readlink "$script")\n  case "$link" in\n    /*) script=$link ;;\n    *) script=$(dirname -- "$script")/$link ;;\n  esac\ndone\nroot=$(CDPATH= cd -- "$(dirname -- "$script")/.." && pwd)\nnode_bin=\${CINDY_HEADLESS_NODE:-"$root/runtime/node"}\nif [ ! -x "$node_bin" ]; then\n  echo "Cindy runtime is missing: $node_bin" >&2\n  exit 1\nfi\nexec "$node_bin" "$root/lib/${name}.js" "$@"\n`;
  const file = path.join(releaseRoot, 'bin', name);
  await writeFile(file, wrapper, { mode: 0o755 });
  await chmod(file, 0o755);
}
await writeFile(path.join(releaseRoot, 'package.json'), `${JSON.stringify({
  private: true,
  type: 'module',
  cindyRelease: { platform: process.platform, arch: process.arch, runtime: process.version },
  dependencies: {
    'better-sqlite3': packageJson.dependencies['better-sqlite3'],
    'gray-matter': '^4.0.3',
  },
}, null, 2)}\n`);
await writeFile(path.join(releaseRoot, 'README.txt'), [
  'Cindy Linux headless host',
  '',
  'Install as a user service:',
  '  ./install-user-service.sh',
  '',
  'Upgrade: unpack the new release to a fresh directory and run the same installer.',
  'The installer replaces only its executable bundle; it preserves Cindy config and session history.',
  '',
  'This Linux release includes its Node runtime and the matching native SQLite module.',
  'No Node, npm, compiler, or network access is needed on the target during installation.',
  `Release target: ${process.platform}/${process.arch} (Node ${process.version}).`,
  'The installer rejects a release built for a different CPU architecture.',
  '',
  'Then sign in to your Cindy account (not Codex or Claude):',
  '  cindy login --sso XD',
  '  cindy chat',
  '',
  'User data uses XDG_CONFIG_HOME, XDG_STATE_HOME and XDG_RUNTIME_DIR; it never uses this release directory.',
  'Cindy uses an unlocked Linux Secret Service when available for restart-safe login.',
  'On headless servers without one, it uses an AES-256-GCM encrypted vault in its private state directory; tokens never enter config or plaintext files.',
].join('\n'));
await chmod(path.join(releaseRoot, 'install-user-service.sh'), 0o755);
await chmod(path.join(releaseRoot, 'uninstall-user-service.sh'), 0o755);
await rm(tarball, { force: true });
await rm(checksumFile, { force: true });
await exec('tar', ['-C', path.dirname(releaseRoot), '-czf', tarball, path.basename(releaseRoot)], {
  // macOS otherwise places provenance xattrs in the archive, which are
  // harmless but needlessly noisy when users unpack on Linux.
  env: { ...process.env, COPYFILE_DISABLE: '1' },
});
const digest = createHash('sha256').update(await readFile(tarball)).digest('hex');
await writeFile(checksumFile, `${digest}  ${artifactName}\n`, { mode: 0o644 });
process.stdout.write(`${tarball}\n`);
