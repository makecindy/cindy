// Cache only locked native dependencies, before the cloud revision is applied.
// Electron's own cache keys include source bytes, platform, arch, version and ABI;
// the enclosing prepared Docker layer additionally binds the lock and toolchain.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const binaries = { 'better-sqlite3': 'build/Release/better_sqlite3.node', 'node-pty': 'build/Release/pty.node' };
const sha = data => createHash('sha256').update(data).digest('hex');

function clearMetadata(buildPath) {
  // Do not accept Electron rebuild's ABI-only early return. Removing only the
  // marker in the packaging copy forces its source/ABI cache lookup instead.
  for (const name of Object.keys(binaries))
    fs.rmSync(path.join(buildPath, 'node_modules', name, 'build/Release/.forge-meta'), { force: true });
}

function verifiedBinaries(buildPath, electronVersion, arch, platform, cacheRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(cacheRoot, 'manifest.json'), 'utf8'));
  if (manifest.electronVersion !== electronVersion || manifest.arch !== arch || manifest.platform !== platform)
    throw Error('NATIVE_CACHE_TARGET_MISMATCH');
  return Object.entries(binaries).map(([name, relative]) => {
    const expected = manifest.binaries[name];
    const file = path.join(buildPath, 'node_modules', name, relative);
    if (sha(fs.readFileSync(file)) !== expected.sha256)
      throw Error(`NATIVE_CACHE_BINARY_MISMATCH:${name}`);
    return { name, file, mode: expected.mode };
  });
}

function verifyPackage(buildPath, electronVersion, arch, platform, cacheRoot = '/workspace/native-cache') {
  for (const { name, file, mode } of verifiedBinaries(buildPath, electronVersion, arch, platform, cacheRoot))
    if ((fs.statSync(file).mode & 0o777) !== mode) throw Error(`NATIVE_CACHE_BINARY_MISMATCH:${name}`);
  console.log('NATIVE_ELECTRON_CACHE_REUSED');
}

function restorePackage(buildPath, electronVersion, arch, platform, cacheRoot = '/workspace/native-cache') {
  // Electron rebuild 4.2 caches file bytes, not modes. Restore only the two
  // hash-verified build outputs, never source directories or user files.
  const files = verifiedBinaries(buildPath, electronVersion, arch, platform, cacheRoot);
  for (const { file, mode } of files) fs.chmodSync(file, mode);
  verifyPackage(buildPath, electronVersion, arch, platform, cacheRoot);
}

async function prime(source, output, electronVersion, rebuild) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw Error('NATIVE_LINUX_X64_REQUIRED');
  if (fs.existsSync(output)) throw Error('NATIVE_CACHE_OUTPUT_EXISTS');
  const req = createRequire(path.join(source, 'apps/desktop/package.json'));
  const resolve = name => path.dirname(req.resolve(`${name}/package.json`));
  const pty = resolve('node-pty');
  const modules = { 'better-sqlite3': resolve('better-sqlite3'), 'node-pty': pty,
    'node-addon-api': path.dirname(createRequire(path.join(pty, 'package.json')).resolve('node-addon-api/package.json')) };
  const scratch = path.join(output, 'prime');
  fs.mkdirSync(path.join(scratch, 'node_modules'), { recursive: true });
  try {
    const dependencies = {};
    for (const [name, folder] of Object.entries(modules)) {
      dependencies[name] = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')).version;
      fs.cpSync(folder, path.join(scratch, 'node_modules', name), { recursive: true, dereference: true });
    }
    fs.writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ name: 'cloud-native-cache', version: '0.0.0', dependencies }));
    // Physical copies protect the Node ABI dependencies used by the build tools.
    // force=true disables useCache in electron-rebuild 4.2. Clear the copied
    // marker instead, so only its source/ABI cache may avoid compilation.
    clearMetadata(scratch);
    await rebuild({ buildPath: scratch, electronVersion, arch: 'x64', force: false, buildFromSource: true,
      onlyModules: Object.keys(binaries), useCache: true, cachePath: path.join(output, 'rebuild') });
    const manifest = { electronVersion, arch: 'x64', platform: 'linux', binaries: {} };
    for (const [name, relative] of Object.entries(binaries)) {
      const file = path.join(scratch, 'node_modules', name, relative), bytes = fs.readFileSync(file);
      if (!bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw Error(`NATIVE_CACHE_NOT_ELF:${name}`);
      manifest.binaries[name] = { sha256: sha(bytes), mode: fs.statSync(file).mode & 0o777 };
    }
    if (fs.readdirSync(path.join(output, 'rebuild')).length !== 2) throw Error('NATIVE_CACHE_INCOMPLETE');
    fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest));
    console.log('NATIVE_ELECTRON_CACHE_PREPARED');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

module.exports = { prime, verifyPackage, restorePackage, clearMetadata };
if (require.main === module) {
  const [source, output, electronVersion] = process.argv.slice(2);
  if (!source || !output || !/^\d+\.\d+\.\d+$/.test(electronVersion || '')) throw Error('NATIVE_CACHE_ARGUMENTS');
  const req = createRequire(path.join(source, 'apps/desktop/package.json'));
  import(pathToFileURL(req.resolve('@electron/rebuild')).href)
    .then(({ rebuild }) => prime(source, output, electronVersion, rebuild))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
