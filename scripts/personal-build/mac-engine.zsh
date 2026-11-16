#!/bin/zsh
# Managed developer checkout: stage/apply/rollback. Configuration is supplied by the Node entry.
set -u
[ -n "${ZSH_VERSION:-}" ] && setopt NULL_GLOB
UPD="${PERSONAL_STATE_DIR:?Run through personal-build.mjs}"
SRC="${PERSONAL_SOURCE_DIR:?}"
WT="${PERSONAL_CLIENT_DIR:?}"
STG="${PERSONAL_STAGING_DIR:?}"
DATA="${PERSONAL_DATA_DIR:?}"
MODE="${1:-}"
TARGET="${PERSONAL_TARGET:-}"; MAIN="${PERSONAL_MAIN:-}"
PACK="${PERSONAL_PACK:-}"; LABEL="${PERSONAL_LABEL:-}"
DB_SCRIPT="${PERSONAL_DB_SCRIPT:-}"; FETCH="${PERSONAL_FETCH:-}"
PREV_REF="${PERSONAL_PREVIOUS_REF:?}"
[ -n "$TARGET" ] || { echo "No update target; select a prepared build first"; exit 2; }
SHORT=$(echo "$TARGET" | cut -c1-9)

gitq() { git -c maintenance.auto=false -c gc.auto=0 "$@"; }
gitnolfs() { git -c filter.lfs.smudge=cat -c filter.lfs.process= -c filter.lfs.required=false -c core.hooksPath=/dev/null "$@"; }
result() { # result <file> ok|fail [原因…]
  local f=$1; shift; local verdict=$1; shift
  { echo "$verdict $TARGET"; [ $# -gt 0 ] && echo "$*"; echo "at $(date '+%Y-%m-%d %H:%M:%S')"; } > "$UPD/$f"
  echo "==> $f: $verdict $* "
}

import_target() {
  ( cd "$SRC" || exit 1
    for commit in $(echo "${PERSONAL_FETCH_COMMITS:-}"); do
      gitq fetch -q --no-tags --no-write-fetch-head "https://github.com/${PERSONAL_REPOSITORY}.git" "$commit" || exit 1
    done
    if [ -n "$FETCH" ]; then
      echo "==> 从 GitHub 拉取：$FETCH"
      for b in $(echo "$FETCH"); do
        GIT_TERMINAL_PROMPT=0 gitq -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 \
          fetch -q --no-tags origin "+refs/heads/${b}:refs/remotes/origin/${b}" || echo "  拉取 $b 失败（继续，依赖代码包）"
      done
    fi
    if ! git cat-file -e "$TARGET^{commit}" 2>/dev/null; then
      [ -n "$PACK" ] && [ -f "$UPD/$PACK" ] || { echo "找不到代码包 $PACK"; exit 1; }
      echo "==> 导入新版本代码…"
      gitq index-pack --stdin < "$UPD/$PACK" >/dev/null || { echo "导入失败"; exit 1; }
    fi
    git cat-file -e "$TARGET^{commit}" || { echo "导入后仍找不到目标提交"; exit 1; }
    [ -n "$PACK" ] && rm -f "$UPD/$PACK"
    if [ -n "$MAIN" ]; then
      cur=$(git rev-parse -q --verify refs/remotes/origin/main 2>/dev/null)
      if [ -z "$cur" ] || git merge-base --is-ancestor "$cur" "$MAIN" 2>/dev/null; then
        git update-ref refs/remotes/origin/main "$MAIN"
      fi
    fi
    exit 0 )
}

restore_lfs() {
  git ls-files 'apps/desktop/native/sqlite-vec' '*.pen' | while IFS= read -r f; do
    [ -f "$f" ] || continue
    head -c 60 "$f" | grep -q '^version https://git-lfs' || continue
    oid=$(sed -n 's/^oid sha256://p' "$f")
    src="$SRC/.git/lfs/objects/${oid:0:2}/${oid:2:2}/$oid"
    if [ ! -f "$src" ]; then
      for w in "$SRC" "${PERSONAL_CLIENT_DIR}" "${PERSONAL_STAGING_DIR}"; do
        if [ -f "$w/$f" ] && [ "$(shasum -a 256 "$w/$f" | cut -c1-64)" = "$oid" ]; then src="$w/$f"; break; fi
      done
    fi
    if [ -f "$src" ]; then cp "$src" "$f"; else echo "  缺少 LFS 文件：$f"; fi
  done
}

# 共享数据库已执行的迁移是否与目标版本的迁移列表完全一致（只读）。输出 same / differs:<库名>
db_state() {
  local data="$DATA" journal have db out="" ok
  journal=$(git -C "$SRC" show "${TARGET}:apps/desktop/drizzle/meta/_journal.json") || { echo unknown; return; }
  for db in "$data"/cindy-*.db; do
    # 不用 -readonly：WAL 库在应用退出、-shm 被清理后只读连接打不开；query_only 同样不会写入数据
    have=$(sqlite3 -cmd 'PRAGMA query_only=1' "$db" "SELECT group_concat(seq||':'||file_name, ',') FROM (SELECT seq, file_name FROM migration_history ORDER BY seq);" 2>/dev/null) || { echo unknown; return; }
    # 历史表可能从某个基线版本才开始记录：只比较 [库里最早一条, 目标最后一条] 这一段
    ok=$(printf '%s' "$journal" | HAVE="$have" node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        const exp=JSON.parse(s).entries.map(e=>e.idx+":"+e.tag+".sql");
        const have=(process.env.HAVE||"").split(",").filter(Boolean);
        if(!have.length){console.log("no-history");return;}
        const min=parseInt(have[0],10);
        const want=exp.filter(x=>parseInt(x,10)>=min);
        console.log(want.join(",")===have.join(",")?"same":"differs");})') || { echo unknown; return; }
    [ "$ok" = same ] || out="$out $(basename "$db")($ok)"
  done
  if [ -z "$out" ]; then echo same; else echo "differs:$out"; fi
}

# 启动时的共享模式迁移门禁（与 restart 脚本同一个函数）；失败原因写入 check-policy.log
policy_check() {
  node --input-type=module -e "import('./scripts/dev-migration-policy.mjs').then((m) => m.assertSharedDevMigrationPolicy(process.cwd(), process.env.PERSONAL_MODE === 'shared' ? ['--shared'] : ['--isolated'])).catch((e) => { console.error(e.message); process.exit(1); })" > "$UPD/check-policy.log" 2>&1
}

# 在当前目录跑校验；输出未通过的项目名（空 = 全部通过）
run_checks() {
  local failed=""
  echo "==> 校验：迁移" >&2;     pnpm --filter desktop db:validate > "$UPD/check-db.log" 2>&1 || failed="$failed db:validate"
  echo "==> 校验：设计台账" >&2; node scripts/design-inventory.mjs --check > "$UPD/check-inventory.log" 2>&1 || failed="$failed design-inventory"
  echo "==> 校验：类型检查" >&2; pnpm --filter desktop run typecheck > "$UPD/check-typecheck.log" 2>&1 || failed="$failed typecheck"
  policy_check || failed="$failed migration-policy"
  echo "$failed"
}

# Allow only verified LFS materialization; all other tracked edits block a reset.
clean_checkout() {
  node "${PERSONAL_TOOLS_DIR}/checkout-guard.mjs" "$1"
}

do_stage() {
  echo "==> 预备版本 $SHORT ${LABEL:-}"
  import_target || { result stage-result fail import; return 1; }
  if [ ! -e "$STG/.git" ]; then
    echo "==> 创建预备目录…"
    (cd "$SRC" && gitnolfs worktree add -q --detach "$STG" "$TARGET") || { result stage-result fail worktree; return 1; }
  else
    clean_checkout "$STG" || { result stage-result fail "dirty staging worktree"; return 1; }
    (cd "$STG" && gitnolfs checkout -q --detach "$TARGET") || { result stage-result fail checkout; return 1; }
  fi
  if [ -z "$DB_SCRIPT" ]; then
    local dbs; dbs=$(db_state)
    echo "==> 数据库迁移记录：$dbs"
    if [ "$dbs" != same ]; then result stage-result fail "database needs upgrade script ($dbs)"; return 1; fi
  fi
  cd "$STG" || return 1
  echo "==> 预备目录安装依赖（离线优先，跳过安装脚本）…"
  # pnpm 的 hoisted 链接偶尔会在重命名临时目录时撞车（ENOENT），重试一次通常就好
  pnpm install --frozen-lockfile --prefer-offline --ignore-scripts > "$UPD/stage-install.log" 2>&1 \
    || { echo "==> 安装失败，重试一次…"; pnpm install --frozen-lockfile --prefer-offline --ignore-scripts >> "$UPD/stage-install.log" 2>&1; } \
    || { result stage-result fail install; return 1; }
  local failed; failed=$(run_checks)
  if [ -n "$failed" ]; then result stage-result fail "$failed"; return 1; fi
  # Electron 升级：新 Electron 第一次读「Cindy Safe Storage」会弹钥匙串授权，没人点就卡在启动阶段。
  # 趁个人版（和远程桌面）还开着，先用预备目录里的新 Electron 弹一次、等你点「始终允许」，通过才允许切换。
  local ev_cur ev_new pr
  ev_cur=$(cat "$WT/node_modules/electron/dist/version" 2>/dev/null)
  ev_new=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' node_modules/electron/package.json 2>/dev/null | head -1)
  if [ -n "$ev_new" ] && [ "$ev_new" != "$ev_cur" ] && [ "$ev_new" != "$(cat "$UPD/electron-ok" 2>/dev/null)" ]; then
    echo "==> Electron $ev_cur → $ev_new：下载并做钥匙串预授权…"
    if [ ! -f node_modules/electron/dist/version ]; then
      node node_modules/electron/install.js > "$UPD/stage-electron.log" 2>&1 || { result stage-result fail "electron download"; return 1; }
    fi
    echo "$(date '+%Y-%m-%d %H:%M:%S') authorizing-keychain electron=$ev_new（请在钥匙串弹窗里输入登录密码并点「始终允许」）" > "$UPD/status"
    pr=$(zsh "${PERSONAL_TOOLS_DIR}/keychain-probe.zsh" "$STG/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" 900 | tail -1)
    echo "$(date '+%Y-%m-%d %H:%M:%S') $ev_new $pr" >> "$UPD/keychain-probe.log"
    case "$pr" in
      KEYCHAIN_OK*) echo "$ev_new" > "$UPD/electron-ok" ;;
      *) result stage-result fail "keychain $ev_new: $pr"; return 1 ;;
    esac
  fi
  result stage-result ok

}

