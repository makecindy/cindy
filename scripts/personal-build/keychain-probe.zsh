#!/bin/zsh
# 钥匙串预授权探针：用指定的 Electron 读写一次「Cindy Safe Storage」。
# 新版本的 Electron 第一次读它时 macOS 会弹授权框；在个人版（和远程桌面）还开着时先弹、先点「始终允许」，
# 之后真正切换版本就不会卡在启动阶段。只读写一个探测值，不碰个人版的数据目录。
#
# 用法：keychain-probe.zsh [Electron 可执行文件] [超时秒数，默认 900]
# 输出最后一行 KEYCHAIN_OK / KEYCHAIN_FAIL <原因> / KEYCHAIN_TIMEOUT；退出码 0 / 1 / 2。
set -u
[ -n "${ZSH_VERSION:-}" ] && setopt NULL_GLOB
E="${1:?Electron executable is required}"
LIMIT="${2:-900}"
[ -x "$E" ] || { echo "KEYCHAIN_FAIL 找不到 Electron：$E"; exit 1; }

D=$(mktemp -d "${TMPDIR:-/tmp}/cindy-keychain-probe.XXXXXX") || { echo "KEYCHAIN_FAIL mktemp"; exit 1; }
# 应用名必须与个人版一致（Cindy），钥匙串条目才是同一个「Cindy Safe Storage」
cat > "$D/package.json" <<'EOF'
{ "name": "Cindy", "productName": "Cindy", "version": "0.0.0", "main": "main.js" }
EOF
cat > "$D/main.js" <<'EOF'
const path = require('path');
const { app, safeStorage } = require('electron');
app.setName('Cindy');
app.setPath('userData', path.join(__dirname, 'user-data')); // 不碰真实数据目录
if (app.dock) app.dock.hide();
app.whenReady().then(() => {
  try {
    const out = safeStorage.decryptString(safeStorage.encryptString('cindy-probe'));
    console.log(out === 'cindy-probe' ? 'KEYCHAIN_OK' : 'KEYCHAIN_FAIL mismatch');
  } catch (e) {
    console.log('KEYCHAIN_FAIL ' + String(e && e.message || e).replace(/\s+/g, ' '));
  }
  app.exit(0);
});
EOF

"$E" "$D" > "$D/out.log" 2>&1 &
pid=$!
waited=0
while kill -0 "$pid" 2>/dev/null && [ $waited -lt "$LIMIT" ]; do sleep 1; waited=$((waited + 1)); done
if kill -0 "$pid" 2>/dev/null; then
  kill -TERM "$pid" 2>/dev/null; sleep 1; kill -KILL "$pid" 2>/dev/null
  rm -rf "$D"; echo "KEYCHAIN_TIMEOUT（${LIMIT} 秒内没有完成授权）"; exit 2
fi
r=$(grep -a -E '^KEYCHAIN_(OK|FAIL)' "$D/out.log" | tail -1)
rm -rf "$D"
[ -n "$r" ] || r="KEYCHAIN_FAIL 探针没有输出"
echo "$r（用时 ${waited} 秒）"
case "$r" in KEYCHAIN_OK*) exit 0 ;; *) exit 1 ;; esac
