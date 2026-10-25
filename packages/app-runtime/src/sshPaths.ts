import type { RemoteHost } from "@cindy/maker-remote-ssh";

/**
 * stat-remote-path — POSIX-bash-driven stat that also expands a leading `~`
 * or `~/...` to `$HOME` safely (no `eval`, no command injection).
 *
 * Output protocol (single line on stdout):
 *   `KIND <resolved-abs-path>`   where KIND ∈ {dir, file, missing}
 *
 * Tilde handling is intentionally done INSIDE the bash script (rather than
 * pre-expanded in TS) because we don't know the remote's $HOME at the
 * callsite — and asking the remote for $HOME just to inline-substitute
 * would be an extra round trip. The `case` pattern matches only `~` or
 * `~/anything` literally; `~user` is left as-is (uncommon; ssh user is
 * already the remote user). `${1:1}` parameter expansion is shell-safe
 * even with hostile input because $1 stays inside double quotes the whole
 * time it's compared/concatenated.
 */
export async function statRemotePath(
  host: RemoteHost,
  inputPath: string,
): Promise<{ kind: "dir" | "file" | "missing"; resolvedPath: string }> {
  if (/[\r\n\0]/.test(inputPath))
    throw new Error("Remote path contains unsupported control characters");
  // 归一化为绝对路径:
  // - 存在的目录 → cd && pwd -P (展开 symlink 与相对路径,与 daemon cwd 契约一致)
  // - 存在的文件 → parent cd && pwd -P + basename
  // - missing → 同 file 路径策略;parent 也不存在时退回原值 (用户输的本就没意义,
  //   交给上层 UI 报错)
  // session.workingDir 直接走这里返回的 resolvedPath,远端 codex daemon 的 cwd
  // 契约要求绝对路径,否则 thread/start 会失败或落到错误目录。
  const script = `
case "$1" in
  '~'|'~/'*) p="$HOME${"$"}{1:1}" ;;
  *)         p="$1" ;;
esac
case "$p" in
  *$'\\r'*|*$'\\n'*) exit 64 ;;
esac
abs_for() {
  local target="$1"
  if [ -d "$target" ]; then
    (cd -P -- "$target" && printf '%s' "$PWD")
  else
    local parent base
    parent="$(dirname -- "$target")"
    base="$(basename -- "$target")"
    if [ -d "$parent" ]; then
      (cd -P -- "$parent" && printf '%s/%s' "$PWD" "$base")
    else
      printf '%s' "$target"
    fi
  fi
}
if [ -d "$p" ]; then
  kind=dir
elif [ -e "$p" ]; then
  kind=file
else
  kind=missing
fi
# Preserve trailing newlines until validation, including symlink targets.
resolved="$(abs_for "$p" && printf '.')" || exit 64
resolved="${"$"}{resolved%.}"
case "$resolved" in
  *$'\\r'*|*$'\\n'*) exit 64 ;;
esac
printf '%s %s\\n' "$kind" "$resolved"
`;
  const result = await host.exec(
    `bash -c ${shellQuoteSh(script)} _ ${shellQuoteSh(inputPath)}`,
    { timeoutMs: 10_000, label: "stat-remote-path" },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `bash exit=${result.exitCode}: ${result.stderr.trim().slice(0, 200) || "(no stderr)"}`,
    );
  }
  // Shell startup can print banners before the final protocol line. Remove
  // only its terminator: trailing spaces belong to the path, not the framing.
  const line =
    result.stdout
      .replace(/\r?\n$/, "")
      .split(/\r?\n/)
      .pop() ?? "";
  // Allow spaces in the resolved path — only split on the first space.
  const spaceIdx = line.indexOf(" ");
  if (spaceIdx < 0) {
    throw new Error(`unexpected stat output: "${line.slice(0, 200)}"`);
  }
  const kindRaw = line.slice(0, spaceIdx);
  const resolvedPath = line.slice(spaceIdx + 1);
  if (kindRaw !== "dir" && kindRaw !== "file" && kindRaw !== "missing") {
    throw new Error(`unexpected stat kind: "${kindRaw}"`);
  }
  return { kind: kindRaw, resolvedPath };
}

/**
 * mkdir-p-remote — POSIX `mkdir -p` with the same safe tilde-expansion as
 * `statRemotePath`. Idempotent — succeeds if the directory already exists.
 * Errors (permission denied, parent is a file, etc.) come through the IPC
 * error channel via stderr.
 *
 * Returns the resolved (tilde-expanded) absolute path so callers can show
 * the user exactly what was created.
 */