switch_to() {
  node "${PERSONAL_TOOLS_DIR}/checkout-guard.mjs" "$PWD" --restore-lfs || return 1
  gitnolfs checkout -q --detach "$1" || return 1
  restore_lfs
  if [ ! -f node_modules/.modules.yaml ] || [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]; then
    echo "==> 依赖有变化，安装中…"
    pnpm install --frozen-lockfile || return 1
  fi
}

do_apply() {
  echo "==> 切换个人版到 $SHORT ${LABEL:-}"
  [ ! -f "$UPD/.database-transition" ] || { result apply-result fail "unfinished database transition; inspect before applying"; return 1; }
  import_target || { result apply-result fail import; return 1; }
  cd "$WT" || return 1
  local prev; prev=$(git rev-parse HEAD)
  if [ "$prev" = "$TARGET" ]; then result apply-result ok "already"; return 0; fi
  clean_checkout "$WT" || { result apply-result fail "dirty worktree"; return 1; }
  if [ -z "$DB_SCRIPT" ]; then
    local dbs; dbs=$(db_state)
    if [ "$dbs" != same ]; then result apply-result fail "database needs upgrade script ($dbs)"; return 1; fi
  fi
  git -C "$SRC" branch -f "$PREV_REF" "$prev"
  echo "==> 旧版本 $(echo "$prev" | cut -c1-9) 备份在分支 $PREV_REF"
  if ! switch_to "$TARGET"; then switch_to "$prev"; result apply-result fail switch; return 1; fi
  # 预备目录已对同一版本校验通过时，这里只做快速的迁移校验；否则完整校验
  local failed=""
  if [ "$(head -1 "$UPD/stage-result" 2>/dev/null)" = "ok $TARGET" ]; then
    echo "==> 预备阶段已校验通过，只复核迁移与启动门禁"
    pnpm --filter desktop db:validate > "$UPD/check-db.log" 2>&1 || failed=" db:validate"
    policy_check || failed="$failed migration-policy"
  else
    failed=$(run_checks)
  fi
  if [ -n "$failed" ]; then
    switch_to "$prev"; result apply-result fail "$failed (已退回 $(echo "$prev" | cut -c1-9))"; return 1
  fi
  if [ -n "$DB_SCRIPT" ]; then
    echo "$TARGET $DB_SCRIPT" > "$UPD/.database-transition"
    echo "==> 升级数据库：$DB_SCRIPT"
    if ! zsh "$UPD/$DB_SCRIPT" </dev/null; then
      result apply-result fail "database script failed; retain target code and inspect backup before recovery"; return 1
    fi
    mv "$UPD/$DB_SCRIPT" "$UPD/done/" 2>/dev/null
    local dbs; dbs=$(db_state)
    [ "$dbs" = same ] || { result apply-result fail "database post-check mismatch ($dbs); retain target code for repair"; return 1; }
  fi
  # 交给启动器：新版本若启动失败，可据此自动退回（升级过数据库的不退，旧代码打不开新库）
  echo "prev=$prev target=$TARGET db=$([ -n "$DB_SCRIPT" ] && echo 1 || echo 0)" > "$UPD/.just-applied"
  rm -f "$UPD/.database-transition"
  result apply-result ok "$(git log --oneline -1)"
}

