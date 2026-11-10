#!/bin/zsh
# Managed personal client launcher. Paths and profile come only from its JSON configuration.
set -u
[ -n "${ZSH_VERSION:-}" ] && setopt NULL_GLOB   # 通配符无匹配时得到空列表；否则 zsh 会直接中止脚本
ROOT="${PERSONAL_CLIENT_DIR:?Run through personal-build.mjs}"
APP="${PERSONAL_INSTALLED_APP:-/Applications/Cindy.app}"
UPD="${PERSONAL_STATE_DIR:?}"
DATA="${PERSONAL_DATA_DIR:?}"
REGION="${PERSONAL_REGION:?}"
MODE="${PERSONAL_MODE:?}"
ENGINE="${PERSONAL_CLI:?}"
REQ="$UPD/request"
STATUS="$UPD/status"
LOG="$UPD/launcher.log"
ELECTRON_RE="${PERSONAL_ELECTRON_RE:?}"
CONSOLE="$UPD/app-console.log"
JUST="$UPD/.just-applied"      # 引擎 apply 成功后写入：prev=<旧提交> target=<新提交> db=<0|1>
EOK="$UPD/electron-ok"         # 上一次成功就绪时的 Electron 版本

# The entry wrapper supplies a neutral Node/pnpm toolchain, independent of any source checkout.
export PATH="${PERSONAL_TOOL_PATH}:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

mkdir -p "$UPD/done" "$UPD/failed"
note() { echo "$*"; echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
set_status() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" > "$STATUS"; }
pause_exit() { set_status "stopped exit=${1:-1}"; echo; echo "按回车键关闭窗口…"; read -r _; exit "${1:-1}"; }

cd "$ROOT" 2>/dev/null || { echo "找不到个人版源码目录：$ROOT"; pause_exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "找不到 pnpm，请先安装 pnpm 10（或执行 corepack enable）。"; pause_exit 1; }

# Region/profile are explicit. Preserve the configured shared profile, not ambient shell overrides.
unset XDT_ISOLATED XDT_ISOLATED_NAME XDT_ISOLATED_AUTH XDT_ISOLATED_AUTH_PROOF XDT_USER_DATA_DIR
LAUNCH_MODE=(--shared)
[ "$MODE" = isolated ] && LAUNCH_MODE=("--isolated=${PERSONAL_PROFILE_NAME}")
source "$PERSONAL_TOOLS_DIR/credential-signing.zsh" || exit 1
resolve_signing_identity

run_engine() { # run_engine stage|apply|rollback → 输出记到 <mode>-<时间>.log，返回引擎退出码
  local stamp; stamp=$(date +%Y%m%d-%H%M%S)
  "$PERSONAL_NODE" "$ENGINE" "$1" --config "$PERSONAL_CONFIG" > "$UPD/$1-$stamp.log" 2>&1
  local erc=$?
  tail -n 6 "$UPD/$1-$stamp.log"
  return $erc
}

stop_running_instance() { # 安装前让本目录正在运行的个人版（及管它的旧启动器）正常退出
  local p waited=0 found=0
  for p in $(electron_pids); do found=1; kill -TERM "$p" 2>/dev/null; done
  [ $found = 1 ] || return 0
  note "==> 有待装更新：先让正在运行的个人版退出…"
  while [ -n "$(electron_pids)" ] && [ $waited -lt 60 ]; do sleep 2; waited=$((waited + 2)); done
  for p in $(electron_pids); do kill -KILL "$p" 2>/dev/null; done
  sleep 2
}

apply_pending() {
  if [ -f "$UPD/.apply" ]; then
    stop_running_instance
    set_status "applying"
    note "==> 安装新版本…"
    if run_engine apply; then note "==> 新版本已安装：$(git log --oneline -1 2>/dev/null)"
    else
      note "==> 新版本安装未完成（详见 apply-result）"
      [ ! -f "$UPD/.database-transition" ] || pause_exit 1
    fi
    rm -f "$UPD/.apply"
  fi
  if [ -f "$UPD/pending.zsh" ]; then
    note "==> 检测到旧 pending.zsh；请先将它迁入显式 manifest 更新流程"
    pause_exit 1
  fi
}

electron_pids() { pgrep -f "$ELECTRON_RE" 2>/dev/null; }

kill_tree() {
  local p c
  p=$1
  for c in $(pgrep -P "$p" 2>/dev/null); do kill_tree "$c"; done
  kill -TERM "$p" 2>/dev/null
}

# The legacy launcher has no complete host activity handshake (scheduler scripts, plugin card
# actions, background Bash). A session-turn count alone would interrupt such work, so a queued
# restart never terminates the app: the update installs at the next normal quit and launch.
defer_update_to_next_launch() {
  local app_pid=$1
  touch "$UPD/.apply"
  note "==> 新版本已排队：个人版不会被强制退出，会在下次正常退出并重新打开时安装"
  set_status "running app=$app_pid (update deferred: next launch)"
}

startup_verdict() { # 本次启动的结论：ready / failed / 空（还没出结论）
  grep -a -o 'DESKTOP_DEV_VERDICT=[a-z]*' "$CONSOLE" 2>/dev/null | tail -1 | cut -d= -f2
}

mark_started() { # 新版本已就绪：不再需要退回；记下这次能正常启动的 Electron 版本
  rm -f "$JUST"
  [ -n "${EV:-}" ] && echo "$EV" > "$EOK"
}

watch_requests() {
  local app_pid=$1 req alive=0 marked=0 v
  while kill -0 "$app_pid" 2>/dev/null; do
    sleep 5; alive=$((alive + 5))
    if [ $marked = 0 ]; then
      v=$(startup_verdict)
      # Only the real startup verdict marks this generation ready.
      if [ "$v" = ready ]; then
        marked=1; mark_started; note "==> 个人版已就绪：$(git log --format='%h %s' -1 2>/dev/null | cut -c1-80)"
      elif [ "$v" = failed ]; then
        marked=1
      fi
    fi
    [ -f "$REQ" ] || continue
    req=$(head -1 "$REQ" | tr -d '[:space:]'); rm -f "$REQ"
    case "$req" in
      stage|stage-restart)
        note "==> 收到 $req：在预备目录校验新版本（个人版照常运行）…"
        set_status "staging"
        if run_engine stage; then
          note "==> 预备校验通过"
          if [ "$req" = stage-restart ]; then defer_update_to_next_launch "$app_pid"; fi
        else
          note "==> 预备校验未通过（详见 stage-result），不切换"
        fi
        set_status "running app=$app_pid head=$(git rev-parse HEAD 2>/dev/null)"
        ;;
      restart)
        note "==> 收到 restart"
        defer_update_to_next_launch "$app_pid"
        ;;
      *) note "==> 忽略未知请求：$req" ;;
    esac
  done
}

