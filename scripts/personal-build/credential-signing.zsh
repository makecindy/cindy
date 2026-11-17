#!/bin/zsh
# Shared by both personal launch paths; does not read credential contents.
credential_signing_note() { print -r -- "$*"; }
# 远程桌面的凭证助手在开发版里现场编译，必须用开发者证书签名：CINDY_REMOTE_CREDENTIALS_SIGNING_IDENTITY
# 要是钥匙串里 Apple Development / Developer ID 证书的 40 位指纹。登录 shell 不读 ~/.zshrc，这里按顺序找：
# 环境变量 → 交互式 zsh 配置 → 已编译助手所用的证书（保持同一张，避免重新授权）→ 钥匙串里唯一的开发证书。
is_fp() { printf '%s' "$1" | grep -Eq '^[A-Fa-f0-9]{40}$'; }
dev_identities() { # 输出「指纹 名称」，只取 Apple Development / Developer ID Application
  security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/^ *[0-9][0-9]*) \([A-Fa-f0-9]\{40\}\) "\(.*\)"$/\1 \2/p' \
    | grep -E ' (Apple Development|Developer ID Application):' | awk '{ $1 = toupper($1); print }'
}
resolve_signing_identity() {
  setopt localoptions nullglob
  local DATA="${PERSONAL_DATA_DIR:?}" UPD="${PERSONAL_STATE_DIR:?}"
  local fp="" src="" ids c leaf tmp
  ids=$(dev_identities)
  if is_fp "${CINDY_REMOTE_CREDENTIALS_SIGNING_IDENTITY:-}"; then
    fp=$CINDY_REMOTE_CREDENTIALS_SIGNING_IDENTITY; src="环境变量"
  fi
  if [ -z "$fp" ]; then
    c=$(zsh -i -c 'print -r -- "${CINDY_REMOTE_CREDENTIALS_SIGNING_IDENTITY:-}"' </dev/null 2>/dev/null | grep -Eo '^[A-Fa-f0-9]{40}$' | tail -1)
    if [ -n "$c" ]; then fp=$c; src="~/.zshrc"; fi
  fi
  if [ -z "$fp" ]; then
    tmp=$(mktemp -d 2>/dev/null)
    for helper in "$DATA"/remote-desktop/native-credentials/*/cindy-macos-remote-credentials; do
      [ -f "$helper" ] && [ -n "$tmp" ] || continue
      rm -f "$tmp"/cert*
      codesign -d --extract-certificates="$tmp/cert" "$helper" >/dev/null 2>&1 || continue
      [ -f "$tmp/cert0" ] || continue
      leaf=$(shasum -a 1 "$tmp/cert0" | cut -c1-40 | tr 'a-f' 'A-F')
      if printf '%s\n' "$ids" | grep -q "^$leaf "; then fp=$leaf; src="已编译的凭证助手"; break; fi
    done
    [ -n "$tmp" ] && rm -rf "$tmp"
  fi
  if [ -z "$fp" ] && [ "$(printf '%s\n' "$ids" | grep -c .)" = 1 ]; then
    fp=$(printf '%s\n' "$ids" | cut -c1-40); src="钥匙串里唯一的开发证书"
  fi
  fp=$(printf '%s' "$fp" | tr 'a-f' 'A-F')
  if [ -z "$fp" ]; then
    credential_signing_note "==> 警告：没找到开发者签名证书（钥匙串里有 $(printf '%s\n' "$ids" | grep -c .) 张候选），远程桌面凭证功能将不可用"
    return 0
  fi
  if ! printf '%s\n' "$ids" | grep -q "^$fp "; then
    credential_signing_note "==> 警告：签名指纹 ${fp:0:8}… 不在钥匙串的有效开发证书里（来源：$src），远程桌面凭证功能可能失败"
  else
    credential_signing_note "==> 开发者签名：${fp:0:8}… $(printf '%s\n' "$ids" | grep "^$fp " | cut -c42- | head -1)（来源：$src）"
  fi
  export CINDY_REMOTE_CREDENTIALS_SIGNING_IDENTITY=$fp
  echo "$(date '+%Y-%m-%d %H:%M:%S') ${fp:0:8} $src" > "$UPD/signing"
}
