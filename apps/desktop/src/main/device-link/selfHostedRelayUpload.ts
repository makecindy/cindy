/** 只搬运宿主提供的公开部署材料，不决定远端的运行环境、服务管理或权限。 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ensureRemoteHostReady, getRemoteSshPool } from '../remote-ssh/index.js';

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

// 文件名按内容寻址；临时文件与最终文件在同一目录，用 hard link 原子发布且绝不覆盖。
// 目录由 Agent 在了解目标环境后准备；这里不运行 sudo，也不信任远端输出中的命令或路径。
const UPLOAD = `set -eu
umask 077
cd "$1"
file="$2"
expected="$3"
hash() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1
  else shasum -a 256 "$1" | cut -d ' ' -f 1; fi
}
tmp=$(mktemp .cindy-relay-upload.XXXXXXXX)
trap 'rm -f "$tmp"' EXIT HUP INT TERM
cat > "$tmp"
[ "$(hash "$tmp")" = "$expected" ]
if [ ! -e "$file" ] && [ ! -L "$file" ]; then ln "$tmp" "$file"; fi
[ ! -L "$file" ] && [ -f "$file" ] && [ "$(hash "$file")" = "$expected" ]
printf '%s\\n' "$expected"
`;

export async function uploadRelayArtifacts(input: {
  sshHostId: string;
  remoteDir: string;
  relayId: string;
  bundle: Buffer;
  init: Buffer;
  assertCurrent: () => Promise<void>;
}): Promise<{ bundlePath: string; initPath: string; bundleSha256: string; initSha256: string }> {
  await input.assertCurrent();
  await ensureRemoteHostReady(input.sshHostId);
  await input.assertCurrent();
  const host = getRemoteSshPool().get(input.sshHostId);
  if (!host) throw new Error('SSH_FAILED');
  const bundleSha256 = createHash('sha256').update(input.bundle).digest('hex');
  const initSha256 = createHash('sha256').update(input.init).digest('hex');
  const bundleName = `relay-${bundleSha256}.mjs`;
  const initName = `relay-init-${input.relayId}-${initSha256}.json`;
  for (const artifact of [{ name: bundleName, hash: bundleSha256, content: input.bundle }, { name: initName, hash: initSha256, content: input.init }]) {
    await input.assertCurrent();
    const command = `sh -c ${quote(UPLOAD)} cindy-relay ${quote(input.remoteDir)} ${quote(artifact.name)} ${quote(artifact.hash)}`;
    const result = await host.exec(command, { input: artifact.content, timeoutMs: 120_000, label: 'relay-agent-upload' });
    await input.assertCurrent();
    if (result.exitCode !== 0 || result.stdout.trim() !== artifact.hash) throw new Error('UPLOAD_FAILED');
  }
  return { bundlePath: path.posix.join(input.remoteDir, bundleName), initPath: path.posix.join(input.remoteDir, initName), bundleSha256, initSha256 };
}
