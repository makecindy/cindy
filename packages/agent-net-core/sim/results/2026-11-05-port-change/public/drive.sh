#!/usr/bin/env bash
# 公网换端口新旧对比：这台 Windows 电脑当客户端，xdt-server 当服务端。旧版（第 5 步，核心 c9252e9bbd46）服务端在 47812，
# 新版（本轮加“最新包的重复也验证”之前的代码，核心 ae1e9e3f6785）在 47813。每种组合三轮，第一、三轮先旧后新，第二轮先新后旧。
K="$TEMP/agent-net-shallow/ssh"; P="$TEMP/agent-net-port/public-final"; mkdir -p "$P"; rm -f "$P"/*.txt
remote() { timeout 60 ssh -F "$K/config" root@<上海云主机> "$1"; }
remote "pkill -x migrate-old; pkill -x migrate-new; cd /root/agent-net-test && (nohup ./migrate-old server --bind 0.0.0.0:47812 --seconds 3000 > server-old.log 2>&1 < /dev/null &) && (nohup ./migrate-new server --bind 0.0.0.0:47813 --seconds 3000 > server-new.log 2>&1 < /dev/null &); sleep 1; cat server-old.log server-new.log" > "$P/servers-start.txt" 2>&1
run() { # 版本 名称 参数...
  local version=$1 name=$2; shift 2
  local port=47812 exe=old; [ "$version" = new ] && port=47813 exe=final
  echo "## $version $name $(date '+%H:%M:%S')" >> "$P/client-$version.txt"
  timeout 200 "$TEMP/agent-net-port/migrate-$exe.exe" client --server <上海云主机>:$port "$@" >> "$P/client-$version.txt" 2>&1
  echo "exit $?" >> "$P/client-$version.txt"
  sleep 3
}
pair() { # 轮次 名称 参数...
  local round=$1 name=$2; shift 2
  if [ "$round" != 2 ]; then run old "$name 第${round}轮" "$@"; run new "$name 第${round}轮" "$@"; else run new "$name 第${round}轮" "$@"; run old "$name 第${round}轮" "$@"; fi
}
for round in 1 2 3; do
  pair $round "下载 不换" --direction down --bytes 15000000
  pair $round "下载 换端口 不知道" --direction down --bytes 15000000 --rebind-at 3,6 --notice no
  pair $round "下载 换端口 知道" --direction down --bytes 15000000 --rebind-at 3,6 --notice yes
  pair $round "上传 不换" --direction up --bytes 120000000
  pair $round "上传 换端口 不知道" --direction up --bytes 120000000 --rebind-at 3,6 --notice no
  pair $round "上传 换端口 知道" --direction up --bytes 120000000 --rebind-at 3,6 --notice yes
done
remote "cat /root/agent-net-test/server-old.log" > "$P/server-old.txt" 2>&1
remote "cat /root/agent-net-test/server-new.log" > "$P/server-new.txt" 2>&1
remote "pkill -x migrate-old; pkill -x migrate-new; rm -rf /root/agent-net-test; echo cleaned" > "$P/cleanup.txt" 2>&1
echo done > "$P/done"