do_rollback() {
  cd "$WT" || return 1
  clean_checkout "$WT" || { result apply-result fail "dirty worktree"; return 1; }
  local cur prev
  cur=$(git rev-parse HEAD)
  prev=$(git rev-parse -q --verify "refs/heads/$PREV_REF") || { result apply-result fail "rollback: 没有旧版本分支"; return 1; }
  if [ "$cur" = "$prev" ]; then result apply-result fail "rollback: 已经是旧版本 $(echo "$prev" | cut -c1-9)"; return 1; fi
  [ ! -f "$UPD/.database-transition" ] || { result apply-result fail "unfinished database transition; inspect backup before rollback"; return 1; }
  local requested="$TARGET"; TARGET="$prev"
  local dbs; dbs=$(db_state); TARGET="$requested"
  [ "$dbs" = same ] || { result apply-result fail "old code does not match database ($dbs)"; return 1; }
  echo "==> 退回旧版本 $(echo "$prev" | cut -c1-9)（新版本 $(echo "$cur" | cut -c1-9) 启动失败）"
  if ! switch_to "$prev"; then
    switch_to "$cur"; result apply-result fail "rollback 失败，仍是 $(echo "$cur" | cut -c1-9)"; return 1
  fi
  TARGET=$cur
  result apply-result fail "新版本启动失败，已自动退回 $(git log --oneline -1)"
}

mkdir -p "$UPD/done"
case "$MODE" in
  stage) do_stage ;;
  apply) do_apply ;;
  rollback) do_rollback ;;
  *) echo "用法：update-engine.zsh stage|apply|rollback"; exit 2 ;;
esac