APP_PID=""
on_signal() {
  [ -n "$APP_PID" ] && kill_tree "$APP_PID"
  set_status "stopped signal"
  exit 130
}
trap on_signal HUP INT TERM

while true; do
  [ ! -f "$UPD/.database-transition" ] || { note "==> 数据库升级尚未完成，请先检查 apply-result"; pause_exit 1; }
  apply_pending

  # Keep application startup available while clearly recording a failed plugin sync.
  if ! "$PERSONAL_NODE" "$PERSONAL_CLI" sync-plugins --config "$PERSONAL_CONFIG" > "$UPD/plugin-sync.log" 2>&1; then
    note "==> 插件同步未完成，保留上次插件；详情见 plugin-sync.log 和维护报告"
  fi
  tail -n 8 "$UPD/plugin-sync.log"

  echo "==> node $(node -v 2>/dev/null)  pnpm $(pnpm -v 2>/dev/null)"
  echo "==> Cindy 个人版  分支: $(git branch --show-current 2>/dev/null)  版本: $(git log --format=%h -1 2>/dev/null)  区域: $REGION  模式: $MODE"

  if [ ! -f node_modules/.modules.yaml ] || [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]; then
    echo "==> 安装 / 更新依赖（首次较慢）…"
    pnpm install --frozen-lockfile || pause_exit 1
  fi

  EXTRA=()
  if [ "$MODE" = shared ] && pgrep -f "$APP/Contents/MacOS/" >/dev/null 2>&1; then
    echo "==> 检测到安装版正在运行：个人版以 passive 模式启动，定时任务交给安装版执行。"
    EXTRA+=(--passive)
  fi

  # 预检共享模式迁移门禁：restart 脚本会因同一原因直接退出，这里把原因记进 launcher.log 便于远程排查
  if ! node --input-type=module -e "import('./scripts/dev-migration-policy.mjs').then((m) => m.assertSharedDevMigrationPolicy(process.cwd(), process.env.PERSONAL_MODE === 'shared' ? ['--shared'] : ['--isolated'])).catch((e) => { console.error(e.message); process.exit(1); })" > "$UPD/preflight.log" 2>&1; then
    note "==> 启动预检未通过（迁移门禁）：$(head -3 "$UPD/preflight.log" | tr '\n' ' ')"; pause_exit 1
  fi

  EV=$(cat node_modules/electron/dist/version 2>/dev/null)
  if [ -n "$EV" ] && [ "$EV" != "$(cat "$EOK" 2>/dev/null)" ]; then
    note "==> 提示：Electron 版本变了（${EV}，上次 $(cat "$EOK" 2>/dev/null || echo 未知)）。macOS 可能弹出钥匙串授权（「Cindy Safe Storage」等），请输入登录密码并点「始终允许」，否则个人版会卡在启动阶段。"
  fi

  echo "==> 个人版就运行在这个终端窗口里：可以最小化，关掉窗口个人版就会退出。"
  STARTED=$(date +%s)
  : > "$CONSOLE"
  if [ "$(uname)" = Darwin ] && [ -x /usr/bin/script ]; then
    # script 提供伪终端（restart 脚本仍认为连着终端）并把输出同时记到 app-console.log；退出码与命令一致
    /usr/bin/script -q "$CONSOLE" pnpm restart:desktop:remote -- --region="$REGION" ${LAUNCH_MODE[@]} ${EXTRA[@]+"${EXTRA[@]}"} </dev/tty &
  else
    pnpm restart:desktop:remote -- --region="$REGION" ${LAUNCH_MODE[@]} ${EXTRA[@]+"${EXTRA[@]}"} </dev/tty &
  fi
  APP_PID=$!
  set_status "running launcher=$$ app=$APP_PID head=$(git rev-parse HEAD 2>/dev/null)"
  watch_requests "$APP_PID" &
  WATCH_PID=$!
  wait "$APP_PID"
  rc=$?
  APP_PID=""
  kill "$WATCH_PID" 2>/dev/null; wait "$WATCH_PID" 2>/dev/null

  VERDICT=$(startup_verdict)
  [ "$VERDICT" = failed ] && [ $rc -eq 0 ] && rc=1
  if [ $rc -ne 0 ]; then
    # 摘出失败原因（code / message）记进日志
    why=$(grep -a -A6 'DESKTOP_DEV_VERDICT=failed' "$CONSOLE" 2>/dev/null | tr -d '\r' | grep -aE '^(code|message)=' | tr '\n' ' ' | cut -c1-300)
    [ -n "$why" ] && note "==> 启动结论：$why"
  fi
  if [ $rc -ne 0 ] && [ -f "$JUST" ] && [ "$VERDICT" != ready ]; then
    # 刚装上的新版本没能启动：退回上一版本再打开（升级过数据库的不退）
    if grep -q 'db=0' "$JUST"; then
      note "==> 新版本启动失败（exit $rc），自动退回上一版本…"
      rm -f "$JUST"
      set_status "rolling-back"
      if run_engine rollback; then
        note "==> 已退回：$(git log --oneline -1 2>/dev/null)，重新打开"
        continue
      fi
      note "==> 自动退回失败（详见 apply-result）"
    else
      note "==> 新版本启动失败，但这次升级过数据库，不能自动退回旧代码"
      rm -f "$JUST"
    fi
  fi
  if [ $rc -ne 0 ]; then
    note "==> 个人版异常退出（exit $rc）；终端里的 DESKTOP_DEV_VERDICT 是原因，预检结果见 preflight.log"
    echo
    echo "启动失败或异常退出（exit $rc）。上面的 DESKTOP_DEV_VERDICT / code / message 就是原因。"
    pause_exit $rc
  fi
  set_status "stopped"
  break
done
