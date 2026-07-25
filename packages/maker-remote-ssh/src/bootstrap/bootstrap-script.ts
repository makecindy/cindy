/**
 * bootstrap-script — the bash script we pipe over SSH stdin to set up
 * an agent CLI on the remote machine.
 *
 * Inlined as a TS string instead of a separate .sh file so the package
 * stays bundler-friendly (no fs.readFile of a sibling file at runtime —
 * Vite / Electron Forge bundling rules vary on that).
 *
 * Design: we DO NOT trust system Node. The remote could have no Node,
 * a broken Node, an ancient Node, or a Node hidden behind a shell init
 * file `bash -l` won't source. Instead we download a known-good Node
 * tarball into `~/.xdt-server/<ver>/node/` and use it for everything.
 * Mirrors the VSCode Remote-SSH approach (they bundle Node in their
 * server tarball). Costs ~30 MB per remote per schema version, paid once.
 *
 * Protocol (every line is one line of stdout, line-prefixed for parsing):
 *
 *   PROBE_START
 *   INSTALL_DIR <abs path>
 *   NODE_CACHED <version>       (bundled node already cached; skip download)
 *   NODE_INSTALL_START <ver>    (about to download)
 *   NODE_DOWNLOAD <url>         (downloading from this URL)
 *   NODE_EXTRACT <basename>     (extracting tarball)
 *   NODE_INSTALL_DONE <version> (bundled node ready, runnable)
 *   ALREADY_INSTALLED <version> (agent sentinel valid; skip install)
 *   INSTALL_START <package-or-installer>
 *                               (claude-code: npm package name;
 *                                codex: 'codex-standalone' — official curl install.sh)
 *   INSTALL_LOG <line>          (relayed npm / curl / install.sh line, may repeat)
 *   INSTALL_DONE
 *   READY <version>             (final terminal-success; binary verified)
 *   ERROR <message>             (terminal-failure; non-zero exit follows)
 *
 * Exit codes:
 *   0  = READY
 *   4  = AGENT_INSTALL_FAILED
 *          (claude-code: npm install failed;
 *           codex: awk preflight (mawk 不支持 {n} ERE) / curl install.sh fetch /
 *                  install.sh 内 SHA256 校验 / 解压等任一阶段失败)
 *   5  = AGENT_BINARY_NOT_RUNNABLE
 *   6  = UNSUPPORTED_PLATFORM_OR_ARCH
 *   7  = NODE_DOWNLOAD_FAILED
 *   10 = UNKNOWN_AGENT_KIND
 */

export const REMOTE_SERVER_SCHEMA_VERSION = 'v1';
export const REMOTE_INSTALL_ROOT = '$HOME/.xdt-server';

/** Bash snippet (read-only) used by probe script — reports bundled state. */
export const PROBE_BUNDLED_NODE_SH = String.raw`if [ -x "$NODE_BIN" ]; then
  V="$("$NODE_BIN" -p 'process.versions.node' 2>/dev/null || echo '')"
  if [ -n "$V" ]; then printf 'NODE_CACHED %s\n' "$V"; fi
else
  printf 'NODE_MISSING\n'
fi
`;

/**
 * Pinned Node version downloaded into `~/.xdt-server/<ver>/node/`.
 * Bump when LTS rolls. The tarball must exist at
 * https://nodejs.org/dist/v<VER>/node-v<VER>-{darwin,linux}-{arm64,x64}.tar.gz
 * for all four matrix entries (verify before bumping).
 */
export const BUNDLED_NODE_VERSION = '22.13.0';

/** Override via env var on the host side if user is behind a firewall / mirror. */
export const NODE_DIST_BASE_URL_DEFAULT = 'https://nodejs.org/dist';

/**
 * codex 官方安装器来源(TS 常量插值进下方 bash 模板,避免 URL 深埋脚本内):
 * pinned 版本用该 release 自带的 install.sh(GitHub Release);latest 用官方入口。
 */
export const CODEX_RELEASE_INSTALLER_URL_BASE = 'https://github.com/openai/codex/releases/download';
export const CODEX_LATEST_INSTALLER_URL = 'https://chatgpt.com/codex/install.sh';

/**
 * Bash script. Args:
 *   $1 = agentKind (claude-code | codex)
 *   $2 = serverVersion (matches REMOTE_SERVER_SCHEMA_VERSION; reserved for future bumps)
 *   $3 = bundled node version (BUNDLED_NODE_VERSION)
 *   $4 = node dist base URL (NODE_DIST_BASE_URL_DEFAULT)
 *   $5 = codex release version (tools/codex/latest.json pin; codex only)
 *   $6 = Claude Code version (tools/claude/latest.json pin; claude-code only)
 *
 * The version + URL are passed as args (not hardcoded) so a host-side
 * config knob can later override them without changing this file.
 */
