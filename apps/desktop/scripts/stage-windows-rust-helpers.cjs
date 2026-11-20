const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Desktop and Node Host ship the same native sources under resources/tools.
function stageWindowsRustHelpers(resources, arch) {
  const target = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' }[arch];
  if (!target) throw new Error(`Unsupported Windows helper architecture: ${arch}`);
  const userRustc = path.join(os.homedir(), '.cargo', 'bin', 'rustc.exe');
  const rustc = fs.existsSync(userRustc) ? userRustc : 'rustc';
  const build = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-windows-helpers-'));
  try {
    for (const [group, executable] of [
      ['windows-atomic-rename', 'cindy-windows-atomic-rename.exe'],
      ['windows-mcp-stdio-job', 'cindy-mcp-stdio-job.exe'],
    ]) {
      const source = path.join(__dirname, '..', 'native', group, 'main.rs');
      const built = path.join(build, executable);
      execFileSync(rustc, [
        source, '--edition=2021', '-C', 'opt-level=s', '-C', 'panic=abort', '--target', target, '-o', built,
      ], { timeout: 180_000, stdio: 'inherit', windowsHide: true });
      const destination = path.join(resources, 'tools', group);
      fs.mkdirSync(destination, { recursive: true });
      fs.copyFileSync(built, path.join(destination, executable));
    }
  } finally {
    fs.rmSync(build, { recursive: true, force: true });
  }
}

module.exports = { stageWindowsRustHelpers };
