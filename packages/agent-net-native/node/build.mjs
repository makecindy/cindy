#!/usr/bin/env node
// Builds the native Agent-Net engine's Node module (this crate) and writes it where the Desktop looks for it:
//   node packages/agent-net-native/node/build.mjs [--target <rust target triple>] [--out <file>]
// Default target: this machine's; default output: apps/desktop/resources/agent-net/cindy-agent-net.node, beside the worker
// bundle (agentNetRuntime.ts `agentNetNative`). Packaging runs it for the target it packages (forge.config.ts
// `stageAgentNetNative`). Without the module the Desktop's Agent-Net worker runs on WASM, as before.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const option = (name) => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : undefined; };
const userCargo = path.join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const cargo = process.env.CARGO || (existsSync(userCargo) ? userCargo : 'cargo');
const rustc = process.env.RUSTC || path.join(path.dirname(cargo), process.platform === 'win32' ? 'rustc.exe' : 'rustc');
const host = /^host: (.+)$/m.exec(spawnSync(existsSync(rustc) ? rustc : 'rustc', ['-vV'], { encoding: 'utf8' }).stdout ?? '')?.[1];
const target = option('--target') ?? host;
if (!target) throw new Error('AGENT_NET_NODE_REQUIRES_RUST: no Rust toolchain found');
const out = path.resolve(option('--out') ?? path.join(root, '..', '..', '..', 'apps', 'desktop', 'resources', 'agent-net', 'cindy-agent-net.node'));
const built = target.includes('windows') ? 'cindy_agent_net_node.dll' : target.includes('apple') ? 'libcindy_agent_net_node.dylib' : 'libcindy_agent_net_node.so';

const targetDir = mkdtempSync(path.join(tmpdir(), 'cindy-agent-net-node-'));
try {
  const result = spawnSync(cargo, ['build', '--release', '--locked', '--target', target, '--manifest-path', path.join(root, 'Cargo.toml'),
    '--target-dir', targetDir], { stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`AGENT_NET_NODE_BUILD_FAILED: cargo ${result.error?.message ?? 'exited ' + result.status}`);
  mkdirSync(path.dirname(out), { recursive: true });
  // A complete copy renamed into place: a running development instance may have the previous one loaded.
  const partial = `${out}.${process.pid}.tmp`;
  copyFileSync(path.join(targetDir, target, 'release', built), partial);
  renameSync(partial, out);
  console.log(`[agent-net-native] ${target} -> ${out}`);
} finally {
  rmSync(targetDir, { recursive: true, force: true });
}