export const BOOTSTRAP_SH = String.raw`#!/usr/bin/env bash
set -u
set -o pipefail

AGENT_KIND="${'$'}{1:-}"
SERVER_VER="${'$'}{2:-v1}"
NODE_VER="${'$'}{3:-22.13.0}"
NODE_BASE_URL="${'$'}{4:-https://nodejs.org/dist}"
CODEX_RELEASE="${'$'}{5:-}"
CLAUDE_RELEASE="${'$'}{6:-}"

emit() { printf '%s\n' "$*"; }

# Per-agent install method:
#  - claude-code: npm install into our isolated $INSTALL_DIR/node_modules/
#  - codex:       official install.sh standalone, redirected via CODEX_HOME
#                 to our isolated $INSTALL_DIR/codex-home/. Why standalone:
#                 codex daemon mode (app-server daemon bootstrap --remote-control)
#                 requires a "managed install" at $CODEX_HOME/packages/standalone/current/codex.
#                 The npm @openai/codex package does NOT create that layout
#                 (see codex-rs/app-server-daemon/src/managed_install.rs).
case "$AGENT_KIND" in
  claude-code)
    if [ -z "$CLAUDE_RELEASE" ]; then
      emit "ERROR missing Claude Code release"
      exit 4
    fi
    NPM_PKG="@anthropic-ai/claude-code@$CLAUDE_RELEASE"
    BIN_NAME="claude"
    ;;
  codex)       NPM_PKG="";                          BIN_NAME="codex"  ;;
  *) emit "ERROR unknown agent kind: $AGENT_KIND"; exit 10 ;;
esac

emit "PROBE_START"

INSTALL_DIR="$HOME/.xdt-server/$SERVER_VER"
NODE_DIR="$INSTALL_DIR/node"
NODE_BIN="$NODE_DIR/bin/node"
NPM_BIN="$NODE_DIR/bin/npm"
SENTINEL="$INSTALL_DIR/.installed-$AGENT_KIND"
# codex 走 standalone (install.sh), binary 在 isolated CODEX_HOME 下;
# claude-code 走 npm,binary 在 isolated node_modules/.bin 下。
# 所有路径都在 ~/.xdt-server/$SERVER_VER/ 下,卸载只需 rm -rf 这一棵树。
if [ "$AGENT_KIND" = "codex" ]; then
  CODEX_HOME_DIR="$INSTALL_DIR/codex-home"
  CODEX_INSTALL_BIN="$CODEX_HOME_DIR/bin"
  BIN_PATH="$CODEX_HOME_DIR/packages/standalone/current/codex"
else
  BIN_PATH="$INSTALL_DIR/node_modules/.bin/$BIN_NAME"
fi
mkdir -p "$INSTALL_DIR"
emit "INSTALL_DIR $INSTALL_DIR"

# ── ensure bundled Node ────────────────────────────────────────────────────
# Always use our own Node. System node is ignored entirely — too many ways
# for it to be missing / broken / version-mismatched / hidden behind shell
# init. Cached binary is reused; only download on first install (or after
# we wiped the cache because the cached binary stopped running).

ensure_node() {
  if [ -x "$NODE_BIN" ]; then
    V="$("$NODE_BIN" -p 'process.versions.node' 2>/dev/null || echo '')"
    if [ -n "$V" ]; then
      emit "NODE_CACHED $V"
      return 0
    fi
    # Cache exists but binary won't run (corrupted? OS upgrade?). Wipe & redo.
    rm -rf "$NODE_DIR"
  fi

  emit "NODE_INSTALL_START $NODE_VER"

  # Map uname to Node's release naming.
  OS_TAG=""
  ARCH_TAG=""
  case "$(uname -s)" in
    Darwin) OS_TAG="darwin" ;;
    Linux)  OS_TAG="linux"  ;;
    *)      emit "ERROR unsupported OS: $(uname -s)"; exit 6 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) ARCH_TAG="arm64" ;;
    x86_64|amd64)  ARCH_TAG="x64"   ;;
    *)             emit "ERROR unsupported arch: $(uname -m)"; exit 6 ;;
  esac

  BASE="node-v${'$'}{NODE_VER}-${'$'}{OS_TAG}-${'$'}{ARCH_TAG}"
  URL="${'$'}{NODE_BASE_URL}/v${'$'}{NODE_VER}/${'$'}{BASE}.tar.gz"
  TMP="$INSTALL_DIR/.node-dl-$$.tar.gz"

  # Need a downloader. curl ships with every macOS & most Linux; wget is
  # the common fallback. Bail clearly if neither is present.
  DL=""
  if command -v curl >/dev/null 2>&1; then DL="curl"
  elif command -v wget >/dev/null 2>&1; then DL="wget"
  else emit "ERROR neither curl nor wget found; cannot download Node"; exit 7
  fi

  emit "NODE_DOWNLOAD $URL"
  if [ "$DL" = "curl" ]; then
    # -fSL: fail on HTTP errors, show server errors, follow redirects.
    # --connect-timeout: don't hang forever on broken networks.
    if ! curl -fSL --connect-timeout 15 -o "$TMP" "$URL" 2>&1 \
        | while IFS= read -r line; do emit "INSTALL_LOG [curl] $line"; done; then
      rm -f "$TMP"
      emit "ERROR download failed ($DL): $URL"
      exit 7
    fi
  else
    if ! wget -q -O "$TMP" "$URL" 2>&1 \
        | while IFS= read -r line; do emit "INSTALL_LOG [wget] $line"; done; then
      rm -f "$TMP"
      emit "ERROR download failed ($DL): $URL"
      exit 7
    fi
  fi

  if [ ! -s "$TMP" ]; then
    rm -f "$TMP"
    emit "ERROR downloaded file is empty: $URL"
    exit 7
  fi

  emit "NODE_EXTRACT $BASE"
  mkdir -p "$NODE_DIR"
  if ! tar -xzf "$TMP" -C "$NODE_DIR" --strip-components=1 2>&1 \
      | while IFS= read -r line; do emit "INSTALL_LOG [tar] $line"; done; then
    rm -f "$TMP"
    emit "ERROR failed to extract tarball $BASE"
    exit 7
  fi
  rm -f "$TMP"

  if [ ! -x "$NODE_BIN" ]; then
    emit "ERROR node binary missing after extract at $NODE_BIN"
    exit 7
  fi

  V="$("$NODE_BIN" -p 'process.versions.node' 2>/dev/null || echo '?')"
  emit "NODE_INSTALL_DONE $V"
}

# ensure_node moved into the claude-code branch below — codex doesn't need Node.

# (PATH-prepend bundled node was here; moved into the claude-code install branch.)

# ── verify existing agent install (idempotent re-run case) ─────────────────
# 永远先直接 exec $BIN_PATH (兼容两种形态):
#   - native binary (Mach-O / ELF): 唯一可行路径 — node 会因为 .exe / 别的
#     非 .js 后缀 throw ERR_UNKNOWN_FILE_EXTENSION。注意 @anthropic-ai/claude-code
#     的 bin/claude.exe 在 macOS 上是 Mach-O arm64, 名字误导
#   - JS shim (#!/usr/bin/env node ...): shebang 走 PATH 找 node; 如果系统
#     PATH 没 node (mac CI 账户常见), 走 fallback 用 bundled $NODE_BIN
# chmod +x real target 兜底 — npm 装 native binary 偶尔丢 +x mode。
# 失败时把 stderr + ls / file / head 几行 emit 到 INSTALL_LOG (silent install
# pipeline 透传到 desktop main log), 不用 ssh 进远端调试。
verify_binary() {
  if [ ! -L "$BIN_PATH" ] && [ ! -x "$BIN_PATH" ] && [ ! -f "$BIN_PATH" ]; then return 1; fi
  _STDERR_LOG="$INSTALL_DIR/.verify-stderr-$$"

  # Make sure the real binary (follow symlink) is executable — npm shim 创建
  # 时偶尔丢 +x 位 (尤其在 npm 把 .exe 名 file 当 Windows-only 后)。
  _REAL_TARGET="$(readlink -f "$BIN_PATH" 2>/dev/null || echo "$BIN_PATH")"
  chmod +x "$_REAL_TARGET" 2>/dev/null || true

  # Try direct exec first — works for native binaries (the common case for
  # claude-code on real platforms after optional dep installs) AND for JS
  # shims whose shebang can find node on PATH.
  V="$("$BIN_PATH" --version 2>"$_STDERR_LOG" | head -1 || true)"

  # Fallback (claude-code only): if direct exec produced no output, the bin
  # might be a JS shim and shebang 'env node' couldn't find node. Try with
  # bundled $NODE_BIN explicitly. Append stderr (don't overwrite) so both
  # attempts' errors are captured for diagnostics.
  if [ -z "$V" ] && [ "$AGENT_KIND" = "claude-code" ]; then
    V="$("$NODE_BIN" "$BIN_PATH" --version 2>>"$_STDERR_LOG" | head -1 || true)"
  fi

  if [ -n "$V" ] &&
     { [ "$AGENT_KIND" != "claude-code" ] || [ "${'$'}{V%% *}" = "$CLAUDE_RELEASE" ]; }; then
    emit "READY $V"
    rm -f "$_STDERR_LOG"
    return 0
  fi
  if [ -n "$V" ]; then
    emit "INSTALL_LOG [verify-fail] Claude Code version ${'$'}{V%% *} != managed pin $CLAUDE_RELEASE"
  fi
  # Diagnostics on failure — these go to INSTALL_LOG so the desktop main process
  # logs them (silent install pipeline forwards INSTALL_LOG lines verbatim).
  emit "INSTALL_LOG [verify-fail] AGENT_KIND=$AGENT_KIND BIN_PATH=$BIN_PATH NODE_BIN=$NODE_BIN"
  if [ -s "$_STDERR_LOG" ]; then
    while IFS= read -r _line; do
      emit "INSTALL_LOG [verify-stderr] $_line"
    done < "$_STDERR_LOG"
  else
    emit "INSTALL_LOG [verify-fail] (no stderr captured; binary may have exited 0 with empty stdout)"
  fi
  ls -la "$BIN_PATH" 2>&1 | while IFS= read -r _line; do
    emit "INSTALL_LOG [verify-fail ls] $_line"
  done
  if command -v file >/dev/null 2>&1; then
    file "$BIN_PATH" 2>&1 | while IFS= read -r _line; do
      emit "INSTALL_LOG [verify-fail file] $_line"
    done
  fi
  # If it's a symlink (npm bin shim), follow it and dump the real file's shebang
  _REAL="$(readlink -f "$BIN_PATH" 2>/dev/null || echo "$BIN_PATH")"
  if [ "$_REAL" != "$BIN_PATH" ]; then
    emit "INSTALL_LOG [verify-fail readlink] $BIN_PATH -> $_REAL"
  fi
  head -3 "$_REAL" 2>&1 | while IFS= read -r _line; do
    emit "INSTALL_LOG [verify-fail head] $_line"
  done
  rm -f "$_STDERR_LOG"
  return 1
}

if [ -f "$SENTINEL" ]; then
  if verify_binary; then exit 0; fi
  # sentinel present but binary unrunnable → fall through to reinstall
fi

# ── install agent ─────────────────────────────────────────────────────────
# claude-code: bundled-Node + npm install (agent shim needs node at runtime).
# codex:       official install.sh standalone, isolated under our CODEX_HOME
#              (daemon mode requires the standalone layout — see top-of-script comment).
if [ "$AGENT_KIND" = "claude-code" ]; then
  ensure_node
  # PATH-prepend bundled node so the agent CLI's shebang (#!/usr/bin/env node)
  # finds bundled node at runtime + npm postinstall scripts see sandboxed node.
  export PATH="$NODE_DIR/bin:$PATH"

  cd "$INSTALL_DIR" || { emit "ERROR cannot cd to $INSTALL_DIR"; exit 4; }
  if [ ! -f "package.json" ]; then
    printf '%s\n' '{"name":"xdt-server","private":true}' > package.json
  fi

  # Detect & nuke stale "claude.exe placeholder" state. Background: when a
  # previous install ran without --include=optional (or with a host npmrc
  # that suppressed optional deps), @anthropic-ai/claude-code's
  # @anthropic-ai/claude-cli-<plat>-<arch> native CLI optional dep didn't
  # install, leaving node_modules/.bin/claude symlinked to a placeholder
  # bin/claude.exe (a sh script that just prints "Error: claude native binary
  # not installed"). npm's idempotent install sees node_modules "satisfying"
  # package.json and won't re-resolve the optional even when --include=optional
  # is now passed. Solution: wipe @anthropic-ai/ to force a fresh resolve.
  # Keeps bundled node + npm metadata, only clears ~80MB under @anthropic-ai/.
  if [ -L "node_modules/.bin/claude" ]; then
    _LINK_TARGET="$(readlink "node_modules/.bin/claude" 2>/dev/null || echo '')"
    case "$_LINK_TARGET" in
      *.exe)
        emit "INSTALL_LOG previous install left placeholder native CLI ($_LINK_TARGET); wiping node_modules/@anthropic-ai for fresh install"
        rm -rf "node_modules/@anthropic-ai"
        ;;
    esac
  fi

  emit "INSTALL_START $NPM_PKG"
  # Absolute path to bundled npm — don't rely on PATH inside npm's child
  # processes (some postinstall scripts mess with PATH).
  #
  # Flag rationale:
  #   --include=optional: @anthropic-ai/claude-code ships per-platform native
  #     CLI binary via optionalDependencies (@anthropic-ai/claude-cli-<plat>-<arch>).
  #     Some macOS / CI accounts have a global npmrc that omits optional, which
  #     leaves only the bin/claude.exe sh-script placeholder ("Error: claude
  #     native binary not installed"). Forcing --include=optional bypasses this.
  #   --foreground-scripts: surface postinstall output (the placeholder echo
  #     above hints "Either postinstall did not run" — making postinstall
  #     visible lets us diagnose silently-skipped postinstall hooks).
  #   no --prefix: we're already cd'd into $INSTALL_DIR. --prefix on some npm
  #     versions skips postinstall when the prefix differs from cwd.
  # Redirect (2>&1): merge stderr into stdout so INSTALL_LOG captures
  # postinstall output — the old "2>&1 1>/dev/null" silently dropped stdout,
  # masking the actual install failure for ~6 months on macOS hosts.
  # Capture npm's exit status before capping log output. A direct pipe to head
  # reports the pipe status, which can hide npm failures on repair paths.
  NPM_LOG="$INSTALL_DIR/.npm-install-$$.log"
  "$NPM_BIN" install --no-audit --no-fund --include=optional --foreground-scripts "$NPM_PKG" >"$NPM_LOG" 2>&1
  NPM_EXIT=$?
  head -200 "$NPM_LOG" | while IFS= read -r line; do
    emit "INSTALL_LOG $line"
  done
  rm -f "$NPM_LOG"
  if [ "$NPM_EXIT" -ne 0 ]; then
    emit "ERROR npm install failed (exit $NPM_EXIT)"
    exit 4
  fi
  emit "INSTALL_DONE"

elif [ "$AGENT_KIND" = "codex" ]; then
  # codex standalone — no bundled Node needed (binary is self-contained).
  if ! command -v curl >/dev/null 2>&1; then
    emit "ERROR curl required for codex standalone install"
    exit 7
  fi
  # Preflight: OpenAI 的 install.sh 用 /^[0-9a-fA-F]{64}$/ 校验 SHA256, 而
  # mawk (Debian/Ubuntu 默认 awk) 不支持 ERE interval quantifier {n}, 跑到
  # SHA256 校验那一步会永远不 match, 报 "Could not find SHA-256 digest..."。
  # 提前一句话拒了, 给用户清晰的修复命令, 比让 install.sh 跑半天再失败友好。
  if ! awk 'BEGIN{ if ("aaaa" ~ /^a{4}$/) exit 0; exit 1 }' 2>/dev/null; then
    emit "ERROR 远端 awk 不支持 ERE interval quantifier (大概率是 mawk, Debian/Ubuntu 默认)。codex 官方 install.sh 的 SHA256 校验依赖 {n} 量词, 在 mawk 上必失败。请在远端跑: sudo apt install -y gawk && sudo update-alternatives --set awk /usr/bin/gawk"
    exit 4
  fi
  mkdir -p "$CODEX_HOME_DIR" "$CODEX_INSTALL_BIN"

  # One-time auth mirror: if user already has ~/.codex/auth.json, copy it
  # into our isolated CODEX_HOME (cp -n = never clobber). We never touch
  # user's ~/.codex/. Subsequent re-installs skip (file exists).
  if [ -f "$HOME/.codex/auth.json" ] && [ ! -f "$CODEX_HOME_DIR/auth.json" ]; then
    cp -n "$HOME/.codex/auth.json" "$CODEX_HOME_DIR/auth.json" 2>/dev/null \
      && emit "INSTALL_LOG mirrored existing $HOME/.codex/auth.json -> $CODEX_HOME_DIR/auth.json"
  fi

  emit "INSTALL_START codex-standalone"
  # install.sh respects three env vars to keep everything in our tree:
  #   CODEX_HOME            → tarball extract target + daemon state + auth
  #   CODEX_INSTALL_DIR     → "visible command" symlink dir (we don't add to PATH; daemon uses absolute path)
  #   CODEX_NON_INTERACTIVE=1 → never prompt; declines all yes/no (won't uninstall user's system codex, won't auto-launch)
  export CODEX_HOME="$CODEX_HOME_DIR"
  export CODEX_INSTALL_DIR="$CODEX_INSTALL_BIN"
  export CODEX_NON_INTERACTIVE=1
  # Stage 1: fetch install.sh to disk (so we can separate curl failures from sh failures).
  # When installing a pinned older Codex release, use that release's installer too:
  # the latest installer may expect a newer package layout.
  INSTALLER_TMP="$INSTALL_DIR/codex-install.sh"
  if [ -n "$CODEX_RELEASE" ]; then
    INSTALLER_URL="${CODEX_RELEASE_INSTALLER_URL_BASE}/rust-v$CODEX_RELEASE/install.sh"
  else
    INSTALLER_URL="${CODEX_LATEST_INSTALLER_URL}"
  fi
  if ! curl -fsSL --connect-timeout 30 --max-time 120 -o "$INSTALLER_TMP" \
       "$INSTALLER_URL" 2>&1 \
       | while IFS= read -r line; do emit "INSTALL_LOG [curl install.sh] $line"; done; then
    CURL_EXIT=${'$'}{PIPESTATUS[0]:-1}
    emit "ERROR failed to download codex install.sh (curl exit=$CURL_EXIT)"
    exit 4
  fi
  CURL_EXIT=${'$'}{PIPESTATUS[0]:-1}
  if [ "$CURL_EXIT" -ne 0 ]; then
    emit "ERROR failed to download codex install.sh (curl exit=$CURL_EXIT)"
    exit 4
  fi
  if [ ! -s "$INSTALLER_TMP" ]; then
    emit "ERROR codex install.sh downloaded but empty"
    exit 4
  fi
  emit "INSTALL_LOG downloaded install.sh ($(wc -c < "$INSTALLER_TMP") bytes)"

  # Stage 2: run install.sh; capture combined output line-by-line so we can pinpoint
  # which step inside install.sh failed.
  if [ -n "$CODEX_RELEASE" ]; then
    emit "INSTALL_LOG using pinned Codex release $CODEX_RELEASE"
    sh "$INSTALLER_TMP" --release "$CODEX_RELEASE" 2>&1 | while IFS= read -r line; do
      emit "INSTALL_LOG [install.sh] $line"
    done
    SH_EXIT=${'$'}{PIPESTATUS[0]:-1}
  else
    sh "$INSTALLER_TMP" 2>&1 | while IFS= read -r line; do
      emit "INSTALL_LOG [install.sh] $line"
    done
    SH_EXIT=${'$'}{PIPESTATUS[0]:-1}
  fi
  rm -f "$INSTALLER_TMP" 2>/dev/null || true
  if [ "$SH_EXIT" -ne 0 ]; then
    emit "ERROR install.sh exit=$SH_EXIT"
    exit 4
  fi

  # install.sh's add_to_path() unconditionally writes a "# >>> Codex installer >>>"
  # block to user's ~/.bashrc / ~/.zshrc / etc. We don't want to touch user
  # shell config — our daemon uses absolute paths everywhere. Strip only the
  # block that points to OUR isolated CODEX_INSTALL_DIR (any user-managed
  # Codex installer block stays untouched).
  for profile in "$HOME/.zprofile" "$HOME/.bash_profile" "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
    [ -f "$profile" ] || continue
    grep -F "$CODEX_INSTALL_BIN" "$profile" >/dev/null 2>&1 || continue
    grep -F "# >>> Codex installer >>>" "$profile" >/dev/null 2>&1 || continue
    TMP_PROFILE="$profile.xdt-strip-$$"
    awk 'BEGIN{inside=0}
         /# >>> Codex installer >>>/ {inside=1; next}
         inside && /# <<< Codex installer <<</ {inside=0; next}
         !inside {print}' \
      "$profile" > "$TMP_PROFILE" && mv "$TMP_PROFILE" "$profile"
    emit "INSTALL_LOG stripped Codex installer block from $profile (isolated install — no PATH export needed)"
  done

  if [ ! -x "$BIN_PATH" ]; then
    emit "ERROR install.sh succeeded but $BIN_PATH not executable"
    exit 5
  fi
  emit "INSTALL_DONE"
fi

if ! verify_binary; then
  emit "ERROR installed but $BIN_PATH not runnable"
  exit 5
fi

touch "$SENTINEL"
exit 0
`;
