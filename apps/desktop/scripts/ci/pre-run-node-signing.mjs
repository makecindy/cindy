import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const entitlements = fileURLToPath(new URL('../../native/pre-run-node/node.entitlements.plist', import.meta.url));

/** Re-sign after the blanket tools pass; Electron helper/main privileges must
 * not leak into standalone Node. Both ad-hoc and Developer ID use this path. */
export function signPreRunNode(tools, arch, { identity = '-', timestamp = false, run = execFileSync } = {}) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Unsupported macOS pre-run Node architecture: ' + arch);
  const node = path.join(tools, 'pre-run-node', 'darwin-' + arch, 'node');
  const options = { stdio: 'pipe' };
  run('/usr/bin/codesign', [
    '--force', ...(timestamp ? ['--timestamp'] : []), '--options', 'runtime',
    '--sign', identity, '--entitlements', entitlements, node,
  ], options);
  run('/usr/bin/codesign', ['--verify', '--strict', node], options);
  // Cross-target builds cannot assume Rosetta/native execution is available.
  // Always verify signatures; only claim execution for the native host target.
  const executed = arch === process.arch;
  if (executed) {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    run(node, ['--max-old-space-size=64', '--eval',
      'let x=0;for(let i=0;i<100000;i++)x+=i;if(x!==4999950000)throw Error("Node JIT smoke failed");',
    ], { ...options, env, timeout: 10_000 });
  }
  return { node, executed };
}
