#!/usr/bin/env bash
# 公网换端口：这台 Windows 电脑当客户端，xdt-server 当服务器。每种组合两轮，交替跑。
K="$TEMP/agent-net-shallow/ssh"; P="$TEMP/agent-net-step5/public"; B="$TEMP/agent-net-step5/migrate-target/release/migrate.exe"
remote() { timeout 60 ssh -F "$K/config" root@<上海云主机> "$1"; }
remote "pkill -x migrate; (nohup /root/agent-net-test/migrate server --bind 0.0.0.0:47812 --seconds 3000 > /root/agent-net-test/server.log 2>&1 < /dev/null &); sleep 1; cat /root/agent-net-test/server.log"
run() { # 名称 参数...
  local name=$1; shift
  echo "## $name $(date '+%H:%M:%S')" >> "$P/client.txt"
  timeout 200 "$B" client --server <上海云主机>:47812 "$@" >> "$P/client.txt" 2>&1
  echo "exit $?" >> "$P/client.txt"
  sleep 4
}
for round in 1 2; do
  run "下载 不换 第$round轮" --direction down --bytes 15000000
  run "下载 换端口 不知道 第$round轮" --direction down --bytes 15000000 --rebind-at 3,6 --notice no
  run "下载 换端口 知道 第$round轮" --direction down --bytes 15000000 --rebind-at 3,6 --notice yes
  run "上传 不换 第$round轮" --direction up --bytes 120000000
  run "上传 换端口 不知道 第$round轮" --direction up --bytes 120000000 --rebind-at 3,6 --notice no
  run "上传 换端口 知道 第$round轮" --direction up --bytes 120000000 --rebind-at 3,6 --notice yes
done
remote "cat /root/agent-net-test/server.log" > "$P/server.txt"
remote "pkill -x migrate; echo stopped"
echo done > "$P/done"