export async function mkdirPRemote(
  host: RemoteHost,
  inputPath: string,
): Promise<{ resolvedPath: string }> {
  // 跟 statRemotePath 一致地归一化为绝对路径。mkdir -p 后目录必存在,直接
  // cd && pwd -P 即可,无需处理 missing 分支。
  const script = `
case "$1" in
  '~'|'~/'*) p="$HOME${"$"}{1:1}" ;;
  *)         p="$1" ;;
esac
mkdir -p "$p"
abs="$(cd "$p" && pwd -P)"
printf '%s\\n' "$abs"
`;
  const result = await host.exec(
    `bash -c ${shellQuoteSh(script)} _ ${shellQuoteSh(inputPath)}`,
    { timeoutMs: 15_000, label: "mkdir-p-remote" },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `bash exit=${result.exitCode}: ${result.stderr.trim().slice(0, 200) || "(no stderr)"}`,
    );
  }
  const resolvedPath = result.stdout.trim().split(/\r?\n/).pop() ?? "";
  if (!resolvedPath) {
    throw new Error("mkdir succeeded but resolved path is empty");
  }
  return { resolvedPath };
}

/**
 * list-remote-dir — POSIX-bash directory listing for the project picker.
 *
 * Returns the resolved absolute path of the dir + the child directories.
 * Tilde expansion done in-bash (same trick as statRemotePath). Output:
 *   first line:    `OK <resolved-abs-path>`
 *   then one line per child:  `D <name>`  (D = real dir, L = symlink to dir)
 *
 * We never list files — picker can only pick a directory, so files are
 * dead clicks. Symlink targets are resolved via `-L` so symlinked dirs
 * appear as L-prefixed children (UI can show a different glyph if needed).
 *
 * Bash-quoting: the entire script is single-quoted via shellQuoteSh, then
 * the user-supplied path is passed as $1 — never interpolated into the
 * script body — so a path like `; rm -rf /` is just a literal arg.
 */
export async function listRemoteDir(
  host: RemoteHost,
  inputPath: string,
): Promise<{
  resolvedPath: string;
  entries: Array<{ name: string; kind: "dir" | "symlink" }>;
}> {
  const script = `
case "$1" in
  '~'|'~/'*) p="$HOME${"$"}{1:1}" ;;
  *)         p="$1" ;;
esac
if [ ! -d "$p" ]; then
  printf 'ERR not a directory\\n' >&2
  exit 2
fi
# Resolve to canonical absolute path. cd in a subshell so we don't change
# the parent shell's cwd if anyone later reuses this connection.
abs="$(cd "$p" && pwd -P)"
printf 'OK %s\\n' "$abs"
# -A skips . and ..; -1 forces one entry per line; we then probe each
# child with test -d. -L means "follow symlinks for the test".
for entry in "$abs"/.* "$abs"/*; do
  [ -e "$entry" ] || continue
  name="${"$"}{entry##*/}"
  case "$name" in '.'|'..') continue ;; esac
  if [ -L "$entry" ] && [ -d "$entry" ]; then
    printf 'L %s\\n' "$name"
  elif [ -d "$entry" ]; then
    printf 'D %s\\n' "$name"
  fi
done
`;
  const result = await host.exec(
    `bash -c ${shellQuoteSh(script)} _ ${shellQuoteSh(inputPath)}`,
    { timeoutMs: 5_000, label: "list-remote-dir" },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `bash exit=${result.exitCode}: ${result.stderr.trim().slice(0, 200) || "(no stderr)"}`,
    );
  }
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  const header = lines.shift() ?? "";
  if (!header.startsWith("OK ")) {
    throw new Error(`unexpected ls output: ${header.slice(0, 80)}`);
  }
  const resolvedPath = header.slice(3);
  const entries: Array<{ name: string; kind: "dir" | "symlink" }> = [];
  for (const line of lines) {
    if (line.startsWith("D "))
      entries.push({ name: line.slice(2), kind: "dir" });
    else if (line.startsWith("L "))
      entries.push({ name: line.slice(2), kind: "symlink" });
  }
  // 大小写不敏感的 locale-aware 排序, 跟 Finder/Explorer 接近
  entries.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
  return { resolvedPath, entries };
}

export function shellQuoteSh(s: string): string {
  // POSIX-safe single-quote escape.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
