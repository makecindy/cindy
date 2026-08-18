/** Install the pinned DSH JavaScript runtime beneath Cindy's remote namespace. */
import type { RemoteHost } from '@cindy/maker-remote-ssh';
import { BUNDLED_NODE_INSTALL_SH } from '@cindy/maker-remote-ssh';

const DSH_VERSION = '0.1.0-rc.7';
const PACKAGES = [
  '@deepseek-ai/dsh-agent-spine-demo', '@deepseek-ai/dsh-bash-local',
  '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-fs-local',
  '@deepseek-ai/dsh-fs-observation-policy', '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-sdk-jsonrpc-demo', '@deepseek-ai/dsh-sdk-jsonrpc-server',
  '@deepseek-ai/dsh-session-checkpoint-policy', '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-subagent', '@deepseek-ai/dsh-subagent-spawn-in-process',
  '@deepseek-ai/dsh-subprocess-local', '@deepseek-ai/dsh-token-meter',
  '@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-tool-todo',
].map((name) => `${name}@${DSH_VERSION}`);

const inFlight = new Map<string, Promise<void>>();

/**
 * This is deliberately isolated from the generic CLI installer: DSH is a
 * plugin graph, not an executable release. Packages are exact-versioned and
 * install scripts are disabled; no key or config travels through this path.
 */
export function ensureDshRuntime(host: RemoteHost): Promise<void> {
  const existing = inFlight.get(host.id);
  if (existing) return existing;
  const pending = ensureDshRuntimeInner(host).finally(() => inFlight.delete(host.id));
  inFlight.set(host.id, pending);
  return pending;
}

async function ensureDshRuntimeInner(host: RemoteHost): Promise<void> {
  const nodeInstall = await host.exec(`bash -c ${shellQuote(BUNDLED_NODE_INSTALL_SH)}`, {
    timeoutMs: 5 * 60_000,
    label: 'dsh-remote-node-install',
  });
  if (nodeInstall.exitCode !== 0) throw new Error(`unable to install Cindy bundled Node for DSH (exit ${nodeInstall.exitCode})`);

  const manifest = JSON.stringify({ private: true, dependencies: Object.fromEntries(PACKAGES.map((entry) => {
    const at = entry.lastIndexOf('@'); return [entry.slice(0, at), entry.slice(at + 1)];
  })) });
  const script = String.raw`set -eu
ROOT="$HOME/.xdt-server/v1/dsh"
NODE_ROOT="$HOME/.xdt-server/v1/node"
NODE="$NODE_ROOT/bin/node"
NPM="$NODE_ROOT/bin/npm"
[ -x "$NODE" ] && [ -x "$NPM" ] || exit 72
umask 077
mkdir -p "$ROOT"
printf '%s' "$1" | base64 -d > "$ROOT/package.json"
if [ -f "$ROOT/.cindy-dsh-version" ] && [ "$(cat "$ROOT/.cindy-dsh-version")" = "$2" ] && [ -f "$ROOT/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/bin.js" ]; then
  "$NODE" "$ROOT/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js" --help >/dev/null 2>&1 && exit 0
fi
cd "$ROOT"
PATH="$NODE_ROOT/bin:$PATH" "$NPM" install --ignore-scripts --omit=dev --no-audit --no-fund --package-lock=true
printf '%s' "$2" > "$ROOT/.cindy-dsh-version"
"$NODE" "$ROOT/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js" --help >/dev/null`;
  const result = await host.exec(
    `bash -c ${shellQuote(script)} -- ${shellQuote(Buffer.from(manifest).toString('base64'))} ${shellQuote(DSH_VERSION)}`,
    { timeoutMs: 5 * 60_000, label: 'dsh-remote-runtime-install' },
  );
  if (result.exitCode !== 0) {
    throw new Error(`unable to install DSH runtime on remote host (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 300)}`);
  }
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
