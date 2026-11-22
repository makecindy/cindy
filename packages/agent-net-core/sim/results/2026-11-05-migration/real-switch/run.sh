#!/usr/bin/env bash
# 用法：run.sh 名称 开始的 Unix 秒 客户端参数...：到点开始传输，同时每秒记一次路由和地址。
D="$TEMP/agent-net-real"; name=$1; at=$2; shift 2
while [ "$(date +%s)" -lt "$at" ]; do sleep 0.2; done
( while [ ! -f "$D/$name.done" ]; do
    echo "== $(date '+%H:%M:%S') $(route print -4 0.0.0.0 2>/dev/null | grep -E '^\s+0\.0\.0\.0' | awk '{print $3"/"$4"/"$5}' | tr '\n' ' ')"
    sleep 1
  done ) > "$D/$name-routes.txt" 2>&1 &
echo "## $name start $(date '+%H:%M:%S')" > "$D/$name-client.txt"
timeout 320 "$D/migrate.exe" client --server <上海云主机>:47812 --timeout 300 "$@" >> "$D/$name-client.txt" 2>&1
echo "exit $? at $(date '+%H:%M:%S')" >> "$D/$name-client.txt"
touch "$D/$name.done"
